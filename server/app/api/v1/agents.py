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

from app.core.security import get_current_user, require_permission, require_role
from app.core.database import get_mongodb, get_db
from app.services.policy_service import PolicyService
from app.services.classification_engine import ClassificationEngine
from app.policies.agent_policy_transformer import AgentPolicyTransformer
from app.policies.database_policy_evaluator import DatabasePolicyEvaluator
from app.core.cache import get_cache, CacheService
from app.core import web_activity as _WA
from app.core import masking as _MASK
from app.core import agent_suspension as _SUSP
from pymongo import ReturnDocument as _ReturnDocument

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
    # Endpoint inventory — reported by the agent, optional so legacy docs
    # (registered before these were captured) still validate.
    hostname: Optional[str] = Field(None, description="Endpoint hostname")
    # OS is split into a precise product name (shown in the OS column) and a
    # granular version (shown in the Version column). ``os_name`` examples:
    # "Windows 11 Pro", "Ubuntu 22.04.3 LTS". ``os_version`` examples:
    # "23H2 (Build 22631.4460)", "6.8.0-124-generic" (Linux kernel).
    os_name: Optional[str] = Field(None, description="Precise OS product name, e.g. 'Windows 11 Pro' / 'Ubuntu 22.04.3 LTS'")
    os_version: Optional[str] = Field(None, description="Granular OS version/build, e.g. '23H2 (Build 22631.4460)' / kernel release")
    # The endpoint may have several people logged in at once (RDP, fast user
    # switching, multi-seat Linux). ``logged_in_users`` lists them all;
    # ``username`` is the primary/active one for back-compat and fallback.
    username: Optional[str] = Field(None, description="Primary/active logged-in user on the endpoint")
    logged_in_users: Optional[List[str]] = Field(None, description="All users with an active login session")
    # TODO: Implement agent resume functionality so agents can resume instead of creating new entries
    # Status field removed - agents are considered active if they've sent heartbeat within timeout period
    last_seen: datetime = Field(..., description="Last heartbeat timestamp")
    created_at: datetime = Field(..., description="Registration timestamp")
    policy_version: Optional[str] = Field(None, description="Last policy bundle version applied")
    policy_sync_status: Optional[str] = Field(None, description="Most recent policy sync status")
    policy_last_synced_at: Optional[str] = Field(None, description="ISO timestamp for last policy sync")
    policy_sync_error: Optional[str] = Field(None, description="Last policy sync error message, if any")
    # Temporary suspension ("Pause"). Orthogonal to lifecycle_status, which
    # answers a different question — whether the machine is heartbeating. An
    # agent can be paused and connected (the normal case), or paused and
    # unplugged, and collapsing the two would hide one of them.
    is_suspended: bool = Field(False, description="Agent is currently paused: no policies applied, events discarded")
    suspended_until: Optional[datetime] = Field(None, description="When the pause auto-expires; null means until manually resumed")
    suspended_at: Optional[datetime] = Field(None, description="When the pause was applied")
    suspended_by: Optional[str] = Field(None, description="Admin who paused it")
    suspend_reason: Optional[str] = Field(None, description="Operator-supplied reason for the pause")
    suspension_seconds_remaining: Optional[float] = Field(None, description="Seconds until auto-resume; null when indefinite")

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
    current_user: dict = Depends(require_permission("view_events")),
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

        # Resolve the pause on read (expiry is never swept by a job) so a
        # lapsed suspension reports as live even before anything rewrites it.
        agent_doc.update(_SUSP.resolve(agent_doc))

        agents.append(Agent(**agent_doc))

    logger.info("Listed agents", count=len(agents))
    return agents


