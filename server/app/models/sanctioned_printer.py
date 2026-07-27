"""
Sanctioned printers — the allowlist of printers permitted on endpoints.

Used when a printer_control policy runs in scope "allowlist": a print job is
allowed only if its printer NAME matches an enabled row here; every other printer
is blocked. Printers are matched on ``printer_name`` (that is what the endpoint
reports at print time). printer_type (local/network) is captured for display.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, String, Boolean, DateTime
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class SanctionedPrinter(Base):
    __tablename__ = "sanctioned_printers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The match key — the printer name as reported by the endpoint.
    printer_name = Column(String(500), nullable=False, unique=True)
    label = Column(String(255), nullable=True)
    printer_type = Column(String(20), nullable=True)   # local | network | unknown
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    notes = Column(String(1000), nullable=True)
    approved_by = Column(UUID(as_uuid=True), nullable=True)
    approved_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)

    def __repr__(self):
        return f"<SanctionedPrinter {self.printer_name} enabled={self.is_enabled}>"
