"""
Pure regression tests for EDM + document fingerprinting (no DB).
Run: python3 server/tests/test_data_matching.py   (or under pytest)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.services.data_matching_service import (  # noqa: E402
    build_edm_index, match_edm,
    build_fingerprint_index, match_fp,
    keyed_digest, normalize_variants, derive_key,
)

KEY = b"deployment-secret-key-A"
OTHER_KEY = b"deployment-secret-key-B"

# A tiny protected dataset (the kind of CSV/DB export EDM protects).
ROWS = [
    {"first": "Jane",  "last": "Doe",     "ssn": "123-45-6789", "acct": "GB29-NWBK-6016"},
    {"first": "John",  "last": "Smith",   "ssn": "987-65-4321", "acct": "US44-BOFA-1234"},
    {"first": "Aisha", "last": "Khan",    "ssn": "555-11-2222", "acct": "IN99-HDFC-7777"},
]
COLS = ["first", "last", "ssn", "acct"]

_fails = []
def chk(name, cond):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    if not cond:
        _fails.append(name)


def test_edm():
    print("EDM — structured record matching")
    idx = build_edm_index(ROWS, COLS, KEY)

    # (1) one-way: the index holds NO plaintext, only hex digests.
    blob = repr(idx)
    leaked = [v for r in ROWS for v in r.values() if v.lower() in blob.lower()]
    chk("index contains no plaintext record values", not leaked)
    chk("index keys are keyed digests (hex, 32 chars)",
        all(len(h) == 32 and all(c in "0123456789abcdef" for c in h) for h in idx["cells"]))

    # (2) combination fires: name + ssn from the SAME row (default min_fields=2)
    m = match_edm("Please review account for Jane Doe, SSN 123-45-6789.", idx, KEY)
    chk("name + ssn (same row) -> MATCH", m["matched"] and m["rows"][0]["row_id"] == 0)
    chk("  ...reports which columns matched",
        set(m["rows"][0]["columns"]) >= {"first", "ssn"})

    # (3) NO false positive: a random SSN-shaped number not in the dataset
    m = match_edm("Random SSN 111-22-3333 and 444-55-6666 mentioned here.", idx, KEY)
    chk("random SSN-shaped numbers -> NO match", not m["matched"])

    # (4) a lone real value stays quiet at the default (needs corroboration)
    m = match_edm("The number 123-45-6789 appeared in a log.", idx, KEY)
    chk("lone real SSN at min_fields=2 -> NO match (needs a 2nd field)", not m["matched"])
    m1 = match_edm("The number 123-45-6789 appeared in a log.", idx, KEY, min_fields=1)
    chk("  ...but fires at min_fields=1 when policy wants single-value", m1["matched"])

    # (5) cross-row must NOT combine: ONE field from row 0 (acct) + ONE from
    # row 1 (ssn), nothing else. Neither row reaches 2 fields, so no match —
    # this is the property that stops unrelated values combining by accident.
    m = match_edm("reference GB29-NWBK-6016 then later code 987-65-4321", idx, KEY)
    chk("acct(row0) + ssn(row1), 1 field each -> NO match (no cross-row combine)",
        not m["matched"])

    # (6) separator / case tolerance: spaces instead of dashes, different case
    m = match_edm("aisha khan  555 11 2222", idx, KEY)
    chk("separator + case variants still match the record", m["matched"])

    # (6b) PUNCTUATION on values (real prose): "Doe," / "123-45-6789."
    m = match_edm("Audit note: Jane Doe, SSN 123-45-6789, flagged for review.", idx, KEY)
    chk("values with attached punctuation still match", m["matched"] and m["rows"][0]["row_id"] == 0)

    # (7) keyed: an index built under a DIFFERENT key cannot be matched with KEY
    idx_other = build_edm_index(ROWS, COLS, OTHER_KEY)
    m = match_edm("Jane Doe 123-45-6789", idx_other, KEY)
    chk("stolen index built under another key -> useless without that key", not m["matched"])
    chk("same value under different keys -> different digest",
        keyed_digest("jane doe", KEY) != keyed_digest("jane doe", OTHER_KEY))


def test_fingerprint():
    print("\nDocument fingerprinting — partial / edited-copy matching")
    secret_doc = (
        "CONFIDENTIAL BOARD MEMO. The acquisition of Northwind Traders will "
        "close in Q3 at a valuation of forty two million dollars. Financing is "
        "arranged through a syndicate led by our primary lender. Do not "
        "distribute this document outside the executive committee. Projected "
        "synergies exceed eight million dollars annually within two fiscal years."
    )
    idx = build_fingerprint_index(secret_doc, KEY)

    # one-way: no plaintext, only hex shingle digests
    blob = repr(idx["fp"])
    chk("fingerprint index contains no document text",
        "acquisition" not in blob and "Northwind" not in blob.lower())
    chk("fingerprints are hex digests", all(all(c in "0123456789abcdef" for c in h) for h in idx["fp"]))

    # exact document -> match
    chk("exact document -> MATCH", match_fp(secret_doc, idx, KEY)["matched"])

    # a PARAGRAPH lifted into an email body among unrelated text -> match
    email = (
        "Hi Bob, quick heads up before the call. "
        "The acquisition of Northwind Traders will close in Q3 at a valuation of "
        "forty two million dollars. Financing is arranged through a syndicate led "
        "by our primary lender. "
        "Anyway, let's sync tomorrow about the offsite. Thanks!"
    )
    r = match_fp(email, idx, KEY)
    chk(f"partial passage pasted into an email -> MATCH (overlap={r['overlap']})", r["matched"])

    # lightly EDITED copy (a few words changed) -> still match
    edited = secret_doc.replace("forty two million", "45 million").replace("Q3", "the third quarter")
    r = match_fp(edited, idx, KEY)
    chk(f"lightly edited copy -> MATCH (overlap={r['overlap']})", r["matched"])

    # unrelated document -> NO match
    unrelated = (
        "Weekly gardening notes. The tomatoes need more water this week and the "
        "basil is doing well. Remember to prune the roses before the weekend and "
        "pick up more mulch from the garden centre on Saturday morning."
    )
    r = match_fp(unrelated, idx, KEY)
    chk(f"unrelated document -> NO match (overlap={r['overlap']})", not r["matched"])

    # keyed: fingerprint index under another key can't be matched with KEY
    idx_other = build_fingerprint_index(secret_doc, OTHER_KEY)
    chk("fingerprint index under another key -> useless without that key",
        not match_fp(secret_doc, idx_other, KEY)["matched"])


def test_key_derivation():
    print("\nKey derivation (from deployment SECRET_KEY)")
    k1 = derive_key("secret-A-at-least-32-characters-long!!")
    k1b = derive_key("secret-A-at-least-32-characters-long!!")
    k2 = derive_key("secret-B-at-least-32-characters-long!!")
    chk("deterministic for a given secret", k1 == k1b)
    chk("different secret -> different key", k1 != k2)
    chk("key is 32 raw bytes", isinstance(k1, bytes) and len(k1) == 32)
    # domain separation: the derived key must not equal a naive HMAC someone
    # might reuse for another purpose with the same secret.
    import hmac as _h, hashlib as _hl
    naive = _h.new(b"secret-A-at-least-32-characters-long!!", b"", _hl.sha256).digest()
    chk("domain-separated from a naive same-secret HMAC", k1 != naive)
    # end-to-end: the derived key actually works for indexing/matching
    idx = build_edm_index(ROWS, COLS, k1)
    chk("derived key indexes + matches end to end",
        match_edm("Jane Doe 123-45-6789", idx, k1)["matched"])
    chk("...and a different derived key can't match that index",
        not match_edm("Jane Doe 123-45-6789", idx, k2)["matched"])


if __name__ == "__main__":
    test_edm()
    test_fingerprint()
    test_key_derivation()
    print()
    if _fails:
        print(f"FAILURES ({len(_fails)}): " + ", ".join(_fails))
        sys.exit(1)
    print("ALL DATA-MATCHING TESTS PASS")
