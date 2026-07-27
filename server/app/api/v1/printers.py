"""
Sanctioned printer registry — the allowlist that printer control enforces in
"allowlist" scope.

When a printer_control policy runs with scope "allowlist", a print job is allowed
only if its printer NAME has an enabled row here; every other printer is blocked.
This module manages that list and surfaces printers already SEEN on endpoints
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


class PrinterApprove(BaseModel):
    printer_name: str = Field(..., min_length=1, max_length=500,
                              description="Printer name — the match key")
    label: Optional[str] = Field(None, max_length=255)
    printer_type: Optional[str] = Field(None, max_length=20, description="local | network | unknown")
    notes: Optional[str] = Field(None, max_length=1000)


class PrinterUpdate(BaseModel):
    label: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = Field(None, max_length=1000)
    is_enabled: Optional[bool] = None


def _printer_out(p: SanctionedPrinter) -> dict:
    return {
        "id": str(p.id),
        "printer_name": p.printer_name,
        "label": p.label,
        "printer_type": p.printer_type,
        "is_enabled": p.is_enabled,
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


@router.get("/")
async def list_printers(
    current_user: User = Depends(require_role("analyst")),
    db: AsyncSession = Depends(get_db),
):
    """The sanctioned-printer allowlist, plus whether allowlist enforcement is on."""
    rows = (await db.execute(
        select(SanctionedPrinter).order_by(SanctionedPrinter.approved_at.desc())
    )).scalars().all()
    printers = [_printer_out(p) for p in rows]
    return {
        "printers": printers,
        "count": len(printers),
        "enabled_count": sum(1 for p in printers if p["is_enabled"]),
        # True only when a printer_control policy is active AND in allowlist scope.
        "enforced": await _allowlist_active(db),
    }


@router.post("/", status_code=status.HTTP_201_CREATED)
async def approve_printer(
    body: PrinterApprove,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Approve (sanction) a printer by name. Idempotent: re-approving updates it."""
    name = body.printer_name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "printer_name is required")

    existing = (await db.execute(
        select(SanctionedPrinter).where(SanctionedPrinter.printer_name == name)
    )).scalar_one_or_none()

    if existing:
        existing.label = body.label or existing.label
        existing.printer_type = body.printer_type or existing.printer_type
        existing.notes = body.notes if body.notes is not None else existing.notes
        existing.is_enabled = True
        existing.approved_by = current_user.id
        existing.approved_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        logger.info("printer_reapproved", printer=name, user=current_user.username)
        return _printer_out(existing)

    p = SanctionedPrinter(
        printer_name=name, label=body.label, printer_type=body.printer_type,
        notes=body.notes, approved_by=current_user.id,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    logger.info("printer_approved", printer=name, user=current_user.username)
    return _printer_out(p)


@router.patch("/{printer_id}")
async def update_printer(
    printer_id: str,
    body: PrinterUpdate,
    current_user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Edit a printer's label/notes or suspend/resume its approval."""
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
    await db.commit()
    await db.refresh(p)
    logger.info("printer_updated", printer=p.printer_name, user=current_user.username)
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
    """Printers observed in print events that are NOT yet sanctioned — the
    enrolment candidates. Deduped by name, most-recent first."""
    approved = {
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
        if r.get("printer_name") in approved:
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
