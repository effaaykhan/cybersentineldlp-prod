# Changelog - Testing and Fixes

**Date:** November 14-26, 2025  
**Testing Environment:** WSL2 (Ubuntu on Windows)  
**Tested By:** Vansh-Raja

This document details all changes, fixes, and improvements made during testing and deployment of the CyberSentinel DLP platform.

---

## ✋ A click is judged when it happens, not against a button found in advance — Agent v1.4.16 (September 23, 2026)

### Summary

1.4.15 fixed the resize. Snapping WhatsApp to half the screen broke text
blocking again. That was the eighth distinct way the click gate had failed. The
earlier seven: wrong control type, stale rectangle, hover-only, captionless
pictures, acquisition lag, a wrong control after a resize, and a rectangle
discarded on a UI rebuild. They all had the same cause.

### The design flaw

A click was inspected only if it landed inside a Send rectangle **located ahead
of time**:

```cpp
if (!fresh || !inside) { ...record why...; return CallNextHookEx(...); }
```

Every way that rectangle could be missing or wrong led to that line, and the
click went through. The line itself was never broken. It asked the question at
the wrong time. Locating the composer alone took 4055ms on a real conversation,
and every layout change starts that over. The Enter path never had this
problem, because it holds the keystroke and decides afterwards.

### The fix

Clicks now work the same way. When there is **no trustworthy rectangle**,
**something sensitive is waiting to be sent**, and **the policy says block**,
the click is held. The control under the pointer is then identified off the
hook thread, at the one point that matters:

* **Send** → blocked, with an event and the notice.
* **Anything else** → the click is replayed with `ReleaseClick`. It costs the
  user only the time it took to ask.
* **No answer within 2s** → blocked. With sensitive content waiting and a block
  policy, getting no answer is not the same as getting permission.

WhatsApp's Send control has no usable accessible name, so it is recognised by
its position beside the message box, and that box is found at the moment of the
click. The click being held is the one that would have moved focus, so the box
the user just typed into still has it. Fallbacks are the locator's cached
composer (if still alive) and probing to the left of the clicked control.

A rectangle found ahead of time is now a **fast path**, not a requirement. When
nothing sensitive is waiting, or the policy is alert-only, no click is held. An
ordinary click is not touched.

### Known edge

While sensitive text sits unsent in the box, a *drag* that starts inside the
app is replayed as a single click.

---

## 📐 A resize made the locator publish the wrong control as Send — Agent v1.4.15 (September 23, 2026)

### Summary

Text blocking stopped working after the WhatsApp window was resized. The log
shows why, and it is worse than a miss — the agent was enforcing against a
rectangle that was not the Send button:

```
15:21:47.313  locator located the Send button ... by position (beside the message box)
15:21:55.917  click at (949,924)  is outside the Send button rect [1267,189 1307,229]
15:22:08.061  click at (1795,857) is outside the Send button rect [1267,120 1307,160]
```

A 40×40 box at y≈120–229 — near the **top** of the window. The real Send button
is at `[1833,921 1894,982]`, bottom right. And it drifts (189→120), so it was
tracking something that scrolls.

### Root cause

A resize moves every control in the app and kills cached accessibility nodes.
**A dead element still answers `ElementRect`** — with the rectangle it had when
it died. So the cached composer handed back a message-box rectangle from the old
layout, `RectBesideComposer` faithfully found a control "beside" it, and that
control was published as Send.

Nothing downstream can tell a stale rectangle from a current one, so the layout
change has to be caught where the elements are owned.

### Fixes

* **A moved or resized window drops everything.** The locator remembers the
  window geometry it located against; when that changes it releases the
  composer, the content root and the send button, clears the published
  rectangle, and re-finds from scratch. Cheaper than reasoning about which
  cached element survived, and the only answer that cannot be subtly wrong.
* **A dead composer's rectangle is never used.** `ElementAlive` is now checked
  before `ElementRect`, and the result must be a sane rectangle inside the
  window.
* **No rectangle outside its own window is ever published as Send**
  (`RectInsideWindow`), applied at both publish sites — the point probes and the
  sampler's re-measure.

### Not the cause

The window-corner probe added in 1.4.13 never fired in any of this — there is no
"window corner" line in the log. It was the first thing suspected and it was
innocent.

---

## 🛑 Sensitive attachments are stopped at staging, not at the send — Agent v1.4.14 (September 23, 2026)

### Summary

The drop/paste attachment path now acts the moment a file is classified, the
same way the file-dialog path always has, instead of waiting to catch the send.

### Why

The detection side was never the problem. On the measured run the `.avif` was
detected, OCR'd, classified **Restricted** and armed at 12:58:36 — and the file
still went out at 12:58:38, because the Send button was not located until
12:58:40. The verdict was ready two seconds early; the gate simply lost a race.

Catching the exact send meant recognising a button in a Chromium UI that
rebuilds itself mid-conversation, faster than a person can click. That gate has
now failed five distinct ways (control type, stale rectangle, hover-only,
captionless pictures, acquisition lag), each a correct fix for a different part
of the same fragile assumption. The file-dialog path never had any of these
problems, because it has always acted at selection time.

### What changed

When `InspectStagedFiles` classifies a staged file Confidential/Restricted:

* **`action: block`** — terminate the app before the attachment reaches its
  TLS-encrypted upload (there is no gentler lever in user mode; we cannot reach
  into the app and un-stage a file it already holds), emit a BLOCK event, show
  the notice. Exactly what the file-dialog path does.
* **`action: alert`** — emit an ALERT event and leave the app alone. Audit-first
  behaviour is unchanged.

The send gates are left in place. They still catch typed messages, and they
still catch an attachment if this path declines to act.

### Trade-off, accepted deliberately

This acts even if the file was only being previewed and would never have been
sent. That is the cost of not depending on a race, and it was chosen over
continuing to patch the gate.

---

## ⏱ The Send button was found 1.5 seconds after the send — Agent v1.4.13 (September 23, 2026)

### Summary

A Restricted `.avif` was dropped into WhatsApp, OCR'd, classified and armed —
and the send still went through. The endpoint log has the whole sequence:

```
12:58:36.176  a sensitive file was staged ... (Restricted) - the next send will be blocked
12:58:38.757  click at (1848,942) NOT inspected: no Send button has been located
12:58:40.255  locator locked onto the composer after 4055ms
12:58:40.281  locator found the Send control beside the message box
12:58:45.510  the composer went stale (the app rebuilt it) - re-acquiring
12:58:46.317  click at (1856,960) NOT inspected: no Send button has been located
```

Both clicks are **inside** the rectangle `[1833,921 1894,982]` the locator went
on to publish. The verdict was ready two seconds before the send. The only thing
missing was knowing where the button was.

### A regression introduced in 1.4.10 (fixed)

The 12:58:46 miss was self-inflicted. That click was inside a valid rectangle and
the window had not moved, so 1.4.10's window-unchanged rule would have accepted
it at 6s old — but 1.4.10's *other* change, clearing the rectangle in
`PublishSendBtn(nullptr, 0)`, had already deleted the data that rule reads. The
two changes worked against each other.

Losing the *element* is not losing the *button*: WhatsApp rebuilds its composer
mid-conversation and re-acquires, while the button stays where it is.
`PublishSendBtn` no longer clears the rectangle. The two cases that genuinely
invalidate one are handled where they belong — focus leaving a managed app
clears it explicitly in the locator, and a moved window is caught by the hook's
`GetWindowRect` comparison.

### Acquisition was slower than the user (fixed)

Locking onto the composer took **4055ms**; the drop-and-click took ~2.5s. Every
probe so far needs the composer's rectangle, so all of them were blind at the
only moment that mattered.

`ProbeSendInWindowCorner` needs nothing but the window — it sweeps a band in
from the bottom-right corner, where a composer's send control sits. Position
alone is **not** allowed to identify Send there: with no composer there is no
"beside the message box" test to corroborate it, so `composerRect` is passed as
null and only a control whose name or automation id says *send* is accepted. A
false positive would swallow clicks in a corner the user actually uses, which is
worse than a miss.

Order is now: pointer → beside the composer → window corner.

---

## 🖼 A picture sent with no caption never reached the attachment hold — Agent v1.4.12 (September 23, 2026)

### Summary

1.4.9 added a hold so a send waits for its attachment's OCR. For a picture sent
**with no caption** the click never got that far.

### What was wrong

The locator only looks for the Send button while there is something worth
sending:

```cpp
g_composerHasText.store(!text.empty() || HasPendingDrop(t.pid, t.exe));
```

`HasPendingDrop` is true only once classification has **finished and come back
sensitive**. For a captionless picture, during the entire OCR there is no text
and no verdict — so the flag was false, the locator's search block was gated
off, no rectangle was ever published, and in `MouseProc` the click failed the
`fresh || inside` test and returned *before* the attachment hold was reached.

`KeyProc` does not consult this flag at all, which is exactly why Enter blocked
pictures and the Send button did not — the same Enter/mouse asymmetry this file
has been chasing throughout.

### The fix

`StagedRecently()` answers "was a file staged in this app recently, whatever the
verdict turned out to be", keyed on the *start* of the inspection rather than
the existence of a result. The locator's gate now opens the moment a file is
staged, giving it the whole OCR to find the button before the user clicks it.

Five minutes, matching the window `PendingDropFor` already allows for adding a
caption, so both halves of the same send agree on how long a staged file stays
interesting.

### Where this leaves image blocking

