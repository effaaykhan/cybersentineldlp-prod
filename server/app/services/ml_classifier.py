"""
ML-based sensitivity classifier — predicts Public / Internal / Confidential /
Restricted for a piece of content.

This is a genuine machine-learning model (TF-IDF features + multinomial logistic
regression, scikit-learn). It learns the vocabulary that distinguishes each
sensitivity tier and returns a predicted level with a probability.

ADDITIVE and SAFE:
  * It never replaces the existing regex / EDM / fingerprint detection — the
    caller combines results by taking the STRONGER level, so ML can only add
    protection, never weaken it.
  * It is guarded end-to-end: if scikit-learn is missing or training fails,
    predict_level() returns None and the pipeline behaves exactly as before.

HONEST LIMITATION: the bundled model is trained on a curated SYNTHETIC corpus
(below). That makes it work out-of-the-box for common cases, but for production
accuracy it should be retrained on YOUR labelled documents — the training data is
a plain dict here, and retrain() accepts your own examples. Treat the shipped
model as a strong starting point, not a finished, tuned classifier.
"""
from __future__ import annotations

import os
import threading
from typing import Any, Dict, List, Optional

LEVELS = ["Public", "Internal", "Confidential", "Restricted"]
LEVEL_ORDER = {lvl: i for i, lvl in enumerate(LEVELS)}

ENABLED = os.getenv("DLP_ML_CLASSIFIER_ENABLED", "1").lower() not in ("0", "false", "no")
# Below this probability the prediction is reported but the caller should not act
# on it (keeps a low-confidence guess from raising the enforced level).
MIN_CONFIDENCE = float(os.getenv("DLP_ML_MIN_CONFIDENCE", "0.60"))
MAX_CHARS = int(os.getenv("DLP_ML_MAX_CHARS", "50000"))

# ── Training corpus (synthetic; retrain on real data for production) ────────
_CORPUS: Dict[str, List[str]] = {
    "Public": [
        "We're excited to announce the launch of our new product line, available nationwide this fall.",
        "Our company was founded with a mission to make technology accessible to everyone.",
        "Join us for our annual community open day featuring workshops, food, and live music.",
        "This user guide explains how to reset your password and update your profile settings.",
        "Press release: the firm's charitable foundation donated to local schools this year.",
        "Our blog covers tips for productivity, remote work, and healthy habits for professionals.",
        "Careers: we are hiring for several open positions. Visit our website to learn more and apply.",
        "Frequently asked questions about shipping, returns, and warranty coverage for our products.",
        "The conference agenda includes keynote talks, breakout sessions, and networking opportunities.",
        "Welcome to our help center. Browse articles or contact support for assistance.",
        "Read our latest customer success story about how the platform improved their workflow.",
        "The public roadmap highlights features we plan to release to all users next quarter.",
        "Download the free trial and explore the product with sample data and tutorials.",
        "Our newsletter shares industry news, event invitations, and community highlights each month.",
        "Terms of service and privacy policy for visitors to our public marketing website.",
    ],
    "Internal": [
        "Team, please submit your timesheets by Friday. The office is closed on the public holiday.",
        "Meeting notes: we discussed the sprint backlog, assigned tasks, and set the next review for Tuesday.",
        "The internal wiki has been updated with the new onboarding checklist for engineering hires.",
        "Reminder: the all-hands meeting is scheduled for Thursday at 3pm in the main conference room.",
        "Ops update: the deployment window is moved to Saturday night to reduce customer impact.",
        "Please review the draft agenda for next week's planning session and add your items.",
        "The facilities team will test the fire alarm on Wednesday morning; no action needed.",
        "Project status: on track for the milestone; two tickets remain in review before release.",
        "Internal announcement: welcome our new colleagues joining the support and sales teams.",
        "The style guide for internal documentation has moved to the shared drive under templates.",
        "Weekly standup summary: blockers, progress, and priorities for the coming week.",
        "Please update your emergency contact details in the internal HR portal by end of month.",
        "Engineering handbook: branching strategy, code review checklist, and release process.",
        "The travel and expense policy for staff has minor updates effective next pay period.",
        "Reminder to complete the mandatory internal security awareness training module.",
    ],
    "Confidential": [
        "The quarterly financial statement shows total revenue, operating expenses, and net margin by region.",
        "This business plan outlines our go-to-market strategy, revenue projections, and competitive analysis.",
        "The customer account list includes company names, contract values, and renewal dates.",
        "Employee compensation review: salary bands, bonus targets, and equity grants by level.",
        "The master service agreement sets pricing, payment terms, and confidentiality obligations.",
        "Strategic roadmap: our confidential three-year plan to enter new markets and expand the portfolio.",
        "The vendor contract includes negotiated discounts and exclusive terms not to be shared externally.",
        "HR memo regarding the reorganization, affected roles, and severance packages under discussion.",
        "Internal forecast of pipeline, churn, and margin that must not leave the finance team.",
        "Confidential pricing model and discount approval thresholds for the enterprise sales team.",
        "Supplier cost breakdown and margin analysis considered commercially sensitive.",
        "Draft investor update with unaudited revenue figures and customer concentration risk.",
        "Confidential product strategy comparing our roadmap against competitor capabilities.",
        "Partner agreement with revenue-share percentages and confidential joint-development plans.",
        "Company financial projections and budget allocations for the upcoming fiscal year.",
    ],
    "Restricted": [
        "Employee record: name Jane Doe, SSN 123-45-6789, date of birth, home address, and bank account.",
        "The AWS secret access key and the production database password are stored in this configuration.",
        "Confidential board briefing on the proposed acquisition, purchase price, and due diligence findings.",
        "Patient medical record with diagnosis, treatment plan, prescriptions, and protected health information.",
        "Attorney-client privileged litigation strategy and settlement figures for the pending lawsuit.",
        "Passport number, national identity number, and credit card details for the executive team.",
        "The merger agreement's confidential terms, escrow arrangements, and closing conditions.",
        "Private key material and API tokens granting administrative access to production systems.",
        "Full customer database export including social security numbers and payment card data.",
        "Board resolution approving the definitive acquisition agreement and financing package.",
        "Credentials file: username, password, private key, and bearer token for the admin account.",
        "Payroll export listing every employee's salary, tax id, and direct-deposit bank details.",
        "Restricted: personally identifiable information including SSN, DOB, and driver's license numbers.",
        "Source code containing a hard-coded private key and the master encryption secret.",
        "Health insurance claims with diagnosis codes, member ids, and protected health information.",
    ],
}

