"""
Sanctioned USB device registry — the allowlist that USB device control enforces.

Strict allowlist (default-deny): when a usb_device_control policy is active, a
removable storage device is authorized only if its serial number has an enabled
row here. This module manages that list and surfaces devices already SEEN on
endpoints (from events) so an admin can enrol them in one click.

Writes are admin-only; reads are analyst.
"""
from datetime import datetime, timezone
from typing import Optional, List, Dict
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.core.security import require_role
from app.core.database import get_db, get_mongodb
from app.models.user import User
from app.models.policy import Policy
from app.models.sanctioned_usb_device import SanctionedUsbDevice

logger = structlog.get_logger()
router = APIRouter()

DEVICE_CONTROL_TYPE = "usb_device_control"


class DeviceApprove(BaseModel):
    # How this exception matches. Default 'serial' keeps old callers working.
    match_type: str = Field("serial", pattern="^(serial|manufacturer|device_id|model)$",
                            description="serial | manufacturer | device_id (vid:pid) | model")
    # allow (sanction) or deny (explicitly disallow — overrides any allow).
    decision: str = Field("allow", pattern="^(allow|deny)$")
    # The value to match. Optional: if omitted it's derived from the matching field
    # below (serial_number / manufacturer / vendor_id+product_id / product_name).
    match_value: Optional[str] = Field(None, max_length=255)
    serial_number: Optional[str] = Field(None, max_length=255,
                                         description="Device serial (match key when match_type=serial)")
    alias: Optional[str] = Field(None, max_length=255, description="Optional friendly name")
    label: Optional[str] = Field(None, max_length=255)
    vendor_id: Optional[str] = Field(None, max_length=16)
    product_id: Optional[str] = Field(None, max_length=16)
    product_name: Optional[str] = Field(None, max_length=255)
    manufacturer: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = Field(None, max_length=1000)

    def resolved_match_value(self) -> Optional[str]:
        """The value to match on, explicit or derived from the relevant field."""
        if self.match_value and self.match_value.strip():
            return self.match_value.strip()
        if self.match_type == "serial":
            return (self.serial_number or "").strip() or None
        if self.match_type == "manufacturer":
            return (self.manufacturer or "").strip() or None
        if self.match_type == "device_id":
            vid = (self.vendor_id or "").strip()
            pid = (self.product_id or "").strip()
            return f"{vid}:{pid}" if (vid or pid) else None
        if self.match_type == "model":
            return (self.product_name or "").strip() or None
        return None


class DeviceUpdate(BaseModel):
    alias: Optional[str] = Field(None, max_length=255)
    label: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = Field(None, max_length=1000)
    is_enabled: Optional[bool] = None


def _device_out(d: SanctionedUsbDevice) -> dict:
    return {
        "id": str(d.id),
        "match_type": getattr(d, "match_type", None) or "serial",
        "match_value": getattr(d, "match_value", None),
        "decision": getattr(d, "decision", None) or "allow",
        "alias": getattr(d, "alias", None),
        "serial_number": d.serial_number,
        "label": d.label,
        "vendor_id": d.vendor_id,
        "product_id": d.product_id,
        "product_name": d.product_name,
        "manufacturer": d.manufacturer,
        "is_enabled": d.is_enabled,
        "notes": d.notes,
        "approved_at": d.approved_at.isoformat() if d.approved_at else None,
    }


# ── Live device activity (connected state + "where inserted") ───────────────
# Derived from the agent's usb connect/disconnect events. A device is "connected"
# when its most recent connect is newer than its most recent disconnect.
_USB_CONNECT_SUBTYPES = ["usb_connect", "usb_connected"]
_USB_DISCONNECT_SUBTYPES = ["usb_disconnect", "usb_disconnected"]


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _host_from_email(user_email: Optional[str]) -> Optional[str]:
    # Agent stamps user_email as "user@HOST"; the host is where it was inserted.
    if user_email and "@" in user_email:
        return user_email.split("@", 1)[1] or None
    return None


