"""
Sanctioned USB device registry — the allowlist that USB device control enforces.

Strict allowlist (default-deny): when a usb_device_control policy is active, a
removable storage device is authorized only if its serial number has an enabled
row here. This module manages that list and surfaces devices already SEEN on
endpoints (from events) so an admin can enrol them in one click.

Writes are admin-only; reads are analyst.
"""
from datetime import datetime, timezone
from typing import Optional, List

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
    # The value to match. Optional: if omitted it's derived from the matching field
    # below (serial_number / manufacturer / vendor_id+product_id / product_name).
    match_value: Optional[str] = Field(None, max_length=255)
    serial_number: Optional[str] = Field(None, max_length=255,
                                         description="Device serial (match key when match_type=serial)")
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
    label: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = Field(None, max_length=1000)
    is_enabled: Optional[bool] = None


def _device_out(d: SanctionedUsbDevice) -> dict:
    return {
        "id": str(d.id),
        "match_type": getattr(d, "match_type", None) or "serial",
        "match_value": getattr(d, "match_value", None),
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
    """The sanctioned-device allowlist, plus whether control is being enforced."""
    rows = (await db.execute(
        select(SanctionedUsbDevice).order_by(SanctionedUsbDevice.approved_at.desc())
    )).scalars().all()
    devices = [_device_out(d) for d in rows]
    return {
        "devices": devices,
        "count": len(devices),
        "enabled_count": sum(1 for d in devices if d["is_enabled"]),
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
    """Approve (sanction) a USB exception by serial, manufacturer, device_id
    (vid:pid) or model. Idempotent per (match_type, match_value): re-approving the
    same exception updates its details and re-enables it."""
    match_type = body.match_type
    match_value = body.resolved_match_value()
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
        logger.info("usb_device_reapproved", match_type=match_type, match_value=match_value,
                    user=current_user.username)
        return _device_out(existing)

    dev = SanctionedUsbDevice(
        match_type=match_type,
        match_value=match_value,
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
    logger.info("usb_device_approved", match_type=match_type, match_value=match_value,
                user=current_user.username)
    return _device_out(dev)


@router.patch("/{device_id}")
async def update_device(
    device_id: str,
    body: DeviceUpdate,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Edit a device's label/notes or suspend/resume its approval (is_enabled)."""
    dev = (await db.execute(
        select(SanctionedUsbDevice).where(SanctionedUsbDevice.id == device_id)
    )).scalar_one_or_none()
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
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
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """USB devices observed on endpoints (from events) that are NOT yet
    sanctioned — the enrolment candidates. Deduped by serial, most-recent first."""
    approved = {
        s for (s,) in (await db.execute(select(SanctionedUsbDevice.serial_number))).all()
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
            "last_seen": {"$first": "$timestamp"},
        }},
        {"$limit": max(1, min(limit, 1000))},
    ]
    out: List[dict] = []
    async for r in mongo.aggregate(pipeline):
        if r.get("serial_number") in approved:
            continue
        ls = r.get("last_seen")
        out.append({
            "serial_number": r.get("serial_number"),
            "vendor_id": r.get("vendor_id"),
            "product_id": r.get("product_id"),
            "product_name": r.get("product_name"),
            "manufacturer": r.get("manufacturer"),
            "volume_label": r.get("volume_label"),
            "drive_letter": r.get("drive_letter"),
            "agent_id": r.get("agent_id"),
            "last_seen": ls.isoformat() if hasattr(ls, "isoformat") else ls,
            "sanctioned": False,
        })
    return {"devices": out, "count": len(out)}
