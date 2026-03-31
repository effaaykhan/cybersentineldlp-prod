"""
Incident Service - Business logic for DLP incident management
"""

from typing import Optional, List
from uuid import UUID
from datetime import datetime

from sqlalchemy import select, and_, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.incident import Incident
from app.models.incident_comment import IncidentComment


class IncidentService:
    """Service for incident-related operations"""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_incident(
        self,
        event_id: Optional[str] = None,
        severity: int = 2,
        title: Optional[str] = None,
        description: Optional[str] = None,
        policy_id: Optional[UUID] = None,
        assigned_to: Optional[UUID] = None,
    ) -> Incident:
        """
        Create a new incident

        Args:
            event_id: Related event ID
            severity: Severity level (0=info, 1=low, 2=medium, 3=high, 4=critical)
            title: Incident title
            description: Incident description
            policy_id: Related policy ID
            assigned_to: User UUID to assign to

        Returns:
            Created Incident object
        """
        incident = Incident(
            event_id=event_id,
            severity=severity,
            title=title,
            description=description,
            policy_id=policy_id,
            assigned_to=assigned_to,
            status="open",
        )

        self.db.add(incident)
        await self.db.flush()
        await self.db.refresh(incident)

        return incident

    async def get_incident(self, incident_id: UUID) -> Optional[Incident]:
        """
        Fetch a single incident by ID

        Args:
            incident_id: UUID of the incident

        Returns:
            Incident object or None if not found
        """
        result = await self.db.execute(
            select(Incident).where(Incident.id == incident_id)
        )
        return result.scalar_one_or_none()

    async def list_incidents(
        self,
        skip: int = 0,
        limit: int = 50,
        severity: Optional[int] = None,
        status: Optional[str] = None,
        assigned_to: Optional[UUID] = None,
    ) -> List[Incident]:
        """
        Fetch incidents with optional filtering

        Args:
            skip: Number of records to skip
            limit: Maximum number of records to return
            severity: Filter by severity level
            status: Filter by status string
            assigned_to: Filter by assigned user UUID

        Returns:
            List of Incident objects
        """
        query = select(Incident)

        filters = []
        if severity is not None:
            filters.append(Incident.severity == severity)
        if status is not None:
            filters.append(Incident.status == status)
        if assigned_to is not None:
            filters.append(Incident.assigned_to == assigned_to)

        if filters:
            query = query.where(and_(*filters))

        query = query.offset(skip).limit(limit).order_by(Incident.created_at.desc())

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def update_incident(
        self,
        incident_id: UUID,
        status: Optional[str] = None,
        assigned_to: Optional[UUID] = None,
    ) -> Optional[Incident]:
        """
        Update incident status and/or assignment

        Args:
            incident_id: UUID of the incident
            status: New status value
            assigned_to: New assignee UUID

        Returns:
            Updated Incident object or None if not found
        """
        incident = await self.get_incident(incident_id)
        if not incident:
            return None

        if status is not None:
            incident.status = status
        if assigned_to is not None:
            incident.assigned_to = assigned_to
        incident.updated_at = datetime.utcnow()

        await self.db.flush()
        await self.db.refresh(incident)
        return incident

    async def add_comment(
        self,
        incident_id: UUID,
        user_id: Optional[UUID],
        comment_text: str,
    ) -> IncidentComment:
        """
        Add a comment to an incident

        Args:
            incident_id: UUID of the incident
            user_id: UUID of the commenting user
            comment_text: Comment body

        Returns:
            Created IncidentComment object
        """
        comment = IncidentComment(
            incident_id=incident_id,
            user_id=user_id,
            comment=comment_text,
        )

        self.db.add(comment)
        await self.db.flush()
        await self.db.refresh(comment)

        return comment

    async def get_comments(self, incident_id: UUID) -> List[IncidentComment]:
        """
        Get all comments for an incident

        Args:
            incident_id: UUID of the incident

        Returns:
            List of IncidentComment objects ordered by creation time
        """
        result = await self.db.execute(
            select(IncidentComment)
            .where(IncidentComment.incident_id == incident_id)
            .order_by(IncidentComment.created_at.asc())
        )
        return list(result.scalars().all())

    async def get_statistics(self) -> dict:
        """
        Get incident statistics: counts by status and severity

        Returns:
            Dictionary with status_counts and severity_counts
        """
        # Counts by status
        status_query = (
            select(Incident.status, func.count(Incident.id))
            .group_by(Incident.status)
        )
        status_result = await self.db.execute(status_query)
        status_counts = {row[0]: row[1] for row in status_result.all()}

        # Counts by severity
        severity_query = (
            select(Incident.severity, func.count(Incident.id))
            .group_by(Incident.severity)
        )
        severity_result = await self.db.execute(severity_query)
        severity_counts = {row[0]: row[1] for row in severity_result.all()}

        total = sum(status_counts.values())

        return {
            "total": total,
            "status_counts": status_counts,
            "severity_counts": severity_counts,
        }

    async def count_incidents(
        self,
        severity: Optional[int] = None,
        status: Optional[str] = None,
        assigned_to: Optional[UUID] = None,
    ) -> int:
        """
        Count incidents with optional filters

        Args:
            severity: Filter by severity level
            status: Filter by status string
            assigned_to: Filter by assigned user UUID

        Returns:
            Number of matching incidents
        """
        query = select(func.count(Incident.id))

        filters = []
        if severity is not None:
            filters.append(Incident.severity == severity)
        if status is not None:
            filters.append(Incident.status == status)
        if assigned_to is not None:
            filters.append(Incident.assigned_to == assigned_to)

        if filters:
            query = query.where(and_(*filters))

        result = await self.db.execute(query)
        return result.scalar_one()
