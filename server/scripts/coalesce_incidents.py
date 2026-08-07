"""
One-time migration: coalesce legacy one-incident-per-event auto-incidents into
grouped incidents that match the new generation logic (events.py
_auto_create_incident).

Groups by (user_email, event_type, category), sessionised by a 24h gap between
consecutive events, and merges each session into a single incident carrying the
real member ``event_ids`` and an accurate ``event_count``.

Safe by default: runs a DRY RUN and prints what it would do. Pass --apply to
back up the ``incidents`` collection to ``incidents_backup_precoalesce`` and
replace it with the coalesced set.

  docker exec cybersentineldlp-manager python /app/scripts/coalesce_incidents.py
  docker exec cybersentineldlp-manager python /app/scripts/coalesce_incidents.py --apply
"""
import asyncio
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.core.database import init_databases, get_mongodb

WINDOW = timedelta(hours=24)
SEV_STR = {4: "critical", 3: "high", 2: "medium", 1: "low", 0: "info"}
CLASS_RANK = {"Restricted": 4, "Confidential": 3, "Internal": 2, "Public": 1}


def _naive(dt):
    """Normalise to naive UTC so tz-aware and tz-naive values never mix in
    comparisons/min/max."""
    if isinstance(dt, datetime) and dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _build_merged(sess):
    """sess = list of (key, ev_ts, event_type, category, classification, inc)."""
    incs = [r[5] for r in sess]
    base = sorted(incs, key=lambda i: _naive(i.get("created_at")) or datetime.max)[0]
    key, event_type, category = sess[0][0], sess[0][2], sess[0][3]

    # Union member event ids, ordered by time, deduped, capped at 500 most recent.
    pairs = []
    for r in sess:
        inc = r[5]
        eids = inc.get("event_ids") or ([inc["event_id"]] if inc.get("event_id") else [])
        for eid in eids:
            pairs.append((r[1], eid))
    seen, uniq = set(), []
    for _ts, eid in sorted(pairs, key=lambda x: x[0]):
        if eid in seen:
            continue
        seen.add(eid)
        uniq.append(eid)

    sev = max((i.get("severity", 2) for i in incs), default=2)
    sev_str = SEV_STR.get(sev, "medium")
    classification = max((r[4] for r in sess), key=lambda c: CLASS_RANK.get(c, 0))
    statuses = {i.get("status", "open") for i in incs}
    status = "open" if "open" in statuses else ("investigating" if "investigating" in statuses else "resolved")

    ev_ts_list = [r[1] for r in sess]
    first_at, last_at = min(ev_ts_list), max(ev_ts_list)
    created = min((_naive(i.get("created_at")) or first_at) for i in incs)

    if category == "blocked_sensitive":
        title = f"Blocked {classification} Data — {event_type.replace('_', ' ').title()}"
    else:
        title = f"{sev_str.title()} Severity Event — {event_type.replace('_', ' ').title()}"

    comments = []
    for i in incs:
        comments.extend(i.get("comments") or [])
    assigned = next((i.get("assigned_to") for i in incs if i.get("assigned_to")), None)

    return {
        "id": base.get("id") or base.get("event_id"),
        "event_id": base.get("event_id"),
        "dedup_key": key,
        "category": category,
        "title": title,
        "description": f"Auto-generated from {event_type} event(s). Classification: {classification}.",
        "severity": sev,
        "status": status,
        "agent_id": base.get("agent_id", "unknown"),
        "user_email": base.get("user_email", "unknown"),
        "event_type": event_type,
        "classification_level": classification,
        "event_ids": uniq[-500:],
        "event_count": len(uniq),
        "first_event_at": first_at,
        "last_event_at": last_at,
        "department": base.get("department", "DEFAULT"),
        "required_clearance": base.get("required_clearance", 0),
        "created_at": created,
        "updated_at": datetime.now(timezone.utc).replace(tzinfo=None),
        "assigned_to": assigned,
        "comments": comments,
    }


async def main(apply: bool):
    await init_databases()
    db = get_mongodb()
    col = db["incidents"]
    evc = db["dlp_events"]

    all_inc = await col.find({}).to_list(length=1_000_000)
    print(f"total incidents: {len(all_inc)}")

    enriched = []
    for inc in all_inc:
        ev = await evc.find_one(
            {"id": inc.get("event_id")},
            {"event_type": 1, "blocked": 1, "classification_level": 1, "severity": 1, "timestamp": 1, "_id": 0},
        ) or {}
        title = inc.get("title") or ""
        event_type = inc.get("event_type") or ev.get("event_type")
        if not event_type:
            event_type = (title.split("—")[-1].strip().lower().replace(" ", "_")) if "—" in title else "unknown"
        classification = inc.get("classification_level") or ev.get("classification_level") or "Public"
        blocked = ev.get("blocked")
        sev_str = SEV_STR.get(inc.get("severity", 2), "medium")
        if blocked is True and classification in ("Restricted", "Confidential"):
            category = "blocked_sensitive"
        elif sev_str in ("critical", "high"):
            category = "high_severity"
        elif title.startswith("Blocked"):
            category = "blocked_sensitive"
        else:
            category = "high_severity"
        key = f"{inc.get('user_email', 'unknown')}|{event_type}|{category}"
        ev_ts = _naive(ev.get("timestamp") or inc.get("created_at")) or datetime.now(timezone.utc).replace(tzinfo=None)
        enriched.append((key, ev_ts, event_type, category, classification, inc))

    groups = defaultdict(list)
    for row in enriched:
        groups[row[0]].append(row)

    merged_docs = []
    for key, rows in groups.items():
        rows.sort(key=lambda r: r[1])
        session, last_ts = [], None
        sessions = []
        for r in rows:
            if last_ts is not None and (r[1] - last_ts) > WINDOW:
                sessions.append(session)
                session = []
            session.append(r)
            last_ts = r[1]
        if session:
            sessions.append(session)
        for sess in sessions:
            merged_docs.append(_build_merged(sess))

    sizes = sorted((m["event_count"] for m in merged_docs), reverse=True)
    print(f"distinct groups: {len(groups)}  ->  coalesced incidents: {len(merged_docs)}")
    print(f"largest incident event_counts: {sizes[:10]}")
    print(f"incidents with >1 event: {sum(1 for s in sizes if s > 1)}")

    if not apply:
        print("\nDRY RUN — no changes written. Re-run with --apply to migrate.")
        return

    backup = db["incidents_backup_precoalesce"]
    await backup.drop()
    if all_inc:
        await backup.insert_many(all_inc)
    print(f"\nbacked up {len(all_inc)} incidents -> incidents_backup_precoalesce")

    await col.delete_many({})
    for m in merged_docs:
        m.pop("_id", None)
    if merged_docs:
        await col.insert_many(merged_docs)
    print(f"replaced incidents collection with {len(merged_docs)} coalesced incidents")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
