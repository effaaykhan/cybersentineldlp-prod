"""
Incident Database Model (PostgreSQL)
Represents security incidents escalated from DLP events
"""

from datetime import datetime
from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class Incident(Base):
    __tablename__ = "incidents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id = Column(String(64), ForeignKey("events.event_id", ondelete="SET NULL"), nullable=True, index=True)
    severity = Column(Integer, nullable=False, default=1)  # 0=info, 1=low, 2=medium, 3=high, 4=critical
    status = Column(String(30), nullable=False, default="open", index=True)  # open, investigating, resolved
    assigned_to = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    title = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    policy_id = Column(UUID(as_uuid=True), ForeignKey("policies.id", ondelete="SET NULL"), nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    event = relationship("Event", backref="incidents", foreign_keys=[event_id])
    assignee = relationship("User", backref="assigned_incidents", foreign_keys=[assigned_to])
    policy = relationship("Policy", backref="incidents", foreign_keys=[policy_id])

    __table_args__ = (
        Index("idx_incidents_severity_status", "severity", "status"),
    )

    def __repr__(self):
        return f"<Incident {self.id} - {self.severity}/{self.status}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "event_id": self.event_id,
            "severity": self.severity,
            "status": self.status,
            "assigned_to": str(self.assigned_to) if self.assigned_to else None,
            "title": self.title,
            "description": self.description,
            "policy_id": str(self.policy_id) if self.policy_id else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
