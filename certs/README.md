# certs/

Mounted read-only into the manager at `/etc/cybersentineldlp/certs`, in both
dev and prod. Everything here is ignored by git except this README — a trust
anchor is per-deployment, and committing one would push trust in somebody
else's host to every deployment that pulls this repo.

Two unrelated kinds of file end up in this directory. Keep them straight:

| File | What it is | Who reads it |
|---|---|---|
| `siem-jwks.pem` | the **SIEM's** certificate — a trust anchor for TLS the DLP makes *outbound* | the manager, when fetching the SSO JWKS |
| `fullchain.pem` / `privkey.pem` | **our own** TLS material, for traffic *inbound* to the dashboard | nginx, in `docker-compose.prod.yml` |

The private key in the second row is ours and belongs here. A private key
belonging to the SIEM — or to anything else we merely talk to — never does:
verifying someone's identity needs their public certificate and nothing more.

## Why SSO needs this at all

SSO handoff tokens from the SIEM are signed RS256. The SIEM signs with its
private key; the DLP verifies with the public key it fetches from
`SIEM_JWKS_URL`. **That fetch is the trust anchor for every SSO login** —
anyone who can impersonate the JWKS host can serve their own public key and
mint tokens we would accept. So it is verified TLS, always, and there is
deliberately no "skip verification" switch anywhere in the product.

A SIEM on a private IP with a self-signed certificate is in no public CA
store, so that verification fails until this deployment is told what to
expect. That is all `SIEM_JWKS_CA_BUNDLE` does: it re-points verification at
a certificate you chose, instead of switching it off.

## Installing it

```bash
csdlp sso-cert fetch 10.200.10.23:3000   # take it from the SIEM, confirm the fingerprint
csdlp sso-cert install siem.pem          # or install one you were handed ( - reads stdin)
csdlp sso-cert check                     # prove the manager can fetch the JWKS
```

`install` writes `siem-jwks.pem`, sets `SIEM_JWKS_CA_BUNDLE` in `.env`,
recreates the manager (`up -d`, not `restart` — a restart reuses the old
environment and would never see the new value) and then verifies.

Doing it by hand is three steps:

```bash
cp siem.pem certs/siem-jwks.pem
echo 'SIEM_JWKS_CA_BUNDLE=/etc/cybersentineldlp/certs/siem-jwks.pem' >> .env
docker compose up -d manager
```

If the file is named but missing or unreadable, the JWKS fetch fails **closed**
— it does not quietly fall back to the system store, because a trust anchor
that silently disappears is worse than one that never worked.

## Production

Which certificate you pin matters more than how you install it.

- **Public CA, real hostname** (`siem.corp.example`): leave
  `SIEM_JWKS_CA_BUNDLE` empty. The system store already trusts it, and pinning
  buys nothing but a renewal chore.
- **Internal/corporate CA**: pin the **CA** certificate, not the server's.
  A CA outlives the certificates it issues, so the SIEM can renew without
  anyone touching the DLP.
- **Self-signed, as in dev**: pinning that one certificate is the only option,
  and it must be reinstalled **every time the SIEM's certificate is renewed**.

The certificate must also carry the host from `SIEM_JWKS_URL` in its SAN —
an IP-based URL needs that IP as an `IP Address:` SAN entry, not just in the
CN, which modern TLS stacks ignore.

Whatever you pin, note the expiry. The fetch fails closed, so the morning a
pinned certificate lapses **every SSO login stops** with a TLS error while
nothing else on the dashboard looks wrong. `csdlp sso-cert check` prints the
expiry date and warns inside 30 days.
