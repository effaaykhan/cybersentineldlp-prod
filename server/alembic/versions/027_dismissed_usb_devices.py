"""Let a seen-but-unruled USB device be cleared from the triage queue.

Adds the ``dismissed_usb_devices`` table.

The "seen on endpoints" list is derived from usb events, so its rows are
observations — there is nothing to delete. Every device ever reported stays in
the queue until someone allows or denies it, which is right for enrolment and
useless once it fills with devices nobody intends to rule on.

Dismissing is bookkeeping, not policy: it does not authorise the device (strict
allowlist still blocks it), does not stop monitoring, and is reversible. The
alternative — deleting the underlying events — would destroy the audit trail of
a device that was plugged into a corporate endpoint, so it is deliberately not
what this does.

Idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 027_dismissed_usb_devices
Revises: 026_printer_decision
"""
from alembic import op
import sqlalchemy as sa


revision = "027_dismissed_usb_devices"
down_revision = "026_printer_decision"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS dismissed_usb_devices (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            serial_number VARCHAR(255) NOT NULL UNIQUE,
            product_name  VARCHAR(255),
            manufacturer  VARCHAR(255),
            note          VARCHAR(1000),
            dismissed_by  UUID,
            dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_dismissed_usb_devices_serial "
        "ON dismissed_usb_devices (serial_number)"
    ))


def downgrade() -> None:
    op.get_bind().execute(sa.text("DROP TABLE IF EXISTS dismissed_usb_devices"))
