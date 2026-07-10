"""Native MFA (TOTP) columns on users + IP allowlist table.

- users.mfa_enabled / mfa_secret / mfa_recovery_codes / mfa_enrolled_at
- ip_allowlist (cidr, label, is_enabled, created_by, created_at)

All idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 020_mfa_and_ip_allowlist
Revises: 019_policy_domains_rbac
"""
from alembic import op
import sqlalchemy as sa


revision = "020_mfa_and_ip_allowlist"
down_revision = "019_policy_domains_rbac"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # ── MFA columns on users ─────────────────────────────────────────
    bind.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false"
    ))
    bind.execute(sa.text("ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT"))
    bind.execute(sa.text("ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes JSONB"))
    bind.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ"
    ))

    # ── IP allowlist table ───────────────────────────────────────────
    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS ip_allowlist (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            cidr        VARCHAR(64) NOT NULL UNIQUE,
            label       VARCHAR(255),
            is_enabled  BOOLEAN NOT NULL DEFAULT true,
            created_by  UUID,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP TABLE IF EXISTS ip_allowlist"))
    for col in ("mfa_enrolled_at", "mfa_recovery_codes", "mfa_secret", "mfa_enabled"):
        bind.execute(sa.text(f"ALTER TABLE users DROP COLUMN IF EXISTS {col}"))
