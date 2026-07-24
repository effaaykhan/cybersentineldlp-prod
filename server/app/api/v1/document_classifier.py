"""
Document / image type classification — API.

Standalone and additive: exposes the 24 built-in classifiers. Does not touch the
existing classification pipeline. Images and scanned PDFs are OCR'd via the
existing extractor, then typed here.
"""
import base64
import binascii
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
import structlog

from app.core.security import require_role
from app.services.document_classifier import (
    classify_document, list_classifiers, CLASSIFIER_COUNT,
)
from app.services.document_extract import extract_text

logger = structlog.get_logger()
router = APIRouter()


class ClassifyRequest(BaseModel):
    content: Optional[str] = Field(None, description="Raw text to type-classify.")
    file_b64: Optional[str] = Field(None, description="Base64 of a document/image file.")
    filename: Optional[str] = Field(None, max_length=500,
        description="Original filename (drives extraction/OCR of file_b64).")
    top_k: int = Field(3, ge=1, le=24)
    min_confidence: float = Field(0.5, ge=0.05, le=1.0)


@router.get("/")
async def catalogue(current_user=Depends(require_role("analyst"))):
    """The catalogue of built-in classifiers."""
    return {"count": CLASSIFIER_COUNT, "classifiers": list_classifiers()}


@router.post("/classify")
async def classify(
    body: ClassifyRequest,
    current_user=Depends(require_role("analyst")),
):
    """Identify the document/image type(s) of the supplied content or file."""
    text = body.content
    extract_kind = "text"
    if not text and body.file_b64:
        try:
            data = base64.b64decode(body.file_b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "file_b64 is not valid base64")
        ex = extract_text(body.filename or "upload", data)  # images/scanned PDFs → OCR here
        extract_kind = ex.kind
        text = ex.text
    if not text or not text.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Provide content or a readable file_b64")

    matches = classify_document(text, top_k=body.top_k, min_confidence=body.min_confidence)
    return {
        "matched": bool(matches),
        "extract_kind": extract_kind,
        "document_types": matches,
    }
