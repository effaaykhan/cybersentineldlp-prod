"""Replace sensitive values in outbound text with placeholders.

WHAT THIS IS FOR
    A policy cell set to ``mask`` lets the activity happen, but not with the
    real data in it. A prompt reading

        "Rahul Menon, Aadhaar 4321 8765 1234, needs his policy reissued"

    goes to the AI vendor as

        "Rahul Menon, Aadhaar [AADHAAR_1], needs his policy reissued"

    The user keeps working, the vendor never sees the number, and the event
    records that one Aadhaar was replaced — never the value itself.

WHY IT LIVES HERE AND NOT IN THE CLASSIFIER
    The classifier answers "is this sensitive"; it counts matches and never
    needed to know where they were (``pattern.findall`` on
    classification_engine.py). Teaching the hot path to carry offsets would
    change a code path every single event goes through, to serve a decision
    almost none of them reach.

    So this is a second, additive pass that runs ONLY when a mask verdict is
    actually in play. It takes the rules the classifier says matched and
    re-runs just those against the same text with ``finditer``. Slower in
    absolute terms, irrelevant in practice — the input is a chat message, and
    the alternative is a riskier change to the code path that classifies
    everything.

THE RULE THAT MAKES IT SAFE
    Masking is all-or-nothing. If any rule that fired cannot be located —
    fingerprint containment, the ML classifier, the correlation heuristics —
    ``plan`` returns None and the caller MUST fall back to blocking. A
    partially masked prompt is more dangerous than an unmasked one, because it
    looks handled: the located half is redacted and the rest goes out with a
    green light on it.

WHAT NEVER LEAVES THIS MODULE
    The original values. They are read to compute offsets and to keep the token
    mapping stable within one message, and then dropped. Nothing here logs,
    stores or returns a matched value — the summary carries types and counts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import structlog

logger = structlog.get_logger()

# Rule types whose matches can be pointed at in the text. Anything not in here
# is a judgement about the document as a whole rather than about a span of it.
LOCATABLE_RULE_TYPES = {"regex", "keyword", "dictionary"}

# Detectors that are meaningful but produce no offsets, listed so the reason a
# mask was refused can name the specific one rather than saying "something".
UNLOCATABLE_REASONS = {
    "fingerprint": "a document fingerprint matched, which identifies the file rather than a place in it",
    "data_match": "exact data matching fired on a record, not on a locatable span",
    "ml": "the ML classifier judged the content as a whole",
    "correlation": "a correlation rule fired on context rather than on a single value",
    "entropy": "high entropy was detected across the content",
}

_TOKEN_SAFE = re.compile(r"[^A-Z0-9]+")


@dataclass
class Redaction:
    """One replaced span, as offsets into the text that was submitted."""
    start: int
    end: int
    type: str
    token: str


@dataclass
class RedactionPlan:
    masked_text: str
    redactions: List[Redaction] = field(default_factory=list)
    # [{"type": "AADHAAR", "count": 2}] — types and counts only, never values.
    summary: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.redactions)


# The first classification label on a rule is almost always the compliance
# bucket it reports under — PII, PCI, CREDENTIAL — and the SECOND is the actual
# data type. "Indian Aadhaar Number" carries ['PII', 'AADHAAR', 'INDIAN_ID'], so
# naively taking labels[0] produces [PII_1] where [AADHAAR_1] is what both the
# user and the model need to see.
_GENERIC_LABELS = frozenset({
    "PII", "PCI", "PHI", "GDPR", "HIPAA", "SOX", "CCPA", "DPDP",
    "FINANCIAL", "CREDENTIAL", "TAX", "BANKING", "PAYMENT", "HEALTHCARE",
    "CONTACT", "PERSONAL", "SENSITIVE",
    "DOCUMENT_CLASSIFICATION", "ENCRYPTION", "INDIAN_ID", "NATIONAL_ID",
})


def _type_label(rule: Any) -> str:
    """A short, stable name for what was replaced, for the placeholder token.

    Prefers the most SPECIFIC classification label — the data type rather than
    the compliance bucket — because the placeholder is read by two audiences
    that both need the specific one: the user, who has to recognise what left
    their message, and the model, which reasons better about [AADHAAR_1] than
    about [PII_1]. Falls back to the rule's own name so a custom regex still
    produces something readable rather than [SENSITIVE_1].
    """
    labels = [str(l).upper() for l in (getattr(rule, "classification_labels", None) or [])]
    specific = next((l for l in labels if l not in _GENERIC_LABELS), "")
    raw = specific or (labels[0] if labels else "") or (getattr(rule, "name", "") or "SENSITIVE")
    label = _TOKEN_SAFE.sub("_", str(raw).upper()).strip("_")
    return label or "SENSITIVE"


def _spans_for_rule(rule: Any, text: str, compiled: Optional[re.Pattern]) -> List[Tuple[int, int]]:
    rtype = (getattr(rule, "type", "") or "").lower()

    if rtype == "regex":
        if compiled is None:
            return []
        return [(m.start(), m.end()) for m in compiled.finditer(text) if m.end() > m.start()]

    if rtype in ("keyword", "dictionary"):
        words = getattr(rule, "keywords", None) or getattr(rule, "dictionary_terms", None) or []
        spans: List[Tuple[int, int]] = []
        case_sensitive = bool(getattr(rule, "case_sensitive", False))
        flags = 0 if case_sensitive else re.IGNORECASE
        for word in words:
            w = str(word).strip()
            if not w:
                continue
            for m in re.finditer(r"\b" + re.escape(w) + r"\b", text, flags):
                spans.append((m.start(), m.end()))
        return spans

    return []


def _merge(spans: Sequence[Tuple[int, int, str]]) -> List[Tuple[int, int, str]]:
    """Collapse overlapping spans, keeping the widest.

    Two rules commonly cover the same digits — a generic "long number" rule and
    a specific Aadhaar one. Replacing twice would corrupt the text, and
    replacing the narrower one would leave part of the value in place.
    """
    if not spans:
        return []
    ordered = sorted(spans, key=lambda s: (s[0], -(s[1] - s[0])))
    out: List[Tuple[int, int, str]] = [ordered[0]]
    for start, end, label in ordered[1:]:
        last_start, last_end, last_label = out[-1]
        if start < last_end:                      # overlaps the one before it
            if end > last_end:
                out[-1] = (last_start, end, last_label)
            continue
        out.append((start, end, label))
    return out


def plan(
    text: str,
    matched_rules: Iterable[Dict[str, Any]],
    rules: Sequence[Any],
    compile_regex,
) -> Tuple[Optional[RedactionPlan], str]:
    """Work out what to replace, or refuse.

    Returns ``(plan, reason)``. A None plan means the caller must block:
    either something matched that cannot be located, or nothing could be found
    to replace at all — and "we found nothing to redact" on content a policy
    called sensitive is a disagreement between two detectors, not a clean bill
    of health.

    ``compile_regex`` is the classification engine's own cached compiler, so
    this uses exactly the patterns that produced the verdict rather than
    recompiling them differently.
    """
    if not text:
        return None, "there is no text to redact"

    by_id = {str(getattr(r, "id", "")): r for r in rules}
    found: List[Tuple[int, int, str]] = []

    for matched in matched_rules:
        rule = by_id.get(str(matched.get("rule_id") or ""))
        rtype = (matched.get("rule_type") or (getattr(rule, "type", "") if rule else "") or "").lower()

        if rtype not in LOCATABLE_RULE_TYPES:
            why = UNLOCATABLE_REASONS.get(rtype, f"a {rtype or 'non-locatable'} detection cannot be pointed at a span")
            # All-or-nothing: see the module docstring.
            return None, why

        if rule is None:
            # The rule matched but is no longer in the cache — we cannot know
            # what to look for, so we must not claim to have masked it.
            return None, "a rule that matched is no longer loaded, so its value cannot be located"

        label = _type_label(rule)
        for start, end in _spans_for_rule(rule, text, compile_regex(rule) if rtype == "regex" else None):
            found.append((start, end, label))

    if not found:
        return None, "the content was flagged but no value could be located to replace"

    merged = _merge(found)

    # Stable tokens: the same literal value gets the same placeholder throughout
    # the message, so the model can still reason about it — "email [PERSON_1]
    # and copy [PERSON_2]" is a sentence it can act on; two different tokens for
    # one person is not.
    assigned: Dict[Tuple[str, str], str] = {}
    counters: Dict[str, int] = {}
    redactions: List[Redaction] = []
    out: List[str] = []
    cursor = 0

    for start, end, label in merged:
        value = text[start:end]
        key = (label, value)
        token = assigned.get(key)
        if token is None:
            counters[label] = counters.get(label, 0) + 1
            token = f"[{label}_{counters[label]}]"
            assigned[key] = token
        out.append(text[cursor:start])
        out.append(token)
        cursor = end
        redactions.append(Redaction(start=start, end=end, type=label, token=token))
    out.append(text[cursor:])

    counts: Dict[str, int] = {}
    for r in redactions:
        counts[r.type] = counts.get(r.type, 0) + 1

    return (
        RedactionPlan(
            masked_text="".join(out),
            redactions=redactions,
            summary=[{"type": t, "count": c} for t, c in sorted(counts.items())],
        ),
        "",
    )
