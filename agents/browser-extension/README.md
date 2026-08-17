# CyberSentinel DLP — browser extension

Granular **web activity control** on a managed endpoint. Not "which sites can
users reach", but **what they may do** in them:

| Category | Upload | Download | Attach | Send | Post / Generate | AI Response |
|---|---|---|---|---|---|---|
| Webmail (Gmail, Outlook Web, …) | ✅ | ✅ | ✅ | ✅ | — | — |
| File sharing / Cloud storage | ✅ | ✅ | — | — | ✅ | — |
| Collaboration (Slack, Teams, …) | ✅ | ✅ | — | — | ✅ | — |
| Generative AI (ChatGPT, Claude, Gemini, …) | ✅ | ✅ | ✅ | — | ✅ | 🔍 audit only |

Each cell is set independently in a **Web Activity Control** policy on the
dashboard, to `allow` / `log` / `alert` / `block`, with a sensitivity threshold
and per-app exceptions.

> This extension replaces the two that came before it — the *Cloud Upload Guard*
> and the *Email Protection* extension. One extension, one enrolment, one agent
> row on the dashboard, one answer to "is this content sensitive". Everything the
> email extension did (Gmail/Outlook send interception, OCR of attached images,
> PDF/Office text extraction, Aadhaar/PAN/passport/bank detection) is here.

## Two rules worth knowing before you install it

**1. Nothing is enforced until a policy says so.** An activity with no policy
covering it is not intercepted at all — no listeners, no latency, no behaviour
change. Install the extension on a fleet and nothing happens until you create a
policy. The Options popup shows exactly what is and isn't covered.

**2. The server decides.** Verdicts come from
`POST /agents/{id}/policy/evaluate`, so the platform's classification engine, ML
model, EDM index and document fingerprints all apply. The bundled scanner is the
fallback for when that call cannot be made, and it says so in the reason it
reports.

## How it works

```
catalogued page (from the app_catalog table, synced every 5 min)
  ├─ inject.js  (MAIN world)     patches fetch/XHR — pauses uploads carrying files
  ├─ content.js (ISOLATED)       arms inject.js with this app's identity + policy
  └─ activity-guard.js           holds the Send/Enter gesture on a ruled activity
       ├─ scanner.js             local detection (fallback only)
       └─ attachment-inspector   ships attachments to the offscreen document
            └─ offscreen.js      Tesseract OCR + pdf.js + OOXML text extraction
  ▼
background.js (service worker)
  ├─ POST /agents/{id}/policy/evaluate   ← the verdict, per body text and per attachment
  ├─ POST /events/                        ← the event, with the full prompt/body text
  ├─ GET  /app-catalog/sync               ← which hosts are which kind of app
  ├─ GET  /agents/{id}/web-activity-policy ← the matrix (also the offline fallback)
  └─ chrome.downloads.onCreated           ← the Download verb
  ▼
block ⇒ gesture cancelled + on-page notice   |   allow ⇒ gesture replayed
```

**Failure behaviour is per-activity, not global.** An activity set to `block`
fails **closed** on timeout or error — "the DLP server was slow" is not a reason
to permit an exfiltration the policy forbids. An activity set to `log` or `alert`
fails open. The previous build failed open unconditionally, in three places.

## Adding a GenAI vendor

Insert a row — no extension release:

```
Dashboard → (API) POST /api/v1/app-catalog/
  { "host_pattern": "newai.example", "app_name": "New AI", "category": "genai" }
```

Endpoints pick it up on the next sync (≤5 min) and the guard registers itself
there. Apps with no bundled DOM profile fall back to a structural resolver that
finds the composer and submit control generically, so a brand-new vendor is
guarded from the moment it is catalogued.

Self-hosted LLM UIs (Ollama, open-webui, LM Studio) are deliberately **not**
seeded — a browser match pattern cannot carry a port, so seeding `localhost:3000`
would inject the guard into every developer's dev server. Add your actual host.

## Components