@router.get("/all")
async def list_all_agents(
    include_deleted: bool = False,
    current_user: dict = Depends(require_permission("view_events")),
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

        # Temporary suspension, resolved on read: a pause whose deadline has
        # passed reports as live here without waiting for anything to clear
        # the stored flag.
        agent_doc.update(_SUSP.resolve(agent_doc))

        # Normalize datetime fields to ISO format
        for dt_field in (
            "last_seen",
            "created_at",
            "last_heartbeat",
            "deleted_at",
            "suspended_at",
            "suspended_until",
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
    # Endpoint inventory details reported by the agent. These are optional so
    # older agents (which never sent them) keep registering unchanged; when
    # present they let the UI show precise OS build, hostname and the
    # logged-in user. ``hostname`` falls back to the agent name so the column
    # is never blank for agents that omit it.
    reported_os_version = body.get("os_version") or None
    reported_os_name = body.get("os_name") or None
    reported_hostname = body.get("hostname") or agent.name
    # ``logged_in_users`` is the authoritative list of who is on the endpoint.
    # Accept only a clean list of non-empty strings; anything else → None so a
    # malformed payload never clobbers a good prior value.
    raw_logged_in = body.get("logged_in_users")
    if isinstance(raw_logged_in, list):
        reported_logged_in_users = [str(u).strip() for u in raw_logged_in if str(u).strip()]
        reported_logged_in_users = reported_logged_in_users or None
    else:
        reported_logged_in_users = None
    # username = the explicit primary user, else the first logged-in user.
    reported_username = body.get("username") or (
        reported_logged_in_users[0] if reported_logged_in_users else None
    )
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
            "hostname": reported_hostname,
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
        # Only overwrite os_version / username when the agent actually
        # reported them, so a re-register from an older agent that omits
        # these fields never blanks out values captured on a prior run.
        if reported_os_version:
            update_fields["os_version"] = reported_os_version
        if reported_os_name:
            update_fields["os_name"] = reported_os_name
        if reported_username:
            update_fields["username"] = reported_username
        if reported_logged_in_users is not None:
            update_fields["logged_in_users"] = reported_logged_in_users
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
        # Mirror the persisted changes onto the in-memory doc so the
        # registration response echoes the values we just wrote (hostname,
        # os_version, username, ip, version) instead of the pre-update state.
        existing.update(update_fields)
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
            "os_version": reported_os_version,
            "os_name": reported_os_name,
            "hostname": reported_hostname,
            "username": reported_username,
            "logged_in_users": reported_logged_in_users,
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
    current_user: dict = Depends(require_permission("view_events")),
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

    agent_doc.update(_SUSP.resolve(agent_doc))

    return Agent(**agent_doc)


class HeartbeatRequest(BaseModel):
    """Heartbeat request model"""
    timestamp: Optional[str] = Field(None, description="Agent timestamp (ISO format)")
    status: Optional[str] = Field(None, description="Agent status")
    ip_address: Optional[str] = Field(None, description="Current IP address")
    # Endpoint inventory refresh — lets the logged-in user / OS build stay
    # current between agent restarts (a user can log off/on without the agent
    # re-registering). Optional so agents that omit them change nothing.
    os_version: Optional[str] = Field(None, description="Granular OS version/build")
    os_name: Optional[str] = Field(None, description="Precise OS product name")
    hostname: Optional[str] = Field(None, description="Endpoint hostname")
    username: Optional[str] = Field(None, description="Primary/active logged-in user")
    logged_in_users: Optional[List[str]] = Field(None, description="All users with an active login session")
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
    if heartbeat and heartbeat.os_version:
        update_data["os_version"] = heartbeat.os_version
    if heartbeat and heartbeat.os_name:
        update_data["os_name"] = heartbeat.os_name
    if heartbeat and heartbeat.hostname:
        update_data["hostname"] = heartbeat.hostname
    if heartbeat and heartbeat.username:
        update_data["username"] = heartbeat.username
    if heartbeat and heartbeat.logged_in_users:
        # Coerce to a clean list of non-empty strings; ignore a stray empty
        # payload so a good prior value is never wiped.
        cleaned = [str(u).strip() for u in heartbeat.logged_in_users if str(u).strip()]
        if cleaned:
            update_data["logged_in_users"] = cleaned
            update_data.setdefault("username", cleaned[0])
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

    # A pause that has run out is already over everywhere it matters —
    # ``_SUSP.resolve`` computes expiry on read, so nothing is enforcing it.
    # Clear the stored flags here, on a write we were doing anyway, so the
    # record stops advertising a suspension that no longer applies (a stale
    # "paused by alice" on a live agent is the kind of thing an operator acts
    # on). Only fires on the one heartbeat that crosses the deadline.
    if previous.get("suspended") and not _SUSP.resolve(previous)["is_suspended"]:
        await agents_collection.update_one(
            {"_id": previous["_id"]}, {"$set": _SUSP.clear_update()}
        )
        _SUSP.invalidate(agent_id)
        _SUSP.invalidate(previous.get("agent_id"))
        logger.info("Agent suspension expired — resumed automatically", agent_id=agent_id)

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


class AgentSuspendRequest(BaseModel):
    """Pause an endpoint for a bounded window."""

    duration_minutes: Optional[int] = Field(
        None,
        description=(
            "How long to stay paused. Omit or send null to pause until an "
            "admin explicitly resumes."
        ),
    )
    reason: Optional[str] = Field(
        None, max_length=500, description="Why — shown on the Agents page and written to the audit log"
    )


class AgentSuspendResponse(BaseModel):
    agent_id: str
    is_suspended: bool
    suspended_until: Optional[datetime] = None
    suspended_at: Optional[datetime] = None
    suspended_by: Optional[str] = None
    suspend_reason: Optional[str] = None
    suspension_seconds_remaining: Optional[float] = None


def _actor_email(current_user: Any) -> Optional[str]:
    if isinstance(current_user, dict):
        return current_user.get("email")
    return getattr(current_user, "email", None)


def _actor_id(current_user: Any) -> Any:
    if isinstance(current_user, dict):
        return current_user.get("id")
    return getattr(current_user, "id", None)


@router.post("/{agent_id}/suspend", response_model=AgentSuspendResponse)
async def suspend_agent(
    agent_id: str,
    body: AgentSuspendRequest,
    current_user: dict = Depends(require_role("admin")),
) -> AgentSuspendResponse:
    """
    Temporarily switch an agent off (admin action — "Pause" in the UI).

    While paused the endpoint receives an empty policy bundle and inert
    channel policies, live evaluations return ``allow``, and its events are
    discarded on arrival. See ``app.core.agent_suspension`` for why that
    combination turns the agent off at the source rather than merely muting
    it here.

    The agent keeps heartbeating and stays listed, so the machine remains
    visible while its protection is off — and picks the resume up on its
    next poll without any push channel.

    Distinct from DELETE: this is reversible, self-expiring, and does not
    hide the agent.
    """
    duration = body.duration_minutes
    if duration is not None:
        if duration <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="duration_minutes must be a positive number of minutes (omit it to pause indefinitely)",
            )
        if duration > _SUSP.MAX_DURATION_MINUTES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"duration_minutes may not exceed {_SUSP.MAX_DURATION_MINUTES} "
                    "(90 days). Remove the agent instead of pausing it for longer."
                ),
            )

    db = get_mongodb()
    agents_collection = db["agents"]
    actor = _actor_email(current_user)

    update = _SUSP.suspend_update(
        duration_minutes=duration, actor=actor, reason=body.reason
    )

    # Match a rolled UUID too, so a reinstalled endpoint still carrying its old
    # local id cannot slip out from under an active pause.
    updated = await agents_collection.find_one_and_update(
        {"$or": [{"agent_id": agent_id}, {"previous_agent_ids": agent_id}]},
        {"$set": update},
        return_document=_ReturnDocument.AFTER,
    )
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    # Both ids: the caller may have addressed a rolled UUID, and the cache is
    # keyed by whatever the agent actually sends.
    _SUSP.invalidate(agent_id)
    _SUSP.invalidate(updated.get("agent_id"))

    try:
        from app.services.audit_service import audit_log
        await audit_log(
            _actor_id(current_user),
            "agent.suspend",
            {
                "agent_id": agent_id,
                "duration_minutes": duration,
                "suspended_until": update["suspended_until"].isoformat() if update["suspended_until"] else None,
                "reason": update["suspend_reason"],
            },
        )
    except Exception as e:  # noqa: BLE001 — never block the response on audit
        logger.warning("Failed to record agent.suspend audit log", error=str(e))

    state = _SUSP.resolve(updated)
    logger.info(
        "Agent suspended",
        agent_id=agent_id,
        duration_minutes=duration,
        indefinite=duration is None,
        user=actor,
    )
    return AgentSuspendResponse(agent_id=updated.get("agent_id", agent_id), **state)


