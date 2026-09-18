"""
Log-retention policy (single-row config).

Holds the admin-portal-managed retention windows for end-user logs. The daily
``cleanup_old_events`` task and any log-store cleanup read the effective value
from here (falling back to the RETENTION env defaults when no row exists). A DB
CHECK plus the API enforce a hard 90-day floor so the policy can never be set
below the compliance minimum.
"""
from datetime import datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base

# Compliance floor — retention can never be configured below this.
MIN_RETENTION_DAYS = 90


class RetentionConfig(Base):
    __tablename__ = "retention_config"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_retention_singleton"),
        CheckConstraint(
            "event_retention_days >= 90 AND opensearch_retention_days >= 90",
            name="ck_retention_floor",
        ),
    )

    id = Column(Integer, primary_key=True, default=1)
    event_retention_days = Column(Integer, nullable=False, default=180, server_default="180")
    opensearch_retention_days = Column(Integer, nullable=False, default=90, server_default="90")

    # Endpoint agent log retention, delivered to agents on policy sync.
    #
    # Deliberately NOT under the 90-day compliance floor above. That floor
    # governs how long THIS server keeps evidence; these govern how much rotated
    # log an endpoint keeps on its own disk, which is an operational limit, not
    # a compliance one - a laptop holding 90 days of 10MB rotations would be
    # holding gigabytes.
    #
    # 0 means unlimited for either. Both 0 means an agent never deletes a
    # rotated log, which is the behaviour that existed before any of this and is
    # now a deliberate choice rather than an oversight.
    agent_log_retention_days = Column(Integer, nullable=False, default=14, server_default="14")
    agent_log_retention_max_files = Column(Integer, nullable=False, default=5, server_default="5")

    updated_by = Column(UUID(as_uuid=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow,
                        onupdate=datetime.utcnow, nullable=False)
