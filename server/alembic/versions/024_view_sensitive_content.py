"""Split "see the event" from "see the captured payload".

Adds the ``view_sensitive_content`` permission and grants it to the roles that
investigate (ADMIN, ANALYST, and the three domain admins). MANAGER and VIEWER
deliberately do NOT get it: they keep full event/alert visibility for triage and
reporting, but the clipboard captures, file excerpts and line diffs stored on
each event are replaced with a marker on read (app/core/redaction.py).

Without this split, any account able to read events could also read the very
data the product exists to protect — the cheapest exfiltration path in the
system, and one that a read-only account would pass an audit while using.

Also grants VIEWER/MANAGER ``view_alerts``. MANAGER never had it, which hid
Alerts and Incidents from the sidebar while the API served those endpoints to
any authenticated caller — the nav and the API disagreeing in both directions.

Idempotent (ON CONFLICT DO NOTHING / NOT EXISTS), safe to re-run.

Revision ID: 024_view_sensitive_content
Revises: 023_ip_allowlist_config
"""
from alembic import op
import sqlalchemy as sa


revision = "024_view_sensitive_content"
down_revision = "023_ip_allowlist_config"
branch_labels = None
depends_on = None


# role name -> permissions to ensure are granted
_GRANTS = {
    "ADMIN": ["view_sensitive_content"],
    "ANALYST": ["view_sensitive_content"],
    "THREAT_ADMIN": ["view_sensitive_content"],
    "DATA_PROTECTION_ADMIN": ["view_sensitive_content"],
    "ACCESS_CONTROL_ADMIN": ["view_sensitive_content"],
    # Not view_sensitive_content — reporting roles see metadata only.
    "MANAGER": ["view_alerts"],
    "VIEWER": ["view_alerts"],
}


def upgrade() -> None:
    bind = op.get_bind()

    bind.execute(sa.text(
        """
        INSERT INTO permissions (name, description)
        VALUES (
            'view_sensitive_content',
            'View captured content on events (clipboard text, file excerpts, '
            'line diffs). Without it these fields are returned redacted.'
        )
        ON CONFLICT (name) DO NOTHING
        """
    ))

    # ── ABAC backfill ────────────────────────────────────────────────
    # A user with department NULL is denied EVERY event by ABAC
    # (abac_service §C), so an SSO-provisioned account could hold
    # view_events and still see a permanently empty page. Admins never
    # noticed because view_all_departments bypasses ABAC entirely — which is
    # what made this present as "only the admin role can see anything".
    # Events are stamped department='DEFAULT' at ingest when the triggering
    # user is unknown, so DEFAULT/1 is the pair that actually matches them
    # (it is what the bootstrap admin already carries).
    bind.execute(sa.text(
        """
        UPDATE users
           SET department = 'DEFAULT'
         WHERE department IS NULL OR btrim(department) = ''
        """
    ))
    bind.execute(sa.text(
        "UPDATE users SET clearance_level = 1 WHERE clearance_level IS NULL"
    ))

    for role_name, perms in _GRANTS.items():
        for perm in perms:
            bind.execute(
                sa.text(
                    """
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                      FROM roles r, permissions p
                     WHERE r.name = :role AND p.name = :perm
                       AND NOT EXISTS (
                           SELECT 1 FROM role_permissions rp
                            WHERE rp.role_id = r.id AND rp.permission_id = p.id
                       )
                    """
                ),
                {"role": role_name, "perm": perm},
            )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        DELETE FROM role_permissions
         WHERE permission_id IN (
             SELECT id FROM permissions WHERE name = 'view_sensitive_content'
         )
        """
    ))
    bind.execute(sa.text(
        "DELETE FROM permissions WHERE name = 'view_sensitive_content'"
    ))
