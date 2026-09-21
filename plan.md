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

## Remaining
- ⬜ Push → CI builds/signs 1.4.8 → publish → update endpoint
- ⬜ Create a real `screen_capture_control` policy in the console
- ⬜ Still pending from 1.4.6: Send-button + file-inspection tests

## ⚠ Behaviour change
Screen capture is no longer enforced until a policy exists. Deliberate, and
consistent with every other channel — but it must be called out on upgrade.
