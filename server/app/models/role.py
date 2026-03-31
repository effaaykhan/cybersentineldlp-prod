"""
Role Database Model (PostgreSQL)
RBAC roles with JSONB permissions
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid

from app.core.database import Base


class Role(Base):
    __tablename__ = "roles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(50), unique=True, nullable=False, index=True)
    permissions = Column(JSONB, nullable=True)  # {"events.read": true, "policies.write": true, ...}

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<Role {self.name}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "name": self.name,
            "permissions": self.permissions,
            "created_at": self.created_at.isoformat(),
        }
