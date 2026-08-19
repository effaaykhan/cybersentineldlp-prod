"""
Temporary agent suspension — "pause this endpoint for a while".

Removing an agent is permanent and heavy-handed. The common operational need
is much smaller: a machine is being re-imaged, a developer is running a load
test that trips every rule, a laptop goes to a repair shop for a week. You
want that endpoint to stop reporting and stop being policed, and you want it
to come back on its own without anyone remembering to re-enable it.

WHAT "SUSPENDED" MEANS
----------------------
Suspension is enforced SERVER-SIDE, at every point the endpoint asks the
server a question:

  • policy sync      → an EMPTY policy bundle
  • channel policies → ``enforced=false, mode="off"``
  • live evaluation  → ``allow``
  • event ingestion  → accepted and discarded

The empty bundle is the load-bearing part. The endpoint agent derives its
own ``allowEvents`` flag from the bundle it was given (no file/clipboard/USB
policies ⇒ no monitoring, no events), so an empty bundle turns the agent off
AT THE SOURCE rather than merely muting it here. It also caches that bundle,
so a reboot mid-suspension stays suspended. Nothing about this depends on
the agent knowing the word "suspended" — it works with binaries already
deployed in the field, which is why it is done this way rather than by
adding a flag the agent has to understand.

The remaining server-side guards are deliberate redundancy: they close the
window between an admin clicking Pause and the agent's next sync, and they
cover any caller that ignores its bundle.

WHAT SUSPENSION DOES *NOT* DO
-----------------------------
Heartbeats are still accepted, and the agent stays visible in the fleet list.
A paused agent is not a hidden one: you can still see the machine is alive,
which is exactly what you want while its protection is off. It also means the
agent learns about the resume on its very next poll, with no push channel.

EXPIRY IS COMPUTED ON READ
--------------------------
There is no scheduler, no sweeper job, no background task. An agent is
suspended if and only if ``suspended`` is set AND ``suspended_until`` is
still in the future. A pause therefore cannot outlive its deadline because
a worker died, a container restarted, or a cron never fired — the three ways
a "temporarily disabled security control" quietly becomes a permanent one.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import structlog

logger = structlog.get_logger()

# Fields written on the Mongo agent doc. Listed here so the read paths that
# project or copy agent documents have one place to look.
SUSPENSION_FIELDS = (
    "suspended",
    "suspended_at",
    "suspended_until",
    "suspended_by",
    "suspend_reason",
)

# Upper bound on a single pause. Not a security control — a typo guard. Someone
# entering minutes where they meant hours should not silently disable an
# endpoint for a year. Ninety days is longer than any legitimate repair,
# re-image or leave-of-absence window; past that, remove the agent instead.
MAX_DURATION_MINUTES = 90 * 24 * 60

# How long a resolved suspension verdict may be reused without re-reading
# Mongo. Bounds the extra read on the event-ingest hot path to once per agent
# per interval instead of once per event. Toggling suspension invalidates the
# entry outright (see ``invalidate``), so this delays nothing an operator does
# — it only smooths the steady state.
_CACHE_TTL_SECONDS = 10.0

# agent_id -> (verdict, expires_at_monotonic)
_verdict_cache: Dict[str, tuple[bool, float]] = {}


def _as_utc(value: Any) -> Optional[datetime]:
    """Coerce a stored datetime to timezone-aware UTC.

    Legacy Mongo docs predate the timezone-aware migration and come back
    naive; comparing one of those to an aware ``now`` raises, and an
    exception on this path would fail *open*.
    """
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def resolve(agent_doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute the current suspension state of one agent document.

    Pure and side-effect free: the caller decides whether to persist the
    expiry. Returns the shape the API exposes, always fully populated so
    the dashboard never has to distinguish "absent" from "false".
    """
    blank = {
        "is_suspended": False,
        "suspended_until": None,
        "suspended_at": None,
        "suspended_by": None,
        "suspend_reason": None,
        "suspension_seconds_remaining": None,
    }
    if not agent_doc or not agent_doc.get("suspended"):
        return blank

    until = _as_utc(agent_doc.get("suspended_until"))
    remaining: Optional[float] = None

    if until is not None:
        remaining = (until - datetime.now(timezone.utc)).total_seconds()
        if remaining <= 0:
            # Deadline passed — the agent is live again as of now, whether or
            # not anything has got around to clearing the flag.
            return blank

    return {
        "is_suspended": True,
        "suspended_until": until,
        "suspended_at": _as_utc(agent_doc.get("suspended_at")),
        "suspended_by": agent_doc.get("suspended_by"),
        "suspend_reason": agent_doc.get("suspend_reason"),
        "suspension_seconds_remaining": remaining,
    }


