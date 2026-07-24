"""
Tests for the ML sensitivity classifier. Needs scikit-learn; skips cleanly if
absent so it never breaks a slim environment. Run in the manager image where
sklearn is installed.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.services.ml_classifier import predict_level, is_available  # noqa: E402

_fails = []
def chk(name, cond):
    if not cond:
        _fails.append(name)


HELD_OUT = [
    ("Public", "Check out our summer sale with discounts on all outdoor gear this weekend."),
    ("Public", "Thanks for visiting our booth at the expo — here is a recap of the demos."),
    ("Internal", "Sprint retro is moved to Friday; please add blockers to the shared board."),
    ("Internal", "Heads up team, the kitchen restocks Monday and parking is limited this week."),
    ("Confidential", "The renewal contract lists negotiated pricing and discount terms for the account."),
    ("Restricted", "The private key and production database password are pasted below for the deploy."),
    ("Restricted", "Here is the customer's SSN 555-11-2222 and their credit card number for the refund."),
]

BENIGN = [
    "Lunch is booked for Friday at noon, let me know your dietary preferences.",
    "The weather looks great for the weekend hike, bring water and sunscreen.",
    "Our new blog post shares five productivity tips for remote workers.",
]


def main():
    if not is_available():
        print("scikit-learn not available — skipping ML classifier tests")
        return
    print("ML sensitivity classifier")

    # held-out accuracy (allow one miss — synthetic corpus, borderline cases)
    correct = 0
    for exp, text in HELD_OUT:
        r = predict_level(text)
        if r and r["level"] == exp:
            correct += 1
    chk("held-out accuracy >= 6/7", correct >= 6)
    print(f"  held-out accuracy: {correct}/{len(HELD_OUT)}")

    # shape of the result
    r = predict_level("Employee SSN 123-45-6789 and bank account details attached.")
    chk("returns level/confidence/probabilities",
        r and "level" in r and "confidence" in r and "probabilities" in r)
    chk("sensitive content -> not Public", r and r["level"] != "Public")

    # THE false-positive guard: benign text is never CONFIDENTLY sensitive
    fp = 0
    for t in BENIGN:
        r = predict_level(t)
        if r and r["confident"] and r["level"] in ("Confidential", "Restricted"):
            fp += 1
    chk("no benign text confidently flagged sensitive", fp == 0)
    print(f"  benign confidently-sensitive: {fp} (want 0)")

    # robustness
    for bad in [None, "", "   "]:
        try:
            predict_level(bad)  # type: ignore
        except Exception:
            chk(f"no crash on {bad!r}", False)

    if _fails:
        print("FAILURES: " + ", ".join(_fails))
        sys.exit(1)
    print("ALL ML CLASSIFIER TESTS PASS")


if __name__ == "__main__":
    main()