| Path | Before | After |
|---|---|---|
| Enter, picture, no caption | held (1.4.9) | held |
| Enter, picture + caption | held | held |
| Send button, picture + caption | held (needs 1.4.11 locator) | held |
| Send button, picture, no caption | **sent uninspected** | held |

---

## 👆 Blocking a send required hovering over the button first — Agent v1.4.11 (September 23, 2026)

### Summary

1.4.10 produced the first ever `via=send-button-click` block. But it only worked
after the user hovered over Send, and the agent said so in its own log:

```
click at (1798,860) NOT inspected: no Send button has been located in this app.
Hover over Send for a moment before clicking and it will be recognised.
```

A control with a documented bypass is not a control. **The first send of every
session went out uninspected.**

### What was wrong

Three things can locate the Send button, and on WhatsApp only one of them worked:

* `FindSendButton` — the tree walk. Fails outright:
  `locator found no Send button in whatsapp.root.exe - by name or beside the message box`.
* `ProbeHoveredSendControl` — `ElementFromPoint` at the cursor. Works, but only
  once the pointer is already on the control.
* Nothing else.

So the gate depended on the user hovering before clicking.

### The fix

`RectBesideComposer` already states where the button must be — level with the
message box, to its right, within 250px. Those are points `ElementFromPoint` can
be asked about without waiting for the pointer to arrive.

The point→validate→publish logic is extracted from the hover probe into
`TryPublishSendAtPoint`, and a new `ProbeSendBesideComposer` walks candidate
points outward from the composer's right edge (200, 150, 110, 80, 56, 36, 20px),
outermost first because the send control sits at the end of the composer's
button row. The locator asks the cursor first — most accurate — and falls back
to the computed points. Same control-type, size and name/position tests as
before; nothing is published that would not have been published on hover.

### Also fixed

The probe path publishes a rectangle **without caching an element**, so it never
set the `g_sendWnd` / `g_sendWndRect` pair that 1.4.10 added. The hook's
"has the window moved?" test therefore had nothing to compare against on the one
path that was actually finding the button. Both are now recorded on publish.

---

## 🖱 The Send button was found, measured correctly, and refused anyway — Agent v1.4.10 (September 21, 2026)

### Summary

Enter blocked a Restricted message; clicking Send sent it. The endpoint log
named the cause exactly:

```
17:43:33.989  click at (1784,793) is outside the Send button rect [1833,921 1894,982]
17:43:35.054  click at (1856,961) NOT inspected: the rectangle is 3426ms old (limit 3000ms)
```

(1856,961) is **inside** [1833,921 1894,982]. The button was located, the
rectangle was right, the click landed on it — and it was refused for being
426ms over an age limit.

### Two causes

**The rectangle was re-measured last.** The refresh sat at the bottom of
`SamplerThread`, below the composer read and the classification. That loop ticks
every 250ms, but this file already documents a Chromium composer read taking
seven seconds, so the measurement only happened once the slow work above it
finished. Observed ages: 3426ms, 4574ms, 64473ms. Hoisted to the top of the
loop, where it is one property read behind nothing that can stall.

**A lost button kept its rectangle.** `PublishSendBtn(nullptr, 0)` released the
element but left `g_sendRect` / `g_sendAtMs` standing, so clicks were refused as
"stale" against a rectangle describing a control that no longer existed —
`1046967ms old`, seventeen minutes. It is now cleared with the element, and such
a click is reported as "no Send button", which is both true and actionable.

### The age limit itself

A rectangle goes stale when the button **moves**, which happens when its window
moves or resizes — not when a clock runs out. Inside 3s the cached rectangle is
trusted outright; beyond that it is trusted for as long as `GetWindowRect` says
the window is precisely where it was when the measurement was taken (a
non-blocking user32 call, the only kind the hook may make), up to a 30s ceiling.

A composer growing to two lines still moves the button inside a stationary
window, and that case falls back to the previous behaviour — the click lands
outside the cached rectangle and is not inspected, exactly as before. No
regression, and the common case now works.

### Scope

`messaging_text_monitor.cpp` only, and within it only the Send-button rectangle
plumbing. The Enter path, the attachment hold added in 1.4.9, and every other
monitor are untouched.

---

## 📎 Attachments were sent before their inspection finished — Agent v1.4.9 (September 21, 2026)

### Summary

Sending a picture in a managed chat showed the DLP block notice *seconds after
the picture had already gone out*. The notice was real; the block was not.

### What was wrong

A staged file is classified on a worker thread — read it, OCR it, ask the
server. For a screenshot that is **seconds**. Both send gates could only ask
*"is there a verdict?"*, never *"is one coming?"*:

* **Click gate** — `MouseProc` called `PendingDropFor()`, found nothing (the OCR
  was still running), fell through to `return CallNextHookEx(...)` and the click
  went to the app. The image was sent. The verdict landed afterwards and raised
  the notice.
* **Enter gate** — `DecideAndAct` assumed the same thing in a comment:
  *"Already classified, on a thread, at drop time - so this costs a mutex and the
  keystroke is not held while a file is inspected."* True for a file dropped a
  while ago, false for a picture attached two seconds before Enter.
* Even a held keystroke would not have survived: `decisionTimeoutMs` defaults to
  **1200ms** and the watchdog released it uninspected — its own log line says
  *"the message was sent"*.

There was no in-flight state anywhere; `grep` found none.

### The fix

`StagedInspectionScope` marks an inspection in flight for as long as
`InspectStagedFiles` runs, and both gates now hold the send while one is
outstanding:

* The click is swallowed and replayed with `ReleaseClick()` if the file comes
  back clean, so a cleared attachment costs the user only what the OCR actually
  took — the wait is a condition variable, woken the instant the verdict lands,
  not a poll.
* The watchdog extends the hold while an attachment is being inspected instead
  of releasing at 1.2s.
* Ceiling of **8s**, and reaching it **blocks**. A file nobody finished reading
  has not been shown to be safe — the same `uninspectable ≠ clean` rule the rest
  of the pipeline already follows.

---

## 📸 Screen capture control policy — Agent v1.4.8 (September 21, 2026)

### Summary

Screen capture was the one enforced channel with no policy behind it. It is now
policy-driven like every other channel, with a new `screen_capture_control`
policy type, its own endpoint, and a config form in the console.

### What was wrong

`screenMonitor->Start()` was called unconditionally in `agent.cpp` — no policy
check and no config key. That meant:

* **No way to turn it off or tune it.** The block threshold was a hardcoded
  `Restricted || Confidential`, and the 17 watched capture tools were compiled
  into the binary.
* **Its events were silently dropped.** `SendEvent` gates on `EventsAllowed()`,
  and screen capture had no flag in that set — so on an endpoint with no *other*
  policy, a screenshot was blocked on screen and the event proving it never
  reached the console.
* **The OCR pass ran forever on every endpoint**, whether or not anyone wanted
  screen-capture control. It is the most expensive thing the agent does.
* **The event lied about the level.** It reported a flat `"Restricted"` whenever
  the sensitive flag was set, and named no policy.

### The policy

`GET /agents/{agent_id}/screen-capture-policy`, modelled on the messaging one.
No active policy → `enforced: false`, and the agent suppresses nothing, kills
nothing, raises nothing and runs no OCR.

| Setting | Meaning |
|---|---|
| `mode` | `enforce` / `audit` — audit records what *would* be blocked |
| `action` | `alert` / `block` — defaults to alert |
| `levels` | classification levels that make the screen sensitive |
| `block_keyboard` | withhold PrintScreen / Alt+PrintScreen / Win+Shift+S |
| `block_capture_tools` | watch for screen-capture applications |
| `terminate_tools` | close such a tool, vs. only recording it |
| `clear_clipboard` | wipe the clipboard after a blocked capture |
| `notify_user` | show the endpoint notice |
| `tools` | capture-tool exe names (empty = built-in list) |
| `exceptions.users` / `exceptions.processes` | exempt users / foreground apps |

The server resolves `mode` + `action` into the three suppression flags, so audit
mode arrives at the agent with all of them false and the agent never re-derives
that. Unticking every level collapses to `enforced: false` rather than silently
meaning "every level" — the same trap the messaging policy's data types hit.

### Also fixed

`EventsAllowed()` now counts this channel, the event carries `policy_id` /
`policy_name`, and it reports the level the scanner actually produced.

### ⚠ Behaviour change on upgrade

Screen capture **stops being enforced** until a `screen_capture_control` policy
is created and made active. That is deliberate and matches every other channel,
but a deployment relying on the old always-on behaviour must create the policy.

---

## 🩺 Agent v1.4.7 — honest policy-state reporting (September 21, 2026)

### Summary

Two reporting defects found while diagnosing a test endpoint that logged
`NO ACTIVE POLICIES FOUND!` while enforcing its messaging policy correctly.
Neither changed enforcement; both made a healthy agent look broken.

### "NO ACTIVE POLICIES FOUND!" on an enforcing agent (fixed)

The verdict was computed from `allowEvents`, which the policy bundle sets from
only four categories:

```cpp
allowEvents = hasFilePolices || hasClipboardPolicies ||
              hasUsbDevicePolicies || hasUsbTransferPolicies;
```

Messaging, printing, application control, network shares and web activity are
each synced from their own endpoint and were never represented in the bundle,
so an endpoint whose only policy was `messaging_app_control` reported that it
had no policies and "will not generate events" — while blocking messages and
sending events normally (`SendEvent` gates on `EventsAllowed()`, which does
count every channel).

The startup verdict now asks `EventsAllowed()`, and the two bundle-scoped
messages say what they actually measured instead of claiming a global verdict.