def clear_update() -> Dict[str, Any]:
    """The ``$set`` payload that lifts a suspension.

    Fields are cleared rather than unset so a doc's shape stays stable and
    ``suspended_by``/``suspended_at`` history is not silently resurrected by
    a later partial write.
    """
    return {
        "suspended": False,
        "suspended_until": None,
        "suspended_at": None,
        "suspended_by": None,
        "suspend_reason": None,
    }


def suspend_update(
    *,
    duration_minutes: Optional[int],
    actor: Optional[str],
    reason: Optional[str],
) -> Dict[str, Any]:
    """The ``$set`` payload that applies a suspension.

    ``duration_minutes=None`` means "until someone resumes it" — stored as a
    null deadline rather than a far-future date, so an indefinite pause is
    honestly represented and can be surfaced as such in the UI instead of
    masquerading as a very long timer.
    """
    now = datetime.now(timezone.utc)
    until: Optional[datetime] = None
    if duration_minutes is not None:
        until = now + timedelta(minutes=duration_minutes)
    return {
        "suspended": True,
        "suspended_at": now,
        "suspended_until": until,
        "suspended_by": actor,
        "suspend_reason": (reason or "").strip() or None,
    }


def mongo_filter(now: Optional[datetime] = None) -> Dict[str, Any]:
    """A Mongo predicate matching agents that are suspended *right now*.

    Mirrors ``resolve`` for the aggregate paths (fleet counts), where loading
    every document to evaluate it in Python would be absurd. Expiry is part of
    the predicate for the same reason it is part of ``resolve``: a count that
    included lapsed pauses would report endpoints as unprotected after their
    window closed.
    """
    moment = now or datetime.now(timezone.utc)
    return {
        "suspended": True,
        "$or": [
            {"suspended_until": None},
            {"suspended_until": {"$exists": False}},
            {"suspended_until": {"$gt": moment}},
        ],
    }


def mongo_not_filter(now: Optional[datetime] = None) -> Dict[str, Any]:
    """The complement of ``mongo_filter`` — agents that are NOT paused.

    Written as ``$nor`` so it composes inside a ``$and`` with a caller's own
    ``$or`` (the heartbeat-freshness clause) without the two colliding on the
    same key.
    """
    return {"$nor": [mongo_filter(now)]}


def invalidate(agent_id: Optional[str]) -> None:
    """Drop a cached verdict so a suspend/resume takes effect immediately."""
    if agent_id:
        _verdict_cache.pop(agent_id, None)


def invalidate_all() -> None:
    _verdict_cache.clear()


async def is_suspended(agent_id: Optional[str]) -> bool:
    """True when this agent is currently paused.

    Tolerates a rolled agent UUID (a reinstalled endpoint still using its old
    local id) by matching ``previous_agent_ids`` too — the same lookup the
    heartbeat and policy-sync paths use, so a pause cannot be shed by
    reinstalling under the old identity.

    Fails OPEN on a database error: if we cannot tell, we let the agent keep
    protecting the endpoint. The alternative — treating an unreachable
    database as "everything is suspended" — would silently disarm the entire
    fleet during an outage.
    """
    if not agent_id:
        return False

    cached = _verdict_cache.get(agent_id)
    now = time.monotonic()
    if cached is not None and cached[1] > now:
        return cached[0]

    try:
        from app.core.database import get_mongodb

        doc = await get_mongodb()["agents"].find_one(
            {"$or": [{"agent_id": agent_id}, {"previous_agent_ids": agent_id}]},
            {field: 1 for field in SUSPENSION_FIELDS},
        )
    except Exception as e:  # noqa: BLE001 — see fail-open note above
        logger.warning("Suspension lookup failed; treating agent as active", agent_id=agent_id, error=str(e))
        return False

    verdict = bool(resolve(doc)["is_suspended"])
    _verdict_cache[agent_id] = (verdict, now + _CACHE_TTL_SECONDS)
    return verdict
