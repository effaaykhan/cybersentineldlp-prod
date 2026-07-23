# EDM sample dataset

`customers-sample.csv` — **40 synthetic customer records** for testing Exact Data
Matching (EDM). Every value here is randomly generated and fake; there is no real
PII in this file. Use it to see EDM block real-record leaks without exposing
actual data.

Columns: `first_name, last_name, ssn, credit_card, account_number, email, phone, date_of_birth`

## Download it

From GitHub (raw):
```
https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/samples/edm/customers-sample.csv
```
or on any box with the repo:
```bash
curl -O https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/samples/edm/customers-sample.csv
```

## Register it in the DLP

1. Dashboard → **Enforce → Data Matching → New source → Exact Data Match**.
2. Upload `customers-sample.csv` (or paste its contents).
3. Leave **columns** blank to index all, and **fields required to match = 2**.
4. **Index source.** The server hashes it and discards the plaintext — only keyed
   one-way digests are stored.

## Prove it works — paste these into "Test content"

These use real rows from the dataset, so they SHOULD match (each has ≥2 fields of
one record):

- `Please review Jane Doe, SSN 736-47-6840, before the audit.`
  → matches (first_name + last_name + ssn, one record)
- `Wire the funds to account ACCT-33254575 for John Smith.`
  → matches (account_number + first/last, one record)
- `Card on file for aisha.khan2@example.com is 1284 5279 2996 5454`
  → matches (email + credit_card, one record)

These should **NOT** match (no real record / only one field):

- `Random test SSN 111-22-3333 in a log file.`
  → no match — not in the dataset (this is EDM's whole point vs. regex)
- `The number 736-47-6840 appeared once.`
  → no match at "2 fields required" — a lone value needs a corroborating field

## End-to-end block test

Put a couple of real records into a file and copy it to a USB, or email it through
the relay — the transfer is blocked and the event shows
`Detected: EDM: <source name> (N record(s))`.

> Reminder: this is fake data purely for demonstrating detection. Do not add real
> customer data to a test/lab deployment.
