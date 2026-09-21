# Plan — Agent v1.4.7: honest policy-state reporting

Triggered by a test endpoint logging `NO ACTIVE POLICIES FOUND!` while its
messaging policy was enforcing correctly.

## Diagnosis
- ✅ Confirmed server-side bundle is healthy: `/policies/sync` returns 2 policies
  (`web_activity_control`, `messaging_app_control`), version `583d00d1…`
- ✅ Confirmed `/messaging-app-policy` returns `enforced:true, action:block`,
  `whatsapp.root.exe` listed, `inspect_messages:true`, 10 data types
- ✅ Confirmed per-channel fetches run outside the `status==200` branch, so they
  refresh even when the bundle reports `up_to_date`
- ✅ Confirmed `SendEvent` gates on `EventsAllowed()` (all channels), not
  `allowEvents` (bundle-only) — so events were never actually being dropped
- ✅ Root cause: the warning is computed from the bundle's four categories only

## Fix 1 — warning tells the truth
- ✅ Startup verdict now uses `EventsAllowed()` instead of `allowEvents`
- ✅ Bundle-tail message scoped to "no file/clipboard/USB policies in this bundle"
- ✅ Cached-bundle message scoped likewise, demoted Warning → Info

## Fix 2 — agent reports its sync state
- ✅ Added `policySyncStatus / policySyncAt / policySyncError` (+ mutex)
- ✅ `NotePolicySync()` helper; every exit path of `SyncPolicies` records an outcome
- ✅ Guarded so a later per-channel throw cannot relabel a successful sync
- ✅ Heartbeat sends all three fields; error sent even when empty so success clears it
- ✅ Vocabulary matches the Linux agent (`never|up_to_date|success|error_<n>|exception`)
- ✅ No server change needed — `HeartbeatRequest` already accepts the fields

## Verification
- ✅ `x86_64-w64-mingw32-g++-posix -std=c++17 -fsyntax-only agent.cpp` → exit 0
- ✅ Live server accepts a 1.4.7-shaped heartbeat (HTTP 200) and stores all three
  fields; test record restored to its pre-test state afterwards
- ✅ `VERSION` bumped 1.4.6 → 1.4.7 (same commit, per CI guard)

## Remaining
- ⬜ Commit + push so CI builds and signs the 1.4.7 binary
- ⬜ Update endpoint, confirm the warning is gone and console shows a real sync status
- ⬜ Still pending from 1.4.6: the three Send-button / file-inspection tests
