"""
App catalog — which web destinations are which kind of app.

A row answers one question: "the browser is talking to this host; what is it?"
The answer (category + app identity) is what turns an anonymous HTTP request
into a policy-matchable activity — "Confidential data posted to ChatGPT" rather
than "a POST to an unknown host".

WHY A TABLE AND NOT A CONSTANT: the previous implementation kept 26 hostnames in
a JavaScript array inside the browser extension (``CLOUD_HOSTS`` in inject.js).
That list contained no AI vendor at all, and extending it meant editing,
re-packing and re-deploying the extension to every endpoint. The generative-AI
landscape changes faster than an extension release cycle, so the list has to be
something an operator can add a row to. The extension pulls this table and
caches it; ``app.core.web_activity.DEFAULT_CATALOG`` seeds it and doubles as the
extension's offline fallback.

Matching is by ``host_pattern``: exact hostname, or a dot-suffix of it, so
"google.com" covers "drive.google.com" but not "notgoogle.com". Deliberately not
a substring match — that is the classic way a host allowlist gets bypassed.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, String, Boolean, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID
import uuid

from app.core.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class AppCatalogEntry(Base):
    __tablename__ = "app_catalog"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The match key. Hostname or dot-suffix; may carry a path prefix for apps
    # that share a host with something else ("bing.com/chat").
    host_pattern = Column(String(255), nullable=False, unique=True)
    # Stable identifier the browser extension keys its DOM profile off. Several
    # rows share one app_id on purpose (chatgpt.com and chat.openai.com are both
    # "chatgpt"), which is why it is not unique.
    app_id = Column(String(100), nullable=False)
    app_name = Column(String(255), nullable=False)
    vendor = Column(String(255), nullable=True)
    # webmail | cloud_storage | collaboration | genai — see core/web_activity.py
    category = Column(String(50), nullable=False)
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    # True for rows that shipped with the product. Kept so a re-seed can refresh
    # built-ins without touching anything an operator added or edited, and so
    # the UI can warn before deleting one.
    is_builtin = Column(Boolean, nullable=False, default=False, server_default="false")
    # Higher wins when two patterns match the same host. Lets a specific row
    # ("github.com/copilot" -> genai) beat a general one ("github.com" -> cloud).
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    notes = Column(String(1000), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    def __repr__(self):
        return f"<AppCatalogEntry {self.host_pattern} -> {self.app_id}/{self.category}>"
