"""App catalog — classify web destinations as webmail / cloud / collab / GenAI.

Adds the ``app_catalog`` table and seeds it from
``app.core.web_activity.DEFAULT_CATALOG``.

WHY: granular activity control needs to know *what kind of app* a destination
is. Before this the only such knowledge in the product was a 26-entry
``CLOUD_HOSTS`` array hardcoded inside the browser extension's inject.js, which
contained no generative-AI vendor at all — so data pasted into ChatGPT produced
no event of any kind. Rows here are pulled by the extension at runtime, so
adding a vendor is an INSERT rather than an extension redeploy.

Seeding is idempotent per row (ON CONFLICT DO NOTHING on host_pattern), so
re-running never clobbers an operator's edits to a built-in row and never
duplicates. Built-ins are flagged so a later re-seed can be told apart from
locally added entries.

Revision ID: 028_app_catalog
Revises: 027_dismissed_usb_devices
"""
from alembic import op
import sqlalchemy as sa


revision = "028_app_catalog"
down_revision = "027_dismissed_usb_devices"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS app_catalog (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            host_pattern VARCHAR(255) NOT NULL UNIQUE,
            app_id       VARCHAR(100) NOT NULL,
            app_name     VARCHAR(255) NOT NULL,
            vendor       VARCHAR(255),
            category     VARCHAR(50)  NOT NULL,
            is_enabled   BOOLEAN      NOT NULL DEFAULT TRUE,
            is_builtin   BOOLEAN      NOT NULL DEFAULT FALSE,
            priority     INTEGER      NOT NULL DEFAULT 0,
            notes        VARCHAR(1000),
            created_by   UUID,
            created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
        )
        """
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_app_catalog_category ON app_catalog (category)"
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_app_catalog_app_id ON app_catalog (app_id)"
    ))

    # Import inside upgrade(): alembic loads every version module at startup, so
    # a top-level app import would make migrations depend on the app package
    # being importable even for unrelated revisions.
    from app.core.web_activity import DEFAULT_CATALOG

    for host_pattern, app_id, app_name, vendor, category in DEFAULT_CATALOG:
        # A pattern carrying a path ("github.com/copilot") is more specific than
        # the bare host, so it must win when both match.
        priority = 10 if "/" in host_pattern else 0
        bind.execute(
            sa.text(
                """
                INSERT INTO app_catalog
                    (host_pattern, app_id, app_name, vendor, category, is_builtin, priority)
                VALUES (:hp, :aid, :an, :v, :c, TRUE, :p)
                ON CONFLICT (host_pattern) DO NOTHING
                """
            ),
            {"hp": host_pattern, "aid": app_id, "an": app_name,
             "v": vendor, "c": category, "p": priority},
        )


def downgrade() -> None:
    op.get_bind().execute(sa.text("DROP TABLE IF EXISTS app_catalog"))
