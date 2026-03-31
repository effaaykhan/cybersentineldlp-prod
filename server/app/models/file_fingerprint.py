"""
File Fingerprint Database Model (PostgreSQL)
Known file hashes mapped to classification labels
"""

from datetime import datetime
from sqlalchemy import Column, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid

from app.core.database import Base


class FileFingerprint(Base):
    __tablename__ = "file_fingerprints"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hash = Column(String(128), nullable=False, unique=True, index=True)  # SHA-256 or similar
    file_name = Column(String(500), nullable=True)
    label_id = Column(UUID(as_uuid=True), ForeignKey("data_labels.id", ondelete="SET NULL"), nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    label = relationship("DataLabel", backref="fingerprints", foreign_keys=[label_id])

    def __repr__(self):
        return f"<FileFingerprint {self.hash[:16]}...>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "hash": self.hash,
            "file_name": self.file_name,
            "label_id": str(self.label_id) if self.label_id else None,
            "created_at": self.created_at.isoformat(),
        }
