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
# Where a trained/retrained model is persisted. Lives on the mounted ml/models
# volume so a retrain survives restarts AND is picked up by every worker (each
# reloads when the file on disk is newer than what it holds).
MODEL_PATH = os.getenv("DLP_ML_MODEL_PATH", "/app/ml/models/ml_sensitivity_model.joblib")

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
        'Our mobile app update adds dark mode and faster search; download it from the app store today.',
        'Case study: how a nonprofit used our tools to run their fundraising campaign.',
        'Public webinar recording: getting started with the platform in thirty minutes.',
        'Meet the team page introducing our founders and their background in the industry.',
        'The community forum is open for questions, feature requests, and show-and-tell posts.',
        'Our sustainability report highlights recycling initiatives and volunteering hours this year.',
        'Product comparison chart showing the features included in each public pricing tier.',
        "Event recap: photos and highlights from last month's public meetup and hackathon.",
        'Tutorial: how to embed a public share link in your website in three steps.',
        'Our accessibility statement describes how the public site meets web content guidelines.',
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
        'Internal FYI: the VPN maintenance window is Saturday; expect brief disconnects.',
        'Please book meeting rooms through the internal calendar and release them if plans change.',
        "Team lunch survey: vote for the cuisine and dietary options for next month's social.",
        'Internal process update: expense approvals now route through the new workflow tool.',
        'Quarterly OKR check-in template attached; fill it in before your one-on-one.',
        'Reminder to rotate on-call duties next week and update the internal schedule.',
        'Internal newsletter: shout-outs, new hires, and upcoming learning sessions.',
        'The support team is piloting a new triage rota; feedback goes to the team lead.',
        'Draft internal runbook for the migration; review comments due Thursday.',
        'Office move logistics: desk assignments and packing instructions for the team.',
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
        'Confidential deal memo summarising valuation, financing structure, and expected close.',
        'The commission plan and quota assignments for the sales org, not for wider circulation.',
        'Internal audit of gross margin by product line, treated as commercially sensitive.',
        'Confidential customer churn analysis with named accounts at risk of non-renewal.',
        'Board pre-read on the annual budget, headcount plan, and capital allocation.',
        'Confidential partnership terms including revenue share and exclusivity clauses.',
        "The pricing committee's confidential floor prices and approval thresholds by segment.",
        'Confidential product cost model and supplier margin negotiations.',
        'Draft earnings commentary with unpublished revenue and guidance figures.',
        'Confidential due-diligence data room index for the potential investment.',
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
        'Restricted: full export of member records with SSN, date of birth, and home address.',
        'Service account credentials, root password, and the signing key for release artifacts.',
        'Confidential settlement agreement with the plaintiff and the sealed damages figure.',
        'Genetic test results and mental-health notes constituting protected health information.',
        "Wire instructions with the beneficiary bank account and the executive's authorization.",
        'Restricted board deck: the acquisition target, offer price, and financing commitments.',
        'Encrypted keystore passphrase and the OAuth client secret for the payment gateway.',
        'Cardholder data including PAN, expiry, and CVV captured from the checkout logs.',
        'Employee visa, passport scan, and tax identification numbers for immigration filing.',
        'Privileged legal opinion on the regulatory investigation and potential liability.',
    ],
}

_model = None
_lock = threading.Lock()
_tried = False
_meta: Dict[str, Any] = {"trained_on": "synthetic", "counts": {}, "cv_accuracy": None, "source": "corpus"}
_loaded_mtime = 0.0


def _build_pipeline():
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    return Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True,
                                  strip_accents="unicode", lowercase=True)),
        ("clf", LogisticRegression(max_iter=2000, C=6.0, class_weight="balanced")),
    ])


def _flatten(corpus: Dict[str, List[str]]):
    X, y = [], []
    for level, docs in corpus.items():
        for d in docs:
            X.append(d)
            y.append(level)
    return X, y


def _fit(corpus: Dict[str, List[str]]):
    X, y = _flatten(corpus)
    pipe = _build_pipeline()
    pipe.fit(X, y)
    return pipe


def _counts(corpus: Dict[str, List[str]]) -> Dict[str, int]:
    return {lvl: len(corpus.get(lvl, []) or []) for lvl in LEVELS}


def cross_val_accuracy(corpus: Optional[Dict[str, List[str]]] = None, folds: int = 5):
    """Stratified k-fold cross-validation accuracy — an honest estimate of how
    the model generalises to unseen text of the same kind. Returns None if it
    cannot be computed (too few samples / sklearn missing)."""
    try:
        from sklearn.model_selection import cross_val_score, StratifiedKFold
        import numpy as np
        corpus = corpus or _CORPUS
        X, y = _flatten(corpus)
        nonempty = [len(v) for v in corpus.values() if v]
        if len(nonempty) < 2 or min(nonempty) < 2:
            return None
        k = max(2, min(folds, min(nonempty)))
        skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
        scores = cross_val_score(_build_pipeline(), X, y, cv=skf)
        return round(float(np.mean(scores)), 3)
    except Exception:
        return None


