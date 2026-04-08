"""
Authentication API Endpoints
User login, registration, token refresh
"""

from datetime import datetime, timedelta
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession
import structlog

from app.core.security import (
    create_access_token,
    create_refresh_token,
    get_password_hash,
    verify_password,
    validate_password_strength,
    decode_token,
    get_current_user,
)
from app.core.config import settings
from app.core.database import get_db
from app.core.cache import get_cache
from app.services.user_service import UserService
from app.services.blacklist_service import TokenBlacklistService
from app.services.audit_service import audit_log
from app.models.user import User

logger = structlog.get_logger()
router = APIRouter()


class UserRegister(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    organization: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


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
    if str(getattr(current_user, "role", "")).upper() != "ADMIN":
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

        # Create new tokens
        access_token = create_access_token(
            data={
                "sub": str(user.id),
                "email": user.email,
                "role": user.role,
            }
        )

        new_refresh_token = create_refresh_token(
            data={
                "sub": str(user.id),
                "email": user.email,
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
