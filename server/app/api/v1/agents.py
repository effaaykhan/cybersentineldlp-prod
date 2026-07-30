"""
Agents API Endpoints
Manage DLP agents deployed on endpoints
"""

from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel, Field, ConfigDict
import structlog

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user, require_role
from app.core.database import get_mongodb, get_db
from app.services.policy_service import PolicyService
from app.services.classification_engine import ClassificationEngine
from app.policies.agent_policy_transformer import AgentPolicyTransformer
from app.policies.database_policy_evaluator import DatabasePolicyEvaluator
from app.core.cache import get_cache, CacheService

logger = structlog.get_logger()
router = APIRouter()

# Agent is considered dead if no heartbeat received in this window.
# This is the threshold for the boolean ``is_active`` flag and the binary
# ``lifecycle_status`` (active/disconnected) computed below.
#
# Must be comfortably larger than the agents' heartbeat interval or a live
# agent flickers to "disconnected" between beats. The Windows agent beats
# every ~30s and real networks drop packets, so 30s left ZERO margin —
# a single missed/slow beat hid the agent. 120s tolerates a few missed
# beats while still reflecting a genuinely dead agent within ~2 minutes.
AGENT_TIMEOUT_SECONDS = 120

# ── Lifecycle status: binary active / disconnected ───────────────────
# Agent status is deliberately just two states, reported as
# ``lifecycle_status`` on agent listings:
#
#   active:       last_seen within AGENT_TIMEOUT_SECONDS — heartbeat is fresh
#   disconnected: anything else (no recent heartbeat, or never seen)
#
# The old four-tier ladder (adding "inactive"/"stale") and the separate
# "decommissioned" concept were removed: if an agent isn't sending a
# heartbeat it is simply disconnected. Nothing else to reason about.
LIFECYCLE_ACTIVE_SECONDS = AGENT_TIMEOUT_SECONDS


def _compute_lifecycle_status(last_seen: Optional[datetime]) -> str:
    """Return "active" or "disconnected" for the given heartbeat.

    Active means the most recent heartbeat is within
    ``AGENT_TIMEOUT_SECONDS``; everything else (stale heartbeat or no
    heartbeat at all) is "disconnected". Treats naive datetimes as UTC
    (legacy Mongo docs predate the timezone-aware migration).
    """
    if last_seen is None or not isinstance(last_seen, datetime):
        return "disconnected"
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - last_seen).total_seconds()
    return "active" if age <= LIFECYCLE_ACTIVE_SECONDS else "disconnected"


async def _next_agent_code() -> Optional[int]:
    """Pull the next ``agent_code`` from the Postgres sequence.

    Sequence-driven so we never compute the ID in application code
    (see migration 018). Returns ``None`` when Postgres is unavailable
    so we degrade to "no display code" rather than blocking registration.
    """
    import app.core.database as _db
    from sqlalchemy import text

    if not _db.postgres_session_factory:
        return None

    try:
        async with _db.postgres_session_factory() as session:
            row = await session.execute(text("SELECT nextval('agent_code_seq')"))
            value = row.scalar()
            return int(value) if value is not None else None
    except Exception as e:
        logger.warning("Failed to fetch agent_code sequence", error=str(e))
        return None


async def _ensure_agent_code(agent_doc: Dict[str, Any]) -> Optional[int]:
    """Backfill ``agent_code`` on a Mongo doc that doesn't have one yet.
    Triggered on legacy docs predating the column AND on docs that were
    inserted while the Postgres ``agent_code_seq`` was missing (fresh
    installs that skipped Alembic — see _auto_init_schema_and_admin).

    The race guard matches both shapes: field absent OR field present
    but null. Concurrent calls can briefly waste sequence values, but
    the guard ensures no doc ever ends up with two codes.
    """
    code = agent_doc.get("agent_code")
    if isinstance(code, int):
        return code

    new_code = await _next_agent_code()
    if new_code is None:
        return None

    db = get_mongodb()
    await db["agents"].update_one(
        {
            "_id": agent_doc["_id"],
            "$or": [
                {"agent_code": {"$exists": False}},
                {"agent_code": None},
            ],
        },
        {"$set": {"agent_code": new_code}},
    )
    # Whoever won the race wrote first; re-read to learn the persisted code.
    fresh = await db["agents"].find_one({"_id": agent_doc["_id"]}, {"agent_code": 1})
    if fresh and isinstance(fresh.get("agent_code"), int):
        agent_doc["agent_code"] = fresh["agent_code"]
        return fresh["agent_code"]
    return None


async def verify_agent_key(request: Request) -> Optional[str]:
    """Verify the X-Agent-Key header if present.

    Returns the agent_id if key is valid, None if no key provided
    (backward compat with agents compiled before key support).
    Raises 401 only if a key IS provided but is invalid.
    """
    agent_key = request.headers.get("X-Agent-Key")
    if not agent_key:
        # Backward compatibility: allow agents without key support
        return None

    db = get_mongodb()
    agents_collection = db["agents"]
    agent_doc = await agents_collection.find_one({"api_key": agent_key})
    if not agent_doc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid agent API key",
        )

    return agent_doc["agent_id"]


class AgentBase(BaseModel):
    """Base agent model"""
    name: str = Field(..., description="Agent name/hostname")
    os: str = Field(..., description="Operating system (windows/linux)")
    ip_address: str = Field(..., description="Agent IP address")
    version: str = Field(default="1.0.0", description="Agent version")
    capabilities: Dict[str, bool] = Field(default_factory=dict, description="Agent capability flags")


class AgentCreate(BaseModel):
    """Agent creation model"""
    agent_id: Optional[str] = Field(None, description="Custom agent ID (auto-generated if not provided)")
    name: str = Field(..., description="Agent name/hostname")
    os: str = Field(..., description="Operating system (windows/linux)")
    ip_address: str = Field(..., description="Agent IP address")
    version: str = Field(default="1.0.0", description="Agent version")


class Agent(AgentBase):
    """Agent response model"""
    agent_id: str = Field(..., description="Unique agent ID")
    # Short numeric ID (1, 2, 3 …) assigned by the Postgres sequence
    # ``agent_code_seq``. UI zero-pads for display ("001"). Optional in
    # the response so legacy Mongo docs that haven't been backfilled yet
    # don't fail validation.
    agent_code: Optional[int] = Field(None, description="Short numeric ID for UI display")
    # TODO: Implement agent resume functionality so agents can resume instead of creating new entries
    # Status field removed - agents are considered active if they've sent heartbeat within timeout period
    last_seen: datetime = Field(..., description="Last heartbeat timestamp")
    created_at: datetime = Field(..., description="Registration timestamp")
    policy_version: Optional[str] = Field(None, description="Last policy bundle version applied")
    policy_sync_status: Optional[str] = Field(None, description="Most recent policy sync status")
    policy_last_synced_at: Optional[str] = Field(None, description="ISO timestamp for last policy sync")
    policy_sync_error: Optional[str] = Field(None, description="Last policy sync error message, if any")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "agent_id": "agt-001",
                "name": "WIN-DESK-01",
                "os": "windows",
                "ip_address": "192.168.1.100",
                "version": "1.0.0",
                "status": "online",
                "last_seen": "2025-01-02T10:30:00Z",
                "created_at": "2025-01-01T08:00:00Z"
            }
        }
    )


@router.get("/", response_model=List[Agent])
async def list_agents(
    os: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
) -> List[Agent]:
    """
    List all active DLP agents (only agents that have sent heartbeat within timeout period)

    Query parameters:
    - os: Filter by operating system (windows/linux)

    Note: Only shows agents whose most recent heartbeat is within
    ``AGENT_TIMEOUT_SECONDS`` (see constant above). Dead agents are
    automatically filtered out.
    """
    db = get_mongodb()
    agents_collection = db["agents"]

    # Calculate cutoff time for active agents (timezone-aware UTC)
    cutoff_time = datetime.now(timezone.utc) - timedelta(seconds=AGENT_TIMEOUT_SECONDS)
    # Also create a naive version for comparing with legacy naive datetimes in MongoDB
    cutoff_naive = datetime.utcnow() - timedelta(seconds=AGENT_TIMEOUT_SECONDS)

    # Build query filter — show agents with a recent heartbeat AND that
    # have not been soft-deleted. Handle both aware and naive last_seen
    # datetimes (legacy docs predate the timezone-aware migration).
    query: Dict[str, Any] = {
        "$or": [
            {"last_seen": {"$gte": cutoff_time}},
            {"last_seen": {"$gte": cutoff_naive}},
        ],
        "is_deleted": {"$ne": True},
    }
    if os:
        query["os"] = os

    # Query agents from database — sort by the numeric agent_code so the
    # earliest-registered agent (001) is first and new agents append at
    # the bottom (PART of the chronological-order spec). last_seen DESC
    # is kept as a tiebreaker for the unlikely case where two agents
    # share a code (e.g. a doc lost its code mid-backfill).
    agents_cursor = agents_collection.find(query).sort(
        [("agent_code", 1), ("last_seen", -1)]
    )
    agents = []

    async for agent_doc in agents_cursor:
        # Backfill agent_code BEFORE stripping _id (we need _id to update).
        await _ensure_agent_code(agent_doc)

        # Remove MongoDB _id field and status field (no longer used)
        if "_id" in agent_doc:
            del agent_doc["_id"]
        if "status" in agent_doc:
            del agent_doc["status"]
        if "capabilities" not in agent_doc:
            agent_doc["capabilities"] = {}

        # Normalize datetime to timezone-aware UTC
        for dt_field in ("last_seen", "created_at"):
            if dt_field in agent_doc and isinstance(agent_doc[dt_field], datetime):
                dt_val = agent_doc[dt_field]
                if dt_val.tzinfo is None:
                    dt_val = dt_val.replace(tzinfo=timezone.utc)
                agent_doc[dt_field] = dt_val.isoformat()

        agents.append(Agent(**agent_doc))

    logger.info("Listed agents", count=len(agents))
    return agents


