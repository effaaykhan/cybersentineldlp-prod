"""Track which accounts the SIEM owns, so SSO can propagate role + ABAC attrs.

Adds ``users.sso_managed`` and ``users.sso_source_role``.

Before this, every SSO account was a VIEWER: /auth/sso/exchange read only
purpose/iss/nonce/email/username and refused to provision, so the SIEM had
to pre-create accounts through an admin endpoint that hardcodes VIEWER.
The DLP now maps the SIEM's role + read-write/read-only pair onto an
existing DLP role (app/core/sso_roles.py) and can keep it in sync.

Sync must not fight the admin UI, hence the flag. Only accounts the DLP
itself provisioned from an SSO login carry sso_managed=true and get
re-synced; anything created locally — including every account that exists
today — is left alone forever. Editing an SSO account's role by hand clears
the flag, so the local decision sticks instead of reverting at next login.

No DLP role or permission is added, removed or altered by this migration.

Idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 025_sso_role_provenance
Revises: 024_view_sensitive_content
"""
from alembic import op
import sqlalchemy as sa


revision = "025_sso_role_provenance"
down_revision = "024_view_sensitive_content"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # Existing rows default to false: no account that predates this
    # migration is retroactively handed to the SIEM to overwrite.
    bind.execute(sa.text(
        """
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS sso_managed BOOLEAN NOT NULL DEFAULT false
        """
    ))
    bind.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_source_role VARCHAR(64)"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE users DROP COLUMN IF EXISTS sso_source_role"))
    bind.execute(sa.text("ALTER TABLE users DROP COLUMN IF EXISTS sso_managed"))
