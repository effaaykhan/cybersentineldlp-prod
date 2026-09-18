"""
System settings API — admin-portal-managed log-retention policy.

Retention is DB-backed (``retention_config``) with the RETENTION env values as
the fallback default. A hard 90-day floor is enforced here and by a DB CHECK,
so the policy can never be set below the compliance minimum.
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_role
from app.core.config import settings
from app.core.timezone import format_iso
from app.core.database import get_db
from app.models.retention_config import RetentionConfig, MIN_RETENTION_DAYS
from app.services.audit_service import audit_log

router = APIRouter()


@router.get("/about")
async def get_about(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """Real component versions for the dashboard's About card.

    The card used to hard-code "2.0.0" and "OpenSearch 2.11.0", which drifted from
    reality on every release and every OpenSearch bump — a client-facing page that
    lied about what it was running. These are now reported live: `version` is the
    deployed app version, `opensearch` is queried from the actual cluster (so it
    reflects the real 2.19 rather than a stale literal). No auth: version strings
    are not sensitive and the card renders before the user hits a protected route.
    """
    opensearch_version = "unavailable"
    try:
        from app.core import opensearch as _os_mod
        client = getattr(_os_mod, "opensearch_client", None)
        if client is not None:
            info = await client.info()
            opensearch_version = (info or {}).get("version", {}).get("number", "unknown")
    except Exception:
        # OpenSearch being down must never break the About card.
        opensearch_version = "unavailable"

    # When this stack was installed and when it last changed build, recorded by
    # _record_deployment_info() at boot. A deployment that has not taken the
    # update introducing that table has no row yet, so every field here is
    # optional and the card renders a dash rather than a wrong date.
    installed_at = last_updated_at = previous_version = build_time = None
    build_sha = None
    try:
        row = (await db.execute(text(
            "SELECT installed_at, last_updated_at, version, previous_version, "
            "       build_sha, build_time "
            "FROM deployment_info WHERE id = 1"
        ))).first()
        if row is not None:
            installed_at = format_iso(row[0])
            last_updated_at = format_iso(row[1])
            previous_version = row[3]
            build_sha = row[4]
            build_time = format_iso(row[5])
    except Exception:
        # Same reasoning as OpenSearch above: bookkeeping must not break the card.
        pass

    return {
        "version": settings.VERSION,
        "service": settings.PROJECT_NAME,
        "backend": "FastAPI",
        "opensearch": opensearch_version,
        "installed_at": installed_at,
        "last_updated_at": last_updated_at,
        "previous_version": previous_version,
        "build_sha": build_sha,
        "build_time": build_time,
    }


def _uid(user):
    return getattr(user, "id", None) if not isinstance(user, dict) else user.get("sub")


class RetentionUpdate(BaseModel):
    event_retention_days: int
    opensearch_retention_days: int
    # Optional: omitting them leaves the stored values alone, so an older
    # dashboard that does not know about these cannot silently reset them.
    agent_log_retention_days: Optional[int] = None
    agent_log_retention_max_files: Optional[int] = None


def _retention_out(row: Optional[RetentionConfig]) -> Dict[str, Any]:
    if row is None:  # env fallback (clamped to the floor)
        return {
            "event_retention_days": max(MIN_RETENTION_DAYS, settings.EVENT_RETENTION_DAYS),
            "opensearch_retention_days": max(MIN_RETENTION_DAYS, settings.OPENSEARCH_RETENTION_DAYS),
            "minimum_days": MIN_RETENTION_DAYS,
            "agent_log_retention_days": 14,
            "agent_log_retention_max_files": 5,
            "source": "environment",
            "updated_at": None,
        }
    return {
        "event_retention_days": row.event_retention_days,
        "opensearch_retention_days": row.opensearch_retention_days,
        "minimum_days": MIN_RETENTION_DAYS,
        "agent_log_retention_days": row.agent_log_retention_days,
        "agent_log_retention_max_files": row.agent_log_retention_max_files,
        "source": "database",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("/retention")
async def get_retention(
    current_user=Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(RetentionConfig).where(RetentionConfig.id == 1))).scalar_one_or_none()
    return _retention_out(row)


@router.put("/retention")
async def update_retention(
    body: RetentionUpdate,
    current_user=Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
):
    if body.event_retention_days < MIN_RETENTION_DAYS or body.opensearch_retention_days < MIN_RETENTION_DAYS:
        raise HTTPException(400, f"Retention must be at least {MIN_RETENTION_DAYS} days for compliance.")
    row = (await db.execute(select(RetentionConfig).where(RetentionConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = RetentionConfig(id=1)
        db.add(row)
    row.event_retention_days = body.event_retention_days
    row.opensearch_retention_days = body.opensearch_retention_days
    # The 90-day floor above is about how long THIS server keeps evidence. These
    # are an endpoint's own disk budget and are deliberately not subject to it -
    # a laptop holding 90 days of 10MB rotations would be holding gigabytes.
    # 0 means unlimited; negative is meaningless and rejected.
    if body.agent_log_retention_days is not None:
        if body.agent_log_retention_days < 0:
            raise HTTPException(400, "agent_log_retention_days cannot be negative (0 = unlimited)")
        row.agent_log_retention_days = body.agent_log_retention_days
    if body.agent_log_retention_max_files is not None:
        if body.agent_log_retention_max_files < 0:
            raise HTTPException(400, "agent_log_retention_max_files cannot be negative (0 = unlimited)")
        row.agent_log_retention_max_files = body.agent_log_retention_max_files
    row.updated_by = _uid(current_user)
    await db.commit()
    await db.refresh(row)
    await audit_log(_uid(current_user), "system.retention.update",
                    {"event_retention_days": row.event_retention_days,
                     "opensearch_retention_days": row.opensearch_retention_days,
                     "agent_log_retention_days": row.agent_log_retention_days,
                     "agent_log_retention_max_files": row.agent_log_retention_max_files})
    return _retention_out(row)
