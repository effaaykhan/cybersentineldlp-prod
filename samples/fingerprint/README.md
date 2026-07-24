# Document fingerprinting test set

`board-memo-SOURCE.txt` is a **synthetic confidential memo** (Project Meridian —
a fake acquisition briefing). It contains **no SSNs, cards, or any regex-
detectable pattern** — it's just prose, which is exactly the point: regex can't
protect a document like this, fingerprinting can.

The `tests/` files show what fingerprinting catches once you register the memo.
Every result below was **verified through the real extraction + classification
pipeline** (the same path a USB/cloud/email transfer takes).

## Setup

1. Dashboard → **Enforce → Data Matching → New source → Fingerprint (document)**.
2. Upload `board-memo-SOURCE.txt` (or paste it). Leave defaults
   (min overlapping shingles = 4, containment = 0.25).
3. **Index source.** The memo text is hashed into shingle digests and discarded.
4. Copy each `tests/` file to a monitored USB (or email/upload it).

## Results (verified)

| # | File | Result | Signal | Why |
|---|---|---|---|---|
| 01 | `01-exact-copy.txt` | 🔴 **BLOCK** | overlap 92 · containment 100% | The whole document |
| 02 | `02-paragraph-in-email.txt` | 🔴 **BLOCK** | overlap 16 · 64% | **One paragraph** lifted into an ordinary email — this is the real leak vector |
| 03 | `03-lightly-edited.txt` | 🔴 **BLOCK** | overlap 74 · 85% | Numbers reworded, a sentence changed — survives edits |
| 04 | `04-short-quote.txt` | 🔴 **BLOCK** | overlap 10 · 76% | Even two distinctive sentences match |
| 05 | `05-heavily-paraphrased.txt` | 🟢 **allow** | — | Same *meaning*, entirely reworded. Fingerprinting matches **text, not meaning** — see the limitation below |
| 06 | `06-unrelated-document.txt` | 🟢 **allow** | — | A different confidential-looking memo — not this document |
| 07 | `07-exact-copy.docx` | 🔴 **BLOCK** | overlap 92 · 100% | Same content in Word — proves it works through document extraction |

## What this shows

- Fingerprinting catches **partial and edited copies**, not just byte-identical
  files. A single pasted paragraph (02) is blocked.
- It fires on prose with **no pattern at all** — regex would pass every one of
  these. This is what fingerprinting adds.
- **The honest limitation (05):** it matches the actual words. A human who
  *rewrites* the content from scratch produces no shared shingles and is not
  caught. Fingerprinting stops copy/paste and edit-and-send — the common cases —
  not deliberate re-authoring. (Regex/EDM don't catch a paraphrase either; no
  content-inspection DLP does.)

## Tuning

- Blocking short quotes too aggressively (04)? Raise **min overlapping shingles**
  (e.g. to 12) so only larger excerpts trip it.
- Want to catch even smaller snippets? Lower it. Use the **Test content** panel
  to see the overlap/containment for any text before committing a threshold.

> All content is synthetic. Never register real confidential documents in a test lab.
