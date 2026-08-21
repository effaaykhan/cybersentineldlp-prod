"""
Authentication API Endpoints
User login, registration, token refresh, SSO exchange
"""

import secrets
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Request, Query
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession
from jose import jwt as jose_jwt, JWTError, ExpiredSignatureError
import structlog

from app.core.security import (
    create_access_token,
    create_refresh_token,
    create_mfa_token,
    get_password_hash,
    verify_password,
    validate_password_strength,
    decode_token,
    get_current_user,
    require_role,
)
from app.core.config import settings
from app.core.database import get_db
from app.core.cache import get_cache
from app.services.user_service import UserService
from app.services.blacklist_service import TokenBlacklistService
from app.services.audit_service import audit_log
from app.services.user_dept_cache import DEFAULT_DEPARTMENT
from app.core.sso_roles import resolve as resolve_sso_identity
from app.core.sso_verify import (
    SSOTokenError,
    SSOUnavailable,
    sso_configured,
    verify_exchange_token,
)
from app.models.user import User

logger = structlog.get_logger()
router = APIRouter()


class UserRegister(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    organization: str


class TokenResponse(BaseModel):
    # access/refresh are absent when MFA is required (second step needed).
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    # Set when the account has MFA enabled — client must POST the code +
    # this mfa_token to /auth/mfa/verify to obtain the real tokens.
    mfa_required: Optional[bool] = None
    mfa_token: Optional[str] = None


class RefreshTokenRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    username: str
    current_password: str
    new_password: str
    new_password_confirm: str


@router.post("/register", response_model=Dict, status_code=status.HTTP_201_CREATED)
async def register(
    user_data: UserRegister,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Register a new user (admin-only).

    SECURITY: Open self-registration is disabled. New accounts must be
    created by an existing admin. Without this guard, any anonymous
    attacker could register a VIEWER account and read every DLP event,
    policy, classification hit, clipboard capture, and file path in the
    system, since the authorization layer has no per-tenant scoping.
    """
    # Only admins can provision new accounts.
    # user.role is a UserRole enum instance; str(enum) returns
    # "ClassName.VALUE" not "VALUE", so extract .value first.
    role_val = getattr(current_user, "role", "")
    role_str = str(getattr(role_val, "value", role_val)).upper()
    if role_str != "ADMIN":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can register new users.",
        )

    # Validate password strength
    if not validate_password_strength(user_data.password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters "
                   "and contain uppercase, lowercase, digit, and special character",
        )

    # Create user service
    user_service = UserService(db)

    try:
        # Create user in database
        user = await user_service.create_user(
            email=user_data.email,
            password=user_data.password,
            full_name=user_data.full_name,
            organization=user_data.organization,
            role="VIEWER",  # Default role for new users
        )

        logger.info(
            "User registered by admin",
            admin_id=str(current_user.id),
            new_user_id=str(user.id),
            new_user_email=user.email,
        )

        return {
            "message": "User registered successfully",
            "email": user.email,
            "user_id": str(user.id),
        }

    except ValueError as e:
        # User already exists or other validation error
        logger.warning("Registration failed", email=user_data.email, error=str(e))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    """
    User login with email and password
    Returns access and refresh tokens

    SECURITY: dedicated rate limiter bucketed by (client_ip + username)
    via Redis. 10 failed attempts in a 5-minute window (per key) triggers
    a 429 until the window expires. This is on TOP of the global
    RateLimitMiddleware and is specifically designed to blunt credential
    stuffing and slow-and-low brute force.
    """
    # ── Rate limit BEFORE touching the DB ─────────────────────────────
    client_ip = request.client.host if request.client else "unknown"
    username = (form_data.username or "").strip().lower()
    rl_key = f"login_fail:{client_ip}:{username}"
    try:
        cache = get_cache()
        failed = await cache.get(rl_key)
        if failed is not None:
            try:
                failed = int(failed)
            except (TypeError, ValueError):
                failed = 0
            if failed >= 10:
                logger.warning(
                    "Login rate limit hit",
                    ip=client_ip, username=username, failed=failed,
                )
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many failed login attempts. Try again in a few minutes.",
                    headers={"Retry-After": "300"},
                )
    except HTTPException:
        raise
    except Exception:
        # Redis unreachable → fail open on the limiter, the global
        # middleware still caps overall throughput.
        pass

    # Create user service
    user_service = UserService(db)

    # Authenticate user
    user = await user_service.authenticate_user(
        email=form_data.username,
        password=form_data.password,
    )

    if not user:
        logger.warning("Login failed - invalid credentials", email=form_data.username)
        # Increment the failed-attempts counter with a 5-minute TTL.
        try:
            cache = get_cache()
            current = await cache.incr(rl_key)
            if current == 1:
                await cache.expire(rl_key, 300)  # 5 minutes
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Successful login → clear the counter for this (ip, username).
    try:
        cache = get_cache()
        await cache.delete(rl_key)
    except Exception:
        pass

    # Check if password change is required
    if getattr(user, "must_change_password", False):
        logger.info("Login requires password change", email=user.email)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password change required. Use /api/v1/auth/change-password to set a new password before logging in.",
        )

    # MFA second factor — when enabled, return an interim mfa_token instead of
    # a full session. The client completes login via POST /auth/mfa/verify.
    if getattr(user, "mfa_enabled", False):
        mfa_token = create_mfa_token(str(user.id))
        await audit_log(user.id, "auth.login.mfa_challenge", {})
        logger.info("MFA challenge issued", user_id=str(user.id))
        return {"mfa_required": True, "mfa_token": mfa_token, "token_type": "mfa"}

    # Create tokens
    access_token = create_access_token(
        data={
            "sub": str(user.id),
            "email": user.email,
            "role": user.role,
        }
    )

    refresh_token = create_refresh_token(
        data={
            "sub": str(user.id),
            "email": user.email,
        }
    )

    logger.info("User logged in", user_id=str(user.id))

    await audit_log(user.id, "auth.login", {})

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
    }


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    request: RefreshTokenRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Refresh access token using refresh token
    """
    try:
        payload = decode_token(request.refresh_token)

        if payload.get("type") != "refresh":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid refresh token",
            )

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid refresh token",
            )

        user_service = UserService(db)
        user = await user_service.get_user_by_id(user_id)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found",
            )

        # Create new tokens. An SSO-vouched session stays SSO-vouched across
        # refreshes — dropping the claim here would silently re-gate the
        # session behind the IP allowlist mid-session.
        is_sso = bool(payload.get("sso"))
        access_token = create_access_token(
            data={
                "sub": str(user.id),
                "email": user.email,
                "role": user.role,
                **({"sso": True} if is_sso else {}),
            }
        )

        new_refresh_token = create_refresh_token(
            data={
                "sub": str(user.id),
                "email": user.email,
                **({"sso": True} if is_sso else {}),
            }
        )

        return {
            "access_token": access_token,
            "refresh_token": new_refresh_token,
            "token_type": "bearer",
        }

    except Exception as e:
        logger.error("Token refresh failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )


@router.post("/change-password")
async def change_password(
    request: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Change the authenticated user's password.

    SECURITY: A valid JWT is required. The `username` field in the
    request body is IGNORED — the password is always rotated for the
    token bearer. This prevents unauthenticated brute-force of
    `current_password` against arbitrary accounts.
    """
    if request.new_password != request.new_password_confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New passwords do not match",
        )

    if not validate_password_strength(request.new_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters "
                   "and contain uppercase, lowercase, digit, and special character",
        )

    user_service = UserService(db)

    # Re-verify the current password for the authenticated user only.
    # The username from the request body is NOT trusted.
    user = await user_service.authenticate_user(
        email=current_user.email,
        password=request.current_password,
    )
    if not user or str(user.id) != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    # Update password
    success = await user_service.update_password(
        user_id=str(user.id),
        current_password=request.current_password,
        new_password=request.new_password,
    )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update password",
        )

    # Clear must_change_password flag if it was set
    if getattr(user, "must_change_password", False):
        from sqlalchemy import text as sa_text
        await db.execute(
            sa_text("UPDATE users SET must_change_password = FALSE WHERE id = :uid"),
            {"uid": user.id},
        )
        await db.commit()

    logger.info("Password changed", user_id=str(user.id))
    return {"message": "Password changed successfully"}


@router.post("/logout")
async def logout(
    request: Request,
    current_user: User = Depends(get_current_user)
):
    """
    User logout
    """
    token = request.headers["authorization"].split(" ")[1]
    cache = get_cache()
    blacklist_service = TokenBlacklistService(cache)
    payload = decode_token(token)
    expires_in = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    await blacklist_service.add_to_blacklist(token, expires_in)
    logger.info("User logged out", email=current_user.email)

    await audit_log(current_user.id, "auth.logout")

    return {"message": "Logged out successfully"}


@router.get("/me")
async def get_me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict:
    """
    Return the authenticated user's identity + resolved permissions.

    This is the source of truth the frontend uses to drive UI gating.
    Never trust the role embedded in a JWT for authorization decisions —
    that's just a hint for optimistic UI; this endpoint is what actually
    backs show/hide logic, and the server re-checks on every protected call.
    """
    from app.services.permission_service import get_user_permissions

    permissions = sorted(await get_user_permissions(db, current_user))
    role_value = getattr(current_user.role, "value", str(current_user.role))

    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "full_name": current_user.full_name,
        "role": role_value,
        "role_id": str(current_user.role_id) if current_user.role_id else None,
        "department": current_user.department,
        "organization": current_user.organization,
        "is_active": current_user.is_active,
        "permissions": permissions,
    }


@router.get("/users/check")
async def check_user_exists(
    email: EmailStr = Query(..., description="Email address to check"),
    _: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
) -> Dict:
    """
    Admin-only probe: does a user with this email exist in the DLP system?

    Used by the SIEM to reconcile its local `dlpRegistered` flag when an
    admin deletes a DLP account directly from the admin panel. Without
    this, the SIEM would keep pushing stale SSO logins for a user that
    no longer exists, and the exchange at /sso/exchange would 401.
    """
    user_service = UserService(db)
    user = await user_service.get_user_by_email(email.strip().lower())
    return {"exists": user is not None}


# ── SSO Exchange ─────────────────────────────────────────────────────────
# The SIEM generates a short-lived JWT "exchange token" signed with
# DLP_SSO_SECRET. This endpoint verifies it, looks up the user in the
# DLP database, and issues standard DLP access+refresh tokens signed
# with SECRET_KEY. The exchange token is NOT the same as a DLP token.
#
# Key material — three roles, never interchangeable:
#   SIEM_JWKS_URL   →  the SIEM's PUBLIC keys, verify RS256 tokens (preferred:
#                      the DLP can then verify but not forge a SIEM token)
#   DLP_SSO_SECRET  →  shared secret, verify HS256 tokens (migration fallback;
#                      clear it to retire symmetric signing)
#   SECRET_KEY      →  issue DLP tokens (never used to verify SIEM tokens)
#
# The token's own signed ``alg`` header routes which is used — see
# app/core/sso_verify.py for why that is safe here.
#
# Exchange token claim contract
# ─────────────────────────────
# Required : purpose="sso_exchange", iss="cybersentineldlp-siem", nonce, exp
#            sub    the SIEM's immutable user id — the key an account is
#                   matched on. email is accepted as a fallback key so
#                   accounts predating this are found and adopt their sub.
#            aud    "cybersentinel-dlp" (SSO_AUDIENCE). Mandatory on RS256;
#                   on HS256 checked only when present, so a SIEM build that
#                   predates the claim is not locked out by a DLP upgrade.
# Optional : username, full_name, organization, email
# Optional : role             "Administrator" | "L1" | "L2" | "L3"
#            access           "read-write" | "read-only"   (absent ⇒ read-only)
#            department       ABAC department
#            clearance_level  ABAC clearance (0-10)
#
# The optional block is what makes an SSO user land on the DLP role and
# access level matching their SIEM account, and what lets the DLP create
# the account on first login. Omit them and SSO behaves exactly as before:
# VIEWER, and the account must already exist. Mapping lives in
# app/core/sso_roles.py; SSO_MAX_ROLE bounds what any token can be granted.


class SSOExchangeRequest(BaseModel):
    token: str


def _nonce_ttl_seconds(payload: dict) -> int:
    """How long to remember a consumed nonce.

    Must outlive the token: retention shorter than the signature's validity
    leaves a gap in which a captured token is replayable. Derived from the
    token's own ``exp`` plus the clock leeway we granted it, floored at
    SSO_NONCE_TTL_SECONDS and capped so a token claiming a year-long expiry
    cannot pin an entry in Redis for a year.
    """
    from datetime import datetime, timezone

    floor = max(60, int(getattr(settings, "SSO_NONCE_TTL_SECONDS", 300) or 300))
    leeway = max(0, int(getattr(settings, "SSO_CLOCK_LEEWAY_SECONDS", 60) or 0))
    ttl = floor
    exp = payload.get("exp")
    if exp:
        try:
            remaining = int(exp) - int(datetime.now(timezone.utc).timestamp())
            ttl = max(ttl, remaining + leeway + 10)
        except (TypeError, ValueError):
            pass
    return min(ttl, 3600)


@router.post("/sso/exchange", response_model=TokenResponse)
async def sso_exchange(
    body: SSOExchangeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Exchange a SIEM-issued SSO token for DLP access + refresh tokens.

    Public endpoint — no Authorization header required. The exchange token
    itself serves as proof of authentication (signed by DLP_SSO_SECRET,
    30-second TTL, single-use nonce).
    """

    # ── Guard: SSO must be configured ────────────────────────────────
    # Either signing scheme counts. During the RS256 cutover both are set;
    # afterwards DLP_SSO_SECRET is cleared and only the JWKS remains.
    if not sso_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO is not configured",
        )

    # ── Verify exchange token (RS256 via JWKS, or HS256 fallback) ────
    try:
        payload, token_alg = await verify_exchange_token(body.token)
    except SSOUnavailable as e:
        # We could not obtain the key material. That is our problem, not a
        # bad token, and 401 would send the SIEM chasing a signature fault
        # that does not exist.
        logger.error("SSO exchange: verification unavailable", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO verification is temporarily unavailable",
        )
    except SSOTokenError as e:
        logger.warning("SSO exchange: token rejected",
                       error=e.detail, expired=e.expired)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=e.detail,
        )

    # ── Validate required claims ─────────────────────────────────────
    if payload.get("purpose") != "sso_exchange":
        logger.warning("SSO exchange: wrong purpose", purpose=payload.get("purpose"))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid exchange token: wrong purpose",
        )

    if payload.get("iss") != "cybersentineldlp-siem":
        logger.warning("SSO exchange: wrong issuer", iss=payload.get("iss"))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid exchange token: wrong issuer",
        )

    nonce = payload.get("nonce")
    if not nonce:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid exchange token: missing nonce",
        )

    # ── Nonce replay protection ──────────────────────────────────────
    nonce_key = f"sso_nonce:{nonce}"
    try:
        cache = get_cache()
        existing = await cache.get(nonce_key)
        if existing is not None:
            logger.warning("SSO exchange: nonce already used", nonce=nonce)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Exchange token already used",
            )
        # Mark the nonce consumed for LONGER than the token can possibly
        # remain valid.
        #
        # This used to be a flat 60s chosen as "double the 30s TTL". Clock
        # leeway broke that arithmetic silently: with 60s of leeway a 30s
        # token stays signature-valid for ~90s, so between t=60s and t=90s
        # the nonce had expired while the token had not — a replay window
        # opened by a change made for availability, in a different file,
        # with nothing connecting the two.
        #
        # Deriving it from the token's own exp means the window cannot
        # reopen: raise leeway, lower the TTL, shorten the token, and the
        # retention still covers the whole of the token's life.
        await cache.set(nonce_key, "1", ex=_nonce_ttl_seconds(payload))
    except HTTPException:
        raise
    except Exception:
        # Redis unavailable → fail open on nonce check (token signature +
        # expiry still protect us). Log so ops can investigate.
        logger.warning("SSO exchange: Redis unavailable for nonce check")

    # ── Identify the human ───────────────────────────────────────────
    # Keyed on the SIEM's ``sub``, not on email.
    #
    # Email is a display attribute that changes — surname changes, domain
    # migrations, typo fixes. Keyed on email, any of those orphans the DLP
    # account: the next login finds nothing, provisions a SECOND account, and
    # the original's history and role belong to a user who can no longer reach
    # them. Nothing errors, so it surfaces weeks later as "why is my history
    # empty". ``sub`` is the SIEM's own id for the person and does not change.
    #
    # Email is still accepted as the fallback key so existing accounts — every
    # one of which predates siem_sub — are found on their next login and adopt
    # their sub then. No migration, no coordinated cutover.
    siem_sub = str(payload.get("sub") or "").strip() or None
    email = str(payload.get("email") or "").strip().lower()
    if not siem_sub and not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Exchange token identifies no user (no sub, no email)",
        )

    # ── Translate the SIEM's role/access pair into a DLP role ────────
    # Optional claims. A SIEM that sends none of them resolves to
    # SSO_DEFAULT_ROLE (VIEWER) — exactly what every SSO account got
    # before this existed.
    identity = resolve_sso_identity(payload)
    if identity.clamped_from:
        logger.warning(
            "SSO exchange: role clamped by SSO_MAX_ROLE",
            email=email, requested=identity.clamped_from, granted=identity.role,
        )

    user_service = UserService(db)

    user = None
    matched_by = ""
    if siem_sub:
        user = await user_service.get_user_by_siem_sub(siem_sub)
        if user:
            matched_by = "siem_sub"
    if not user and email:
        user = await user_service.get_user_by_email(email)
        if user:
            matched_by = "email"

    # ── Reconcile the identity we matched with the one on the token ──
    if user:
        updates: Dict = {}
        if siem_sub and not getattr(user, "siem_sub", None):
            # Backfill: this account existed before sub-keying, or was created
            # locally and is now claimed by its SIEM identity. From here on it
            # is found by sub and survives an email change.
            updates["siem_sub"] = siem_sub
        if matched_by == "siem_sub" and email and user.email != email:
            # The rename this whole mechanism exists to survive. Only trusted
            # when the match came from sub — an email-matched row tells us
            # nothing new about its own email.
            existing = await user_service.get_user_by_email(email)
            if existing is not None and str(existing.id) != str(user.id):
                # Another account already holds it. Renaming into a collision
                # would fail the whole login for something cosmetic.
                logger.warning("SSO exchange: email already held by another account",
                               siem_sub=siem_sub, email=email)
            else:
                updates["email"] = email
        if updates:
            try:
                user = await user_service.update_user(str(user.id), **updates)
            except Exception as e:  # noqa: BLE001 — identity upkeep, never fatal
                logger.warning("SSO exchange: identity reconcile failed",
                               error=str(e), siem_sub=siem_sub)
            else:
                await audit_log(user.id, "auth.sso_identity_reconcile", {
                    "matched_by": matched_by, **updates,
                })

    # ── Just-in-time provisioning ────────────────────────────────────
    # Without this the SIEM has to hold DLP admin credentials purely to
    # pre-register people, and every unregistered login dead-ends at 401.
    if not user:
        if not settings.SSO_JIT_PROVISION:
            logger.warning("SSO exchange: user not found",
                           email=email, siem_sub=siem_sub)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found in DLP system",
            )
        if not email:
            # A DLP account is keyed on email in every other part of the
            # product (it is the unique column, and what ABAC and the audit
            # log display). We can FIND a user by sub alone, but we cannot
            # invent one without an address.
            logger.warning("SSO exchange: cannot provision without an email",
                           siem_sub=siem_sub)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Exchange token missing email claim",
            )

        siem_username = (payload.get("username") or "").strip() or None
        # username is UNIQUE; a collision would abort the whole login, and a
        # display alias is not worth that. Drop it and keep email as the
        # canonical identifier.
        if siem_username:
            from sqlalchemy import select as _select

            taken = await db.execute(
                _select(User.id).where(User.username == siem_username)
            )
            if taken.scalar_one_or_none() is not None:
                logger.warning("SSO JIT: username already taken, omitting",
                               username=siem_username, email=email)
                siem_username = None

        full_name = (
            payload.get("full_name") or payload.get("name")
            or payload.get("username") or email.split("@")[0]
        )

        try:
            user = await user_service.create_user(
                email=email,
                # SSO accounts never authenticate with a password. Store an
                # unguessable one rather than a blank/known hash so the
                # /auth/login path can never be used against this account.
                password=secrets.token_urlsafe(48),
                full_name=str(full_name)[:255],
                role=identity.role,
                organization=str(payload.get("organization") or "CyberSentinelDLP")[:255],
                # NULL department = denied every event by ABAC §C, which is
                # how an SSO user ends up with a working login and a
                # permanently empty console.
                department=identity.department or DEFAULT_DEPARTMENT,
                clearance_level=identity.clearance_level,
                username=siem_username,
                sso_managed=True,
                sso_source_role=f"{identity.siem_role}:{identity.siem_access}"[:64],
                siem_sub=siem_sub,
            )
        except ValueError:
            # Lost a race with a concurrent SSO login for the same person.
            user = None
            if siem_sub:
                user = await user_service.get_user_by_siem_sub(siem_sub)
            if not user:
                user = await user_service.get_user_by_email(email)
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="User not found in DLP system",
                )
        else:
            logger.info("SSO JIT provisioned user", email=email, **identity.as_log())
            await audit_log(user.id, "auth.sso_provision", {
                "email": email,
                "siem_user": payload.get("username"),
                **identity.as_log(),
            })

    # ── Sync role/attributes for accounts the SIEM owns ──────────────
    # Only ever touches rows this flow itself created (sso_managed). A
    # locally created account — or one an admin has edited by hand, which
    # clears the flag — is never rewritten from a token.
    elif settings.SSO_SYNC_ON_LOGIN and getattr(user, "sso_managed", False):
        current_role = str(getattr(user.role, "value", user.role)).upper()
        changes: Dict = {}

        # Only when the SIEM actually sent a role we recognise. Otherwise a
        # SIEM that stops sending the claim would silently demote everyone
        # to SSO_DEFAULT_ROLE on their next login.
        if identity.mapped and current_role != identity.role:
            changes["role"] = identity.role
        if identity.department and user.department != identity.department:
            changes["department"] = identity.department
        if (identity.clearance_level is not None
                and getattr(user, "clearance_level", None) != identity.clearance_level):
            changes["clearance_level"] = identity.clearance_level

        if changes:
            user = await user_service.update_user(
                user_id=str(user.id),
                sso_source_role=f"{identity.siem_role}:{identity.siem_access}"[:64],
                **changes,
            )
            logger.info("SSO synced user from SIEM", email=email,
                        previous_role=current_role, **identity.as_log())
            await audit_log(user.id, "auth.sso_sync", {
                "email": email,
                "previous_role": current_role,
                "changes": changes,
                **identity.as_log(),
            })

    if not getattr(user, "is_active", True):
        logger.warning("SSO exchange: user inactive", email=email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is disabled",
        )

    # ── Issue DLP tokens (signed with SECRET_KEY, not DLP_SSO_SECRET) ─
    # The ``sso`` claim marks the session as vouched for by the SIEM. The IP
    # allowlist honours it (SSO_ALLOWLIST_BYPASS) so an off-network analyst
    # does not get a successful login attached to a console that 403s on every
    # request — which reads as the DLP being broken, not restricted. Password
    # sessions carry no such claim and stay gated.
    access_token = create_access_token(
        data={
            "sub": str(user.id),
            "email": user.email,
            "role": user.role,
            "sso": True,
        }
    )

    refresh_token = create_refresh_token(
        data={
            "sub": str(user.id),
            "email": user.email,
            # Carried so a refresh from off-network does not silently produce a
            # gated session and log the user out at the next request.
            "sso": True,
        }
    )

    # Clear any login rate-limit counters for this user (same as normal login).
    client_ip = request.client.host if request.client else "unknown"
    try:
        cache = get_cache()
        await cache.delete(f"login_fail:{client_ip}:{email}")
    except Exception:
        pass

    logger.info(
        "SSO login successful",
        user_id=str(user.id),
        email=user.email,
        siem_user=payload.get("username"),
    )

    await audit_log(user.id, "auth.sso_login", {
        "siem_user": payload.get("username"),
        "siem_issuer": payload.get("iss"),
    })

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
    }
