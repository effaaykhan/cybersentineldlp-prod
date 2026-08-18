"""
DLP Events API Endpoints
Query, filter, and manage DLP events
"""

from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Query, HTTPException, status, Request
from pydantic import BaseModel, Field
import structlog

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import (
    get_current_user,
    get_permission_set,
    require_permission,
    require_role,
)
from app.core.redaction import may_view_sensitive, redact_event, redact_events
from app.core.database import get_mongodb, get_db
from app.core.domains import domain_for_event_type
from app.core import web_activity as _WA
from app.services.domain_service import build_domain_mongo_filter
from app.services.event_processor import get_event_processor
from app.integrations.siem.integration_service import siem_service
from app.services.ioc_service import ioc_matcher

logger = structlog.get_logger()
router = APIRouter()


async def _match_iocs_and_tag(doc: Dict[str, Any]) -> None:
    """Match an event's destinations/hashes against active IOCs. On a hit, tag
    the event and record the match (alert + tag only — no enforcement change).
    Best-effort; never raises into the request path."""
    try:
        hits = await ioc_matcher.match_event(doc)
        if not hits:
            return
        db = get_mongodb()
        summary = [
            {"ioc_id": h["ioc_id"], "ioc_type": h["ioc_type"], "value": h["value"],
             "source": h.get("source"), "tlp": h.get("tlp")}
            for h in hits
        ]
        # Tag the event so the detail view shows the IOC hit.
        await db["dlp_events"].update_one(
            {"id": doc.get("id")},
            {"$set": {"ioc_matches": summary, "ioc_matched": True}},
        )
        # Record the match for the Threat Intelligence "recent matches" feed.
        await db.get_collection("ioc_matches").insert_one({
            "event_id": doc.get("id"),
            "timestamp": datetime.now(timezone.utc),
            "agent_id": doc.get("agent_id"),
            "event_type": doc.get("event_type"),
            "severity": doc.get("severity"),
            "destination": doc.get("destination") or doc.get("destination_host"),
            "file_path": doc.get("file_path"),
            "matches": summary,
        })
        logger.info("ioc_match", event_id=doc.get("id"), hits=len(summary))
    except Exception as e:  # noqa: BLE001
        logger.warning("ioc_match_failed", error=str(e))


