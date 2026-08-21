"""
Configuration Management
Centralized configuration using Pydantic Settings
"""

import json
from typing import List, Optional
from pydantic import Field, field_validator, PostgresDsn, MongoDsn, RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables
    """

    # Application Info
    PROJECT_NAME: str = "CyberSentinel DLP"
    PROJECT_DESCRIPTION: str = "Enterprise Data Loss Prevention Platform"
    VERSION: str = "2.0.0"
    ENVIRONMENT: str = Field(default="development")
    DEBUG: bool = Field(default=False)

    # Server Configuration
    HOST: str = Field(default="0.0.0.0")
    PORT: int = Field(default=55100)
    WORKERS: int = Field(default=4)
    API_V1_PREFIX: str = "/api/v1"

    # Security
    SECRET_KEY: str = Field(...)
    # Separate key for Fernet encryption (OAuth tokens). Falls back to SECRET_KEY if not set.
    ENCRYPTION_KEY: str = Field(default="")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    PASSWORD_MIN_LENGTH: int = 7

    # SSO — shared secret for verifying exchange tokens from the SIEM.
    # If empty/unset, the /auth/sso/exchange endpoint returns 503 (SSO disabled).
    # This is NOT the same as SECRET_KEY. The SIEM signs its exchange token
    # with DLP_SSO_SECRET; the DLP verifies it with DLP_SSO_SECRET then issues
    # its own tokens signed with SECRET_KEY.
    DLP_SSO_SECRET: str = Field(default="")

    # ── Asymmetric SSO verification (RS256 via the SIEM's JWKS) ──────────
    # With HS256 the DLP holds a secret that can FORGE SIEM tokens, not just
    # verify them — and with JIT provisioning on, forging one mints a DLP
    # account at a role of the forger's choosing. With RS256 the DLP holds
    # only a public key: a compromise of this config can read nothing and
    # sign nothing, and the SIEM can rotate keys without a flag day because
    # the token's ``kid`` selects which key verifies it.
    #
    # Empty (the default) = unchanged behaviour: HS256 with DLP_SSO_SECRET.
    # Set it and the token's own signed ``alg`` header routes verification:
    # RS*/ES*/PS* -> JWKS, HS256 -> DLP_SSO_SECRET. To complete a cutover and
    # retire symmetric signing entirely, clear DLP_SSO_SECRET — HS256 tokens
    # are then rejected outright rather than quietly still accepted.
    SIEM_JWKS_URL: str = Field(default="")
    # PEM used to verify the JWKS host's TLS certificate. Empty = the system
    # trust store, which is right for a publicly-issued certificate.
    #
    # A SIEM on an internal network usually presents a self-signed certificate,
    # and the fetch then fails closed — correctly. It is worth being explicit
    # about why the obvious shortcut is not offered here: the JWKS IS the trust
    # anchor for every RS256 login. Skipping verification does not merely
    # silence a warning, it means anyone who can answer for that address serves
    # their own public key and thereafter mints SSO tokens the DLP accepts as
    # genuine — turning "needs the SIEM's private key" into "needs to be on the
    # network path". So the escape hatch is a pinned certificate, not a
    # disabled check.
    #
    # Point this at the SIEM's own certificate (a self-signed leaf works: it is
    # its own issuer) or at the CA that signed it. The certificate must still
    # match the host in SIEM_JWKS_URL, so it needs that name or IP in its SAN.
    # Trade-off worth knowing: the DLP now stops trusting the SIEM when that
    # certificate is rotated. That is the point — but put its expiry in a
    # calendar, because the failure mode is "SSO stopped working".
    SIEM_JWKS_CA_BUNDLE: str = Field(default="")
    # How long a fetched JWKS is trusted before refetching. A token whose kid
    # is not in the cache forces one early refetch (rate-limited), so a key
    # rotation is picked up in seconds rather than at the end of this window.
    SSO_JWKS_CACHE_SECONDS: int = Field(default=600)

    # Audience the exchange token must be addressed to. Without this check a
    # token the SIEM minted for a DIFFERENT consumer of the same key is
    # accepted here as though it were meant for the DLP.
    #
    # Enforced strictly for asymmetric tokens (the new contract). For HS256 it
    # is enforced only when the token actually carries an ``aud`` claim, so a
    # SIEM build predating this cannot be locked out by upgrading the DLP —
    # and gets the check automatically the moment it starts sending one.
    SSO_AUDIENCE: str = Field(default="cybersentinel-dlp")

    # Clock skew tolerance when validating exp/nbf on an exchange token.
    # The token's TTL is ~30s, so two boxes a minute apart make every login
    # fail with nothing in either log to explain it. Read together with
    # SSO_NONCE_TTL_SECONDS below — leeway EXTENDS how long a token stays
    # valid, so the replay window has to be extended to match.
    SSO_CLOCK_LEEWAY_SECONDS: int = Field(default=60)
    # Reject a token with no exp claim rather than treating it as eternal.
    # python-jose does not require exp by default.
    SSO_REQUIRE_EXP: bool = Field(default=True)
    # How long a consumed nonce is remembered. MUST exceed the maximum time a
    # token can stay valid (its TTL + SSO_CLOCK_LEEWAY_SECONDS) or a replay
    # window opens between the nonce expiring and the signature going stale.
    # The exchange derives the actual TTL from the token's own exp and uses
    # this as the floor, so raising leeway cannot silently outrun it.
    SSO_NONCE_TTL_SECONDS: int = Field(default=300)
    # Longest validity window an exchange token may claim. The SIEM issues 30s
    # tokens; this refuses one that asserts far more.
    #
    # It exists to keep the nonce guarantee airtight. Nonce retention is
    # derived from the token's exp but capped, so that a token claiming a
    # year-long expiry cannot pin a Redis entry for a year — and that cap would
    # otherwise reopen the replay window it was meant to close, just further
    # out. Bounding the token's lifetime instead means retention always covers
    # the whole of it, with no cap ever being reached.
    SSO_MAX_TOKEN_AGE_SECONDS: int = Field(default=600)

    # An SSO-authenticated session is not IP-gated.
    # The SIEM vouches for the human; gating the session by source IP as well
    # means an off-network analyst logs in successfully and then gets 403 on
    # every API call — a working login attached to a dead console, which reads
    # as the DLP being broken rather than restricted. Password logins stay
    # gated, which is where the network control earns its keep.
    SSO_ALLOWLIST_BYPASS: bool = Field(default=True)

    # ── SSO role/attribute propagation (app/core/sso_roles.py) ───────────
    # The SIEM can carry its own role ("Administrator"/"L1"/"L2"/"L3"),
    # access mode ("read-write"/"read-only") and ABAC attributes on the
    # exchange token. These settings decide what the DLP does with them.
    # Every one of them is optional: with the defaults and a SIEM that
    # sends no such claims, SSO behaves exactly as it did before.
    #
    # Ceiling on what an SSO login can ever be granted. DLP_SSO_SECRET is
    # shared with the SIEM, so this bounds the damage from a forged token:
    # set it to MANAGER/ANALYST and no SSO login can reach ADMIN, no matter
    # what the token claims. Default ADMIN = no clamp.
    SSO_MAX_ROLE: str = Field(default="ADMIN")
    # Role for a login whose SIEM role is missing or unrecognised. This is
    # what every SSO account already got, so it is also the no-op default.
    SSO_DEFAULT_ROLE: str = Field(default="VIEWER")
    # Create the DLP account on first SSO login instead of 401-ing.
    # ON: the alternative is the SIEM holding DLP admin credentials purely to
    # pre-register people, which is both a standing privileged credential and
    # the reason its service account needed an MFA exemption. Provisioning
    # from the token removes the admin round-trip entirely.
    #
    # This raises the stakes on token forgery — a forged token no longer just
    # impersonates an existing user, it MINTS one at a role of its choosing —
    # so it is bounded by SSO_MAX_ROLE, and RS256 (SIEM_JWKS_URL above)
    # removes the DLP's ability to forge one at all.
    SSO_JIT_PROVISION: bool = Field(default=True)
    # Re-apply the SIEM's role/department/clearance on every SSO login, so a
    # promotion or transfer in the SIEM follows the user into the DLP. Only
    # ever touches accounts the DLP itself provisioned via SSO
    # (users.sso_managed); a locally-created or locally-edited account is
    # never rewritten. See app/api/v1/auth.py.
    SSO_SYNC_ON_LOGIN: bool = Field(default=True)
    # Optional JSON override of the built-in SIEM→DLP translation table, e.g.
    #   {"L3": {"rw": "ANALYST", "ro": "ANALYST"}, "L1": "VIEWER"}
    # Invalid JSON falls back to the built-in table and logs an error.
    SSO_ROLE_MAP: str = Field(default="")

    # TAXII 2.1 sharing server credentials (HTTP Basic for partner vendors).
    # If TAXII_SHARE_PASSWORD is empty/unset, the TAXII sharing endpoints return
    # 503 (sharing disabled) — nothing is published until a credential is set.
    TAXII_SHARE_USER: str = Field(default="partner")
    TAXII_SHARE_PASSWORD: str = Field(default="")

    # CORS
    # NOTE: Pydantic Settings parses list fields from env as JSON only. To support both:
    # - JSON list strings (recommended) AND
    # - comma-separated strings
    # we allow either str or List[str] as input and normalize via validators below.
    CORS_ORIGINS: List[str] | str = Field(
        default=["*"]
    )
    ALLOWED_HOSTS: List[str] | str = Field(default=["*"])

    # PostgreSQL Configuration
    POSTGRES_HOST: str = Field(default="localhost")
    POSTGRES_PORT: int = Field(default=5432)
    POSTGRES_USER: str = Field(default="dlp_user")
    POSTGRES_PASSWORD: str = Field(...)
    POSTGRES_DB: str = Field(default="cybersentineldlp")
    POSTGRES_POOL_SIZE: int = Field(default=20)
    POSTGRES_MAX_OVERFLOW: int = Field(default=10)

    @property
    def DATABASE_URL(self) -> str:
        """Construct PostgreSQL connection URL"""
        return str(PostgresDsn.build(
            scheme="postgresql+asyncpg",
            username=self.POSTGRES_USER,
            password=self.POSTGRES_PASSWORD,
            host=self.POSTGRES_HOST,
            port=self.POSTGRES_PORT,
            path=self.POSTGRES_DB,
        ))

    # MongoDB Configuration
    MONGODB_HOST: str = Field(default="localhost")
    MONGODB_PORT: int = Field(default=27017)
    MONGODB_USER: str = Field(default="dlp_user")
    MONGODB_PASSWORD: str = Field(...)
    MONGODB_DB: str = Field(default="cybersentineldlp")
    MONGODB_MAX_POOL_SIZE: int = Field(default=100)

    @property
    def MONGODB_URL(self) -> str:
        """Construct MongoDB connection URL"""
        return str(MongoDsn.build(
            scheme="mongodb",
            username=self.MONGODB_USER,
            password=self.MONGODB_PASSWORD,
            host=self.MONGODB_HOST,
            port=self.MONGODB_PORT,
            path=self.MONGODB_DB,
            query="authSource=admin",
        ))

    # Redis Configuration
    REDIS_HOST: str = Field(default="localhost")
    REDIS_PORT: int = Field(default=6379)
    REDIS_PASSWORD: Optional[str] = Field(default=None)
    REDIS_DB: int = Field(default=0)
    REDIS_POOL_SIZE: int = Field(default=10)

    @property
    def REDIS_URL(self) -> str:
        """Construct Redis connection URL"""
        return str(RedisDsn.build(
            scheme="redis",
            password=self.REDIS_PASSWORD,
            host=self.REDIS_HOST,
            port=self.REDIS_PORT,
            path=str(self.REDIS_DB),
        ))

    # OpenSearch Configuration
    OPENSEARCH_HOST: str = Field(default="localhost")
    OPENSEARCH_PORT: int = Field(default=9200)
    OPENSEARCH_USER: str = Field(default="admin")
    OPENSEARCH_PASSWORD: str = Field(...)
    OPENSEARCH_USE_SSL: bool = Field(default=True)
    OPENSEARCH_VERIFY_CERTS: bool = Field(default=False)
    OPENSEARCH_INDEX_PREFIX: str = Field(default="cybersentineldlp")
    OPENSEARCH_RETENTION_DAYS: int = Field(default=90)

    # Event Retention Configuration
    EVENT_RETENTION_DAYS: int = Field(default=180)

    # Rate Limiting
    RATE_LIMIT_ENABLED: bool = Field(default=True)
    RATE_LIMIT_REQUESTS: int = Field(default=100)
    RATE_LIMIT_WINDOW: int = Field(default=60)

    # Timezone — controls display/API timestamps. Storage is always UTC.
    # Examples: "Asia/Kolkata", "US/Eastern", "Europe/London", "UTC"
    APP_TIMEZONE: str = Field(default="UTC")

    # Logging
    LOG_LEVEL: str = Field(default="INFO")
    LOG_FORMAT: str = Field(default="json")
    LOG_FILE: Optional[str] = Field(default=None)

    # Email Configuration (for alerts and reports)
    SMTP_HOST: str = Field(default="smtp.gmail.com")
    SMTP_PORT: int = Field(default=587)
    SMTP_TLS: bool = Field(default=True)
    SMTP_USER: Optional[str] = Field(default=None)
    SMTP_PASSWORD: Optional[str] = Field(default=None)
    SMTP_FROM: str = Field(default="dlp@cybersentineldlp.local")
    SMTP_FROM_EMAIL: str = Field(default="dlp@cybersentineldlp.local")

    # Wazuh Integration
    WAZUH_HOST: str = Field(default="localhost")
    WAZUH_PORT: int = Field(default=1514)
    WAZUH_PROTOCOL: str = Field(default="udp")
    WAZUH_API_URL: Optional[str] = Field(default=None)
    WAZUH_API_USER: Optional[str] = Field(default=None)
    WAZUH_API_PASSWORD: Optional[str] = Field(default=None)

    # ML Configuration
    ML_MODEL_PATH: str = Field(default="./ml/models")
    ML_INFERENCE_BATCH_SIZE: int = Field(default=32)
    ML_CONFIDENCE_THRESHOLD: float = Field(default=0.75)

    # DLP Configuration
    DLP_MAX_FILE_SIZE_MB: int = Field(default=100)
    DLP_SCAN_TIMEOUT_SECONDS: int = Field(default=30)
    DLP_QUARANTINE_PATH: str = Field(default="./quarantine")

    # Classification Thresholds
    CLASSIFICATION_HIGH_RISK_THRESHOLD: float = Field(default=0.85)
    CLASSIFICATION_MEDIUM_RISK_THRESHOLD: float = Field(default=0.60)

    # Monitoring & Metrics
    METRICS_ENABLED: bool = Field(default=True)
    HEALTH_CHECK_INTERVAL: int = Field(default=30)

    # Feature Flags
    FEATURE_ML_CLASSIFICATION: bool = Field(default=True)
    FEATURE_REAL_TIME_BLOCKING: bool = Field(default=True)
    FEATURE_CLOUD_CONNECTORS: bool = Field(default=True)

    # Google Drive OAuth
    GOOGLE_CLIENT_ID: Optional[str] = Field(default=None)
    GOOGLE_CLIENT_SECRET: Optional[str] = Field(default=None)
    GOOGLE_REDIRECT_URI: Optional[str] = Field(default=None)
    GOOGLE_OAUTH_CREDENTIALS_PATH: Optional[str] = Field(default="credentials.json")

    # OneDrive OAuth
    ONEDRIVE_CLIENT_ID: Optional[str] = Field(default=None)
    ONEDRIVE_CLIENT_SECRET: Optional[str] = Field(default=None)
    ONEDRIVE_REDIRECT_URI: Optional[str] = Field(default=None)
    ONEDRIVE_TENANT_ID: Optional[str] = Field(default="consumers")  # "consumers" for personal accounts, "common" for both, or tenant ID for org accounts

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        """
        Parse CORS origins from env.

        Supports:
        - JSON list string: ["http://localhost:3000","http://192.168.1.63:3000"]
        - Comma-separated:  http://localhost:3000,http://192.168.1.63:3000
        """
        if v is None or (isinstance(v, str) and not v.strip()):
            # Explicit empty env should fall back to the Field default.
            default = cls.model_fields["CORS_ORIGINS"].default
            return list(default) if isinstance(default, list) else default
        return cls._parse_list_env(v, field_name="CORS_ORIGINS")

    @field_validator("ALLOWED_HOSTS", mode="before")
    @classmethod
    def parse_allowed_hosts(cls, v):
        """
        Parse allowed hosts from env.

        Supports:
        - JSON list string: ["localhost","127.0.0.1","192.168.1.63"]
        - Comma-separated:  localhost,127.0.0.1,192.168.1.63
        """
        if v is None or (isinstance(v, str) and not v.strip()):
            # Explicit empty env should fall back to the Field default.
            default = cls.model_fields["ALLOWED_HOSTS"].default
            return list(default) if isinstance(default, list) else default
        return cls._parse_list_env(v, field_name="ALLOWED_HOSTS")

    @classmethod
    def _parse_list_env(cls, v, *, field_name: str) -> List[str]:
        """
        Parse list-like environment variable values.

        Accepts:
        - JSON list strings: ["a","b"]
        - Comma-separated strings: a,b
        - Python lists/tuples/sets
        """
        if isinstance(v, str):
            s = v.strip()
            if s.startswith("["):
                try:
                    parsed = json.loads(s)
                except json.JSONDecodeError as e:
                    raise ValueError(
                        f"{field_name} must be a JSON list or comma-separated string; "
                        f"got invalid JSON: {v!r}"
                    ) from e
                if not isinstance(parsed, list):
                    raise ValueError(f"{field_name} must be a JSON list; got {type(parsed).__name__}")
                items = parsed
            else:
                items = [part.strip() for part in s.split(",")]
        elif isinstance(v, (list, tuple, set)):
            items = list(v)
        else:
            raise ValueError(
                f"{field_name} must be a JSON list string, comma-separated string, or list; "
                f"got {type(v).__name__}"
            )

        cleaned = [str(item).strip() for item in items if str(item).strip()]
        if not cleaned:
            default = cls.model_fields[field_name].default
            return list(default) if isinstance(default, list) else default
        return cleaned

    @field_validator("SECRET_KEY", mode="after")
    @classmethod
    def reject_weak_secret_key(cls, v: str) -> str:
        """Prevent startup with placeholder or weak secret keys."""
        weak_keys = {
            "change-this-to-a-random-secret-key-min-32-chars",
            "change-this-secret-key-in-production",
            "secret",
            "changeme",
        }
        if v in weak_keys or len(v) < 32:
            raise ValueError(
                "SECRET_KEY is insecure. Set a random string of at least 32 characters. "
                "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        return v

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )


# Global settings instance
settings = Settings()
