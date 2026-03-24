"""
Rule Database Model (PostgreSQL)
Manages detection rules for data classification
"""

from datetime import datetime
from sqlalchemy import Column, String, Boolean, DateTime, Integer, JSON, Text, Float
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


class Rule(Base):
    """
    Detection Rule Model

    Supports three types:
    - regex: Pattern-based detection
    - keyword: Keyword matching
    - dictionary: External wordlist matching
    """
    __tablename__ = "rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False, unique=True)
    description = Column(Text, nullable=True)
    enabled = Column(Boolean, default=True, nullable=False)

    # Rule type: 'regex', 'keyword', 'dictionary'
    type = Column(String(20), nullable=False)

    # For regex rules
    pattern = Column(Text, nullable=True)
    regex_flags = Column(JSON, nullable=True)  # e.g., ['IGNORECASE', 'MULTILINE']

    # For keyword rules
    keywords = Column(JSON, nullable=True)  # List of keywords
    case_sensitive = Column(Boolean, default=False, nullable=True)

    # For dictionary rules
    dictionary_path = Column(String(500), nullable=True)
    dictionary_hash = Column(String(64), nullable=True)  # SHA256 of dictionary file

    # Detection configuration
    threshold = Column(Integer, default=1, nullable=False)  # Minimum matches required
    weight = Column(Float, default=0.5, nullable=False)  # Weight for confidence scoring (0.0 - 1.0)

    # Classification impact
    classification_labels = Column(JSON, nullable=True)  # e.g., ['PII', 'FINANCIAL', 'CONFIDENTIAL']
    severity = Column(String(20), nullable=True)  # 'low', 'medium', 'high', 'critical'

    # Metadata
    category = Column(String(100), nullable=True)  # e.g., 'PII', 'Financial', 'Healthcare', 'Source Code'
    tags = Column(JSON, nullable=True)

    # Audit fields
    created_by = Column(UUID(as_uuid=True), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Statistics
    match_count = Column(Integer, default=0, nullable=False)  # Total matches
    last_matched_at = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<Rule {self.name} ({self.type})>"

    def to_dict(self):
        """Convert rule to dictionary format"""
        return {
            "id": str(self.id),
            "name": self.name,
            "description": self.description,
            "enabled": self.enabled,
            "type": self.type,
            "pattern": self.pattern,
            "regex_flags": self.regex_flags,
            "keywords": self.keywords,
            "case_sensitive": self.case_sensitive,
            "dictionary_path": self.dictionary_path,
            "dictionary_hash": self.dictionary_hash,
            "threshold": self.threshold,
            "weight": self.weight,
            "classification_labels": self.classification_labels,
            "severity": self.severity,
            "category": self.category,
            "tags": self.tags,
            "created_by": str(self.created_by),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "match_count": self.match_count,
            "last_matched_at": self.last_matched_at.isoformat() if self.last_matched_at else None,
        }