### Console showed `policy_sync_status: never` forever (fixed)

The Windows agent reported `policy_version` in its heartbeat but never
`policy_sync_status`, `policy_last_synced_at` or `policy_sync_error`, so the
server kept the `"never"` it writes at registration no matter how many syncs
succeeded — an agent syncing every 60 seconds displayed as one that had never
synced.

Every exit path of `SyncPolicies` now records an outcome, using the same
vocabulary the Linux agent already used so one console column means the same
thing on both platforms: `never | up_to_date | success | error_<http status> |
exception`. A recorded outcome is final, so a throw from the per-channel
fetches that run after the bundle is applied cannot relabel a successful sync.
`policy_sync_error` is sent even when empty, so a success clears the previous
failure's text instead of leaving it pinned beside a `success` status.

No server change was required — `HeartbeatRequest` already accepted all three
fields.

---

## 🔐 v2.1.1 — Random per-deployment admin password (July 17, 2026)

### Summary

Removes hardcoded default admin credentials. Found while validating the v2.1.0
GHCR images with a clean-room deploy.

### Default-credentials exposure (fixed)

The first admin was seeded with a **fixed** password, `Admin@1234`, written in
`server/app/main.py`. This repository is source-available, so every deployment
shipped with publicly-known admin credentials until an operator happened to
change them.

The manager now generates a **random 20-character password, unique per
deployment**, using `secrets` (CSPRNG). It is logged exactly once on first boot:

```bash
docker logs cybersentineldlp-manager 2>&1 | grep generated_password
```

The generator guarantees the app's own policy (upper + lower + digit + symbol,
verified against `validate_password_strength`, 1000/1000 samples valid and
unique). Set `DLP_ADMIN_PASSWORD` in `.env` to pin it from a secrets manager
instead (automated deployments) — then nothing is logged. Either path applies
**only** when seeding a brand-new database; it never rotates an existing admin.

### Why `must_change_password` was NOT enabled

Forcing a change on first login looks like the obvious companion fix, but the
two endpoints deadlock: `login()` rejects such users with **403 and no token**
(`auth.py:215`), while `/auth/change-password` **requires a valid JWT**
(`auth.py:319`). Enabling the flag would lock the only admin out permanently.
Left `FALSE` deliberately; the deadlock must be fixed before it can be used.

### Verified (clean-room, fresh database)

- Fresh install seeds a random password; `Admin@1234` appears **0** times.
- Login with the generated password → **200** + access token.
- Login with the old `Admin@1234` → **401**.
- Manager healthy, `environment=production`, `debug=false`, version 2.1.1.

Images: `dlp-manager` / `dlp-dashboard` at `:latest` and `:2.1.1`.

---

## 🛡️ Content-Inspection Hardening, Outage Resilience & OCR (July 15–16, 2026)

### Summary

A sustained hardening pass on content inspection and agent resilience, plus a new
OCR capability. Every item below was validated end-to-end on a live Windows
endpoint. The unifying principle: **content we could not fully inspect must never
be treated as clean** — classification reports what it saw; policy decides what to
do about not knowing (via `extraction_status = readable | unreadable | too_large`).

### Content-inspection bypasses closed

Each of these previously produced a green "allowed / Public" event while sensitive
data left the machine:

1. **Binary documents** (`312acf2`) — the C++ agent shredded non-printable bytes
   before upload, destroying PDF/DOCX/XLSX content so it classified Public. Fixed:
   the agent sends raw bytes (base64) and the server extracts text (pypdf,
   python-docx, openpyxl, python-pptx).
2. **Rename evasion** (`a4e0acb`) — `secret.txt` → `secret.docx` made the parser
   fail and the file read as empty → Public. Fixed: on parser failure, fall back
   to scanning the raw bytes as text when they look textual.
3. **Archives** (`bff19a6`) — zipping defeated inspection. Fixed: expand
   zip/tar/gz/7z (py7zr pinned `0.21.1`), recursing members back through the
   extractor under a zip-bomb budget (depth 3 / 500 entries / 100 MB).
4. **Oversize padding** (`b007deb`) — files over the agent cap returned allow.
   Fixed: cap raised 10 MB → 25 MB; over-cap sends `inspection_skipped=too_large`
   and enforces the server's decision.
5. **Scan window** (`e1f83b0`) — text past a 1 M-char cap was never scanned but
   reported as a complete read, so filler ahead of a secret classified Public (an
   87 KB zip was enough). Fixed: `Extracted.truncated` propagates through nested
   archives; a truncated read maps to `too_large`; the second regex cap was
   removed; `MAX_TEXT_CHARS` raised to 10 M. Regression tests added.
6. **Agent fail-open** (`0bbdb74`) — on API error/timeout the agent reported
   success and allowed the file, so stopping the server disabled USB inspection.
   Fixed: honour the existing fail-closed fallback, gated by a new
   `block_on_dlp_error` config flag (default true).
7. **No policy persistence** (`e55ddf0`) — policies lived only in memory, so an
   agent that restarted while the server was down enforced *nothing*. Fixed:
   cache the policy bundle to disk and load it at startup before the first sync.

### Outage resilience (endpoint agent)

- **Offline event spool** (`ba70719`) — events raised while the server is
  unreachable are written to `cybersentineldlp_events.spool` (16 MB cap) and
  replayed on reconnect, so an enforcement action always leaves an audit record.
- **Bounded HTTP timeouts** (`ba70719`) — added `WinHttpSetTimeouts` (connect 5 s,
  receive 60 s); previously a downed server stalled every USB copy for 60 s.
- **Stable identity + self-heal** (`a2b5718`) — the agent persists a generated
  `agent_id` into its config (no more new identity per restart) and re-registers
  automatically on a `404` heartbeat.

### OCR — scanned PDFs & images (`9158819`)

Scanned/image-only PDFs and screenshots have no text layer and were the last
uninspectable category. The server now OCRs them (Tesseract): image-only PDFs are
rasterised via poppler/pdf2image; raster images go straight to Tesseract (also
sniffed by magic bytes). Bounded by `DLP_OCR_MAX_PAGES`/`DLP_OCR_DPI`/
`DLP_OCR_PAGE_TIMEOUT`. Fully optional and graceful — if the OCR stack is absent
the file stays *uninspectable* (blocked by policy), never "clean". Manager image
gained `tesseract-ocr`, `tesseract-ocr-eng`, `poppler-utils` (system) and
`pytesseract`, `pdf2image`, `Pillow` (pip).

### Email DLP (built, not yet deployed)

- **SMTP relay** (`smtp-relay/`, `7d4487b`) — an aiosmtpd relay that MIME-walks
  outbound mail, asks the same server decision API, and rejects sensitive
  attachments/bodies with a real `550` at DATA. Deployment (Google Workspace
  outbound gateway + STARTTLS) is pending.
- **Dashboard email policy type** (`85b9afc`) — `email_send_prevention` added to
  the policy creator alongside `cloud_upload_prevention`.

### Files & tests

- Core extractor: `server/app/services/document_extract.py` (mirrored to
  `smtp-relay/app/extract.py`).
- Decision API: `server/app/api/v1/agents.py` (`/agents/{id}/policy/evaluate`).
- Agent: `agents/endpoint/windows/agent.cpp`.
- Regression tests: `server/tests/test_document_extract_truncation.py`.
- Test-sample generators: `tests/samples/New-DlpSizeSamples.ps1`,
  `tests/samples/New-DlpScanWindowSamples.ps1`.

---

## 🚀 OneDrive Hybrid Modification Detection (December 25, 2025)

### Summary

- **Total Files Modified:** 2
- **New Features:** Hybrid modification detection using Redis file state tracking and ETag comparison
- **Problem Solved:** File modifications were incorrectly shown as create+delete pairs instead of modification events

### Highlights

#### Hybrid Modification Detection System
- **Problem:** Microsoft Graph API delta queries sometimes report file modifications as "created" + "deleted" events instead of a single "updated" event
- **Solution:** Implemented hybrid approach combining delta API with file metadata comparison
  - **Delta API for Deletions & Creations:** Uses delta API as-is for reliable `changeType="deleted"` and `changeType="created"` events
  - **Metadata Comparison for Modifications:** When delta reports "updated" OR when a file previously seen appears as "created", verifies by comparing file state (ETag, version, lastModifiedDateTime)

#### Redis File State Storage
- Stores file state in Redis: `onedrive:file_state:{connection_id}:{file_id}`
- State includes: ETag, lastModifiedDateTime, version
- 90-day TTL for automatic cleanup of old file states
- Gracefully handles Redis unavailability (falls back to delta-only mode)

#### File Metadata Fetching
- `_fetch_file_metadata()` method fetches current file ETag/version from Graph API
- Compares current state with stored state to detect real modifications
- Handles API errors gracefully (skips verification on errors)

#### Enhanced Delta Processing
- **Deletions:** Uses delta as-is, removes file state from Redis
- **Creations:** Checks if file exists in Redis; if yes, treats as modification
- **Updates:** Verifies with metadata comparison before logging as modification
- Stores file state after processing each file

#### Event Normalizer Updates
- Includes ETag and version in event details for debugging
- Modification events properly marked with `event_subtype="file_modified"`
- Event details include ETag/version information

#### Files Changed
- `server/app/services/onedrive_polling.py` - Added Redis helpers, metadata fetching, modification detection logic
- `server/app/services/onedrive_event_normalizer.py` - Added ETag/version extraction and event details