@router.get("/all")
async def list_all_agents(
    include_deleted: bool = False,
    current_user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """
    List ALL agents (including disconnected ones) with lifecycle status.

    Returns agents with additional computed fields:
    - is_active: True if agent sent heartbeat within ``AGENT_TIMEOUT_SECONDS``.
    - status_label: "active"/"disconnected" string (mirrors lifecycle_status).
    - lifecycle_status: "active" or "disconnected", computed from the
      freshness of ``last_seen``.
    - last_seen_seconds_ago: numeric age of the heartbeat in seconds, so the
      UI can render "Last seen X ago" without doing client-side timezone math.
    - is_deleted: soft-delete flag that hides the agent from the default list.

    Soft-deleted agents (``is_deleted=true``) are hidden by default — pass
    ``include_deleted=true`` to surface them in audit views.
    """
    db = get_mongodb()
    agents_collection = db["agents"]

    # Cutoffs reused for the legacy is_active boolean. lifecycle_status uses
    # _compute_lifecycle_status() which handles its own freshness math.
    cutoff_time = datetime.now(timezone.utc) - timedelta(seconds=AGENT_TIMEOUT_SECONDS)
    cutoff_naive = datetime.utcnow() - timedelta(seconds=AGENT_TIMEOUT_SECONDS)
    now_aware = datetime.now(timezone.utc)

    # Hide soft-deleted by default. The {"$ne": True} predicate matches
    # both "field absent" (legacy docs) and "explicitly false", so we
    # don't need to backfill is_deleted on existing rows.
    query: Dict[str, Any] = {} if include_deleted else {"is_deleted": {"$ne": True}}
    agents_cursor = agents_collection.find(query).sort(
        [("agent_code", 1), ("last_seen", -1)]
    )
    agents = []

    async for agent_doc in agents_cursor:
        # Backfill agent_code BEFORE stripping _id (we need _id to update).
        await _ensure_agent_code(agent_doc)

        # Remove MongoDB _id field
        if "_id" in agent_doc:
            del agent_doc["_id"]
        if "capabilities" not in agent_doc:
            agent_doc["capabilities"] = {}

        # Determine if agent is active (legacy boolean)
        last_seen = agent_doc.get("last_seen")
        is_active = False
        last_seen_seconds_ago: Optional[float] = None
        if last_seen and isinstance(last_seen, datetime):
            if last_seen.tzinfo is None:
                is_active = last_seen >= cutoff_naive
                last_seen_seconds_ago = (
                    now_aware - last_seen.replace(tzinfo=timezone.utc)
                ).total_seconds()
            else:
                is_active = last_seen >= cutoff_time
                last_seen_seconds_ago = (now_aware - last_seen).total_seconds()

        # Binary lifecycle status — active if the heartbeat is fresh,
        # otherwise disconnected. Exposed so the UI doesn't recompute it.
        agent_doc["lifecycle_status"] = _compute_lifecycle_status(last_seen)
        agent_doc["last_seen_seconds_ago"] = last_seen_seconds_ago

        # Kept for existing dashboard code paths; mirror lifecycle_status.
        agent_doc["is_active"] = is_active
        agent_doc["status_label"] = "active" if is_active else "disconnected"

        # Soft-delete flag so admin views can distinguish deleted records.
        agent_doc["is_deleted"] = bool(agent_doc.get("is_deleted"))

        # Normalize datetime fields to ISO format
        for dt_field in (
            "last_seen",
            "created_at",
            "last_heartbeat",
            "deleted_at",
        ):
            if dt_field in agent_doc and isinstance(agent_doc[dt_field], datetime):
                dt_val = agent_doc[dt_field]
                if dt_val.tzinfo is None:
                    dt_val = dt_val.replace(tzinfo=timezone.utc)
                agent_doc[dt_field] = dt_val.isoformat()

        agents.append(agent_doc)

    logger.info("Listed all agents", count=len(agents), include_deleted=include_deleted)
    return agents


@router.post("/", status_code=status.HTTP_201_CREATED)
async def register_agent(
    request: Request,
    agent: AgentCreate,
) -> Dict[str, Any]:
    """
    Register a new DLP agent.

    Returns the agent record **and** a one-time ``api_key``.  The agent
    must store this key and send it as ``X-Agent-Key`` header on all
    subsequent requests (events, heartbeat, policy sync).
    """
    import secrets

    db = get_mongodb()
    agents_collection = db["agents"]

    body = await request.json()
    provided_agent_id = body.get("agent_id")
    capabilities = body.get("capabilities") or {}
    now = datetime.now(timezone.utc)

    # Use the agent's self-assigned ID if provided (C++ agent sends UUID).
    # Otherwise generate a sequential one.
    if provided_agent_id:
        agent_id = provided_agent_id
    else:
        agent_id = f"{agent.os.upper()}-{agent.name.replace(' ', '-')}"

    # Check if this agent already exists (by agent_id OR by hostname+os)
    existing = await agents_collection.find_one({
        "$or": [
            {"agent_id": agent_id},
            {"name": agent.name, "os": agent.os},
        ]
    })

    if existing:
        # Re-registering — update fields, keep the stored agent_id
        stored_id = existing["agent_id"]
        api_key = existing.get("api_key") or f"csak_{secrets.token_urlsafe(32)}"

        # If the agent rolled its UUID (reinstall / stale state file), we
        # used to overwrite agent_id and silently orphan every prior
        # event. Now: keep the stored_id stable AS the canonical id and
        # archive any rolled UUIDs in ``previous_agent_ids`` so event
        # enrichment + the /events agent filter can resolve them back
        # to this same agent record.
        update_fields = {
            "ip_address": agent.ip_address,
            "version": agent.version,
            "last_seen": now,
            "capabilities": capabilities,
            "api_key": api_key,
            # Re-enrollment is an explicit "this endpoint is back in
            # service" signal (fresh install / restart). Clear any stale
            # removal or decommission flags so the returning agent becomes
            # visible again instead of silently staying hidden behind an
            # old soft-delete.
            "is_deleted": False,
            "decommissioned": False,
        }
        if existing.get("is_deleted") or existing.get("decommissioned"):
            logger.info(
                "Re-registration revived a removed/decommissioned agent",
                agent_id=existing["agent_id"],
            )
        update_ops: Dict[str, Any] = {"$set": update_fields}
        if stored_id != agent_id:
            previous_ids = list(existing.get("previous_agent_ids") or [])
            # Archive the agent's rolled UUID under previous_agent_ids
            # so historic events tagged with it still resolve.
            if agent_id not in previous_ids and agent_id != stored_id:
                update_ops["$addToSet"] = {"previous_agent_ids": agent_id}
            # Force the registering agent to keep using stored_id so all
            # new events share the canonical id.
            agent_id = stored_id

        await agents_collection.update_one(
            {"_id": existing["_id"]},
            update_ops,
        )
        # Re-registering legacy agent without agent_code → backfill now.
        agent_code = existing.get("agent_code")
        if not isinstance(agent_code, int):
            agent_code = await _ensure_agent_code(existing)
        agent_doc = existing
        agent_doc["agent_id"] = stored_id
    else:
        # New agent — pull agent_code from the Postgres sequence so we
        # never compute the ID in app code.
        api_key = f"csak_{secrets.token_urlsafe(32)}"
        agent_code = await _next_agent_code()

        agent_doc = {
            "agent_id": agent_id,
            "agent_code": agent_code,
            "name": agent.name,
            "os": agent.os,
            "ip_address": agent.ip_address,
            "version": agent.version,
            "last_seen": now,
            "created_at": now,
            "capabilities": capabilities,
            "policy_version": None,
            "policy_sync_status": "never",
            "policy_last_synced_at": None,
            "policy_sync_error": None,
            "api_key": api_key,
        }

        await agents_collection.insert_one(agent_doc)

    logger.info("Agent registered", agent_id=agent_id, agent_code=agent_code, name=agent.name)

    # Return agent data + the API key (shown once)
    response_doc = {k: v for k, v in agent_doc.items() if k not in ("api_key", "_id")}
    response_doc["api_key"] = api_key
    response_doc["agent_code"] = agent_code
    response_doc["last_seen"] = now.isoformat()
    response_doc["created_at"] = now.isoformat()

    return response_doc


@router.get("/{agent_id}", response_model=Agent)
async def get_agent(
    agent_id: str,
    current_user: dict = Depends(get_current_user),
) -> Agent:
    """
    Get details of a specific agent
    """
    db = get_mongodb()
    agents_collection = db["agents"]

    agent_doc = await agents_collection.find_one({"agent_id": agent_id})

    if not agent_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found"
        )

    # Backfill agent_code BEFORE stripping _id (we need _id to update).
    await _ensure_agent_code(agent_doc)

    # Remove MongoDB _id field
    if "_id" in agent_doc:
        del agent_doc["_id"]
    if "capabilities" not in agent_doc:
        agent_doc["capabilities"] = {}

    return Agent(**agent_doc)


