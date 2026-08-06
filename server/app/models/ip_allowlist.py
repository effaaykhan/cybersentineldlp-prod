"""
IP allowlist — authorized source networks for the admin portal.

When the table has one or more **enabled** entries, the IP-allowlist
middleware permits only requests whose real client IP falls within one of the
CIDRs (plus loopback, always). An empty/all-disabled table means the control
is off (fail-open). Agent-ingestion endpoints are always exempt so endpoints
keep reporting from any network.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, String, Boolean, DateTime, Integer, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class IPAllowlistConfig(Base):
    """Global master switch for the IP allowlist (singleton row, id=1).

    Independent of the individual CIDR entries: when ``is_enabled`` is False the
    middleware skips allowlist enforcement entirely and the portal is reachable
    from any IP — the configured ranges are preserved but dormant, so the admin
    can turn whitelisting off and back on without re-entering their networks.

    Defaults to True (enforcement on). When no row exists the middleware and API
    treat the control as **on**, so existing installs keep their current
    behavior after this table is introduced.
    """
    __tablename__ = "ip_allowlist_config"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_ip_allowlist_config_singleton"),
    )

    id = Column(Integer, primary_key=True, default=1)
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    updated_by = Column(UUID(as_uuid=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    def __repr__(self):
        return f"<IPAllowlistConfig enabled={self.is_enabled}>"


class IPAllowlistEntry(Base):
    __tablename__ = "ip_allowlist"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # A single IP (e.g. 203.0.113.7) or a CIDR range (e.g. 203.0.113.0/24).
    cidr = Column(String(64), nullable=False, unique=True)
    label = Column(String(255), nullable=True)
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)

    def __repr__(self):
        return f"<IPAllowlistEntry {self.cidr} enabled={self.is_enabled}>"
