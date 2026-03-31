"""
Data Label Database Model (PostgreSQL)
Classification labels used to tag sensitive data
"""

from datetime import datetime
from sqlalchemy import Column, String, Integer, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


class DataLabel(Base):
    __tablename__ = "data_labels"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), unique=True, nullable=False, index=True)  # Public, Confidential, Restricted
    severity = Column(Integer, nullable=False, default=0)  # 0=low, 1=medium, 2=high, 3=critical
    description = Column(Text, nullable=True)
    color = Column(String(20), nullable=True)  # hex color code e.g. #FF0000

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<DataLabel {self.name}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "name": self.name,
            "severity": self.severity,
            "description": self.description,
            "color": self.color,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
