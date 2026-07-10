"""Threat-intel IOC store + TAXII feed config.

- iocs        (indicators; ingested / internal; opt-in shareable)
- taxii_feeds (remote TAXII 2.1 collections we poll)

Idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 022_ioc_threat_intel
Revises: 021_siem_connectors
"""
from alembic import op
import sqlalchemy as sa


revision = "022_ioc_threat_intel"
down_revision = "021_siem_connectors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS iocs (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            stix_id      VARCHAR(255) UNIQUE,
            ioc_type     VARCHAR(24)  NOT NULL,
            value        VARCHAR(2048) NOT NULL,
            pattern      TEXT,
            name         VARCHAR(512),
            description  TEXT,
            labels       JSONB,
            confidence   INTEGER,
            tlp          VARCHAR(8) DEFAULT 'amber',
            valid_from   TIMESTAMPTZ,
            valid_until  TIMESTAMPTZ,
            source       VARCHAR(255),
            direction    VARCHAR(16) NOT NULL DEFAULT 'ingested',
            external_id  VARCHAR(255),
            is_shared    BOOLEAN NOT NULL DEFAULT false,
            is_active    BOOLEAN NOT NULL DEFAULT true,
            created_by   UUID,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_ioc_type_value UNIQUE (ioc_type, value)
        )
        """
    ))
    bind.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_iocs_value ON iocs (value)"))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_iocs_active_shared ON iocs (is_active, is_shared)"
    ))

    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS taxii_feeds (
            id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name           VARCHAR(128) NOT NULL UNIQUE,
            server_url     VARCHAR(1024) NOT NULL,
            collection_id  VARCHAR(255),
            username       VARCHAR(255),
            secrets_enc    TEXT,
            poll_enabled   BOOLEAN NOT NULL DEFAULT true,
            last_polled_at TIMESTAMPTZ,
            last_status    VARCHAR(512),
            total_imported INTEGER NOT NULL DEFAULT 0,
            created_by     UUID,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP TABLE IF EXISTS taxii_feeds"))
    bind.execute(sa.text("DROP TABLE IF EXISTS iocs"))
