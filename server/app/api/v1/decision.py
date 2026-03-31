"""
Real-time Decision API

Standalone endpoint for agent enforcement decisions.
Classify → Evaluate → Decide in a single call, targeting <100ms latency.

Also includes:
- Batch event ingestion
- Delta policy sync
"""

from typing import List, Dict, Any, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.core.database import get_db, get_mongodb
from app.services.classification_engine import ClassificationEngine
from app.policies.decision_engine import DecisionEngine

logger = structlog.get_logger()
router = APIRouter()


# ─── Request / Response Models ───────────────────────────────────────────────


class DecisionRequest(BaseModel):
    """Input for the real-time decision endpoint"""
    agent_id: str = Field(..., description="Agent identifier")
    event: Dict[str, Any] = Field(..., description="Event payload")

    class Config:
        json_schema_extra = {
            "example": {
                "agent_id": "agt-001",
                "event": {
                    "type": "USB_COPY",
                    "file_name": "data.xlsx",
                    "file_hash": "abc123",
                    "file_size": 12345,
                    "channel": "USB",
                    "content": "SSN: 123-45-6789",
                }
            }
        }


class DecisionResponse(BaseModel):
    decision: str = Field(..., description="BLOCK, ALLOW, ALERT, ENCRYPT, QUARANTINE")
    reason: str = Field(..., description="Human-readable reason")
    policy_id: Optional[str] = None
    policy_name: Optional[str] = None
    severity: Optional[str] = None
    cache_ttl: int = Field(300, description="Seconds the agent should cache this decision")
    classification_level: Optional[str] = None
    confidence_score: float = 0.0
    matched_policies: List[Dict[str, Any]] = Field(default_factory=list)
    should_log: bool = True
    should_create_incident: bool = False


class BatchEventItem(BaseModel):
    event_id: str
    event_type: str
    severity: str = "low"
    agent_id: str
    source_type: str = "agent"
    decision: Optional[str] = None
    file_path: Optional[str] = None
    file_name: Optional[str] = None
    file_hash: Optional[str] = None
    channel: Optional[str] = None
    content: Optional[str] = None
    action: str = "logged"
    timestamp: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class BatchEventRequest(BaseModel):
    events: List[BatchEventItem] = Field(..., min_length=1, max_length=500)


class BatchEventResponse(BaseModel):
    accepted: int
    rejected: int
    errors: List[Dict[str, str]] = Field(default_factory=list)


class PolicySyncResponse(BaseModel):
    version: str
    policies: List[Dict[str, Any]]
    policy_count: int
    generated_at: str
    is_delta: bool = False


# ─── Decision Endpoint (Real-time, <100ms target) ───────────────────────────


