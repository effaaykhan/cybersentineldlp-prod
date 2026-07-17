"""
Regression tests for classification false positives / false negatives.

The rule these defend: the channel policies BLOCK on Confidential/Restricted, so
anything that reaches those levels stops real work. Ordinary business documents
must never get there; definitive secrets always must.

This exists because the scoring once did `scale = min(2.0, count / threshold)`,
so with the usual threshold of 1 a *second* match doubled a rule's weight. Two
phone numbers scored 0.4*2 = 0.8 = Restricted; two financial words 0.5*2 = 1.0.
Measured on real content, a contact sheet, a server inventory, a support ticket
and an invoice template were all classified Confidential/Restricted — i.e. the
product would have blocked a contact list and an invoice on every client.

Engine-level tests: no network, no agent.

These deliberately use the REAL Postgres session rather than conftest's
`db_session` (an in-memory SQLite). Detection rules live in Postgres and are
seeded on first boot, so a SQLite session has no rules and every input would
classify Public — the tests would pass while proving nothing.
"""
import pytest
import pytest_asyncio

import app.core.database as _db
from app.core.database import init_databases
from app.services.classification_engine import ClassificationEngine


@pytest_asyncio.fixture
async def rules_db():
    """A session against the real database, where the detection rules live."""
    await init_databases()
    async with _db.postgres_session_factory() as session:
        yield session

BLOCKING_LEVELS = ("Confidential", "Restricted")

# Ordinary work product. None of this is a secret; all of it is the kind of
# thing that flows through a business every day.
BENIGN = {
    "meeting_notes": "Team sync notes. Action items assigned. Next review Friday.",
    "contact_sheet": (
        "Sales contacts:\njohn.smith@acme.com\nsarah.lee@acme.com\n"
        "mike.j@acme.com\nPhone: +91 98765 43210"
    ),
    "server_inventory": "web01 10.0.0.15\nweb02 10.0.0.16\ndb01 10.0.0.20\ncache 10.0.0.31",
    "support_ticket": (
        "Customer reports login issue. Contact: jane.doe@client.com, "
        "phone 555-123-4567. Server 192.168.1.50 timed out."
    ),
    "invoice_template": (
        "INVOICE\nBill To: Acme Corp\nAmount: 1500.00\nTerms: Net 30\n"
        "Remit payment to account department."
    ),
    # Volume of a weak identifier is still not a secret — it must alert, not block.
    "bulk_email_list": "\n".join(f"user{i}@acme.com" for i in range(300)),
    # A connection string with no credentials is configuration, not a secret.
    "db_url_without_credentials": "DATABASE_URL=postgresql://analytics-db:5432/reporting",
    "readme_prose": "Run docker compose up. See the postgres:// docs at https://example.com/help",
}

# Definitive secrets. Each must reach a blocking level on its own.
SENSITIVE = {
    "aws_access_key": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "ssn": "Employee SSN: 123-45-6789",
    "credit_card": "Card: 4111 1111 1111 1111",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...",
    "github_token": "token ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    # Bare scheme — what SQLAlchemy/Django/Rails/.env actually contain. The
    # original rule only matched `jdbc:` and missed every one of these.
    "db_conn_bare": "DATABASE_URL=postgresql://admin:s3cr3t@10.0.0.5:5432/customers",
    "db_conn_jdbc": "jdbc:postgresql://svc:PassW0rd@db:5432/prod",
    "mongo_srv": "mongodb+srv://root:pw123@cluster0.mongodb.net/users",
    # A real secret surrounded by weak noise must still block.
    "secret_amongst_noise": (
        "Customer record\njane@acme.com\nphone 555-123-4567\nSSN: 123-45-6789"
    ),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(BENIGN))
async def test_benign_content_is_never_blocked(rules_db, name):
    """Ordinary business content must stay below the blocking levels."""
    result = await ClassificationEngine(rules_db).classify_content(BENIGN[name])
    assert result.classification not in BLOCKING_LEVELS, (
        f"FALSE POSITIVE: {name} classified {result.classification} "
        f"(score {result.confidence_score}) — the channel policies would block this."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(SENSITIVE))
async def test_real_secrets_are_blocked(rules_db, name):
    """Every definitive secret must reach a blocking level."""
    result = await ClassificationEngine(rules_db).classify_content(SENSITIVE[name])
    assert result.classification in BLOCKING_LEVELS, (
        f"FALSE NEGATIVE: {name} classified {result.classification} "
        f"(score {result.confidence_score}) — this would be allowed out."
    )


@pytest.mark.asyncio
async def test_weak_signals_alone_cannot_reach_a_blocking_level(rules_db):
    """The core invariant: no volume of weak identifiers substitutes for a secret.

    Emails/IPs/phones indicate a document is *about* people or infrastructure,
    not that it *contains* a secret. Before the strong-signal gate, 300 emails
    scored high enough to block.
    """
    engine = ClassificationEngine(rules_db)
    result = await engine.classify_content("\n".join(f"user{i}@acme.com" for i in range(300)))
    assert result.classification == "Internal", (
        f"300 emails classified {result.classification}; weak signals must cap at Internal"
    )


@pytest.mark.asyncio
async def test_match_count_scaling_is_sublinear(rules_db):
    """A second match must not double a rule's weight.

    Guards the exact regression: `min(2.0, count/threshold)` meant two phone
    numbers = 0.4*2 = 0.8 = Restricted.
    """
    engine = ClassificationEngine(rules_db)
    two_phones = await engine.classify_content("Call 555-123-4567 or 555-987-6543")
    assert two_phones.classification not in BLOCKING_LEVELS, (
        f"two phone numbers classified {two_phones.classification} "
        f"(score {two_phones.confidence_score})"
    )
