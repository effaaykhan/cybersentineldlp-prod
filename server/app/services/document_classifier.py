"""
Document & image type classification — 24 built-in classifiers.

ADDITIVE and SELF-CONTAINED. This is a NEW signal layer that answers a different
question from the existing pipeline: not "does this contain sensitive data?"
(regex / EDM / fingerprint already do that) but "what KIND of document/image is
this?" — a patent, an M&A agreement, a passport, source code, and so on. It does
not import, modify, or depend on classification_engine; callers opt in.

How it works (be precise about the "AI/ML" claim): each classifier is a
weighted-signal scoring model — a curated set of characteristic markers
(distinctive keywords/phrases and regex signatures) with weights. A document's
score for a type is the sum of the weights of the markers it contains; the
confidence is that score normalised against the type's target. This is an
explainable linear model, not a neural network: every decision reports exactly
which signals fired. It is deterministic, fast, needs no GPU or model download,
and runs offline — the right tool for structured document typing.

Images are covered through the existing OCR path: an image or scanned PDF is
OCR'd to text upstream (document_extract), and that text is classified here — so
a passport photo classifies via its MRZ + fields, an ID scan via its markers.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

# A signal is (kind, pattern, weight). kind: "kw" = case-insensitive substring,
# "re" = regex (compiled case-insensitive). Distinctive markers carry more weight.
Signal = Tuple[str, str, float]

# Each classifier: id, human label, category, signals, target score to reach
# full confidence, and the min confidence to report a match.
_RAW: List[Dict[str, Any]] = [
    # ── Identity documents (often arrive as images → OCR → here) ──────────
    {"id": "passport", "label": "Passport", "category": "identity", "target": 4, "signals": [
        ("re", r"P[<K][A-Z]{3}[A-Z<]{2,}", 3), ("kw", "passport", 2), ("kw", "nationality", 1),
        ("kw", "place of birth", 1), ("kw", "date of expiry", 1), ("kw", "authority", 1),
        ("re", r"passport\s*(no|number)", 2), ("kw", "date of issue", 1)]},
    {"id": "national_id", "label": "National ID card", "category": "identity", "target": 4, "signals": [
        ("kw", "identity card", 3), ("kw", "national id", 2), ("kw", "national identity", 2),
        ("kw", "aadhaar", 2), ("kw", "social security card", 2), ("re", r"\bid\s*(no|number)\b", 1),
        ("kw", "id card", 1)]},
    {"id": "drivers_license", "label": "Driver's license", "category": "identity", "target": 4, "signals": [
        ("kw", "driver's license", 3), ("kw", "driving licence", 3), ("kw", "driver license", 3),
        ("kw", "department of motor vehicles", 2), ("kw", "dmv", 1), ("re", r"\bdl\s*(no|number)\b", 2),
        ("kw", "endorsements", 1), ("kw", "restrictions", 1)]},
    {"id": "visa", "label": "Visa", "category": "identity", "target": 4, "signals": [
        ("kw", "visa type", 3), ("re", r"visa\s*(no|number)", 2), ("kw", "port of entry", 2),
        ("kw", "consulate", 1), ("kw", "immigration", 1), ("kw", "multiple entry", 1),
        ("kw", "date of admission", 1), ("kw", "control number", 1)]},

    # ── Legal / IP ────────────────────────────────────────────────────────
    {"id": "patent", "label": "Patent", "category": "legal_ip", "target": 4, "signals": [
        ("kw", "united states patent", 3), ("kw", "patent application", 2), ("kw", "prior art", 2),
        ("kw", "field of the invention", 3), ("kw", "what is claimed is", 3), ("kw", "uspto", 2),
        ("re", r"patent\s*no\.?\s*[:#]?\s*\d", 2), ("kw", "inventor", 1), ("kw", "embodiment", 1)]},
    {"id": "ma_document", "label": "M&A document", "category": "legal_ip", "target": 4, "signals": [
        ("kw", "definitive agreement", 3), ("kw", "share purchase agreement", 3), ("kw", "merger", 2),
        ("kw", "acquisition", 2), ("kw", "letter of intent", 2), ("kw", "due diligence", 2),
        ("kw", "purchase price", 2), ("kw", "target company", 2), ("kw", "closing conditions", 2),
        ("kw", "term sheet", 2)]},
    {"id": "contract", "label": "Contract / agreement", "category": "legal_ip", "target": 4, "signals": [
        ("kw", "in witness whereof", 3), ("kw", "hereinafter", 2), ("kw", "whereas", 2),
        ("kw", "governing law", 2), ("kw", "the parties", 1), ("kw", "terms and conditions", 1),
        ("kw", "indemnif", 1), ("kw", "termination", 1), ("kw", "this agreement", 1)]},
    {"id": "nda", "label": "Non-disclosure agreement", "category": "legal_ip", "target": 4, "signals": [
        ("kw", "non-disclosure agreement", 3), ("kw", "receiving party", 2), ("kw", "disclosing party", 2),
        ("kw", "confidential information", 2), ("kw", "trade secret", 2), ("kw", "shall not disclose", 2)]},
    {"id": "legal_filing", "label": "Legal filing / litigation", "category": "legal_ip", "target": 4, "signals": [
        ("kw", "plaintiff", 2), ("kw", "defendant", 2), ("re", r"case\s*no\.?\s*[:#]?\s*\d", 2),
        ("kw", "docket", 2), ("kw", "jurisdiction", 1), ("kw", "attorney", 1), ("kw", "complaint", 1),
        ("kw", "hereby", 1)]},

    # ── Financial ─────────────────────────────────────────────────────────
    {"id": "financial_statement", "label": "Financial statement", "category": "financial", "target": 4, "signals": [
        ("kw", "balance sheet", 3), ("kw", "income statement", 3), ("kw", "statement of operations", 3),
        ("kw", "total assets", 2), ("kw", "total liabilities", 2), ("kw", "shareholders equity", 2),
        ("kw", "cash flow", 2), ("kw", "net income", 1), ("kw", "gross profit", 1)]},
    {"id": "invoice", "label": "Invoice", "category": "financial", "target": 4, "signals": [
        ("re", r"invoice\s*(no|number|#)", 3), ("kw", "bill to", 2), ("kw", "amount due", 2),
        ("kw", "total due", 2), ("kw", "payment terms", 1), ("kw", "purchase order", 1),
        ("kw", "subtotal", 1), ("kw", "invoice", 1)]},
    {"id": "bank_statement", "label": "Bank statement", "category": "financial", "target": 4, "signals": [
        ("kw", "opening balance", 2), ("kw", "closing balance", 2), ("kw", "available balance", 2),
        ("kw", "account statement", 2), ("kw", "statement period", 2), ("kw", "routing number", 2),
        ("kw", "withdrawal", 1), ("kw", "deposit", 1)]},
    {"id": "tax_document", "label": "Tax document", "category": "financial", "target": 4, "signals": [
        ("kw", "form w-2", 3), ("kw", "form 1099", 3), ("kw", "internal revenue service", 2),
        ("kw", "taxable income", 2), ("kw", "employer identification", 2), ("re", r"\b1040\b", 2),
        ("kw", "withholding", 1), ("kw", "tax return", 2)]},
    {"id": "payroll", "label": "Payroll / pay stub", "category": "financial", "target": 4, "signals": [
        ("kw", "pay stub", 3), ("kw", "gross pay", 2), ("kw", "net pay", 2), ("kw", "pay period", 2),
        ("kw", "payroll", 2), ("kw", "year-to-date", 1), ("kw", "ytd", 1), ("kw", "overtime", 1)]},
    {"id": "insurance_claim", "label": "Insurance claim / policy", "category": "financial", "target": 4, "signals": [
        ("kw", "insurance claim", 3), ("re", r"policy\s*(no|number)", 2), ("re", r"claim\s*(no|number)", 2),
        ("kw", "claimant", 2), ("kw", "policyholder", 2), ("kw", "adjuster", 2), ("kw", "date of loss", 2),
        ("kw", "deductible", 1)]},

    # ── Technical ─────────────────────────────────────────────────────────
    {"id": "source_code", "label": "Source code", "category": "technical", "target": 4, "signals": [
        ("re", r"#include\s*<", 3), ("kw", "public static void", 3), ("re", r"\bdef\s+\w+\s*\(", 2),
        ("kw", "using system;", 3), ("kw", "<?php", 3), ("re", r"\bfunction\s+\w+\s*\(", 2),
        ("re", r"\bimport\s+[\w.]+", 1), ("kw", "console.log", 2), ("kw", "system.out.print", 2),
        ("re", r"=>|::|\bconst\s+\w+\s*=", 1), ("re", r"\breturn\b", 1)]},
    {"id": "sql_dump", "label": "Database dump / SQL", "category": "technical", "target": 4, "signals": [
        ("kw", "mysqldump", 3), ("kw", "pg_dump", 3), ("kw", "create table", 2), ("kw", "insert into", 2),
        ("re", r"select\s+.*\s+from", 2), ("kw", "drop table", 2), ("kw", "alter table", 2),
        ("kw", "primary key", 1), ("kw", "foreign key", 1)]},
    {"id": "secrets_config", "label": "Secrets / credentials file", "category": "technical", "target": 4, "signals": [
        ("re", r"-----BEGIN\s+(RSA\s+)?PRIVATE KEY", 3), ("re", r"AKIA[0-9A-Z]{16}", 3),
        ("re", r"(api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]", 2),
        ("re", r"password\s*[:=]", 1), ("kw", "aws_secret_access_key", 3),
        ("re", r"authorization:\s*bearer", 2)]},
    {"id": "infra_config", "label": "Infrastructure / DevOps config", "category": "technical", "target": 4, "signals": [
        ("kw", "kind: deployment", 3), ("re", r"apiversion:\s*", 2), ("re", r"^from\s+\w+.*", 2),
        ("kw", "terraform", 2), ("re", r"resource\s+\"\w+\"", 2), ("kw", "kubectl", 2),
        ("kw", "dockerfile", 2), ("re", r"server\s*\{", 1), ("kw", "upstream", 1)]},

    # ── Corporate ─────────────────────────────────────────────────────────
    {"id": "board_document", "label": "Board / executive document", "category": "corporate", "target": 4, "signals": [
        ("kw", "board of directors", 3), ("kw", "minutes of", 2), ("kw", "resolved that", 2),
        ("kw", "quorum", 2), ("kw", "motion carried", 2), ("kw", "executive session", 2),
        ("kw", "board meeting", 2), ("kw", "chairman", 1)]},
    {"id": "business_plan", "label": "Business plan / strategy", "category": "corporate", "target": 4, "signals": [
        ("kw", "business plan", 3), ("kw", "go-to-market", 2), ("kw", "market analysis", 2),
        ("kw", "revenue model", 2), ("kw", "competitive landscape", 2), ("kw", "financial projections", 2),
        ("kw", "value proposition", 1), ("kw", "executive summary", 1), ("kw", "target market", 1)]},
    {"id": "resume_cv", "label": "Resume / CV", "category": "corporate", "target": 4, "signals": [
        ("kw", "curriculum vitae", 3), ("kw", "work experience", 2), ("kw", "professional experience", 2),
        ("kw", "employment history", 2), ("kw", "references available", 2), ("re", r"linkedin\.com/in/", 2),
        ("kw", "education", 1), ("kw", "skills", 1), ("kw", "objective", 1)]},

    # ── Healthcare ────────────────────────────────────────────────────────
    {"id": "medical_record", "label": "Medical record / PHI", "category": "healthcare", "target": 4, "signals": [
        ("kw", "protected health information", 3), ("kw", "medical record", 3), ("re", r"icd-?10", 3),
        ("kw", "diagnosis", 2), ("kw", "treatment plan", 2), ("kw", "medical history", 2),
        ("kw", "prescription", 2), ("kw", "physician", 1), ("kw", "allergies", 1), ("kw", "patient", 1)]},

    # ── Security ──────────────────────────────────────────────────────────
    {"id": "security_audit", "label": "Security / audit report", "category": "security", "target": 4, "signals": [
        ("kw", "penetration test", 3), ("re", r"\bcvss\b", 3), ("re", r"\bcve-\d{4}-\d+", 3),
        ("kw", "vulnerability", 2), ("kw", "security assessment", 2), ("kw", "risk rating", 2),
        ("kw", "remediation", 1), ("kw", "exploit", 1), ("kw", "finding", 1)]},
]

_DEFAULT_MIN_CONFIDENCE = 0.5


def _compile(raw: List[Dict[str, Any]]):
    out = []
    for c in raw:
        sigs = []
        for kind, pat, w in c["signals"]:
            if kind == "kw":
                sigs.append(("kw", pat.lower(), float(w), pat))
            else:
                sigs.append(("re", re.compile(pat, re.IGNORECASE | re.MULTILINE), float(w), pat))
        out.append({**c, "signals": sigs})
    return out


_CLASSIFIERS = _compile(_RAW)

# Public: how many classifiers ship out of the box.
CLASSIFIER_COUNT = len(_CLASSIFIERS)


def list_classifiers() -> List[Dict[str, str]]:
    """The catalogue of built-in classifiers (for the UI / docs)."""
    return [{"id": c["id"], "label": c["label"], "category": c["category"]} for c in _CLASSIFIERS]


def classify_document(
    text: str,
    top_k: int = 3,
    min_confidence: float = _DEFAULT_MIN_CONFIDENCE,
) -> List[Dict[str, Any]]:
    """Classify what KIND of document/image `text` is.

    Returns up to `top_k` matches above `min_confidence`, each:
      {type, label, category, confidence, matched_signals}
    Multiple types can legitimately match (an "M&A document" is often also a
    "contract"). Returns [] when nothing is recognised — that is a valid answer,
    not a failure. Never raises on odd input.
    """
    if not text or not isinstance(text, str):
        return []
    lower = text.lower()
    results: List[Dict[str, Any]] = []
    for c in _CLASSIFIERS:
        score = 0.0
        matched: List[str] = []
        for kind, pat, w, label in c["signals"]:
            try:
                hit = (pat in lower) if kind == "kw" else bool(pat.search(text))
            except Exception:
                hit = False
            if hit:
                score += w
                matched.append(label)
        if score <= 0:
            continue
        conf = min(1.0, score / float(c["target"]))
        if conf >= min_confidence:
            results.append({
                "type": c["id"],
                "label": c["label"],
                "category": c["category"],
                "confidence": round(conf, 3),
                "matched_signals": matched[:8],
            })
    results.sort(key=lambda r: -r["confidence"])
    return results[:top_k]