def _save(pipe, meta) -> bool:
    try:
        import joblib
        d = os.path.dirname(MODEL_PATH)
        if d:
            os.makedirs(d, exist_ok=True)
        joblib.dump({"pipe": pipe, "meta": meta}, MODEL_PATH)
        return True
    except Exception:
        return False


def _load_from_disk():
    try:
        if not os.path.exists(MODEL_PATH):
            return None
        import joblib
        return joblib.load(MODEL_PATH)
    except Exception:
        return None


def _get_model():
    """Return the trained pipeline, training/loading it once. If another worker
    has written a NEWER model to disk (e.g. via retrain), reload it so a retrain
    propagates across the whole fleet without a restart."""
    global _model, _tried, _meta, _loaded_mtime
    try:
        if os.path.exists(MODEL_PATH):
            mt = os.path.getmtime(MODEL_PATH)
            if mt > _loaded_mtime:
                blob = _load_from_disk()
                if blob and blob.get("pipe") is not None:
                    with _lock:
                        _model = blob["pipe"]
                        _meta = blob.get("meta", _meta)
                        _loaded_mtime = mt
                    return _model
    except Exception:
        pass
    if _model is not None:
        return _model
    if _tried:
        return None
    with _lock:
        if _model is None and not _tried:
            _tried = True
            try:
                blob = _load_from_disk()
                if blob and blob.get("pipe") is not None:
                    _model = blob["pipe"]
                    _meta = blob.get("meta", _meta)
                    try:
                        _loaded_mtime = os.path.getmtime(MODEL_PATH)
                    except Exception:
                        pass
                else:
                    _model = _fit(_CORPUS)
                    _meta = {"trained_on": "synthetic", "counts": _counts(_CORPUS),
                             "cv_accuracy": cross_val_accuracy(_CORPUS), "source": "corpus"}
                    if _save(_model, _meta):
                        try:
                            _loaded_mtime = os.path.getmtime(MODEL_PATH)
                        except Exception:
                            pass
            except Exception:
                _model = None
    return _model


def retrain(corpus: Dict[str, List[str]], replace: bool = False) -> Dict[str, Any]:
    """Retrain on YOUR labelled examples ({level: [texts]}).

    replace=False (default) MERGES your data with the built-in corpus — safest,
    keeps broad coverage while learning your vocabulary. replace=True trains on
    ONLY your data. The result is persisted (survives restarts, propagates to
    every worker) and evaluated with cross-validation. Returns a status dict.
    """
    global _model, _meta, _loaded_mtime, _tried
    try:
        clean = {lvl: [t for t in (corpus.get(lvl) or []) if t and t.strip()] for lvl in LEVELS}
        if replace:
            base, source = clean, "custom"
        else:
            base = {lvl: list(_CORPUS.get(lvl, [])) + clean.get(lvl, []) for lvl in LEVELS}
            source = "synthetic+custom"
        nonempty = [lvl for lvl in LEVELS if base.get(lvl)]
        if len(nonempty) < 2:
            return {"ok": False, "error": "need labelled examples for at least two levels"}
        with _lock:
            pipe = _fit(base)
            cv = cross_val_accuracy(base)
            meta = {"trained_on": source, "counts": _counts(base),
                    "custom_counts": _counts(clean), "cv_accuracy": cv, "source": source}
            _model = pipe
            _meta = meta
            _tried = True
            persisted = _save(pipe, meta)
            if persisted:
                try:
                    _loaded_mtime = os.path.getmtime(MODEL_PATH)
                except Exception:
                    pass
        return {"ok": True, "persisted": persisted, **meta}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def reset_to_default() -> Dict[str, Any]:
    """Discard a custom model and retrain from the built-in corpus."""
    global _model, _meta, _tried, _loaded_mtime
    try:
        if os.path.exists(MODEL_PATH):
            os.remove(MODEL_PATH)
    except Exception:
        pass
    with _lock:
        _model = _fit(_CORPUS)
        _meta = {"trained_on": "synthetic", "counts": _counts(_CORPUS),
                 "cv_accuracy": cross_val_accuracy(_CORPUS), "source": "corpus"}
        _tried = True
        if _save(_model, _meta):
            try:
                _loaded_mtime = os.path.getmtime(MODEL_PATH)
            except Exception:
                pass
    return model_status()


def model_status() -> Dict[str, Any]:
    """Everything the UI/API needs to show the model's state and quality."""
    m = _get_model()
    return {
        "available": bool(m is not None and ENABLED),
        "enabled": ENABLED,
        "model": "tfidf+logreg",
        "levels": LEVELS,
        "min_confidence": MIN_CONFIDENCE,
        "trained_on": _meta.get("trained_on"),
        "counts": _meta.get("counts", {}),
        "custom_counts": _meta.get("custom_counts", {}),
        "cv_accuracy": _meta.get("cv_accuracy"),
        "persisted": os.path.exists(MODEL_PATH),
        "model_path": MODEL_PATH,
    }


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
            "trained_on": _meta.get("trained_on", "synthetic"),
        }
    except Exception:
        return None
