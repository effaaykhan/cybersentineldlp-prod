#!/usr/bin/env python3
"""
Build a REAL, balanced text,label training set for the DLP ML sensitivity
classifier by pulling rows from public Hugging Face datasets via the
datasets-server API. Weak-supervision mapping (dataset nature -> DLP level):

  Public       <- fancyzhx/ag_news            (public news articles)      field: text
  Internal     <- corbt/enron-emails          (internal corporate email)  field: body
  Confidential <- coastalcph/lex_glue [ledgar](commercial contract clauses)field: text
  Restricted   <- ai4privacy/pii-masking-200k (PII-laden sentences)        field: source_text

This is heuristic labelling, not ground truth — but it gives the model real,
diverse vocabulary per level. Review/trim before trusting in production.
"""
import csv, json, re, sys, time, urllib.parse, urllib.request, random

random.seed(42)
BASE = "https://datasets-server.huggingface.co/rows"
PER_LEVEL = 300
_ws = re.compile(r"\s+")
_quoted = re.compile(r"^\s*>.*$", re.M)          # quoted email reply lines

def fetch(dataset, config, split, offset, length=100):
    q = urllib.parse.urlencode({"dataset": dataset, "config": config,
                                "split": split, "offset": offset, "length": length})
    url = f"{BASE}?{q}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r).get("rows", [])
        except Exception as e:
            time.sleep(1.5 * (attempt + 1))
    print(f"  ! giving up on {dataset} offset {offset}: {e}", file=sys.stderr)
    return []

def clean(t):
    if not t:
        return ""
    t = _quoted.sub(" ", str(t))                 # drop quoted reply lines
    t = _ws.sub(" ", t).strip().strip('"')
    return t

def collect(dataset, config, split, field, lo, hi, want, lang_field=None):
    out, seen, offset = [], set(), 0
    while len(out) < want and offset < 4000:
        rows = fetch(dataset, config, split, offset)
        if not rows:
            break
        for r in rows:
            row = r.get("row", {})
            if lang_field and row.get(lang_field) not in (None, "en", "English"):
                continue
            t = clean(row.get(field, ""))
            if not (lo <= len(t) <= hi):
                continue
            key = t[:80].lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(t)
            if len(out) >= want:
                break
        offset += 100
        print(f"  {dataset:32s} collected {len(out)}/{want}")
    return out

SOURCES = [
    ("Public",       "fancyzhx/ag_news",            "default", "train", "text",        60, 500),
    ("Internal",     "corbt/enron-emails",          "default", "train", "body",        80, 700),
    ("Confidential", "coastalcph/lex_glue",         "ledgar",  "train", "text",        80, 700),
    ("Restricted",   "ai4privacy/pii-masking-200k", "default", "train", "source_text", 40, 600),
]

def main():
    rows = []
    for level, ds, cfg, split, field, lo, hi, *rest in SOURCES:
        lang = "language" if ds.startswith("ai4privacy") else None
        print(f"[{level}] {ds}")
        texts = collect(ds, cfg, split, field, lo, hi, PER_LEVEL, lang_field=lang)
        rows += [(t, level) for t in texts]
    random.shuffle(rows)
    out_path = sys.argv[1] if len(sys.argv) > 1 else "training-real.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["text", "label"])
        w.writerows(rows)
    from collections import Counter
    c = Counter(l for _, l in rows)
    print("\nWROTE", out_path, "->", dict(c), "total", len(rows))

if __name__ == "__main__":
    main()