class HeartbeatRequest(BaseModel):
    """Heartbeat request model"""
    timestamp: Optional[str] = Field(None, description="Agent timestamp (ISO format)")
    status: Optional[str] = Field(None, description="Agent status")
    ip_address: Optional[str] = Field(None, description="Current IP address")
    policy_version: Optional[str] = Field(None, description="Agent policy bundle version")
    policy_sync_status: Optional[str] = Field(None, description="Most recent policy sync status")
    policy_last_synced_at: Optional[str] = Field(None, description="ISO timestamp for last policy sync")
    policy_sync_error: Optional[str] = Field(None, description="Error details from last policy sync")


@router.put("/{agent_id}/heartbeat")
async def agent_heartbeat(
    agent_id: str,
    request: Request,
    heartbeat: Optional[HeartbeatRequest] = None,
    _verified_agent: str = Depends(verify_agent_key),
) -> Dict[str, Any]:
    """
    Update agent heartbeat.  Requires ``X-Agent-Key`` header.

    Accepts optional request body with timestamp. If provided, validates it's within
    reasonable bounds (not more than 5 minutes in the future or past).
    Uses server time if not provided or invalid.
    """
    db = get_mongodb()
    agents_collection = db["agents"]

    # Determine timestamp to use
    server_time = datetime.now(timezone.utc)
    heartbeat_time = server_time

    if heartbeat and heartbeat.timestamp:
        try:
            # Parse agent-provided timestamp
            agent_time_str = heartbeat.timestamp.replace('Z', '+00:00')
            agent_time = datetime.fromisoformat(agent_time_str)
            # Ensure agent_time is timezone-aware for comparison
            if agent_time.tzinfo is None:
                agent_time = agent_time.replace(tzinfo=timezone.utc)
            # Validate timestamp is within reasonable bounds (±5 minutes)
            time_diff = abs((agent_time - server_time).total_seconds())
            if time_diff <= 300:  # 5 minutes
                heartbeat_time = agent_time
            else:
                logger.warning(
                    "Agent timestamp out of bounds, using server time",
                    agent_id=agent_id,
                    agent_time=heartbeat.timestamp,
                    server_time=server_time.isoformat(),
                    diff_seconds=time_diff
                )
        except (ValueError, AttributeError) as e:
            logger.debug(f"Invalid timestamp format, using server time: {e}")

    # Update last_seen and optionally other fields
    update_data = {
        "last_seen": heartbeat_time,
        # A live heartbeat is definitive proof the endpoint is still
        # running. If this agent had been soft-deleted ("Remove Agent")
        # or swept by cleanup-stale, it must NOT stay hidden: every agent
        # listing filters out ``is_deleted`` docs, so a still-running
        # agent would remain invisible on the dashboard forever despite
        # heartbeating successfully (HTTP 200). Reviving it here closes
        # that blind spot — the correct way to remove a live agent is to
        # uninstall it (which stops the heartbeats), not to hide a machine
        # that is actively touching data.
        "is_deleted": False,
    }

    if heartbeat and heartbeat.ip_address:
        update_data["ip_address"] = heartbeat.ip_address
    if heartbeat and heartbeat.policy_version is not None:
        update_data["policy_version"] = heartbeat.policy_version
    if heartbeat and heartbeat.policy_sync_status is not None:
        update_data["policy_sync_status"] = heartbeat.policy_sync_status
    if heartbeat and heartbeat.policy_last_synced_at is not None:
        update_data["policy_last_synced_at"] = heartbeat.policy_last_synced_at
    if heartbeat and heartbeat.policy_sync_error is not None:
        update_data["policy_sync_error"] = heartbeat.policy_sync_error

    # Resolve rolled UUIDs (reinstalled agent) by also matching previous_agent_ids.
    # An agent whose local state file kept an old UUID may still be heartbeating
    # under it; that UUID now lives in this record's previous_agent_ids array.
    #
    # find_one_and_update returns the pre-update document (ReturnDocument.BEFORE
    # by default), so we learn — atomically, without an extra read — whether
    # this heartbeat just revived a soft-deleted agent, and can log that
    # transition for the audit trail.
    previous = await agents_collection.find_one_and_update(
        {"$or": [{"agent_id": agent_id}, {"previous_agent_ids": agent_id}]},
        {"$set": update_data},
    )

    if previous is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found"
        )

    if previous.get("is_deleted"):
        logger.info(
            "Revived soft-deleted agent on live heartbeat — a running endpoint cannot stay hidden",
            agent_id=agent_id,
        )

    logger.debug("Agent heartbeat", agent_id=agent_id, timestamp=heartbeat_time.isoformat())
    return {
        "status": "success",
        "message": "Heartbeat recorded",
        "timestamp": heartbeat_time.isoformat()
    }


