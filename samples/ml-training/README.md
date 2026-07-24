# Real training data for the ML sensitivity classifier

The built-in model ships trained on a small synthetic corpus. To fit **your**
content, retrain it on real labelled text. This folder builds a balanced
`text,label` training set from **public** datasets, mapped to the four DLP
sensitivity levels.

## What maps to what (weak supervision)

Each public dataset is used as a proxy for the *kind of language* a sensitivity
level contains. This is heuristic labelling, not ground truth — but it gives the
model real, diverse vocabulary far beyond the synthetic seed corpus.

| Level | Dataset | Why it fits | Field |
|------|---------|-------------|-------|
| **Public** | [`fancyzhx/ag_news`](https://huggingface.co/datasets/fancyzhx/ag_news) — public news articles | Published, non-sensitive prose | `text` |
| **Internal** | [`corbt/enron-emails`](https://huggingface.co/datasets/corbt/enron-emails) (cleaned [Enron corpus](https://www.kaggle.com/datasets/wcukierski/enron-email-dataset)) | Routine internal corporate email | `body` |
| **Confidential** | [`coastalcph/lex_glue`](https://huggingface.co/datasets/coastalcph/lex_glue) config `ledgar` — commercial contract clauses (from [CUAD](https://www.atticusprojectai.org/cuad)/EDGAR) | Contract/commercial language org keeps confidential | `text` |
| **Restricted** | [`ai4privacy/pii-masking-200k`](https://huggingface.co/datasets/ai4privacy/pii-masking-200k) — PII-laden sentences | SSNs, cards, credentials, medical → regulated/PII | `source_text` |

**Other real datasets you can add** (see the source list at the bottom):
SEC 10-K filings ([`JanosAudran/financial-reports-sec`](https://huggingface.co/datasets/JanosAudran/financial-reports-sec),
[`PleIAs/SEC`](https://huggingface.co/datasets/PleIAs/SEC)) for more Confidential
financial text; [`SecretBench`](https://arxiv.org/pdf/2303.06729) for hard-coded
credentials (Restricted).

## Build the CSV

```bash
python3 build_real_csv.py training-real.csv
# -> training-real.csv  (300 rows/level, 1,200 total, header: text,label)
```

Only needs Python stdlib + internet (pulls rows from the Hugging Face
datasets-server API). Edit `PER_LEVEL` to scale, or `SOURCES` to swap datasets.

## Best option: your own documents (`folder_to_csv.py`)

The public datasets above are a strong starting point, but a classifier tuned on
*your* files is far better. Sort a sample of real documents into per-level
folders and convert them — with the **same** PDF/DOCX/image-OCR extraction the
live DLP pipeline uses:

```
my-docs/
  Public/        press releases, public web/marketing, published docs
  Internal/      memos, meeting notes, routine email exports
  Confidential/  contracts, financials, business plans
  Restricted/    PII exports, credentials, medical, legal-privileged
```

Run it **inside the manager container** (so PDF/DOCX/OCR work):

```bash
docker cp ./my-docs cybersentinel-manager:/tmp/my-docs
docker cp samples/ml-training/folder_to_csv.py cybersentinel-manager:/tmp/f2c.py
docker exec -e PYTHONPATH=/app -w /app cybersentinel-manager \
    python3 /tmp/f2c.py /tmp/my-docs -o /tmp/training-mine.csv
docker cp cybersentinel-manager:/tmp/training-mine.csv ./training-mine.csv
```

It handles `.pdf` (text **and** OCR for scans), `.docx`, `.xlsx`, `.pptx`,
images (`.png/.jpg/.tiff` → OCR), `.txt/.md/.csv/.log/.json`, and archives.
Long documents are split into several snippets (one contract → many rows).
Folder names are case-insensitive with synonyms (`sensitive`→Confidential,
`secret/pii`→Restricted, …); use `--map "hr=Restricted,legal=Confidential"` for
custom names. Options: `--chunk-chars` (snippet size), `--min-chars`,
`--max-rows-per-file`. The summary reports per-level rows and any skipped/
unreadable files. Aim for a few dozen+ rows per level.

## Feed it to the model

**Dashboard (easiest):** *Enforce → ML Classifier → Retrain on your data* →
upload the CSV. Leave "train on my data only" unchecked to **merge** with the
built-in corpus (safest), or check it to train on your data alone.

**API:**
```bash
B64=$(base64 -w0 training-real.csv)
curl -X POST https://<host>/api/v1/ml-classifier/retrain \
  -H "Authorization: Bearer <admin-token>" -H "Content-Type: application/json" \
  -d "{\"csv_b64\":\"$B64\",\"replace\":false}"
```

Measured on this set: cross-validation accuracy rose from **0.86** (synthetic
only) to **0.98** (real only) / **0.96** (merged), with **zero** benign texts
confidently flagged sensitive.

## Important caveats

- **Heuristic labels.** The Enron corpus in particular contains some emails with
  financials/PII that are really Confidential/Restricted, not Internal — so the
  labels carry noise. Skim and trim before trusting in production; the closer the
  data is to *your* documents, the better.
- **Best of all: your own documents.** Replace any level with a folder of your
  real Public/Internal/Confidential/Restricted files and this becomes a genuinely
  tuned classifier. Same `text,label` format.
- **Licensing.** Upstream datasets carry their own licenses (AG News is
  non-commercial/research; Enron is public; lex_glue/LEDGAR is CC-BY; ai4privacy
  is synthetic). The generated CSV is **git-ignored** — regenerate it under those
  terms rather than redistributing. Review each license for your use.

## Sources
- Enron email corpus — https://www.kaggle.com/datasets/wcukierski/enron-email-dataset · https://huggingface.co/datasets/corbt/enron-emails
- ai4privacy PII masking — https://huggingface.co/datasets/ai4privacy/pii-masking-200k
- CUAD contracts — https://www.atticusprojectai.org/cuad · LEDGAR via https://huggingface.co/datasets/coastalcph/lex_glue
- AG News — https://huggingface.co/datasets/fancyzhx/ag_news
- SEC filings — https://huggingface.co/datasets/JanosAudran/financial-reports-sec · https://huggingface.co/datasets/PleIAs/SEC
- SecretBench (credentials) — https://arxiv.org/pdf/2303.06729
