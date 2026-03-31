"""
Incidents API Endpoints
Security incident management and tracking
"""

from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.core.security import get_current_user
from app.core.database import get_db
from app.services.incident_service import IncidentService

logger = structlog.get_logger()
router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class IncidentCreate(BaseModel):
    event_id: Optional[str] = None
    severity: int = Field(default=2, ge=0, le=4, description="0=info, 1=low, 2=medium, 3=high, 4=critical")
    title: Optional[str] = Field(default=None, max_length=500)
    description: Optional[str] = None
    policy_id: Optional[UUID] = None


class IncidentUpdate(BaseModel):
    status: Optional[str] = Field(default=None, description="open, investigating, resolved, closed")
    assigned_to: Optional[UUID] = None


class CommentCreate(BaseModel):
    comment: str = Field(..., min_length=1)


class CommentOut(BaseModel):
    id: str
    incident_id: str
    user_id: Optional[str] = None
    comment: str
    created_at: datetime

    class Config:
        from_attributes = True


class IncidentOut(BaseModel):
    id: str
    event_id: Optional[str] = None
    severity: int
    status: str
    assigned_to: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    policy_id: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class IncidentDetailOut(IncidentOut):
    comments: List[CommentOut] = []


class IncidentListResponse(BaseModel):
    incidents: List[IncidentOut]
    total: int


class IncidentStatisticsResponse(BaseModel):
    total: int
    status_counts: dict
    severity_counts: dict


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _incident_to_out(incident: Any) -> IncidentOut:
    d = incident.to_dict()
    return IncidentOut(
        id=d["id"],
        event_id=d["event_id"],
        severity=d["severity"],
        status=d["status"],
        assigned_to=d["assigned_to"],
        title=d["title"],
        description=d["description"],
        policy_id=d["policy_id"],
        created_at=incident.created_at,
        updated_at=incident.updated_at,
    )


def _comment_to_out(comment: Any) -> CommentOut:
    d = comment.to_dict()
    return CommentOut(
        id=d["id"],
        incident_id=d["incident_id"],
        user_id=d["user_id"],
        comment=d["comment"],
        created_at=comment.created_at,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/", response_model=IncidentListResponse)
async def list_incidents(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    severity: Optional[int] = Query(None, ge=0, le=4),
    status: Optional[str] = Query(None),
    assigned_to: Optional[UUID] = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List incidents with optional filtering"""
    svc = IncidentService(db)
    incidents = await svc.list_incidents(
        skip=skip,
        limit=limit,
        severity=severity,
        status=status,
        assigned_to=assigned_to,
    )
    total = await svc.count_incidents(
        severity=severity,
        status=status,
        assigned_to=assigned_to,
    )
    return IncidentListResponse(
        incidents=[_incident_to_out(i) for i in incidents],
        total=total,
    )


@router.get("/statistics", response_model=IncidentStatisticsResponse)
async def get_statistics(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get incident statistics (counts by status and severity)"""
    svc = IncidentService(db)
    stats = await svc.get_statistics()
    return IncidentStatisticsResponse(**stats)


@router.get("/{incident_id}", response_model=IncidentDetailOut)
async def get_incident(
    incident_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a single incident with its comments"""
    svc = IncidentService(db)
    incident = await svc.get_incident(incident_id)
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")

    comments = await svc.get_comments(incident_id)

    out = IncidentDetailOut(
        **_incident_to_out(incident).model_dump(),
        comments=[_comment_to_out(c) for c in comments],
    )
    return out


@router.post("/", response_model=IncidentOut, status_code=status.HTTP_201_CREATED)
async def create_incident(
    body: IncidentCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new incident"""
    svc = IncidentService(db)
    incident = await svc.create_incident(
        event_id=body.event_id,
        severity=body.severity,
        title=body.title,
        description=body.description,
        policy_id=body.policy_id,
    )
    await db.commit()
    await db.refresh(incident)

    logger.info(
        "incident_created_via_api",
        incident_id=str(incident.id),
        severity=body.severity,
    )
    return _incident_to_out(incident)


@router.patch("/{incident_id}", response_model=IncidentOut)
async def update_incident(
    incident_id: UUID,
    body: IncidentUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update incident status and/or assignment"""
    svc = IncidentService(db)
    incident = await svc.update_incident(
        incident_id=incident_id,
        status=body.status,
        assigned_to=body.assigned_to,
    )
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")

    await db.commit()
    await db.refresh(incident)

    logger.info(
        "incident_updated_via_api",
        incident_id=str(incident_id),
        new_status=body.status,
    )
    return _incident_to_out(incident)


@router.post("/{incident_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def add_comment(
    incident_id: UUID,
    body: CommentCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a comment to an incident"""
    svc = IncidentService(db)

    # Verify the incident exists
    incident = await svc.get_incident(incident_id)
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")

    user_id = current_user.get("id") or current_user.get("user_id")
    comment = await svc.add_comment(
        incident_id=incident_id,
        user_id=user_id,
        comment_text=body.comment,
    )
    await db.commit()
    await db.refresh(comment)

    return _comment_to_out(comment)


@router.get("/{incident_id}/comments", response_model=List[CommentOut])
async def list_comments(
    incident_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all comments for an incident"""
    svc = IncidentService(db)

    # Verify the incident exists
    incident = await svc.get_incident(incident_id)
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")

    comments = await svc.get_comments(incident_id)
    return [_comment_to_out(c) for c in comments]