#### Testing Results
- ✅ File modifications now show as `file_modified` events (not create+delete)
- ✅ File creations still work correctly
- ✅ File deletions still work correctly
- ✅ System gracefully handles Redis/API failures
- ✅ Historical modifications correctly identified
- ✅ No performance degradation in normal operation

---

## 🐛 Alert Counter Bug Fix (January 5, 2026)

### Summary
- **Total Files Modified:** 2
- **Problem Solved:** Alert counter capped at 100, blank page on alerts route
- **Root Cause:** API returned limited list (100 items) and frontend calculated counts from array length; frontend called `.filter()` on response object instead of alerts array

### Highlights

#### Alert Counter Fix
- **Problem:** Alert counters on Alerts page were capped at 100 even when more alerts existed
- **Root Cause:** API endpoint `/api/v1/alerts` had hardcoded `.limit(100)` on MongoDB queries, and frontend calculated counts by filtering the returned array
- **Solution:** 
  - Modified API to return both alerts list (limited to 100 for performance) and total counts separately
  - API now returns `{alerts: [...], counts: {new: X, acknowledged: Y, resolved: Z, total: N}}`
  - Frontend uses API-provided counts instead of calculating from array length
  - Counters now display accurate totals above 100

#### Blank Page Fix
- **Problem:** Alerts page (`/alerts`) showed blank white page with console error `TypeError: e.filter is not a function`
- **Root Cause:** Frontend tried to call `.filter()` on the response object when API returned new format
- **Solution:**
  - Added defensive handling to ensure `alerts` is always an array
  - Proper type checking for both old format (array) and new format (object with alerts and counts)
  - Added null/undefined checks and type validation

#### Files Changed
- `server/app/api/v1/alerts.py` - Changed response from `List[Alert]` to `AlertsResponse` with separate counts
- `dashboard/src/pages/Alerts.tsx` - Updated to use API counts and added defensive response handling

#### Testing Results
- ✅ Alert counters display accurate totals above 100 (verified with 201 alerts)
- ✅ Alerts page loads correctly without blank page errors
- ✅ Backward compatible with both old and new API response formats
- ✅ List display still limited to 100 for performance while counts show accurate totals

---

## 🚀 Google Drive Cloud Integration (November 26, 2025)

### Summary

- **Total Files Modified:** 25+
- **New Features:** Google Drive OAuth integration, Activity API polling, protected folder monitoring, baseline management, manual refresh
- **New Components:** Google Drive policy forms, protected folder management UI, baseline reset controls

### Highlights

#### Google Drive OAuth & Connection Management
- Implemented OAuth 2.0 flow for Google Drive authentication
- Created `GoogleDriveConnection` and `GoogleDriveProtectedFolder` models in PostgreSQL
- Added connection management API endpoints (`/google-drive/connect`, `/google-drive/connections`)
- Protected folder selection UI with folder tree navigation
- Connection status tracking and token refresh handling

#### Google Drive Activity Polling
- Celery-based background polling service (`GoogleDrivePollingService`)
- Polls Google Drive Activity API every 5 minutes for protected folders
- Event normalization from Google Drive activity format to DLP event format
- Supports file operations: created, modified, deleted, moved, copied, downloaded
- Deterministic event ID generation to prevent duplicates
- Per-folder baseline timestamps (`last_seen_timestamp`) to prevent historical re-ingestion

#### Baseline Management System
- Per-folder `last_seen_timestamp` stored in PostgreSQL
- Polling only fetches events after baseline timestamp
- Baseline initialized to `datetime.utcnow()` when folder is added to policy
- API endpoints for viewing and resetting baselines (`/google-drive/connections/{id}/protected-folders`, `/google-drive/connections/{id}/baseline`)
- UI controls to reset individual folder baselines or entire connection baseline
- "Monitoring since" date display in policy forms

#### Manual Refresh & Event Display
- Manual refresh button in Events UI triggers immediate Google Drive poll
- API endpoint `/google-drive/poll` for on-demand polling
- Enhanced event display with Google Drive-specific fields:
  - `event_subtype`: file_created, file_deleted, file_modified, etc.
  - `description`: Human-readable activity description
  - `file_id`, `folder_id`, `folder_name`, `folder_path`: Google Drive metadata
  - `mime_type`: File MIME type
  - `details`: Raw Google Drive activity payload
- Event timestamps use actual Google Drive activity timestamp (not poll time)

#### Policy Integration
- Google Drive Cloud policy type in policy creation wizard
- Policy configuration includes:
  - Google Drive connection selection
  - Protected folder selection (multi-select)
  - Policy rules matching on `source`, `connection_id`, `folder_id`
- Policy sync updates protected folders when policy is created/updated
- Policy evaluation matches Google Drive events against configured rules

#### Database Schema
- Migration `caa6530e7d81_add_google_drive_tables.py`:
  - `google_drive_connections` table: OAuth tokens, user email, connection status
  - `google_drive_protected_folders` table: Folder metadata, baseline timestamps
- Foreign key relationships to `users` and `policies` tables

#### Files Changed
- `server/app/models/google_drive.py` - Database models
- `server/app/services/google_drive_oauth.py` - OAuth and connection management
- `server/app/services/google_drive_polling.py` - Activity polling service
- `server/app/services/google_drive_event_normalizer.py` - Event normalization
- `server/app/tasks/google_drive_polling_tasks.py` - Celery task wrapper
- `server/app/api/v1/google_drive.py` - API endpoints
- `server/app/api/v1/policies.py` - Policy sync integration
- `server/app/api/v1/events.py` - Event model updates for Google Drive fields
- `dashboard/src/components/policies/GoogleDriveCloudPolicyForm.tsx` - Policy form
- `dashboard/src/components/google-drive/` - OAuth and folder selection components
- `dashboard/src/lib/api.ts` - Google Drive API client functions
- `dashboard/src/pages/Events.tsx` - Manual refresh button
- `dashboard/src/app/dashboard/events/page.tsx` - Manual refresh button (App Router)

#### Testing Results
- ✅ OAuth flow completes successfully
- ✅ Protected folders are stored and synced with policies
- ✅ Polling service fetches new activities correctly
- ✅ Baseline system prevents historical event re-ingestion
- ✅ Events display with correct Google Drive timestamps
- ✅ Manual refresh triggers immediate polling
- ✅ Policy matching works for Google Drive events
- ✅ No duplicate events appear after baseline implementation

---

## 🚀 Unified Policy Distribution & Cleanup (November 20, 2025)

### Summary

- **Total Files Modified:** 112
- **Lines Changed:** +1,295 insertions / -35,281 deletions
- **New Artifacts:** `.cursorrules`, `archive/`, `server/app/policies/`, `server/app/utils/policy_transformer.py`, `server/tests/test_agent_policy_transformer.py`, `dashboard/src/types/policy.ts`
- **Removed Artifacts:** Legacy YAML configs, `policy_engine` module/tests, `agents/common/*`, deprecated Windows/Linux installers, and 40+ outdated documentation files

### Highlights

#### Unified Policy Schema + API
- Added `type`, `severity`, and `config` columns to the `Policy` ORM plus Alembic migration, enabling storage of UI-native configurations.
- Introduced `transform_frontend_config_to_backend()` so create/update flows accept wizard output while preserving backend condition/action logic.
- `/api/v1/policies` responses now include the new fields, enforce real `User` objects for auth, and expose a `/policies/stats/summary` endpoint with MongoDB-backed violation counts.

#### Agent Policy Bundles
- Created `AgentPolicyTransformer` and `/api/v1/agents/{id}/policies/sync`, caching bundles per platform/capability in Redis to minimize payload churn.
- Agents register/report capability flags plus policy sync metadata (`policy_version`, `policy_sync_status`, `policy_last_synced_at`, `policy_sync_error`) so operators can verify rollout status from the dashboard.

#### Windows & Linux Agent Runtime
- Agents now fetch bundles on startup and at `policy_sync_interval`, restart filesystem observers when monitored paths change, and include policy context in file/clipboard/USB events.
- USB transfer handling maps to per-policy actions (block/quarantine/log) and emits richer telemetry (source/destination paths, policy metadata, content snippets).
- Heartbeats inherit policy version/sync metadata, while event payloads include `policy_version`, `source_path`, and truncated `content` for downstream evaluation.

#### Event Pipeline Hardening
- `EventProcessor` now plugs into the database-backed evaluator/action executor, attaches `matched_policies` and `policy_action_summaries`, and preserves clipboard text for policy checks.
- Clipboard events automatically populate `clipboard_content`, and USB/file events carry additional metadata for evaluator rules.

#### Frontend & Docs
- `dashboard/src/lib/api.ts` hydrates auth tokens from persisted state and adds helpers for enable/disable/statistics calls; shared policy types live under `dashboard/src/types/policy.ts`.
- `README.md`, `INSTALLATION_GUIDE.md`, and `TESTING_COMMANDS.md` reference the new policy workflow, while the obsolete documentation tree was moved into `archive/` or removed entirely to keep the repo lean.

## Summary

- **Total Files Modified:** 53 files
- **Lines Changed:** +3,869 insertions, -826 deletions
- **New Files:** 2 (.env.example, Login page component)
- **Major Fixes:** Dashboard authentication, Dashboard overview page, Alerts page, Events API, Linux Agent connectivity, Windows Agent connectivity, Docker configuration, Configuration system (removed hardcoded paths/IPs), Windows Agent USB monitoring threading fix, Agent lifecycle management, Timezone display (IST), Heartbeat system improvements, File transfer blocking (Windows), Event display improvements

---

## 🎯 Latest Updates (December 2025)

