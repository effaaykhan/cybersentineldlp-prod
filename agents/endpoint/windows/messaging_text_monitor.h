// messaging_text_monitor.h
// Typed-message DLP for desktop messaging apps — CyberSentinel DLP Windows Agent
//
// THE GAP THIS CLOSES
// -------------------
// Messaging App Attachment Control watches the file picker: it sees a file
// chosen through the app's Open dialog and can block it. It never sees the far
// more common case — somebody TYPING sensitive data straight into the chat box.
// An operator who switched that policy to Block reasonably believed sensitive
// data could no longer leave over WhatsApp. It could, and did: a pasted or typed
// Aadhaar number went out with nothing logged, because no file dialog ever
// opened and so no code path ran at all.
//
// This module covers the typed path.
//
// HOW IT WORKS — hold, inspect, then release
// ------------------------------------------
// A low-level keyboard hook (WH_KEYBOARD_LL — no DLL injection, no code inside
// the target app) watches for the send gesture: Enter, or Ctrl+Enter, in a
// window owned by a managed messaging app. When policy says BLOCK, the
// keystroke is swallowed and a worker thread:
//
//   1. reads the composer text through UI Automation,
//   2. classifies it with the agent's local classifier (regex + Luhn,
//      sub-millisecond — no server round trip, works offline),
//   3. re-injects the keystroke if the message is clean, or drops it and
//      raises an event if it is not.
//
// The hold is typically 10-100ms and imperceptible in a chat window.
//
// WHY HOLD-AND-RELEASE, AND NOT THE SCREENSHOT MODULE'S PRECOMPUTED FLAG
// ----------------------------------------------------------------------
// ScreenCaptureMonitor keeps a background thread scoring the screen and has the
// hook read one atomic bool, because OCR is far too slow to run inside a hook
// and a screenshot cannot be meaningfully "replayed" later.
//
// Neither constraint applies here. Classifying a chat message is a regex sweep,
// and an Enter key CAN be replayed — perfectly, a few milliseconds later, with
// SendInput. Holding it means the verdict is computed against the text that is
// actually in the box at the moment of sending, instead of whatever a sampler
// last happened to see. A sampled flag would leave a real hole: type or paste a
// number and hit Enter inside the sampling gap and it ships uninspected. That
// hole is the entire bug this module exists to close, so it is not reintroduced
// as an implementation detail.
//
// SAFETY RULES, and they matter more than coverage here
// -----------------------------------------------------
//   * ALERT mode never touches input. Keystrokes are only ever held when an
//     admin has explicitly chosen Block, so the audit-first rollout the rest of
//     the product follows costs the user nothing.
//   * Every failure path RELEASES the keystroke. If UI Automation cannot read
//     the box, if the worker is slow, if anything throws — the Enter goes
//     through and an event records that the message could not be inspected.
//     This deliberately inverts the "uninspectable is not clean" rule the file
//     paths follow, and the reason is proportion: a file transfer wrongly
//     denied is an inconvenience, while a chat app that cannot send is a broken
//     machine, and a user with a broken machine turns the agent off.
//   * Injected keystrokes are ignored (LLKHF_INJECTED), so our own replay
//     cannot re-enter the hook and loop.
//   * The hook holds no locks and does no I/O — it flips an atomic and signals
//     a worker, so it can never approach the LowLevelHooksTimeout that would
//     make Windows silently evict it.
//
// SCOPE — what this does NOT cover
//   * Sending by CLICKING the send button. Deciding whether a click lands on
//     that button needs a UI Automation hit-test, which cannot run inside a
//     mouse hook, and swallowing clicks globally to find out is not a risk
//     worth taking for the minority gesture.
//   * Apps that send on a key this doesn't know about.
//   * Text pasted and sent inside one sampling-free instant is still caught,
//     because the text is read at send time — but the paste itself is Clipboard
//     control's job and remains so.

#pragma once

#include <string>
#include "network_exfil_monitor.h"

namespace MessagingTextMonitor {

struct Config {
    std::string agentId;
    std::string agentName;
    std::string username;
    std::string hostname;

    // Reused verbatim from NetworkExfilMonitor so both messaging paths classify,
    // report and resolve policy through exactly one implementation each.
    NetworkExfilMonitor::ClassifyFn         classify;        // MUST be set
    NetworkExfilMonitor::SendEventFn        sendEvent;       // MUST be set
    NetworkExfilMonitor::LogFn              log;             // MUST be set
    NetworkExfilMonitor::MessagingPolicyFn  messagingPolicy; // MUST be set

    // Longest composer text inspected. A chat message is small; the cap only
    // bounds the cost of someone pasting a novel into the box.
    size_t maxTextBytes = 64 * 1024;

    // How long the worker may take before the keystroke is released anyway.
    // Sized for "UI Automation is wedged", not for normal operation.
    unsigned decisionTimeoutMs = 1200;
};

// Installs the hook and starts the worker. Returns false if the hook could not
// be installed; the agent keeps running with typed-message coverage off.
bool Start(const Config& cfg);

void Stop();

// True while the hook is installed.
bool IsRunning();

} // namespace MessagingTextMonitor
