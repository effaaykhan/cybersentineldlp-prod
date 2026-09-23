# Plan — `screen_capture_control` policy (Agent v1.4.8)

Screen capture was the only enforced channel with no policy behind it:
`screenMonitor->Start()` ran unconditionally, the level threshold and tool list
were compiled in, and its events were dropped on any endpoint with no other
policy because the channel was missing from `EventsAllowed()`.

## Server
- ✅ `domains.py`: `screen_capture_control` → THREAT
- ✅ `ScreenCapturePolicyResponse` + `GET /agents/{id}/screen-capture-policy`
- ✅ mode+action folded into the suppression flags server-side (audit can never suppress)
- ✅ empty `levels` collapses to `enforced:false` rather than meaning "all levels"
- ✅ suspended agent returns the same inert shape

## Agent (Windows only — Linux untouched)
- ✅ `ScreenCapturePolicy` struct + `ApplyPolicy` / `GetPolicy` / `IsExcepted`
- ✅ keyboard hook gated on the policy; alert mode records without swallowing
- ✅ capture-tool watcher uses the policy's list; terminates only when told to
- ✅ content scanner skips the Tesseract OCR pass entirely with no policy
- ✅ levels + exceptions decide sensitivity, not a hardcoded pair
- ✅ event reports the real level, the action actually taken, and the deciding policy
- ✅ `screenCaptureEnforced` added to `EventsAllowed()`
- ✅ `FetchScreenCapturePolicy()` on every sync; initial policy pushed when the monitor starts
- ✅ VERSION 1.4.7 → 1.4.8

## Dashboard
- ✅ `screen_capture_control` in `PolicyType` + `ScreenCaptureControlConfig`
- ✅ tile in PolicyTypeSelector ("The endpoint itself"), icon + label in policyUtils
- ✅ `ScreenCaptureControlForm` (levels, mode, action, 5 toggles, tool list, exceptions)
- ✅ summary line, default config, modal wiring

## Verification
- ✅ Endpoint: no policy → `enforced:false`; active → full config; audit forces
  suppression flags false; empty levels → `enforced:false`
- ✅ `agent.cpp` + `screen_capture_monitor.cpp` compile clean (mingw, `-fsyntax-only`)
- ✅ `npx tsc --noEmit`: zero errors in any file touched (47 pre-existing elsewhere)
- ✅ Temp validation policy deleted from Postgres
- ✅ Dashboard image rebuilt; manager restarted (volume-mounted)

## Follow-on — Agent v1.4.9: attachments raced their own inspection
- ✅ Root cause: no "inspection in flight" state; both send gates could only ask
  "is there a verdict?", so a picture went out while its OCR was still running
  and the block notice appeared afterwards
- ✅ `StagedInspectionScope` marks `InspectStagedFiles` in flight
- ✅ Click gate holds the click, replays it via `ReleaseClick()` when cleared
- ✅ Enter gate waits in `DecideAndAct`; watchdog extends past its 1200ms budget
- ✅ 8s ceiling, fail closed (uninspectable ≠ clean); CV wake so a clean file
  releases the instant OCR finishes
- ✅ Every agent source compiles (case-bridged UIA headers for the local mingw)
- ✅ VERSION 1.4.8 → 1.4.9

## Follow-on — Agent v1.4.10: the Send button click gate
- ✅ Diagnosed from the endpoint log, not guessed: click (1856,961) was INSIDE
  rect [1833,921 1894,982] and refused only for being 3426ms old vs a 3000ms limit
- ✅ Rect refresh hoisted to the top of SamplerThread (was below a UIA read this
  file documents taking 7s); loop ticks every 250ms
- ✅ PublishSendBtn(nullptr) now clears the rect — a lost button was leaving a
  1046967ms-old rectangle standing, reported as "stale" instead of "no button"
- ✅ Age limit replaced by the invariant it stood for: trust the rect while
  GetWindowRect says the window has not moved (3s outright, 30s ceiling)
- ✅ Confined to the send-rect plumbing; Enter path and 1.4.9 attachment hold untouched
- ✅ VERSION 1.4.9 → 1.4.10

## Follow-on — Agent v1.4.11: blocking required hovering first
- ✅ 1.4.10 produced the first `via=send-button-click` block, but only after a hover
- ✅ Root cause: FindSendButton fails on WhatsApp; only the cursor probe worked,
  so the FIRST send of every session went out uninspected
