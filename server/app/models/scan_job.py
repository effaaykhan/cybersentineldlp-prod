"""
Scan Job Database Model (PostgreSQL)
Data discovery scan jobs
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, Text, Index
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


class ScanJob(Base):
    __tablename__ = "scan_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    target = Column(Text, nullable=False)  # endpoint/db/path
    status = Column(String(30), nullable=False, default="pending", index=True)  # pending, running, completed, failed
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("idx_scan_jobs_status_created", "status", "created_at"),
    )

    def __repr__(self):
        return f"<ScanJob {self.id} target={self.target} status={self.status}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "target": self.target,
            "status": self.status,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "created_at": self.created_at.isoformat(),
        }
