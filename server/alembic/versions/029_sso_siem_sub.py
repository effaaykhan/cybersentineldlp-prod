"""Key SSO accounts on the SIEM's immutable user id instead of email.

Adds ``users.siem_sub`` plus a unique index.

Email is a display attribute that people change — surname changes, a domain
migration, a typo correction. Keyed on email, any of those orphans the DLP
account: the next SSO login finds nothing, provisions a SECOND account, and
the original's audit history, saved views and role are attached to a user who
can no longer reach them. Nothing errors, so nobody notices until someone asks
why an analyst's history is empty.

``sub`` is the SIEM's own identifier for the human and does not change, so it
is the correct key. Email stays on the record and is now kept in step FROM the
token rather than being the thing looked up.

NULLABLE and backfilled lazily: accounts created locally have no SIEM identity
at all, and existing SSO accounts adopt their sub on the first login that
presents one (see /auth/sso/exchange). Nothing has to be migrated ahead of
time and no account is touched until its owner next logs in.

UNIQUE so two DLP accounts can never claim the same SIEM identity. Partial —
NULL is not "the same as" another NULL here, and every local account is NULL.

Idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 029_sso_siem_sub
Revises: 028_app_catalog
"""
from alembic import op


revision = "029_sso_siem_sub"
down_revision = "028_app_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS siem_sub VARCHAR(255)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_siem_sub "
        "ON users (siem_sub) WHERE siem_sub IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_siem_sub")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS siem_sub")
