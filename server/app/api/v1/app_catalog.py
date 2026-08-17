"""
App catalog API — the destination classification the browser extension runs on.

Reads answer "what kind of app is this host?"; writes let an operator add a
vendor without a release. See ``app/core/web_activity.py`` for the vocabulary
and ``app/models/app_catalog.py`` for why this is a table.

Two read paths, deliberately different:

* ``GET /app-catalog/``      — the console view. Analyst-and-up, full rows.
* ``GET /app-catalog/sync``  — what the endpoint pulls. Agent-key authenticated,
  enabled rows only, trimmed to the fields the extension needs, and carrying an
  ``etag`` so an unchanged catalog costs one cheap request instead of a full
  transfer on every browser start.

The sync route is exempt from the portal IP allowlist for the same reason the
other agent routes are: an endpoint must keep working from any network while the
admin portal is restricted.
"""
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
import hashlib
import structlog

from app.core.database import get_db
from app.core.security import require_role, require_permission
from app.core import web_activity as WA
from app.models.app_catalog import AppCatalogEntry
from app.models.user import User

logger = structlog.get_logger()
router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────
class CatalogEntryOut(BaseModel):
    id: str
    host_pattern: str
    app_id: str
    app_name: str
    vendor: Optional[str] = None
    category: str
    category_label: Optional[str] = None
    is_enabled: bool
    is_builtin: bool
    priority: int
    notes: Optional[str] = None
    created_at: Optional[datetime] = None


class CatalogCreate(BaseModel):
    host_pattern: str = Field(..., min_length=1, max_length=255,
                              description="Hostname or dot-suffix, e.g. 'chatgpt.com'")
    app_id: Optional[str] = Field(None, max_length=100,
                                  description="Stable id the extension keys its DOM profile off")
    app_name: str = Field(..., min_length=1, max_length=255)
    vendor: Optional[str] = Field(None, max_length=255)
    category: str = Field(..., description=f"One of {list(WA.CATEGORIES)}")
    priority: Optional[int] = Field(None, description="Higher wins when two patterns match")
    notes: Optional[str] = Field(None, max_length=1000)
    is_enabled: Optional[bool] = True


class CatalogUpdate(BaseModel):
    app_id: Optional[str] = Field(None, max_length=100)
    app_name: Optional[str] = Field(None, max_length=255)
    vendor: Optional[str] = Field(None, max_length=255)
    category: Optional[str] = None
    priority: Optional[int] = None
    notes: Optional[str] = Field(None, max_length=1000)
    is_enabled: Optional[bool] = None


class CatalogListResponse(BaseModel):
    entries: List[CatalogEntryOut]
    count: int
    by_category: dict
    categories: List[dict]
    activities: List[dict]


# ── Helpers ──────────────────────────────────────────────────────────────────
def _clean_category(value: Optional[str]) -> str:
    c = WA.normalize_category(value)
    if not c:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"category must be one of {list(WA.CATEGORIES)}, got '{value}'",
        )
    return c


def _clean_host(value: str) -> str:
    """Accept a pasted URL as well as a bare host — an operator adding a vendor
    almost always has the URL in the clipboard, and silently storing
    'https://chatgpt.com/' as a host pattern would simply never match."""
    h = str(value or "").strip().lower()
    if not h:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "host_pattern is required")
    for prefix in ("https://", "http://"):
        if h.startswith(prefix):
            h = h[len(prefix):]
    h = h.lstrip("*.").strip("/")
    # Keep at most host + first path segment ("bing.com/chat"); deeper paths are
    # noise from a copied URL.
    parts = h.split("/")
    h = parts[0] if len(parts) == 1 else f"{parts[0]}/{parts[1]}"
    if not h:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "host_pattern is required")
    return h


def _slug(value: str) -> str:
    out = "".join(ch if ch.isalnum() else "_" for ch in str(value).lower()).strip("_")
    while "__" in out:
        out = out.replace("__", "_")
    return out[:100] or "custom_app"


def _out(row: AppCatalogEntry) -> CatalogEntryOut:
    return CatalogEntryOut(
        id=str(row.id),
        host_pattern=row.host_pattern,
        app_id=row.app_id,
        app_name=row.app_name,
        vendor=row.vendor,
        category=row.category,
        category_label=WA.CATEGORY_LABELS.get(row.category, row.category),
        is_enabled=bool(row.is_enabled),
        is_builtin=bool(row.is_builtin),
        priority=int(row.priority or 0),
        notes=row.notes,
        created_at=row.created_at,
    )


# ── Console routes ───────────────────────────────────────────────────────────
@router.get("/", response_model=CatalogListResponse)
async def list_catalog(
    category: Optional[str] = None,
    include_disabled: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("view_events")),
):
    """Every catalog row, plus the category/activity vocabulary the matrix UI
    renders from — so the dashboard never hardcodes a second copy of it."""
    stmt = select(AppCatalogEntry)
    if category:
        stmt = stmt.where(AppCatalogEntry.category == _clean_category(category))
    if not include_disabled:
        stmt = stmt.where(AppCatalogEntry.is_enabled.is_(True))
    stmt = stmt.order_by(AppCatalogEntry.category, AppCatalogEntry.app_name, AppCatalogEntry.host_pattern)

    rows = (await db.execute(stmt)).scalars().all()

    by_category = {}
    for r in rows:
        by_category[r.category] = by_category.get(r.category, 0) + 1

    return CatalogListResponse(
        entries=[_out(r) for r in rows],
        count=len(rows),
        by_category=by_category,
        categories=[
            {
                "value": c,
                "label": WA.CATEGORY_LABELS[c],
                "activities": list(WA.CATEGORY_ACTIVITIES[c]),
            }
            for c in WA.CATEGORIES
        ],
        activities=[
            {"value": a, "label": WA.ACTIVITY_LABELS[a]} for a in WA.ACTIVITIES
        ],
    )


