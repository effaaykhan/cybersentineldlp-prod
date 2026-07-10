"""
Native TOTP MFA — opt-in, self-service for any account.

Flow:
  1. POST /auth/mfa/setup    (authed) → generate secret, return QR + otpauth URI
  2. POST /auth/mfa/confirm  (authed) → verify a code, enable MFA, return backup codes
  3. GET  /auth/mfa/status   (authed) → { enabled, recovery_codes_remaining }
  4. POST /auth/mfa/disable  (authed) → verify a code, turn MFA off
  5. POST /auth/mfa/verify   (public) → complete a login: { mfa_token, code } → tokens

Secrets are stored Fernet-encrypted (app.core.crypto). Backup codes are stored
as bcrypt hashes and consumed on use.
"""
import base64
import io
import secrets as pysecrets
from typing import Optional

import pyotp
import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.core.security import (
    get_current_user, get_password_hash, verify_password,
    create_access_token, create_refresh_token, decode_token,
)
from app.core.database import get_db
from app.core.crypto import encrypt_str, decrypt_str
from app.models.user import User
from app.services.audit_service import audit_log

logger = structlog.get_logger()
router = APIRouter()

_ISSUER = "CyberSentinel DLP"
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no ambiguous chars


# ── helpers ──────────────────────────────────────────────────────────────
def _qr_data_uri(text: str) -> str:
    """otpauth URI → inline SVG data URI (no Pillow dependency)."""
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


def _gen_recovery_codes(n: int = 10) -> list[str]:
    """Return n human-friendly one-time codes, e.g. 'abcd-efgh'."""
    out = []
    for _ in range(n):
        raw = "".join(pysecrets.choice(_RECOVERY_ALPHABET) for _ in range(8))
        out.append(f"{raw[:4]}-{raw[4:]}")
    return out


def _norm_recovery(code: str) -> str:
    return "".join(c for c in (code or "").lower() if c.isalnum())


def _verify_totp(user: User, code: str) -> bool:
    if not user.mfa_secret:
        return False
    digits = "".join(c for c in (code or "") if c.isdigit())
    if len(digits) != 6:
        return False
    try:
        secret = decrypt_str(user.mfa_secret)
    except Exception:
        return False
    return pyotp.TOTP(secret).verify(digits, valid_window=1)


def _consume_recovery(user: User, code: str) -> bool:
    """Match a recovery code against stored hashes; consume it on success."""
    norm = _norm_recovery(code)
    if len(norm) != 8:
        return False
    codes = list(user.mfa_recovery_codes or [])
    for i, h in enumerate(codes):
        if verify_password(norm, h):
            del codes[i]
            user.mfa_recovery_codes = codes
            return True
    return False


def verify_mfa_code(user: User, code: str) -> bool:
    """True if `code` is a valid TOTP OR an unused recovery code (consumed)."""
    return _verify_totp(user, code) or _consume_recovery(user, code)


# ── models ───────────────────────────────────────────────────────────────
class MfaSetupResponse(BaseModel):
    secret: str
    otpauth_uri: str
    qr_svg: str


class MfaCodeRequest(BaseModel):
    code: str = Field(..., description="6-digit TOTP or a recovery code")


class MfaVerifyRequest(BaseModel):
    mfa_token: str
    code: str


# ── endpoints ────────────────────────────────────────────────────────────
@router.post("/setup", response_model=MfaSetupResponse)
async def mfa_setup(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Begin enrollment: generate a fresh TOTP secret (stored pending, not yet
    enabled) and return the provisioning URI + QR to scan."""
    if current_user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is already enabled. Disable it first to re-enroll.")

    secret = pyotp.random_base32()
    current_user.mfa_secret = encrypt_str(secret)
    current_user.mfa_enabled = False  # stays pending until /confirm
    await db.commit()

    uri = pyotp.TOTP(secret).provisioning_uri(name=current_user.email, issuer_name=_ISSUER)
    return MfaSetupResponse(secret=secret, otpauth_uri=uri, qr_svg=_qr_data_uri(uri))


@router.post("/confirm")
async def mfa_confirm(
    body: MfaCodeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Verify the first code from the authenticator, enable MFA, and return
    one-time backup codes (shown ONCE)."""
    if not current_user.mfa_secret:
        raise HTTPException(status_code=400, detail="Run MFA setup first.")
    if not _verify_totp(current_user, body.code):
        raise HTTPException(status_code=400, detail="Invalid code. Check your authenticator and try again.")

    recovery = _gen_recovery_codes()
    current_user.mfa_recovery_codes = [get_password_hash(_norm_recovery(c)) for c in recovery]
    current_user.mfa_enabled = True
    from datetime import datetime, timezone
    current_user.mfa_enrolled_at = datetime.now(timezone.utc)
    await db.commit()
    await audit_log(current_user.id, "auth.mfa.enabled", {})
    logger.info("MFA enabled", user_id=str(current_user.id))
    return {"enabled": True, "recovery_codes": recovery}


@router.get("/status")
async def mfa_status(current_user: User = Depends(get_current_user)):
    return {
        "enabled": bool(current_user.mfa_enabled),
        "recovery_codes_remaining": len(current_user.mfa_recovery_codes or []),
    }


@router.post("/disable")
async def mfa_disable(
    body: MfaCodeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Turn MFA off. Requires a valid current TOTP or recovery code so a
    hijacked session alone can't remove the second factor."""
    if not current_user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is not enabled.")
    if not verify_mfa_code(current_user, body.code):
        raise HTTPException(status_code=400, detail="Invalid code.")
    current_user.mfa_enabled = False
    current_user.mfa_secret = None
    current_user.mfa_recovery_codes = None
    current_user.mfa_enrolled_at = None
    await db.commit()
    await audit_log(current_user.id, "auth.mfa.disabled", {})
    logger.info("MFA disabled", user_id=str(current_user.id))
    return {"enabled": False}


@router.post("/verify")
async def mfa_verify(
    body: MfaVerifyRequest,
    db: AsyncSession = Depends(get_db),
):
    """Second step of login: exchange a valid mfa_pending token + code for the
    full access/refresh tokens."""
    from app.services.user_service import UserService

    payload = decode_token(body.mfa_token)
    if payload.get("type") != "mfa_pending":
        raise HTTPException(status_code=401, detail="Invalid MFA session token.")
    user_id = payload.get("sub")
    user = await UserService(db).get_user_by_id(user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid MFA session.")
    if not user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is not enabled for this account.")

    if not verify_mfa_code(user, body.code):
        await audit_log(user.id, "auth.mfa.failed", {})
        raise HTTPException(status_code=401, detail="Invalid code.")

    await db.commit()  # persist any consumed recovery code
    access_token = create_access_token(data={"sub": str(user.id), "email": user.email, "role": user.role})
    refresh_token = create_refresh_token(data={"sub": str(user.id), "email": user.email})
    await audit_log(user.id, "auth.login.mfa", {})
    logger.info("MFA login completed", user_id=str(user.id))
    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer"}
