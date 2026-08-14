"""
Role-based redaction of captured content on read.

The DLP database stores the very thing it is protecting: clipboard captures,
file-content excerpts and line-level diffs all sit in the event record. Any
role allowed to *see that an incident happened* would therefore also see the
leaked data itself — which turns a read-only account into the easiest
exfiltration path in the product.

So visibility is split in two:

  view_events            — the event happened: who, when, which agent, which
                           policy matched, what action was taken, file NAME and
                           path, classification level. Enough to triage and to
                           report, and this is what a VIEWER gets.
  view_sensitive_content — the captured payload itself. ANALYST and above.

Without the second permission the payload fields are replaced by a marker
(never silently dropped — a blank field reads as "nothing was captured", which
is a different and misleading claim). The UI can show "hidden" honestly.

Applied on the way OUT, at the API boundary, so it covers every reader
regardless of which store the row came from (OpenSearch, Mongo, Postgres
mirror) and cannot be bypassed by a different query path.
"""
from __future__ import annotations

from typing import Any

SENSITIVE_PERMISSION = "view_sensitive_content"

REDACTED = "[hidden — requires view_sensitive_content]"

# Top-level event fields that carry captured payload rather than metadata.
_SENSITIVE_FIELDS: tuple[str, ...] = (
    "content",
    "clipboard_content",
    "content_changes",
)

# Substrings identifying payload-bearing keys nested inside the free-form
# ``details`` / ``metadata`` blobs. Matched case-insensitively on the key name.
# Deliberately broad: a false positive hides a field from a low-privilege
# reader, a false negative leaks the data we exist to protect.
_SENSITIVE_KEY_HINTS: tuple[str, ...] = (
    "content",
    "preview",
    "excerpt",
    "snippet",
    "sample",
    "matched_value",
    "matched_text",
    "matched_string",
    "clipboard",
    "body",
    "payload",
)

# Keys that contain one of the hints above but are counters/flags, not payload.
# Without this, `content_redacted` (a bool) and `lines_added` style fields get
# stringified into the marker and the UI loses working metadata.
_HINT_EXEMPT: frozenset[str] = frozenset({
    "content_redacted",
    "content_changes_truncated",
    "content_length",
    "content_size",
    "content_hash",
    "content_type",
    "mime_type",
    "body_size",
})

_MAX_DEPTH = 6


def _is_sensitive_key(key: str) -> bool:
    k = str(key).lower()
    if k in _HINT_EXEMPT:
        return False
    return any(hint in k for hint in _SENSITIVE_KEY_HINTS)


def _scrub(value: Any, depth: int = 0) -> Any:
    """Recursively replace payload-bearing values inside a nested blob."""
    if depth >= _MAX_DEPTH:
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if _is_sensitive_key(k) and v not in (None, "", [], {}):
                out[k] = REDACTED
            else:
                out[k] = _scrub(v, depth + 1)
        return out
    if isinstance(value, list):
        return [_scrub(v, depth + 1) for v in value]
    return value


def redact_event(doc: Any) -> Any:
    """
    Return a copy of one event with captured payload replaced by a marker.

    Copies rather than mutates: these dicts can come straight from a cache or a
    shared result set, and redacting in place would poison them for a
    subsequent privileged reader on the same worker.
    """
    if not isinstance(doc, dict):
        return doc

    out = dict(doc)

    for field in _SENSITIVE_FIELDS:
        if out.get(field) not in (None, "", [], {}):
            out[field] = REDACTED

    for blob in ("details", "metadata"):
        if isinstance(out.get(blob), dict):
            out[blob] = _scrub(out[blob])

    # Tell the client the difference between "nothing captured" and "not
    # allowed to see it", so the UI can render an honest placeholder.
    out["content_hidden"] = True
    return out


def redact_events(docs: Any) -> Any:
    if not isinstance(docs, list):
        return docs
    return [redact_event(d) for d in docs]


def may_view_sensitive(permissions: Any) -> bool:
    """True when the resolved permission set allows seeing captured payload."""
    try:
        return SENSITIVE_PERMISSION in permissions
    except TypeError:
        return False
