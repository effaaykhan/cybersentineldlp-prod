# SIEM → DLP integration contract

What the SIEM must send to provision DLP accounts and log users in.

Two separate flows, and they behave differently — worth reading the distinction
before coding:

| Flow | Who calls the DLP | Auth |
|---|---|---|
| **A. Open DLP** (a user clicks through) | the user's **browser** | exchange token in the URL |
| **B. Provisioning** (create/update/disable users) | the **SIEM server** | DLP admin session |

Flow A needs no API client at all — you mint a token and redirect. Flow B is
ordinary server-to-server REST using an admin session you obtain through Flow A's
endpoint.

---

## 0. Prerequisites

**Shared secret.** `DLP_SSO_SECRET` must be identical on both sides. Empty on the
DLP side ⇒ every exchange returns `503 SSO is not configured`. Use real random
bytes (`openssl rand -hex 32`), not a memorable pattern — this secret can now
choose a user's role, so guessing it is equivalent to minting an admin.

**IP allowlist.** The DLP portal is IP-restricted and **the allowlist is currently
enabled**. `/auth/sso/exchange` and `/users` are *not* exempt, so:

- Flow A is executed by the **user's browser** → the user's network must be allowlisted.
- Flow B is executed by the **SIEM server** → the SIEM server's IP must be allowlisted.

A missing entry returns `403 Access to this portal is restricted to authorized IP
addresses`. This is the single most common cause of "SSO suddenly stopped working".

**A DLP admin identity for the SIEM.** Flow B requires an access token belonging to
a DLP user with `manage_users`. Create one DLP `ADMIN` account whose email matches
the SIEM's service identity; the SIEM obtains its session by running Flow A for
itself.

**Base URL.** `http://<dlp-host>:55100/api/v1` (the dashboard is separate, on
`https://<dlp-host>:3023`).

---

## 1. The exchange token

A JWT the SIEM signs with `DLP_SSO_SECRET`, **HS256**. Keep the lifetime ~30s.

```jsonc
{
  // ── required ────────────────────────────────────────────────
  "purpose": "sso_exchange",              // exact string
  "iss":     "cybersentineldlp-siem",     // exact string
  "nonce":   "9f2c…",                     // unique per token (uuid4 hex)
  "email":   "analyst@corp.com",          // the DLP account identifier
  "exp":     1786000030,                  // now + 30s

  // ── optional: identity ──────────────────────────────────────
  "username":  "jdoe",
  "full_name": "J. Doe",

  // ── optional: privileges ────────────────────────────────────
  "role":   "L2",            // Administrator | L1 | L2 | L3
  "access": "read-write",    // read-write | read-only

  // ── optional: data scope ────────────────────────────────────
  "department":      "Finance",
  "clearance_level": 3        // 0–10
}
```

**Every optional claim can be omitted** — the DLP then behaves exactly as it did
before this integration existed. Send them and the account tracks the SIEM.

Three behaviours to code around:

- `nonce` is single-use, remembered for 60s. **Generate a fresh one per token**;
  reusing one returns `401 Exchange token already used`.
- A missing or unrecognised `access` is read as **read-only**. If the user is
  read-write, say so explicitly — silence is not treated as permission.
- An unrecognised `role` falls back to `VIEWER` and logs a warning. It does not
  error, because a login should not fail over a role typo.

---

## 2. Flow A — opening the DLP

No API call from the SIEM. Mint the token and redirect the browser:

```
https://<dlp-host>:3023/auth/sso?token=<exchange-token>
```

The dashboard posts the token to `/auth/sso/exchange` itself, stores the returned
tokens and lands on the console. Access tokens last 30 minutes; the dashboard
refreshes them on its own.

If you need the tokens server-side instead (to drive the API rather than the UI):

```http
POST /api/v1/auth/sso/exchange
Content-Type: application/json

{ "token": "<exchange-token>" }
```

```jsonc
200 → { "access_token": "…", "refresh_token": "…", "token_type": "bearer" }
```

