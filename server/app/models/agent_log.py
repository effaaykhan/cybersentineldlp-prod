"""
Agent Log Database Model (PostgreSQL)
Raw event logs from endpoint agents
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class AgentLog(Base):
    __tablename__ = "agent_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    endpoint_id = Column(UUID(as_uuid=True), ForeignKey("endpoints.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(50), nullable=False, index=True)
    raw_data = Column(JSONB, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    # Relationships
    endpoint = relationship("Endpoint", backref="agent_logs", foreign_keys=[endpoint_id])

    __table_args__ = (
        Index("idx_agent_logs_endpoint_created", "endpoint_id", "created_at"),
    )

    def __repr__(self):
        return f"<AgentLog {self.event_type} @ {self.endpoint_id}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "endpoint_id": str(self.endpoint_id),
            "event_type": self.event_type,
            "raw_data": self.raw_data,
            "created_at": self.created_at.isoformat(),
        }