### 18. Policy System & Agent Alignment (early December 2025)
- Backend: tightened policy bundle generation (`agent_policy_transformer`), agent policy sync API, and action execution paths to reflect updated policy schemas; added tests for transformer and Google Drive normalization/models.
- Agents: Linux agent classification and config defaults aligned; supports faster policy sync cadence and logs richer heartbeat/sync telemetry.
- Frontend: policy forms/types updated to current backend schema (actions, fields), details modal and table rows refreshed to reflect new policy shape.
- Data: Alembic migration for Google Drive tables kept in sync; sample test files expanded for new classifiers/policies.
- Note: Quarantine remains future work (tracked in `archive/FUTURE_TODO.md`); current actions focus on alert/log/block.

### 17. Installer Automation (Windows & Linux) - December 10, 2025
- Added scripted installers:
  - **Windows:** `scripts/install_windows_agent.ps1` clones the agent, builds a venv, templates config, and registers a SYSTEM AtStartup Scheduled Task with restart-on-failure. Docs include usage, args, and troubleshooting.
  - **Linux:** `scripts/install_linux_agent.sh` clones the agent, builds a venv, templates config, and installs a systemd service (boot autostart, restart on failure).
- Docs: `scripts/README.md` updated with arguments, examples, and post-install commands.
- Hardening: Linux installer skips empty configs, handles `--force` clean re-provisioning, and notes agent log location (`/root/cybersentineldlp_agent.log` by default).
- Outcome: Both agents verified to auto-start after reboot; Linux logs surface 404 if manager is down (expected until registration).

### 16. India-Specific Detection & Clipboard Policy Alignment

#### Summary
- **Goal:** Align clipboard and file transfer detection with India-first identifiers and ensure agents strictly follow database policies as the single source of truth.

#### Highlights
- **India-Specific Patterns (Agents):**
  - Extended Windows agent content classifier to detect Aadhaar, PAN, IFSC, Indian bank accounts, Indian phone numbers, UPI IDs, MICR, and Indian-format dates of birth.
  - Added source code and secret patterns: generic code tokens, AWS access keys, GitHub tokens, generic API keys, and database connection strings (JDBC, MongoDB, Redis).
  - Reused the same classifier for clipboard, file events, and USB transfer events so all channels share a consistent label set.
- **Clipboard Monitoring (Windows):**
  - Switched clipboard capture to prefer `CF_UNICODETEXT` with fallback to `CF_TEXT`, fixing missing events from modern apps and standard `Ctrl+C` flows.
  - Introduced agent-side policy awareness: clipboard events are only sent when content is classified as sensitive **and** at least one active clipboard policy’s configured patterns match the detected labels.
  - Logged active clipboard/file/USB policy names on every policy bundle application to simplify debugging and manual validation.
- **Linux Agent:**
  - Confirmed filesystem monitoring pipeline and classification for sensitive content; added dedicated tests for Indian identifier and source code patterns.
  - Clarified that Linux currently performs **logical** blocking only (events marked as blocked by policies) and does not delete/move files on disk.
- **Quarantine Action Visibility:**
  - Temporarily removed `quarantine` from user-selectable actions in the dashboard (`File System` and `USB Transfer` policies) and from shared policy types.
  - Documented current limitation in `archive/FUTURE_TODO.md` – quarantine is tracked as future work and is not advertised as a working action in the UI.

#### Files Touched (Highlights)
- `agents/endpoint/windows/agent.py` – Unicode clipboard capture, India/source-code classifier, clipboard policy matching, USB transfer policy alignment.
- `agents/endpoint/linux/agent.py` – Classification confirmation and tests for new patterns.
- `dashboard/src/types/policy.ts` – Removed `quarantine` from active action enums; tightened policy types around `alert`, `log`, and `block`.
- `dashboard/src/components/policies/FileSystemPolicyForm.tsx` – Removed quarantine option and quarantine path field.
- `dashboard/src/components/policies/GoogleDriveLocalPolicyForm.tsx` – Removed quarantine option and quarantine path field.
- `dashboard/src/mocks/mockPolicies.ts` – Updated mock actions to use `block`/`alert` only.
- `dashboard/src/app/dashboard/settings/page.tsx` – Marked quarantine toggle as “coming soon”.
- `archive/FUTURE_TODO.md` – Captured end-to-end quarantine implementation as a tracked future enhancement.

---

## 🎯 Previous Updates (January 2025)

### 15. Policy Management UI Revamp

#### Problem
- Old policy tab showed YAML-based system (not actually implemented)
- No user-friendly way to create or manage policies
- Policies displayed as raw data without proper organization
- Missing features: edit, duplicate, toggle status, view details

#### Solution
- **Complete UI Redesign:**
  - Removed old YAML-based policy display
  - Created multi-step policy creation wizard (Type → Config → Review)
  - Added policy type selector with 4 types: Clipboard, File System, USB Device, USB Transfer
  - Implemented type-specific configuration forms with validation
  - Added Priority and Severity fields (customizable in step 2)
  - Created separate tables for Active and Inactive policies
  - Added 3-dots context menu for each policy row

- **Policy Creation Wizard:**
  - Step 1: Select policy type (2x2 card grid)
  - Step 2: Configure policy (Basic Info + Type-specific config)
    - Basic Info: Name, Description, Severity (Low/Medium/High/Critical), Priority (1-100), Enabled status
    - Type-specific: Patterns, directories, events, actions based on policy type
  - Step 3: Review and save (shows summary + JSON preview)

- **Policy Management Features:**
  - View Details: Read-only modal with full policy configuration, JSON toggle
  - Edit Policy: Opens creation modal pre-filled with existing policy data
  - Duplicate Policy: Creates copy and opens creation modal
  - Toggle Status: Activate/deactivate policy (moves between Active/Inactive tables)
  - Delete Policy: Removes policy with confirmation dialog

- **UI Components:**
  - `PolicyCreatorModal`: Multi-step wizard component
  - `PolicyTypeSelector`: 2x2 card grid for type selection
  - `ClipboardPolicyForm`: Pattern selection (predefined + custom regex)
  - `FileSystemPolicyForm`: Directory monitoring, file extensions, events
  - `USBDevicePolicyForm`: USB device events (connect, disconnect, file transfer)
  - `USBTransferPolicyForm`: Monitored directories, actions (block/quarantine)
  - `PolicyTable`: Reusable table component for Active/Inactive policies
  - `PolicyRow`: Individual policy row with icon, badges, metadata, 3-dots menu
  - `PolicyContextMenu`: Dropdown menu with all policy actions
  - `PolicyDetailsModal`: Read-only policy viewer with JSON toggle

- **Mock Data:**
  - Created `mockPolicies.ts` with 12 sample policies (9 active, 3 inactive)
  - Includes all 4 policy types with realistic configurations
  - Used for frontend development and testing

#### Files Changed
- `dashboard/src/app/dashboard/policies/page.tsx` - Complete rewrite with new UI
- `dashboard/src/components/policies/PolicyCreatorModal.tsx` - New multi-step wizard
- `dashboard/src/components/policies/PolicyTypeSelector.tsx` - New type selector
- `dashboard/src/components/policies/ClipboardPolicyForm.tsx` - New clipboard form
- `dashboard/src/components/policies/FileSystemPolicyForm.tsx` - New filesystem form
- `dashboard/src/components/policies/USBDevicePolicyForm.tsx` - New USB device form
- `dashboard/src/components/policies/USBTransferPolicyForm.tsx` - New USB transfer form
- `dashboard/src/components/policies/PolicyTable.tsx` - New table component
- `dashboard/src/components/policies/PolicyRow.tsx` - New row component
- `dashboard/src/components/policies/PolicyContextMenu.tsx` - New context menu
- `dashboard/src/components/policies/PolicyDetailsModal.tsx` - New details modal
- `dashboard/src/mocks/mockPolicies.ts` - New mock data file
- `dashboard/src/utils/policyUtils.ts` - New utility functions
- `dashboard/src/App.tsx` - Updated import for policies page

#### Current Status
- ✅ Frontend mock implementation complete
- ✅ All UI components built and tested
- ✅ Policy creation wizard working
- ✅ Active/Inactive tables displaying correctly
- ✅ Context menu actions functional (mock)
- ⏳ Backend integration pending (schema mismatch needs resolution)

#### Next Steps
- Integrate frontend with backend API
- Resolve schema mismatch between frontend form and backend API
- Implement actual policy CRUD operations
- Add policy evaluation engine integration

### 14. File Transfer Blocking Feature (Windows)

#### Problem
- No protection against copying sensitive files to removable drives (USB, external SSDs)
- Files could be copied to external storage without detection or blocking
- No visual feedback in dashboard for blocked transfers
- Event details showing raw JSON instead of user-friendly information

#### Solution
- **Windows Agent Transfer Blocking:**
  - Added removable drive monitoring with `watchdog` library
  - Detects files copied to removable drives (USB, external SSDs)
  - Compares file hash (SHA256) with files in monitored directories
  - Automatically deletes copied files from removable drives when match found
  - Sends blocked transfer events with `action: "blocked"` status
  - Handles file locking issues with retry mechanism (Windows Explorer locks files during copy)
  - Configurable via `transfer_blocking.enabled` in agent config

- **Backend Event Processing:**
  - Updated `EventCreate` model to accept `action`, `destination`, `blocked`, `event_subtype`, `description`, `user_email` fields
  - Backend now properly stores agent-provided `action` field (mapped to `action_taken`)
  - Fixed hardcoded `action_taken: "logged"` to use agent-provided action
  - Added debug logging for action field tracking