async def _usb_activity(serials: List[str], db: AsyncSession) -> Dict[str, dict]:
    """Per-serial connection state, from the connect/disconnect history AND the
    liveness of the agent that reported it.

    A connect with no matching disconnect does NOT mean the device is still
    plugged in. Disconnects are only emitted by a running agent, so a machine
    that was shut down, hibernated, slept, lost power, or simply had its agent
    stopped leaves its last connect standing forever. Believing that event on
    its own is what makes a stick pulled out months ago — on a host that has
    been offline ever since — still render as "Connected".

    So a connect is only trusted while the agent that reported it is still
    beating (the same freshness window the Agents page uses). When that agent is
    dead we genuinely do not know whether the device is attached, and the honest
    answer is "unknown" — not a green dot.

    Returns per serial:
        connection_state         "connected" | "disconnected" | "unknown"
        connected                bool — True only for "connected"
        reporting_agent_id       agent that reported the last connect
        reporting_agent_online   whether that agent is currently beating
        reporting_host           where it was last inserted
        last_connect / last_disconnect / last_seen
    """
    serials = [s for s in {s for s in serials if s}]
    if not serials:
        return {}
    mongo = get_mongodb()["dlp_events"]

    # Most recent CONNECT per serial, carrying the agent that reported it.
    # Sort-then-$last is the portable way to pick the newest document per group.
    connects: Dict[str, dict] = {}
    async for r in mongo.aggregate([
        {"$match": {"event_type": "usb", "serial_number": {"$in": serials},
                    "event_subtype": {"$in": _USB_CONNECT_SUBTYPES}}},
        {"$sort": {"timestamp": 1}},
        {"$group": {"_id": "$serial_number",
                    "ts": {"$last": "$timestamp"},
                    "agent_id": {"$last": "$agent_id"},
                    "hostname": {"$last": "$hostname"},
                    "user_email": {"$last": "$user_email"}}},
    ]):
        connects[r["_id"]] = r

    # Most recent DISCONNECT per serial.
    disconnects: Dict[str, object] = {}
    async for r in mongo.aggregate([
        {"$match": {"event_type": "usb", "serial_number": {"$in": serials},
                    "event_subtype": {"$in": _USB_DISCONNECT_SUBTYPES}}},
        {"$group": {"_id": "$serial_number", "ts": {"$max": "$timestamp"}}},
    ]):
        disconnects[r["_id"]] = r.get("ts")

    # Liveness of every agent that reported a connect, by the same rule the
    # Agents page applies (heartbeat within AGENT_TIMEOUT_SECONDS).
    from app.api.v1.agents import _compute_lifecycle_status
    from app.models.agent import Agent

    agent_ids = {c.get("agent_id") for c in connects.values() if c.get("agent_id")}
    live: Dict[str, bool] = {}
    if agent_ids:
        rows = (await db.execute(
            select(Agent.agent_id, Agent.last_heartbeat, Agent.last_seen)
            .where(Agent.agent_id.in_(agent_ids))
        )).all()
        for aid, heartbeat, seen in rows:
            live[aid] = _compute_lifecycle_status(heartbeat or seen) == "active"

    out: Dict[str, dict] = {}
    for serial in serials:
        c = connects.get(serial)
        lc = c.get("ts") if c else None
        ld = disconnects.get(serial)
        if lc is None and ld is None:
            continue  # never observed — leave it absent so callers render "—"

        agent_id = (c or {}).get("agent_id")
        # None (not False) when the connect predates agent tracking: unknown,
        # not "offline".
        agent_online = live.get(agent_id) if agent_id else None

        if lc and (not ld or lc > ld):
            # Last thing we heard was "plugged in" — believe it only if the
            # reporter is still alive to have told us otherwise.
            state = "connected" if agent_online else "unknown"
        else:
            # An explicit disconnect is trustworthy whatever the agent does next.
            state = "disconnected"

        out[serial] = {
            "connection_state": state,
            "connected": state == "connected",
            "reporting_agent_id": agent_id,
            "reporting_agent_online": agent_online,
            "reporting_host": ((c or {}).get("hostname")
                               or _host_from_email((c or {}).get("user_email"))),
            "last_connect": _iso(lc),
            "last_disconnect": _iso(ld),
            "last_seen": _iso(lc if (lc and (not ld or lc > ld)) else (ld or lc)),
        }
    return out


async def _device_control_active(db: AsyncSession) -> bool:
    """True when at least one active usb_device_control policy exists — i.e. the
    allowlist is actually being enforced."""
    n = await db.scalar(
        select(func.count()).select_from(Policy).where(
            Policy.type == DEVICE_CONTROL_TYPE,
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        )
    )
    return bool(n and n > 0)


