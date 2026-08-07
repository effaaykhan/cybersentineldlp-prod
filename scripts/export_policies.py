"""
Export the CURRENT policies from this server's Postgres into
server/data/default_policies.json — the seed file the manager bakes into its
image and applies on every boot.

Run this on the DEV server (.204) inside the manager container, then commit +
push. CI rebuilds the manager image with the updated seed baked in; on the next
image pull the target server (.76) applies the new policies via _seed_default_
policies() (INSERT ... ON CONFLICT (name) DO NOTHING — adds the newly-created
policies, never overwrites operator edits or the ones already present).

    docker exec -e PYTHONPATH=/app -w /app cybersentineldlp-manager \
        python3 /app/../scripts/export_policies.py            # writes /app/data/default_policies.json

(The dev manager mounts ./server:/app, so /app/data/... IS server/data/... in the
repo working tree.)

Throwaway policies whose name starts with a prefix in EXCLUDE_PREFIXES are skipped
so test rows never leak into the seed. Review the git diff before committing.
"""
import asyncio
import json
import os
import sys

import app.core.database as d
from sqlalchemy import select
from app.models.policy import Policy

EXCLUDE_PREFIXES = ("TEST ", "test ")

# Written to a SEPARATE file (not default_policies.json) so it never pollutes the
# curated client defaults. The manager applies it ONLY when the target sets
# DLP_SEED_EXPORTED_POLICIES=1 (i.e. the mirror server .76), so client installs
# still get only the vetted default_policies.json.
DEFAULT_OUT = "/app/data/exported_policies.json"


async def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    await d.init_databases()
    async with d.postgres_session_factory() as s:
        rows = (await s.execute(
            select(Policy)
            .where(Policy.deleted_at.is_(None))
            .order_by(Policy.priority, Policy.name)
        )).scalars().all()

    exported, skipped = [], 0
    for p in rows:
        if any(p.name.startswith(pre) for pre in EXCLUDE_PREFIXES):
            skipped += 1
            continue
        if not p.type:
            # A policy with no type can't be seeded meaningfully (type is NOT the
            # match key but the evaluator/agent need it) — skip malformed rows.
            skipped += 1
            continue
        exported.append({
            "name": p.name,
            "description": p.description or "",
            # Seed files express intent as `enabled`; the schema stores `status`.
            "enabled": (p.status == "active"),
            "priority": p.priority if p.priority is not None else 100,
            "type": p.type,
            "severity": p.severity or "medium",
            "config": p.config or {},
            "conditions": p.conditions or {"match": "all", "rules": []},
            "actions": p.actions or {},
        })

    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(exported, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, out_path)
    print(f"EXPORTED {len(exported)} policies -> {out_path} (skipped {skipped} test)")


if __name__ == "__main__":
    asyncio.run(main())