@router.post("/", response_model=CatalogEntryOut, status_code=status.HTTP_201_CREATED)
async def add_entry(
    body: CatalogCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(["ADMIN", "ACCESS_CONTROL_ADMIN", "DATA_PROTECTION_ADMIN"])),
):
    """Add a destination. Re-adding an existing host updates it in place rather
    than 409ing — the operator's intent ("this host is GenAI") is the same
    either way, and a duplicate-key error here is pure friction."""
    host = _clean_host(body.host_pattern)
    category = _clean_category(body.category)
    app_id = _slug(body.app_id or body.app_name)

    existing = (await db.execute(
        select(AppCatalogEntry).where(AppCatalogEntry.host_pattern == host)
    )).scalars().first()

    if existing:
        existing.app_id = app_id
        existing.app_name = body.app_name
        existing.vendor = body.vendor
        existing.category = category
        existing.notes = body.notes
        if body.priority is not None:
            existing.priority = body.priority
        if body.is_enabled is not None:
            existing.is_enabled = body.is_enabled
        existing.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        logger.info("App catalog entry updated", host=host, category=category,
                    user=str(current_user.email))
        return _out(existing)

    row = AppCatalogEntry(
        host_pattern=host,
        app_id=app_id,
        app_name=body.app_name,
        vendor=body.vendor,
        category=category,
        is_enabled=True if body.is_enabled is None else bool(body.is_enabled),
        is_builtin=False,
        # A pattern with a path is more specific than the bare host, so default
        # it above the host row that would otherwise shadow it.
        priority=body.priority if body.priority is not None else (10 if "/" in host else 0),
        notes=body.notes,
        created_by=current_user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("App catalog entry added", host=host, category=category,
                app=body.app_name, user=str(current_user.email))
    return _out(row)


@router.patch("/{entry_id}", response_model=CatalogEntryOut)
async def update_entry(
    entry_id: str,
    body: CatalogUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(["ADMIN", "ACCESS_CONTROL_ADMIN", "DATA_PROTECTION_ADMIN"])),
):
    row = (await db.execute(
        select(AppCatalogEntry).where(AppCatalogEntry.id == entry_id)
    )).scalars().first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Catalog entry not found")

    if body.category is not None:
        row.category = _clean_category(body.category)
    if body.app_id is not None:
        row.app_id = _slug(body.app_id)
    if body.app_name is not None:
        row.app_name = body.app_name
    if body.vendor is not None:
        row.vendor = body.vendor
    if body.priority is not None:
        row.priority = body.priority
    if body.notes is not None:
        row.notes = body.notes
    if body.is_enabled is not None:
        row.is_enabled = body.is_enabled
    row.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(["ADMIN", "ACCESS_CONTROL_ADMIN", "DATA_PROTECTION_ADMIN"])),
):
    """Remove a destination.

    A built-in row is DISABLED rather than deleted: the seed would recreate it
    on the next deployment, so deleting one looks like it worked and then
    silently reverts. Disabling survives re-seeding (ON CONFLICT DO NOTHING).
    """
    row = (await db.execute(
        select(AppCatalogEntry).where(AppCatalogEntry.id == entry_id)
    )).scalars().first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Catalog entry not found")

    if row.is_builtin:
        row.is_enabled = False
        row.updated_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info("Built-in catalog entry disabled (not deleted)",
                    host=row.host_pattern, user=str(current_user.email))
        return

    await db.delete(row)
    await db.commit()
    logger.info("App catalog entry deleted", host=row.host_pattern,
                user=str(current_user.email))


# ── Endpoint sync ────────────────────────────────────────────────────────────
class CatalogSyncEntry(BaseModel):
    host: str
    app_id: str
    app_name: str
    category: str
    priority: int


class CatalogSyncResponse(BaseModel):
    entries: List[CatalogSyncEntry]
    count: int
    etag: str
    unchanged: bool = False
    generated_at: datetime


@router.get("/sync", response_model=CatalogSyncResponse)
async def sync_catalog(
    http_request: Request,
    etag: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """What the browser extension pulls. Requires X-Agent-Key (backward
    compatible: no key -> allowed, same as every other agent route).

    Pass the ``etag`` from a previous response to get ``unchanged=true`` and an
    empty body when nothing has changed. A browser starting up otherwise
    re-downloads the whole catalog on every service-worker wake, which on MV3 is
    often — the worker is torn down aggressively.
    """
    from app.api.v1.agents import verify_agent_key
    await verify_agent_key(http_request)

    rows = (await db.execute(
        select(AppCatalogEntry)
        .where(AppCatalogEntry.is_enabled.is_(True))
        .order_by(AppCatalogEntry.priority.desc(), AppCatalogEntry.host_pattern)
    )).scalars().all()

    entries = [
        CatalogSyncEntry(
            host=r.host_pattern,
            app_id=r.app_id,
            app_name=r.app_name,
            category=r.category,
            priority=int(r.priority or 0),
        )
        for r in rows
    ]

    fingerprint = hashlib.sha256(
        "\n".join(f"{e.host}|{e.app_id}|{e.category}|{e.priority}" for e in entries).encode()
    ).hexdigest()[:32]

    if etag and etag == fingerprint:
        return CatalogSyncResponse(
            entries=[], count=len(entries), etag=fingerprint, unchanged=True,
            generated_at=datetime.now(timezone.utc),
        )

    return CatalogSyncResponse(
        entries=entries, count=len(entries), etag=fingerprint, unchanged=False,
        generated_at=datetime.now(timezone.utc),
    )