@router.get("/")
async def list_devices(
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """The device registry (allow + deny), each annotated with live connected
    state, plus whether control is being enforced."""
    rows = (await db.execute(
        select(SanctionedUsbDevice).order_by(SanctionedUsbDevice.approved_at.desc())
    )).scalars().all()
    devices = [_device_out(d) for d in rows]

    # Annotate each device with live connected state from usb connect/disconnect
    # events (keyed by serial; rule-type rows without a serial get connected=None).
    activity = await _usb_activity([d.get("serial_number") for d in devices], db)
    for d in devices:
        act = activity.get(d.get("serial_number") or "")
        d["connected"] = act["connected"] if act else None
        d["connection_state"] = act["connection_state"] if act else None
        d["reporting_host"] = act["reporting_host"] if act else None
        d["reporting_agent_online"] = act["reporting_agent_online"] if act else None
        d["last_seen"] = act["last_seen"] if act else None

    return {
        "devices": devices,
        "count": len(devices),
        "enabled_count": sum(1 for d in devices if d["is_enabled"]),
        "allow_count": sum(1 for d in devices if d["decision"] == "allow"),
        "deny_count": sum(1 for d in devices if d["decision"] == "deny"),
        # True once an active usb_device_control policy exists. When False, the
        # registry is informational only and no device is blocked.
        "enforced": await _device_control_active(db),
    }


@router.post("/", status_code=status.HTTP_201_CREATED)
async def approve_device(
    body: DeviceApprove,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Register a USB exception by serial, manufacturer, device_id (vid:pid) or
    model, as either allow (sanction) or deny (explicit disallow). Idempotent per
    (match_type, match_value): re-submitting updates details, flips the decision,
    and re-enables it. A deny is recorded as a log event."""
    match_type = body.match_type
    match_value = body.resolved_match_value()
    decision = body.decision
    if not match_value:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"a match value is required for match_type '{match_type}'",
        )

    existing = (await db.execute(
        select(SanctionedUsbDevice).where(
            SanctionedUsbDevice.match_type == match_type,
            SanctionedUsbDevice.match_value == match_value,
        )
    )).scalar_one_or_none()

    if existing:
        existing.decision = decision
        existing.alias = body.alias if body.alias is not None else existing.alias
        existing.label = body.label or existing.label
        existing.serial_number = body.serial_number or existing.serial_number
        existing.vendor_id = body.vendor_id or existing.vendor_id
        existing.product_id = body.product_id or existing.product_id
        existing.product_name = body.product_name or existing.product_name
        existing.manufacturer = body.manufacturer or existing.manufacturer
        existing.notes = body.notes if body.notes is not None else existing.notes
        existing.is_enabled = True
        existing.approved_by = current_user.id
        existing.approved_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        logger.info("usb_device_registered", decision=decision, match_type=match_type,
                    match_value=match_value, user=current_user.username)
        await _clear_dismissal(db, body.serial_number)
        if decision == "deny":
            await _log_disallow_event(existing, current_user)
        return _device_out(existing)

    dev = SanctionedUsbDevice(
        match_type=match_type,
        match_value=match_value,
        decision=decision,
        alias=body.alias,
        serial_number=body.serial_number,
        label=body.label,
        vendor_id=body.vendor_id,
        product_id=body.product_id,
        product_name=body.product_name,
        manufacturer=body.manufacturer,
        notes=body.notes,
        approved_by=current_user.id,
    )
    db.add(dev)
    await db.commit()
    await db.refresh(dev)
    logger.info("usb_device_registered", decision=decision, match_type=match_type,
                match_value=match_value, user=current_user.username)
    await _clear_dismissal(db, body.serial_number)
    if decision == "deny":
        await _log_disallow_event(dev, current_user)
    return _device_out(dev)


async def _clear_dismissal(db: AsyncSession, serial: Optional[str]) -> None:
    """Drop any dismissal for this serial — a real decision supersedes it.

    Without this, removing the rule later would drop the device back into
    hiding rather than back into the triage queue.
    """
    serial = (serial or "").strip()
    if not serial:
        return
    from app.models.dismissed_usb_device import DismissedUsbDevice

    await db.execute(delete(DismissedUsbDevice).where(
        DismissedUsbDevice.serial_number == serial
    ))
    await db.commit()


async def _log_disallow_event(dev: SanctionedUsbDevice, user: User) -> None:
    """Write a dlp_events record so an explicit disallow shows in the log section."""
    try:
        name = (dev.alias or dev.product_name or dev.manufacturer
                or dev.serial_number or dev.match_value or "USB device")
        doc = {
            "event_id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc),
            "event_type": "usb",
            "event_subtype": "usb_device_disallowed",
            "severity": "high",
            "source_type": "admin",
            "agent_id": "console",
            "user_email": getattr(user, "email", None) or getattr(user, "username", "admin"),
            "title": f"USB device disallowed by admin: {name}",
            "description": (f"Admin {getattr(user, 'username', 'admin')} disallowed USB "
                            f"{dev.match_type}={dev.match_value}. Matching devices will be blocked."),
            "action_taken": "disallowed",
            "blocked": True,
            "alias": dev.alias,
            "serial_number": dev.serial_number,
            "vendor_id": dev.vendor_id,
            "product_id": dev.product_id,
            "product_name": dev.product_name,
            "manufacturer": dev.manufacturer,
            "match_type": dev.match_type,
            "match_value": dev.match_value,
        }
        doc["usb"] = {k: doc[k] for k in
                      ("serial_number", "vendor_id", "product_id", "product_name",
                       "manufacturer", "alias") if doc.get(k)}
        await get_mongodb()["dlp_events"].insert_one(doc)
    except Exception as e:  # logging must never fail the disallow itself
        logger.warning("usb_disallow_event_log_failed", error=str(e))


@router.patch("/{device_id}")
async def update_device(
    device_id: str,
    body: DeviceUpdate,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Edit a device's alias/label/notes or suspend/resume it (is_enabled)."""
    dev = (await db.execute(
        select(SanctionedUsbDevice).where(SanctionedUsbDevice.id == device_id)
    )).scalar_one_or_none()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    if body.alias is not None:
        dev.alias = body.alias
    if body.label is not None:
        dev.label = body.label
    if body.notes is not None:
        dev.notes = body.notes
    if body.is_enabled is not None:
        dev.is_enabled = body.is_enabled
    await db.commit()
    await db.refresh(dev)
    logger.info("usb_device_updated", serial=dev.serial_number, user=current_user.username)
    return _device_out(dev)


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(
    device_id: str,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Revoke (delete) a device's approval. It becomes unsanctioned again."""
    res = await db.execute(
        delete(SanctionedUsbDevice).where(SanctionedUsbDevice.id == device_id)
    )
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    logger.info("usb_device_revoked", device_id=device_id, user=current_user.username)


@router.get("/seen")
async def seen_devices(
    limit: int = 200,
    include_dismissed: bool = False,
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """USB devices observed on endpoints (from events) with no registry rule —
    the enrolment candidates. Deduped by serial, most-recent first.

    Devices that were dismissed are hidden by default (they are triage noise,
    not decisions); pass ``include_dismissed=true`` to see them, each flagged
    with ``dismissed: true`` so they can be restored. ``dismissed_count`` is
    always returned so the UI can offer that without a second call.
    """
    from app.models.dismissed_usb_device import DismissedUsbDevice

    approved = {
        s for (s,) in (await db.execute(select(SanctionedUsbDevice.serial_number))).all()
    }
    dismissed = {
        s for (s,) in (await db.execute(select(DismissedUsbDevice.serial_number))).all()
    }
    mongo = get_mongodb()["dlp_events"]
    pipeline = [
        {"$match": {"serial_number": {"$nin": [None, ""]}}},
        {"$sort": {"timestamp": -1}},
        {"$group": {
            "_id": "$serial_number",
            "serial_number": {"$first": "$serial_number"},
            "vendor_id": {"$first": "$vendor_id"},
            "product_id": {"$first": "$product_id"},
            "product_name": {"$first": "$product_name"},
            "manufacturer": {"$first": "$manufacturer"},
            "volume_label": {"$first": "$volume_label"},
            "drive_letter": {"$first": "$drive_letter"},
            "agent_id": {"$first": "$agent_id"},
            "user_email": {"$first": "$user_email"},
            "last_seen": {"$first": "$timestamp"},
        }},
        {"$limit": max(1, min(limit, 1000))},
    ]
    out: List[dict] = []
    async for r in mongo.aggregate(pipeline):
        serial = r.get("serial_number")
        if serial in approved:
            continue
        if serial in dismissed and not include_dismissed:
            continue
        ls = r.get("last_seen")
        out.append({
            "dismissed": serial in dismissed,
            "serial_number": serial,
            "vendor_id": r.get("vendor_id"),
            "product_id": r.get("product_id"),
            "product_name": r.get("product_name"),
            "manufacturer": r.get("manufacturer"),
            "volume_label": r.get("volume_label"),
            "drive_letter": r.get("drive_letter"),
            "agent_id": r.get("agent_id"),
            "host": _host_from_email(r.get("user_email")),
            "last_seen": ls.isoformat() if hasattr(ls, "isoformat") else ls,
            "sanctioned": False,
        })

    # Live connected state from connect/disconnect events, keyed by serial.
    activity = await _usb_activity([d["serial_number"] for d in out], db)
    for d in out:
        act = activity.get(d["serial_number"] or "")
        d["connected"] = act["connected"] if act else None
        d["connection_state"] = act["connection_state"] if act else None
        d["reporting_agent_online"] = act["reporting_agent_online"] if act else None
    return {
        "devices": out,
        "count": len(out),
        "dismissed_count": len(dismissed),
        "include_dismissed": include_dismissed,
    }


class DeviceDismiss(BaseModel):
    serial_number: str = Field(..., min_length=1, max_length=255)
    product_name: Optional[str] = Field(None, max_length=255)
    manufacturer: Optional[str] = Field(None, max_length=255)
    note: Optional[str] = Field(None, max_length=1000)


@router.post("/seen/dismiss", status_code=status.HTTP_201_CREATED)
async def dismiss_seen_device(
    body: DeviceDismiss,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Clear a device off the seen list without allowing or denying it.

    Bookkeeping only. The device is NOT authorized — under a usb_device_control
    policy the posture is strict allowlist, so a dismissed device with no allow
    row stays blocked — and it keeps generating events, violations and alerts.
    Reversible via DELETE; the event history is never touched.
    """
    from app.models.dismissed_usb_device import DismissedUsbDevice

    serial = body.serial_number.strip()
    if not serial:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "serial_number is required")

    existing = (await db.execute(
        select(DismissedUsbDevice).where(DismissedUsbDevice.serial_number == serial)
    )).scalar_one_or_none()
    if existing:
        return {"serial_number": serial, "dismissed": True, "already": True}

    db.add(DismissedUsbDevice(
        serial_number=serial,
        product_name=body.product_name,
        manufacturer=body.manufacturer,
        note=body.note,
        dismissed_by=current_user.id,
    ))
    await db.commit()
    logger.info("usb_device_dismissed", serial=serial, user=current_user.username)
    return {"serial_number": serial, "dismissed": True, "already": False}


@router.delete("/seen/dismiss/{serial_number}", status_code=status.HTTP_204_NO_CONTENT)
async def restore_seen_device(
    serial_number: str,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Undo a dismissal — the device returns to the seen list for triage."""
    from app.models.dismissed_usb_device import DismissedUsbDevice

    res = await db.execute(
        delete(DismissedUsbDevice).where(
            DismissedUsbDevice.serial_number == serial_number.strip()
        )
    )
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device was not dismissed")
    logger.info("usb_device_restored", serial=serial_number, user=current_user.username)


@router.get("/activity")
async def device_activity(
    serial: str,
    limit: int = 50,
    current_user: User = Depends(require_role("analyst")),
):
    """Insertion history for a device (by serial): where it was plugged in — host,
    drive letter, volume, and when — newest first. Powers the 'where inserted' view."""
    serial = (serial or "").strip()
    if not serial:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "serial is required")
    mongo = get_mongodb()["dlp_events"]
    cur = (
        mongo.find({
            "event_type": "usb",
            "serial_number": serial,
            "event_subtype": {"$in": _USB_CONNECT_SUBTYPES + _USB_DISCONNECT_SUBTYPES},
        })
        .sort("timestamp", -1)
        .limit(max(1, min(limit, 500)))
    )
    events: List[dict] = []
    async for e in cur:
        st = e.get("event_subtype") or ""
        ts = e.get("timestamp")
        events.append({
            "event": "disconnect" if st in _USB_DISCONNECT_SUBTYPES else "connect",
            "timestamp": _iso(ts),
            "agent_id": e.get("agent_id"),
            "host": _host_from_email(e.get("user_email")),
            "user_email": e.get("user_email"),
            "drive_letter": e.get("drive_letter"),
            "volume_label": e.get("volume_label"),
        })
    return {"serial_number": serial, "events": events, "count": len(events)}