- `manifest.json`, `src/` — the MV3 extension (Chrome / Edge 116+).
- `ocr/`, `pdf/` — bundled Tesseract and pdf.js; no network fetches, CSP-safe.
- `offscreen.html` — the one context with both a DOM and the extension's origin,
  which is what OCR needs. See the comments in it and in `src/offscreen.js`.
- `native-host/` — optional. Only supplies "which agent is this machine?" so
  browser events attribute to the same dashboard row as the endpoint agent.
  Everything works without it.

## Deploying it

**One script on the endpoint, one command on the server.**

### On the DLP server, once per release

```bash
python3 scripts/pack-extension.py
```

Packs and signs the extension and publishes it at `/api/v1/extension/`. The
signing key is generated on first run at
`/etc/cybersentineldlp/extension-signing.pem` — **back it up**: it is the
extension's identity, and losing it means every endpoint sees a different
extension on the next release. Bump `version` in `manifest.json` before packing
a new build; browsers only upgrade when the version increases.

The update feed is generated per request from the host the endpoint reached, so
one packed artifact works on every deployment without re-packing.

### On each endpoint

```
manage-windows-agent.ps1  →  [5] Extension  →  [1] Deploy / update
```

That is the whole thing. The script asks the server for the extension id, writes
the `ExtensionInstallForcelist` policy for **both Chrome and Edge**, and hands
the extension this machine's configuration. Restart the browser and it installs
itself.

A force-installed extension **cannot be disabled or removed by the user** and
updates itself — which is the difference between a DLP control and a suggestion.
It shows as *"Installed by enterprise policy"* at `chrome://extensions`.

### One agent per device

The same policy hands over the endpoint agent's identity, so a machine running
**both** the agent and the extension appears **once** on the dashboard — USB
copies, print jobs and ChatGPT prompts all on the same agent. When attached this
way the extension deliberately never registers and never heartbeats: the agent
owns that row and that liveness signal, and a browser beating on its behalf would
show a machine as active with the agent dead.

Install the agent first ([1] on the menu) so the identity exists. With no agent
on the box the extension enrols on its own — that deployment still works, it just
appears as its own row.

Nothing else needs configuring on the endpoint. The Options popup shows what it
resolved and greys out the fields policy owns.

### Then create a policy

Dashboard → Policies → *Web Activity Control*. Start in **Audit**: it records
what would have been blocked without stopping anyone.

### Testing on one machine

`chrome://extensions` → Developer mode → *Load unpacked* → this folder. The
packed and unpacked builds share an id (the public key is pinned in
`manifest.json`), so you debug the same extension you deploy. Configure it by
hand in the popup.

## Test

- With no policy: paste an Aadhaar number into ChatGPT → allowed, and an event
  appears with the full prompt. That is correct — nothing is ruled yet.
- Create a policy with GenAI → Post = **Block**, threshold Confidential. Repeat →
  blocked, with a red on-page notice naming the policy.
- Attach a **photo** of an ID card to a Gmail compose and Send → held while OCR
  runs, then blocked. The server has no OCR engine; the text the extension
  recovered is what convicts it.
- Set GenAI → Post = **Allow** and reload nothing — the next prompt goes through.
- Diagnose any miss with `CyberSentinelDebug()` in the page console: it reports
  whether the composer and submit control resolved, what the guard read, and
  which policy cell decided to engage.

## Known limitations

- Uploads that run inside a **Web Worker** are not visible to the page hook.
- **Desktop apps** (the ChatGPT/Claude/Slack native clients) are out of scope for
  a browser extension — that is the endpoint agent's job.
- Content sent for classification is capped at 10 MB per file; body text at
  200 000 characters, flagged as truncated when it is cut.
- **AI Response is audit-only, by design.** By the time a reply exists the prompt
  has already been sent, it streams in with no single moment to intercept, and
  tearing text out mid-render breaks the app for no security gain.
- App DOM selectors will rot. The structural fallback keeps coverage when they
  do — precision degrades, not detection.