_model = None
_lock = threading.Lock()
_tried = False
_trained_on = "synthetic"


def _build_pipeline():
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    return Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True,
                                  strip_accents="unicode", lowercase=True)),
        ("clf", LogisticRegression(max_iter=2000, C=6.0, class_weight="balanced")),
    ])


def _fit(corpus: Dict[str, List[str]]):
    X, y = [], []
    for level, docs in corpus.items():
        for d in docs:
            X.append(d)
            y.append(level)
    pipe = _build_pipeline()
    pipe.fit(X, y)
    return pipe


def _get_model():
    global _model, _tried
    if _model is not None:
        return _model
    if _tried:
        return None
    with _lock:
        if _model is None and not _tried:
            _tried = True
            try:
                _model = _fit(_CORPUS)
            except Exception:
                _model = None
    return _model


def retrain(corpus: Dict[str, List[str]]) -> bool:
    """Retrain on YOUR labelled examples ({level: [texts]}). Returns success."""
    global _model, _trained_on
    try:
        merged = {lvl: list(_CORPUS.get(lvl, [])) + list(corpus.get(lvl, [])) for lvl in LEVELS}
        with _lock:
            _model = _fit(merged)
            _trained_on = "synthetic+custom"
        return True
    except Exception:
        return False


def is_available() -> bool:
    return ENABLED and _get_model() is not None


def predict_level(text: str) -> Optional[Dict[str, Any]]:
    """Predict the sensitivity level of `text`.

    Returns {level, confidence, confident (bool), probabilities, model} or None
    when disabled / unavailable / no text. `confident` is True when confidence
    >= MIN_CONFIDENCE — the caller should only let ML RAISE the enforced level
    when confident.
    """
    if not ENABLED or not text or not text.strip():
        return None
    model = _get_model()
    if model is None:
        return None
    try:
        import numpy as np
        sample = text[:MAX_CHARS]
        proba = model.predict_proba([sample])[0]
        classes = list(model.classes_)
        idx = int(np.argmax(proba))
        level = classes[idx]
        conf = float(proba[idx])
        return {
            "level": level,
            "confidence": round(conf, 3),
            "confident": conf >= MIN_CONFIDENCE,
            "probabilities": {c: round(float(p), 3) for c, p in zip(classes, proba)},
            "model": "tfidf+logreg",
            "trained_on": _trained_on,
        }
    except Exception:
        return None
