#!/usr/bin/env python3
"""
Merge several text,label CSVs (e.g. the public training-real.csv + your own
training-mine.csv) into ONE balanced training file for the ML sensitivity
classifier.

  python3 merge_csv.py training-real.csv training-mine.csv -o training-merged.csv \
      --balance min --prefer training-mine.csv

What it does:
  * reads every input CSV (header text,label — or content/level etc.),
  * normalises labels to Public / Internal / Confidential / Restricted
    (case-insensitive, with synonyms; unknown labels are skipped and reported),
  * de-duplicates identical text across all files,
  * balances the four levels (see --balance / --per-level),
  * when a level has to be trimmed, keeps rows from --prefer'd files FIRST so
    your real documents survive over public filler,
  * writes a shuffled text,label CSV ready to upload at
    Enforce → ML Classifier → Retrain (or POST /api/v1/ml-classifier/retrain).

Stdlib only — runs anywhere.
"""
import argparse
import csv
import os
import re
import random
import sys
from collections import Counter, defaultdict

csv.field_size_limit(10_000_000)
random.seed(42)

LEVELS = ["Public", "Internal", "Confidential", "Restricted"]
ALIASES = {
    "public": "Public", "open": "Public", "unclassified": "Public",
    "internal": "Internal", "internal-use": "Internal", "internal_use": "Internal",
    "confidential": "Confidential", "sensitive": "Confidential", "private": "Confidential",
    "restricted": "Restricted", "secret": "Restricted", "pii": "Restricted",
    "regulated": "Restricted", "highly-confidential": "Restricted",
}
_ws = re.compile(r"\s+")
_HEADER_LABELS = {"label", "level", "classification", "sensitivity", "class"}


def norm_label(raw):
    return ALIASES.get((raw or "").strip().lower())


def clean(t):
    return _ws.sub(" ", str(t or "")).strip().strip('"')


def read_csv(path):
    """Yield (text, label) from a text,label CSV, skipping a header if present."""
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.reader(f))
    if not rows:
        return
    start = 0
    head = [c.strip().lower() for c in rows[0][:2]]
    if head and head[-1] in _HEADER_LABELS:
        start = 1
    for r in rows[start:]:
        if len(r) < 2:
            continue
        text, lvl = clean(r[0]), norm_label(r[-1])
        if text and lvl:
            yield text, lvl


def main():
    ap = argparse.ArgumentParser(description="Merge + balance text,label CSVs")
    ap.add_argument("inputs", nargs="+", help="input CSV files")
    ap.add_argument("-o", "--output", default="training-merged.csv")
    ap.add_argument("--balance", choices=["none", "min"], default="min",
                    help="'min' (default) trims every level to the smallest level's "
                         "count; 'none' keeps everything")
    ap.add_argument("--per-level", type=int, default=0,
                    help="explicit cap per level (overrides --balance)")
    ap.add_argument("--prefer", action="append", default=[],
                    help="input file whose rows are kept first when trimming "
                         "(repeatable) — e.g. your own documents")
    ap.add_argument("--min-chars", type=int, default=20, help="drop shorter rows")
    args = ap.parse_args()

    prefer = {os.path.abspath(p) for p in args.prefer}
    # by level: list of (text, is_preferred, source)
    by_level = defaultdict(list)
    per_file = Counter()
    seen = set()               # global text de-dup (first wins; preferred beat later dups)
    dups = 0
    skipped_short = 0

    # read preferred files FIRST so their rows win de-duplication
    ordered = sorted(args.inputs, key=lambda p: os.path.abspath(p) not in prefer)
    for path in ordered:
        if not os.path.isfile(path):
            print(f"  ! not found, skipping: {path}", file=sys.stderr)
            continue
        ap_ = os.path.abspath(path)
        is_pref = ap_ in prefer
        n = 0
        for text, lvl in read_csv(path):
            if len(text) < args.min_chars:
                skipped_short += 1
                continue
            key = text[:120].lower()
            if key in seen:
                dups += 1
                continue
            seen.add(key)
            by_level[lvl].append((text, is_pref, path))
            per_file[path] += 1
            n += 1
        print(f"  read {path}: {n} usable rows" + ("  [preferred]" if is_pref else ""))

    present = {l: v for l, v in by_level.items() if v}
    if len(present) < 2:
        sys.exit("need at least two levels with rows — check your inputs/labels")

    # target per level
    if args.per_level > 0:
        target = args.per_level
    elif args.balance == "min":
        target = min(len(v) for v in present.values())
    else:
        target = max(len(v) for v in present.values())  # effectively 'keep all'

    final = []
    report = {}
    for lvl in LEVELS:
        rows = present.get(lvl, [])
        if not rows:
            report[lvl] = 0
            continue
        pref = [r for r in rows if r[1]]
        rest = [r for r in rows if not r[1]]
        random.shuffle(pref)
        random.shuffle(rest)
        chosen = (pref + rest)[:target]          # preferred kept first when trimming
        report[lvl] = (len(chosen), sum(1 for r in chosen if r[1]))
        final += [(t, lvl) for t, _, _ in chosen]

    random.shuffle(final)
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["text", "label"])
        w.writerows(final)

    print("\n=== merged ===")
    print(f"  de-duplicated: {dups} rows   short-dropped: {skipped_short}")
    print(f"  target per level: {target}")
    for lvl in LEVELS:
        r = report.get(lvl, 0)
        if isinstance(r, tuple):
            print(f"  {lvl:12s} {r[0]:5d} rows   ({r[1]} from preferred files)")
        else:
            print(f"  {lvl:12s} {0:5d} rows   (none — level missing!)")
    if any(report.get(l, 0) == 0 for l in LEVELS):
        print("  ! at least one level has no rows; the model can't learn it.")
    print(f"  WROTE {args.output}: {len(final)} rows total")


if __name__ == "__main__":
    main()
