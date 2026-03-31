"""
Endpoint Database Model (PostgreSQL)
Consolidates physical/virtual device + DLP agent into a single entity
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID, INET
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class Endpoint(Base):
    __tablename__ = "endpoints"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hostname = Column(String(255), nullable=False, index=True)
    ip_address = Column(String(45), nullable=True)
    os = Column(String(100), nullable=False)
    agent_version = Column(String(50), nullable=True)
    status = Column(String(20), nullable=False, default="offline")  # online, offline
    last_seen = Column(DateTime, nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", backref="endpoints", foreign_keys=[user_id])

    __table_args__ = (
        Index("idx_endpoints_status_last_seen", "status", "last_seen"),
    )

    def __repr__(self):
        return f"<Endpoint {self.hostname}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "hostname": self.hostname,
            "ip_address": self.ip_address,
            "os": self.os,
            "agent_version": self.agent_version,
            "status": self.status,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "user_id": str(self.user_id) if self.user_id else None,
            "created_at": self.created_at.isoformat(),
        }
