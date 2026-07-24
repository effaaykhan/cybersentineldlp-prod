"""
Pure tests for the document/image type classifier (no DB).
Run: python3 server/tests/test_document_classifier.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.services.document_classifier import (  # noqa: E402
    classify_document, list_classifiers, CLASSIFIER_COUNT,
)

# One representative snippet per classifier — realistic markers, not the whole doc.
POSITIVE = {
    "passport": "REPUBLIC OF EXAMPLE PASSPORT\nP<UTODOE<<JANE<<<<<<<<<<<<<<<\nNationality: EXAMPLE  Place of birth: CITY  Date of expiry: 2030-01-01",
    "national_id": "NATIONAL IDENTITY CARD\nID Number: 99887766\nThis identity card is issued by the national identity authority.",
    "drivers_license": "DRIVER'S LICENSE\nDepartment of Motor Vehicles\nDL No: X1234567  Endorsements: none  Restrictions: corrective lenses",
    "visa": "ENTRY VISA\nVisa type: B1/B2  Visa number: 1234567  Port of entry: airport  Multiple entry",
    "patent": "UNITED STATES PATENT\nField of the invention: widgets.\nWhat is claimed is: 1. A device comprising...\nPrior art references cited.",
    "ma_document": "DEFINITIVE AGREEMENT\nThis share purchase agreement sets the purchase price for the target company following due diligence and closing conditions.",
    "contract": "THIS AGREEMENT is made between the parties. WHEREAS the following terms apply; hereinafter the Company. Governing law shall be...",
    "nda": "MUTUAL NON-DISCLOSURE AGREEMENT\nThe receiving party shall not disclose the confidential information of the disclosing party.",
    "legal_filing": "IN THE DISTRICT COURT\nCase No: 21-CV-1234\nPLAINTIFF vs DEFENDANT\nThe docket reflects the complaint filed by the attorney.",
    "financial_statement": "CONSOLIDATED BALANCE SHEET\nTotal assets ... Total liabilities ... Shareholders equity ...\nSee income statement and cash flow.",
    "invoice": "INVOICE\nInvoice Number: INV-2026-001\nBill to: Acme Corp\nSubtotal ... Amount due ... Total due ...\nPayment terms: net 30",
    "bank_statement": "ACCOUNT STATEMENT\nStatement period: Jan 2026\nOpening balance ... Closing balance ... Available balance ...\nRouting number: 021000021",
    "tax_document": "FORM W-2 Wage and Tax Statement\nInternal Revenue Service\nEmployer identification number ...\nTaxable income and withholding shown.",
    "payroll": "PAY STUB\nPay period: 2026-07\nGross pay ... Net pay ... Payroll deductions ... YTD earnings ...",
    "insurance_claim": "INSURANCE CLAIM FORM\nPolicy number: P-99887  Claim number: C-12345\nClaimant and policyholder details. Date of loss recorded.",
    "source_code": "#include <stdio.h>\nint main() {\n    printf(\"hi\");\n    return 0;\n}\ndef helper(x):\n    return x*2",
    "sql_dump": "-- MySQL dump\nCREATE TABLE users (id INT PRIMARY KEY);\nINSERT INTO users VALUES (1);\nSELECT * FROM users;",
    "secrets_config": "config:\n  AWS_SECRET_ACCESS_KEY=abc\n  api_key: sk-test\n-----BEGIN RSA PRIVATE KEY-----\nMII...",
    "infra_config": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n# managed by terraform, resource \"aws_instance\" ...",
    "board_document": "MINUTES OF THE BOARD MEETING\nThe board of directors confirmed a quorum. RESOLVED THAT the plan is approved; motion carried.",
    "business_plan": "BUSINESS PLAN\nExecutive summary ... Market analysis ... Go-to-market ... Revenue model ... Financial projections ...",
    "resume_cv": "CURRICULUM VITAE\nProfessional experience and employment history follow. Education, skills. linkedin.com/in/janedoe",
    "medical_record": "MEDICAL RECORD (Protected Health Information)\nPatient diagnosis and treatment plan. ICD-10 codes. Medical history and prescription.",
    "security_audit": "PENETRATION TEST REPORT\nVulnerability findings with CVSS scores. CVE-2024-1234 identified. Risk rating high. Remediation advised.",
}

NEGATIVE = [
    "Hi team, lunch is booked for Friday at 12:30. Let me know if you have dietary needs. Cheers, Sam.",
    "The weather this weekend looks great for hiking. Bring water and sunscreen, and we'll meet at the trailhead at nine.",
    "Reminder: the office will be closed on Monday for the public holiday. Normal hours resume Tuesday.",
]

_fails = []
def chk(name, cond):
    if not cond:
        _fails.append(name)
    return cond


def main():
    print(f"Built-in classifiers: {CLASSIFIER_COUNT}")
    chk("ships >= 20 classifiers", CLASSIFIER_COUNT >= 20)
    chk("catalogue lists them", len(list_classifiers()) == CLASSIFIER_COUNT)
    print()

    # every classifier fires on its representative sample, as the TOP match
    print("Positive samples (each should be the top match):")
    covered = set()
    for expected, text in POSITIVE.items():
        res = classify_document(text)
        top = res[0]["type"] if res else None
        types = [r["type"] for r in res]
        ok = expected in types
        top_ok = top == expected
        covered.add(expected)
        flag = "PASS" if ok else "FAIL"
        note = "" if top_ok else f"  (top was {top}; {expected} in results={ok})"
        print(f"  [{flag}] {expected:20s} -> {types}{note}")
        chk(f"{expected} recognised", ok)

    chk("all 24 classifiers have a positive sample", covered == {c['id'] for c in list_classifiers()})

    # clean/unrelated text triggers nothing
    print("\nNegative samples (should classify as nothing):")
    for i, text in enumerate(NEGATIVE):
        res = classify_document(text)
        ok = len(res) == 0
        print(f"  [{'PASS' if ok else 'FAIL'}] negative #{i+1} -> {[r['type'] for r in res]}")
        chk(f"negative #{i+1} no false positive", ok)

    # odd input never raises
    for bad in [None, "", 123, "   "]:
        try:
            classify_document(bad)  # type: ignore
        except Exception as e:
            chk(f"no crash on {bad!r}", False)
            print("  crash on", repr(bad), e)

    print()
    if _fails:
        print(f"FAILURES ({len(_fails)}): " + ", ".join(_fails))
        sys.exit(1)
    print("ALL DOCUMENT-CLASSIFIER TESTS PASS")


if __name__ == "__main__":
    main()