@router.post("/", response_model=DecisionResponse)
async def make_decision(
    request: DecisionRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    **Real-time enforcement decision.**

    Agent sends event context, server returns BLOCK/ALLOW/ALERT decision.
    No auth required — agents call this for every enforcement action.

    Pipeline: Classify content → Evaluate policies → Resolve conflicts → Return decision

    Target latency: <100ms
    """
    event = request.event
    content = event.get("content") or event.get("file_content", "")

    # Step 1: Classify content (if present)
    classification_level = "Public"
    confidence_score = 0.0

    if content:
        try:
            engine = ClassificationEngine(db)
            result = await engine.classify_content(content, context={
                "event_type": event.get("type"),
                "file_name": event.get("file_name"),
                "agent_id": request.agent_id,
            })
            classification_level = result.classification
            confidence_score = result.confidence_score
        except Exception as e:
            logger.warning("Classification failed in decision path", error=str(e))

    # Step 2: Build normalized event structure for policy evaluation
    eval_event = {
        "event": {"type": event.get("type", "unknown"), "severity": event.get("severity", "medium")},
        "agent": {"id": request.agent_id},
        "event_type": event.get("type", "unknown"),
        "file_name": event.get("file_name"),
        "file_path": event.get("file_path"),
        "file_hash": event.get("file_hash"),
        "file_size": event.get("file_size"),
        "channel": event.get("channel"),
        "destination_type": event.get("destination_type") or event.get("channel"),
        "source_path": event.get("source_path"),
        "classification_level": classification_level,
        "confidence_score": confidence_score,
        "classification_metadata": {
            "classification_level": classification_level,
            "confidence_score": confidence_score,
        },
    }

    # Step 3: Evaluate policies and resolve conflicts
    decision_engine = DecisionEngine()
    decision = await decision_engine.evaluate(
        eval_event,
        classification_level=classification_level,
        confidence_score=confidence_score,
    )

    return DecisionResponse(**decision.to_dict())


# ─── Batch Event Ingestion (Async) ──────────────────────────────────────────


@router.post("/events/batch", response_model=BatchEventResponse)
async def ingest_batch_events(
    request: BatchEventRequest,
):
    """
    **Batch event upload.**

    Agent batches events and sends them periodically.
    Events are stored in MongoDB with minimal processing.
    Heavy processing (classification, policy eval) happens asynchronously.
    """
    db = get_mongodb()
    events_collection = db["dlp_events"]

    accepted = 0
    rejected = 0
    errors = []

    # Prepare bulk insert
    docs = []
    for item in request.events:
        try:
            doc = {
                "event_id": item.event_id,
                "event_type": item.event_type,
                "severity": item.severity,
                "agent_id": item.agent_id,
                "source_type": item.source_type,
                "decision": item.decision,
                "file_path": item.file_path,
                "file_name": item.file_name,
                "file_hash": item.file_hash,
                "channel": item.channel,
                "action_taken": item.action,
                "timestamp": item.timestamp or datetime.utcnow().isoformat(),
                "metadata": item.metadata or {},
                "batch_ingested": True,
                "ingested_at": datetime.utcnow().isoformat(),
            }
            docs.append(doc)
            accepted += 1
        except Exception as e:
            rejected += 1
            errors.append({"event_id": item.event_id, "error": str(e)})

    if docs:
        try:
            # Use ordered=False for best throughput (continues on individual errors)
            result = await events_collection.insert_many(docs, ordered=False)
            logger.info("Batch events ingested", count=len(result.inserted_ids))
        except Exception as e:
            logger.error("Batch insert failed", error=str(e))
            # Partial failure: some may have been inserted
            rejected += accepted
            accepted = 0
            errors.append({"event_id": "batch", "error": str(e)})

    return BatchEventResponse(accepted=accepted, rejected=rejected, errors=errors)


# ─── Delta Policy Sync ──────────────────────────────────────────────────────


@router.get("/policies/sync", response_model=PolicySyncResponse)
async def sync_policies(
    agent_id: str,
    platform: str = "windows",
    current_version: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    **Delta policy sync for agents.**

    Agent sends its current policy version. Server returns:
    - If version matches: empty delta (no changes)
    - If version differs: full policy bundle

    Agents should call this periodically (e.g., every 60 seconds).
    """
    from app.services.policy_service import PolicyService
    from app.policies.agent_policy_transformer import AgentPolicyTransformer

    service = PolicyService(db)
    policies = await service.get_enabled_policies()

    transformer = AgentPolicyTransformer()
    bundle = transformer.build_bundle(
        policies,
        platform=platform,
        agent_id=agent_id,
    )

    server_version = bundle["version"]

    # Delta check: if agent already has this version, return minimal response
    if current_version and current_version == server_version:
        return PolicySyncResponse(
            version=server_version,
            policies=[],
            policy_count=0,
            generated_at=datetime.utcnow().isoformat() + "Z",
            is_delta=True,
        )

    # Full sync: flatten grouped policies into a list
    all_policies = []
    for policy_type, policy_list in bundle.get("policies", {}).items():
        for p in policy_list:
            p["policy_type"] = policy_type
            all_policies.append(p)

    return PolicySyncResponse(
        version=server_version,
        policies=all_policies,
        policy_count=len(all_policies),
        generated_at=bundle["generated_at"],
        is_delta=False,
    )
