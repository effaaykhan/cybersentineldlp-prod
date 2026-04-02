"""
DLP Events API Endpoints
Query, filter, and manage DLP events
"""

from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Query, HTTPException, status, Request
from pydantic import BaseModel, Field
import structlog

from app.core.security import get_current_user, require_role
from app.core.database import get_mongodb
from app.services.event_processor import get_event_processor

logger = structlog.get_logger()
router = APIRouter()


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
    detected_content: Optional[str] = Field(None, description="Summary of detected sensitive content")
    action: Optional[str] = Field(None, description="Action taken (logged, blocked, alerted, etc.)")
    destination: Optional[str] = Field(None, description="Destination path for transfers")
    destination_type: Optional[str] = Field(None, description="Destination type (e.g., removable_drive, network_share)")
    content: Optional[str] = Field(None, description="Raw content captured (clipboard, file snippet, etc.)")
    usb_event_type: Optional[str] = Field(None, description="USB event subtype (connect, disconnect, transfer)")
    blocked: Optional[bool] = Field(None, description="Whether action was blocked")
    event_subtype: Optional[str] = Field(None, description="Event subtype")
    description: Optional[str] = Field(None, description="Event description")
    user_email: Optional[str] = Field(None, description="User email")
    policy_version: Optional[str] = Field(None, description="Agent policy bundle version when event was generated")


class DLPEvent(BaseModel):
    id: str = ""
    title: Optional[str] = None
    timestamp: Optional[datetime] = None
    event_type: str = "unknown"
    event_subtype: Optional[str] = None
    description: Optional[str] = None
    source: str = "unknown"
    agent_id: str = "unknown"
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

    # ── Step 1: Build raw event doc (NO processing yet) ────────────────
    event_doc: Dict[str, Any] = {
        "id": event.event_id,
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
        "processing_status": "pending",
    }

    if event.event_subtype:
        event_doc["event_subtype"] = event.event_subtype
    if event.description:
        event_doc["description"] = event.description

    # ── Step 2: Atomic upsert into MongoDB (fast, <5ms) ────────────────
    result = await events_collection.update_one(
        {"id": event.event_id},
        {"$setOnInsert": event_doc},
        upsert=True,
    )
    if result.matched_count > 0:
        return {"status": "duplicate", "event_id": event.event_id}

    # ── Step 3: Queue background processing ────────────────────────────
    background_tasks.add_task(
        _process_event_background,
        event_id=event.event_id,
        payload=_build_processor_payload(event),
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

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            processor = get_event_processor()
            processed = await processor.process_event(payload)

            # Update the raw event doc with processing results
            update_fields: Dict[str, Any] = {
                "processing_status": "completed",
                "processed_at": datetime.now(timezone.utc),
            }

            # Merge processed results
            if processed.get("event"):
                ev = processed["event"]
                if ev.get("severity"):
                    update_fields["severity"] = ev["severity"]
                if ev.get("action"):
                    update_fields["action_taken"] = ev["action"]

            if processed.get("blocked"):
                update_fields["blocked"] = True
            if processed.get("quarantined"):
                update_fields["quarantined"] = True
            if processed.get("classification_metadata"):
                update_fields["classification_metadata"] = processed["classification_metadata"]
                cm = processed["classification_metadata"]
                if cm.get("classification_level"):
                    update_fields["classification_level"] = cm["classification_level"]
                if cm.get("confidence_score") is not None:
                    update_fields["classification_score"] = cm["confidence_score"]
            if processed.get("matched_policies"):
                update_fields["matched_policies"] = processed["matched_policies"]
            if processed.get("metadata"):
                update_fields["metadata"] = processed["metadata"]

            await events_collection.update_one(
                {"id": event_id},
                {"$set": update_fields},
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
    search: Optional[str] = Query(None, description="Search keyword for filtering events"),
    start_time: Optional[datetime] = Query(
        None,
        description="Filter events with timestamp >= this ISO datetime (UTC)",
    ),
    end_time: Optional[datetime] = Query(
        None,
        description="Filter events with timestamp <= this ISO datetime (UTC)",
    ),
    current_user=Depends(get_current_user),
):
    """
    Get DLP events with pagination and filtering.

    Supports:
    - severity filter
    - source filter
    - search keyword (searches in event_type, description, file_path, destination, etc.)
    - time range via start_time / end_time
    """
    db = get_mongodb()

    # Build query filter
    query_filter: Dict[str, Any] = {}
    if severity:
        query_filter["severity"] = severity
    if source:
        query_filter["source"] = source
    if search:
        # Perform case-insensitive text search across multiple fields
        search_pattern = {"$regex": search, "$options": "i"}
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
    if start_time or end_time:
        time_filter: Dict[str, Any] = {}
        if start_time:
            time_filter["$gte"] = start_time
        if end_time:
            time_filter["$lte"] = end_time
        query_filter["timestamp"] = time_filter

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

    # Get total count for pagination
    total = await db.dlp_events.count_documents(query_filter)

    logger.info(
        "Events queried",
        user=getattr(current_user, "email", None),
        count=len(events),
        total=total,
        filters=query_filter,
    )

    return {
        "events": events,
        "total": total,
        "skip": skip,
        "limit": limit,
    }


@router.get("/{event_id}", response_model=DLPEvent)
async def get_event(
    event_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Get specific DLP event by ID
    """
    db = get_mongodb()
    event = await db.dlp_events.find_one({"id": event_id})

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    return event


@router.get("/stats/summary")
async def get_event_stats(
    current_user: dict = Depends(get_current_user),
):
    """
    Get event statistics summary
    """
    db = get_mongodb()

    # Aggregate statistics
    total_events = await db.dlp_events.count_documents({})
    blocked_events = await db.dlp_events.count_documents({"blocked": True})

    # Events by severity
    severity_pipeline = [
        {"$group": {"_id": "$severity", "count": {"$sum": 1}}}
    ]
    severity_stats = await db.dlp_events.aggregate(severity_pipeline).to_list(None)

    # Events by source
    source_pipeline = [
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
    current_user: dict = Depends(get_current_user),
):
    """
    Get events grouped by type for dashboard charts
    """
    db = get_mongodb()

    # Aggregate events by event_type
    pipeline = [
        {"$group": {"_id": "$event_type", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}
    ]
    
    type_stats = await db.dlp_events.aggregate(pipeline).to_list(None)
    
    # Format for chart component
    return [
        {"type": item["_id"] or "unknown", "count": item["count"]}
        for item in type_stats
    ]


@router.get("/stats/by-severity")
async def get_events_by_severity(
    current_user: dict = Depends(get_current_user),
):
    """
    Get events grouped by severity for dashboard charts
    """
    db = get_mongodb()

    # Aggregate events by severity
    pipeline = [
        {"$group": {"_id": "$severity", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}
    ]
    
    severity_stats = await db.dlp_events.aggregate(pipeline).to_list(None)
    
    # Format for chart component
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
