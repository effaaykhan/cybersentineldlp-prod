"""
Policy Condition Database Model (PostgreSQL)
Individual conditions that compose a policy's matching logic
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class PolicyCondition(Base):
    __tablename__ = "policy_conditions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    policy_id = Column(UUID(as_uuid=True), ForeignKey("policies.id", ondelete="CASCADE"), nullable=False, index=True)
    condition_type = Column(String(50), nullable=False)  # user, device, file_type, label, app, location
    operator = Column(String(20), nullable=True)  # equals, contains, regex, gt, lt, in, not_in
    value = Column(String(500), nullable=False)  # condition value or expression

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    policy = relationship("Policy", backref="policy_conditions_rel", foreign_keys=[policy_id])

    def __repr__(self):
        return f"<PolicyCondition {self.condition_type} {self.operator} {self.value}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "policy_id": str(self.policy_id),
            "condition_type": self.condition_type,
            "operator": self.operator,
            "value": self.value,
            "created_at": self.created_at.isoformat(),
        }
