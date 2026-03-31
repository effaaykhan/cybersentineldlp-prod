"""
Policy Action Database Model (PostgreSQL)
Actions to execute when a policy matches
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class PolicyAction(Base):
    __tablename__ = "policy_actions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    policy_id = Column(UUID(as_uuid=True), ForeignKey("policies.id", ondelete="CASCADE"), nullable=False, index=True)
    action_type = Column(String(50), nullable=False)  # block, allow, alert, encrypt, quarantine, notify
    parameters = Column(JSONB, nullable=True)  # action-specific configuration
    value = Column(String(500), nullable=True)  # simple value (legacy compat)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    policy = relationship("Policy", backref="policy_actions_rel", foreign_keys=[policy_id])

    def __repr__(self):
        return f"<PolicyAction {self.action_type}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "policy_id": str(self.policy_id),
            "action_type": self.action_type,
            "parameters": self.parameters,
            "value": self.value,
            "created_at": self.created_at.isoformat(),
        }
