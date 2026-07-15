"""
Document text extraction for DLP classification (canonical implementation).

The classification engine scans TEXT. Binary office/PDF attachments decode to
garbage bytes, which is why they previously classified as "Public" and slipped
through — this module turns those bytes into text the classifier can actually
scan (pdf, docx, xlsx, pptx), and decodes the plain-text family directly
(csv, txt, json, xml, ...).

Everything here is defensive on purpose: an attachment is untrusted input.
A parser that blows up, a corrupt/encrypted file, or a format we don't handle
returns a result with ok=False rather than raising, and byte/char caps stop a
hostile attachment from exhausting memory. The caller decides the policy for
un-extractable content — this module never decides allow/block.

Used by /agents/{id}/policy/evaluate when a caller sends `file_content_b64`:
the endpoint agent (USB / file transfer), the browser upload guard, and the
SMTP relay all send raw bytes and let the server do the parsing — so binary
office/PDF attachments are classified on their real text instead of the
compressed bytes (which always looked like "Public" and were let through).
"""
from __future__ import annotations

import io
import logging
import os
from typing import NamedTuple

log = logging.getLogger(__name__)

# Don't even attempt to parse an attachment larger than this.
MAX_EXTRACT_BYTES = 25 * 1024 * 1024
# Cap the text handed to the classifier (keeps evaluate calls bounded).
MAX_TEXT_CHARS = 1_000_000

# Formats that are already text — decode, don't parse.
TEXT_EXTS = {
    ".txt", ".csv", ".tsv", ".log", ".json", ".xml", ".html", ".htm", ".md",
    ".yaml", ".yml", ".ini", ".cfg", ".conf", ".sql", ".eml", ".rtf",
    ".py", ".js", ".ts", ".java", ".c", ".cpp", ".cs", ".go", ".rb", ".php",
    ".sh", ".ps1", ".bat",
}


class Extracted(NamedTuple):
    text: str
    kind: str      # pdf | docx | xlsx | pptx | text | unsupported | error | too_large | empty
    ok: bool       # True when we produced text we trust for classification
    reason: str = ""


def _clip(s: str) -> str:
    return s if len(s) <= MAX_TEXT_CHARS else s[:MAX_TEXT_CHARS]


def _decode(data: bytes) -> str:
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="ignore")


def _extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")  # some PDFs are "encrypted" with an empty owner password
        except Exception:
            raise ValueError("encrypted pdf")
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def _extract_docx(data: bytes) -> str:
    import docx
    document = docx.Document(io.BytesIO(data))
    parts = [p.text for p in document.paragraphs]
    for table in document.tables:                      # PII loves living in tables
        for row in table.rows:
            parts.extend(cell.text for cell in row.cells)
    return "\n".join(parts)


def _extract_xlsx(data: bytes) -> str:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        lines = []
        for ws in wb.worksheets:
            for row in ws.iter_rows(values_only=True):
                if row:
                    lines.append(" ".join("" if v is None else str(v) for v in row))
        return "\n".join(lines)
    finally:
        wb.close()


def _extract_pptx(data: bytes) -> str:
    from pptx import Presentation
    prs = Presentation(io.BytesIO(data))
    out = []
    for slide in prs.slides:
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                out.append(shape.text_frame.text)
            elif hasattr(shape, "text"):
                out.append(shape.text)
    return "\n".join(out)


_PARSERS = {
    ".pdf": ("pdf", _extract_pdf),
    ".docx": ("docx", _extract_docx),
    ".docm": ("docx", _extract_docx),
    ".xlsx": ("xlsx", _extract_xlsx),
    ".xlsm": ("xlsx", _extract_xlsx),
    ".pptx": ("pptx", _extract_pptx),
}

# Legacy OLE formats need extra tooling we don't ship; call them out explicitly
# so the caller can policy-decide rather than silently treating them as clean.
_LEGACY_EXTS = {".doc", ".xls", ".ppt"}


def sniff_kind(filename: str, data: bytes) -> str:
    """Best-effort format label from the extension, with a magic-byte fallback."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in _PARSERS:
        return _PARSERS[ext][0]
    if ext in TEXT_EXTS:
        return "text"
    if ext in _LEGACY_EXTS:
        return "unsupported"
    if data[:5] == b"%PDF-":
        return "pdf"
    if data[:4] == b"PK\x03\x04":
        return "ooxml"   # a zip container — needs the extension to disambiguate
    return "unknown"


def extract_text(filename: str, data: bytes) -> Extracted:
    """Return text suitable for classification, plus how we got it."""
    if not data:
        return Extracted("", "empty", True, "no content")
    if len(data) > MAX_EXTRACT_BYTES:
        return Extracted("", "too_large", False, f"{len(data)} bytes exceeds cap")

    ext = os.path.splitext(filename or "")[1].lower()

    parser = _PARSERS.get(ext)
    if parser is None and data[:5] == b"%PDF-":
        parser = _PARSERS[".pdf"]                       # mislabeled/extension-less PDF

    if parser is not None:
        kind, fn = parser
        try:
            text = _clip(fn(data))
        except Exception as e:                          # corrupt / encrypted / unsupported variant
            log.warning("extract failed for %s (%s): %s", filename, kind, e)
            return Extracted("", "error", False, f"{kind}: {e}")
        if not text.strip():
            # Parsed fine but produced nothing — e.g. a scanned/image-only PDF.
            return Extracted("", kind, False, "no extractable text (image-only?)")
        return Extracted(text, kind, True)

    if ext in TEXT_EXTS:
        return Extracted(_clip(_decode(data)), "text", True)

    if ext in _LEGACY_EXTS:
        return Extracted("", "unsupported", False, f"legacy format {ext} not supported")

    # Unknown extension: if it decodes cleanly it's text; otherwise say so.
    text = _decode(data)
    printable = sum(c.isprintable() or c.isspace() for c in text[:4096])
    if text and printable / max(1, len(text[:4096])) > 0.85:
        return Extracted(_clip(text), "text", True)

    return Extracted("", "unsupported", False, f"binary/unknown format {ext or '(none)'}")
