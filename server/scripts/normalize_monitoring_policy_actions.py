"""Collapse stale multi-action shapes on monitoring policies.

Background
----------
Two policy-creation flows historically wrote different shapes into the
``policies`` table:

* The new ``PolicyCreatorModal`` sets ``config.action`` AND the
  matching single-entry ``actions`` dict (e.g. ``{"alert": {}}``).
* The legacy ``CreatePolicyModal`` in ``pages/Policies.tsx`` left
  ``config.action`` empty and stored multiple actions in the dict
  (e.g. ``{"block": {"clear_clipboard": true}, "alert": {...}}``).

The dashboard listing renders ``config.action`` (defaulting to "alert"
when missing), while the Windows agent's parser falls back to the
actions dict with priority ``block > quarantine > alert > log``. A
clipboard policy in the second shape thus displays as "Action: alert"
in the UI but causes the endpoint to actually clear the clipboard —
the exact symptom the operator reported.

What this script does
---------------------
For every monitoring-type policy (clipboard/file/usb/drive), align
``actions`` with ``config.action``:

1. If ``config.action`` exists, force ``actions = {config.action:
   actions.get(config.action) or {}}`` — preserves any parameters
   (e.g. quarantine path) attached to that action while dropping
   stale entries.
2. If ``config.action`` is missing, pick the strongest action from
   the existing dict, write it back into ``config.action``, and
   collapse the dict to that single entry.

Idempotent: re-running on already-normalized rows is a no-op.

Usage::

    docker compose exec manager python -m scripts.normalize_monitoring_policy_actions
    docker compose restart manager   # or wait for the bundle cache TTL
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any, Dict, Optional

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import text  # noqa: E402

from app.core.database import init_databases, close_databases  # noqa: E402
from app.core import database as _db  # noqa: E402


MONITORING_TYPES = (
    "clipboard_monitoring",
    "file_system_monitoring",
    "file_transfer_monitoring",
    "usb_device_monitoring",
    "usb_file_transfer_monitoring",
    "google_drive_local_monitoring",
)

ACTION_RANK = {"block": 4, "quarantine": 3, "alert": 2, "log": 1}


def _strongest(actions: Dict[str, Any]) -> Optional[str]:
    if not isinstance(actions, dict) or not actions:
        return None
    return max(actions.keys(), key=lambda k: ACTION_RANK.get(k, 0))


def _normalize(
    config: Optional[Dict[str, Any]],
    actions: Optional[Dict[str, Any]],
) -> tuple[Dict[str, Any], Dict[str, Any], bool]:
    """Return (new_config, new_actions, changed)."""
    cfg = dict(config or {})
    acts = dict(actions or {})

    config_action = cfg.get("action")
    if isinstance(config_action, str) and config_action:
        # config.action is canonical — collapse actions to that key.
        params = acts.get(config_action) or {}
        new_acts = {config_action: params}
        changed = new_acts != acts
        return cfg, new_acts, changed

    strongest = _strongest(acts)
    if strongest is None:
        # No actions at all — leave alone.
        return cfg, acts, False

    new_acts = {strongest: acts.get(strongest) or {}}
    cfg["action"] = strongest
    changed = new_acts != acts or "action" not in (config or {})
    return cfg, new_acts, changed


async def run() -> None:
    await init_databases()
    try:
        async with _db.postgres_session_factory() as session:
            placeholders = ", ".join(f":t{i}" for i in range(len(MONITORING_TYPES)))
            params = {f"t{i}": t for i, t in enumerate(MONITORING_TYPES)}
            rows = await session.execute(
                text(
                    f"SELECT id, name, type, config, actions FROM policies "
                    f"WHERE type IN ({placeholders})"
                ),
                params,
            )
            updates = []
            for r in rows.mappings():
                cfg, acts, changed = _normalize(r["config"], r["actions"])
                if changed:
                    updates.append((str(r["id"]), r["name"], cfg, acts))

            if not updates:
                print("No policies need normalization.")
                return

            for pid, name, cfg, acts in updates:
                print(f"Normalizing {name} ({pid}): actions -> {list(acts.keys())}")
                await session.execute(
                    text(
                        "UPDATE policies SET config = :cfg, actions = :acts, "
                        "updated_at = NOW() WHERE id = :pid"
                    ),
                    {
                        "pid": pid,
                        "cfg": json.dumps(cfg),
                        "acts": json.dumps(acts),
                    },
                )
            await session.commit()
            print(f"Normalized {len(updates)} polic{'y' if len(updates) == 1 else 'ies'}.")
    finally:
        await close_databases()


if __name__ == "__main__":
    asyncio.run(run())
