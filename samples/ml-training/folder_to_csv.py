#!/usr/bin/env python3
"""
Turn a folder of YOUR real documents into a text,label training CSV for the DLP
ML sensitivity classifier.

Expected layout — one subfolder per sensitivity level (case-insensitive; common
synonyms accepted), any supported files inside, nested folders are fine:

    my-docs/
      Public/         press releases, marketing, public docs, ...
      Internal/       memos, meeting notes, routine email exports, ...
      Confidential/   contracts, financials, business plans, ...
      Restricted/     PII exports, credentials, medical, legal-privileged, ...

Supported files (via the project's own extractor, same as the DLP pipeline):
  .pdf (text + OCR for scans), .docx, .xlsx, .pptx, images (.png/.jpg/.tiff → OCR),
  .txt/.md/.csv/.log/.json, and archives (.zip/.tar/.gz).

Long documents are split into several snippets so one big contract becomes many
training rows (not one giant row). Output is `text,label`, ready to upload at
Enforce → ML Classifier → Retrain, or POST to /api/v1/ml-classifier/retrain.

RUN IT IN THE MANAGER CONTAINER so PDF/DOCX/OCR are available, e.g.:

    docker cp ./my-docs cybersentinel-manager:/tmp/my-docs
    docker cp samples/ml-training/folder_to_csv.py cybersentinel-manager:/tmp/f2c.py
    docker exec -e PYTHONPATH=/app -w /app cybersentinel-manager \
        python3 /tmp/f2c.py /tmp/my-docs -o /tmp/training-mine.csv
    docker cp cybersentinel-manager:/tmp/training-mine.csv ./training-mine.csv
"""
import argparse
import csv
import os
import re
import sys
from collections import Counter, defaultdict

LEVELS = ["Public", "Internal", "Confidential", "Restricted"]
# folder-name -> canonical level (case-insensitive)
ALIASES = {
    "public": "Public", "open": "Public", "unclassified": "Public",
    "internal": "Internal", "internal-use": "Internal", "internal_use": "Internal",
    "confidential": "Confidential", "sensitive": "Confidential", "private": "Confidential",
    "restricted": "Restricted", "secret": "Restricted", "highly-confidential": "Restricted",
    "pii": "Restricted", "regulated": "Restricted",
}
_ws = re.compile(r"[ \t ]+")
_nl = re.compile(r"\n{2,}")
_sent = re.compile(r"(?<=[.!?])\s+")


def get_extractor():
    """Return extract_text from the app if importable (full OCR/format support),
    else a stdlib fallback that only reads plain-text files."""
    try:
        from app.services.document_extract import extract_text  # type: ignore
        def extract(path, data):
            r = extract_text(os.path.basename(path), data)
            return (r.text or ""), r.kind, r.ok
        return extract, True
    except Exception:
        TEXT_EXT = {".txt", ".md", ".csv", ".log", ".json", ".text"}
        def extract(path, data):
            ext = os.path.splitext(path)[1].lower()
            if ext not in TEXT_EXT:
                return "", "unsupported(no-app)", False
            for enc in ("utf-8", "utf-16", "latin-1"):
                try:
                    return data.decode(enc), "text", True
                except Exception:
                    continue
            return data.decode("utf-8", errors="ignore"), "text", True
        return extract, False


def chunk(text, target, min_chars):
    """Split text into snippets ~target chars on paragraph, then sentence,
    boundaries. Yields cleaned chunks >= min_chars."""
    text = _nl.sub("\n\n", text or "")
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    buf = ""
    def flush(b):
        b = _ws.sub(" ", b.replace("\n", " ")).strip()
        return b if len(b) >= min_chars else None
    for p in paras:
        if len(p) > target * 1.6:                      # long paragraph -> sentences
            for s in _sent.split(p):
                if len(buf) + len(s) + 1 > target and buf:
                    c = flush(buf); buf = ""
                    if c: yield c
                buf = (buf + " " + s).strip()
        else:
            if len(buf) + len(p) + 1 > target and buf:
                c = flush(buf); buf = ""
                if c: yield c
            buf = (buf + "\n" + p).strip()
    c = flush(buf)
    if c:
        yield c


