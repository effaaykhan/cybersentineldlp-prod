"""
Dismissed USB devices — serials removed from the "seen on endpoints" triage
queue without being allowed or denied.

The seen list is derived from usb events, so its entries are observations, not
rows: there is nothing to delete. Every device an endpoint has ever reported
stays in it until someone makes a decision, which is correct for enrolment and
useless once the queue fills with devices nobody intends to rule on (a
one-off contractor's phone, a test stick, a card reader that will never carry
data).

Dismissing records "I have seen this and do not intend to enrol it", so the
queue shows what still needs attention. It is bookkeeping, NOT policy:

* It does NOT authorise the device. Under a usb_device_control policy the
  posture is strict allowlist, so a dismissed device with no allow row is still
  blocked exactly as before.
* It does NOT stop monitoring. The device keeps generating events, violations
  and alerts.
* It is reversible — restoring puts the device straight back in the queue, and
  nothing about the event history is touched.

Deleting the underlying events was the other way to clear the list, and it is
the wrong one: it would destroy the audit trail of a device that was, at some
point, plugged into a corporate endpoint.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, String, DateTime
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class DismissedUsbDevice(Base):
    __tablename__ = "dismissed_usb_devices"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The match key — same serial the seen list is grouped by.
    serial_number = Column(String(255), nullable=False, unique=True, index=True)
    # Kept for display so the dismissed list is readable without re-querying
    # events (a dismissed device may stop appearing in recent events entirely).
    product_name = Column(String(255), nullable=True)
    manufacturer = Column(String(255), nullable=True)
    note = Column(String(1000), nullable=True)
    dismissed_by = Column(UUID(as_uuid=True), nullable=True)
    dismissed_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)

    def __repr__(self):
        return f"<DismissedUsbDevice {self.serial_number}>"