@router.delete("/{agent_id}/unregister", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_agent(
    agent_id: str,
    request: Request,
    _verified_agent: str = Depends(verify_agent_key),
):
    """
    Self-unregister called by the agent during a clean uninstall.

    We deliberately do NOT hard-delete the agent record here. Doing so
    would orphan event history (event_id → agent_id lookups would fail
    enrichment) and erase audit trails for an agent that produced real
    activity. Instead we soft-delete it so it drops out of the active
    inventory. If the agent is ever reinstalled, its first heartbeat /
    re-registration revives the record automatically.
    """
    db = get_mongodb()
    agents_collection = db["agents"]
    now = datetime.now(timezone.utc)

    result = await agents_collection.update_one(
        {"agent_id": agent_id},
        {"$set": {
            "is_deleted": True,
            "deleted_at": now,
            "deleted_reason": "agent_self_uninstall",
        }},
    )

    if result.matched_count == 0:
        # Already gone or never registered — uninstall is idempotent.
        logger.debug("Agent not found for unregister", agent_id=agent_id)
    else:
        logger.info("Agent self-removed via uninstall", agent_id=agent_id)

    return None


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(
    agent_id: str,
    current_user: dict = Depends(require_role("admin")),
):
    """
    Soft-delete an agent record (admin action — "Remove Agent" in the UI).

    The agent_id is preserved on the doc so:
      • event/incident enrichment can still resolve agent_name + agent_code
      • audit trails referencing this agent stay queryable
    Listings hide soft-deleted agents by default; pass
    ``GET /agents/all?include_deleted=true`` to surface them.
    """
    db = get_mongodb()
    agents_collection = db["agents"]
    now = datetime.now(timezone.utc)
    actor = current_user.get("email") if isinstance(current_user, dict) else getattr(current_user, "email", None)

    result = await agents_collection.update_one(
        {"agent_id": agent_id, "is_deleted": {"$ne": True}},
        {"$set": {
            "is_deleted": True,
            "deleted_at": now,
            "deleted_by": actor,
        }},
    )

    if result.matched_count == 0:
        # Either the agent doesn't exist OR it's already soft-deleted.
        # We 404 in both cases — admin should hit ?include_deleted=true
        # to confirm before retrying.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    # Audit log so the soft-delete is traceable even if the doc is later
    # purged from Mongo. Fire-and-forget — never block the response on it.
    try:
        from app.services.audit_service import audit_log
        user_id = current_user.get("id") if isinstance(current_user, dict) else getattr(current_user, "id", None)
        await audit_log(user_id, "agent.delete", {"agent_id": agent_id})
    except Exception as e:
        logger.warning("Failed to record agent.delete audit log", error=str(e))

    logger.info("Agent soft-deleted", agent_id=agent_id, user=actor)
    return None


@router.post("/cleanup-stale", status_code=status.HTTP_200_OK)
async def cleanup_stale_agents(
    older_than_days: int = 30,
    dry_run: bool = True,
    current_user: dict = Depends(require_role("admin")),
) -> Dict[str, Any]:
    """
    Soft-delete agents whose ``last_seen`` is older than N days.

    Admin-triggered, never automatic — invoke from a UI button or a cron
    you control. ``dry_run=true`` (default) returns the set that *would*
    be cleaned up so you can review before actually applying. Pass
    ``dry_run=false`` to perform the soft delete.

    NOTE: this is a soft delete (``is_deleted=true``); event history and
    audit trails referencing the agent are preserved.
    """
    if older_than_days <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="older_than_days must be positive",
        )

    db = get_mongodb()
    agents_collection = db["agents"]
    cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
    actor = current_user.get("email") if isinstance(current_user, dict) else getattr(current_user, "email", None)

    # Build the candidate filter once and reuse it for both the preview
    # and the update so the two views always agree on the affected set.
    query: Dict[str, Any] = {
        "is_deleted": {"$ne": True},
        "$or": [
            {"last_seen": {"$lt": cutoff}},
            {"last_seen": {"$exists": False}},
            {"last_seen": None},
        ],
    }

    candidates: List[Dict[str, Any]] = []
    async for doc in agents_collection.find(
        query, {"agent_id": 1, "name": 1, "agent_code": 1, "last_seen": 1, "_id": 0}
    ):
        last_seen = doc.get("last_seen")
        if isinstance(last_seen, datetime):
            if last_seen.tzinfo is None:
                last_seen = last_seen.replace(tzinfo=timezone.utc)
            doc["last_seen"] = last_seen.isoformat()
        candidates.append(doc)

    if dry_run:
        return {
            "dry_run": True,
            "older_than_days": older_than_days,
            "cutoff": cutoff.isoformat(),
            "would_remove_count": len(candidates),
            "candidates": candidates,
        }

    now = datetime.now(timezone.utc)
    result = await agents_collection.update_many(
        query,
        {"$set": {
            "is_deleted": True,
            "deleted_at": now,
            "deleted_by": actor,
            "deleted_reason": f"stale>{older_than_days}d",
        }},
    )

    try:
        from app.services.audit_service import audit_log
        user_id = current_user.get("id") if isinstance(current_user, dict) else getattr(current_user, "id", None)
        await audit_log(
            user_id,
            "agent.cleanup_stale",
            {"older_than_days": older_than_days, "removed": result.modified_count},
        )
    except Exception as e:
        logger.warning("Failed to record agent.cleanup_stale audit log", error=str(e))

    logger.info(
        "Stale agents cleaned up",
        older_than_days=older_than_days,
        removed=result.modified_count,
        user=actor,
    )
    return {
        "dry_run": False,
        "older_than_days": older_than_days,
        "cutoff": cutoff.isoformat(),
        "removed_count": result.modified_count,
        "candidates": candidates,
    }


@router.get("/stats/summary")
async def get_agents_summary(
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """
    Get summary statistics of active agents
    """
    db = get_mongodb()
    agents_collection = db["agents"]

    # Calculate cutoff time for active agents (handle both aware and naive datetimes)
    cutoff_time = datetime.now(timezone.utc) - timedelta(seconds=AGENT_TIMEOUT_SECONDS)
    cutoff_naive = datetime.utcnow() - timedelta(seconds=AGENT_TIMEOUT_SECONDS)

    # Count active agents (have sent heartbeat within timeout)
    active = await agents_collection.count_documents({
        "$or": [
            {"last_seen": {"$gte": cutoff_time}},
            {"last_seen": {"$gte": cutoff_naive}},
        ]
    })

    # Count total agents (including dead ones)
    total = await agents_collection.count_documents({})

    return {
        "total": total,
        "active": active,
    }


class AgentPolicySyncRequest(BaseModel):
    """Agent policy sync request"""
    platform: Optional[str] = Field(None, description="Override detected platform (windows/linux)")
    capabilities: Dict[str, bool] = Field(default_factory=dict, description="Agent capability flags")
    installed_version: Optional[str] = Field(None, description="Currently installed bundle version")


class AgentPolicySyncResponse(BaseModel):
    """Agent policy sync response"""
    status: str = Field(default="updated", description="updated|up_to_date")
    version: str
    generated_at: datetime
    policy_count: int
    policies: Dict[str, Any] = Field(default_factory=dict)


_agent_policy_transformer = AgentPolicyTransformer()


def _get_agent_policy_transformer() -> AgentPolicyTransformer:
    return _agent_policy_transformer


@router.post("/{agent_id}/policies/sync", response_model=AgentPolicySyncResponse)
async def sync_agent_policies(
    agent_id: str,
    sync_request: AgentPolicySyncRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _verified_agent: str = Depends(verify_agent_key),
):
    """
    Provide agents with a policy bundle tailored to their platform/capabilities.
    Requires ``X-Agent-Key`` header.
    """
    mongo = get_mongodb()
    agents_collection = mongo["agents"]

    # Tolerate rolled UUIDs (reinstalled agent still using its old local id)
    # by also looking up in previous_agent_ids.
    agent_doc = await agents_collection.find_one(
        {"$or": [{"agent_id": agent_id}, {"previous_agent_ids": agent_id}]}
    )
    if not agent_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    platform = (sync_request.platform or agent_doc.get("os") or "windows").lower()
    capabilities = {**agent_doc.get("capabilities", {}), **sync_request.capabilities}

    # Normalize capability flags
    capabilities = {k: bool(v) for k, v in capabilities.items()}
    capability_key = "-".join(sorted([k for k, v in capabilities.items() if v])) or "default"

    cache_service: Optional[CacheService] = None
    try:
        cache_service = CacheService(get_cache())
    except RuntimeError:
        cache_service = None

    cache_key = f"agent-policy-bundle:{agent_id}:{platform}:{capability_key}"
    bundle: Optional[Dict[str, Any]] = None

    if cache_service:
        bundle = await cache_service.get(cache_key)

    if not bundle:
        policy_service = PolicyService(db)
        enabled_policies = await policy_service.get_enabled_policies()
        transformer = _get_agent_policy_transformer()
        bundle = transformer.build_bundle(
            enabled_policies,
            platform,
            capabilities,
            agent_id=agent_id,
        )
        if cache_service:
            await cache_service.set(cache_key, bundle, expire=30)

    if not bundle:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build policy bundle",
        )

    version = bundle.get("version")
    generated_at_raw = bundle.get("generated_at")
    generated_at = datetime.fromisoformat(generated_at_raw.replace("Z", "+00:00")) if generated_at_raw else datetime.utcnow()

    if sync_request.installed_version and sync_request.installed_version == version:
        logger.info("Agent policy bundle up-to-date", agent_id=agent_id, platform=platform, version=version)
        return AgentPolicySyncResponse(
            status="up_to_date",
            version=version,
            generated_at=generated_at,
            policy_count=bundle.get("policy_count", 0),
            policies={},
        )

    logger.info(
        "Agent policy bundle issued",
        agent_id=agent_id,
        platform=platform,
        version=version,
        policy_count=bundle.get("policy_count", 0),
    )

    return AgentPolicySyncResponse(
        status="updated",
        version=version,
        generated_at=generated_at,
        policy_count=bundle.get("policy_count", 0),
        policies=bundle.get("policies", {}),
    )


# Extraction kinds that mean "there is no text in this file to leak" — a photo
# OCR confirmed is wordless, a video, an installer, a disk image. These are NOT
# the same as failing to read a document, and must not be blocked as such.
_NO_TEXT_KINDS = frozenset({"image_no_text", "binary", "empty"})