def _siem_event_from_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten a stored event_doc into the shape SIEM connectors format
    (see SIEMConnector.format_dlp_event)."""
    ts = doc.get("timestamp")
    labels = doc.get("classification_labels") or []
    matched = doc.get("matched_policies") or []
    fpath = doc.get("file_path") or ""
    return {
        "event_id": doc.get("id"),
        "event_type": doc.get("event_type"),
        "severity": doc.get("severity", "medium"),
        "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else ts,
        "agent_id": doc.get("agent_id"),
        "agent_name": doc.get("agent_name") or doc.get("hostname"),
        "hostname": doc.get("hostname"),
        "agent_ip": doc.get("agent_ip") or doc.get("ip_address"),
        "classification_type": (labels[0] if labels else None) or doc.get("classification_category"),
        "confidence": doc.get("classification_score"),
        "blocked": bool(doc.get("blocked", False)),
        "policy_id": doc.get("policy_id"),
        "policy_name": (matched[0].get("policy_name") if matched else None),
        "username": doc.get("username"),
        "user_email": doc.get("user_email"),
        "source_ip": doc.get("source_ip") or doc.get("agent_ip"),
        "destination_host": doc.get("destination"),
        "file_name": (fpath.replace("\\", "/").rstrip("/").split("/")[-1] or None),
        "file_path": doc.get("file_path"),
        "file_hash": doc.get("file_hash") or (doc.get("metadata") or {}).get("file_hash"),
        "actions": [doc["action_taken"]] if doc.get("action_taken") else [],
        "metadata": {
            "classification_level": doc.get("classification_level"),
            "labels": labels,
        },
    }


async def _forward_to_siem(doc: Dict[str, Any]) -> None:
    """Best-effort real-time forward of one event to all SIEM connectors whose
    severity threshold it meets. Never raises into the request path."""
    try:
        if not siem_service.active_connectors:
            return
        await siem_service.forward_event(_siem_event_from_doc(doc))
    except Exception as e:  # noqa: BLE001
        logger.warning("siem_forward_failed", error=str(e))


class EventCreate(BaseModel):
    """Event creation model for agents"""
    event_id: str = Field(..., description="Unique event ID")
    event_type: str = Field(..., description="Event type")
    severity: str = Field(..., description="Event severity")
    agent_id: str = Field(..., description="Agent ID that detected the event")
    source_type: str = Field(default="endpoint", description="Source type")
    file_path: Optional[str] = Field(None, description="File path if applicable")
    source_path: Optional[str] = Field(None, description="Original source path (for transfer/block policies)")
    classification: Optional[Dict[str, Any]] = Field(None, description="Classification data")
    classification_level: Optional[str] = Field(None, description="Classification level (Public/Internal/Confidential/Restricted)")
    classification_score: Optional[float] = Field(None, description="Classification confidence score (0.0-1.0)")
    classification_labels: Optional[List[str]] = Field(None, description="List of sensitive data types detected")
    classification_category: Optional[str] = Field(None, description="Classification category (Public/Internal/Confidential/Restricted)")
    classification_rules_matched: Optional[List[str]] = Field(None, description="Names of classification rules that matched")
    # Document/image TYPE (passport, patent, source_code, …). Optional: the agent
    # MAY supply it (e.g. from the evaluate response); if it doesn't, the server
    # classifies it from the captured content during background processing.
    document_type: Optional[str] = Field(None, description="Detected document/image type id, e.g. 'passport'")
    document_type_label: Optional[str] = Field(None, description="Human label for document_type, e.g. 'Passport'")
    # Print events: the target printer, and WHY a job was blocked
    # ('printer_control' = device policy, 'content' = sensitive document).
    printer_name: Optional[str] = Field(None, description="Target printer name (print events)")
    block_reason: Optional[str] = Field(None, description="Why blocked: 'printer_control' | 'content'")
    # Integrity hashes of the inspected/"violated" file, computed on the endpoint
    # (both agents). Logged whenever a file was included — primarily the print
    # channel's spooled document, but usable by any file-bearing event.
    file_md5: Optional[str] = Field(None, description="MD5 of the violated/inspected file (hex)")
    file_sha256: Optional[str] = Field(None, description="SHA-256 of the violated/inspected file (hex)")
    detected_content: Optional[str] = Field(None, description="Summary of detected sensitive content")
    action: Optional[str] = Field(None, description="Action taken (logged, blocked, alerted, etc.)")
    destination: Optional[str] = Field(None, description="Destination path for transfers")
    destination_type: Optional[str] = Field(None, description="Destination type (e.g., removable_drive, network_share)")
    content: Optional[str] = Field(None, description="Raw content captured (clipboard, file snippet, etc.)")
    usb_event_type: Optional[str] = Field(None, description="USB event subtype (connect, disconnect, transfer)")
    # USB device identity captured by the endpoint agent on connect/disconnect.
    # All arrive as strings (the agent sends capacity as a decimal string and
    # may send "" when a field is unavailable), so keep them Optional[str] —
    # declaring capacity as int would 422 on an empty string and drop the event.
    device_name: Optional[str] = Field(None, description="Human-readable device description")
    device_id: Optional[str] = Field(None, description="Raw device instance path / interface id")
    vendor_id: Optional[str] = Field(None, description="USB vendor ID (VID)")
    product_id: Optional[str] = Field(None, description="USB product ID (PID)")
    serial_number: Optional[str] = Field(None, description="Hardware serial number of the device")
    manufacturer: Optional[str] = Field(None, description="Device manufacturer")
    product_name: Optional[str] = Field(None, description="Device model / friendly name")
    volume_label: Optional[str] = Field(None, description="Mounted volume label (the 'USB name')")
    volume_serial: Optional[str] = Field(None, description="Filesystem volume serial (XXXX-XXXX)")
    file_system: Optional[str] = Field(None, description="Filesystem type (FAT32/exFAT/NTFS)")
    drive_letter: Optional[str] = Field(None, description="Mounted drive letter, e.g. 'E:'")
    capacity_bytes: Optional[str] = Field(None, description="Total volume capacity in bytes (decimal string)")
    blocked: Optional[bool] = Field(None, description="Whether action was blocked")
    event_subtype: Optional[str] = Field(None, description="Event subtype")
    description: Optional[str] = Field(None, description="Event description")
    user_email: Optional[str] = Field(None, description="User email")
    policy_version: Optional[str] = Field(None, description="Agent policy bundle version when event was generated")
    # Optional ABAC overrides — if absent, server derives from user_email / defaults.
    department: Optional[str] = Field(None, description="ABAC department (frozen at ingest)")
    required_clearance: Optional[int] = Field(None, description="ABAC required clearance level")
    # Agent-asserted policy attribution. The agent already evaluated which
    # enabled policies matched this event content; without this field the
    # server has no way to attribute the event back to a rule (monitoring
    # policies have empty conditions.rules and never match server-side).
    matched_policies: Optional[List[Any]] = Field(
        None,
        description=(
            "Policy IDs (or {policy_id,...} dicts) the agent matched against "
            "this event. Server resolves these to enriched records and uses "
            "their severity/action when no server-side rules matched."
        ),
    )
    # Per-line diff captured by the agent on file_modified events.
    # Populated when the new content differs from the previous snapshot
    # the agent has on disk; the analyst can see exactly which lines
    # changed in a large file instead of just "file modified."
    content_changes: Optional[List[Dict[str, Any]]] = Field(
        None,
        description=(
            "Line-level diff: list of {line, action: added|removed, content} "
            "entries. Only present on file_modified events."
        ),
    )
    lines_added: Optional[int] = Field(None, description="Count of added lines in content_changes")
    lines_removed: Optional[int] = Field(None, description="Count of removed lines in content_changes")
    content_changes_truncated: Optional[bool] = Field(
        None,
        description="True when content_changes was capped to avoid oversized payloads",
    )
    # Network exfiltration context captured by the endpoint agent on
    # network_exfil events (data leaving over ftp/scp/http/python-server/…).
    # All Optional so a partial payload never 422s and drops the event; blank
    # fields are pruned before persisting. Stored flat (DLPEvent has
    # extra="allow", so they reach the event-detail UI) and mirrored under a
    # "network" object for the SIEM formatter / title builder.
    protocol: Optional[str] = Field(None, description="Transport/app protocol (ftp, scp, https, dns, …)")
    transfer_method: Optional[str] = Field(None, description="Canonical exfil method (scp, python_http_server, curl, …)")
    process_name: Optional[str] = Field(None, description="Process that initiated the transfer")
    process_path: Optional[str] = Field(None, description="Full path of the initiating process")
    destination_host: Optional[str] = Field(None, description="Remote hostname / domain")
    destination_ip: Optional[str] = Field(None, description="Remote IP address")
    destination_port: Optional[str] = Field(None, description="Remote port (string — agent may send '' when unknown)")
    direction: Optional[str] = Field(None, description="Traffic direction (outbound/inbound)")
    bytes_transferred: Optional[str] = Field(None, description="Bytes moved (decimal string)")
    # ── Web activity context (browser extension) ─────────────────────────────
    # WHAT the user was doing and WHAT KIND of app they were doing it in. See
    # app/core/web_activity.py. Without these two fields a GenAI prompt and a
    # Google Drive upload are the same "cloud_upload" row on the dashboard, and
    # a requirement written per-activity cannot be reported on at all.
    activity: Optional[str] = Field(None, description="upload|download|attach|send|post|ai_response")
    app_category: Optional[str] = Field(None, description="webmail|cloud_storage|collaboration|genai")
    app_id: Optional[str] = Field(None, description="Catalog app id, e.g. 'chatgpt'")
    app_name: Optional[str] = Field(None, description="Human app name, e.g. 'ChatGPT'")
    page_url: Optional[str] = Field(None, description="Page the activity happened on")
    page_host: Optional[str] = Field(None, description="Hostname of that page")
    # The typed/pasted body itself — the GenAI prompt, the email body, the chat
    # message. Stored so an analyst investigating "an Aadhaar number went to
    # ChatGPT" can see what was actually asked; `content` already carries the
    # same convention for clipboard events and inherits its retention and
    # redaction handling.
    text_content: Optional[str] = Field(None, description="Typed/pasted body text of the activity")
    text_truncated: Optional[bool] = Field(None, description="True when text_content was capped")
    attachment_names: Optional[List[str]] = Field(None, description="Attachment filenames on this activity")
    recipients: Optional[str] = Field(None, description="Recipients / destination of a send")
    # Why the decision went the way it did, and what it did. An event that says
    # "masked" and nothing else is a verdict with the reasoning thrown away.
    policy_reason: Optional[str] = Field(None, description="The rule/policy sentence behind the verdict")
    matched_rules: Optional[List[str]] = Field(None, description="Names of the classification rules that fired")
    # Redaction evidence. TYPES AND COUNTS ONLY — the values are the thing that
    # was removed, and writing them into the event would put them back.
    mask_summary: Optional[List[Dict[str, Any]]] = Field(
        None, description="What was replaced, as [{type, count}] — never the values"
    )
    masked_text: Optional[str] = Field(None, description="What actually left the machine after redaction")


class DLPEvent(BaseModel):
    id: str = ""
    title: Optional[str] = None
    timestamp: Optional[datetime] = None
    event_type: str = "unknown"
    event_subtype: Optional[str] = None
    description: Optional[str] = None
    source: str = "unknown"
    agent_id: str = "unknown"
    # Enriched from the agents table at read time so the UI can render a
    # human-readable label ("CRYPTON (002)") instead of the raw agent_id
    # UUID. Both fall back to None when the agent has been deleted; the
    # raw agent_id stays the source of truth and is never overwritten.
    agent_name: Optional[str] = None
    agent_code: Optional[int] = None
    user_email: str = "agent@system"
    classification_level: Optional[str] = None
    classification_score: Optional[float] = 0.0
    classification_labels: Optional[List[str]] = Field(default_factory=list)
    classification: Optional[List[Dict[str, Any]]] = None
    classification_metadata: Optional[Dict[str, Any]] = None
    classification_category: Optional[str] = None
    classification_rules_matched: Optional[List[str]] = None
    detected_content: Optional[str] = None
    policy_id: Optional[str] = None
    action_taken: str = "logged"
    severity: str = "medium"
    file_path: Optional[str] = None
    file_name: Optional[str] = None
    file_id: Optional[str] = None
    file_md5: Optional[str] = None
    file_sha256: Optional[str] = None
    mime_type: Optional[str] = None
    folder_id: Optional[str] = None
    folder_name: Optional[str] = None
    folder_path: Optional[str] = None
    source_path: Optional[str] = None
    destination: Optional[str] = None
    destination_type: Optional[str] = None
    blocked: bool = False
    content: Optional[str] = None
    clipboard_content: Optional[str] = None
    details: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    policy_version: Optional[str] = None
    matched_policies: Optional[List[Dict[str, Any]]] = None
    policy_action_summaries: Optional[List[Dict[str, Any]]] = None
    tags: Optional[List[str]] = None
    # Line-level diff captured by the agent on file_modified events.
    content_changes: Optional[List[Dict[str, Any]]] = None
    lines_added: Optional[int] = None
    lines_removed: Optional[int] = None
    content_changes_truncated: Optional[bool] = None

    class Config:
        extra = "allow"


class EventsResponse(BaseModel):
    events: List[DLPEvent]
    total: int
    skip: int
    limit: int


class EventQueryParams(BaseModel):
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    severity: Optional[List[str]] = None
    source: Optional[List[str]] = None
    user_email: Optional[str] = None
    blocked_only: bool = False


async def _attach_agent_info(events: List[Dict[str, Any]]) -> None:
    """Batch-fill ``agent_name``/``agent_code`` on event dicts in place.

    Events and agents both live in MongoDB (``dlp_events`` / ``agents``),
    so we can't SQL-JOIN them. Instead: collect the unique ``agent_id``s
    referenced by this page of events, fetch the matching agent docs in
    one query, then merge ``name`` and ``agent_code`` onto each event.
    The event documents themselves are never mutated — enrichment lives
    purely on the API response, so renames on the agent flow through
    automatically and the events collection stays canonical.

    Lookup order for each event:
      1. exact ``agent_id`` match (canonical)
      2. ``agent_id`` matches an agent's ``previous_agent_ids`` (covers
         events emitted before the agent rolled its UUID on reinstall)
      3. ``agent_id`` matches an agent's ``name`` (legacy events where
         the hostname was recorded as the id)
      4. event's own ``hostname`` matches an agent's ``name`` (covers
         events that pre-date stable UUIDs entirely)
    """
    if not events:
        return

    candidate_ids: set[str] = set()
    candidate_names: set[str] = set()
    for ev in events:
        aid = ev.get("agent_id")
        if aid and aid != "unknown":
            candidate_ids.add(aid)
            # The same string may double as a hostname for legacy agents.
            candidate_names.add(aid)
        host = ev.get("hostname") or ev.get("agent_hostname")
        if host:
            candidate_names.add(host)

    if not candidate_ids and not candidate_names:
        return

    db = get_mongodb()
    or_clauses: List[Dict[str, Any]] = []
    if candidate_ids:
        or_clauses.append({"agent_id": {"$in": list(candidate_ids)}})
        # Match historic UUIDs that the agent has rolled past.
        or_clauses.append({"previous_agent_ids": {"$in": list(candidate_ids)}})
    if candidate_names:
        or_clauses.append({"name": {"$in": list(candidate_names)}})

    cursor = db.agents.find(
        {"$or": or_clauses},
        {
            "_id": 0,
            "agent_id": 1,
            "name": 1,
            "agent_code": 1,
            "previous_agent_ids": 1,
        },
    )
    by_id: Dict[str, Dict[str, Any]] = {}
    by_name: Dict[str, Dict[str, Any]] = {}
    async for doc in cursor:
        if doc.get("agent_id"):
            by_id[doc["agent_id"]] = doc
        # Index every previous id so events tagged with old UUIDs hit
        # the same agent record.
        for prev in doc.get("previous_agent_ids") or []:
            by_id[prev] = doc
        if doc.get("name"):
            # Last-write-wins is fine — duplicates are rare and the agents
            # collection has a unique index on (name, os) for active rows.
            by_name[doc["name"]] = doc

    for ev in events:
        aid = ev.get("agent_id")
        host = ev.get("hostname") or ev.get("agent_hostname")
        match = (
            (by_id.get(aid) if aid else None)
            or (by_name.get(aid) if aid else None)
            or (by_name.get(host) if host else None)
        )
        if match:
            ev["agent_name"] = match.get("name") or ev.get("agent_name")
            if ev.get("agent_code") is None:
                ev["agent_code"] = match.get("agent_code")


# Action precedence used to pick which agent-matched policy "wins" when
# enriching event_doc. Mirrors the agent's classifier ranking so server
# and agent agree on suggestedAction.
_ACTION_RANK = {"log": 1, "alert": 2, "quarantine": 3, "block": 4}
_SEVERITY_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def _normalize_agent_matched_ids(raw: Optional[List[Any]]) -> List[str]:
    """Agent sends either bare UUID strings or {policy_id: ...} dicts."""
    if not raw:
        return []
    ids: List[str] = []
    for item in raw:
        if isinstance(item, str) and item:
            ids.append(item)
        elif isinstance(item, dict):
            pid = item.get("policy_id") or item.get("id")
            if pid:
                ids.append(str(pid))
    # Preserve order while deduping
    seen: set[str] = set()
    out: List[str] = []
    for pid in ids:
        if pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


async def _resolve_matched_policies(policy_ids: List[str]) -> List[Dict[str, Any]]:
    """
    Hydrate agent-asserted policy IDs into the canonical ``matched_policies``
    shape (``policy_id``, ``policy_name``, ``severity``, ``priority``, ``action``).

    Why: the agent has the policy bundle and is authoritative on which
    enabled policy matched a clipboard/USB/file copy. The server's rule-
    based evaluator skips monitoring policies entirely (their
    ``conditions.rules`` is empty), so without this resolution every
    monitoring-policy event would persist with ``policy_id: null`` and
    the dashboard couldn't link the event back to a rule.
    """
    if not policy_ids:
        return []
    from app.core.database import get_postgres_session
    from app.services.policy_service import PolicyService

    async with get_postgres_session() as session:
        service = PolicyService(session)
        out: List[Dict[str, Any]] = []
        for pid in policy_ids:
            try:
                policy = await service.get_policy_by_id(pid)
            except Exception:
                policy = None
            if not policy:
                # Agent referenced a policy that no longer exists; keep the
                # raw id so the event is still traceable in audits.
                out.append({"policy_id": pid})
                continue
            # Resolve canonical action from the policy's ``config.action``
            # (single canonical action — normalize_monitoring_actions
            # already collapsed the legacy {block:{}, alert:{}} shape).
            cfg = policy.config or {}
            action = cfg.get("action")
            if not action and policy.actions:
                action = next(iter(policy.actions.keys()), None)
            out.append({
                "policy_id": str(policy.id),
                "policy_name": policy.name,
                "severity": policy.severity,
                "priority": policy.priority or 0,
                "action": action,
            })
        return out


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_event(
    event: EventCreate,
    request: Request,
    background_tasks: BackgroundTasks = None,
) -> Dict[str, Any]:
    """
    Create a new DLP event.  Requires ``X-Agent-Key`` header from a registered agent.

    Flow:
      1. Authenticate agent (fast)
      2. Insert raw event into MongoDB (fast)
      3. Queue background processing (classify → evaluate → execute)

    The API returns immediately after step 2.  Step 3 runs asynchronously
    so the agent is not blocked by classification or webhook latency.
    """
    if background_tasks is None:
        background_tasks = BackgroundTasks()

    from app.api.v1.agents import verify_agent_key
    await verify_agent_key(request)

    db = get_mongodb()
    events_collection = db["dlp_events"]

    # Resolve ABAC attrs from the user that the event is about. If the
    # payload explicitly carried department/required_clearance we honour
    # those; otherwise we derive from the user_email via the cache.
    from app.services.user_dept_cache import resolve_user_attrs, DEFAULT_DEPARTMENT

    abac = await resolve_user_attrs(event.user_email)
    department = getattr(event, "department", None) or abac.department or DEFAULT_DEPARTMENT
    required_clearance = int(getattr(event, "required_clearance", 0) or 0)

    # ── Step 1: Build raw event doc (NO processing yet) ────────────────
    event_doc: Dict[str, Any] = {
        "id": event.event_id,
        "department": department,
        "required_clearance": required_clearance,
        "title": None,                 # Populated by background processor
        "timestamp": datetime.now(timezone.utc),
        "event_type": event.event_type,
        "severity": event.severity,
        "agent_id": event.agent_id,
        "source": event.source_type,
        "source_type": event.source_type,
        "user_email": event.user_email or "agent@system",
        "classification_level": event.classification_level,
        "classification_score": getattr(event, "classification_score", 0.0) or 0.0,
        "classification_labels": getattr(event, "classification_labels", []) or [],
        "policy_id": None,
        "action_taken": event.action or "logged",
        "file_path": event.file_path,
        "source_path": event.source_path or event.file_path,
        "destination": event.destination,
        "destination_type": event.destination_type,
        "clipboard_content": event.content if event.event_type.lower() == "clipboard" else None,
        "blocked": event.blocked if event.blocked is not None else False,
        "quarantined": False,
        "metadata": {},
        "policy_version": event.policy_version,
        "content": event.content,
        "classification_category": event.classification_category or event.classification_level or "Public",
        "classification_rules_matched": event.classification_rules_matched or [],
        "detected_content": event.detected_content,
        # Domain-scoped RBAC: stamp the policy domain so reporting can be
        # filtered per domain-admin. Derived from the event type.
        "policy_domain": domain_for_event_type(event.event_type),
        "processing_status": "pending",
    }

    if event.event_subtype:
        event_doc["event_subtype"] = event.event_subtype
    if event.description:
        event_doc["description"] = event.description
    # Document/image type: keep an agent-supplied value now; otherwise the
    # background processor fills it in by classifying the captured content.
    if event.document_type:
        event_doc["document_type"] = event.document_type
        event_doc["document_type_label"] = event.document_type_label or event.document_type
    # Print events: target printer + block reason (printer_control vs content).
    if event.printer_name:
        event_doc["printer_name"] = event.printer_name
    if event.block_reason:
        event_doc["block_reason"] = event.block_reason
    # File integrity hashes of the violated/inspected file (print channel etc.),
    # computed on the endpoint. Mirror the SHA-256 into ``file_hash`` too so the
    # existing SIEM connectors forward it without further changes.
    if event.file_md5:
        event_doc["file_md5"] = event.file_md5
    if event.file_sha256:
        event_doc["file_sha256"] = event.file_sha256
        event_doc.setdefault("file_hash", event.file_sha256)
    # Preserve agent-provided content diff fields so the event detail
    # view can render the per-line change list. Empty diffs are still
    # written so the UI can distinguish "modified, no textual change"
    # (e.g. metadata-only) from "modified, agent didn't compute diff."
    if event.content_changes is not None:
        event_doc["content_changes"] = event.content_changes
    if event.lines_added is not None:
        event_doc["lines_added"] = event.lines_added
    if event.lines_removed is not None:
        event_doc["lines_removed"] = event.lines_removed
    if event.content_changes_truncated is not None:
        event_doc["content_changes_truncated"] = event.content_changes_truncated

    # USB device identity (connect/disconnect events). Persist the fields the
    # agent captured — serial, model, volume label, capacity, etc. Written
    # both as top-level keys (the read model DLPEvent has extra="allow", so
    # they flow straight to the event-detail UI) and mirrored under a "usb"
    # object that the action processor / title builder consume. Blank/absent
    # fields are dropped so we never store empty placeholders.
    usb_device_fields = {
        "device_name": event.device_name,
        "device_id": event.device_id,
        "vendor_id": event.vendor_id,
        "product_id": event.product_id,
        "serial_number": event.serial_number,
        "manufacturer": event.manufacturer,
        "product_name": event.product_name,
        "volume_label": event.volume_label,
        "volume_serial": event.volume_serial,
        "file_system": event.file_system,
        "drive_letter": event.drive_letter,
        "capacity_bytes": event.capacity_bytes,
    }
    usb_device_fields = {k: v for k, v in usb_device_fields.items() if v not in (None, "")}
    if usb_device_fields:
        event_doc.update(usb_device_fields)
        event_doc["usb"] = {**event_doc.get("usb", {}), **usb_device_fields}

    # Network exfiltration context (network_exfil events). Same pattern as the
    # USB block above: persist the how/where the agent captured so the analyst
    # can see "Confidential file → scp → 203.0.113.5:22 by scp.exe" on the event
    # detail view. Blank/absent fields dropped so we never store placeholders.
    network_event_fields = {
        "protocol": event.protocol,
        "transfer_method": event.transfer_method,
        "process_name": event.process_name,
        "process_path": event.process_path,
        "destination_host": event.destination_host,
        "destination_ip": event.destination_ip,
        "destination_port": event.destination_port,
        "direction": event.direction,
        "bytes_transferred": event.bytes_transferred,
    }
    network_event_fields = {k: v for k, v in network_event_fields.items() if v not in (None, "")}
    if network_event_fields:
        event_doc.update(network_event_fields)
        event_doc["network"] = {**event_doc.get("network", {}), **network_event_fields}

    # Web activity context (browser extension). Same pattern as the two blocks
    # above — flat for the event-detail UI (DLPEvent has extra="allow") and
    # mirrored under "web" for the SIEM formatter and title builder. Values are
    # normalised so a slightly-off agent build ("ai"/"generate") still lands on
    # the canonical row instead of creating a parallel vocabulary in the event
    # store that no dashboard filter will ever match.
    web_event_fields = {
        "activity": _WA.normalize_activity(event.activity) or (event.activity or None),
        "app_category": _WA.normalize_category(event.app_category) or (event.app_category or None),
        "app_id": event.app_id,
        "app_name": event.app_name,
        "page_url": event.page_url,
        "page_host": event.page_host,
        "recipients": event.recipients,
    }
    web_event_fields = {k: v for k, v in web_event_fields.items() if v not in (None, "")}
    if web_event_fields:
        event_doc.update(web_event_fields)
        event_doc["web"] = {**event_doc.get("web", {}), **web_event_fields}
    if event.attachment_names:
        event_doc["attachment_names"] = event.attachment_names
    if event.policy_reason:
        event_doc["policy_reason"] = event.policy_reason
    if event.matched_rules:
        event_doc["matched_rules"] = event.matched_rules
        # The dashboard and the incident view already read this shape.
        event_doc.setdefault(
            "classification_rules_matched", [{"rule_name": r} for r in event.matched_rules]
        )
    if event.mask_summary:
        event_doc["mask_summary"] = event.mask_summary
    if event.masked_text:
        event_doc["masked_text"] = event.masked_text
    # The prompt / body text. Written to `content` as well when the agent did
    # not populate it, so every existing consumer that renders captured content
    # (event detail, incident view, SIEM payload) shows it without changes.
    if event.text_content:
        event_doc["text_content"] = event.text_content
        if not event_doc.get("content"):
            event_doc["content"] = event.text_content
    if event.text_truncated is not None:
        event_doc["text_truncated"] = event.text_truncated

    # Hydrate agent-asserted matched policies. The agent ran the policy
    # bundle against the content and is authoritative on which monitoring
    # policies matched; the server's rule-based evaluator can't replicate
    # this because monitoring policies have empty conditions.rules. Using
    # the resolved records here lets every event cite its triggering
    # policy and use that policy's operator-configured severity/action
    # instead of falling back to classification-derived defaults.
    #
    # IMPORTANT: when the agent's reported action is "allowed", it means
    # the policy *inspected* this content but did not detect anything
    # sensitive — the matched_policies array is monitoring-attribution
    # only. In that case we still attach the policies so the analyst can
    # trace which rule looked at the event, but we MUST NOT override the
    # agent's "allowed" outcome with the policy's enforcement action.
    agent_action_norm = (event.action or "").lower()
    agent_outcome_allowed = agent_action_norm in ("allowed", "allow")
    agent_matched_ids = _normalize_agent_matched_ids(
        getattr(event, "matched_policies", None)
    )
    resolved_matches: List[Dict[str, Any]] = []
    if agent_matched_ids:
        resolved_matches = await _resolve_matched_policies(agent_matched_ids)
        if resolved_matches:
            event_doc["matched_policies"] = resolved_matches
            event_doc["policy_id"] = resolved_matches[0].get("policy_id")
            if not agent_outcome_allowed:
                # Severity: pick the highest among matched policies. The
                # operator's configured severity wins over any classification-
                # derived bump (e.g. "Restricted" content forcing "critical").
                sevs = [
                    m.get("severity") for m in resolved_matches
                    if m.get("severity") in _SEVERITY_RANK
                ]
                if sevs:
                    event_doc["severity"] = max(
                        sevs, key=lambda s: _SEVERITY_RANK[s]
                    )
                # Action: pick the strongest enforcement (block > quarantine
                # > alert > log). Past-tense form matches the existing event
                # vocabulary (alert→alerted, block→blocked, etc.).
                actions = [
                    m.get("action") for m in resolved_matches
                    if m.get("action") in _ACTION_RANK
                ]
                if actions:
                    winning = max(actions, key=lambda a: _ACTION_RANK[a])
                    event_doc["action_taken"] = {
                        "alert": "alerted",
                        "block": "blocked",
                        "quarantine": "quarantined",
                        "log": "logged",
                    }.get(winning, winning)

    # ── Step 2: Atomic upsert into MongoDB (fast, <5ms) ────────────────
    result = await events_collection.update_one(
        {"id": event.event_id},
        {"$setOnInsert": event_doc},
        upsert=True,
    )
    if result.matched_count > 0:
        return {"status": "duplicate", "event_id": event.event_id}

    # ── Real-time SIEM forwarding (best-effort, severity-thresholded) ──
    background_tasks.add_task(_forward_to_siem, dict(event_doc))

    # ── Threat-intel IOC matching (alert + tag only) ──────────────────
    background_tasks.add_task(_match_iocs_and_tag, dict(event_doc))

    # ── Step 3: Queue background processing ────────────────────────────
    payload = _build_processor_payload(event)
    # Tell the processor about the agent-resolved matches so its
    # classify_event stage won't override the policy-derived severity.
    if resolved_matches:
        payload["matched_policies"] = resolved_matches
    background_tasks.add_task(
        _process_event_background,
        event_id=event.event_id,
        payload=payload,
    )

    return {"status": "accepted", "event_id": event.event_id}


async def _process_event_background(event_id: str, payload: Dict[str, Any]) -> None:
    """
    Background worker: classify content, evaluate policies, execute actions.
    Updates the MongoDB event document with results.
    Retries up to 3 times on transient failures.
    """
    MAX_RETRIES = 3
    db = get_mongodb()
    events_collection = db["dlp_events"]

    # Snapshot the fields the document-type step needs BEFORE process_event runs
    # — the processor mutates/consumes payload (content in particular), so these
    # must be read up-front.
    _doctype_agent = payload.get("document_type")
    _doctype_agent_label = payload.get("document_type_label")
    _doctype_content = payload.get("content") or ""

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            processor = get_event_processor()
            processed = await processor.process_event(payload)

            # Update the raw event doc with processing results
            update_fields: Dict[str, Any] = {
                "processing_status": "completed",
                "processed_at": datetime.now(timezone.utc),
            }

            # If the agent already attributed this event to one or more
            # policies, those represent the operator's authoritative
            # intent. The server's downstream stages (classify_event in
            # particular) may try to bump severity based on content
            # classification — we ignore those bumps here so the
            # operator-configured severity sticks. The same applies to
            # matched_policies: don't let an empty server-side match
            # wipe out the agent's attribution.
            agent_supplied_policies = bool(payload.get("matched_policies"))
            # Distinguish "agent matched something" from "agent only saw
            # the content but found nothing sensitive in it". The latter
            # carries action="allowed" (or similar) from the agent's
            # Public path. For those events the server's independent
            # classifier MUST NOT relabel the event as Restricted /
            # Confidential — the only enabled policies didn't consider
            # the content sensitive, so any contradiction is the server
            # second-guessing the operator's policy set.
            agent_action = (payload.get("event", {}).get("action") or "").lower()
            agent_outcome_allowed = agent_action in ("allowed", "allow")

            # Merge processed results
            if processed.get("event"):
                ev = processed["event"]
                if ev.get("severity") and not agent_supplied_policies:
                    update_fields["severity"] = ev["severity"]
                if ev.get("action") and not agent_supplied_policies:
                    update_fields["action_taken"] = ev["action"]

            if processed.get("blocked") and not agent_outcome_allowed:
                update_fields["blocked"] = True
            if processed.get("quarantined") and not agent_outcome_allowed:
                update_fields["quarantined"] = True
            if processed.get("classification_metadata") and not agent_outcome_allowed:
                update_fields["classification_metadata"] = processed["classification_metadata"]
                cm = processed["classification_metadata"]
                if cm.get("classification_level"):
                    update_fields["classification_level"] = cm["classification_level"]
                if cm.get("confidence_score") is not None:
                    update_fields["classification_score"] = cm["confidence_score"]
            if processed.get("matched_policies"):
                # If the server-side evaluator also matched policies
                # (conditions.rules-based), union them with the agent's
                # attribution. Dedupe by policy_id to avoid double-billing.
                server_matches = processed["matched_policies"]
                if agent_supplied_policies:
                    seen = {
                        m.get("policy_id")
                        for m in payload["matched_policies"]
                        if isinstance(m, dict)
                    }
                    merged = list(payload["matched_policies"])
                    for sm in server_matches:
                        if sm.get("policy_id") not in seen:
                            merged.append(sm)
                            seen.add(sm.get("policy_id"))
                    update_fields["matched_policies"] = merged
                else:
                    update_fields["matched_policies"] = server_matches
            if processed.get("metadata"):
                update_fields["metadata"] = processed["metadata"]

            # Document/image TYPE for the log (passport, patent, source_code, …).
            # ADDITIVE — annotates the event only; never changes the action,
            # severity, or classification level. Prefer a type the agent already
            # supplied; otherwise classify the captured content server-side so a
            # transfer of e.g. a passport is labelled in the log with no agent
            # change. Guarded: a failure here never fails event processing.
            try:
                doc_type = _doctype_agent
                doc_label = _doctype_agent_label
                doc_types = []
                if not doc_type:
                    text = _doctype_content
                    if isinstance(text, str) and len(text.strip()) >= 20:
                        from app.services.document_classifier import classify_document
                        doc_types = classify_document(text)
                        if doc_types:
                            doc_type = doc_types[0]["type"]
                            doc_label = doc_types[0]["label"]
                if doc_type:
                    update_fields["document_type"] = doc_type
                    update_fields["document_type_label"] = doc_label or doc_type
                    if doc_types:
                        update_fields["document_types"] = doc_types
            except Exception as _dte:
                logger.warning("document-type detection skipped",
                               event_id=event_id, error=str(_dte))

            await events_collection.update_one(
                {"id": event_id},
                {"$set": update_fields},
            )

            # Auto-create incident for blocked/critical events
            await _auto_create_incident(db, event_id, payload, update_fields)

            # PG mirror: read the now-finalised Mongo doc (has classification,
            # action_taken, department, etc.) and mirror it into the PG events
            # table so analytics/export have something to aggregate. Best-
            # effort — failures are logged inside the service and do not
            # affect the background task's success.
            try:
                final_doc = await events_collection.find_one({"id": event_id})
                if final_doc:
                    from app.services.pg_event_mirror import mirror_event_to_pg
                    await mirror_event_to_pg(final_doc)
            except Exception as mirror_err:
                logger.warning(
                    "pg_mirror dispatch failed (non-fatal)",
                    event_id=event_id,
                    error=str(mirror_err),
                )

            logger.info("Background event processing complete", event_id=event_id)
            return

        except Exception as e:
            logger.warning(
                "Background event processing failed",
                event_id=event_id,
                attempt=attempt,
                error=str(e),
            )
            if attempt < MAX_RETRIES:
                import asyncio
                await asyncio.sleep(2 ** attempt)  # Exponential backoff
            else:
                # Mark as failed after all retries
                try:
                    await events_collection.update_one(
                        {"id": event_id},
                        {"$set": {
                            "processing_status": "failed",
                            "processing_error": str(e),
                            "processed_at": datetime.now(timezone.utc),
                        }},
                    )
                except Exception:
                    pass
                logger.error(
                    "Background event processing exhausted retries",
                    event_id=event_id,
                    error=str(e),
                )


# Coalescing controls: repeated same-user / same-type / same-category events
# fold into ONE incident whose last event is within this window, instead of
# creating a fresh incident per event. MAX_INCIDENT_EVENT_IDS caps the stored
# member-id array (event_count remains the true total).
INCIDENT_COALESCE_WINDOW_HOURS = 24
MAX_INCIDENT_EVENT_IDS = 500


async def _auto_create_incident(
    db, event_id: str, payload: Dict[str, Any], update_fields: Dict[str, Any]
) -> None:
    """
    Auto-create (or grow) incidents for blocked or high-severity events.

    An event qualifies when its classification is Restricted/Confidential AND it
    was blocked (Rule 1), or its severity is critical/high (Rule 2). Qualifying
    events are COALESCED: repeated events of the same kind from the same user
    join one incident (see the coalescing block below) rather than spawning a
    new incident each time. ``event_count`` is the number of events grouped into
    the incident and ``event_ids`` lists them.
    """
    try:
        incidents_col = db["incidents"]
        events_col = db["dlp_events"]

        classification = (
            update_fields.get("classification_level")
            or payload.get("classification_level")
            or "Public"
        )
        action = update_fields.get("action_taken") or payload.get("event", {}).get("action", "logged")
        severity_str = update_fields.get("severity") or payload.get("event", {}).get("severity", "low")
        blocked = update_fields.get("blocked", False)
        agent_id = payload.get("agent", {}).get("id", "unknown")
        user_email = payload.get("user", {}).get("email", "unknown")
        event_type = payload.get("event", {}).get("type", "unknown")

        # Categorize the event. Rule 1 (blocked sensitive data) wins over
        # Rule 2 (high/critical severity) when both apply.
        if blocked and classification in ("Restricted", "Confidential"):
            category = "blocked_sensitive"
            title = f"Blocked {classification} Data — {event_type.replace('_', ' ').title()}"
            sev_num = 4 if classification == "Restricted" else 3
        elif severity_str in ("critical", "high"):
            category = "high_severity"
            title = f"{severity_str.title()} Severity Event — {event_type.replace('_', ' ').title()}"
            sev_num = 4 if severity_str == "critical" else 3
        else:
            return

        # Idempotency: never record the same event twice — as a coalesced member
        # or as a legacy single-event incident.
        if await incidents_col.find_one({"event_ids": event_id}, {"_id": 1}):
            return
        if await incidents_col.find_one({"event_id": event_id}, {"_id": 1}):
            return

        # Source-event ABAC attributes + timestamp (authoritative post-tag).
        src_event = await events_col.find_one(
            {"id": event_id},
            projection={"department": 1, "required_clearance": 1, "timestamp": 1, "_id": 0},
        ) or {}
        dept = src_event.get("department") or "DEFAULT"
        req_clr = int(src_event.get("required_clearance") or 0)
        ev_ts = src_event.get("timestamp") or datetime.now(timezone.utc)
        now = datetime.now(timezone.utc)

        # COALESCE: a qualifying event joins the most recent still-active incident
        # of the same (user, event_type, category) whose last event is within the
        # window; otherwise it starts a new incident. This makes event_count mean
        # "events in this incident" and stops one-incident-per-event flooding.
        from datetime import timedelta
        dedup_key = f"{user_email}|{event_type}|{category}"
        window_start = ev_ts - timedelta(hours=INCIDENT_COALESCE_WINDOW_HOURS)

        coalesced = await incidents_col.update_one(
            {
                "dedup_key": dedup_key,
                "status": {"$in": ["open", "investigating"]},
                "last_event_at": {"$gte": window_start},
            },
            {
                "$inc": {"event_count": 1},
                "$push": {"event_ids": {"$each": [event_id], "$slice": -MAX_INCIDENT_EVENT_IDS}},
                "$max": {"severity": sev_num, "last_event_at": ev_ts},
                "$set": {"updated_at": now},
            },
        )
        if coalesced.matched_count:
            logger.info("Auto-incident coalesced", event_id=event_id, dedup_key=dedup_key)
            return

        incident_doc = {
            "id": event_id,
            "event_id": event_id,          # the incident's first / primary event
            "dedup_key": dedup_key,
            "category": category,
            "title": title,
            "description": f"Auto-generated from {event_type} event(s). Classification: {classification}. Action: {action}.",
            "severity": sev_num,
            "status": "open",
            "agent_id": agent_id,
            "user_email": user_email,
            "event_type": event_type,
            "classification_level": classification,
            "event_ids": [event_id],
            "event_count": 1,
            "first_event_at": ev_ts,
            "last_event_at": ev_ts,
            "department": dept,
            "required_clearance": req_clr,
            "created_at": now,
            "updated_at": now,
            "assigned_to": None,
            "comments": [],
        }

        await incidents_col.update_one(
            {"event_id": event_id},
            {"$setOnInsert": incident_doc},
            upsert=True,
        )

        logger.info("Auto-incident created", event_id=event_id, title=title, dedup_key=dedup_key)

    except Exception as e:
        logger.warning("Auto-incident creation failed (non-fatal)", error=str(e))


def _build_processor_payload(event: EventCreate) -> Dict[str, Any]:
    """
    Convert the agent-supplied event payload into the richer structure used by the EventProcessor.
    """
    payload: Dict[str, Any] = {
        "event_id": event.event_id,
        "agent": {
            "id": event.agent_id,
            "name": event.agent_id,
        },
        "event": {
            "type": event.event_type,
            "severity": event.severity,
            "source_type": event.source_type,
            "action": event.action or "logged",
        },
        "metadata": {
            "ingest_source": "api",
        },
        "tags": [],
    }

    if event.user_email:
        payload.setdefault("user", {})["email"] = event.user_email

    if event.file_path:
        payload.setdefault("file", {})["path"] = event.file_path
    if event.source_path or event.file_path:
        source_path = event.source_path or event.file_path
        payload["source_path"] = source_path
        payload.setdefault("file", {})["source_path"] = source_path

    if event.destination:
        payload.setdefault("destination", {})["path"] = event.destination

    if event.destination_type:
        payload["destination_type"] = event.destination_type
        payload.setdefault("destination", {})["type"] = event.destination_type

    if event.classification:
        payload["classification"] = event.classification

    if event.content:
        payload["content"] = event.content
        payload["clipboard_content"] = event.content
    elif event.description and event.event_type.lower() == "clipboard":
        payload["clipboard_content"] = event.description

    if event.document_type:
        payload["document_type"] = event.document_type
        payload["document_type_label"] = event.document_type_label or event.document_type

    if event.event_subtype:
        payload["event"]["subtype"] = event.event_subtype

    if event.usb_event_type:
        payload.setdefault("usb", {})["event_type"] = event.usb_event_type

    if event.blocked is not None:
        payload["blocked"] = event.blocked

    if event.description:
        payload["description"] = event.description

    if event.policy_version:
        payload["policy_version"] = event.policy_version

    # Include classification data from agent
    if event.classification_level or event.classification_score or event.classification_labels:
        payload["classification_metadata"] = {
            "classification_level": event.classification_level,
            "confidence_score": event.classification_score or 0.0,
        }
        if event.classification_labels:
            payload["classification_labels"] = event.classification_labels

    return payload


def _build_event_title(event: EventCreate, processed_event: Dict[str, Any]) -> str:
    """Build descriptive event title"""
    from pathlib import Path

    event_type = event.event_type
    event_subtype = event.event_subtype or ""

    # Extract file name
    file_name = "Unknown"
    if event.file_path:
        file_name = Path(event.file_path).name

    # Extract classification
    classification_meta = processed_event.get("classification_metadata", {})
    classification = classification_meta.get("classification_level", "Public")
    confidence = classification_meta.get("confidence_score", 0.0)

    # Check if blocked
    blocked = processed_event.get("blocked", False)

    # Build title based on event type
    if "usb" in event_type.lower():
        if "file_transfer" in event_subtype.lower():
            action = "Blocked" if blocked else "Allowed"
            if classification and confidence > 0:
                return f"USB Transfer {action} - {file_name} ({classification} - {int(confidence * 100)}%)"
            else:
                return f"USB Transfer {action} - {file_name}"
        elif "connect" in event_subtype.lower():
            return "USB Device Connected"
        elif "disconnect" in event_subtype.lower():
            return "USB Device Disconnected"
        else:
            return f"USB Event - {event_subtype}"
    elif "clipboard" in event_type.lower():
        action = "Blocked" if blocked else "Copied"
        if classification and confidence > 0:
            return f"Clipboard {action} ({classification} - {int(confidence * 100)}%)"
        else:
            return f"Clipboard {action}"
    elif "file" in event_type.lower():
        action = "Blocked" if blocked else "Modified"
        return f"File {action} - {file_name}"
    else:
        return f"{event_type.title()} Event - {file_name}"


def _merge_processed_event(event_doc: Dict[str, Any], processed_event: Dict[str, Any]) -> None:
    """
    Merge classification results, policy matches, and action summaries from the EventProcessor output.
    """
    classification = processed_event.get("classification")
    if classification:
        event_doc["classification"] = classification
        labels = [cls.get("label") for cls in classification if isinstance(cls, dict) and cls.get("label")]
        event_doc["classification_labels"] = labels
        confidences = [cls.get("confidence", 0.0) for cls in classification if isinstance(cls, dict)]
        if confidences:
            event_doc["classification_score"] = max(confidences)

    classification_metadata = processed_event.get("classification_metadata")
    if classification_metadata:
        event_doc["classification_metadata"] = classification_metadata
        if classification_metadata.get("classification_level"):
            event_doc["classification_level"] = classification_metadata["classification_level"]

    matched_policies = processed_event.get("matched_policies")
    if matched_policies:
        event_doc["matched_policies"] = matched_policies
        if not event_doc.get("policy_id"):
            event_doc["policy_id"] = matched_policies[0].get("policy_id")

    action_summaries = processed_event.get("policy_action_summaries")
    if action_summaries:
        event_doc["policy_action_summaries"] = action_summaries

    if "blocked" in processed_event:
        event_doc["blocked"] = processed_event["blocked"]

    if "quarantined" in processed_event:
        event_doc["quarantined"] = processed_event["quarantined"]

    if processed_event.get("content_redacted"):
        event_doc["content_redacted"] = processed_event["content_redacted"]

    if processed_event.get("tags"):
        event_doc["tags"] = processed_event["tags"]

    if processed_event.get("clipboard_content"):
        event_doc["clipboard_content"] = processed_event["clipboard_content"]

    processor_event = processed_event.get("event", {})
    if processor_event.get("action"):
        event_doc["action_taken"] = processor_event["action"]


@router.get("/", response_model=EventsResponse)
async def get_events(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    severity: Optional[str] = None,
    source: Optional[str] = None,
    search: Optional[str] = Query(None, max_length=200, description="Search keyword for filtering events"),
    start_time: Optional[datetime] = Query(None),
    end_time: Optional[datetime] = Query(None),
    # Drill-down: filter to one agent and ALL its historic UUIDs.
    # Resolved against the agents collection so events emitted before
    # a reinstall still appear under the same agent record.
    agent: Optional[str] = Query(None, description="Filter by canonical agent_id (expands to previous_agent_ids)"),
    # Phase 3: filter-driven drill-down from dashboards. All optional.
    module: Optional[str] = Query(None, description="Alias for event_type (USB/clipboard/screen_capture/network_exfil)"),
    event_type: Optional[str] = Query(None),
    action: Optional[str] = Query(None, description="Matches action_taken case-insensitively"),
    classification: Optional[str] = Query(None, description="classification_level tier"),
    channel: Optional[str] = Query(None),
    current_user=Depends(require_permission("view_events")),
    permissions: set = Depends(get_permission_set),
    pg_db: AsyncSession = Depends(get_db),
):
    """
    Get DLP events with pagination and filtering.

    SECURITY: gated on the ``view_events`` PERMISSION, not the analyst role
    tier. The old role gate contradicted the sidebar (which shows this page to
    anything holding ``view_events``), so a VIEWER saw the link and got a 403 —
    the page simply never loaded.

    The concern behind that gate was real, though: these records carry
    clipboard captures and file excerpts. That is now handled where it belongs
    — callers without ``view_sensitive_content`` get the events with their
    captured payload redacted (app/core/redaction.py), so a VIEWER can triage
    and report without ever reading the data the event was protecting.

    Supports:
    - severity filter
    - source filter
    - search keyword (searches in event_type, description, file_path, destination, etc.)
    - time range via start_time / end_time

    ABAC: Results are further constrained per the viewer's department +
    clearance_level, unless they carry the ``view_all_departments``
    permission (in which case the filter is a no-op).
    """
    db = get_mongodb()

    # Build query filter
    query_filter: Dict[str, Any] = {}
    if severity:
        query_filter["severity"] = severity
    if source:
        query_filter["source"] = source
    if search:
        # SECURITY: The incoming `search` term is user-controlled and
        # used to build a Mongo `$regex` query. Without escaping, a
        # crafted pattern like `(a+)+$` can pin a mongod worker (ReDoS)
        # and a crafted anchored pattern can be used as a timing oracle
        # to enumerate documents. We escape all regex metacharacters so
        # the search is treated as a literal substring. `$options: "i"`
        # keeps the match case-insensitive.
        import re as _re
        escaped = _re.escape(search)
        search_pattern = {"$regex": escaped, "$options": "i"}
        query_filter["$or"] = [
            {"event_type": search_pattern},
            {"description": search_pattern},
            {"file_path": search_pattern},
            {"source_path": search_pattern},
            {"destination": search_pattern},
            {"action_taken": search_pattern},
            {"clipboard_content": search_pattern},
            {"event_subtype": search_pattern},
            {"source_type": search_pattern},
            {"destination_type": search_pattern},
            {"agent_id": search_pattern},
            {"user_email": search_pattern},
        ]

    # Resolve ``?agent=<id>`` to the set of every UUID the matching
    # agent has ever used (current + previous_agent_ids). Without this,
    # clicking an agent from the Agents tab only surfaces events from
    # AFTER the last reinstall — anything emitted under a rolled UUID
    # silently disappears from the filter.
    if agent:
        agent_doc = await db.agents.find_one(
            {
                "$or": [
                    {"agent_id": agent},
                    {"previous_agent_ids": agent},
                ]
            },
            {"_id": 0, "agent_id": 1, "previous_agent_ids": 1},
        )
        if agent_doc:
            id_set = {agent_doc["agent_id"], *(agent_doc.get("previous_agent_ids") or [])}
        else:
            # Unknown id — still filter by what the caller asked for so
            # we don't silently return ALL events.
            id_set = {agent}
        query_filter["agent_id"] = {"$in": list(id_set)}
    if start_time or end_time:
        time_filter: Dict[str, Any] = {}
        if start_time:
            time_filter["$gte"] = start_time
        if end_time:
            time_filter["$lte"] = end_time
        query_filter["timestamp"] = time_filter

    # ── Phase 3 dynamic filters ──────────────────────────────────────
    # Case-insensitive anchored regex via $regex + $options=i. We escape
    # every value so arbitrary user input can never be interpreted as
    # regex metacharacters (ReDoS / enumeration vectors).
    def _ci_exact(value: str) -> Dict[str, Any]:
        import re as _re
        return {"$regex": f"^{_re.escape(value)}$", "$options": "i"}

    # ``module`` is a frontend-facing alias for ``event_type`` — the
    # caller wins if both are provided.
    et = event_type or module
    if et:
        query_filter["event_type"] = _ci_exact(et)
    if action:
        # Ingest stores outcomes in ``action_taken`` with varied casing;
        # compare case-insensitively to keep "blocked"/"BLOCKED"/"block"
        # addressable from a dashboard drill-down.
        query_filter["action_taken"] = _ci_exact(action)
    if classification:
        # Mongo field matches the denormalized PG column name.
        query_filter["classification_level"] = _ci_exact(classification)
    if channel:
        query_filter["channel"] = _ci_exact(channel)

    # ── ABAC: merge viewer-specific visibility filter ─────────────────
    from app.services.abac_service import (
        build_abac_mongo_filter,
        merge_mongo_filter,
    )
    from app.services.domain_service import build_domain_mongo_filter
    abac_filter = await build_abac_mongo_filter(pg_db, current_user)
    query_filter = merge_mongo_filter(query_filter, abac_filter)
    # ── Domain-scoped RBAC: restrict a domain-admin to their domain ───
    query_filter = merge_mongo_filter(query_filter, build_domain_mongo_filter(current_user))

    # Query MongoDB
    cursor = (
        db.dlp_events.find(query_filter)
        .sort("timestamp", -1)
        .skip(skip)
        .limit(limit)
    )
    events_raw = await cursor.to_list(length=limit)

    # Convert MongoDB documents to match DLPEvent model
    events = []
    for event_doc in events_raw:
        try:
            # Remove MongoDB _id field and ensure all required fields exist
            event_dict = {k: v for k, v in event_doc.items() if k != "_id"}

            # Ensure required fields have defaults if missing
            if "id" not in event_dict:
                event_dict["id"] = event_dict.get("event_id", "")
            if "event_type" not in event_dict:
                event_dict["event_type"] = "unknown"
            if "severity" not in event_dict or event_dict["severity"] is None:
                event_dict["severity"] = "medium"
            if "agent_id" not in event_dict:
                event_dict["agent_id"] = "unknown"
            if "classification_score" not in event_dict:
                event_dict["classification_score"] = 0.0
            if "classification_labels" not in event_dict:
                event_dict["classification_labels"] = []
            if "policy_id" not in event_dict:
                event_dict["policy_id"] = None
            if "file_path" not in event_dict:
                event_dict["file_path"] = None
            if "source_path" not in event_dict:
                event_dict["source_path"] = event_dict.get("file_path")
            if "destination" not in event_dict:
                event_dict["destination"] = None
            if "destination_type" not in event_dict:
                event_dict["destination_type"] = None
            if "source" not in event_dict:
                event_dict["source"] = event_dict.get("source_type", "unknown")
            if "user_email" not in event_dict or event_dict["user_email"] is None:
                event_dict["user_email"] = "agent@system"
            if "action_taken" not in event_dict or event_dict["action_taken"] is None:
                event_dict["action_taken"] = "logged"
            if "blocked" not in event_dict or event_dict["blocked"] is None:
                event_dict["blocked"] = False
            if "content" not in event_dict:
                event_dict["content"] = None
            if "policy_version" not in event_dict:
                event_dict["policy_version"] = None

            # Normalize timestamp to timezone-aware UTC
            if "timestamp" in event_dict and isinstance(event_dict["timestamp"], datetime):
                if event_dict["timestamp"].tzinfo is None:
                    event_dict["timestamp"] = event_dict["timestamp"].replace(tzinfo=timezone.utc)
            elif "timestamp" not in event_dict or event_dict["timestamp"] is None:
                event_dict["timestamp"] = datetime.now(timezone.utc)

            events.append(event_dict)
        except Exception as e:
            logger.warning("Skipping malformed event document", error=str(e))

    # Enrich with friendly agent label (name + numeric code) from the
    # Mongo agents collection — no JOIN, just a batched lookup.
    await _attach_agent_info(events)

    # Get total count for pagination
    total = await db.dlp_events.count_documents(query_filter)

    logger.info(
        "Events queried",
        user=getattr(current_user, "email", None),
        count=len(events),
        total=total,
        filters=query_filter,
    )

    # Aggregated ABAC observability — one line per request, no per-record
    # events. `visible_count` is the filtered total the caller would see
    # if they paginated through; it already reflects ABAC.
    from app.services.audit_service import log_abac_scope
    log_abac_scope(
        current_user,
        endpoint="GET /events/",
        visible_count=total,
        extra={"has_abac_filter": abac_filter is not None},
    )

    # Redact captured payload for callers without view_sensitive_content.
    # Applied last, on the way out, so it covers every branch above regardless
    # of which store served the rows.
    if not may_view_sensitive(permissions):
        events = redact_events(events)

    return {
        "events": events,
        "total": total,
        "skip": skip,
        "limit": limit,
    }


@router.get("/{event_id}", response_model=DLPEvent)
async def get_event(
    event_id: str,
    current_user=Depends(require_permission("view_events")),
    permissions: set = Depends(get_permission_set),
    pg_db: AsyncSession = Depends(get_db),
):
    """
    Get specific DLP event by ID. Gated on the ``view_events`` permission;
    callers without ``view_sensitive_content`` receive the record with its
    clipboard captures and file excerpts redacted rather than being denied
    the record outright (see GET / above for the rationale).

    ABAC: if the viewer lacks ``view_all_departments``, a matching event
    is only returned when its department + clearance satisfy the viewer's
    attributes. Otherwise we 404 (same response as "not found") — we do
    not leak existence via a 403.
    """
    from app.services.abac_service import (
        build_abac_mongo_filter,
        merge_mongo_filter,
    )

    db = get_mongodb()
    abac = await build_abac_mongo_filter(pg_db, current_user)
    _dom = build_domain_mongo_filter(current_user)
    if _dom is not None:
        abac = merge_mongo_filter(abac or {}, _dom)
    lookup = merge_mongo_filter({"id": event_id}, abac)

    event = await db.dlp_events.find_one(lookup)
    if not event:
        # Distinguish "truly absent" from "ABAC-filtered": if a doc exists
        # with this id but didn't pass the filter, record a DENY. Otherwise
        # the 404 is genuine and no log is written.
        if abac is not None:
            exists_unfiltered = await db.dlp_events.find_one(
                {"id": event_id}, projection={"_id": 1}
            )
            if exists_unfiltered is not None:
                try:
                    from app.services.audit_service import audit_abac_deny
                    await audit_abac_deny(
                        user=current_user,
                        resource_type="event",
                        resource_id=event_id,
                        reason="dept_or_clearance_mismatch",
                    )
                except Exception:
                    pass
        raise HTTPException(status_code=404, detail="Event not found")

    # Enrich with friendly agent label so the detail view shows
    # "CRYPTON (002)" rather than the raw agent_id UUID.
    event_dict = {k: v for k, v in event.items() if k != "_id"}
    await _attach_agent_info([event_dict])
    if not may_view_sensitive(permissions):
        event_dict = redact_event(event_dict)
    return event_dict


@router.get("/stats/summary")
async def get_event_stats(
    current_user=Depends(get_current_user),
    pg_db: AsyncSession = Depends(get_db),
):
    """
    Get event statistics summary (ABAC-scoped).
    """
    from app.services.abac_service import (
        build_abac_mongo_filter,
        merge_mongo_filter,
    )

    db = get_mongodb()
    abac = await build_abac_mongo_filter(pg_db, current_user)
    _dom = build_domain_mongo_filter(current_user)
    if _dom is not None:
        abac = merge_mongo_filter(abac or {}, _dom)
    base = merge_mongo_filter({}, abac)
    blocked = merge_mongo_filter({"blocked": True}, abac)

    total_events = await db.dlp_events.count_documents(base)
    blocked_events = await db.dlp_events.count_documents(blocked)

    # Mongo aggregation pipelines must start with $match so the ABAC filter
    # is applied before $group — otherwise totals leak from other depts.
    pre_match: list = [{"$match": base}] if base else []

    severity_pipeline = pre_match + [
        {"$group": {"_id": "$severity", "count": {"$sum": 1}}}
    ]
    severity_stats = await db.dlp_events.aggregate(severity_pipeline).to_list(None)

    source_pipeline = pre_match + [
        {"$group": {"_id": "$source", "count": {"$sum": 1}}}
    ]
    source_stats = await db.dlp_events.aggregate(source_pipeline).to_list(None)

    return {
        "total_events": total_events,
        "blocked_events": blocked_events,
        "by_severity": {item["_id"]: item["count"] for item in severity_stats},
        "by_source": {item["_id"]: item["count"] for item in source_stats},
    }


@router.get("/stats/by-type")
async def get_events_by_type(
    current_user=Depends(get_current_user),
    pg_db: AsyncSession = Depends(get_db),
):
    """Events grouped by type for dashboard charts (ABAC-scoped)."""
    from app.services.abac_service import (
        build_abac_mongo_filter,
        merge_mongo_filter,
    )

    db = get_mongodb()
    abac = await build_abac_mongo_filter(pg_db, current_user)
    _dom = build_domain_mongo_filter(current_user)
    if _dom is not None:
        abac = merge_mongo_filter(abac or {}, _dom)
    base = merge_mongo_filter({}, abac)
    pre_match: list = [{"$match": base}] if base else []

    pipeline = pre_match + [
        {"$group": {"_id": "$event_type", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    type_stats = await db.dlp_events.aggregate(pipeline).to_list(None)
    return [
        {"type": item["_id"] or "unknown", "count": item["count"]}
        for item in type_stats
    ]


@router.get("/stats/by-severity")
async def get_events_by_severity(
    current_user=Depends(get_current_user),
    pg_db: AsyncSession = Depends(get_db),
):
    """Events grouped by severity for dashboard charts (ABAC-scoped)."""
    from app.services.abac_service import (
        build_abac_mongo_filter,
        merge_mongo_filter,
    )

    db = get_mongodb()
    abac = await build_abac_mongo_filter(pg_db, current_user)
    _dom = build_domain_mongo_filter(current_user)
    if _dom is not None:
        abac = merge_mongo_filter(abac or {}, _dom)
    base = merge_mongo_filter({}, abac)
    pre_match: list = [{"$match": base}] if base else []

    pipeline = pre_match + [
        {"$group": {"_id": "$severity", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    severity_stats = await db.dlp_events.aggregate(pipeline).to_list(None)
    return [
        {"severity": item["_id"] or "unknown", "count": item["count"]}
        for item in severity_stats
    ]


@router.delete("/clear", status_code=status.HTTP_200_OK)
async def clear_all_events(
    current_user = Depends(require_role("admin")),
):
    """
    Clear all events from MongoDB (admin only)
    
    This endpoint deletes all events from the dlp_events collection.
    Use with caution as this action cannot be undone.
    """
    db = get_mongodb()
    events_collection = db["dlp_events"]
    
    try:
        # Get count before deletion
        before_count = await events_collection.count_documents({})
        
        # Delete all events
        result = await events_collection.delete_many({})
        deleted_count = result.deleted_count
        
        # Get count after deletion
        after_count = await events_collection.count_documents({})
        
        # Access user email - require_role returns User object
        user_email = getattr(current_user, "email", "unknown")
        
        logger.info(
            "All events cleared",
            user=user_email,
            deleted_count=deleted_count,
            before_count=before_count,
            after_count=after_count,
        )
        
        return {
            "status": "success",
            "message": "All events cleared successfully",
            "deleted_count": deleted_count,
            "before_count": before_count,
            "after_count": after_count,
        }
        
    except Exception as e:
        # Access user email - require_role returns User object
        user_email = getattr(current_user, "email", "unknown")
        logger.error("Failed to clear events", error=str(e), user=user_email)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to clear events: {str(e)}"
        )
