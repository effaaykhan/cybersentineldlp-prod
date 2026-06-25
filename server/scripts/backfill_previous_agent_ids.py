"""Backfill ``previous_agent_ids`` for agents that rolled their UUID.

Why
---
Until the register endpoint started archiving rolled UUIDs (see
``server/app/api/v1/agents.py::register_agent``), a reinstalled agent
would simply overwrite ``agents.agent_id``. Every event emitted under
the prior UUID became unresolvable: the listing rendered "Unknown
Agent" and the per-agent filter (``/events?agent=<uuid>``) returned an
empty page.

What this does
--------------
Scans ``dlp_events`` for ``agent_id`` values that don't match any
agent's current ``agent_id``. For each orphan id, looks at the
``user_email`` field on those events (``<user>@<HOSTNAME>``) to recover
the hostname, then matches that hostname to a current agent's ``name``.
When a match is found, appends the orphan id to that agent's
``previous_agent_ids`` set.

Idempotent. Run after a reinstall to recover historic event linkage.

Usage::

    docker compose exec manager python -m scripts.backfill_previous_agent_ids
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
from typing import Dict, Set

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import init_databases, close_databases, get_mongodb  # noqa: E402


HOSTNAME_RE = re.compile(r"@([A-Za-z0-9._-]+)$")


async def run() -> None:
    await init_databases()
    try:
        db = get_mongodb()

        # 1. Map agent name -> canonical agent_id (current).
        canonical: Dict[str, str] = {}
        already_known: Set[str] = set()
        async for a in db.agents.find(
            {}, {"_id": 0, "agent_id": 1, "name": 1, "previous_agent_ids": 1}
        ):
            if a.get("name") and a.get("agent_id"):
                canonical[a["name"]] = a["agent_id"]
                already_known.add(a["agent_id"])
                for prev in a.get("previous_agent_ids") or []:
                    already_known.add(prev)

        if not canonical:
            print("No agents in the database — nothing to backfill.")
            return

        # 2. Find orphan agent_ids in events that don't map to any
        # agent record (current or previously-archived).
        all_event_ids: Set[str] = set(
            await db.dlp_events.distinct("agent_id")
        )
        orphans = {
            aid
            for aid in all_event_ids
            if aid
            and aid != "unknown"
            and aid not in already_known
        }
        if not orphans:
            print("No orphan agent_ids in dlp_events — nothing to backfill.")
            return

        print(f"Found {len(orphans)} orphan agent_id(s) in events.")

        # 3. For each orphan, recover the hostname from a sample
        # user_email and map it back to a current agent.
        recovered: Dict[str, Set[str]] = {}  # canonical_id -> {orphan ids}
        for orphan in orphans:
            sample = await db.dlp_events.find_one(
                {"agent_id": orphan, "user_email": {"$exists": True, "$ne": None}},
                {"_id": 0, "user_email": 1},
            )
            if not sample:
                print(f"  • {orphan}: no user_email sample — skipping")
                continue
            m = HOSTNAME_RE.search(sample.get("user_email") or "")
            if not m:
                print(f"  • {orphan}: user_email '{sample.get('user_email')}' has no hostname — skipping")
                continue
            hostname = m.group(1)
            canon = canonical.get(hostname)
            if not canon:
                print(f"  • {orphan}: hostname '{hostname}' has no current agent record — skipping")
                continue
            recovered.setdefault(canon, set()).add(orphan)

        if not recovered:
            print("No orphan ids could be matched to a current agent.")
            return

        # 4. Append to previous_agent_ids on each matched agent.
        for canon, ids in recovered.items():
            result = await db.agents.update_one(
                {"agent_id": canon},
                {"$addToSet": {"previous_agent_ids": {"$each": sorted(ids)}}},
            )
            print(
                f"  • agent {canon}: added {len(ids)} previous id(s) "
                f"(matched={result.matched_count}, modified={result.modified_count})"
            )

        print(f"Backfill complete: {sum(len(v) for v in recovered.values())} orphan id(s) attached.")
    finally:
        await close_databases()


if __name__ == "__main__":
    asyncio.run(run())