class PolicyEvaluationRequest(BaseModel):
    """Request model for real-time policy evaluation"""
    file_name: str = Field(..., description="Name of the file being transferred")
    file_content: str = Field(
        "",
        description=(
            "Plain-text content to classify. Correct only for text formats — a "
            "binary file (pdf/docx/xlsx) decoded into this field is unreadable "
            "to the classifier and will look Public. Send file_content_b64 instead."
        ),
    )
    # Raw file bytes, base64-encoded. Preferred for ANY file: the server decodes
    # and extracts real text (pdf/docx/xlsx/pptx/text), so binary documents are
    # classified on their actual contents rather than their compressed bytes.
    file_content_b64: Optional[str] = Field(
        None, description="Base64 of the raw file bytes (preferred over file_content)"
    )
    # Set by a caller that COULD NOT inspect the file at all — e.g. the agent
    # refusing to read a 500MB file into memory ("too_large"). Callers must send
    # this instead of silently allowing: the server marks the content
    # uninspectable so a policy decides, rather than an unread file being
    # classified Public and let through.
    inspection_skipped: Optional[str] = Field(
        None, description="Why the caller could not inspect: too_large | unreadable"
    )
    file_size: Optional[int] = Field(None, description="File size in bytes")
    event_type: str = Field(..., description="Event type (e.g., 'usb_file_transfer', 'clipboard', 'network_exfil')")
    destination_type: Optional[str] = Field(None, description="Destination type (e.g., 'removable_drive', 'network')")
    source_path: Optional[str] = Field(None, description="Source file path")
    destination_path: Optional[str] = Field(None, description="Destination path")
    # ── Network exfiltration context ─────────────────────────────────────────
    # Populated by the agent when it intercepts an outbound network transfer
    # (event_type="network_exfil"). The file itself is still sent via
    # file_content_b64 and classified/extracted exactly like a USB copy — so
    # every file type and the uninspectable invariant are handled for free.
    # These fields only add the "how / where" so method- and destination-scoped
    # policies can match. All optional: a purely content-gated network policy
    # ("block Confidential leaving over the network") ignores them entirely.
    protocol: Optional[str] = Field(None, description="Transport/app protocol: ftp|sftp|scp|http|https|tcp|udp|smb|dns|...")
    transfer_method: Optional[str] = Field(None, description="Canonical exfil method: ftp|scp|sftp|tftp|http_post|http_server|python_http_server|curl|wget|netcat|powershell_upload|smb_copy|dns_tunnel|cloud_cli|webdav|rsync|...")
    process_name: Optional[str] = Field(None, description="Process initiating the transfer (e.g. python.exe, scp.exe, curl.exe)")
    process_path: Optional[str] = Field(None, description="Full path of the initiating process")
    destination_host: Optional[str] = Field(None, description="Remote hostname / domain")
    destination_ip: Optional[str] = Field(None, description="Remote IP address")
    destination_port: Optional[int] = Field(None, description="Remote port")
    direction: Optional[str] = Field(None, description="Traffic direction: outbound|inbound")


class ClassificationDetails(BaseModel):
    """Classification result details"""
    level: str = Field(..., description="Classification level (Public/Internal/Confidential/Restricted)")
    confidence: float = Field(..., description="Confidence score (0.0 - 1.0)")
    matched_rules: List[Dict[str, Any]] = Field(default_factory=list, description="List of matched classification rules")
    total_matches: int = Field(0, description="Total number of pattern matches")
    document_types: List[Dict[str, Any]] = Field(default_factory=list, description="Detected document/image type(s), most confident first")


class PolicyEvaluationResponse(BaseModel):
    """Response model for real-time policy evaluation"""
    action: str = Field(..., description="Action to take: 'allow' or 'block'")
    reason: str = Field(..., description="Reason for the decision")
    classification: ClassificationDetails = Field(..., description="Content classification details")
    policies_triggered: List[Dict[str, Any]] = Field(default_factory=list, description="Policies that matched")
    should_log: bool = Field(True, description="Whether to log this event")
    alert_severity: Optional[str] = Field(None, description="Alert severity if applicable")
    # How the content was read. extraction_status="unreadable" means we could NOT
    # see inside (encrypted archive, scanned image, opaque binary) — the
    # classification below is therefore not evidence of being clean.
    extraction_status: str = Field("readable", description="readable | unreadable")
    extraction_kind: str = Field("text", description="pdf | docx | xlsx | archive | text | ...")


class DeviceAuthorizeRequest(BaseModel):
    """Device identity the agent reports when a USB storage device connects."""
    serial_number: Optional[str] = Field(None, description="USB serial number — the match key")
    vendor_id: Optional[str] = None
    product_id: Optional[str] = None
    product_name: Optional[str] = None
    manufacturer: Optional[str] = None
    volume_label: Optional[str] = None
    volume_serial: Optional[str] = None
    drive_letter: Optional[str] = None
    device_name: Optional[str] = None


class DeviceAuthorizeResponse(BaseModel):
    action: str                      # "allow" | "block" — what the agent must enforce
    sanctioned: bool                 # serial is on the enabled allowlist
    enforced: bool                   # a usb_device_control policy is active
    mode: str                        # "enforce" | "audit" | "off"
    would_block: bool = False        # audit mode: allowed, but would block under enforce
    reason: str
    serial_number: Optional[str] = None


async def _log_device_authorization(agent_id, req: "DeviceAuthorizeRequest", action, sanctioned,
                                     enforced, mode, would_block, reason) -> None:
    """Write the connect-time decision to the event log so the device + verdict
    are visible on the Events page."""
    import uuid as _uuid
    from app.core.domains import domain_for_event_type
    mongo = get_mongodb()["dlp_events"]
    now = datetime.now(timezone.utc)
    ident = req.product_name or req.device_name or req.serial_number or "USB device"
    if action == "block":
        title, sev = f"USB device blocked (unsanctioned): {ident}", "high"
    elif would_block:
        title, sev = f"Unsanctioned USB device allowed (audit): {ident}", "medium"
    elif enforced and sanctioned:
        title, sev = f"Sanctioned USB device allowed: {ident}", "low"
    else:
        title, sev = f"USB device connected: {ident}", "info"

    doc = {
        "id": f"devauth-{_uuid.uuid4()}",
        "timestamp": now,
        "event_type": "usb",
        "event_subtype": "usb_device_authorization",
        "usb_event_type": "device_authorization",
        "severity": sev,
        "agent_id": agent_id,
        "source": "agent",
        "source_type": "agent",
        "user_email": "agent@system",
        "title": title,
        "action_taken": action,
        "blocked": action == "block",
        "quarantined": False,
        "classification_level": None,
        "processing_status": "completed",
        "processed_at": now,
        "policy_domain": domain_for_event_type("usb"),
        # device-control specifics (read model allows extra → surface in the UI)
        "device_sanctioned": sanctioned,
        "device_control_enforced": enforced,
        "device_control_mode": mode,
        "would_block": would_block,
        "reason": reason,
        "metadata": {},
    }
    ident_fields = {k: v for k, v in {
        "serial_number": req.serial_number, "vendor_id": req.vendor_id,
        "product_id": req.product_id, "product_name": req.product_name,
        "manufacturer": req.manufacturer, "volume_label": req.volume_label,
        "volume_serial": req.volume_serial, "drive_letter": req.drive_letter,
        "device_name": req.device_name,
    }.items() if v not in (None, "")}
    doc.update(ident_fields)
    if ident_fields:
        doc["usb"] = dict(ident_fields)
    await mongo.insert_one(doc)


