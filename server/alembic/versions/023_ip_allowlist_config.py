"""Global master switch for the IP allowlist.

Adds the singleton ``ip_allowlist_config`` table (id=1, is_enabled). When the
switch is off the IPAllowlistMiddleware skips enforcement entirely and the
portal is reachable from any IP, while the configured CIDR entries are kept.
Defaults to enabled (whitelisting on), and a missing row is treated as on, so
existing installs keep their current behavior.

Idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 023_ip_allowlist_config
Revises: 022_ioc_threat_intel
"""
from alembic import op
import sqlalchemy as sa


revision = "023_ip_allowlist_config"
down_revision = "022_ioc_threat_intel"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS ip_allowlist_config (
            id          INTEGER PRIMARY KEY DEFAULT 1,
            is_enabled  BOOLEAN NOT NULL DEFAULT true,
            updated_by  UUID,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT ck_ip_allowlist_config_singleton CHECK (id = 1)
        )
        """
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP TABLE IF EXISTS ip_allowlist_config"))
