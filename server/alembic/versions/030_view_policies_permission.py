"""Split "read a policy" from "change a policy".

Until now there was no way to express read-only access to policies. The API
gated ``GET /policies`` on ``require_role("analyst")`` and the sidebar gated the
Policies link on ``create_policy``/``update_policy`` — a WRITE permission doing
duty as a READ gate. The effect was that a VIEWER, whose whole purpose is
read-only oversight, could not see that any policy existed: the nav link was
hidden and the endpoint answered 403.

``view_policies`` is that missing read grant. Every human role gets it,
including VIEWER. Creating, editing, deleting and enabling/disabling remain on
create_policy / update_policy / delete_policy, so widening read does not widen
write anywhere.

Idempotent (ON CONFLICT DO NOTHING / NOT EXISTS), safe to re-run.

Revision ID: 030_view_policies_permission
Revises: 029_sso_siem_sub
"""
from alembic import op
import sqlalchemy as sa


revision = "030_view_policies_permission"
down_revision = "029_sso_siem_sub"
branch_labels = None
depends_on = None


# Read-only policy visibility is appropriate for every human role. The roles
# that may also CHANGE a policy are unchanged — they hold create_policy /
# update_policy / delete_policy, which this migration does not touch.
_ROLES = [
    "ADMIN",
    "ANALYST",
    "MANAGER",
    "VIEWER",
    "THREAT_ADMIN",
    "DATA_PROTECTION_ADMIN",
    "ACCESS_CONTROL_ADMIN",
]


def upgrade() -> None:
    bind = op.get_bind()

    bind.execute(sa.text(
        """
        INSERT INTO permissions (name, description)
        VALUES (
            'view_policies',
            'Read DLP policies and their configuration. Does not permit '
            'creating, editing, enabling/disabling or deleting a policy.'
        )
        ON CONFLICT (name) DO NOTHING
        """
    ))

    for role_name in _ROLES:
        bind.execute(
            sa.text(
                """
                INSERT INTO role_permissions (role_id, permission_id)
                SELECT r.id, p.id
                  FROM roles r, permissions p
                 WHERE r.name = :role AND p.name = 'view_policies'
                   AND NOT EXISTS (
                       SELECT 1 FROM role_permissions rp
                        WHERE rp.role_id = r.id AND rp.permission_id = p.id
                   )
                """
            ),
            {"role": role_name},
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        DELETE FROM role_permissions
         WHERE permission_id IN (
             SELECT id FROM permissions WHERE name = 'view_policies'
         )
        """
    ))
    bind.execute(sa.text(
        "DELETE FROM permissions WHERE name = 'view_policies'"
    ))
