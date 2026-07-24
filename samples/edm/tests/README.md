# EDM test files — what blocks and what doesn't

Nine files that exercise Exact Data Matching against `../customers-sample.csv`.
Every "block" result below was **verified through the real extraction +
classification pipeline** (the same path a USB/cloud/email transfer takes).

**Setup:** register `../customers-sample.csv` in Dashboard → Enforce → Data
Matching → Exact Data Match, with **fields required to match = 2**. Then copy
each file to a monitored USB (or email/upload it) and watch the result.

They use three real rows from the dataset: **Jane Doe**, **John Smith**,
**Aisha Khan**.

| # | File | Result | Why |
|---|---|---|---|
| 01 | `01-real-records-no-patterns.txt` | **BLOCK** (EDM) | Real records as **name + account + DOB only — no SSN/card**. Regex sees nothing; EDM recognises your customers. *This is the file that shows what EDM adds.* |
| 02 | `02-real-record-in-email.txt` | **BLOCK** (EDM) | One real customer + account buried in an ordinary email body. |
| 03 | `03-real-records-full.csv` | **BLOCK** (EDM) | Real records with every column (incl. SSN/card). Raw comma-packed CSV — EDM still matches the cells. |
| 04 | `04-real-records.docx` | **BLOCK** (EDM) | Real records in a Word doc — proves EDM works through document extraction. |
| 05 | `05-real-records.xlsx` | **BLOCK** (EDM) | Real records in a spreadsheet. |
| 06 | `06-fake-records-no-patterns.txt` | **allow** | **Same shape as 01 but made-up** names/accounts/DOBs. Not your data → not blocked. This is EDM's precision: no false positives on look-alikes. |
| 07 | `07-single-field-only.txt` | **allow** | A single real value (one account number) alone. Below the 2-field rule — one value isn't enough to identify a record. |
| 08 | `08-cross-record-mix.txt` | **allow** | Two values, but from **different** records (no two fields of one record together). EDM won't combine across records. |
| 09 | `09-clean-content.txt` | **allow** | Ordinary text, no protected data. |

## The comparison that makes EDM click

Copy **01** and **06** to the USB:
- **01 blocks** — real customers, even though there's not a single SSN or credit
  card in the file. Regex would have let this walk out.
- **06 doesn't** — identical format, but the names/accounts are invented.

Same shape, opposite outcome. Regex can't tell them apart; EDM blocks *your*
data and ignores the look-alike. That difference — plus catching data with **no
pattern at all** (account numbers, customer IDs, names) — is what EDM adds on top
of regex.

> All data here is synthetic. Never load real customer data into a test lab.