- ✅ Extracted TryPublishSendAtPoint from the hover probe
- ✅ Added ProbeSendBesideComposer — asks ElementFromPoint about the points
  RectBesideComposer already says the button must occupy (no hover needed)
- ✅ Locator tries cursor first, computed points as fallback
- ✅ Fixed a 1.4.10 gap: the probe path never set g_sendWnd/g_sendWndRect, so the
  window-unchanged test had nothing to compare on the path that actually worked
- ✅ VERSION 1.4.10 → 1.4.11

## Follow-on — Agent v1.4.12: captionless pictures bypassed the attachment hold
- ✅ Found by tracing the question "does OCR work on the click path too?" rather
  than assuming 1.4.9 + 1.4.11 covered it — it did not
- ✅ g_composerHasText was keyed on HasPendingDrop, true only AFTER classification
  finished and came back sensitive; during the OCR of a captionless picture it
  was false, so the locator never looked for the Send button
- ✅ MouseProc therefore returned at the fresh||inside test, before the 1.4.9 hold
- ✅ KeyProc never consults that flag — hence Enter blocked pictures, clicks did not
- ✅ StagedRecently() opens the gate from the START of inspection (5 min, matching
  PendingDropFor's caption window)
- ✅ VERSION 1.4.11 → 1.4.12

## Follow-on — Agent v1.4.13: the button was found 1.5s after the send
- ✅ Drop path fully vindicated by the log: .avif detected, OCR'd, Restricted,
  pending-drop armed 2s before the send. Only the button location was missing
- ✅ FIXED MY OWN REGRESSION: 1.4.10's PublishSendBtn(nullptr) clear deleted the
  data 1.4.10's window-unchanged rule reads; a click inside a valid rect on an
  unmoved window was refused as "no Send button". Clear removed; focus-leave and
  the GetWindowRect comparison cover the real cases
- ✅ Composer lock took 4055ms vs a 2.5s drop-and-click, so every composer-based
  probe was blind. Added ProbeSendInWindowCorner (no composer needed,
  name-verified only, bottom-right band)
- ✅ Probe order: pointer -> beside composer -> window corner
- ✅ VERSION 1.4.12 → 1.4.13

## Follow-on — Agent v1.4.14: enforce at staging, not at the send
- ✅ User chose staging-time enforcement after the send gate failed five ways
- ✅ InspectStagedFiles now acts on a Confidential/Restricted verdict:
  block -> terminate the app + BLOCK event + notice (same as the file-dialog path)
  alert -> ALERT event only, app untouched
- ✅ Send gates left in place as the secondary catch for typed messages
- ✅ Forward-declared DescribeLabels/EmitEvent/ShowBlockedNotice/ClearPendingDrop
  (all defined below InspectStagedFiles); EmitEvent defaults moved to the decl
- ✅ Accepted trade-off: acts even on a file that was only being previewed
- ✅ VERSION 1.4.13 → 1.4.14

## Follow-on — Agent v1.4.15: a resize published the WRONG control as Send
- ✅ Reproduced by the user: resize WhatsApp -> text blocking stops
- ✅ Log proved the agent published rect [1267,189 1307,229] (40x40, TOP of window)
  as the Send button; the real one is [1833,921 1894,982]. It also drifted, so it
  was tracking a scrolling element
- ✅ Root cause: a DEAD element still answers ElementRect with its last-known
  rectangle. After a resize the cached composer returned the old layout's rect,
  and RectBesideComposer matched a control "beside" a message box that had moved
- ✅ Locator now tracks the window geometry it located against; any move/resize
  drops composer + contentRoot + sendBtn, clears the published rect, re-finds
- ✅ ElementAlive checked before trusting a composer rect; rect must be sane and
  inside the window
- ✅ RectInsideWindow guards BOTH publish sites (point probes + sampler re-measure)
- ✅ The 1.4.13 corner probe was suspected first and was innocent — it never fired
- ✅ VERSION 1.4.14 → 1.4.15

## Remaining
- ⬜ Push → CI builds/signs 1.4.8 → publish → update endpoint
- ⬜ Create a real `screen_capture_control` policy in the console
- ⬜ Still pending from 1.4.6: Send-button + file-inspection tests

## ⚠ Behaviour change
Screen capture is no longer enforced until a policy exists. Deliberate, and
consistent with every other channel — but it must be called out on upgrade.