@router.post("/{agent_id}/resume", response_model=AgentSuspendResponse)
async def resume_agent(
    agent_id: str,
    current_user: dict = Depends(require_role("admin")),
) -> AgentSuspendResponse:
    """
    Lift a suspension early (admin action — "Resume" in the UI).

    Idempotent: resuming an agent that is not paused, or whose pause has
    already expired on its own, is a no-op that still returns 200. Clearing
    an already-expired pause is worth doing — it tidies the stored flags so
    the record matches what every read path already computes.
    """
    db = get_mongodb()
    agents_collection = db["agents"]
    actor = _actor_email(current_user)

    updated = await agents_collection.find_one_and_update(
        {"$or": [{"agent_id": agent_id}, {"previous_agent_ids": agent_id}]},
        {"$set": _SUSP.clear_update()},
        return_document=_ReturnDocument.AFTER,
    )
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    _SUSP.invalidate(agent_id)
    _SUSP.invalidate(updated.get("agent_id"))

    try:
        from app.services.audit_service import audit_log
        await audit_log(_actor_id(current_user), "agent.resume", {"agent_id": agent_id})
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to record agent.resume audit log", error=str(e))

    logger.info("Agent resumed", agent_id=agent_id, user=actor)
    return AgentSuspendResponse(
        agent_id=updated.get("agent_id", agent_id), **_SUSP.resolve(updated)
    )


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
    current_user: dict = Depends(require_permission("view_events")),
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

    # ── Paused endpoint: hand back an EMPTY bundle ───────────────────────────
    #
    # This is what actually switches the agent off, and it is worth being
    # precise about why an empty bundle beats a "you are suspended" flag.
    #
    # The endpoint agent derives its own master monitoring switch from the
    # bundle it was given: no file / clipboard / USB policies means it stops
    # watching and stops emitting events entirely (``allowEvents`` in
    # agent.cpp). So an empty bundle stops the work AT THE SOURCE instead of
    # letting the endpoint keep scanning and discarding the results here. It
    # also needs no agent-side support, so it governs binaries already
    # deployed in the field, and the agent caches the bundle — a reboot part
    # way through a pause comes back still paused.
    #
    # The version is a hash of the (empty) policy set, so it differs from the
    # live bundle's version and the agent applies it; on resume the real
    # version returns and the agent restores itself on its next sync. No
    # special cases at either end.
    #
    # Cache is bypassed deliberately: a paused agent must neither read a
    # populated bundle nor publish its empty one for anyone else.
    if _SUSP.resolve(agent_doc)["is_suspended"]:
        empty = _get_agent_policy_transformer().build_bundle(
            [], platform, capabilities, agent_id=agent_id
        )
        empty_version = empty.get("version")
        logger.info(
            "Agent is suspended — issuing empty policy bundle",
            agent_id=agent_id,
            platform=platform,
        )
        if sync_request.installed_version and sync_request.installed_version == empty_version:
            return AgentPolicySyncResponse(
                status="up_to_date",
                version=empty_version,
                generated_at=datetime.now(timezone.utc),
                policy_count=0,
                policies={},
            )
        return AgentPolicySyncResponse(
            status="updated",
            version=empty_version,
            generated_at=datetime.now(timezone.utc),
            policy_count=0,
            policies={},
        )

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
    # Endpoint-computed file hashes, used for the file-hash denylist rule
    # (Print/USB). Optional: if the agent sends file_content_b64, the server
    # computes them from the raw bytes instead.
    file_sha256: Optional[str] = Field(None, description="SHA-256 of the file (hex), for file-hash rules")
    file_md5: Optional[str] = Field(None, description="MD5 of the file (hex), for file-hash rules")
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
    # ── Web activity context ─────────────────────────────────────────────────
    # Sent by the browser extension when it intercepts an activity in a
    # catalogued web app. These are the two dimensions the product had no
    # representation for: WHAT KIND of app the destination is, and WHAT THE USER
    # IS DOING. Without them every interception was "a file upload", so a
    # requirement written as "block Attach & Send on webmail but allow Download"
    # could not be expressed at all.
    #
    # All optional: an agent that knows nothing about web activity sends none of
    # them and evaluates exactly as before.
    activity: Optional[str] = Field(
        None, description="upload | download | attach | send | post | ai_response"
    )
    app_category: Optional[str] = Field(
        None, description="webmail | cloud_storage | collaboration | genai"
    )
    app_id: Optional[str] = Field(None, description="Catalog app id, e.g. 'chatgpt'")
    app_name: Optional[str] = Field(None, description="Human app name, e.g. 'ChatGPT'")
    # The typed/pasted prose itself — a GenAI prompt, an email body, a chat
    # message. Distinct from file_content, which is an *attachment's* text: a
    # single Send can carry both, and a policy that blocks the prompt must not
    # be confused by an innocent attachment (or vice versa). Classified together
    # but reported separately.
    text_content: Optional[str] = Field(
        None, description="Typed/pasted body text (prompt, email body, chat message)"
    )


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
    # Redaction, for action="mask". masked_text is authoritative: the caller
    # writes exactly this back into the composer rather than applying the
    # offsets itself, so there is one implementation of the substitution and
    # no way for the two sides to disagree about encoding or ordering.
    # `redactions` is for display and audit only.
    masked_text: Optional[str] = Field(None, description="The submitted text with sensitive values replaced")
    redactions: List[Dict[str, Any]] = Field(
        default_factory=list, description="Replaced spans: start, end, type, token — never the value"
    )
    mask_summary: List[Dict[str, Any]] = Field(
        default_factory=list, description="What was replaced, as [{type, count}]"
    )