**This endpoint never creates users.** An email with no DLP account returns
`401 User not found in DLP system`. Provision first (Flow B), then log in.

On each login the DLP re-applies `role` / `department` / `clearance_level` to
accounts the SIEM owns (see §5), so a promotion in the SIEM follows the user
automatically. Sending no `role` claim leaves the existing role alone rather than
resetting it.

---

## 3. Flow B — provisioning

First get an admin session: run the §2 exchange for the SIEM's own admin identity
and keep `access_token` (30 min). Then send it as `Authorization: Bearer <token>`.

### Create a user

```http
POST /api/v1/users/          ← keep the trailing slash
Authorization: Bearer <admin access token>
Content-Type: application/json
```

```jsonc
{
  "email":     "analyst@corp.com",   // required, unique, the login identifier
  "password":  "…",                  // required — see note below
  "full_name": "J. Doe",             // required
  "organization": "CyberSentinel",

  "siem_role": "L2",                 // your vocabulary; DLP translates
  "access":    "read-write",

  "username":   "jdoe",              // optional alias, must be unique
  "department": "Finance",           // optional
  "clearance_level": 3               // optional; defaults to the tier's value
}
```

`201` returns the created user including the resolved `role`, `permissions`,
`sso_managed` and `sso_source_role`.

**On the password:** it is required by the endpoint but an SSO user never types
it — generate 32 random characters and discard them. It must contain upper, lower,
digit and a symbol, minimum 7 characters, or you get a `400`.

**Alternative:** send `"role": "ANALYST"` (a DLP role name) instead of
`siem_role`/`access` if you'd rather own the mapping on your side. An explicit
`role` always wins. Sending neither yields `VIEWER`.

### Change a role

```http
PUT /api/v1/users/{user_id}
{ "siem_role": "L3", "access": "read-only" }
```

**Use `siem_role` here, not `role`.** They differ in ownership: `siem_role` keeps
the account tracking the SIEM, while a bare `role` is treated as a local
administrator's override and permanently detaches the account from SSO sync
(§5). Both are legitimate — just pick deliberately.

### Disable / re-enable / delete

```http
PUT    /api/v1/users/{user_id}          { "is_active": false }   ← disable
PUT    /api/v1/users/{user_id}          { "is_active": true }    ← re-enable
DELETE /api/v1/users/{user_id}                                   ← soft delete
DELETE /api/v1/users/{user_id}?hard=true                         ← permanent
```

A disabled account fails SSO login with `401 User account is disabled`.

### Reconcile your `dlpRegistered` flag

```http
GET /api/v1/auth/users/check?email=analyst@corp.com   →  { "exists": true }
```

Worth polling when your DLP page loads: a DLP admin can delete accounts directly,
and a stale flag means you'd redirect a user into a guaranteed 401.

---

## 4. Role mapping

Your role + access mode → the DLP role, and what that role can actually do:

| SIEM | Access | DLP role | Sees events & alerts | Sees captured content¹ | Exports | Writes policy | Manages users |
|---|---|---|---|---|---|---|---|
| Administrator | read-write | `ADMIN` | ✔ | ✔ | ✔ | ✔ | ✔ |
| Administrator | read-only | `MANAGER` | ✔ | ✖ | ✔ | ✖ | ✖ |
| L3 | read-write | `DATA_PROTECTION_ADMIN` | ✔ | ✔ | ✔ | ✔ | ✖ |
| L3 | read-only | `ANALYST` | ✔ | ✔ | ✖ | ✖ | ✖ |
| L2 | read-write | `ANALYST` | ✔ | ✔ | ✖ | ✖ | ✖ |
| L2 | read-only | `ANALYST` | ✔ | ✔ | ✖ | ✖ | ✖ |
| L1 | read-write | `VIEWER` | ✔ | ✖ | ✖ | ✖ | ✖ |
| L1 | read-only | `VIEWER` | ✔ | ✖ | ✖ | ✖ | ✖ |