- **Dashboard Event Display:**
  - Created user-friendly `EventDetailModal` component for blocked transfers
  - Visual flow display: Source → Destination with file details
  - Shows file size, hash, transfer type, and action taken
  - Expandable raw JSON section for technical details
  - Improved standard event display with better formatting
  - Fixed `action_taken` field display (now shows "blocked" for blocked transfers, "logged" for others)

#### Configuration
```json
{
  "monitoring": {
    "transfer_blocking": {
      "enabled": true,
      "block_removable_drives": true,
      "poll_interval_seconds": 5
    }
  }
}
```

#### Files Changed
- `agents/endpoint/windows/agent.py` - Added transfer blocking logic, removable drive monitoring, file hash comparison
- `agents/endpoint/windows/agent_config.json` - Added transfer_blocking configuration section
- `server/app/api/v1/events.py` - Updated EventCreate model and event processing
- `dashboard/src/pages/Events.tsx` - Added EventDetailModal component and improved event display
- `dashboard/src/app/dashboard/events/page.tsx` - Added EventDetailModal component (app router version)

#### Testing Results
- ✅ Transfer blocking detects files copied to USB drives
- ✅ Files successfully deleted from removable drives when match found
- ✅ Blocked transfer events show `action_taken: "blocked"` in dashboard
- ✅ User-friendly event modal displays transfer details correctly
- ✅ File locking issues handled with retry mechanism
- ✅ Works with multiple monitored directories
- ✅ Handles path normalization (E:file.txt → E:\file.txt)

### 12. Agent Lifecycle Management and Heartbeat Improvements

#### Problem
- Agents didn't unregister cleanly on shutdown, leaving stale entries in dashboard
- Heartbeat timeout errors (5s timeout too short)
- Rate limiting middleware blocking agent heartbeats
- Agent names using hostname instead of friendly names
- "Last seen" timestamps not updating correctly
- Dashboard showing dead/inactive agents

#### Solution
- **Graceful Agent Shutdown:**
  - Added `unregister_agent()` method to both Linux and Windows agents
  - Agents now call `/agents/{agent_id}/unregister` endpoint on shutdown
  - Added signal handlers (SIGINT, SIGTERM) for clean shutdown
  - Added `atexit` handler as backup for cleanup

- **Heartbeat System Improvements:**
  - Increased heartbeat timeout from 5s to 30s (handles slow server responses)
  - Reduced heartbeat interval from 60s to 30s (more frequent updates)
  - Heartbeat now sends timestamp (ISO format with Z suffix) and IP address
  - Improved heartbeat logging (INFO level instead of DEBUG)
  - Fixed datetime timezone awareness in heartbeat endpoint

- **Rate Limiting Fix:**
  - Bypassed rate limiting for agent endpoints (heartbeat, registration)
  - Prevents Redis delays from blocking critical agent operations
  - Fixed datetime timezone comparison errors in rate limiting

- **Agent Name Standardization:**
  - Linux agent default name: "Linux-Agent" (was hostname)
  - Windows agent default name: "Windows-Agent" (configurable)
  - Updated config files with new default names

- **Backend Agent Management:**
  - Agents filtered by `last_seen` timestamp (only active within 5 minutes)
  - Dead agents automatically cleaned up in background
  - Removed `status` field (replaced with time-based filtering)
  - Backend converts datetime to ISO strings with 'Z' suffix for frontend

- **Frontend Improvements:**
  - Dashboard shows only active agents (filtered by backend)
  - Removed status indicators (no longer needed)
  - "Last seen" displays correctly with IST timezone
  - Auto-refresh every 10 seconds for real-time updates
  - Events page shows agent names instead of agent IDs

### 13. Timezone Display Fixes (IST)

#### Problem
- Dashboard timestamps displayed in UTC instead of IST
- Timezone conversion not working correctly
- "Last seen" times showing incorrect values

#### Solution
- **Frontend Timezone Conversion:**
  - Added `parseAsUTC()` function to handle dates without timezone info
  - All date formatting functions now use IST timezone (`Asia/Kolkata`)
  - Updated `formatDate()`, `formatRelativeTime()`, `formatTimeIST()`, `formatDateTimeIST()`
  - Fixed UTC date parsing (appends 'Z' if timezone missing)

- **Backend Timestamp Formatting:**
  - Backend explicitly converts datetime objects to ISO strings with 'Z' suffix
  - Ensures frontend receives properly formatted UTC timestamps
  - Fixed timezone awareness in heartbeat endpoint

- **Dashboard Components Updated:**
  - Events page: All timestamps display in IST
  - Agents page: "Last seen" and "Registered" times in IST
  - Dashboard charts: X-axis and tooltips show IST times
  - Recent events: Timestamps in IST format

---

## 🎯 Major Fixes

### 11. Configuration System - Removed Hardcoded Paths and IPs

#### Problem
- Hardcoded IP addresses (`172.23.19.78`) in `docker-compose.yml`
- Hardcoded server URLs in agent config files
- System-specific paths in installation guide
- No environment variable support for configuration
- Not portable across different systems

#### Solution
- **`.env.example`**: Created comprehensive environment variable template
  - Network configuration (`SERVER_IP`, `CORS_ORIGINS`, `VITE_API_URL`, `VITE_WS_URL`)
  - Database passwords and security keys
  - All configurable settings with sensible defaults

- **`docker-compose.yml`**: Updated to use environment variables
  - `CORS_ORIGINS` uses `${CORS_ORIGINS}` with localhost defaults
  - `VITE_API_URL` and `VITE_WS_URL` use environment variables with defaults
  - All values configurable via `.env` file

- **`agents/endpoint/linux/agent.py`**: Added environment variable support
  - Checks `CYBERSENTINELDLP_SERVER_URL` environment variable first
  - Falls back to config file, then defaults to `http://localhost:55000/api/v1`
  - Environment variable takes precedence over config file

- **`agents/endpoint/windows/agent.py`**: Added environment variable support
  - Checks `CYBERSENTINELDLP_SERVER_URL` environment variable first
  - Falls back to config file, then defaults to `http://localhost:55000/api/v1`
  - Environment variable expansion for `%USERNAME%` in monitored paths (via `os.path.expandvars()`)
  - Environment variable takes precedence over config file

- **`agents/endpoint/linux/agent_config.json`**: Updated default server URL
  - Changed from hardcoded IP to `http://localhost:55000/api/v1`

- **`agents/endpoint/windows/agent_config.json`**: Updated default server URL
  - Changed from hardcoded IP to `http://localhost:55000/api/v1`
  - Supports `%USERNAME%` in monitored paths (expanded at runtime)

- **`dashboard/Dockerfile`**: Fixed package manager issue
  - Changed `apk` (Alpine) to `apt-get` (Debian-based image)
  - Fixed curl installation order (before switching to non-root user)

- **`dashboard/src/lib/api.ts`**: Fixed duplicate exports
  - Removed duplicate function exports causing build errors
  - Cleaned up API client structure

- **`INSTALLATION_GUIDE.md`**: Updated with configurable paths
  - Removed hardcoded system-specific paths
  - Added instructions for `.env` file configuration
  - Updated agent configuration examples with environment variables

#### Files Changed
- `.env.example` (new file)
- `docker-compose.yml`
- `agents/endpoint/linux/agent.py`
- `agents/endpoint/linux/agent_config.json`
- `agents/endpoint/windows/agent.py`
- `agents/endpoint/windows/agent_config.json`
- `dashboard/Dockerfile`
- `dashboard/src/lib/api.ts`
- `INSTALLATION_GUIDE.md`

#### Testing Results
- ✅ Dashboard builds and runs with environment variables
- ✅ Linux agent connects using `localhost` default
- ✅ Windows agent connects using `localhost` default
- ✅ Environment variables override config file values
- ✅ Windows agent expands `%USERNAME%` in monitored paths correctly
- ✅ All hardcoded IPs removed
- ✅ System works out-of-the-box with sensible defaults

---

### 1. Dashboard Build and Runtime Issues

#### Problem
- Dashboard failed to build due to Next.js/Vite mismatch
- Missing dependencies (`react-router-dom`)
- Incorrect build commands in Dockerfile
- Environment variables not properly configured for Vite

#### Solution
- **`dashboard/Dockerfile`**: Migrated from Next.js to Vite build system
  - Changed base image to `node:20-slim`
  - Updated build commands to use `vite build` instead of Next.js
  - Fixed `CMD` to use `vite preview` for production
  - Added proper Vite environment variable handling via build args

- **`dashboard/package.json`**: Updated dependencies and scripts
  - Added `react-router-dom: ^6.20.0` to dependencies
  - Added `@vitejs/plugin-react` and `vite` to devDependencies
  - Updated scripts: `dev`, `build`, `start`, `preview` to use Vite

- **`dashboard/src/index.css`**: Fixed Tailwind CSS error
  - Changed `@apply border-border;` to `@apply border-gray-200;`

#### Files Changed
- `dashboard/Dockerfile`
- `dashboard/package.json`
- `dashboard/package-lock.json`
- `dashboard/src/index.css`

---

### 2. Dashboard Authentication System

#### Problem
- Dashboard had mock authentication
- No login page
- API calls failing with 401 Unauthorized
- Routes not protected

#### Solution
- **`dashboard/src/lib/store/auth.ts`**: Implemented real authentication
  - Replaced mock auth with actual API calls to `/auth/login` and `/auth/refresh`
  - Uses OAuth2PasswordRequestForm format (form-urlencoded)
  - Properly handles JWT tokens and refresh tokens
  - Stores authentication state in Zustand with persistence