# ── Inert responses for a paused endpoint ────────────────────────────────────
#
# Every channel policy the agent asks about already has an "off" shape — the
# one it gets when no policy of that type exists. A paused agent is handed
# exactly that shape, so it takes the code path it already takes on a fleet
# with no policies configured. Nothing new has to be understood at the other
# end, and there is no half-armed state where the agent thinks a control is
# live but the server has stopped answering for it.
#
# These sit alongside the empty policy bundle in ``sync_agent_policies``, which
# is what stops the agent doing the work at all. The guards here close the gap
# between an admin clicking Pause and the agent's next sync, and cover any
# caller that ignores its bundle.
SUSPENDED_REASON = "Agent is suspended — monitoring and enforcement are paused"


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

    if await _SUSP.is_suspended(agent_id):
        return DeviceAuthorizeResponse(
            action="allow",
            sanctioned=False,
            enforced=False,
            mode="off",
            would_block=False,
            reason=SUSPENDED_REASON,
            serial_number=(request.serial_number or None),
        )
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
    # ── Explicit disallows ───────────────────────────────────────────────────
    # A deny row means "never this device", and it BEATS any allow that would
    # otherwise cover it. The agent must subtract these AFTER matching the allow
    # lists above, exactly as the runtime authorize endpoint does.
    #
    # Without them the offline path and the runtime path disagreed, and the
    # offline one wins in practice: allow a vendor fleet, deny one bad serial
    # inside it, and the agent's Device Installation Restrictions admitted the
    # denied stick on the strength of the vendor rule — the runtime check that
    # would have blocked it never got the chance, which is the whole point of
    # enforcing offline. Same defect the printer policy had before
    # ``blocked_printers`` was added; this is the USB half of that fix.
    denied_serials: List[str] = []        # UPPERCASE, to match `serials`
    denied_manufacturers: List[str] = []  # lowercase
    denied_device_ids: List[str] = []     # lowercase "vid:pid"
    denied_models: List[str] = []         # lowercase
    denied_count: int = 0
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

    if await _SUSP.is_suspended(agent_id):
        return UsbAllowlistResponse(
            enforced=False, mode="off", access_mode="read_write", read_only=False,
            count=0, serials=[], manufacturers=[], device_ids=[], models=[], devices=[],
            denied_serials=[], denied_manufacturers=[], denied_device_ids=[],
            denied_models=[], denied_count=0,
            generated_at=datetime.now(timezone.utc),
        )
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
    # into the offline allow lists (they mean the opposite). They are sent
    # separately below, because leaving them out entirely was its own bug.
    allow_rows = [d for d in rows if (getattr(d, "decision", None) or "allow") == "allow"]
    deny_rows = [d for d in rows if (getattr(d, "decision", None) or "allow") == "deny"]

    devices = [{
        "serial_number": d.serial_number,
        "vendor_id": d.vendor_id,
        "product_id": d.product_id,
        "product_name": d.product_name,
        "manufacturer": d.manufacturer,
        "match_type": (getattr(d, "match_type", None) or "serial"),
        "match_value": getattr(d, "match_value", None),
    } for d in allow_rows]

    def _mv(source, mt: str) -> List[str]:
        # each row's match value (fall back to serial for legacy serial rows).
        out = []
        for d in source:
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
        serials=[s.upper() for s in _mv(allow_rows, "serial")],
        manufacturers=[s.lower() for s in _mv(allow_rows, "manufacturer")],
        device_ids=[s.lower() for s in _mv(allow_rows, "device_id")],
        models=[s.lower() for s in _mv(allow_rows, "model")],
        denied_serials=[s.upper() for s in _mv(deny_rows, "serial")],
        denied_manufacturers=[s.lower() for s in _mv(deny_rows, "manufacturer")],
        denied_device_ids=[s.lower() for s in _mv(deny_rows, "device_id")],
        denied_models=[s.lower() for s in _mv(deny_rows, "model")],
        denied_count=len(deny_rows),
        devices=devices, generated_at=datetime.now(timezone.utc),
    )


