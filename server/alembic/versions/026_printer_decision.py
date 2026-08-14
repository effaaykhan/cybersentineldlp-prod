"""Let a printer be explicitly DISAPPROVED, not just left off the allowlist.

Adds ``sanctioned_printers.decision`` ('allow' | 'deny'), mirroring the column
the USB registry has had since it shipped.

Until now the printer registry was allow-only. The single lever was scope: an
allowlist policy blocks everything not enrolled, and any other scope
(block_all / block_network / block_local) ignores the registry entirely. So
"block this one printer and leave the rest alone" was not expressible — you had
to switch the whole estate to allowlist scope and enrol every other printer just
to deny one. Suspending a row (is_enabled=false) is not the same thing either:
it only withdraws an approval, and outside allowlist scope withdrawing an
approval blocks nothing.

A deny row is checked in EVERY scope, so it is a real disapproval rather than
the absence of an approval.

Existing rows become 'allow', which is what they already meant.

Idempotent (IF NOT EXISTS), safe to re-run.

Revision ID: 026_printer_decision
Revises: 025_sso_role_provenance
"""
from alembic import op
import sqlalchemy as sa


revision = "026_printer_decision"
down_revision = "025_sso_role_provenance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        ALTER TABLE sanctioned_printers
          ADD COLUMN IF NOT EXISTS decision VARCHAR(10) NOT NULL DEFAULT 'allow'
        """
    ))
    # Belt and braces for rows written before the default existed.
    bind.execute(sa.text(
        "UPDATE sanctioned_printers SET decision = 'allow' "
        "WHERE decision IS NULL OR btrim(decision) = ''"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE sanctioned_printers DROP COLUMN IF EXISTS decision"
    ))
