"""
Device Database Model (PostgreSQL)
Represents physical/virtual devices monitored by DLP agents
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class Device(Base):
    __tablename__ = "devices"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hostname = Column(String(255), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    os = Column(String(100), nullable=False)  # windows, linux, macos
    agent_version = Column(String(50), nullable=True)
    status = Column(String(30), nullable=False, default="inactive")  # active, inactive, compromised, decommissioned

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", backref="devices", foreign_keys=[user_id])

    def __repr__(self):
        return f"<Device {self.hostname}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "hostname": self.hostname,
            "user_id": str(self.user_id) if self.user_id else None,
            "os": self.os,
            "agent_version": self.agent_version,
            "status": self.status,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