@router.post("/{agent_id}/device/authorize", response_model=DeviceAuthorizeResponse)
async def authorize_usb_device(
    agent_id: str,
    request: DeviceAuthorizeRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Real-time USB DEVICE authorization for agent-side enforcement (STRICT
    ALLOWLIST / default-deny). The agent calls this the moment a USB storage
    device connects, before permitting it. Requires a valid X-Agent-Key.

    Decision:
      * no active usb_device_control policy  -> allow (monitoring only)
      * serial is on the enabled allowlist   -> allow (sanctioned)
      * otherwise                            -> block  (enforce mode)
                                                allow + would_block (audit mode)

    The verdict is logged as an event so the device and outcome appear in the log.
    Content control (file inspection on transfers) is unchanged and still applies
    to sanctioned devices.
    """
    await verify_agent_key(http_request)
    from sqlalchemy import select as _select
    from app.models.policy import Policy
    from app.models.sanctioned_usb_device import SanctionedUsbDevice

    serial = (request.serial_number or "").strip()

    # Is device control enabled? Highest-priority active usb_device_control policy.
    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "usb_device_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()
    enforced = policy is not None
    mode = "off"
    if enforced:
        mode = ((policy.config or {}).get("mode") or "enforce").lower()

    # Match against the enabled registry by each exception's chosen attribute:
    # serial / manufacturer / device_id (vid:pid) / model (case-insensitive). A
    # device is sanctioned if it matches an ANY enabled allow row; an explicit deny
    # row wins over any allow (e.g. allow a whole vendor but disallow one bad serial).
    sanctioned = False
    explicitly_denied = False
    rows = (await db.execute(
        _select(SanctionedUsbDevice).where(SanctionedUsbDevice.is_enabled.is_(True))
    )).scalars().all()
    dev_serial = serial.lower()
    dev_mfg = (request.manufacturer or "").strip().lower()
    dev_model = (request.product_name or "").strip().lower()
    dev_devid = ((request.vendor_id or "").strip() + ":" + (request.product_id or "").strip()).lower()

    def _row_matches(r) -> bool:
        mt = (getattr(r, "match_type", None) or "serial")
        mv = getattr(r, "match_value", None) or (r.serial_number if mt == "serial" else None)
        mv = (mv or "").strip().lower()
        if not mv:
            return False
        return ((mt == "serial" and dev_serial and mv == dev_serial) or
                (mt == "manufacturer" and dev_mfg and mv == dev_mfg) or
                (mt == "device_id" and dev_devid != ":" and mv == dev_devid) or
                (mt == "model" and dev_model and mv == dev_model))

    for r in rows:
        if not _row_matches(r):
            continue
        if (getattr(r, "decision", None) or "allow") == "deny":
            explicitly_denied = True   # deny overrides any allow
            break
        sanctioned = True
    if explicitly_denied:
        sanctioned = False

    would_block = False
    if not enforced:
        action, reason = "allow", "USB device control not enabled — monitoring only"
    elif explicitly_denied:
        # Admin explicitly disallowed this device — block even in audit mode is
        # inconsistent with audit semantics, so honour mode but flag would_block.
        if mode == "audit":
            action, would_block, reason = "allow", True, "Device is explicitly disallowed — would be blocked (audit mode)"
        else:
            action, reason = "block", "Device is explicitly disallowed by admin"
    elif sanctioned:
        action, reason = "allow", "Device is sanctioned"
    else:
        # Unsanctioned (unknown serial, or no serial at all under strict allowlist).
        base_reason = ("Device has no serial number and cannot be sanctioned"
                       if not serial else "Unsanctioned USB storage device")
        if mode == "audit":
            action, would_block, reason = "allow", True, f"{base_reason} — would be blocked (audit mode)"
        else:
            action, reason = "block", f"{base_reason} — blocked"

    try:
        await _log_device_authorization(agent_id, request, action, sanctioned,
                                        enforced, mode, would_block, reason)
    except Exception as e:  # logging must never change the decision
        logger.warning("device authorization event log failed", agent_id=agent_id, error=str(e))

    logger.info("USB device authorization", agent_id=agent_id, serial=serial or None,
                action=action, sanctioned=sanctioned, enforced=enforced, mode=mode)
    return DeviceAuthorizeResponse(
        action=action, sanctioned=sanctioned, enforced=enforced, mode=mode,
        would_block=would_block, reason=reason, serial_number=serial or None,
    )


class UsbAllowlistResponse(BaseModel):
    enforced: bool                 # an active usb_device_control policy exists
    mode: str                      # "enforce" | "audit" | "off"
    access_mode: str               # "read_write" | "read_only" (USB STORAGE write access)
    read_only: bool                # convenience flag: access_mode == "read_only"
    count: int
    serials: List[str]             # enabled sanctioned serials (match_type=serial), UPPERCASE
    manufacturers: List[str]       # allowed manufacturers (match_type=manufacturer), lowercase
    device_ids: List[str]          # allowed "vid:pid" (match_type=device_id), lowercase
    models: List[str]              # allowed product names (match_type=model), lowercase
    devices: List[Dict[str, Any]]  # serial + vid/pid/model, for building device IDs
    generated_at: datetime


@router.get("/{agent_id}/usb-allowlist", response_model=UsbAllowlistResponse)
async def usb_allowlist(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    The USB device allowlist the endpoint enforces locally (Approach A: Windows
    Device Installation Restrictions). Returns the enabled sanctioned serials plus
    whether device control is enforced and in which mode. Requires X-Agent-Key.

    Agent should apply: enforced && mode == "enforce"  -> DenyUnspecified + allow
    ONLY these serials (block everything else, no race, works offline). mode ==
    "audit" or not enforced -> do NOT block (monitor / log-only).
    """
    await verify_agent_key(http_request)
    from sqlalchemy import select as _select
    from app.models.policy import Policy
    from app.models.sanctioned_usb_device import SanctionedUsbDevice

    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "usb_device_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()
    enforced = policy is not None
    mode = ((policy.config or {}).get("mode") or "enforce").lower() if enforced else "off"
    # Read-only USB storage: independent of enforce/audit. When set, the agent flips
    # the global StorageDevicePolicies\WriteProtect flag so USB storage mounts but
    # writes fail — lets users read from a (sanctioned) drive but not copy data out.
    access_mode = ((policy.config or {}).get("access_mode") or "read_write").lower() if enforced else "read_write"
    if access_mode not in ("read_write", "read_only"):
        access_mode = "read_write"
    read_only = access_mode == "read_only"

    rows = (await db.execute(
        _select(SanctionedUsbDevice).where(SanctionedUsbDevice.is_enabled.is_(True))
    )).scalars().all()
    # Only ALLOW rows feed the agent's sanctioned sets — deny rows must never leak
    # into the offline allow lists (they mean the opposite).
    allow_rows = [d for d in rows if (getattr(d, "decision", None) or "allow") == "allow"]

    devices = [{
        "serial_number": d.serial_number,
        "vendor_id": d.vendor_id,
        "product_id": d.product_id,
        "product_name": d.product_name,
        "manufacturer": d.manufacturer,
        "match_type": (getattr(d, "match_type", None) or "serial"),
        "match_value": getattr(d, "match_value", None),
    } for d in allow_rows]

    def _mv(mt: str) -> List[str]:
        # each allow row's match value (fall back to serial for legacy serial rows).
        out = []
        for d in allow_rows:
            row_mt = (getattr(d, "match_type", None) or "serial")
            if row_mt != mt:
                continue
            v = getattr(d, "match_value", None) or (d.serial_number if mt == "serial" else None)
            if v and v.strip():
                out.append(v.strip())
        return out

    return UsbAllowlistResponse(
        enforced=enforced, mode=mode, access_mode=access_mode, read_only=read_only,
        count=len(devices),
        # serials UPPERCASE (agent compares serials in upper); the rest lowercase.
        serials=[s.upper() for s in _mv("serial")],
        manufacturers=[s.lower() for s in _mv("manufacturer")],
        device_ids=[s.lower() for s in _mv("device_id")],
        models=[s.lower() for s in _mv("model")],
        devices=devices, generated_at=datetime.now(timezone.utc),
    )


class PrinterPolicyResponse(BaseModel):
    enforced: bool          # an active printer_control (device) policy exists
    mode: str               # "enforce" | "audit" | "off"
    scope: str              # "block_all" | "block_network" | "block_local" | "allowlist" | "none"
    printers: List[str]     # sanctioned printer names (used when scope == "allowlist")
    content_inspection: bool  # an active print_content_prevention policy exists
    content_mode: str         # "enforce" | "audit" | "off" (print content control)
    generated_at: datetime


@router.get("/{agent_id}/printer-policy", response_model=PrinterPolicyResponse)
async def printer_policy(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Printer device-control policy for the endpoint (fast scope). Returns whether
    printing is governed and how: block_all / block_network / block_local, in
    enforce or audit mode. Requires X-Agent-Key.

    The agent applies: enforced && mode=="enforce" -> cancel print jobs that match
    the scope (all printers / network printers / local printers). audit or not
    enforced -> do NOT cancel (monitor/log only). Content-aware print blocking
    (sensitive documents) is a separate, existing layer and is unaffected.
    """
    await verify_agent_key(http_request)
    from sqlalchemy import select as _select, func
    from app.models.policy import Policy
    from app.models.sanctioned_printer import SanctionedPrinter

    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "printer_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()
    enforced = policy is not None
    cfg = (policy.config or {}) if policy else {}
    mode = (cfg.get("mode") or "enforce").lower() if enforced else "off"
    scope = (cfg.get("scope") or "block_network").lower() if enforced else "none"

    # Ship the sanctioned printer names only when allowlist scope is in play, so
    # the agent can enforce "block anything not on the list" (offline-capable).
    printers: List[str] = []
    if enforced and scope == "allowlist":
        printers = [
            n for (n,) in (await db.execute(
                _select(SanctionedPrinter.printer_name).where(
                    SanctionedPrinter.is_enabled.is_(True)
                )
            )).all()
        ]

    # Is print CONTENT control active? The agent only inspects the spooled document
    # (pause + read + /evaluate) when this is true, to avoid latency otherwise.
    # content_mode drives enforce (cancel) vs audit (log "would block") agent-side.
    content_policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "print_content_prevention",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()
    content_inspection = content_policy is not None
    content_mode = ((content_policy.config or {}).get("mode") or "enforce").lower() \
        if content_inspection else "off"
    return PrinterPolicyResponse(
        enforced=enforced, mode=mode, scope=scope, printers=printers,
        content_inspection=content_inspection, content_mode=content_mode,
        generated_at=datetime.now(timezone.utc),
    )


# ── Managed-application file control ──────────────────────────────────────
# Allow/block a file ACTION (copy to USB, upload, email, print, …) based on the
# APPLICATION performing it. The endpoint returns the managed-app list, the mode,
# the channels it covers, and the exception sets (apps / users / paths / file
# types). The agent knows the acting process + user + path + type locally, so it
# enforces the verdict on the endpoint — same fetch-and-enforce model as USB
# device control and printer control.
class ApplicationControlResponse(BaseModel):
    enforced: bool                       # an active application_control policy exists
    mode: str                            # "allowlist" (only managed apps) | "blocklist" (managed apps blocked) | "off"
    applications: List[str]              # managed application exe names (lowercased)
    channels: List[str]                  # channels covered; empty = all channels
    exception_applications: List[str]    # exe names always allowed
    exception_users: List[str]           # users/groups exempt
    exception_paths: List[str]           # path prefixes exempt
    exception_file_types: List[str]      # extensions exempt (no leading dot)
    generated_at: datetime


def _lc_list(v):
    return [str(x).strip().lower() for x in (v or []) if str(x).strip()]


@router.get("/{agent_id}/application-control", response_model=ApplicationControlResponse)
async def application_control(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    The managed-application file-control policy the endpoint enforces locally.
    Agent applies, for an action on <channel> by process P (user U, path F, type T):
      1. if channels is non-empty and <channel> not in channels -> not covered, ALLOW;
      2. if P in exception_applications, or U in exception_users, or F starts with any
         exception_paths, or T in exception_file_types -> exempt, ALLOW;
      3. else mode == "allowlist": BLOCK if P not in applications;
              mode == "blocklist": BLOCK if P in applications.
    Requires X-Agent-Key (backward-compatible: no key -> allowed).
    """
    await verify_agent_key(http_request)
    from sqlalchemy import select as _select
    from app.models.policy import Policy

    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "application_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()

    if not policy:
        return ApplicationControlResponse(
            enforced=False, mode="off", applications=[], channels=[],
            exception_applications=[], exception_users=[], exception_paths=[],
            exception_file_types=[], generated_at=datetime.now(timezone.utc),
        )

    cfg = policy.config or {}
    mode = (cfg.get("mode") or "allowlist").lower()
    if mode not in ("allowlist", "blocklist"):
        mode = "allowlist"
    exc = cfg.get("exceptions") or {}
    return ApplicationControlResponse(
        enforced=True,
        mode=mode,
        applications=_lc_list(cfg.get("applications")),
        channels=_lc_list(cfg.get("channels")),
        exception_applications=_lc_list(exc.get("applications")),
        exception_users=_lc_list(exc.get("users")),
        # paths keep their case (Windows is case-insensitive; the agent lowercases at compare)
        exception_paths=[str(p).strip() for p in (exc.get("paths") or []) if str(p).strip()],
        exception_file_types=[str(t).strip().lower().lstrip(".") for t in (exc.get("file_types") or []) if str(t).strip()],
        generated_at=datetime.now(timezone.utc),
    )


# ── Network file-share transfer control ───────────────────────────────────
# Allow/block copying files to network file shares (mapped network drives; UNC
# resolved via WNetGetConnection). Two modes: block_all (block every copy to a
# share) or content_aware (block only Confidential/Restricted). Exceptions exempt
# specific shares/servers, users, source paths, or file types. Agent enforces
# locally on the network-drive watcher — same fetch-and-enforce model as the others.
class NetworkSharePolicyResponse(BaseModel):
    enforced: bool                        # an active network_share_control policy exists
    mode: str                             # "block_all" | "content_aware" | "off"
    action: str                           # "audit" (log/event only) | "block" (quarantine + delete)
    exception_shares: List[str]           # UNC prefixes always allowed (lowercased)
    exception_users: List[str]            # users/groups exempt (lowercased)
    exception_paths: List[str]            # source path prefixes exempt (case preserved)
    exception_file_types: List[str]       # extensions exempt (no leading dot)
    generated_at: datetime


@router.get("/{agent_id}/network-share-policy", response_model=NetworkSharePolicyResponse)
async def network_share_policy(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    The network-share transfer-control policy the endpoint enforces locally. Agent
    watches mapped network drives; for a file copied to a share (not matching an
    exception) it blocks (block_all) or classifies + blocks if sensitive
    (content_aware). Requires X-Agent-Key (backward-compatible: no key -> allowed).
    """
    await verify_agent_key(http_request)
    from sqlalchemy import select as _select
    from app.models.policy import Policy

    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "network_share_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()

    if not policy:
        return NetworkSharePolicyResponse(
            enforced=False, mode="off", action="audit",
            exception_shares=[], exception_users=[], exception_paths=[],
            exception_file_types=[], generated_at=datetime.now(timezone.utc),
        )
    cfg = policy.config or {}
    mode = (cfg.get("mode") or "block_all").lower()
    if mode not in ("block_all", "content_aware"):
        mode = "block_all"
    # Default to audit so enabling a policy never deletes until the admin opts in.
    action = (cfg.get("action") or "audit").lower()
    if action not in ("audit", "block"):
        action = "audit"
    exc = cfg.get("exceptions") or {}
    return NetworkSharePolicyResponse(
        enforced=True, mode=mode, action=action,
        exception_shares=_lc_list(exc.get("shares")),
        exception_users=_lc_list(exc.get("users")),
        exception_paths=[str(p).strip() for p in (exc.get("paths") or []) if str(p).strip()],
        exception_file_types=[str(t).strip().lower().lstrip(".") for t in (exc.get("file_types") or []) if str(t).strip()],
        generated_at=datetime.now(timezone.utc),
    )


# ── Wireless / Bluetooth transfer control ─────────────────────────────────
# Block file transfer over Bluetooth (Object Push / File Transfer profiles) and
# Wi-Fi Direct / Nearby Sharing, while leaving audio (headphones) + input (HID)
# devices working. The agent applies the OS-level disables locally and reconciles
# them each sync — same fetch-and-enforce model as the other device controls.
class WirelessPolicyResponse(BaseModel):
    enforced: bool                        # an active wireless_transfer_control policy exists
    mode: str                             # "enforce" | "audit" | "off"
    block_bluetooth_file_transfer: bool   # block Bluetooth OPP/FTP (audio/HID stay allowed)
    block_nearby_sharing: bool            # block Wi-Fi Direct / Windows Nearby Sharing
    generated_at: datetime


@router.get("/{agent_id}/wireless-policy", response_model=WirelessPolicyResponse)
async def wireless_policy(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    The wireless-transfer control policy the endpoint enforces locally. Agent, in
    enforce mode, disables Bluetooth file-transfer profiles (audio/HID untouched)
    and/or Wi-Fi Direct / Nearby Sharing; in audit mode it logs "would block" only.
    Requires X-Agent-Key (backward-compatible: no key -> allowed).
    """
    await verify_agent_key(http_request)
    from sqlalchemy import select as _select
    from app.models.policy import Policy

    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "wireless_transfer_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()

    if not policy:
        return WirelessPolicyResponse(
            enforced=False, mode="off",
            block_bluetooth_file_transfer=False, block_nearby_sharing=False,
            generated_at=datetime.now(timezone.utc),
        )
    cfg = policy.config or {}
    mode = (cfg.get("mode") or "enforce").lower()
    if mode not in ("enforce", "audit"):
        mode = "enforce"
    return WirelessPolicyResponse(
        enforced=True, mode=mode,
        block_bluetooth_file_transfer=bool(cfg.get("block_bluetooth_file_transfer", True)),
        block_nearby_sharing=bool(cfg.get("block_nearby_sharing", True)),
        generated_at=datetime.now(timezone.utc),
    )


@router.post("/{agent_id}/policy/evaluate", response_model=PolicyEvaluationResponse)
async def evaluate_policy_realtime(
    agent_id: str,
    request: PolicyEvaluationRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Real-time policy evaluation for agent-side enforcement.

    SECURITY: Requires a valid X-Agent-Key header. Previously this was
    anonymous — which both let external callers use it as a
    classification oracle to tune exfiltration so it lands as "Public",
    and let them DoS the classification engine with arbitrarily large
    file contents since the endpoint is expensive.

    Agent calls this BEFORE allowing a file transfer or action.
    Server classifies content and evaluates policies, then returns
    a decision (allow/block) with full classification details.

    This enables content-aware blocking based on sensitive data detection.
    """
    await verify_agent_key(http_request)

    try:
        # 0. Resolve the text to classify. When the caller sends raw bytes we
        #    extract real text from them (pdf/docx/xlsx/pptx/text). This is what
        #    makes binary documents classifiable at all — decoding their bytes
        #    into a string yields compressed garbage that always looks "Public".
        content_to_classify = request.file_content or ""
        extract_kind = "text"
        # readable | unreadable — whether we could actually see inside the file.
        # An encrypted archive / scanned image / opaque binary is NOT the same as
        # "clean", and must never be silently treated as Public. We surface it as
        # a policy-matchable field so operators choose: block unreadable content
        # (strict) or allow it (lenient). Defaults to readable for plain text.
        extraction_status = "readable"
        extraction_reason = ""
        if request.inspection_skipped:
            # The caller told us up front it couldn't look inside (too big to
            # read, etc). Don't pretend: mark it uninspectable and let policy rule.
            extraction_status = "too_large" if request.inspection_skipped == "too_large" else "unreadable"
            extract_kind = request.inspection_skipped
            extraction_reason = f"caller skipped inspection: {request.inspection_skipped}"
            content_to_classify = ""
            logger.info(
                "Caller skipped inspection",
                agent_id=agent_id, file_name=request.file_name,
                reason=request.inspection_skipped, file_size=request.file_size,
            )
        elif request.file_content_b64:
            import base64 as _b64
            from app.services.document_extract import extract_text as _extract_text
            try:
                raw = _b64.b64decode(request.file_content_b64, validate=False)
            except Exception as e:  # noqa: BLE001 — malformed base64 from an agent
                raise HTTPException(400, f"file_content_b64 is not valid base64: {e}")
            extracted = _extract_text(request.file_name, raw)
            content_to_classify = extracted.text
            extract_kind = extracted.kind
            extraction_reason = extracted.reason
            if not extracted.ok:
                # We got no text. WHY matters, because policy blocks on this.
                #
                #   no_text_content — the file simply isn't text-bearing: a photo
                #     OCR confirmed has no writing, a video, an installer, a disk
                #     image. There is nothing here to leak, so blocking it is a
                #     pure false positive. Measured: treating these as
                #     "unreadable" blocked every holiday photo, mp4, exe and iso
                #     copied to a USB stick — unusable on a real endpoint.
                #
                #   unreadable — a document we SHOULD have been able to read and
                #     couldn't: encrypted archive, corrupt/renamed office file,
                #     legacy .doc, an image we couldn't OCR. That's the evasion
                #     shape, and policy blocks it.
                #
                #   too_large — inspection skipped entirely; policy decides.
                if extracted.kind == "too_large":
                    extraction_status = "too_large"
                elif extracted.kind in _NO_TEXT_KINDS:
                    extraction_status = "no_text_content"
                else:
                    extraction_status = "unreadable"
                logger.info(
                    "Content not extractable",
                    agent_id=agent_id, file_name=request.file_name,
                    kind=extracted.kind, reason=extracted.reason,
                    extraction_status=extraction_status,
                )
            elif extracted.truncated:
                # We read it, but not all of it: it outran the scan budget, or an
                # archive hit its safety limits. The text we DID get is still
                # classified below — it may convict the file on its own — but we
                # must not certify the part we never saw. Reported as too_large so
                # the existing "Block Uninspectable Content" policy governs it,
                # exactly as for a file that was too big to open. Otherwise padding
                # a file with filler until the secret falls past the budget is a
                # trivial bypass.
                extraction_status = "too_large"
                logger.info(
                    "Content only partially inspected",
                    agent_id=agent_id, file_name=request.file_name,
                    kind=extracted.kind, reason=extracted.reason,
                    scanned_chars=len(extracted.text),
                )

        # 1. Classify the file content using ClassificationEngine
        classification_engine = ClassificationEngine(db)
        classification_result = await classification_engine.classify_content(
            content_to_classify,
            context={
                "event_type": request.event_type,
                "file_name": request.file_name,
                "source_path": request.source_path,
            }
        )

        logger.info(
            "Content classified",
            agent_id=agent_id,
            file_name=request.file_name,
            classification=classification_result.classification,
            confidence=classification_result.confidence_score,
            matched_rules_count=len(classification_result.matched_rules),
        )

        # 1b. Identify the document/image TYPE (patent, passport, source code, …).
        # Purely ADDITIVE: this never changes the classification level or any
        # existing decision — it only annotates the event and exposes a new
        # policy-matchable field. Guarded so a failure can't affect evaluate.
        document_types = []
        try:
            from app.services.document_classifier import classify_document
            document_types = classify_document(content_to_classify)
        except Exception as e:
            logger.warning("Document-type classification failed", error=str(e))

        # 2. Build event data structure for policy evaluation
        event_data = {
            "classification_level": classification_result.classification,
            "confidence_score": classification_result.confidence_score,
            "classification_labels": [
                label
                for rule in classification_result.matched_rules
                for label in rule.get("classification_labels", [])
            ],
            "event_type": request.event_type,
            "destination_type": request.destination_type,
            "source_path": request.source_path,
            "destination_path": request.destination_path,
            "file_name": request.file_name,
            "file_size": request.file_size,
            "agent_id": agent_id,
            # Policy-matchable: lets an operator write
            #   extraction_status equals unreadable -> block
            # to stop password-protected archives / scanned images, which we
            # cannot inspect and which would otherwise look "Public".
            "extraction_status": extraction_status,
            "extraction_kind": extract_kind,
            # Additive: the detected document/image type. Policy-matchable, so an
            # operator MAY write `document_type equals source_code -> block`.
            # Existing policies don't reference it, so their behaviour is unchanged.
            "document_type": document_types[0]["type"] if document_types else None,
            "document_type_label": document_types[0]["label"] if document_types else None,
        }

        # Network exfiltration context — only present for network_exfil events.
        # Written both flat and under a "network"/"process" object so the
        # evaluator's dotted field mappings resolve either shape. Blank/absent
        # fields are dropped so a rule like `transfer_method in [...]` simply
        # doesn't match rather than matching an empty string.
        network_fields = {
            "protocol": request.protocol,
            "transfer_method": request.transfer_method,
            "process_name": request.process_name,
            "process_path": request.process_path,
            "destination_host": request.destination_host,
            "destination_ip": request.destination_ip,
            "destination_port": request.destination_port,
            "direction": request.direction,
        }
        network_fields = {k: v for k, v in network_fields.items() if v not in (None, "")}
        if network_fields:
            event_data.update(network_fields)
            event_data["network"] = {
                k: v for k, v in network_fields.items() if k not in ("process_name", "process_path")
            }
            event_data["process"] = {
                "name": request.process_name,
                "path": request.process_path,
            }

        # 3. Evaluate classification-aware policies
        policy_evaluator = DatabasePolicyEvaluator()
        policy_matches = await policy_evaluator.evaluate_event(event_data)

        # 4. Determine action based on matched policies
        should_block = False
        should_alert = False
        alert_severity = None
        triggered_policies = []

        for match in policy_matches:
            triggered_policies.append({
                "policy_id": match.policy_id,
                "policy_name": match.policy_name,
                "severity": match.severity,
                "priority": match.priority,
            })

            # Check actions
            for action in match.actions:
                action_type = action.get("type") or action.get("action")
                if action_type == "block":
                    should_block = True
                elif action_type == "alert":
                    should_alert = True
                    # Get highest severity
                    action_severity = action.get("parameters", {}).get("severity") or match.severity
                    if action_severity:
                        if alert_severity is None or _severity_rank(action_severity) > _severity_rank(alert_severity):
                            alert_severity = action_severity

        # 5. Build response
        action = "block" if should_block else "allow"

        # Build detailed reason
        if classification_result.matched_rules:
            rule_names = [r["rule_name"] for r in classification_result.matched_rules[:5]]
            reason = f"Classification: {classification_result.classification} (confidence {classification_result.confidence_score:.2%}). "
            reason += f"Detected: {', '.join(rule_names)}"
            if len(classification_result.matched_rules) > 5:
                reason += f" and {len(classification_result.matched_rules) - 5} more"
        else:
            reason = f"Classification: {classification_result.classification} - no sensitive data detected"

        if should_block:
            reason = f"BLOCKED - {reason}"

        logger.info(
            "Policy evaluation complete",
            agent_id=agent_id,
            file_name=request.file_name,
            action=action,
            policies_triggered=len(triggered_policies),
            should_block=should_block,
        )

        return PolicyEvaluationResponse(
            action=action,
            reason=reason,
            classification=ClassificationDetails(
                level=classification_result.classification,
                confidence=classification_result.confidence_score,
                matched_rules=classification_result.matched_rules,
                total_matches=classification_result.total_matches,
                document_types=document_types,
            ),
            policies_triggered=triggered_policies,
            should_log=True,
            alert_severity=alert_severity,
            extraction_status=extraction_status,
            extraction_kind=extract_kind,
        )

    except Exception as e:
        logger.error(
            "Policy evaluation failed",
            agent_id=agent_id,
            file_name=request.file_name,
            error=str(e),
        )
        # Fail-safe: allow on error (configurable)
        return PolicyEvaluationResponse(
            action="allow",
            reason=f"Policy evaluation error: {str(e)}",
            classification=ClassificationDetails(
                level="Public",
                confidence=0.0,
                matched_rules=[],
                total_matches=0,
            ),
            policies_triggered=[],
            should_log=True,
            alert_severity=None,
        )


def _severity_rank(severity: str) -> int:
    """Convert severity to numeric rank for comparison"""
    ranks = {"low": 1, "medium": 2, "high": 3, "critical": 4}
    return ranks.get(severity.lower(), 0)