def resolve_level(folder_name, extra_map):
    key = folder_name.strip().lower()
    return extra_map.get(key) or ALIASES.get(key) or (
        folder_name if folder_name in LEVELS else None)


def main():
    ap = argparse.ArgumentParser(description="Folder of documents -> text,label CSV")
    ap.add_argument("input_dir", help="root folder containing per-level subfolders")
    ap.add_argument("-o", "--output", default="training-mine.csv")
    ap.add_argument("--chunk-chars", type=int, default=600, help="target snippet length")
    ap.add_argument("--min-chars", type=int, default=60, help="drop snippets shorter than this")
    ap.add_argument("--max-rows-per-file", type=int, default=40,
                    help="cap rows from one document so it can't dominate")
    ap.add_argument("--map", default="", help='custom folder=Level pairs, e.g. "hr=Restricted,legal=Confidential"')
    args = ap.parse_args()

    extra_map = {}
    for pair in filter(None, (p.strip() for p in args.map.split(","))):
        k, _, v = pair.partition("=")
        if v.strip() in LEVELS:
            extra_map[k.strip().lower()] = v.strip()

    extract, full = get_extractor()
    if not full:
        print("WARNING: app extractor not importable — only plain-text files will be "
              "read. Run inside the manager container for PDF/DOCX/OCR.\n", file=sys.stderr)

    if not os.path.isdir(args.input_dir):
        sys.exit(f"not a directory: {args.input_dir}")

    rows = []
    per_level = Counter()
    files_ok = Counter()
    files_skipped = Counter()
    kinds = Counter()
    skip_reasons = defaultdict(Counter)

    for entry in sorted(os.listdir(args.input_dir)):
        sub = os.path.join(args.input_dir, entry)
        if not os.path.isdir(sub):
            continue
        level = resolve_level(entry, extra_map)
        if level is None:
            print(f"  · skipping folder '{entry}' (not a recognised level; use --map)")
            continue
        for dirpath, _, filenames in os.walk(sub):
            for fn in sorted(filenames):
                if fn.startswith("."):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    with open(path, "rb") as fh:
                        data = fh.read()
                    text, kind, ok = extract(path, data)
                    kinds[kind] += 1
                    if not ok or not (text or "").strip():
                        files_skipped[level] += 1
                        skip_reasons[level][kind] += 1
                        continue
                    n = 0
                    seen = set()
                    for c in chunk(text, args.chunk_chars, args.min_chars):
                        k = c[:80].lower()
                        if k in seen:
                            continue
                        seen.add(k)
                        rows.append((c, level))
                        per_level[level] += 1
                        n += 1
                        if n >= args.max_rows_per_file:
                            break
                    files_ok[level] += 1
                except Exception as e:
                    files_skipped[level] += 1
                    skip_reasons[level]["error"] += 1
                    print(f"  ! {path}: {e}", file=sys.stderr)

    # de-dup across everything
    dedup, seen = [], set()
    for t, l in rows:
        k = (l, t[:120].lower())
        if k in seen:
            continue
        seen.add(k)
        dedup.append((t, l))

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["text", "label"])
        w.writerows(dedup)

    print("\n=== summary ===")
    for lvl in LEVELS:
        print(f"  {lvl:12s} files:{files_ok[lvl]:4d}  skipped:{files_skipped[lvl]:3d}  "
              f"rows:{per_level[lvl]:5d}"
              + (f"   (skips: {dict(skip_reasons[lvl])})" if skip_reasons[lvl] else ""))
    print(f"  extraction kinds: {dict(kinds)}")
    print(f"  WROTE {args.output}: {len(dedup)} rows total")
    present = [l for l in LEVELS if per_level[l]]
    if len(present) < 2:
        print("  ! need at least two levels with rows to retrain — add more documents.")
    elif min(per_level[l] for l in present) < 20:
        print("  ! some levels have very few rows (<20); add more for a reliable model.")


if __name__ == "__main__":
    main()
