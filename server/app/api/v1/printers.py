"""
Printer registry — the per-printer exceptions that printer control enforces.

Each row carries a ``decision``:

* ``allow`` — a sanction. Under a printer_control policy in "allowlist" scope a
  job is permitted only if its printer NAME has an enabled allow row here;
  every other printer is blocked.
* ``deny``  — an explicit disapproval. Blocked in EVERY scope, and it beats an
  allow row for the same name. This is what makes "block just this printer,
  leave the rest alone" expressible; previously the only lever was scope, so
  denying one printer meant switching the whole estate to allowlist and
  enrolling every other printer to spare it.

Suspending a row (``is_enabled=false``) is a third, different thing: it parks the
entry without deleting it, and a suspended row — allow or deny — enforces
nothing.

This module manages that registry and surfaces printers already SEEN on endpoints
(from print events) for one-click enrolment. Writes admin-only, reads analyst.
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
from app.models.sanctioned_printer import SanctionedPrinter

logger = structlog.get_logger()
router = APIRouter()

PRINTER_CONTROL_TYPE = "printer_control"


DECISIONS = ("allow", "deny")


def _clean_decision(value: Optional[str], default: Optional[str] = None) -> Optional[str]:
    """Normalise + validate a decision, or 400. None means 'not supplied'."""
    if value is None:
        return default
    d = str(value).strip().lower()
    if d not in DECISIONS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"decision must be one of {list(DECISIONS)}, got '{value}'",
        )
    return d


class PrinterApprove(BaseModel):
    printer_name: str = Field(..., min_length=1, max_length=500,
                              description="Printer name — the match key")
    label: Optional[str] = Field(None, max_length=255)
    printer_type: Optional[str] = Field(None, max_length=20, description="local | network | unknown")
    notes: Optional[str] = Field(None, max_length=1000)
    # allow = sanction it; deny = explicitly disapprove it (blocked in every
    # scope). Defaults to allow so existing callers are unaffected.
    decision: Optional[str] = Field(None, description="allow | deny")


class PrinterUpdate(BaseModel):
    label: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = Field(None, max_length=1000)
    is_enabled: Optional[bool] = None
    # Flip an existing entry between sanctioned and disapproved.
    decision: Optional[str] = Field(None, description="allow | deny")


def _printer_out(p: SanctionedPrinter) -> dict:
    return {
        "id": str(p.id),
        "printer_name": p.printer_name,
        "label": p.label,
        "printer_type": p.printer_type,
        "is_enabled": p.is_enabled,
        "decision": (p.decision or "allow"),
        "notes": p.notes,
        "approved_at": p.approved_at.isoformat() if p.approved_at else None,
    }


async def _allowlist_active(db: AsyncSession) -> bool:
    """True when an active printer_control policy is in scope 'allowlist'."""
    rows = (await db.execute(
        select(Policy.config).where(
            Policy.type == PRINTER_CONTROL_TYPE,
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        )
    )).scalars().all()
    return any((c or {}).get("scope") == "allowlist" for c in rows)


async def _printer_control_active(db: AsyncSession) -> bool:
    """True when any active printer_control policy exists, whatever its scope.

    Deny rows are consulted in every scope, so this — not the allowlist-only
    check above — is what decides whether a disapproval actually bites.
    """
    n = await db.scalar(
        select(func.count()).select_from(Policy).where(
            Policy.type == PRINTER_CONTROL_TYPE,
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        )
    )
    return bool(n and n > 0)


@router.get("/")
async def list_printers(
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """The printer registry (allow + deny), plus what is actually being enforced."""
    rows = (await db.execute(
        select(SanctionedPrinter).order_by(SanctionedPrinter.approved_at.desc())
    )).scalars().all()
    printers = [_printer_out(p) for p in rows]
    return {
        "printers": printers,
        "count": len(printers),
        "enabled_count": sum(1 for p in printers if p["is_enabled"]),
        "allow_count": sum(1 for p in printers if p["decision"] == "allow"),
        "deny_count": sum(1 for p in printers if p["decision"] == "deny"),
        # True only when a printer_control policy is active AND in allowlist
        # scope — i.e. when the ALLOW rows are what decides a job.
        "enforced": await _allowlist_active(db),
        # True whenever any printer_control policy is active. DENY rows apply in
        # every scope, so they bite even when "enforced" above is False.
        "deny_enforced": await _printer_control_active(db),
    }


@router.post("/", status_code=status.HTTP_201_CREATED)
async def approve_printer(
    body: PrinterApprove,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Register a printer exception by name, as either `allow` (sanction) or
    `deny` (explicit disapproval). Idempotent per printer_name: re-submitting
    updates the details and flips the decision, so the same call both approves
    and disapproves."""
    name = body.printer_name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "printer_name is required")
    decision = _clean_decision(body.decision, "allow")

    existing = (await db.execute(
        select(SanctionedPrinter).where(SanctionedPrinter.printer_name == name)
    )).scalar_one_or_none()

    if existing:
        existing.label = body.label or existing.label
        existing.printer_type = body.printer_type or existing.printer_type
        existing.notes = body.notes if body.notes is not None else existing.notes
        existing.decision = decision
        existing.is_enabled = True
        existing.approved_by = current_user.id
        existing.approved_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        logger.info("printer_rule_updated", printer=name, decision=decision,
                    user=current_user.username)
        return _printer_out(existing)

    p = SanctionedPrinter(
        printer_name=name, label=body.label, printer_type=body.printer_type,
        notes=body.notes, decision=decision, approved_by=current_user.id,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    logger.info("printer_rule_created", printer=name, decision=decision,
                user=current_user.username)
    return _printer_out(p)


@router.patch("/{printer_id}")
async def update_printer(
    printer_id: str,
    body: PrinterUpdate,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Edit a printer's label/notes, flip it between allow and deny, or
    suspend/resume the entry."""
    p = (await db.execute(
        select(SanctionedPrinter).where(SanctionedPrinter.id == printer_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "printer not found")
    if body.label is not None:
        p.label = body.label
    if body.notes is not None:
        p.notes = body.notes
    if body.is_enabled is not None:
        p.is_enabled = body.is_enabled
    if body.decision is not None:
        p.decision = _clean_decision(body.decision)
    await db.commit()
    await db.refresh(p)
    logger.info("printer_updated", printer=p.printer_name, decision=p.decision,
                user=current_user.username)
    return _printer_out(p)


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_printer(
    printer_id: str,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Revoke (delete) a printer's approval."""
    res = await db.execute(
        delete(SanctionedPrinter).where(SanctionedPrinter.id == printer_id)
    )
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "printer not found")
    logger.info("printer_revoked", printer_id=printer_id, user=current_user.username)


@router.get("/seen")
async def seen_printers(
    limit: int = 200,
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """Printers observed in print events that have NO registry rule yet — the
    enrolment candidates, to allow or deny in one click. Deduped by name,
    most-recent first."""
    # Any existing rule counts, allow or deny: a denied printer is already a
    # decision, not a candidate.
    ruled = {
        n for (n,) in (await db.execute(select(SanctionedPrinter.printer_name))).all()
    }
    mongo = get_mongodb()["dlp_events"]
    pipeline = [
        {"$match": {"event_type": "print", "printer_name": {"$nin": [None, ""]}}},
        {"$sort": {"timestamp": -1}},
        {"$group": {
            "_id": "$printer_name",
            "printer_name": {"$first": "$printer_name"},
            "last_seen": {"$first": "$timestamp"},
            "agent_id": {"$first": "$agent_id"},
            "last_action": {"$first": "$action_taken"},
        }},
        {"$limit": max(1, min(limit, 1000))},
    ]
    out: List[dict] = []
    async for r in mongo.aggregate(pipeline):
        if r.get("printer_name") in ruled:
            continue
        ls = r.get("last_seen")
        out.append({
            "printer_name": r.get("printer_name"),
            "agent_id": r.get("agent_id"),
            "last_action": r.get("last_action"),
            "last_seen": ls.isoformat() if hasattr(ls, "isoformat") else ls,
            "sanctioned": False,
        })
    return {"printers": out, "count": len(out)}