- **`dashboard/src/pages/Login.tsx`**: Created new login page
  - Beautiful gradient UI with animated background
  - Form validation and error handling
  - Redirects to dashboard on successful login

- **`dashboard/src/components/Layout.tsx`**: Added route protection
  - Checks authentication status
  - Redirects unauthenticated users to login page
  - Handles client-side hydration

- **`dashboard/src/App.tsx`**: Added login route
  - New route `/login` pointing to Login component

#### Files Changed
- `dashboard/src/lib/store/auth.ts`
- `dashboard/src/components/Layout.tsx`
- `dashboard/src/components/auth/LoginForm.tsx`
- `dashboard/src/App.tsx`
- `dashboard/src/pages/Login.tsx` (new file)

---

### 3. Events API Response Format

#### Problem
- Events API returned 500 error
- Response format mismatch between API and frontend
- MongoDB `_id` fields causing validation errors
- Frontend expected nested structure but API returned flat structure

#### Solution
- **`server/app/api/v1/events.py`**: Fixed API response
  - Changed response model from `List[DLPEvent]` to `EventsResponse` with pagination
  - Added `EventsResponse` model with `events`, `total`, `skip`, `limit` fields
  - Removed MongoDB `_id` fields from response
  - Ensured all required fields have defaults
  - Fixed `current_user` access (changed from dict to User object)

- **`dashboard/src/pages/Events.tsx`**: Updated to match API structure
  - Changed from `event.event.severity` to `event.severity`
  - Changed from `event.event.type` to `event.event_type`
  - Updated field access: `event.timestamp`, `event.file_path`, `event.agent_id`
  - Fixed classification labels display

- **`dashboard/src/lib/api.ts`**: Updated Event type definition
  - Added all required fields: `classification_score`, `classification_labels`, `blocked`, `policy_id`, etc.
  - Updated `timestamp` to accept `string | Date`

#### Files Changed
- `server/app/api/v1/events.py`
- `dashboard/src/pages/Events.tsx`
- `dashboard/src/lib/api.ts`

---

### 4. Agent Configuration and Connectivity

#### Problem
- Linux agent couldn't connect to server
- Incorrect server URL in configuration
- Heartbeat endpoint mismatch (POST vs PUT)
- Permission errors for log/config files

#### Solution
- **`agents/endpoint/linux/agent.py`**: Multiple fixes
  - Updated default `server_url` to use correct port (55000) and path (`/api/v1`)
  - Changed `send_heartbeat` from `POST` to `PUT` to match server endpoint
  - Fixed log file location to use `~/cybersentineldlp_agent.log` (user-writable)
  - Improved config loading with fallback to local config if `/etc/cybersentineldlp` not writable
  - Better error handling for directory creation

- **`agents/endpoint/linux/agent_config.json`**: Updated configuration
  - Set `server_url` to `http://172.23.19.78:55000/api/v1` (WSL IP)
  - Updated `agent_id` to match registered agent

- **`agents/endpoint/windows/agent.py`**: Multiple fixes
  - Updated default `server_url` to use correct port (55000) and path (`/api/v1`)
  - Changed `send_heartbeat` from `POST` to `PUT` to match server endpoint
  - Added environment variable expansion in `start_file_monitoring()` using `os.path.expandvars()`
  - Added logging for file events to track monitoring activity
  - Fixed path expansion for `%USERNAME%` in monitored paths

- **`agents/endpoint/windows/agent_config.json`**: Updated for WSL compatibility
  - Set `server_url` to `http://localhost:55000/api/v1` for WSL2
  - Updated `agent_id` to `windows-agent-001` for testing

#### Files Changed
- `agents/endpoint/linux/agent.py`
- `agents/endpoint/linux/agent_config.json`
- `agents/endpoint/windows/agent.py`
- `agents/endpoint/windows/agent_config.json`

---

### 5. Docker Configuration

#### Problem
- CORS errors preventing dashboard from accessing API
- Server running on wrong port (8000 instead of 55000)
- OpenSearch healthcheck failing
- Environment variables not properly configured

#### Solution
- **`docker-compose.yml`**: Multiple fixes
  - Updated `CORS_ORIGINS` to include WSL IP: `http://172.23.19.78:3000`
  - Added `ALLOWED_HOSTS` with WSL IP
  - Fixed dashboard build args to pass Vite environment variables
  - Removed duplicate OpenSearch security settings
  - Added `DISABLE_SECURITY_PLUGIN=true` for OpenSearch

- **`server/Dockerfile`**: Fixed port configuration
  - Updated `EXPOSE` to port `55000`
  - Updated `HEALTHCHECK` to use correct port
  - Set `ENV PORT=55000`
  - Updated `CMD` to use port 55000

#### Files Changed
- `docker-compose.yml`
- `server/Dockerfile`

---

### 6. Database and Security Fixes

#### Problem
- User ID type mismatch (integer vs UUID)
- Role enum case mismatch (lowercase vs uppercase)
- Token blacklist failing incorrectly
- Database initialization errors

