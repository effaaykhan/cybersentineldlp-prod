"""
ML sensitivity classifier — management API.

Lets an admin RETRAIN the automatic Public/Internal/Confidential/Restricted
classifier on real labelled documents, inspect its quality, test a prediction,
and reset to the built-in model. Retraining is additive to the running system:
the model only ever RAISES the enforced level in the pipeline, never lowers it,
so retraining can improve coverage but cannot weaken existing detection.

Feed training data either as JSON ({level: [texts]}) or by uploading a CSV whose
rows are `text,label` (label is one of the four levels, case-insensitive).
"""
import base64
import binascii
import csv
import io
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
import structlog

from app.core.security import require_role
from app.services import ml_classifier as mlc

logger = structlog.get_logger()
router = APIRouter()

_LEVEL_ALIASES = {lvl.lower(): lvl for lvl in mlc.LEVELS}


def _normalize_level(raw: str) -> Optional[str]:
    return _LEVEL_ALIASES.get((raw or "").strip().lower())


class RetrainRequest(BaseModel):
    examples: Optional[Dict[str, List[str]]] = Field(
        None, description="Labelled data as {level: [texts]}. Levels: "
                          "Public / Internal / Confidential / Restricted.")
    csv_b64: Optional[str] = Field(
        None, description="Base64 of a CSV whose rows are `text,label` "
                          "(header optional). Alternative to `examples`.")
    replace: bool = Field(
        False, description="False (default) merges your data with the built-in "
                          "corpus. True trains on ONLY your data.")


class PredictRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=200_000)


def _parse_csv(csv_b64: str) -> Dict[str, List[str]]:
    try:
        raw = base64.b64decode(csv_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "csv_b64 is not valid base64")
    try:
        text = raw.decode("utf-8-sig", errors="replace")
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "CSV is not decodable text")

    out: Dict[str, List[str]] = {lvl: [] for lvl in mlc.LEVELS}
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "CSV is empty")

    # Skip a header row if it looks like one (e.g. text,label / content,level).
    start = 0
    header = [c.strip().lower() for c in rows[0][:2]]
    if header and header[-1] in ("label", "level", "classification", "sensitivity"):
        start = 1

    skipped = 0
    for row in rows[start:]:
        if len(row) < 2:
            skipped += 1
            continue
        body = (row[0] or "").strip()
        lvl = _normalize_level(row[-1])
        if not body or lvl is None:
            skipped += 1
            continue
        out[lvl].append(body)
    if not any(out.values()):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No usable rows. Expected `text,label` with label in "
            "Public/Internal/Confidential/Restricted.")
    return out


@router.get("/status")
async def status_(current_user=Depends(require_role("analyst"))):
    """Current model state: availability, provenance, per-level example counts,
    and cross-validation accuracy."""
    return mlc.model_status()


@router.post("/predict")
async def predict(req: PredictRequest, current_user=Depends(require_role("analyst"))):
    """Test the model on a piece of text (does not enforce anything)."""
    if not mlc.is_available():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "ML classifier unavailable (scikit-learn missing or disabled)")
    result = mlc.predict_level(req.content)
    if result is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Could not classify the input")
    return result


@router.post("/retrain")
async def retrain(req: RetrainRequest, current_user=Depends(require_role("admin"))):
    """Retrain on real labelled data (JSON examples or an uploaded CSV) and
    persist the result. Reports cross-validation accuracy before/after."""
    if not (req.examples or req.csv_b64):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Provide `examples` or `csv_b64`")

    corpus: Dict[str, List[str]] = {lvl: [] for lvl in mlc.LEVELS}
    if req.csv_b64:
        for lvl, texts in _parse_csv(req.csv_b64).items():
            corpus[lvl].extend(texts)
    if req.examples:
        for raw_lvl, texts in req.examples.items():
            lvl = _normalize_level(raw_lvl)
            if lvl is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                    f"Unknown level '{raw_lvl}'. Use: {', '.join(mlc.LEVELS)}")
            corpus[lvl].extend([t for t in (texts or []) if t and t.strip()])

    total = sum(len(v) for v in corpus.values())
    if total == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No usable training examples found")

    before = mlc.model_status().get("cv_accuracy")
    result = mlc.retrain(corpus, replace=req.replace)
    if not result.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            result.get("error", "Retrain failed"))
    logger.info("ml_classifier_retrained",
                user=getattr(current_user, "username", None),
                source=result.get("trained_on"), examples=total,
                cv_accuracy=result.get("cv_accuracy"))
    return {"cv_accuracy_before": before, "examples_added": total, **result}


@router.post("/reset")
async def reset(current_user=Depends(require_role("admin"))):
    """Discard any custom model and retrain from the built-in corpus."""
    logger.info("ml_classifier_reset", user=getattr(current_user, "username", None))
    return mlc.reset_to_default()