¹ **The column that matters most.** The DLP separates "an event happened" from
"the data that event captured" — clipboard text, file excerpts, line diffs. Roles
without it get the full event stream with those fields replaced by a marker, so a
triage tier can work without the console doubling as an exfiltration path. The
SIEM has no equivalent concept, which is why the read-only column is not simply
the read-write role minus writes.

**L2 read-write and read-only both map to `ANALYST`** because `ANALYST` holds no
write permissions — the DLP has no "L2 who can change things" role to promote
into. Not an oversight; the alternative was inventing a role.

Two ways to change this table without touching code: `SSO_ROLE_MAP` (JSON) remaps
any cell, and `SSO_MAX_ROLE` caps the highest grantable role regardless of what a
token claims. Both are documented in `.env.example`.

### `department` and `clearance_level`

These are not cosmetic. The DLP filters every event by department, and **a user
with no department is denied every event** — a working login with a permanently
empty console. Send `department` if the SIEM knows it. Omit it and the account
falls back to the shared default, which sees the general event stream.

`clearance_level` defaults to the tier (Administrator 5, L3 4, L2 3, L1 2) unless
you send one.

---

## 5. Who owns an account

Each account is either SIEM-owned or locally owned, exposed as `sso_managed` on
every user response.

- **Created with `siem_role`** → SIEM-owned. Role, department and clearance are
  re-applied from the token on every login.
- **Created without it** (or from the DLP admin UI) → locally owned. SSO never
  rewrites it.
- **`PUT` with `siem_role`** → stays (or becomes) SIEM-owned.
- **`PUT` with a bare `role`** → becomes locally owned. This is how a DLP admin
  pins an exception; without it their change would silently revert at the user's
  next login.

So a DLP admin can always override the SIEM, and the SIEM can always take the
account back by sending `siem_role` again. `sso_source_role` records the last SIEM
role seen (e.g. `L3:ro`) for tracing.

---

## 6. Errors

| Status | Meaning | Fix |
|---|---|---|
| `403 …authorized IP addresses` | caller's IP not allowlisted | add the SIEM server / user network |
| `503 SSO is not configured` | `DLP_SSO_SECRET` empty on the DLP | set it, restart manager |
| `401 Invalid exchange token` | signature mismatch | secrets differ between products |
| `401 Exchange token has expired` | `exp` passed | clock skew, or a TTL that is too tight |
| `401 …wrong purpose` / `…wrong issuer` | claim typo | must be `sso_exchange` / `cybersentineldlp-siem` |
| `401 Exchange token already used` | nonce reused | generate a fresh nonce per token |
| `401 User not found in DLP system` | not provisioned | run Flow B first |
| `401 User account is disabled` | `is_active = false` | re-enable via `PUT` |
| `400 Unrecognised siem_role …` | bad `siem_role` on create/update | one of Administrator, L1, L2, L3 |
| `400 Password must be…` | weak generated password | ≥7 chars, upper + lower + digit + symbol |
| `403 Only administrators can assign the ADMIN role` | caller isn't `ADMIN` | the SIEM's service account must be `ADMIN` to seed admins |

---

## 7. Build checklist for the SIEM's DLP page

1. Config: DLP base URL, `DLP_SSO_SECRET`, the service admin's email.
2. A `mintExchangeToken(email, opts)` helper — HS256, fresh nonce, 30s expiry.
3. A `getDlpAdminSession()` helper — mint for the service identity, POST
   `/auth/sso/exchange`, cache `access_token` for <30 min.
4. **Register**: `POST /users/` with `siem_role` + `access` + a random password.
   Store your `dlpRegistered` flag on success.
5. **Open DLP**: redirect to `/auth/sso?token=…` with the user's current role and
   access mode. No API call.
6. **Role change**: `PUT /users/{id}` with `siem_role` + `access`.
7. **Deactivate**: `PUT /users/{id}` with `is_active: false`.
8. **Reconcile**: `GET /auth/users/check` on page load; clear the flag on `false`.
9. Surface `sso_managed: false` in your UI as "overridden in DLP" so an admin
   exception doesn't look like a bug when your role change appears not to stick.