#### Solution
- **`server/init_db.py`**: Fixed database schema
  - Changed user `id` from `SERIAL PRIMARY KEY` to `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - Updated default admin role to `'ADMIN'` (uppercase)
  - Added `policies` table creation
  - Updated default admin password to `"admin"`

- **`server/app/models/user.py`**: Fixed UserRole enum
  - Changed enum values to uppercase: `ADMIN`, `ANALYST`, `VIEWER`

- **`server/app/core/security.py`**: Fixed role comparison
  - Updated `role_hierarchy` to use uppercase keys
  - Added role conversion to uppercase for comparison

- **`server/app/services/blacklist_service.py`**: Fixed fail-safe logic
  - Changed error handling to return `False` (token valid) instead of `True` (token revoked)
  - Prevents all tokens from being rejected on Redis errors

#### Files Changed
- `server/init_db.py`
- `server/app/models/user.py`
- `server/app/core/security.py`
- `server/app/services/blacklist_service.py`

---

### 7. OpenSearch Configuration

#### Problem
- OpenSearch container unhealthy
- SSL connection errors
- Healthcheck authentication failures

#### Solution
- **`server/app/core/opensearch.py`**: Fixed client initialization
  - Conditionally add `http_auth` only if `OPENSEARCH_USE_SSL` is `True`
  - Fixed `exists_index_template` check using `get_index_template` with `NotFoundError` handling
  - Removed unnecessary `connection_class` parameter
  - Added error handling in `close_opensearch()`

- **`server/app/core/config.py`**: Updated OpenSearch settings
  - Set `OPENSEARCH_USE_SSL: bool = Field(default=False)`

#### Files Changed
- `server/app/core/opensearch.py`
- `server/app/core/config.py`

---

### 8. Frontend API Client Updates

#### Problem
- API client using wrong port (8000 instead of 55000)
- Environment variables not properly read (Next.js vs Vite)
- Missing exports for API functions

#### Solution
- **`dashboard/src/lib/api.ts`**: Multiple fixes
  - Updated `baseURL` to use `import.meta.env.VITE_API_URL` (Vite format)
  - Changed default port from 8000 to 55000
  - Fixed refresh token endpoint to use correct API URL
  - Exported all required functions: `getStats`, `getEventTimeSeries`, `getEventsByType`, `getEventsBySeverity`, `getAgents`, `deleteAgent`, `getAlerts`, `searchEvents`
  - Exported `Agent` and `Event` types
  - Fixed `getEventTimeSeries` function signature

#### Files Changed
- `dashboard/src/lib/api.ts`

---

### 9. Dashboard Overview Page Fix

#### Problem
- Dashboard overview page showing all zeros (0 agents, 0 events)
- Stats cards not displaying real data from database
- Charts not showing any data
- Dashboard data not synchronized with Agents and Events pages

#### Solution
- **`server/app/api/v1/dashboard.py`**: Fixed dashboard overview endpoint
  - Changed events collection from `db["events"]` to `db.dlp_events` (correct collection name)
  - Added agent queries from MongoDB `agents` collection
  - Updated response format to match frontend expectations:
    - `total_agents`: Count of all registered agents
    - `active_agents`: Count of agents with status "online"
    - `total_events`: Total count of all events
    - `critical_alerts`: Count of events with severity "critical"
    - `blocked_events`: Count of blocked events

- **`server/app/api/v1/events.py`**: Added missing stats endpoints
  - Added `/events/stats/by-type` endpoint for pie chart data
  - Added `/events/stats/by-severity` endpoint for bar chart data
  - Both endpoints aggregate data from `dlp_events` collection
  - Return data in format expected by chart components

- **`server/app/api/v1/dashboard.py`**: Fixed timeline endpoint
  - Updated to use `db.dlp_events` collection
  - Returns timeline data in correct format for line chart

#### Files Changed
- `server/app/api/v1/dashboard.py`
- `server/app/api/v1/events.py`

#### Testing
- Verified dashboard shows correct agent count (3 agents)
- Verified dashboard shows correct event count (362 events)
- Verified charts display data correctly:
  - Events Over Time: Line chart with hourly event counts
  - Events by Type: Pie chart showing file (99%), clipboard (1%)
  - Events by Severity: Bar chart showing critical, high, medium, low
- Verified data consistency across Dashboard, Agents, and Events pages

---

### 10. Alerts Page Fix

#### Problem
- Alerts page showing "0 alerts" even though dashboard showed 33 critical alerts
- Alerts API endpoint returning empty array
- `AttributeError: 'User' object has no attribute 'get'` when accessing current_user

#### Solution
- **`server/app/api/v1/alerts.py`**: Complete rewrite of alerts endpoint
  - Generates alerts dynamically from critical/high severity events in MongoDB
  - Checks for existing alerts in MongoDB collection first
  - If no alerts exist, creates alerts from events with severity "critical" or "high"
  - Formats alert titles and descriptions based on event type:
    - File events: "Sensitive Data Detected in File" with file path
    - Clipboard events: "Sensitive Data Copied to Clipboard"
    - USB events: "USB Device Connected"
  - Sets all generated alerts to status "new"
  - Added optional filtering by severity and status
  - Fixed `current_user` access: Changed `current_user.get("email")` to `getattr(current_user, "email", "unknown")`

#### Files Changed
- `server/app/api/v1/alerts.py`

#### Testing
- Verified alerts page displays 33 new alerts (matching dashboard critical alerts count)
- Verified stats cards show correct counts (33 New, 0 Acknowledged, 0 Resolved)
- Verified alerts list displays:
  - Severity badges (critical)
  - Alert titles and descriptions
  - File paths for file events
  - Agent IDs
  - Timestamps
  - Event IDs
  - Acknowledge/Resolve buttons
- Verified alerts are generated from critical/high severity events

---

### 12. Windows Agent USB Monitoring Threading Fix

#### Problem
- Windows agent throwing `wmi.x_wmi_uninitialised_thread` error
- USB monitoring failing with COM initialization error
- Error message: "WMI returned a syntax error: you're probably running inside a thread without first calling pythoncom.CoInitialize[Ex]"

#### Solution
- **`agents/endpoint/windows/agent.py`**: Fixed COM initialization in USB monitoring thread
  - Changed from `pythoncom.CoInitialize()` to `pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)` for better thread safety
  - Added fallback to `CoInitialize()` if `CoInitializeEx` is not available
  - Improved error handling with `exc_info=True` for better debugging
  - Added try/except around `CoUninitialize()` to prevent cleanup errors
  - USB monitoring now properly initializes COM in the separate thread

#### Files Changed
- `agents/endpoint/windows/agent.py`

#### Testing Results
- ✅ USB monitoring starts without errors
- ✅ No more `x_wmi_uninitialised_thread` exceptions
- ✅ USB device detection working correctly
- ✅ Windows agent runs cleanly without threading errors

---

### 11. Agents Page Display Fix

#### Problem
- Agents page showing white screen
- `RangeError: Invalid time value` in console
- Outdated Agent type definition

#### Solution
- **`dashboard/src/pages/Agents.tsx`**: Updated field names
  - Changed `agent.registered_at` to `agent.created_at`
  - Updated to use `agent.last_seen` instead of `agent.last_heartbeat`

- **`dashboard/src/lib/utils.ts`**: Improved date handling
  - Added null/undefined checks in `formatRelativeTime`
  - Added try-catch for invalid dates
  - Returns "Never" for null/undefined dates

- **`dashboard/src/lib/api.ts`**: Updated Agent type
  - Changed `last_heartbeat` to `last_seen`
  - Added `created_at` field
  - Updated field types to match API response

#### Files Changed
- `dashboard/src/pages/Agents.tsx`
- `dashboard/src/lib/utils.ts`
- `dashboard/src/lib/api.ts`

---

## 📝 Configuration Changes

### Environment Variables

#### Docker Compose
- Added `CORS_ORIGINS` with WSL IP support
- Added `ALLOWED_HOSTS` for server access
- Updated dashboard build args for Vite environment variables

#### Server Configuration
- Port changed from 8000 to 55000
- OpenSearch SSL disabled by default
- CORS origins include WSL IP addresses

#### Agent Configuration
- Server URL updated to use port 55000
- Path updated to `/api/v1`
- WSL-specific IP addresses configured

---

## 🧪 Testing Results

### Dashboard
- ✅ Login page working
- ✅ Authentication flow functional
- ✅ Events page displaying events correctly
- ✅ Agents page showing agent information
- ✅ Alerts page displaying alerts correctly (generated from critical/high events)
- ✅ API calls working with proper authentication
- ✅ Dashboard overview page fixed - now displays real-time stats
- ✅ Dashboard stats cards showing correct agent and event counts
- ✅ Charts displaying data (Events Over Time, Events by Type, Events by Severity)
- ✅ Dashboard data synchronized with Agents, Events, and Alerts pages

### Linux Agent
- ✅ Agent registration successful
- ✅ Heartbeat sending correctly
- ✅ File monitoring functional
- ✅ Events being sent to server
- ✅ Sensitive data classification working

### Windows Agent
- ✅ Agent registration successful
- ✅ Heartbeat endpoint fixed (POST → PUT)
- ✅ File monitoring functional with environment variable expansion
- ✅ Clipboard monitoring working (Windows-specific feature)
- ✅ USB device monitoring working (Windows-specific feature) - Fixed threading error
- ✅ Events being sent to server
- ✅ Sensitive data classification working
- ✅ Environment variable expansion in monitored paths (%USERNAME%)
- ✅ USB monitoring COM initialization fixed (CoInitializeEx with COINIT_MULTITHREADED)

### Server API
- ✅ Events API returning correct format
- ✅ Authentication endpoints working
- ✅ Agent endpoints functional
- ✅ Database operations successful

---

## 🔧 Technical Details

### Port Changes
- **Server API**: 8000 → 55000
- **Dashboard**: 3000 (unchanged)
- **PostgreSQL**: 5432 (unchanged)
- **MongoDB**: 27017 (unchanged)
- **Redis**: 6379 (unchanged)
- **OpenSearch**: 9200 (unchanged)

### Build System Changes
- **Dashboard**: Next.js → Vite
- **Node Version**: 18 → 20
- **Package Manager**: npm (unchanged)

### Database Schema Changes
- **User ID**: Integer → UUID
- **User Roles**: Lowercase → Uppercase
- **Policies Table**: Added

---

## 🚀 Deployment Notes

### WSL2 Specific Configuration
- Server IP: `172.23.19.78` (WSL2 dynamic IP)
- CORS origins include WSL IP
- Agent configs use WSL-compatible URLs

### Default Credentials
- **Email**: `admin`
- **Password**: `admin`
- **Role**: `ADMIN`

---

## 📋 Files Modified Summary

### Backend (Server)
1. `server/Dockerfile` - Port configuration
2. `server/app/api/v1/dashboard.py` - Overview endpoint, timeline endpoint, stats
3. `server/app/api/v1/events.py` - Response format, user access, stats endpoints
4. `server/app/api/v1/alerts.py` - Alerts generation from events, current_user fix
5. `server/app/core/config.py` - OpenSearch SSL, database paths
6. `server/app/core/opensearch.py` - Client initialization
7. `server/app/core/security.py` - Role comparison
8. `server/app/models/user.py` - Role enum values
9. `server/app/services/blacklist_service.py` - Error handling
10. `server/init_db.py` - Database schema and policies table

### Frontend (Dashboard)
1. `dashboard/Dockerfile` - Vite migration
2. `dashboard/package.json` - Dependencies and scripts
3. `dashboard/src/App.tsx` - Login route
4. `dashboard/src/components/Layout.tsx` - Route protection
5. `dashboard/src/components/auth/LoginForm.tsx` - Router update
6. `dashboard/src/index.css` - Tailwind fix
7. `dashboard/src/lib/api.ts` - API client updates
8. `dashboard/src/lib/store/auth.ts` - Real authentication
9. `dashboard/src/lib/utils.ts` - Date handling
10. `dashboard/src/pages/Agents.tsx` - Field names
11. `dashboard/src/pages/Events.tsx` - Event structure
12. `dashboard/src/pages/Login.tsx` - New file

### Agents
1. `agents/endpoint/linux/agent.py` - Connectivity and permissions
2. `agents/endpoint/linux/agent_config.json` - Server URL
3. `agents/endpoint/windows/agent.py` - Heartbeat endpoint, path expansion, logging, USB monitoring COM initialization fix
4. `agents/endpoint/windows/agent_config.json` - WSL compatibility

### Infrastructure
1. `docker-compose.yml` - CORS, environment variables, build args

---

## ✅ Verification Checklist

- [x] Dashboard builds successfully
- [x] Dashboard authentication working
- [x] Dashboard overview page displaying real-time stats
- [x] Dashboard charts displaying data correctly
- [x] Events page displaying events
- [x] Agents page showing agents
- [x] Alerts page displaying alerts (generated from critical/high events)
- [x] Linux agent connecting to server
- [x] Windows agent connecting to server
- [x] Agents sending heartbeats correctly
- [x] File monitoring functional (Linux and Windows)
- [x] Clipboard monitoring functional (Windows)
- [x] USB monitoring functional (Windows)
- [x] Events being stored in database
- [x] API endpoints responding correctly
- [x] CORS issues resolved
- [x] Database initialization working
- [x] OpenSearch connectivity fixed
- [x] Browser testing completed for all features

---

## 🔮 Known Issues / Future Improvements

1. **Policy Evaluation**: Policies are created but not evaluated when events are received (documented in removed `POLICY_TEST_RESULTS.md`)
2. **Agent-Side Policy Enforcement**: Not implemented - all events sent with `"action": "logged"`
3. **WSL IP**: Currently hardcoded - should use dynamic detection or environment variable
4. **Default Password**: Should be changed in production

---

## 📚 Related Documentation

- See `INSTALLATION_GUIDE.md` for updated installation instructions
- See `AGENT_DEPLOYMENT.md` for agent deployment details
- See `DEPLOYMENT_GUIDE.md` for production deployment

---

**End of Changelog**


