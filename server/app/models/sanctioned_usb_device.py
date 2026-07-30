"""
Sanctioned USB devices — the allowlist of storage devices permitted on
endpoints.

Enforcement posture is STRICT ALLOWLIST (default-deny): when USB device control
is enabled (a usb_device_control policy), a removable storage device is allowed
only if it matches an enabled row here; every other device is blocked. A row
matches on its ``match_type`` — ``serial`` (a single device), ``manufacturer``
(a whole vendor), ``device_id`` ("vid:pid", a model/type) or ``model`` (product
name) — against ``match_value``. A device is authorized iff it matches ANY
enabled row on that row's attribute.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, String, Boolean, DateTime
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class SanctionedUsbDevice(Base):
    __tablename__ = "sanctioned_usb_devices"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # How this exception matches a connected device:
    #   serial       -> match_value == device serial number (default, unique device)
    #   manufacturer -> match_value == device manufacturer  (a whole vendor)
    #   device_id    -> match_value == "vid:pid"            (a device model/type)
    #   model        -> match_value == device product name  (a model by name)
    # A device is authorized iff it matches ANY enabled row on that row's attribute.
    match_type = Column(String(20), nullable=False, default="serial", server_default="serial")
    match_value = Column(String(255), nullable=True)
    # allow  -> sanctioned (permitted when device control is enforced)
    # deny   -> explicitly disallowed; overrides any matching allow row.
    decision = Column(String(10), nullable=False, default="allow", server_default="allow")
    # Optional friendly name so an admin can identify the device at a glance.
    alias = Column(String(255), nullable=True)
    # serial_number is now just one possible match attribute (nullable for the
    # manufacturer/device_id/model exception types); kept for display too.
    serial_number = Column(String(255), nullable=True)
    label = Column(String(255), nullable=True)          # e.g. "Finance dept #3"
    # Captured for display / enrolment context.
    vendor_id = Column(String(16), nullable=True)
    product_id = Column(String(16), nullable=True)
    product_name = Column(String(255), nullable=True)
    manufacturer = Column(String(255), nullable=True)
    # Lets an admin suspend an approval without deleting the enrolment history.
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    notes = Column(String(1000), nullable=True)
    approved_by = Column(UUID(as_uuid=True), nullable=True)
    approved_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)

    def __repr__(self):
        return f"<SanctionedUsbDevice {self.serial_number} enabled={self.is_enabled}>"