class PrinterPolicyResponse(BaseModel):
    enforced: bool          # an active printer_control (device) policy exists
    mode: str               # "enforce" | "audit" | "off"
    scope: str              # "block_all" | "block_network" | "block_local" | "allowlist" | "none"
    printers: List[str]     # sanctioned printer names (used when scope == "allowlist")
    blocked_printers: List[str]  # explicitly denied names — blocked in EVERY scope
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

    The agent applies, in order:
      1. blocked_printers — an explicit disapproval. Matches in EVERY scope and
         beats the allowlist, so a single printer can be denied without putting
         the whole estate on an allowlist.
      2. scope — cancel jobs matching all / network / local printers, or (in
         allowlist scope) anything whose name is not in `printers`.
    mode=="enforce" cancels; "audit" or not enforced -> do NOT cancel
    (monitor/log only). Content-aware print blocking (sensitive documents) is a
    separate, existing layer and is unaffected.
    """
    await verify_agent_key(http_request)

    if await _SUSP.is_suspended(agent_id):
        return PrinterPolicyResponse(
            enforced=False, mode="off", scope="none", printers=[], blocked_printers=[],
            content_inspection=False, content_mode="off",
            generated_at=datetime.now(timezone.utc),
        )
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
                    SanctionedPrinter.is_enabled.is_(True),
                    SanctionedPrinter.decision == "allow",
                )
            )).all()
        ]

    # Explicit disapprovals apply in EVERY scope — that is the whole point of a
    # deny row, and why it is not gated on scope == "allowlist" like the list
    # above. Agent rule: if the job's printer name is here, cancel it (enforce)
    # or log "would block" (audit), before any other scope check.
    blocked_printers: List[str] = []
    if enforced:
        blocked_printers = [
            n for (n,) in (await db.execute(
                _select(SanctionedPrinter.printer_name).where(
                    SanctionedPrinter.is_enabled.is_(True),
                    SanctionedPrinter.decision == "deny",
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
        blocked_printers=blocked_printers,
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

    if await _SUSP.is_suspended(agent_id):
        return ApplicationControlResponse(
            enforced=False, mode="off", applications=[], channels=[],
            exception_applications=[], exception_users=[], exception_paths=[],
            exception_file_types=[], generated_at=datetime.now(timezone.utc),
        )
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

    if await _SUSP.is_suspended(agent_id):
        return NetworkSharePolicyResponse(
            enforced=False, mode="off", action="audit", exception_shares=[],
            exception_users=[], exception_paths=[], exception_file_types=[],
            generated_at=datetime.now(timezone.utc),
        )
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


# ── Messaging / thick-client attachment control ───────────────────────────
# Alert or block when a managed messaging/thick-client app (Teams, WhatsApp,
# Telegram, Slack, Discord, Signal, …) attaches a sensitive file for upload. The
# agent's UIA file-dialog detector attributes the acting app locally and enforces
# the verdict before the file enters the app's (TLS-encrypted) upload — the same
# inspect-before-encryption model as the CLI exfil path, so pinned thick clients
# are covered without breaking their TLS. Action defaults to "alert" (audit-first)
# so enabling a policy never terminates an app until an admin opts into "block".
# NOTE: only file-picker attachments are seen; drag-and-drop needs a filesystem
# minifilter and is out of scope for the user-mode agent.
class MessagingAppPolicyResponse(BaseModel):
    enforced: bool                        # an active messaging_app_control policy exists
    action: str                           # "alert" (log/event only) | "block" (terminate app)
    apps: List[str]                       # managed messaging exe names (lowercased)
    exception_users: List[str]            # users/groups exempt (lowercased)
    exempt_file_types: List[str]          # extensions never inspected (no leading dot)
    # Typed chat text, which is a different surface from attachments: the agent
    # holds the send keystroke, reads the composer through UI Automation and
    # classifies it before releasing (see messaging_text_monitor.h).
    #
    # Defaults to FALSE — the one flag here that does not follow "on when a
    # policy exists". Attachment control observes a file dialog; this one sits
    # in front of the user's keyboard, and inheriting that silently from an
    # existing policy is not a decision an operator should discover by feel.
    # Combined with action="block" it is the only thing that ever withholds a
    # keystroke; in alert mode the agent does not touch input at all.
    inspect_messages: bool = False
    # Which detector types make a TYPED message sensitive. Attachments keep the
    # blanket "anything Confidential or Restricted" rule; typed chat does not,
    # because the same detection means different things in the two places. A
    # phone number inside a document being uploaded is worth a second look; a
    # phone number typed into WhatsApp is the most ordinary message there is,
    # and blocking on it teaches users that the agent is broken.
    message_data_types: List[str] = []
    generated_at: datetime


# Built-in managed set used when a policy is active but names no apps of its own,
# so the feature works out of the box. Mirrors the agent's fallback list.
# whatsapp.root.exe is not a typo and not a duplicate. Current WhatsApp for
# Windows is a WebView2 application: the window belongs to WhatsApp.Root.exe and
# the UI renders inside msedgewebview2.exe. A machine running it has no
# whatsapp.exe at all, so the old list silently covered nothing on exactly the
# app most people name first. whatsapp.exe stays for older standalone builds.
#
# msedgewebview2.exe is deliberately NOT here: it hosts WebView2 content for many
# unrelated applications, so listing it would make every one of them a managed
# messaging app.
_DEFAULT_MESSAGING_APPS = [
    "teams.exe", "ms-teams.exe", "msteams.exe",
    "whatsapp.exe", "whatsapp.root.exe",
    "telegram.exe", "slack.exe", "discord.exe", "signal.exe",
]

# Every type the endpoint classifier can report, so the API rejects a typo in a
# policy rather than silently narrowing what gets inspected to nothing.
# Mirrors NetworkExfilMonitor::KnownDataTypes().
_MESSAGING_DATA_TYPES = [
    "CREDIT_CARD", "AADHAAR", "PAN", "SSN", "INDIAN_PASSPORT",
    "AWS_KEY", "PRIVATE_KEY",
    "JWT_TOKEN", "IFSC", "UPI_ID", "INDIAN_PHONE",
]

# What a policy that has not chosen gets: everything above EXCEPT INDIAN_PHONE.
# Not a blanket default, and deliberately so — the endpoint treats an empty list
# as "every Confidential/Restricted type", which on a chat app means blocking
# every message that carries a mobile number. Naming the default here rather
# than leaving the list empty is what keeps that from being the out-of-the-box
# behaviour on the one channel where phone numbers are the point.
_DEFAULT_MESSAGE_DATA_TYPES = [t for t in _MESSAGING_DATA_TYPES if t != "INDIAN_PHONE"]


def _message_data_types(cfg: dict) -> List[str]:
    raw = cfg.get("message_data_types")
    if raw is None:
        return list(_DEFAULT_MESSAGE_DATA_TYPES)
    known = {t: t for t in _MESSAGING_DATA_TYPES}
    picked = [known[t] for t in (str(x).strip().upper() for x in raw) if t in known]
    # An explicit empty selection is a real choice, and it is honoured — see
    # inspect_messages below for how, because "" and "everything" must not be
    # able to mean the same thing on the wire.
    return picked


@router.get("/{agent_id}/messaging-app-policy", response_model=MessagingAppPolicyResponse)
async def messaging_app_policy(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    The messaging / thick-client attachment-control policy the endpoint enforces
    locally. For a file selected in a managed app's file picker, the agent reads +
    classifies it and, if Confidential/Restricted, alerts (default) or terminates
    the app (action == "block"), unless the user or file type is excepted.
    Requires X-Agent-Key (backward-compatible: no key -> allowed).
    """
    await verify_agent_key(http_request)

    if await _SUSP.is_suspended(agent_id):
        return MessagingAppPolicyResponse(
            enforced=False, action="alert", apps=[], exception_users=[],
            exempt_file_types=[], inspect_messages=False, message_data_types=[],
            generated_at=datetime.now(timezone.utc),
        )
    from sqlalchemy import select as _select
    from app.models.policy import Policy

    policy = (await db.execute(
        _select(Policy).where(
            Policy.type == "messaging_app_control",
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().first()

    if not policy:
        return MessagingAppPolicyResponse(
            enforced=False, action="alert", apps=[],
            exception_users=[], exempt_file_types=[], inspect_messages=False,
            message_data_types=[], generated_at=datetime.now(timezone.utc),
        )

    cfg = policy.config or {}
    data_types = _message_data_types(cfg)
    # An empty selection has to be resolved HERE, because the endpoint cannot
    # tell "the operator picked nothing" from "this server is too old to send
    # the field" — both arrive as an absent/empty JSON array, and the endpoint
    # reads that as "every Confidential/Restricted type", the exact opposite of
    # what unticking every box asks for. So an empty selection is expressed the
    # one way that cannot be misread: typed-message inspection is off. Nothing
    # is sensitive and nothing is inspected are the same instruction.
    inspect_messages = bool(cfg.get("inspect_messages")) and bool(data_types)
    # Default to alert so enabling a policy never terminates an app until opted in.
    action = (cfg.get("action") or "alert").lower()
    if action not in ("alert", "block"):
        action = "alert"
    apps = _lc_list(cfg.get("apps")) or list(_DEFAULT_MESSAGING_APPS)
    exc = cfg.get("exceptions") or {}
    return MessagingAppPolicyResponse(
        enforced=True, action=action, apps=apps,
        exception_users=_lc_list(exc.get("users")),
        exempt_file_types=[str(t).strip().lower().lstrip(".") for t in (exc.get("file_types") or []) if str(t).strip()],
        inspect_messages=inspect_messages,
        message_data_types=data_types,
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

    if await _SUSP.is_suspended(agent_id):
        return WirelessPolicyResponse(
            enforced=False, mode="off",
            block_bluetooth_file_transfer=False, block_nearby_sharing=False,
            generated_at=datetime.now(timezone.utc),
        )
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


class WebActivityPolicyResponse(BaseModel):
    """The category x activity matrix the browser extension enforces.

    Pulled once at browser start and refreshed periodically. It serves three
    purposes, and only the first is obvious:

      1. It tells the extension WHICH activities to intercept at all. Holding
         every submit gesture on every catalogued app while a server round-trip
         completes would make the browser feel broken; an activity whose cell is
         "allow" is never held.
      2. It is the OFFLINE FALLBACK. Decisions are server-authoritative, so when
         the server is unreachable the extension has no verdict — without a
         cached matrix its only options are "block everything" or "allow
         everything", and both are wrong. With it, the last known policy is
         applied to whatever the bundled local scanner detected.
      3. It carries ``mode``, so an operator can roll a matrix out in audit and
         watch what it would have stopped before it starts stopping anything.
    """
    enforced: bool
    mode: str                                  # enforce | audit | off
    matrix: Dict[str, Dict[str, Any]]
    app_overrides: List[Dict[str, Any]]
    min_level: Optional[str]
    block_uninspectable: bool
    policy_names: List[str]
    generated_at: datetime


@router.get("/{agent_id}/web-activity-policy", response_model=WebActivityPolicyResponse)
async def web_activity_policy(
    agent_id: str,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Effective web-activity matrix for this endpoint.

    Several active policies are merged cell by cell, strongest action wins —
    the same precedence _match_web_activity applies at decision time, so what
    the extension caches and what the server would decide cannot disagree.
    Requires X-Agent-Key (backward-compatible: no key -> allowed).
    """
    await verify_agent_key(http_request)

    if await _SUSP.is_suspended(agent_id):
        # An empty matrix is not "block nothing by omission" — the extension
        # reads ``enforced``/``mode`` first and holds no gesture when off, so
        # the browser stops feeling intercepted rather than silently failing
        # open on a matrix it can't find a cell in.
        return WebActivityPolicyResponse(
            enforced=False, mode="off", matrix={}, app_overrides=[],
            min_level=None, block_uninspectable=False, policy_names=[],
            generated_at=datetime.now(timezone.utc),
        )
    from sqlalchemy import select as _select
    from app.models.policy import Policy

    rows = (await db.execute(
        _select(Policy).where(
            Policy.type == _WEB_ACTIVITY_TYPE,
            Policy.status == "active",
            Policy.deleted_at.is_(None),
        ).order_by(Policy.priority.desc())
    )).scalars().all()

    applicable = [
        p for p in rows
        if not (getattr(p, "agent_ids", None) or []) or agent_id in (p.agent_ids or [])
    ]

    if not applicable:
        return WebActivityPolicyResponse(
            enforced=False, mode="off", matrix={}, app_overrides=[],
            min_level=None, block_uninspectable=True, policy_names=[],
            generated_at=datetime.now(timezone.utc),
        )

    matrix: Dict[str, Dict[str, Any]] = {}
    overrides: List[Dict[str, Any]] = []
    names: List[str] = []
    # "enforce" unless EVERY contributing policy is audit — one enforcing policy
    # means enforcement is on for the cells it defines.
    modes = set()
    min_level = None
    block_uninspectable = False

    for p in applicable:
        cfg = getattr(p, "config", None) or {}
        names.append(getattr(p, "name", "web activity control"))
        modes.add(str(cfg.get("mode") or "enforce").strip().lower())
        if cfg.get("blockUninspectable", True):
            block_uninspectable = True
        if cfg.get("minLevel") and min_level is None:
            min_level = cfg.get("minLevel")

        for category, row in (cfg.get("matrix") or {}).items():
            cat = _WA.normalize_category(category)
            if not cat or not isinstance(row, dict):
                continue
            for activity, cell in row.items():
                act = _WA.normalize_activity(activity)
                if not act or not _WA.is_valid_pair(cat, act):
                    continue
                if isinstance(cell, dict):
                    action = _WA.normalize_action(cell.get("action"), default=_WA.ACTION_LOG)
                    cell_min = cell.get("minLevel") or cfg.get("minLevel")
                else:
                    action = _WA.normalize_action(cell, default=_WA.ACTION_LOG)
                    cell_min = cfg.get("minLevel")
                existing = matrix.setdefault(cat, {}).get(act)
                if existing and _WA.ACTION_RANK.get(existing.get("action"), 0) >= _WA.ACTION_RANK.get(action, 0):
                    continue
                matrix[cat][act] = {"action": action, "minLevel": cell_min}

        for entry in (cfg.get("appOverrides") or []):
            if isinstance(entry, dict):
                overrides.append(entry)

    mode = "audit" if modes == {"audit"} else "enforce"

    return WebActivityPolicyResponse(
        enforced=True,
        mode=mode,
        matrix=matrix,
        app_overrides=overrides,
        min_level=min_level,
        block_uninspectable=block_uninspectable,
        policy_names=names,
        generated_at=datetime.now(timezone.utc),
    )


def _file_extension(file_name: Optional[str]) -> Optional[str]:
    """Lowercase file extension incl. the dot (e.g. '.dwg'), or None."""
    if not file_name:
        return None
    base = str(file_name).replace("\\", "/").rstrip("/").split("/")[-1]
    dot = base.rfind(".")
    if dot <= 0 or dot == len(base) - 1:
        return None
    return base[dot:].lower()


async def _match_file_identity(
    db: AsyncSession,
    agent_id: str,
    event_type: Optional[str],
    file_ext: Optional[str],
    file_sha256: Optional[str],
    file_md5: Optional[str],
):
    """Match a file against the custom-extension and file-hash denylists defined
    on the USB/Print policies that apply to this agent.

    Independent of content classification: a file is caught if its extension is
    on a policy's custom-extension list OR its hash is on a policy's denylist —
    which also catches renamed files and non-text documents. Returns
    (should_block, should_alert, reason).
    """
    try:
        et = (event_type or "").lower()
        if "print" in et:
            types = {"print_content_prevention"}
        elif "usb" in et:
            types = {"usb_file_transfer_monitoring", "usb_device_control"}
        else:
            return (False, False, "")

        hashes = {h.lower() for h in (file_sha256, file_md5) if h}
        policies = await PolicyService(db).get_all_policies(skip=0, limit=1000, enabled_only=True)
        for p in policies:
            if getattr(p, "type", None) not in types:
                continue
            # Scope: a policy with agent_ids applies only to those agents.
            scope = getattr(p, "agent_ids", None) or []
            if scope and agent_id not in scope:
                continue
            cfg = getattr(p, "config", None) or {}

            # Custom blocked extensions — a DENYLIST (distinct from the existing
            # ``fileExtensions`` scope field, which selects file types to inspect
            # for content and must NOT be treated as "block these").
            exts = []
            for e in (cfg.get("blockedExtensions") or []):
                e = str(e).strip().lower()
                if e:
                    exts.append(e if e.startswith(".") else "." + e)
            if file_ext and file_ext in exts:
                act = str(cfg.get("blockedExtensionAction") or "block").lower()
                reason = f"file extension {file_ext} is on the block list (policy '{p.name}')"
                return (act != "alert", act == "alert", reason)

            # File-hash denylist (MD5 or SHA-256).
            plist = {str(h).strip().lower() for h in (cfg.get("blockedHashes") or []) if h}
            hit = hashes & plist
            if hit:
                act = str(cfg.get("blockedHashAction") or "block").lower()
                matched = next(iter(hit))
                reason = f"file hash {matched[:16]}… is on the block list (policy '{p.name}')"
                return (act != "alert", act == "alert", reason)
        return (False, False, "")
    except Exception as e:  # never let matching break evaluation
        logger.warning("File-identity match failed (non-fatal)", error=str(e))
        return (False, False, "")


# Web-activity matching lives in services/web_activity_policy.py so the event
# INGEST path can attribute an event to its governing policy without importing
# this router. Re-exported under the original private names because the rest of
# this module (and the evaluate endpoint below) reads them.
from app.services.web_activity_policy import (  # noqa: E402
    WEB_ACTIVITY_TYPE as _WEB_ACTIVITY_TYPE,
    level_rank as _level_rank,
    matrix_cell as _matrix_cell,
    app_override as _app_override,
    decide as _web_activity_decision,
    match as _match_web_activity,
)

_LEVEL_RANK = {"public": 0, "internal": 1, "confidential": 2, "restricted": 3}


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

    if await _SUSP.is_suspended(agent_id):
        # Allow WITHOUT classifying. Returning "allow" after a full inspection
        # would still read the file, still run the classifier, and still leave
        # the content in this process — none of which a paused endpoint should
        # be paying for or exposing. should_log=False keeps the pause quiet:
        # an operator who paused an endpoint does not want its traffic showing
        # up as allowed-by-policy decisions.
        return PolicyEvaluationResponse(
            action="allow",
            reason=SUSPENDED_REASON,
            classification=ClassificationDetails(
                level="Public", confidence=0.0, matched_rules=[], total_matches=0
            ),
            policies_triggered=[],
            should_log=False,
            extraction_status="readable",
            extraction_kind="text",
        )

    try:
        # 0. Resolve the text to classify. When the caller sends raw bytes we
        #    extract real text from them (pdf/docx/xlsx/pptx/text). This is what
        #    makes binary documents classifiable at all — decoding their bytes
        #    into a string yields compressed garbage that always looks "Public".
        content_to_classify = request.file_content or ""
        # File hashes for the file-hash denylist rule: prefer agent-supplied,
        # else computed from the raw bytes in the base64 branch below.
        req_sha256 = (request.file_sha256 or "").strip().lower() or None
        req_md5 = (request.file_md5 or "").strip().lower() or None
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
            # Hash the real bytes for the file-hash denylist (covers USB, where
            # the agent sends raw bytes; the print agent sends its own hashes).
            if req_sha256 is None or req_md5 is None:
                import hashlib as _hl
                if req_sha256 is None:
                    req_sha256 = _hl.sha256(raw).hexdigest()
                if req_md5 is None:
                    req_md5 = _hl.md5(raw).hexdigest()
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

        # 0a2. Text the CALLER extracted and we could not.
        #
        # The browser extension carries an OCR engine and a PDF rasteriser; the
        # server does not. So for a photographed Aadhaar card the extension has
        # real text and ``extract_text`` here has nothing — and because the b64
        # branch above *replaces* content_to_classify, that text was being
        # thrown away and the card classified Public.
        #
        # Appending rather than replacing is deliberate: whichever side could
        # read the file contributes, and neither can hide the other's findings.
        # The status upgrade matters just as much — left at no_text_content, an
        # operator's "block uninspectable content" rule would fire on every
        # holiday photo the extension successfully OCR'd and found clean.
        if request.file_content_b64 and request.file_content:
            caller_text = request.file_content.strip()
            if caller_text and caller_text not in content_to_classify:
                content_to_classify = (
                    f"{content_to_classify}\n{caller_text}" if content_to_classify else caller_text
                )
                if extraction_status in ("no_text_content", "unreadable"):
                    extraction_status = "readable"
                    extract_kind = f"{extract_kind}+caller_extracted"
                    logger.info(
                        "Caller supplied text the server could not extract",
                        agent_id=agent_id, file_name=request.file_name,
                        chars=len(caller_text),
                    )

        # 0b. Web-activity body text — a GenAI prompt, an email body, a chat
        # message. Classified ALONGSIDE any attachment text, never instead of
        # it: one Send gesture routinely carries both, and whichever half is
        # sensitive has to convict the activity. They stay separately reported
        # on the event so an analyst can tell "he pasted the Aadhaar number into
        # the prompt" from "he attached a photo of the card".
        text_content = (request.text_content or "").strip()
        if text_content:
            content_to_classify = (
                f"{text_content}\n{content_to_classify}" if content_to_classify else text_content
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

        # Web-activity context — present only when a browser extension (or any
        # caller that understands the vocabulary) intercepted an activity in a
        # catalogued web app. Written flat AND under a "web" object so the
        # evaluator's dotted field mappings resolve either shape, exactly like
        # the network block below. Unrecognised values are dropped rather than
        # passed through, so a typo becomes "no match" instead of a rule that
        # matches an empty string.
        _activity = _WA.normalize_activity(request.activity)
        _app_category = _WA.normalize_category(request.app_category)
        web_fields = {
            "activity": _activity,
            "app_category": _app_category,
            "app_id": (request.app_id or "").strip() or None,
            "app_name": (request.app_name or "").strip() or None,
            # Lets a rule distinguish "posted a prompt" from "attached a file"
            # without having to reason about which content field was populated.
            "has_text_content": True if text_content else None,
        }
        web_fields = {k: v for k, v in web_fields.items() if v not in (None, "")}
        if web_fields:
            event_data.update(web_fields)
            event_data["web"] = dict(web_fields)

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

        # 4b. File-identity rules (custom extensions + file-hash denylist) for the
        # USB/Print channels — independent of content classification, so they
        # also catch renamed files and non-text documents.
        _id_block, _id_alert, _id_reason = await _match_file_identity(
            db, agent_id, request.event_type,
            _file_extension(request.file_name), req_sha256, req_md5,
        )
        if _id_block:
            should_block = True
        elif _id_alert:
            should_alert = True

        # 4c. Web activity matrix (webmail / cloud / collaboration / GenAI x
        # upload / download / attach / send / post / ai_response). Independent
        # of the generic evaluator because a matrix needs a different action per
        # cell; see _match_web_activity.
        _wa_action, _wa_reason, _wa_governing = await _match_web_activity(
            db, agent_id, request.app_category, request.activity,
            request.app_id, request.app_name,
            classification_result.classification, extraction_status,
        )
        # Attribution, not enforcement. A matrix policy that examined this
        # activity and let it through is still the policy that governs it, and
        # the caller echoes these back on the event so the log can name the rule
        # instead of showing an unexplained "Logged". Strongest first, and ahead
        # of the rule-based matches because a matrix cell is the more specific
        # statement about this activity.
        if _wa_governing:
            # The rule-based evaluator can match the SAME policy (its generic
            # conditions fire on the content), and its record carries only
            # id/name/severity/priority. Merging matrix-first keeps the cell
            # detail — which cell, which threshold, enforced or not — instead of
            # letting the thinner record win by arriving first.
            _by_id = {g.get("policy_id"): dict(g) for g in _wa_governing}
            _rest = []
            for t in triggered_policies:
                pid = t.get("policy_id")
                if pid in _by_id:
                    merged = {**t, **_by_id[pid]}
                    _by_id[pid] = merged
                else:
                    _rest.append(t)
            triggered_policies = [_by_id[g.get("policy_id")] for g in _wa_governing] + _rest

        # A mask verdict has to be turned into an actual redaction here, and if
        # that cannot be done it becomes a block. Masking is the only action
        # that can FAIL to be carried out — allow, log, alert and block are all
        # decisions, while mask is a decision plus a piece of work.
        mask_plan = None
        if _wa_action == _WA.ACTION_MASK:
            refused = ""
            if request.file_content_b64 or (request.file_content or "").strip():
                # An attachment cannot be redacted in place: rebuilding a PDF or
                # a spreadsheet with values removed is a different feature, and
                # sending the prose masked while the file goes out whole would
                # be worse than doing nothing.
                refused = "the submission carries an attachment, which cannot be redacted"
            else:
                # Planned against text_content ALONE, never the concatenated
                # blob that was classified: the offsets have to line up with the
                # exact string the caller is going to rewrite.
                mask_plan, refused = _MASK.plan(
                    request.text_content or "",
                    classification_result.matched_rules,
                    await classification_engine.get_active_rules(),
                    classification_engine.compiled_pattern,
                )

            if mask_plan is None:
                _wa_action = _WA.ACTION_BLOCK
                _wa_reason = (
                    f"{_wa_reason} — masking was not possible because {refused}"
                    if _wa_reason else f"Masking was not possible because {refused}"
                )
                logger.info(
                    "Mask refused, falling back to block",
                    agent_id=agent_id, activity=request.activity, reason=refused,
                )

        if _wa_action == _WA.ACTION_BLOCK:
            should_block = True
        elif _wa_action in (_WA.ACTION_ALERT, _WA.ACTION_MASK):
            should_alert = True
            if alert_severity is None:
                alert_severity = "high" if _level_rank(
                    classification_result.classification
                ) >= _LEVEL_RANK["confidential"] else "medium"

        # 5. Build response
        action = (
            "block" if should_block
            else "mask" if mask_plan is not None
            else "allow"
        )

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

        # A file-identity match is the operator-relevant reason — surface it.
        if _id_reason:
            reason = (f"BLOCKED - {_id_reason}" if _id_block else _id_reason)

        # A web-activity match is more specific still: "Send to Gmail is set to
        # block for Confidential content" is what the operator actually
        # configured, and what the end user needs to read on the block banner —
        # far more actionable than a classification summary.
        if _wa_reason:
            # Name the data, not just the rule that stopped it. The web-activity
            # sentence REPLACES the classification summary here, and that summary
            # was the only thing that said "Detected: Indian Aadhaar Number" — so
            # the block banner the user reads, and the policy_reason stored on the
            # event, told them a policy stopped them but never what they had
            # typed that triggered it.
            _detected = list(dict.fromkeys(
                (f"{r['rule_name']} ({r['category']})" if r.get("category") else r["rule_name"])
                for r in (classification_result.matched_rules or [])
                if isinstance(r, dict) and r.get("rule_name")
            ))
            if _detected:
                shown = ", ".join(_detected[:5])
                if len(_detected) > 5:
                    shown += f" and {len(_detected) - 5} more"
                _wa_reason = f"{_wa_reason} — detected: {shown}"
            reason = (f"BLOCKED - {_wa_reason}" if _wa_action == _WA.ACTION_BLOCK else _wa_reason)

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
            masked_text=mask_plan.masked_text if mask_plan else None,
            redactions=[
                {"start": r.start, "end": r.end, "type": r.type, "token": r.token}
                for r in (mask_plan.redactions if mask_plan else [])
            ],
            mask_summary=mask_plan.summary if mask_plan else [],
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
