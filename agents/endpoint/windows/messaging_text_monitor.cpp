// messaging_text_monitor.cpp — see messaging_text_monitor.h for the design and
// for why every failure path releases the keystroke.

// Feature macros first — they gate QueryFullProcessImageName and the UI
// Automation interface declarations, and only take effect before <windows.h>.
// Kept identical to network_exfil_monitor.cpp so both modules see one ABI.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601      // Windows 7+, matches agent.cpp
#endif
#define _WIN32_DCOM
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <UIAutomation.h>
#include <shlobj.h>
#include <shellapi.h>
#include <exdisp.h>
#include <shldisp.h>

#include "messaging_text_monitor.h"

#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cwchar>

namespace MessagingTextMonitor {
namespace {

Config            g_cfg;
std::atomic<bool> g_running{false};
std::atomic<bool> g_stop{false};

HHOOK       g_hook       = nullptr;
HHOOK       g_mouseHook  = nullptr;
DWORD       g_hookThread = 0;
std::thread g_hookThreadObj;

// ── Are we still hooked? ──────────────────────────────────────────────────
//
// Windows removes a low-level hook whose callback overruns
// LowLevelHooksTimeout — 300ms, by default — and it tells nobody. No error, no
// callback, no notification: the HHOOK we are holding stays non-null and every
// keystroke from that moment on is simply never offered to us again. From
// inside this process the result is indistinguishable from a user who stopped
// typing, which is exactly why this failure reads as "it blocked yesterday,
// today it does not, and there is nothing in the log".
//
// So the hook thread cannot be trusted to notice its own death, and nothing
// short of restarting the agent used to bring it back. These two timestamps
// let the watchdog notice instead, by asking a question the OS will answer:
// has Windows seen input that we did not?
std::atomic<long long> g_lastKeyHookMs{0};
std::atomic<long long> g_lastMouseHookMs{0};

// Posted to the hook thread; the hooks may only be reinstalled by the thread
// that owns their message pump.
constexpr UINT WM_REHOOK = WM_APP + 7;
std::thread g_workerObj;
std::thread g_samplerObj;
std::thread g_watchdogObj;
std::thread g_locatorObj;

// ── Hook -> worker handoff ────────────────────────────────────────────────
// The hook must never block, so it publishes the bare facts and wakes the
// worker. One pending item at a time: a second Enter while a decision is in
// flight is passed straight through rather than queued, because queueing
// keystrokes is how you end up delivering them in the wrong order.
std::mutex              g_mx;
std::condition_variable g_cv;
bool                    g_pendingWork  = false;
bool                    g_pendingAudit = false;   // alert mode: nothing was held
HWND                    g_pendingWnd   = nullptr;
DWORD                   g_pendingPid   = 0;
// The name the POLICY matched, which is not always the owner of the window:
// a Chromium renderer owns the window, its parent owns the product. Events
// must name the app the operator listed, not msedgewebview2.exe.
std::string             g_pendingExe;
bool                    g_pendingCtrl  = false;
std::vector<std::string> g_pendingTypes;          // operator-selected detector types

// True from the moment we swallow the Enter keydown until the decision is made.
// Read by the hook to also swallow the matching keyup (an app that sees a keyup
// with no keydown is not harmed, but it is untidy and some Electron composers
// do watch for it).
std::atomic<bool> g_decisionPending{false};

// The held keystroke is resolved exactly once, by whichever of the worker and
// the watchdog claims it first. Two releases would send the message twice; a
// release after a deliberate drop would send the message the policy just
// blocked. `true` is the resting state — nothing is held.
std::atomic<bool>      g_decisionResolved{true};
std::atomic<long long> g_holdStartMs{0};
std::atomic<bool>      g_holdCtrl{false};
// True when the current hold was extended for an attachment inspection, so
// the watchdog knows a timeout here means "could not read the file" rather
// than "could not read the text box" - and must not end it by sending.
std::atomic<bool>      g_holdForAttachment{false};

// Why an unmanaged app is worth a log line at all: the hook's silent exit for
// "not one of ours" is correct behaviour and was also completely undebuggable.
// When typed-message inspection appears to do nothing, the single most useful
// fact is what the agent actually RESOLVED the foreground app to — a packaged
// app seen through its frame host, a launcher, a webview host, or simply a name
// the policy does not list. Without it the operator is left comparing an empty
// log against a policy that looks correct, which is exactly where this landed.
// Rate-limited hard, and published from the hook for the worker to write, so the
// hook itself still does no I/O.
// Every send key produces one of these, whatever the policy says about the app.
// Rate limiting lives in the worker (per app), not here: a global limiter meant
// pressing Enter in Notepad could hide the WhatsApp keypress tested two seconds
// later, which is precisely the case somebody is trying to diagnose.
std::mutex        g_probeMx;
std::string       g_probeExe;
bool              g_probeManaged = false;
bool              g_probeInspect = false;
bool              g_probeBlock   = false;
bool              g_probeReady   = false;

// Alert-mode composer snapshot (see the header: alert mode never holds input,
// so the box is already empty by the time we get to look at it).
std::mutex             g_snapMx;
std::string            g_snapText;
DWORD                  g_snapPid   = 0;
long long              g_snapAtMs  = 0;
// The verdict on that snapshot, decided here rather than in the mouse hook.
// A low-level hook has a few hundred milliseconds of total budget before
// Windows silently evicts it, so it must read a bool, never run a classifier.
bool                   g_snapSensitive = false;
std::string            g_snapWhat;
// The WHOLE result, not just its category: the event schema carries the score,
// the matched rule and the labels, and a block that reached the dashboard
// missing all three would be visibly poorer than the same block from Enter.
NetworkExfilMonitor::ClassifyResult g_snapCls;

// ── Where the Send button is ──────────────────────────────────────────────
// Holding Enter is only half a send. Every one of these apps also has a button,
// and a user who watches one message get blocked reaches for the mouse — which
// is exactly what happened in testing. The sampler keeps this rectangle fresh
// so the mouse hook can answer "was that click on Send?" with an integer
// comparison and nothing else.
std::mutex g_sendMx;
RECT       g_sendRect  = {0, 0, 0, 0};
DWORD      g_sendPid   = 0;
long long  g_sendAtMs  = 0;
// The window the rectangle was measured in, and where that window was at the
// time. A Send button moves when its window moves; it does not move when the
// window sits still. That is the fact the age limit below was standing in
// for, and checking it directly is both cheaper and correct - GetWindowRect
// is a non-blocking user32 call, safe on the hook thread.
HWND       g_sendWnd     = nullptr;
RECT       g_sendWndRect = {0, 0, 0, 0};
// A swallowed button-down must have its button-up swallowed too, or the app
// sees a release it never saw pressed and can latch a drag.
std::atomic<bool> g_swallowNextUp{false};

// Is there anything in the composer right now?
//
// This exists because of what WhatsApp actually does: the control to the right
// of the message box is a MICROPHONE while the box is empty and only becomes
// Send once you type. Searching for a Send button in an empty chat window is
// therefore guaranteed to fail, and the old code did exactly that — it searched
// on a timer from the moment the app came to the foreground, missed (there was
// no such button yet), and backed off to one attempt every 160 seconds. By the
// time a user typed something the search had given up, so clicking Send was
// never covered on the one app it was written for.
//
// Searching is now driven by this instead of by the clock: look when there is
// something to send, never when there is not.
std::atomic<bool> g_composerHasText{false};
std::atomic<long long> g_hoverMissLoggedMs{0};

// ── A file dragged into a chat ───────────────────────────────────────────────
// A drop opens no file dialog, so the attachment detector - which hangs off the
// file picker - never sees it. It is also the way people actually attach things.
//
// The drag has an ORIGIN, though, and that is the part worth keeping: a drop is
// a button-down over Explorer and a button-up over the chat. Ask the SOURCE
// window what was selected when the drag began and the file is identified
// exactly, with its full path - no matching on a bare file name, which cannot
// tell one Photo.avif from another in a different folder.
//
// Only the two points are recorded on the hook thread. Everything that costs
// anything - hit tests, COM, classification - happens on a worker, because a
// low-level hook that overruns its timeout is removed by Windows without notice.
std::mutex  g_dragMx;
POINT       g_dragDownPt   = {0, 0};
long long   g_dragDownMs   = 0;
bool        g_dragDownSeen = false;
// The window the drag STARTED on, captured while the button is going down.
// Resolving it afterwards from the same screen point does not work: by then the
// chat has been raised over that spot, so the hit test answers with the chat
// window and the real source is never asked what it had selected.
HWND        g_dragDownWnd  = nullptr;

// A file dropped into a chat that we judged sensitive. Held against the window
// it was dropped into, and consumed when a send is attempted there.
// Held against the APPLICATION, not the window it landed on. WhatsApp opens a
// separate preview window for an attachment, and the send happens there - a
// different HWND entirely - so a drop keyed to the chat window was never found
// again when Send was finally pressed. The exe is kept alongside the pid
// because that preview may well belong to a different process of the same app.
std::mutex               g_dropMx;
DWORD                    g_dropPid = 0;
std::string              g_dropExe;
long long                g_dropAtMs = 0;
std::string              g_dropPath;
NetworkExfilMonitor::ClassifyResult g_dropCls;

long long NowSteadyMs();   // defined below; needed by the helpers here

// ── Staged-attachment inspection, in flight ──────────────────────────────
//
// A staged file is classified on a worker thread: read it, OCR it, ask the
// server. For a screenshot that is SECONDS, not milliseconds. Until this
// existed the only question either send gate could ask was "is there a
// verdict?" - never "is one coming?" - so a picture clicked away before its
// OCR landed went out uninspected, and the block notice appeared afterwards,
// about a message the user had already sent. That is the worst shape this
// failure can take: it looks like enforcement while being the absence of it.
//
// The send is now held while an inspection is in flight. The wait ends the
// instant the verdict lands (condition variable, not a poll), so a clean
// attachment costs the user whatever the OCR actually took and no more.
std::mutex              g_inspMx;
std::condition_variable g_inspCv;
DWORD                   g_inspPid   = 0;
int                     g_inspBusy  = 0;
long long               g_inspStart = 0;

// Ceiling on holding a send for an attachment verdict. Only ever reached by
// an inspection that is genuinely stuck; reaching it BLOCKS, because an
// attachment nobody managed to read has not been shown to be safe.
constexpr int kAttachmentHoldMs = 8000;

// Marks an inspection in flight for as long as it is in scope.
struct StagedInspectionScope {
    explicit StagedInspectionScope(DWORD pid) {
        std::lock_guard<std::mutex> lk(g_inspMx);
        g_inspPid = pid; g_inspStart = NowSteadyMs(); ++g_inspBusy;
    }
    ~StagedInspectionScope() {
        {
            std::lock_guard<std::mutex> lk(g_inspMx);
            if (g_inspBusy > 0) --g_inspBusy;
        }
        // Wakes every held send immediately - this is what keeps a cleared
        // attachment from costing the user the whole ceiling.
        g_inspCv.notify_all();
    }
};

// Is an attachment staged in this app still being inspected? The age check
// keeps a crashed or wedged inspection from holding every later send.
bool StagedInspectionInFlight(DWORD pid) {
    std::lock_guard<std::mutex> lk(g_inspMx);
    if (g_inspBusy <= 0) return false;
    if (pid && g_inspPid && g_inspPid != pid) return false;
    return NowSteadyMs() - g_inspStart <= kAttachmentHoldMs;
}

// Wait for it to finish. True = it completed and the verdict is readable;
// false = the ceiling was reached first, which the caller must treat as
// "not cleared" rather than "clean".
// Was a file staged in this app recently, whatever the verdict turned out to
// be? StagedInspectionInFlight answers only "right now", and the locator
// needs longer: it has to FIND the Send button before the user clicks it, and
// that search is gated on there being something worth sending. Keyed on the
// start of the inspection, so it is true from the moment a file is staged -
// not from the moment a verdict exists, which is far too late.
bool StagedRecently(DWORD pid, int windowMs) {
    std::lock_guard<std::mutex> lk(g_inspMx);
    if (!g_inspStart) return false;
    if (pid && g_inspPid && g_inspPid != pid) return false;
    return NowSteadyMs() - g_inspStart <= windowMs;
}

bool AwaitStagedInspection(int budgetMs) {
    std::unique_lock<std::mutex> lk(g_inspMx);
    return g_inspCv.wait_for(lk, std::chrono::milliseconds(budgetMs),
                             [] { return g_inspBusy <= 0; });
}
std::atomic<bool>        g_dropBusy{false};
std::atomic<bool>        g_dropNoSourceLogged{false};

// Which conversation a message is going to. Cached by the sampler and read by
// EmitEvent, which runs on a detached thread with no UI Automation instance of
// its own and must not spend seconds building one while a send is held.
std::mutex  g_convMx;
std::string g_convName;
HWND        g_convWnd  = nullptr;
long long   g_convAtMs = 0;
std::atomic<long long> g_convProbedMs{0};
std::atomic<bool>      g_convLoggedOnce{false};
// Said once per app, not four times a second, when the pointer probe works out
// where Send is - it is the line that tells an operator the mouse is covered.
std::atomic<bool> g_hoverSaidSo{false};
std::atomic<bool> g_besideSaidSo{false};
std::atomic<bool> g_cornerSaidSo{false};

// ── What the locator has found ─────────────────────────────────────
// Both threads live in the COM multithreaded apartment, so an interface pointer
// is legal to use from either one. The lock protects the pointer itself; anyone
// reading through it takes their own reference first, so the locator is free to
// replace or release its copy at any moment.
std::mutex            g_locMx;
IUIAutomationElement* g_locComposer    = nullptr;
DWORD                 g_locComposerPid = 0;
IUIAutomationElement* g_locSendBtn     = nullptr;
DWORD                 g_locSendBtnPid  = 0;
// Set by the sampler when the element it is reading through goes dead, so the
// locator re-acquires immediately instead of waiting out its rate limit.
std::atomic<bool>     g_refindComposer{false};

// ── Thread liveness ───────────────────────────────────────────────────────
//
// "It worked for a while and then stopped" has exactly one shape that nothing
// in here could see: a thread died. An exception escaping a loop body ends that
// thread silently - no log, no crash, the agent keeps running and keeps
// reporting itself healthy - and whatever that thread was responsible for
// simply stops. The watchdog is the worst one to lose, because it owns
// CheckHookHealth: lose it and a dropped input hook is never reinstalled, so
// blocking stays off until the agent is restarted. Which is the symptom.
//
// Each timer-driven thread stamps its own beat. The others check it. No new
// thread and no supervisor to lose: as long as ONE of them lives, a death gets
// reported by name instead of being inferred from behaviour weeks later.
//
// The worker is deliberately NOT here - it waits on a condition variable, so a
// quiet machine is indistinguishable from a dead one and the only honest
// reading is no reading at all.
// Why the last left-click in a managed chat was NOT inspected.
//
// "Enter blocks, the Send button does not" has four possible causes and they
// are indistinguishable from outside: the button was never located, its
// rectangle went stale, the click landed outside it, or the hook never saw the
// click at all. Each needs a different fix and we have guessed wrong about
// which more than once.
//
// The hook may not log - a low-level hook that overruns LowLevelHooksTimeout is
// removed by Windows without warning - so it stores a code and the sampler
// prints it. Atomic stores only: no allocation, no lock, no formatting.
enum ClickGate : int {
    CLICK_NONE = 0, CLICK_NO_BUTTON, CLICK_STALE, CLICK_OUTSIDE, CLICK_INSPECTED
};
std::atomic<int>       g_clickGate{CLICK_NONE};
std::atomic<long long> g_clickAgeMs{0};
std::atomic<int>       g_clickX{0}, g_clickY{0};
std::atomic<int>       g_clickRL{0}, g_clickRT{0}, g_clickRR{0}, g_clickRB{0};

std::atomic<long long> g_beatLocator{0};
std::atomic<long long> g_beatSampler{0};
std::atomic<long long> g_beatWatchdog{0};

// Alert mode fires on every Enter, including the ones that resend the same
// text; an operator does not need the same message five times.
std::string            g_lastAuditText;
long long              g_lastAuditMs = 0;

// "UI Automation cannot see this app's composer" is a deployment fact worth
// reporting once — it is how you discover a build of WhatsApp this cannot read
// — but not something to raise on every Enter.
std::mutex                       g_uninspectableMx;
std::map<std::string, long long> g_uninspectableAt;

long long NowSteadyMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

void LogMsg(const char* level, const std::string& m) {
    if (g_cfg.log) { try { g_cfg.log(level, "MessagingText: " + m); } catch (...) {} }
}
void LogInfo(const std::string& m) { LogMsg("INFO",  m); }
void LogWarn(const std::string& m) { LogMsg("WARNING", m); }
void LogDbg (const std::string& m) { LogMsg("DEBUG", m); }

std::string ToLowerAscii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return (char)std::tolower(c); });
    return s;
}

bool EqualsIgnoreCase(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::tolower((unsigned char)a[i]) != std::tolower((unsigned char)b[i])) return false;
    }
    return true;
}

std::string WideToUtf8(const wchar_t* w) {
    if (!w) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string out((size_t)n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, &out[0], n, nullptr, nullptr);
    return out;
}

// The other direction. Needed because every string in this file is UTF-8 and
// the only correct way to put one on screen is the wide Win32 entry point.
std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return {};
    std::wstring out((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], n);
    return out;
}

std::string ProcessExeName(DWORD pid) {
    if (!pid) return {};
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return {};
    wchar_t buf[MAX_PATH] = {0};
    DWORD sz = MAX_PATH;
    std::string out;
    if (QueryFullProcessImageNameW(h, 0, buf, &sz)) {
        std::string full = WideToUtf8(buf);
        size_t slash = full.find_last_of("\\/");
        out = (slash == std::string::npos) ? full : full.substr(slash + 1);
    }
    CloseHandle(h);
    return ToLowerAscii(out);
}

// ── Which app is the user actually typing into ────────────────────────────
//
// A packaged (MSIX/UWP) app does not own its top-level window: the foreground
// HWND is an ApplicationFrameWindow owned by ApplicationFrameHost.exe, and the
// app itself owns a child CoreWindow. Resolving the process from the foreground
// window alone therefore reports the frame host, which is in no managed-app
// list, and the whole module quietly does nothing for exactly the apps most
// likely to be managed — the Store build of WhatsApp among them.
//
// The rule is simple and does not depend on knowing which apps are packaged:
// if the foreground window belongs to the frame host, the real app is the child
// window that belongs to somebody else.

struct TargetApp {
    HWND        wnd = nullptr;   // the window UI Automation should read from
    DWORD       pid = 0;
    std::string exe;             // lowercased image name
};

struct ChildProbe {
    DWORD framePid = 0;
    DWORD pid      = 0;
    HWND  wnd      = nullptr;
};

BOOL CALLBACK FrameChildProc(HWND h, LPARAM lp) {
    ChildProbe* p = (ChildProbe*)lp;
    DWORD cpid = 0;
    GetWindowThreadProcessId(h, &cpid);
    if (!cpid || cpid == p->framePid) return TRUE;   // frame chrome, keep looking

    wchar_t cls[128] = {0};
    GetClassNameW(h, cls, 128);
    if (wcscmp(cls, L"Windows.UI.Core.CoreWindow") == 0) {
        p->pid = cpid; p->wnd = h;
        return FALSE;                                 // the app itself — done
    }
    if (!p->pid) { p->pid = cpid; p->wnd = h; }       // fallback candidate
    return TRUE;
}

TargetApp ResolveApp(HWND fg) {
    TargetApp t;
    if (!fg) return t;
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    if (!pid || pid == GetCurrentProcessId()) return t;

    t.wnd = fg;
    t.pid = pid;
    t.exe = ProcessExeName(pid);

    if (t.exe == "applicationframehost.exe") {
        ChildProbe p;
        p.framePid = pid;
        EnumChildWindows(fg, FrameChildProc, (LPARAM)&p);
        if (p.pid) {
            t.pid = p.pid;
            t.wnd = p.wnd ? p.wnd : fg;
            t.exe = ProcessExeName(p.pid);
        }
    }
    return t;
}

TargetApp ResolveForegroundApp() { return ResolveApp(GetForegroundWindow()); }

// ── Which app the POLICY should be asked about ────────────────────────────
//
// Stepping through the frame host above solves packaged apps. It does not solve
// the other shape, which is now the common one: a Chromium-family app (WebView2,
// Electron, CEF) renders its UI in a CHILD process, and when that child owns the
// window we resolve, the name we hold is msedgewebview2.exe. That name can never
// be put in a managed-app list — it hosts content for a dozen unrelated
// applications, and listing it would make every one of them a managed messaging
// app. The name that CAN be listed is the process that owns the renderer: its
// parent.
//
// So when the resolved image is not managed, walk up the process tree and ask
// again. Two hops, because a packaged Chromium app is commonly
// launcher -> browser -> renderer. The window and pid are deliberately NOT
// rewritten — the composer lives in the renderer and UI Automation must keep
// reading it there; only the name the policy is asked about moves.

// Walking the process tree means a Toolhelp snapshot, which is far too
// expensive to run inside a low-level keyboard hook on every Enter the user
// presses anywhere on the machine. It is also almost always the same answer:
// the foreground process changes when the user alt-tabs, not when they type. So
// the ancestry is resolved once per (pid, image) and remembered. Keying on the
// image name as well as the pid is what makes a recycled pid safe — a new
// process reusing the number resolves under its own name.
std::mutex g_ancestorMx;
struct AncestorEntry { std::string childExe; std::vector<std::string> exes; };
std::map<DWORD, AncestorEntry> g_ancestorCache;

// A parent pid recorded by the OS outlives the parent process, and Windows
// recycles pids. Without this the walk can name whatever happens to be sitting
// on that number now, and "managed messaging app" is a verdict that withholds a
// keystroke — not somewhere to accept a coincidence. A real ancestor always
// started first.
bool StartedNoLaterThan(DWORD ancestorPid, DWORD childPid) {
    FILETIME a{}, c{}, ignore1{}, ignore2{}, ignore3{};
    bool gotA = false, gotC = false;
    if (HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, ancestorPid)) {
        gotA = GetProcessTimes(h, &a, &ignore1, &ignore2, &ignore3) != 0;
        CloseHandle(h);
    }
    if (HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, childPid)) {
        gotC = GetProcessTimes(h, &c, &ignore1, &ignore2, &ignore3) != 0;
        CloseHandle(h);
    }
    if (!gotA || !gotC) return true;   // cannot tell — leave the walk as it was
    return CompareFileTime(&a, &c) <= 0;
}

// mayWalk=false answers ONLY from the cache and never touches the process
// table. The keyboard hook passes false, and that is not an optimisation — see
// the note above KeyProc. The sampler, which looks at the foreground app four
// times a second, is what keeps this cache warm; a window you have not had in
// front of you cannot be the window you just pressed Enter in.
std::vector<std::string> AncestorExes(DWORD pid, const std::string& childExe,
                                      bool mayWalk) {
    {
        std::lock_guard<std::mutex> lk(g_ancestorMx);
        auto it = g_ancestorCache.find(pid);
        if (it != g_ancestorCache.end() && it->second.childExe == childExe) {
            return it->second.exes;
        }
    }
    if (!mayWalk) return {};

    std::vector<std::string> out;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        std::map<DWORD, DWORD> parentOf;
        PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
            do { parentOf[pe.th32ProcessID] = pe.th32ParentProcessID; }
            while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);

        DWORD cur = pid;
        for (int hop = 0; hop < 2; ++hop) {
            auto it = parentOf.find(cur);
            if (it == parentOf.end()) break;
            const DWORD par = it->second;
            if (!par || par == cur || par == GetCurrentProcessId()) break;
            if (!StartedNoLaterThan(par, cur)) break;   // recycled pid, not our parent
            const std::string pexe = ProcessExeName(par);
            if (pexe.empty()) break;
            out.push_back(pexe);
            cur = par;
        }
    }

    std::lock_guard<std::mutex> lk(g_ancestorMx);
    if (g_ancestorCache.size() > 64) g_ancestorCache.clear();
    g_ancestorCache[pid] = AncestorEntry{ childExe, out };
    return out;
}

NetworkExfilMonitor::MessagingVerdict AskPolicy(const std::string& exeLower) {
    NetworkExfilMonitor::MessagingVerdict v;
    if (g_cfg.messagingPolicy && !exeLower.empty()) {
        try { v = g_cfg.messagingPolicy(exeLower, g_cfg.username); } catch (...) {}
    }
    return v;
}

// Returns the verdict, and rewrites t.exe to the name that actually matched.
NetworkExfilMonitor::MessagingVerdict VerdictForTarget(TargetApp& t,
                                                      bool mayWalk = true) {
    NetworkExfilMonitor::MessagingVerdict mv = AskPolicy(t.exe);
    if (mv.managed || t.exe.empty() || !t.pid) return mv;

    for (const auto& pexe : AncestorExes(t.pid, t.exe, mayWalk)) {
        if (pexe == t.exe) continue;
        NetworkExfilMonitor::MessagingVerdict pv = AskPolicy(pexe);
        if (pv.managed) {
            LogDbg("foreground window belongs to " + t.exe + ", whose ancestor " + pexe +
                   " IS a managed app - attributing the send to " + pexe);
            t.exe = pexe;
            return pv;
        }
    }
    return mv;
}

// ── Reading the composer ──────────────────────────────────────────────────

// mingw's import libraries carry only PART of the UI Automation IID set:
// IID_IUIAutomationValuePattern resolves (network_exfil_monitor.cpp has linked
// against it for as long as it has existed) but IID_IUIAutomationTextPattern
// does not, and the first CI build of this file died on exactly that undefined
// reference. The header DECLARES the symbol via DEFINE_GUID; nothing DEFINES it.
//
// Defined here instead of reaching for __uuidof: mingw does supply
// __CRT_UUID_DECL for this interface, so __uuidof would work today, but it
// would make linking depend on a header macro surviving in whichever MSYS2
// snapshot CI happens to pull. A literal GUID depends on nothing. The bytes are
// the interface's own identity and cannot drift — taken from mingw-w64's
// uiautomationclient.h, which matches the Windows SDK:
//     DEFINE_GUID(IID_IUIAutomationTextPattern, 0x32eba289, 0x3583, 0x42c9,
//                 0x9c,0x59, 0x3b,0x6d,0x9a,0x1e,0x9b,0x6a);
static const GUID kIID_IUIAutomationTextPattern =
    { 0x32eba289, 0x3583, 0x42c9, { 0x9c, 0x59, 0x3b, 0x6d, 0x9a, 0x1e, 0x9b, 0x6a } };

bool BoolProperty(IUIAutomationElement* el, PROPERTYID prop, bool& value) {
    if (!el) return false;
    VARIANT v; VariantInit(&v);
    bool got = false;
    if (SUCCEEDED(el->GetCurrentPropertyValue(prop, &v)) && v.vt == VT_BOOL) {
        value = (v.boolVal == VARIANT_TRUE);
        got = true;
    }
    VariantClear(&v);
    return got;
}

// Is this element still attached to a live UI node?
//
// A cached element outlives the thing it points at. A dead one answers every
// read with an empty string — which is indistinguishable from an empty message
// box, and that ambiguity is exactly how blocking could work once and then
// never again. UIA reports a detached node as UIA_E_ELEMENTNOTAVAILABLE on any
// property read, so one cheap read is the whole test.
bool ElementAlive(IUIAutomationElement* el) {
    if (!el) return false;
    VARIANT v; VariantInit(&v);
    const HRESULT hr = el->GetCurrentPropertyValue(UIA_ControlTypePropertyId, &v);
    VariantClear(&v);
    return SUCCEEDED(hr);
}

DWORD ElementProcessId(IUIAutomationElement* el) {
    if (!el) return 0;
    int pid = 0;
    if (SUCCEEDED(el->get_CurrentProcessId(&pid)) && pid > 0) return (DWORD)pid;
    return 0;
}

// "Can the user type here?" — the one question that separates a composer from
// the conversation above it. In a WebView2/Chromium app the chat history is a
// Document node exactly like the composer is, and it is READ-ONLY; that is the
// only reliable difference between them.
// `definite` separates "this node reports it is writable" from "this node did
// not say, so we guessed from focusability". The distinction is what tells a
// composer from a conversation pane: a Chromium history region is commonly
// keyboard-focusable — for scrolling and aria — and so passes the fallback,
// which is how a read-only conversation ends up looking exactly like a message
// box to everything downstream.
struct Editability {
    bool editable = false;
    bool definite = false;   // ValueIsReadOnly answered, and answered "writable"
};

Editability ElementEditability(IUIAutomationElement* el) {
    Editability e;
    bool readOnly = false;
    if (BoolProperty(el, UIA_ValueIsReadOnlyPropertyId, readOnly)) {
        e.editable = !readOnly;
        e.definite = e.editable;
        return e;
    }
    // No Value pattern at all — common for a contenteditable div. Fall back to
    // "the caret can go here", which is weaker and is recorded as such.
    bool focusable = false;
    if (BoolProperty(el, UIA_IsKeyboardFocusablePropertyId, focusable)) e.editable = focusable;
    return e;
}

bool ElementIsEditable(IUIAutomationElement* el) { return ElementEditability(el).editable; }

bool ElementHasFocus(IUIAutomationElement* el) {
    bool focused = false;
    return BoolProperty(el, UIA_HasKeyboardFocusPropertyId, focused) && focused;
}

// Pull text out of one element: ValuePattern for a plain edit, TextPattern for
// the rich/contenteditable composers that Electron and WinUI apps actually use.
std::string TextFromElement(IUIAutomationElement* el) {
    if (!el) return {};
    std::string out;

    IUnknown* pat = nullptr;
    if (SUCCEEDED(el->GetCurrentPattern(UIA_ValuePatternId, &pat)) && pat) {
        IUIAutomationValuePattern* vp = nullptr;
        pat->QueryInterface(IID_IUIAutomationValuePattern, (void**)&vp);
        pat->Release();
        if (vp) {
            BSTR v = nullptr;
            if (SUCCEEDED(vp->get_CurrentValue(&v)) && v) {
                out = WideToUtf8(v);
                SysFreeString(v);
            }
            vp->Release();
        }
    }
    if (!out.empty()) return out;

    pat = nullptr;
    if (SUCCEEDED(el->GetCurrentPattern(UIA_TextPatternId, &pat)) && pat) {
        IUIAutomationTextPattern* tp = nullptr;
        pat->QueryInterface(kIID_IUIAutomationTextPattern, (void**)&tp);
        pat->Release();
        if (tp) {
            IUIAutomationTextRange* range = nullptr;
            if (SUCCEEDED(tp->get_DocumentRange(&range)) && range) {
                BSTR t = nullptr;
                if (SUCCEEDED(range->GetText(-1, &t)) && t) {
                    out = WideToUtf8(t);
                    SysFreeString(t);
                }
                range->Release();
            }
            tp->Release();
        }
    }
    return out;
}

// What UI Automation thinks the focused thing IS. Two property reads, used
// only on a failed read: "no editable node" is a conclusion, not a diagnosis,
// and without this there is no way to tell a composer we failed to recognise
// from a focus that was never on the composer at all.
// Absent from some UIAutomation headers, same reason kIID_IUIAutomationTextPattern
// is spelled out above. 30005 is fixed by the UI Automation specification.
const PROPERTYID kNamePropertyId = 30005;
// Same reason again: these are fixed by the UI Automation specification, and
// naming them here means the file builds against a trimmed header as well as a
// complete one. 50000 is Button; 30001 is the bounding rectangle.
const CONTROLTYPEID kButtonControlTypeId       = 50000;
const PROPERTYID    kBoundingRectanglePropertyId = 30001;
// 50006 is Image, 30011 is AutomationId. Chromium-family apps expose an
// icon-only button as a Button whose only child is an Image, and the hit test
// under the cursor lands on whichever of the two is innermost.
const CONTROLTYPEID kImageControlTypeId        = 50006;
const PROPERTYID    kAutomationIdPropertyId    = 30011;

// Where an element is on screen, in screen coordinates.
//
// get_CurrentBoundingRectangle is absent from some UIAutomation headers, so
// this goes through the property instead. Note the shape of what comes back:
// UIA hands over {left, top, WIDTH, HEIGHT} as four doubles, not a RECT — read
// it as right/bottom and every hit test is wrong in a way that still looks
// plausible, which is worse than failing.
bool ElementRect(IUIAutomationElement* el, RECT& out) {
    if (!el) return false;
    VARIANT v; VariantInit(&v);
    bool ok = false;
    if (SUCCEEDED(el->GetCurrentPropertyValue(kBoundingRectanglePropertyId, &v))
        && (v.vt & VT_ARRAY) && v.parray) {
        SAFEARRAY* sa = v.parray;
        LONG lb = 0, ub = 0;
        if (SUCCEEDED(SafeArrayGetLBound(sa, 1, &lb)) &&
            SUCCEEDED(SafeArrayGetUBound(sa, 1, &ub)) && (ub - lb + 1) == 4) {
            double d[4] = {0, 0, 0, 0};
            bool got = true;
            for (LONG i = 0; i < 4 && got; ++i) {
                LONG idx = lb + i;
                if (FAILED(SafeArrayGetElement(sa, &idx, &d[i]))) got = false;
            }
            if (got && d[2] > 0 && d[3] > 0) {
                out.left   = (LONG)d[0];
                out.top    = (LONG)d[1];
                out.right  = (LONG)(d[0] + d[2]);
                out.bottom = (LONG)(d[1] + d[3]);
                ok = true;
            }
        }
    }
    VariantClear(&v);
    return ok;
}

std::string ElementDescription(IUIAutomationElement* el) {
    if (!el) return "(none)";
    std::string out;
    VARIANT v; VariantInit(&v);
    if (SUCCEEDED(el->GetCurrentPropertyValue(UIA_ControlTypePropertyId, &v)) && v.vt == VT_I4)
        out += "type=" + std::to_string((int)v.lVal);
    VariantClear(&v);

    VariantInit(&v);
    if (SUCCEEDED(el->GetCurrentPropertyValue(kNamePropertyId, &v))
        && v.vt == VT_BSTR && v.bstrVal) {
        std::string n = WideToUtf8(v.bstrVal);
        if (n.size() > 40) n = n.substr(0, 40) + "...";
        if (!out.empty()) out += " ";
        out += "name='" + n + "'";
    }
    VariantClear(&v);
    return out.empty() ? "(opaque)" : out;
}

// ── What the user actually typed ──────────────────────────────────────────
//
// Everything else in this file depends on UI Automation being able to read the
// app's message box. On WhatsApp for Windows — a WinUI 3 window hosting
// WebView2 — that has repeatedly proved unreliable: Chromium builds its
// accessibility tree lazily, sometimes not at all, and when it is absent this
// module has nothing to inspect and the send goes out unchecked. Every fix so
// far has been a better way of asking the same question of a component that
// keeps declining to answer.
//
// This is the answer that does not ask it. The hook already sees every
// keystroke on the machine and, until now, discarded all of them except Enter.
// Keeping the printable ones costs a table lookup per key and gives the
// decision a source that no app, framework or accessibility setting can take
// away.
//
// The scope is deliberately narrow, because this IS keystroke capture and it
// should exist only where an operator has explicitly asked for typed messages
// to be inspected:
//   - only while the foreground window is a MANAGED app with typed-message
//     inspection turned on. The sampler publishes that one window handle and
//     the hook does a pointer compare, because resolving the foreground app on
//     every keystroke is a syscall per key and that is how a low-level hook
//     gets evicted by Windows;
//   - discarded as soon as the message is sent, when the box is seen to be
//     empty, on Escape, on select-all-and-replace, when a different app's
//     message box takes over, and after five minutes of nobody typing.
//     Deliberately NOT discarded merely because another window came to the
//     front: the block dialog itself is MB_SETFOREGROUND, so that rule would
//     empty the buffer immediately after every block and let the user's next
//     Enter carry the same card number straight out;
//   - never written to the log, and never leaves the machine except as the
//     message text of a block or alert the policy already asked for;
//   - capped, and expired.
std::mutex  g_typedMx;
std::string g_typedText;
HWND        g_typedWnd  = nullptr;
long long   g_typedAtMs = 0;

// Published by the sampler, read by the hook. Null means "the foreground window
// is not an app we inspect", and the hook records nothing at all.
std::atomic<HWND> g_managedWnd{nullptr};
// Ctrl+V in a managed app. The clipboard is read by the sampler, never by the
// hook: OpenClipboard blocks on whichever process currently owns it.
std::atomic<bool> g_pasteSeen{false};
// Ctrl+A in a managed app. The next printable key or Delete replaces the whole
// box, so the buffer has to start again - otherwise a card number that the user
// selected and typed over is still in it, and blocks the innocent message that
// replaced it.
std::atomic<bool> g_selectAll{false};

constexpr size_t   kTypedMaxBytes = 4096;
constexpr long long kTypedMaxAgeMs = 300000;   // five minutes of not typing

void ClearTypedBuffer() {
    std::lock_guard<std::mutex> lk(g_typedMx);
    g_typedText.clear();
    g_typedAtMs = 0;
}

// What was typed into `wnd`, or empty. Never returns another window's text.
std::string TypedTextFor(HWND wnd) {
    std::lock_guard<std::mutex> lk(g_typedMx);
    if (!wnd || g_typedWnd != wnd || g_typedText.empty()) return {};
    if (g_typedAtMs && NowSteadyMs() - g_typedAtMs > kTypedMaxAgeMs) return {};
    return g_typedText;
}

void AppendTypedText(HWND wnd, const std::string& add) {
    if (add.empty()) return;
    std::lock_guard<std::mutex> lk(g_typedMx);
    const long long now = NowSteadyMs();
    if (g_typedWnd != wnd || (g_typedAtMs && now - g_typedAtMs > kTypedMaxAgeMs)) {
        g_typedText.clear();
        g_typedWnd = wnd;
    }
    if (g_typedText.size() < kTypedMaxBytes)
        g_typedText.append(add, 0, kTypedMaxBytes - g_typedText.size());
    g_typedAtMs = now;
}

void AppendTyped(HWND wnd, char ch) { AppendTypedText(wnd, std::string(1, ch)); }

// Ctrl+V happened in a managed app. Read from the SAMPLER thread, never the
// hook: OpenClipboard blocks on whichever process currently owns the clipboard,
// and a hook that blocks is a hook Windows removes. If it is held right now we
// lose this one paste rather than stall the desktop.
// Shared by the two ways a file reaches a chat without a file dialog: dropped,
// and pasted. Defined further down, where the classifier is in scope.
void InspectStagedFiles(std::vector<std::string> paths, DWORD targetPid);

// Files on the clipboard, if any. Copying a file in Explorer puts CF_HDROP
// there, carrying FULL PATHS - so a file pasted into a chat identifies itself
// exactly, with none of the ambiguity a bare file name would have.
//
// Pasting is the other half of dropping: WhatsApp opens the same preview window
// for both, and a picture that cannot be sent by dragging can be sent by
// copying. Covering one and not the other would just move the hole.
std::vector<std::string> ClipboardFilePaths() {
    std::vector<std::string> out;
    HANDLE h = GetClipboardData(CF_HDROP);
    if (!h) return out;
    HDROP drop = (HDROP)GlobalLock(h);
    if (!drop) return out;
    const UINT n = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
    for (UINT i = 0; i < n && out.size() < 16; ++i) {
        wchar_t buf[MAX_PATH] = {0};
        if (DragQueryFileW(drop, i, buf, MAX_PATH) > 0) {
            const std::string p = WideToUtf8(buf);
            if (!p.empty()) out.push_back(p);
        }
    }
    GlobalUnlock(h);
    return out;
}

void AppendClipboardText(HWND wnd) {
    if (!OpenClipboard(nullptr)) return;
    HANDLE h = GetClipboardData(CF_UNICODETEXT);
    if (h) {
        const wchar_t* w = (const wchar_t*)GlobalLock(h);
        if (w) {
            std::string utf8 = WideToUtf8(w);
            GlobalUnlock(h);
            if (utf8.size() > kTypedMaxBytes) utf8.resize(kTypedMaxBytes);
            AppendTypedText(wnd, utf8);
        }
    }
    const std::vector<std::string> files = ClipboardFilePaths();
    CloseClipboard();

    // Inspected on a thread: this reads the file and asks the server, and the
    // sampler must not stall while it happens.
    if (!files.empty()) {
        DWORD tpid = 0;
        if (wnd) GetWindowThreadProcessId(wnd, &tpid);
        std::thread(InspectStagedFiles, files, tpid).detach();
    }
}

// Called from the hook, on every keydown, before anything expensive.
//
// MapVirtualKey rather than ToUnicode: ToUnicode mutates the calling thread's
// keyboard state and can swallow the user's next dead key. Doing that inside a
// hook, on every keystroke, would break accented input across the whole desktop
// to read a message box.
void RecordTypedKey(DWORD vk) {
    const HWND managed = g_managedWnd.load(std::memory_order_relaxed);
    if (!managed || GetForegroundWindow() != managed) return;

    const bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    if (ctrl) {
        // Paste is how a card number most often arrives in a chat window, so it
        // cannot be the one input method this does not see. The hook only
        // records that it happened.
        if (vk == 'V') g_pasteSeen.store(true, std::memory_order_relaxed);
        if (vk == 'A') g_selectAll.store(true, std::memory_order_relaxed);
        return;                                   // Ctrl+C, Ctrl+X … type nothing
    }

    // Shift+Enter is a new line, not a send - the send path lets it through
    // untouched and asks us to keep it, because a message whose line breaks are
    // dropped runs "4111111111111111" straight into the next word and stops
    // looking like a card number.
    if (vk == VK_RETURN) { AppendTyped(managed, '\n'); return; }

    if (vk == VK_BACK || vk == VK_DELETE) {
        if (g_selectAll.exchange(false, std::memory_order_relaxed)) {
            ClearTypedBuffer();                   // the whole box was selected
            return;
        }
        if (vk == VK_DELETE) return;              // forward delete: position unknown
        std::lock_guard<std::mutex> lk(g_typedMx);
        if (g_typedWnd == managed && !g_typedText.empty()) g_typedText.pop_back();
        return;
    }
    if (vk == VK_ESCAPE) {
        g_selectAll.store(false, std::memory_order_relaxed);
        ClearTypedBuffer();
        return;
    }

    char ch = 0;
    if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) {
        ch = (char)('0' + (vk - VK_NUMPAD0));
    } else if (vk == VK_SPACE) {
        ch = ' ';
    } else {
        // A shifted number-row key is punctuation, not a digit. Without this,
        // "!!!!" reads as "1111" and a row of exclamation marks starts looking
        // like the beginning of a card number.
        if (vk >= '0' && vk <= '9' && (GetAsyncKeyState(VK_SHIFT) & 0x8000)) return;
        const UINT m = MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) & 0x7FFF;
        if (m < 32 || m > 126) return;            // dead keys, F-keys, navigation
        ch = (char)m;
    }
    // Typing over a selection replaces it.
    if (g_selectAll.exchange(false, std::memory_order_relaxed)) ClearTypedBuffer();
    AppendTyped(managed, ch);
}

// ── Where the app actually keeps its UI ───────────────────────────────────
//
// ElementFromHandle(the foreground window) is the correct root for a native app
// and the wrong one for every app that hosts a browser. WhatsApp for Windows is
// a WinUI 3 window with a WebView2 child:
//
//   WinUIDesktopWin32WindowClass                  <- GetForegroundWindow()
//     Microsoft.UI.Content.DesktopChildSiteBridge
//     Chrome_WidgetWin_0                          <- the entire chat UI is here
//
// WinUI does not bridge the WebView2 fragment into its own UI Automation tree.
// So FindAll(TreeScope_Descendants) from the top-level window was not slow and
// not unlucky - it was COMPLETE, and the true answer was zero editable nodes.
// The composer cannot be reached from that root however long it is given, which
// is precisely what "0 editable node(s) seen in 17668ms" reported, correctly,
// about a box that had a card number in it. Every symptom followed from this:
// no composer, no Send button, and a focused element that was the WebView2 host
// pane rather than anything a user could type into.
//
// The root is therefore enumerated rather than assumed. The window itself is
// tried first - a native app (Telegram, Signal's Qt build) must behave exactly
// as it did before, and it costs one FindAll - then its child windows, browser
// hosts ahead of the rest.
bool IsEmbeddedBrowserHost(const std::string& cls) {
    // Chromium's own window classes: WebView2, Electron and CEF all use them.
    if (cls.rfind("chrome_widgetwin_", 0) == 0)               return true;
    if (cls == "chrome_renderwidgethosthwnd")                 return true;
    // The WinUI 3 / Windows App SDK content island that hosts them.
    if (cls == "microsoft.ui.content.desktopchildsitebridge") return true;
    if (cls == "windows.ui.core.corewindow")                  return true;
    if (cls == "intermediate d3d window")                     return true;
    return false;
}

struct RootCandidate {
    HWND h       = nullptr;
    bool browser = false;
    bool visible = false;
};

BOOL CALLBACK CollectRootWindow(HWND h, LPARAM lp) {
    auto* out = reinterpret_cast<std::vector<RootCandidate>*>(lp);
    if (!out) return FALSE;
    if (out->size() >= 48) return FALSE;      // a window tree, not a search
    char cls[128] = {0};
    if (GetClassNameA(h, cls, (int)sizeof(cls) - 1) <= 0) return TRUE;
    RootCandidate c;
    c.h       = h;
    c.browser = IsEmbeddedBrowserHost(ToLowerAscii(cls));
    c.visible = IsWindowVisible(h) ? true : false;
    out->push_back(c);
    return TRUE;
}

// Browser hosts are included whether or not Windows calls them visible - a
// composited Chromium surface is not always marked WS_VISIBLE and excluding it
// would put us back where we started. Everything else must be visible, because
// a hidden pane is where a background tab's text lives, and reading that would
// classify a conversation nobody is looking at.
//
// Browser hosts come BEFORE the foreground window, not after. Trying the
// top-level window first looks like the conservative order and is the wrong
// one: on WhatsApp that window intermittently exposes ONE editable node which
// is not the message box - the 26-character, zero-digit node that a card number
// was once judged against - and a search that returns on its first hit stops
// there and never reaches the browser. When an app embeds a browser, the
// browser is where the conversation is; the window itself is the fallback, and
// for a native app (Telegram, Signal's Qt build) it is the only entry and
// nothing about its handling changes.
std::vector<HWND> ContentRoots(HWND wnd) {
    std::vector<HWND> roots;
    if (!wnd) return roots;
    std::vector<RootCandidate> kids;
    EnumChildWindows(wnd, CollectRootWindow, reinterpret_cast<LPARAM>(&kids));
    for (const auto& k : kids) if (k.browser)              roots.push_back(k.h);
    roots.push_back(wnd);
    for (const auto& k : kids) if (!k.browser && k.visible) roots.push_back(k.h);
    return roots;
}

// Chromium builds its accessibility tree only once a client asks for it the way
// a screen reader does - WM_GETOBJECT carrying OBJID_CLIENT. Until something
// asks, the tree does not exist, and every UI Automation query against it is
// answered, truthfully, with nothing.
//
// SendMessageTimeout, short and abort-if-hung, and from the LOCATOR thread
// only: this blocks on another process's message pump, and a low-level hook
// that did such a thing would be evicted by Windows for overrunning its budget
// - the exact failure this file already carries a watchdog for.
#ifndef OBJID_CLIENT
#define OBJID_CLIENT ((LONG)0xFFFFFFFC)
#endif

void NudgeAccessibility(HWND wnd) {
    if (!wnd) return;
    std::vector<RootCandidate> kids;
    EnumChildWindows(wnd, CollectRootWindow, reinterpret_cast<LPARAM>(&kids));
    for (const auto& k : kids) {
        if (!k.browser) continue;
        DWORD_PTR res = 0;
        SendMessageTimeout(k.h, WM_GETOBJECT, 0, (LPARAM)OBJID_CLIENT,
                           SMTO_ABORTIFHUNG, 200, &res);
    }
}

enum class ReadStatus {
    Ok,          // we read the composer
    EmptyBox,    // we found the composer; there was nothing in it
    NoComposer,  // UI Automation showed us no editable node at all
};

struct ComposerRead {
    ReadStatus  status = ReadStatus::NoComposer;
    std::string text;
    std::string source;   // for the log: which strategy found it
};

struct Candidate {
    std::string text;
    bool        focused  = false;
    bool        definite = false;   // see ElementEditability
};

// Every editable Edit/Document node under `root`. `sizeCap` of 0 means no cap;
// a non-zero cap discards anything larger, which is how the window-wide sweep
// avoids swallowing a conversation.
void CollectEditable(IUIAutomation* uia, IUIAutomationElement* root, size_t sizeCap,
                     std::vector<Candidate>& out, int& editableSeen,
                     long long deadlineMs = 0) {
    if (!uia || !root) return;
    for (int controlType : { UIA_EditControlTypeId, UIA_DocumentControlTypeId }) {
        if (deadlineMs && NowSteadyMs() >= deadlineMs) return;
        IUIAutomationCondition* cond = nullptr;
        VARIANT v; VariantInit(&v);
        v.vt = VT_I4; v.lVal = controlType;
        if (FAILED(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, v, &cond)) || !cond) {
            VariantClear(&v);
            continue;
        }
        VariantClear(&v);
        IUIAutomationElementArray* arr = nullptr;
        root->FindAll(TreeScope_Descendants, cond, &arr);
        if (arr) {
            int n = 0; arr->get_Length(&n);
            for (int i = 0; i < n; ++i) {
                // Every property read below is a cross-process call. On a chat
                // window that is thousands of them, and the caller is holding a
                // keystroke while we make them.
                if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
                IUIAutomationElement* el = nullptr;
                arr->GetElement(i, &el);
                if (!el) continue;
                const Editability ed = ElementEditability(el);
                if (ed.editable) {
                    ++editableSeen;
                    std::string t = TextFromElement(el);
                    if (!t.empty() && (sizeCap == 0 || t.size() <= sizeCap)) {
                        out.push_back({ t, ElementHasFocus(el), ed.definite });
                    }
                }
                el->Release();
            }
            arr->Release();
        }
        cond->Release();
    }
}

// The box the user is typing in is the focused element — true by construction,
// since they just pressed Enter into it. Everything here is anchored on that
// fact. Deliberately NOT "the longest Edit/Document in the window": in a
// WebView2/Chromium app the longest one is the chat history, and picking it
// blocks every send on something said last month while shipping the whole
// conversation off the endpoint as evidence.
ComposerRead ReadComposer(IUIAutomation* uia, HWND wnd, DWORD pid,
                          bool allowWindowSweep = true, long long deadlineMs = 0) {
    ComposerRead r;
    if (!uia) return r;

    int editableSeen = 0;

    // 1. The focused element itself.
    //
    // The focused element routinely belongs to a DIFFERENT process than the
    // window we resolved, and rejecting that outright threw away the only good
    // signal in exactly the apps this module exists for. WhatsApp for Windows is
    // a WebView2 app: the window belongs to WhatsApp.Root.exe and the composer
    // the user is typing in belongs to msedgewebview2.exe. Electron, the new
    // Teams and Outlook clients, and every other Chromium host are the same
    // shape — the renderer is a separate process by design.
    //
    // A cross-process focus is therefore treated as unverified rather than
    // wrong: it is still used, but only under the size cap, so the worst case is
    // that a very large read is declined instead of a conversation being
    // classified and shipped as evidence.
    IUIAutomationElement* focused = nullptr;
    if (SUCCEEDED(uia->GetFocusedElement(&focused)) && focused) {
        const DWORD fpid = ElementProcessId(focused);
        const bool sameProcess = (pid == 0 || fpid == 0 || fpid == pid);
        {
            const bool editable = ElementIsEditable(focused) && sameProcess;
            if (editable) ++editableSeen;
            std::string t = TextFromElement(focused);
            // Focus is the strongest evidence there is that this is the box the
            // user is typing in, so a focused node is trusted even when its
            // editability cannot be established — a web composer that reports
            // neither a Value pattern nor keyboard-focusability would otherwise
            // fail inspection open, which is the bug this module exists to fix.
            // The one shape never accepted on that basis is unverifiable AND the
            // size of a conversation, because that is what a chat history is.
            if (!t.empty() && (editable || t.size() <= g_cfg.maxFallbackTextBytes)) {
                focused->Release();
                r.status = ReadStatus::Ok;
                r.text   = t;
                r.source = editable ? "focused"
                                    : (sameProcess ? "focused-unverified"
                                                   : "focused-crossprocess");
                return r;
            }
            // 2. Focus may sit on a wrapper rather than the editable node.
            //    Search ITS subtree, which is still nowhere near the history.
            std::vector<Candidate> cands;
            CollectEditable(uia, focused, 0, cands, editableSeen, deadlineMs);
            if (!cands.empty()) {
                // Taking cands[0] when nothing reported focus was this module
                // breaking its own rule on the one path where it costs the most.
                // This sweep runs UNCAPPED, so the chat history is an eligible
                // candidate, and in document order it comes FIRST — above the
                // composer. The result is the conversation being classified in
                // place of the message: a card number sitting in the box is
                // reported "clean (Public)" and released, which is precisely the
                // leak this module exists to stop, wearing a passing verdict.
                //
                // Order of evidence, strongest first:
                const Candidate* pick = nullptr;
                const char* how = "";
                for (const auto& c : cands) if (c.focused) { pick = &c; how = "focused"; break; }
                if (!pick) {
                    // Exactly one node that POSITIVELY reports it is writable.
                    // A history pane reaches this list only through the
                    // focusability fallback, so it is never `definite`.
                    const Candidate* only = nullptr; int n = 0;
                    for (const auto& c : cands) if (c.definite) { ++n; only = &c; }
                    if (n == 1) { pick = only; how = "sole-writable"; }
                }
                if (!pick && cands.size() == 1) { pick = &cands[0]; how = "sole-candidate"; }

                if (pick) {
                    focused->Release();
                    r.status = ReadStatus::Ok; r.text = pick->text;
                    r.source = std::string("focused-subtree(") + std::to_string(cands.size()) +
                               "," + how + ")";
                    return r;
                }
                // Genuinely ambiguous. Fall through to the window sweep, which
                // is size-capped and demands an unambiguous answer — and if that
                // declines too, the send is reported as uninspectable rather
                // than silently blessed by whichever node sorted first.
                LogDbg("focused subtree offered " + std::to_string(cands.size()) +
                       " editable candidates, none focused and none uniquely writable"
                       " - not guessing");
            }
        }
        focused->Release();
    }

    // 3. Last resort: the whole window. Editable nodes only, size-capped, and
    //    it must be unambiguous — either exactly one candidate, or one that
    //    reports keyboard focus. Guessing here is how you read a conversation.
    // Step 3 walks EVERY descendant of the window. On WhatsApp for Windows that
    // measured seven seconds — with the user's Enter held the whole time, so the
    // watchdog released the send uninspected at 1.2s and the read eventually
    // came back reporting an empty box: empty because the message it was meant
    // to inspect had already gone. It is a fine thing for the background sampler
    // to do and an indefensible thing to do while holding a keystroke.
    // Over every candidate root, not just the top-level window - see
    // ContentRoots. In a WebView2 app the top-level window's tree contains no
    // editable node at all, so this branch used to conclude "no composer" about
    // an app whose composer was one child window away.
    if (wnd && allowWindowSweep) {
        for (HWND cand : ContentRoots(wnd)) {
            if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
            IUIAutomationElement* root = nullptr;
            if (FAILED(uia->ElementFromHandle(cand, &root)) || !root) continue;
            std::vector<Candidate> cands;
            CollectEditable(uia, root, g_cfg.maxFallbackTextBytes, cands, editableSeen, deadlineMs);
            root->Release();
            const Candidate* pick = nullptr;
            for (const auto& c : cands) if (c.focused) { pick = &c; break; }
            if (!pick && cands.size() == 1) pick = &cands[0];
            if (pick) {
                r.status = ReadStatus::Ok; r.text = pick->text; r.source = "window-fallback";
                return r;
            }
            if (!cands.empty()) {
                LogDbg("ambiguous composer (" + std::to_string(cands.size()) +
                       " editable candidates, none focused) - not guessing");
            }
        }
    }

    r.status = (editableSeen > 0) ? ReadStatus::EmptyBox : ReadStatus::NoComposer;
    return r;
}

// The ONLY read allowed while a keystroke is held.
//
// Everything expensive lives in one call the hold path must never make:
// FindAll(TreeScope_Descendants). In a Chromium app the focused element's
// subtree is the whole document - the entire chat history - and enumerating it
// cross-process measured seven seconds on WhatsApp for Windows. It is a single
// blocking call, so no deadline can interrupt it: the budget expired before the
// first node was examined, which is why the read reported "no editable node"
// while editable nodes plainly existed.
//
// So this asks UI Automation exactly one question - what has focus, and what is
// in it - and accepts no for an answer. Finding the composer the hard way is
// the sampler's job, done between keystrokes when nothing is held.
ComposerRead ReadFocusedOnly(IUIAutomation* uia, DWORD pid) {
    ComposerRead r;
    if (!uia) return r;

    IUIAutomationElement* focused = nullptr;
    if (FAILED(uia->GetFocusedElement(&focused)) || !focused) return r;

    const DWORD fpid = ElementProcessId(focused);
    const bool sameProcess = (pid == 0 || fpid == 0 || fpid == pid);
    const bool editable = ElementIsEditable(focused) && sameProcess;
    std::string t = TextFromElement(focused);

    if (!t.empty() && (editable || t.size() <= g_cfg.maxFallbackTextBytes)) {
        r.status = ReadStatus::Ok;
        r.text   = t;
        r.source = editable ? "focused"
                            : (sameProcess ? "focused-unverified" : "focused-crossprocess");
    } else {
        r.status = editable ? ReadStatus::EmptyBox : ReadStatus::NoComposer;
        r.source = "focus:" + ElementDescription(focused);
    }
    focused->Release();
    return r;
}

// Locate the composer ELEMENT and keep it. Called by the sampler, never while a
// keystroke is held: this is the expensive path, and finding the box once and
// then reading its text every cycle is the difference between a sample that is
// a quarter of a second old and one that costs seven seconds to take.
// The Send button, by name. Every app in scope labels it for accessibility —
// it has to, or a screen-reader user could not send a message — so the name is
// the one durable handle across WhatsApp, Teams, Telegram, Slack and Signal.
// Matched on a contained "send" so "Send", "Send message" and "Send now" all
// hit, and deliberately NOT on position or icon, which change with every
// redesign.
// ── Recognising the Send control ───────────────────────────────────
//
// Two independent tests, because neither covers these apps on its own.
//
// By NAME, when there is a name: the accessible name is "Send", "Send message",
// occasionally "Send (Enter)". Matched a word at a time rather than by
// substring, so "Resend", "Unsend" and "Sender" do not match, and the compound
// actions that send something other than the typed text - "Send file", "Send
// contact", "Send voice message" - are excluded outright. Swallowing a click on
// those would block an attachment flow, which the attachment path already
// covers, while showing the user a message about typed text.
//
// By POSITION, for the apps that ship an unnamed icon, which is most of them:
// in every chat client this monitor manages, the send affordance is the control
// immediately to the RIGHT of the message box and vertically level with it.
// Emoji and attachment sit to the LEFT; toolbar and header buttons sit above
// with no vertical overlap. The test is deliberately narrow, and it fails safe:
// no composer rectangle, or nothing small beside it, and there is no candidate
// at all rather than a guess.

std::string ElementStringProp(IUIAutomationElement* el, PROPERTYID prop) {
    if (!el) return "";
    std::string out;
    VARIANT v; VariantInit(&v);
    if (SUCCEEDED(el->GetCurrentPropertyValue(prop, &v)) && v.vt == VT_BSTR && v.bstrVal)
        out = ToLowerAscii(WideToUtf8(v.bstrVal));
    VariantClear(&v);
    return out;
}

CONTROLTYPEID ElementControlType(IUIAutomationElement* el) {
    if (!el) return 0;
    CONTROLTYPEID ct = 0;
    VARIANT v; VariantInit(&v);
    if (SUCCEEDED(el->GetCurrentPropertyValue(UIA_ControlTypePropertyId, &v)) && v.vt == VT_I4)
        ct = (CONTROLTYPEID)v.lVal;
    VariantClear(&v);
    return ct;
}

// Whole-word test. "resend" and "sender" contain "send" and are not it.
bool ContainsWord(const std::string& hay, const std::string& word) {
    size_t at = 0;
    while ((at = hay.find(word, at)) != std::string::npos) {
        const bool leftOk  = at == 0 || !isalnum((unsigned char)hay[at - 1]);
        const size_t end   = at + word.size();
        const bool rightOk = end >= hay.size() || !isalnum((unsigned char)hay[end]);
        if (leftOk && rightOk) return true;
        at = end;
    }
    return false;
}

bool NameSuggestsSend(const std::string& name) {
    if (name.empty() || name.size() > 48) return false;
    static const char* kNotThisSend[] = {
        "resend", "unsend", "send file", "send a file", "send document",
        "send photo", "send picture", "send image", "send video", "send gif",
        "send sticker", "send contact", "send location", "send voice",
        "send audio", "send money", "send payment", "send later",
        "schedule send", "send feedback", "send invite",
    };
    for (const char* bad : kNotThisSend)
        if (name.find(bad) != std::string::npos) return false;
    return ContainsWord(name, "send");
}

bool ElementSuggestsSend(IUIAutomationElement* el) {
    if (NameSuggestsSend(ElementStringProp(el, kNamePropertyId))) return true;
    // An automation id is developer-chosen and never localised, so a substring
    // is the right test there: "sendButton", "btn-send", "composer_send".
    const std::string id = ElementStringProp(el, kAutomationIdPropertyId);
    if (id.empty() || id.size() > 48) return false;
    if (id.find("resend") != std::string::npos ||
        id.find("unsend") != std::string::npos) return false;
    return id.find("send") != std::string::npos;
}

// Is this rectangle actually inside the window it is supposed to belong to?
// A rectangle that is not describes a layout that no longer exists - a dead
// element answering with the geometry it had when it died.
bool RectInsideWindow(const RECT& r, HWND wnd) {
    RECT w{};
    if (!wnd || !GetWindowRect(wnd, &w)) return false;
    return r.left >= w.left && r.top >= w.top &&
           r.right <= w.right && r.bottom <= w.bottom;
}

// Big enough to click, small enough to be a button rather than a panel or a
// conversation row. Everything published to the mouse hook passes through here:
// the hook swallows a click inside whatever rectangle it is given, so an
// oversized one would swallow clicks all over the window.
bool ButtonSized(const RECT& r) {
    const LONG w = r.right - r.left;
    const LONG h = r.bottom - r.top;
    return w >= 8 && h >= 8 && w <= 400 && h <= 200;
}

// Is this rectangle the control sitting beside the message box?
bool RectBesideComposer(const RECT& cand, const RECT& comp) {
    const LONG w = cand.right - cand.left;
    const LONG h = cand.bottom - cand.top;
    if (w < 8 || h < 8 || w > 140 || h > 140)          return false;  // not button-shaped
    if (cand.top >= comp.bottom || cand.bottom <= comp.top) return false;  // not level with it
    if (cand.left < comp.right - 8)                    return false;  // not to its right
    if (cand.left - comp.right > 250)                  return false;  // not beside it
    return true;
}

// composerRect may be null; viaPosition (optional) reports which test won, so
// the log can say whether the agent recognised the button or guessed it.
// One root, one pass — see SearchEditableUnder for why this is split out.
IUIAutomationElement* SearchSendButtonUnder(IUIAutomation* uia, HWND rootWnd,
                                            long long deadlineMs,
                                            const RECT* composerRect,
                                            bool* viaPosition) {
    IUIAutomationElement* root = nullptr;
    if (FAILED(uia->ElementFromHandle(rootWnd, &root)) || !root) return nullptr;

    IUIAutomationElement* named  = nullptr;
    IUIAutomationElement* placed = nullptr;   // best positional candidate so far
    LONG                  placedLeft = 0;

    // Button AND Image, as two filtered passes.
    //
    // This asked for Button alone, and the hover probe below has always accepted
    // either - with a comment explaining exactly why: "Chromium-family apps
    // expose an icon-only button as a Button whose only child is an Image, and
    // the hit test under the cursor lands on whichever of the two is innermost."
    //
    // So the two paths disagreed about what a send control looks like, and the
    // search is the one that has to work. Hovering found the button; the tree
    // walk could not, and a click without a hover first was never inspected.
    // That is the whole of "Enter blocks, the Send button does not".
    //
    // Two passes rather than one OR condition: CreateOrCondition is absent from
    // the trimmed UIAutomation headers this file is required to build against,
    // and the same reasoning that spells the control-type constants out by
    // number applies here. Each pass is still filtered by the provider, which is
    // what keeps this off the "return every descendant and sift" path that
    // FindAll over a Chromium document otherwise becomes.
    const CONTROLTYPEID kWanted[] = { kButtonControlTypeId, kImageControlTypeId };
    for (const CONTROLTYPEID ctWanted : kWanted) {
        if (named) break;
        if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
        VARIANT want; VariantInit(&want);
        want.vt = VT_I4; want.lVal = ctWanted;
        IUIAutomationCondition* cond = nullptr;
        if (SUCCEEDED(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, want, &cond)) && cond) {
            IUIAutomationElementArray* arr = nullptr;
            if (SUCCEEDED(root->FindAll(TreeScope_Descendants, cond, &arr)) && arr) {
                int n = 0; arr->get_Length(&n);
                for (int i = 0; i < n && !named; ++i) {
                    if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
                    IUIAutomationElement* el = nullptr;
                    if (FAILED(arr->GetElement(i, &el)) || !el) continue;
                    // No process filter. The root is a window inside the
                    // foreground app's OWN hierarchy, so anything under it
                    // belongs to that app whichever process draws it - and in a
                    // WebView2 app that is never the process owning the window.
                    RECT r{};
                    const bool measured = ElementRect(el, r);

                    // Measurable and button-shaped is a condition of the NAME
                    // match too: the only use anything found here is put to is a
                    // click rectangle, so a control we cannot measure is not a
                    // candidate, and a huge one is a container that happens to be
                    // named Send.
                    if (measured && ButtonSized(r) && ElementSuggestsSend(el)) {
                        named = el; continue;                         // caller releases
                    }
                    if (composerRect && measured &&
                        RectBesideComposer(r, *composerRect) &&
                        (!placed || r.left < placedLeft)) {
                        if (placed) placed->Release();
                        placed = el; placedLeft = r.left;
                        continue;                                     // kept, not released
                    }
                    el->Release();
                }
                arr->Release();
            }
            cond->Release();
        }
        VariantClear(&want);
    }
    root->Release();

    if (named) {
        if (placed) placed->Release();
        return named;
    }
    if (placed && viaPosition) *viaPosition = true;
    return placed;
}

IUIAutomationElement* FindSendButton(IUIAutomation* uia, HWND wnd, DWORD pid,
                                     long long deadlineMs,
                                     const RECT* composerRect,
                                     bool* viaPosition) {
    if (viaPosition) *viaPosition = false;
    if (!uia || !wnd) return nullptr;
    (void)pid;
    for (HWND cand : ContentRoots(wnd)) {
        if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
        IUIAutomationElement* found =
            SearchSendButtonUnder(uia, cand, deadlineMs, composerRect, viaPosition);
        if (found) return found;
    }
    return nullptr;
}

// Reports the display scaling this process actually sees. Worth a line at
// startup because it is the one thing that decides whether the mouse path can
// work at all: a DPI-UNAWARE process is handed cursor positions in a virtualised
// 96-DPI space while UI Automation reports rectangles in physical pixels, and on
// a scaled display the two differ by exactly this factor - so a correctly found
// Send button is compared against a click that can never fall inside it.
//
// The number is therefore also the proof that the awareness call at startup
// took: an unaware process reads 96 here no matter how the display is set.
std::string DescribeDisplayScaling() {
    UINT dpi = 0;
    if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
        typedef UINT (WINAPI *GetDpiFn)(void);
        GetDpiFn f = (GetDpiFn)(void*)GetProcAddress(user32, "GetDpiForSystem");
        if (f) dpi = f();
    }
    if (!dpi) {
        if (HDC dc = GetDC(nullptr)) {
            const int d = GetDeviceCaps(dc, LOGPIXELSX);
            if (d > 0) dpi = (UINT)d;
            ReleaseDC(nullptr, dc);
        }
    }
    if (!dpi) dpi = 96;
    const unsigned pct = (dpi * 100u + 48u) / 96u;
    return std::to_string(pct) + "% (" + std::to_string(dpi) + " dpi)";
}

// Is this string plausibly the name of a chat, rather than a status line or a
// piece of the app's own furniture?
bool LooksLikeConversationName(const std::string& s, const std::string& appName) {
    if (s.size() < 2 || s.size() > 64) return false;
    const std::string l = ToLowerAscii(s);
    if (l == ToLowerAscii(appName)) return false;
    static const char* kNotAName[] = {
        "online", "typing", "last seen", "click here", "search", "menu",
        "new chat", "status", "settings", "profile", "archived", "unread",
        "message", "attach", "emoji", "voice", "video call", "recording",
        // Hosting-layer furniture. A hit test that lands anywhere but the page
        // returns the name of the window that OWNS that pixel, and those names
        // read like plausible prose - "non client input sink window" has
        // letters, spaces and a sensible length, and sailed through every test
        // below. It was reported as the conversation name on a real block.
        "input sink", "sink window", "non client", "nonclient",
        "chrome_widgetwin", "chrome_renderwidget", "desktopchildsitebridge",
        "corewindow", "intermediate d3d", "title bar", "titlebar",
        "minimize", "maximize", "restore", "close", "system menu",
        // Shell windows that sit OVER an application and answer a hit test in
        // its place. "virtual desktop switching preview" was reported as the
        // conversation on a real block.
        "virtual desktop", "switching preview", "desktop", "taskbar",
        "start menu", "notification", "shell", "program manager",
    };
    for (const char* bad : kNotAName)
        if (l.find(bad) != std::string::npos) return false;
    bool anyLetter = false;
    for (unsigned char c : s) if (std::isalpha(c)) { anyLetter = true; break; }
    return anyLetter;
}

// WhatsApp puts the product name in its window title and the conversation only
// in the page, so the title says nothing about who a message was going to -
// the first thing an analyst asks and the one thing the event could not answer.
//
// Read by POINT rather than by walking the tree. A chat window's accessibility
// tree holds every message ever rendered in it, so a descendant search is
// thousands of nodes and seconds of work; the conversation header sits in the
// same place - the top of the right-hand pane - so a handful of hit tests
// answers the same question for almost nothing. Sampled across a small band
// because the exact offset moves with window size, zoom and title-bar height.
std::string ProbeConversationName(IUIAutomation* uia, HWND wnd, const std::string& appName) {
    if (!uia || !wnd) return {};
    // The CLIENT area, not the window. Sampling the window rectangle put the
    // first rows of points in the caption, where the hit test returns the
    // non-client input sink rather than anything on the page - which is exactly
    // what got reported as a conversation name.
    RECT cr{};
    if (!GetClientRect(wnd, &cr)) return {};
    POINT tl{ cr.left, cr.top }, br{ cr.right, cr.bottom };
    if (!ClientToScreen(wnd, &tl) || !ClientToScreen(wnd, &br)) return {};
    const LONG w = br.x - tl.x, h = br.y - tl.y;
    if (w < 500 || h < 300) return {};      // too small for a two-pane layout

    // Wider band than before: WinUI apps draw their own title bar INSIDE the
    // client area, so the header can sit anywhere in the top fifth depending on
    // how tall that custom caption is.
    // Three points, not fifteen. Every one of these is a cross-process hit test
    // into a WebView2 tree, and fifteen of them on the sampler thread stalled
    // the loop that the send path waits on - which showed up as a delay on
    // EVERY message, sensitive or not. A conversation name is worth almost
    // nothing next to that.
    static const double kXs[] = {0.52};
    static const double kYs[] = {0.09, 0.14, 0.19};

    std::string firstSeen;
    for (double fy : kYs) {
        for (double fx : kXs) {
            POINT p{ tl.x + (LONG)(w * fx), tl.y + (LONG)(h * fy) };
            IUIAutomationElement* el = nullptr;
            if (FAILED(uia->ElementFromPoint(p, &el)) || !el) continue;
            const std::string name = ElementStringProp(el, kNamePropertyId);
            // The element has to be INSIDE the app's own client area. A hit test
            // answers with whatever owns that pixel, and a shell window layered
            // over the app owns it just as truthfully - which is how a desktop
            // switching preview came back as the name of a chat. Anything
            // spilling outside the app is not part of its page.
            RECT er{};
            const bool inside =
                ElementRect(el, er) &&
                er.left >= tl.x - 2 && er.top >= tl.y - 2 &&
                er.right <= br.x + 2 && er.bottom <= br.y + 2 &&
                (er.right - er.left) > 0 && (er.bottom - er.top) > 0;
            el->Release();
            if (name.empty() || !inside) continue;
            if (firstSeen.empty()) firstSeen = name;
            if (LooksLikeConversationName(name, appName)) return name;
        }
    }
    // Nothing matched. Say once what WAS up there, so a layout this does not fit
    // can be corrected from evidence rather than by another guess.
    if (!firstSeen.empty() && !g_convLoggedOnce.exchange(true)) {
        LogInfo("could not identify the conversation in this window - the header "
                "area reads '" + firstSeen + "'");
    }
    return {};
}

bool HaveConversationFor(HWND wnd) {
    std::lock_guard<std::mutex> lk(g_convMx);
    if (!wnd || g_convWnd != wnd || g_convName.empty()) return false;
    return !(g_convAtMs && NowSteadyMs() - g_convAtMs > 60000);
}

std::string ConversationFor(HWND wnd) {
    std::lock_guard<std::mutex> lk(g_convMx);
    if (!wnd || g_convWnd != wnd || g_convName.empty()) return {};
    if (g_convAtMs && NowSteadyMs() - g_convAtMs > 60000) return {};
    return g_convName;
}

// The shell-automation GUIDs, defined here rather than linked.
//
// libuuid supplies them, but linking it also supplies CLSID_CUIAutomation,
// IID_IUIAutomation, IID_IUIAutomationEventHandler and
// IID_IUIAutomationValuePattern - all four of which network_exfil_monitor.cpp
// already defines for itself, so the link fails on multiple definition. This
// file follows the same convention a few hundred lines up: a literal GUID
// depends on no library and cannot be duplicated by one.
//
// Values taken from mingw-w64's shldisp.h / exdisp.h, which match the SDK:
//     DEFINE_GUID(CLSID_ShellWindows,       0x9ba05972,0xf6a8,0x11cf, ...)
//     DEFINE_GUID(IID_IShellWindows,        0x85cb6900,0x4d95,0x11cf, ...)
//     DEFINE_GUID(IID_IWebBrowser2,         0xd30c1661,0xcdaf,0x11d0, ...)
//     DEFINE_GUID(IID_IShellFolderViewDual, 0xe7a1af80,0x4d96,0x11cf, ...)
static const CLSID kCLSID_ShellWindows =
    { 0x9ba05972, 0xf6a8, 0x11cf, { 0xa4,0x42, 0x00,0xa0,0xc9,0x0a,0x8f,0x39 } };
static const IID   kIID_IShellWindows =
    { 0x85cb6900, 0x4d95, 0x11cf, { 0x96,0x0c, 0x00,0x80,0xc7,0xf4,0xee,0x85 } };
static const IID   kIID_IWebBrowser2 =
    { 0xd30c1661, 0xcdaf, 0x11d0, { 0x8a,0x3e, 0x00,0xc0,0x4f,0xc9,0xe2,0x6e } };
static const IID   kIID_IShellFolderViewDual =
    { 0xe7a1af80, 0x4d96, 0x11cf, { 0x96,0x0c, 0x00,0x80,0xc7,0xf4,0xee,0x85 } };

// What is selected in the Explorer window a drag started from.
//
// Asked of the shell itself rather than inferred: Explorer publishes its open
// views through IShellWindows, and a view knows its own selection with full
// paths. That is what makes this unambiguous - dragging selects, so the
// selection at drag time IS what was dragged, and no two files with the same
// name can be confused for one another.
std::vector<std::string> SelectedPathsInShellWindow(HWND target) {
    std::vector<std::string> out;
    if (!target) return out;
    IShellWindows* windows = nullptr;
    if (FAILED(CoCreateInstance(kCLSID_ShellWindows, nullptr, CLSCTX_ALL,
                                kIID_IShellWindows, (void**)&windows)) || !windows)
        return out;
    long count = 0;
    windows->get_Count(&count);
    for (long i = 0; i < count && out.empty(); ++i) {
        VARIANT v; VariantInit(&v); v.vt = VT_I4; v.lVal = i;
        IDispatch* disp = nullptr;
        if (FAILED(windows->Item(v, &disp)) || !disp) { VariantClear(&v); continue; }
        IWebBrowser2* wb = nullptr;
        if (SUCCEEDED(disp->QueryInterface(kIID_IWebBrowser2, (void**)&wb)) && wb) {
            SHANDLE_PTR hw = 0;
            wb->get_HWND(&hw);
            if ((HWND)hw == target) {
                IDispatch* docDisp = nullptr;
                if (SUCCEEDED(wb->get_Document(&docDisp)) && docDisp) {
                    IShellFolderViewDual* view = nullptr;
                    if (SUCCEEDED(docDisp->QueryInterface(kIID_IShellFolderViewDual,
                                                          (void**)&view)) && view) {
                        FolderItems* items = nullptr;
                        if (SUCCEEDED(view->SelectedItems(&items)) && items) {
                            long n = 0; items->get_Count(&n);
                            for (long k = 0; k < n && (int)out.size() < 16; ++k) {
                                VARIANT kv; VariantInit(&kv); kv.vt = VT_I4; kv.lVal = k;
                                FolderItem* it = nullptr;
                                if (SUCCEEDED(items->Item(kv, &it)) && it) {
                                    BSTR bp = nullptr;
                                    if (SUCCEEDED(it->get_Path(&bp)) && bp) {
                                        const std::string sp = WideToUtf8(bp);
                                        if (!sp.empty()) out.push_back(sp);
                                        SysFreeString(bp);
                                    }
                                    it->Release();
                                }
                                VariantClear(&kv);
                            }
                            items->Release();
                        }
                        view->Release();
                    }
                    docDisp->Release();
                }
            }
            wb->Release();
        }
        disp->Release();
        VariantClear(&v);
    }
    windows->Release();
    return out;
}

// A drop landed on a managed chat window. Runs on its own thread: this does
// COM, hit tests and a server round trip, none of which may happen on a hook.
void ResolveDroppedFiles(HWND srcWnd, HWND target) {
    if (g_dropBusy.exchange(true)) return;      // one at a time is plenty
    struct Done { ~Done(){ g_dropBusy.store(false); } } done;

    const bool comOk = SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED));
    HWND src = srcWnd ? GetAncestor(srcWnd, GA_ROOT) : nullptr;

    std::vector<std::string> paths;
    if (src && src != target) paths = SelectedPathsInShellWindow(src);

    if (paths.empty()) {
        // Dragged from something that is not an Explorer view - another app's
        // list, a browser download bar, a shell view we cannot query. Name what
        // the source actually was: "not identified" on its own cannot tell a
        // wrong window from an unsupported one, and those need different fixes.
        if (!g_dropNoSourceLogged.exchange(true)) {
            char cls[128] = {0};
            if (src) GetClassNameA(src, cls, (int)sizeof(cls) - 1);
            DWORD spid = 0;
            if (src) GetWindowThreadProcessId(src, &spid);
            LogInfo(std::string("a file was dropped into a managed chat but the "
                    "source could not be asked what it had selected - source "
                    "window class='") + cls + "' exe=" +
                    (spid ? ProcessExeName(spid) : std::string("(none)")) +
                    (src == target ? " (same window as the chat)" : ""));
        }
        if (comOk) CoUninitialize();
        return;
    }

    DWORD tpid = 0;
    if (target) GetWindowThreadProcessId(target, &tpid);
    if (comOk) CoUninitialize();
    InspectStagedFiles(paths, tpid);
}

// Defined below, where the event plumbing and the classifier are in scope.
// Staging-time enforcement needs them here.
std::string DescribeLabels(const NetworkExfilMonitor::ClassifyResult& cls);
void EmitEvent(const std::string& exe, DWORD pid, const std::string& action,
               const std::string& severity,
               const NetworkExfilMonitor::ClassifyResult& cls,
               const std::string& reason, const std::string& text,
               const std::string& via = "", HWND wnd = nullptr);
void ShowBlockedNotice(const std::string& appExe, const std::string& what);
void ClearPendingDrop();

// Classify files staged for sending and, if any is sensitive, hold that verdict
// against the application until it sends. Already on its own thread in both
// callers - this reads a file and asks the server, and neither the sampler nor
// a hook may wait for that.
// Same enforcement the file-dialog path uses: stop the app before the
// attachment reaches its TLS-encrypted upload. There is no gentler lever in
// user mode - we cannot reach into the app and un-stage a file it is already
// holding.
bool TerminateMessagingApp(DWORD pid) {
    if (!pid) return false;
    HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (!h) return false;
    const bool ok = TerminateProcess(h, 1) != FALSE;
    CloseHandle(h);
    return ok;
}

void InspectStagedFiles(std::vector<std::string> paths, DWORD targetPid) {
    if (paths.empty()) return;
    // Was the hook even wired up? Returning quietly here meant that an agent
    // built or configured without server-side file classification behaved
    // exactly like one where every attachment came back clean - no block and
    // no explanation, which is the hardest failure of all to report.
    if (!g_cfg.classifyFile) {
        LogWarn("a file was staged in a managed chat but no file classifier is "
                "configured - attachments cannot be inspected on this agent");
        return;
    }

    // From here until this returns, both send gates know a verdict is coming
    // and will hold a send rather than let it race the OCR.
    StagedInspectionScope inFlight(targetPid);
    for (const auto& path : paths) {
        NetworkExfilMonitor::ClassifyResult cls;
        try { cls = g_cfg.classifyFile(path, "messaging_attachment"); }
        catch (...) { LogWarn("classifying " + path + " threw"); }
        const std::string cat = ToLowerAscii(cls.category);
        // Say what was decided, for every file. Until now the only line written
        // was the one announcing a sensitive file, so "nothing happened" covered
        // both "looked and it was fine" and "never actually looked".
        if (!cls.inspected) {
            LogWarn("staged attachment NOT inspected: " + path +
                    " - it has NOT been cleared, the inspection did not complete");
        } else {
            LogInfo("staged attachment inspected: " + path + " -> " +
                    (cls.category.empty() ? "no classification" : cls.category));
        }
        if (cat == "confidential" || cat == "restricted") {
            {
                std::lock_guard<std::mutex> lk(g_dropMx);
                g_dropPid = targetPid;
                g_dropExe = ToLowerAscii(ProcessExeName(targetPid));
                g_dropAtMs = NowSteadyMs();
                g_dropPath = path;  g_dropCls = cls;
            }
            LogWarn("a sensitive file was staged in a managed chat: " + path +
                    " (" + cls.category + ")");

            // Act HERE, not at the send.
            //
            // Waiting for the send meant recognising the Send button in a Chromium UI
            // that rebuilds itself mid-conversation, and doing it faster than a person
            // can click. On one measured run the verdict was armed at 12:58:36 and the
            // button was not located until 12:58:40 - 1.5s AFTER the file had gone. The
            // detection side was never the problem; the race was. The file-dialog path
            // never had this problem because it has always acted at selection time.
            //
            // The send gates below are left in place. They still catch a typed message,
            // and they still catch an attachment if this returns without acting.
            const DWORD  tpid     = targetPid;
            const std::string exe = ProcessExeName(tpid);
            NetworkExfilMonitor::MessagingVerdict mv = AskPolicy(ToLowerAscii(exe));
            const std::string what = DescribeLabels(cls);
            const std::string severity =
                (ToLowerAscii(cls.category) == "restricted") ? "critical" : "high";
            if (mv.block) {
                const bool killed = TerminateMessagingApp(tpid);
                try {
                    EmitEvent(exe, tpid, "BLOCK", severity, cls,
                              "Blocked sensitive file staged in " + exe + " (" +
                              cls.category + ") - " + path +
                              (killed ? "" : " [terminate failed]"),
                              path, "staged_file", nullptr);
                } catch (...) {}
                LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" + cls.category +
                        " detected=[" + what + "] via=staged-file path=" + path +
                        (killed ? " (app terminated)" : " (terminate FAILED)"));
                ShowBlockedNotice(exe, what.empty() ? std::string("a sensitive file") : what);
                // Acted. Leaving the verdict armed would block the next unrelated send
                // in this app for the whole five-minute window.
                if (killed) ClearPendingDrop();
            } else {
                // Audit-first default: recorded, not interrupted. The send gates still
                // hold the verdict, so an alert-mode policy behaves exactly as before.
                try {
                    EmitEvent(exe, tpid, "ALERT", severity, cls,
                              "Sensitive file staged in " + exe + " (" + cls.category +
                              ") - " + path + ". Alert only - not blocked.",
                              path, "staged_file", nullptr);
                } catch (...) {}
                LogWarn("POLICY_DECISION messaging decision=ALERT category=" + cls.category +
                        " via=staged-file path=" + path);
            }
            break;
        }
    }
}

// The pending sensitive drop for this window, if there is a fresh one.
// Matches on either identity: the same process, or any process running the same
// executable. One covers a second window of the same process, the other covers a
// preview hosted by a sibling process of the same application.
bool DropMatches(DWORD pid, const std::string& exe) {
    if (g_dropPath.empty()) return false;
    if (g_dropAtMs && NowSteadyMs() - g_dropAtMs > 300000) return false;
    if (pid && g_dropPid == pid) return true;
    return !exe.empty() && !g_dropExe.empty() && ToLowerAscii(exe) == g_dropExe;
}

bool HasPendingDrop(DWORD pid, const std::string& exe) {
    std::lock_guard<std::mutex> lk(g_dropMx);
    return DropMatches(pid, exe);
}

bool PendingDropFor(DWORD pid, const std::string& exe, std::string& pathOut,
                    NetworkExfilMonitor::ClassifyResult& clsOut) {
    std::lock_guard<std::mutex> lk(g_dropMx);
    // Five minutes: long enough to add a caption, short enough that a file
    // dropped and then removed does not haunt the next message.
    if (!DropMatches(pid, exe)) return false;
    pathOut = g_dropPath; clsOut = g_dropCls;
    return true;
}

void ClearPendingDrop() {
    std::lock_guard<std::mutex> lk(g_dropMx);
    g_dropPid = 0; g_dropExe.clear(); g_dropAtMs = 0; g_dropPath.clear();
    g_dropCls = NetworkExfilMonitor::ClassifyResult{};
}

// ── The pointer as the cheap search ───────────────────────────────
//
// FindSendButton walks the whole descendant tree, which on a Chromium document
// costs seconds. ElementFromPoint asks about ONE point and costs a fraction of
// that, and there is a point worth asking about: nobody clicks Send without
// first moving the pointer onto it. At 300ms per pass, a button the user is
// travelling towards is identified well before the click lands.
//
// It also covers what the tree walk cannot. The walk runs on a timer against a
// tree that rebuilds itself constantly; this runs against whatever is under the
// cursor at that instant, so an app that renames or re-creates its send control
// per message is handled without a re-find. Publishes straight into the
// rectangle the mouse hook reads - there is no element to cache, which is the
// point.
// One point, asked once. Extracted from the hover probe so the same rules can
// be applied to a point the user has not reached yet.
//
// Returns true when it published a rectangle. When it saw a clickable,
// button-sized control that it declined to call Send, *declined is filled in so
// the caller can say so - that line is the difference between knowing an app
// labels its send control unusually and guessing.
bool TryPublishSendAtPoint(IUIAutomation* uia, const TargetApp& t, POINT p,
                           const RECT* composerRect, std::string* declined) {
    if (!uia || !t.wnd) return false;
    RECT wr{};
    if (!GetWindowRect(t.wnd, &wr)) return false;
    if (p.x < wr.left || p.x >= wr.right || p.y < wr.top || p.y >= wr.bottom) return false;

    IUIAutomationElement* el = nullptr;
    if (FAILED(uia->ElementFromPoint(p, &el)) || !el) return false;

    bool published = false;
    RECT r{};
    // No process check on what comes back. In every Chromium-hosted app the Send
    // button belongs to the renderer - WhatsApp's is msedgewebview2.exe while
    // the window is WhatsApp.Root.exe - so an equality test against the
    // foreground pid rejected the exact control it was meant to find, and did so
    // silently.
    //
    // Nothing is lost by its absence: the point is already proven to be inside
    // the managed window's rectangle above, and the size, control-type and
    // name/position tests below still have to pass. The rectangle is published
    // against t.pid either way, so the mouse hook compares like with like.
    if (ElementRect(el, r)) {
        // The hit test returns the innermost node, which for an icon button is
        // the Image inside it rather than the Button itself - hence Image
        // counting as clickable here.
        //
        // The control type gate applies to the NAME test as well, not only the
        // positional one. A conversation row reading "send me the file when you
        // can" is named send-ish and is not a button, and swallowing a click on
        // it would be the agent breaking the app.
        const CONTROLTYPEID ct = ElementControlType(el);
        const bool clickable = (ct == kButtonControlTypeId || ct == kImageControlTypeId);
        if (clickable && ButtonSized(r) && RectInsideWindow(r, t.wnd)) {
            if (ElementSuggestsSend(el) ||
                (composerRect && RectBesideComposer(r, *composerRect))) {
                std::lock_guard<std::mutex> lk(g_sendMx);
                g_sendRect = r; g_sendPid = t.pid; g_sendAtMs = NowSteadyMs();
                // Recorded here too. The probe publishes a rectangle without
                // caching an element, so without this the hook's "has the window
                // moved?" test had nothing to compare against on the one path
                // that was actually finding the button.
                g_sendWnd     = t.wnd;
                g_sendWndRect = wr;
                published = true;
            } else if (declined) {
                *declined = ElementDescription(el) + " size=" +
                            std::to_string(r.right - r.left) + "x" +
                            std::to_string(r.bottom - r.top);
            }
        }
    }
    el->Release();
    return published;
}

// ── The pointer as the cheap search ───────────────────────────────
//
// FindSendButton walks the whole descendant tree, which on a Chromium document
// costs seconds. ElementFromPoint asks about ONE point and costs a fraction of
// that, and there is a point worth asking about: nobody clicks Send without
// first moving the pointer onto it.
//
// It also covers what the tree walk cannot. The walk runs on a timer against a
// tree that rebuilds itself constantly; this runs against whatever is under the
// cursor at that instant, so an app that renames or re-creates its send control
// per message is handled without a re-find.
bool ProbeHoveredSendControl(IUIAutomation* uia, const TargetApp& t,
                             const RECT* composerRect) {
    POINT p{};
    if (!GetCursorPos(&p)) return false;
    std::string declined;
    if (TryPublishSendAtPoint(uia, t, p, composerRect, &declined)) return true;
    if (!declined.empty()) {
        // Once a minute, not once a frame.
        const long long now  = NowSteadyMs();
        const long long last = g_hoverMissLoggedMs.load(std::memory_order_relaxed);
        if (!last || now - last > 60000) {
            g_hoverMissLoggedMs.store(now, std::memory_order_relaxed);
            LogInfo("locator saw a clickable control under the pointer in " +
                    t.exe + " but does not recognise it as Send - " + declined +
                    (composerRect ? ""
                                  : " (no message-box rectangle, so the name was the only test)"));
        }
    }
    return false;
}

// ── Where Send has to be, asked directly ──────────────────────────
//
// The tree walk fails on WhatsApp ("by name or beside the message box") and the
// hover probe only fires once the pointer is already on the control - so the
// FIRST send of a session was never inspected, and the user had to hover before
// the agent would block anything. That is not a control; it is a control with a
// documented bypass.
//
// The button's position is not a mystery, though. RectBesideComposer already
// states where it must be: level with the message box, to its right, within
// 250px. Those are points ElementFromPoint can be asked about without waiting
// for the pointer to arrive. Outermost first, because the send control sits at
// the end of the row of composer buttons.
bool ProbeSendBesideComposer(IUIAutomation* uia, const TargetApp& t,
                             const RECT* composerRect) {
    if (!composerRect) return false;
    const RECT& c = *composerRect;
    if (c.right <= c.left || c.bottom <= c.top) return false;
    const LONG y = c.top + (c.bottom - c.top) / 2;
    static const LONG kOffsets[] = { 200, 150, 110, 80, 56, 36, 20 };
    for (const LONG dx : kOffsets) {
        POINT p{ c.right + dx, y };
        if (TryPublishSendAtPoint(uia, t, p, composerRect, nullptr)) return true;
    }
    return false;
}

// ── Where Send has to be when the composer is not known yet ───────
//
// Locking onto the composer took 4055ms on a real WhatsApp conversation, and
// the user had dropped a file and clicked Send inside 2.5s of it. Every probe
// that needs the message box's rectangle was therefore still blind at the one
// moment that mattered, and the send went out with "no Send button has been
// located" in the log. This one needs nothing but the window.
//
// Position alone is NOT allowed to call something Send here. Without the
// composer there is no "beside the message box" test to corroborate it, so
// composerRect is passed as null and only a control whose NAME or automation
// id says send is accepted. A false positive here would swallow clicks in the
// corner of the window the user actually uses, which is worse than a miss.
bool ProbeSendInWindowCorner(IUIAutomation* uia, const TargetApp& t) {
    RECT wr{};
    if (!t.wnd || !GetWindowRect(t.wnd, &wr)) return false;
    if (wr.right - wr.left < 320 || wr.bottom - wr.top < 320) return false;
    // The composer row sits above the bottom edge, and the send control at its
    // right end - so sweep a band in from the bottom-right corner.
    static const LONG kDx[] = { 30, 56, 86, 120 };
    static const LONG kDy[] = { 100, 130, 70, 160, 190 };
    for (const LONG dy : kDy) {
        for (const LONG dx : kDx) {
            POINT p{ wr.right - dx, wr.bottom - dy };
            if (TryPublishSendAtPoint(uia, t, p, nullptr, nullptr)) return true;
        }
    }
    return false;
}

// One root, one pass. Extracted so the same rules about what counts as a
// composer can be run against several candidate roots without being restated.
IUIAutomationElement* SearchEditableUnder(IUIAutomation* uia, IUIAutomationElement* root,
                                          long long deadlineMs, int& editableSeen) {
    if (!uia || !root) return nullptr;
    IUIAutomationElement* best = nullptr;
    for (int controlType : { UIA_EditControlTypeId, UIA_DocumentControlTypeId }) {
        if (best || (deadlineMs && NowSteadyMs() >= deadlineMs)) break;
        IUIAutomationCondition* cond = nullptr;
        VARIANT v; VariantInit(&v);
        v.vt = VT_I4; v.lVal = controlType;
        if (FAILED(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, v, &cond)) || !cond) {
            VariantClear(&v);
            continue;
        }
        VariantClear(&v);
        IUIAutomationElementArray* arr = nullptr;
        root->FindAll(TreeScope_Descendants, cond, &arr);
        if (arr) {
            int n = 0; arr->get_Length(&n);
            for (int i = 0; i < n; ++i) {
                if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
                IUIAutomationElement* el = nullptr;
                arr->GetElement(i, &el);
                if (!el) continue;
                const Editability ed = ElementEditability(el);
                if (ed.editable) ++editableSeen;
                // Only a node that POSITIVELY reports it is writable. A history
                // pane reaches the editable list through the focusability
                // fallback and is never `definite`, which is what keeps the
                // conversation from being sampled in place of the message.
                if (ed.editable && ed.definite) {
                    if (ElementHasFocus(el)) {          // unambiguous winner
                        if (best) best->Release();
                        best = el;
                        break;
                    }
                    if (!best) { best = el; continue; }
                }
                el->Release();
            }
            arr->Release();
        }
        cond->Release();
    }
    return best;
}

// `rootUsed` reports which window actually held the composer, so the Send
// button search can start there instead of paying for the same discovery twice.
IUIAutomationElement* FindComposerElement(IUIAutomation* uia, HWND wnd, DWORD pid,
                                          long long deadlineMs, int& editableSeen,
                                          HWND* rootUsed = nullptr) {
    if (rootUsed) *rootUsed = wnd;
    if (!uia) return nullptr;
    (void)pid;

    IUIAutomationElement* focused = nullptr;
    if (SUCCEEDED(uia->GetFocusedElement(&focused)) && focused) {
        // A cross-process focus is the NORM in the apps this module exists for:
        // the window belongs to the shell (WhatsApp.Root.exe) and the composer
        // to the renderer (msedgewebview2.exe). ReadComposer has always accepted
        // that. Requiring a pid match HERE rejected the composer of every
        // Chromium-hosted app outright and sent the search down the tree-walk
        // path, which - rooted at the top-level window - could not reach it
        // either. Editability is still required, so the WebView2 host pane that
        // focus resolves to before the tree is built is still not mistaken for
        // a message box.
        if (ElementIsEditable(focused)) {
            ++editableSeen;
            return focused;   // caller releases
        }
        focused->Release();
    }

    if (!wnd) return nullptr;
    for (HWND cand : ContentRoots(wnd)) {
        if (deadlineMs && NowSteadyMs() >= deadlineMs) break;
        IUIAutomationElement* root = nullptr;
        if (FAILED(uia->ElementFromHandle(cand, &root)) || !root) continue;
        IUIAutomationElement* best = SearchEditableUnder(uia, root, deadlineMs, editableSeen);
        root->Release();
        if (best) {
            if (rootUsed) *rootUsed = cand;
            return best;
        }
    }
    return nullptr;
}

// Chromium does not build an accessibility tree until something asks it to, and
// the ask that triggers it is the one that then returns nothing — the tree is
// populated a beat later. A single read therefore finds NO editable node on the
// first send into a WebView2/Electron app and finds the composer instantly on
// the second, which is how this module came to report "composer unreadable" for
// exactly the applications it exists to cover.
//
// Retried only for NoComposer. EmptyBox means the tree was there and the box was
// empty, which is the normal alert-mode result after the app has cleared it, and
// re-reading that would just burn the budget the watchdog is counting down.
ComposerRead ReadComposerRetry(IUIAutomation* uia, HWND wnd, DWORD pid, unsigned budgetMs,
                              bool allowWindowSweep = true) {
    const long long deadline = NowSteadyMs() + (long long)budgetMs;
    ComposerRead r;
    int attempts = 0;
    for (;;) {
        ++attempts;
        try { r = ReadComposer(uia, wnd, pid, allowWindowSweep, deadline); } catch (...) {}
        if (r.status != ReadStatus::NoComposer) break;
        if (NowSteadyMs() >= deadline) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(40));
    }
    if (attempts > 1 && r.status != ReadStatus::NoComposer) {
        LogDbg("composer appeared on attempt " + std::to_string(attempts) +
               " (accessibility tree was still being built)");
    }
    return r;
}

// ── Releasing a held keystroke ────────────────────────────────────────────
// Replay as a genuine keypress. Windows stamps it LLKHF_INJECTED, which the
// hook checks first, so this cannot come back round to us.
// Replay a click we held. SetCursorPos first, because the pointer may have
// moved while the verdict was pending and the app decides what was clicked
// from where the cursor is. Windows stamps the injected events
// LLMHF_INJECTED, which MouseProc checks first, so this cannot come back
// round to us.
void ReleaseClick(POINT pt) {
    SetCursorPos(pt.x, pt.y);
    INPUT in[2] = {};
    in[0].type = INPUT_MOUSE; in[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    in[1].type = INPUT_MOUSE; in[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(2, in, sizeof(INPUT));
}

void ReleaseKeystroke(bool withCtrl) {
    INPUT in[4] = {};
    int n = 0;
    if (withCtrl) {
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_CONTROL; ++n;
    }
    in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_RETURN; ++n;
    in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_RETURN;
    in[n].ki.dwFlags = KEYEVENTF_KEYUP; ++n;
    if (withCtrl) {
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_CONTROL;
        in[n].ki.dwFlags = KEYEVENTF_KEYUP; ++n;
    }
    SendInput(n, in, sizeof(INPUT));
}

// Exactly one resolver wins. Returns true to the winner.
bool ClaimDecision() { return !g_decisionResolved.exchange(true); }

void ResolveRelease(bool ctrl) {
    if (ClaimDecision()) {
        ReleaseKeystroke(ctrl);
        g_decisionPending.store(false);
    }
}

bool ResolveDrop() {
    if (ClaimDecision()) {
        g_decisionPending.store(false);
        return true;
    }
    return false;
}

// ── Events ────────────────────────────────────────────────────────────────

std::string EscapeJson(const std::string& s) {
    std::string out; out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    sprintf(buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;
                }
        }
    }
    return out;
}

std::string NowIso8601() {
    SYSTEMTIME st; GetSystemTime(&st);
    char buf[64];
    sprintf(buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    return buf;
}

std::string GenerateUuidLike() {
    GUID g;
    if (FAILED(CoCreateGuid(&g))) return "00000000-0000-0000-0000-000000000000";
    char buf[64];
    sprintf(buf, "%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            (unsigned long)g.Data1, g.Data2, g.Data3,
            g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3],
            g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7]);
    return buf;
}

// "whatsapp.root.exe" is what the process is called, not what a person calls
// the app they were using. An analyst reading an alert at 2am should not have to
// know that WhatsApp for Windows runs as WhatsApp.Root.exe.
std::string FriendlyAppName(const std::string& exeLower) {
    if (exeLower.rfind("whatsapp", 0) == 0)                       return "WhatsApp";
    if (exeLower.find("teams") != std::string::npos)              return "Microsoft Teams";
    if (exeLower.rfind("telegram", 0) == 0)                       return "Telegram";
    if (exeLower.rfind("slack", 0) == 0)                          return "Slack";
    if (exeLower.rfind("discord", 0) == 0)                        return "Discord";
    if (exeLower.rfind("signal", 0) == 0)                         return "Signal";
    std::string n = exeLower;
    const size_t dot = n.rfind(".exe");
    if (dot != std::string::npos) n.erase(dot);
    if (!n.empty()) n[0] = (char)std::toupper((unsigned char)n[0]);
    return n;
}

// The title of the window the message was being sent from. On Teams and Slack
// this names the conversation, which is the single most useful thing an analyst
// can be told - "sent to which chat" is the first question every time. WhatsApp
// titles its window with the product name alone, so it is only reported when it
// says something the app name does not.
std::string ConversationHint(HWND wnd, const std::string& appName) {
    // What the sampler read out of the page beats the window title: WhatsApp's
    // title is the product name and nothing else, so the title alone left this
    // field empty on the one app it was most wanted for.
    const std::string probed = ConversationFor(wnd);
    if (!probed.empty()) return probed;
    if (!wnd) return {};
    wchar_t buf[256] = {0};
    const int n = GetWindowTextW(wnd, buf, 255);
    if (n <= 0) return {};
    (void)n;
    // Trimmed inline: TrimText is defined further down and this needs no more
    // than the edges taken off a window title.
    std::string title = WideToUtf8(buf);
    const size_t b = title.find_first_not_of(" \t\r\n");
    const size_t e = title.find_last_not_of(" \t\r\n");
    title = (b == std::string::npos) ? std::string() : title.substr(b, e - b + 1);
    if (title.empty()) return {};
    const std::string lt = ToLowerAscii(title), la = ToLowerAscii(appName);
    if (lt == la) return {};                       // just the product name
    return title;
}

void EmitEvent(const std::string& exe, DWORD pid, const std::string& action,
               const std::string& severity,
               const NetworkExfilMonitor::ClassifyResult& cls,
               const std::string& reason, const std::string& text,
               const std::string& via, HWND wnd) {
    if (!g_cfg.sendEvent) return;
    std::ostringstream j;
    j << "{";
    j << "\"event_id\":\""      << EscapeJson(GenerateUuidLike()) << "\",";
    j << "\"event_type\":\""    << "messaging"                    << "\",";
    j << "\"event_subtype\":\"" << "messaging_message"            << "\",";
    j << "\"agent_id\":\""      << EscapeJson(g_cfg.agentId)      << "\",";
    j << "\"source_type\":\""   << "agent"                        << "\",";
    j << "\"user_email\":\""    << EscapeJson(g_cfg.username + "@" + g_cfg.hostname) << "\",";
    j << "\"severity\":\""      << EscapeJson(severity)           << "\",";
    j << "\"action\":\""        << EscapeJson(action)             << "\",";
    j << "\"channel\":\""       << "MESSAGING"                    << "\",";
    j << "\"process_name\":\""  << EscapeJson(exe)                << "\",";
    // Quoted deliberately. process_id is declared Optional[str] on EventCreate
    // and pydantic 2 does not coerce a number to a string - it 422s the whole
    // request. Sending a bare integer here meant every blocked message was
    // rejected at ingest, so the block happened on the endpoint and left no
    // event, no alert and no incident behind it.
    j << "\"process_id\":\""    << pid                            << "\",";
    j << "\"destination\":\""   << EscapeJson(exe)                << "\",";
    j << "\"destination_type\":\"" << "messaging_app"             << "\",";
    j << "\"blocked\":"         << (action == "BLOCK" ? "true" : "false") << ",";
    if (!cls.category.empty()) {
        j << "\"classification_level\":\"" << EscapeJson(cls.category) << "\",";
        j << "\"classification_score\":"   << cls.score                << ",";
    }
    if (!cls.matchedRule.empty()) {
        // Plural, and an array: classification_rules_matched is the field the
        // server declares. The singular string this used to send was not on
        // EventCreate at all, so it was dropped at ingest and the rule that
        // fired never reached the event an analyst opens.
        j << "\"classification_rules_matched\":[\"" << EscapeJson(cls.matchedRule) << "\"],";
    }
    if (!cls.labels.empty()) {
        j << "\"classification_labels\":[";
        for (size_t i = 0; i < cls.labels.size(); ++i) {
            if (i) j << ",";
            j << "\"" << EscapeJson(cls.labels[i]) << "\"";
        }
        j << "],";
    }
    // The message itself is the evidence, exactly as the typed prompt is for the
    // browser extension: "an Aadhaar number went to WhatsApp" is not something an
    // analyst can triage without seeing what was actually about to be sent. It
    // travels the same authenticated channel and inherits the same retention and
    // read-redaction handling as every other captured content field.
    if (!text.empty()) {
        j << "\"content\":\"" << EscapeJson(text) << "\",";
    }
    if (!reason.empty()) {
        j << "\"description\":\"" << EscapeJson(reason) << "\",";
    }
    // ── What an analyst actually needs ──────────────────────────────────
    // The same shape the browser-extension events use, so one detail view
    // serves both. Before this, a blocked message arrived as a severity chip, a
    // detector name and a sentence - enough to know something happened, not
    // enough to decide what to do about it.
    const std::string exeLower = ToLowerAscii(exe);
    const std::string appName  = FriendlyAppName(exeLower);
    j << "\"activity\":\"send\",";
    j << "\"app_category\":\"messaging\",";
    j << "\"app_name\":\"" << EscapeJson(appName) << "\",";
    j << "\"app_id\":\"" << EscapeJson(exeLower) << "\",";
    // How it was sent. This lived only inside the description sentence, so it
    // could not be filtered, counted, or charted - and the two send paths fail
    // independently, which is exactly when you want to count them separately.
    if (!via.empty()) j << "\"transfer_method\":\"" << EscapeJson(via) << "\",";
    const std::string chat = ConversationHint(wnd, appName);
    if (!chat.empty()) j << "\"recipients\":\"" << EscapeJson(chat) << "\",";
    if (!text.empty()) {
        j << "\"text_content\":\"" << EscapeJson(text) << "\",";
        j << "\"text_truncated\":" << (text.size() >= kTypedMaxBytes ? "true" : "false") << ",";
    }
    if (!cls.labels.empty()) {
        j << "\"matched_rules\":[";
        for (size_t i = 0; i < cls.labels.size(); ++i) {
            if (i) j << ",";
            j << "\"" << EscapeJson(cls.labels[i]) << "\"";
        }
        j << "],";
    }
    // WHICH policy decided, by id and by name. policy_id arriving null is what
    // made a blocked message unanswerable: an analyst could see the verdict and
    // still not know which rule to change to stop it happening again.
    {
        NetworkExfilMonitor::MessagingVerdict pv;
        if (g_cfg.messagingPolicy) {
            try { pv = g_cfg.messagingPolicy(exeLower, g_cfg.username); } catch (...) {}
        }
        if (!pv.policyId.empty()) {
            j << "\"policy_id\":\"" << EscapeJson(pv.policyId) << "\",";
            j << "\"matched_policies\":[\"" << EscapeJson(pv.policyId) << "\"],";
        }
        if (!pv.policyName.empty()) {
            j << "\"governing_policies\":[{\"policy_id\":\"" << EscapeJson(pv.policyId)
              << "\",\"policy_name\":\"" << EscapeJson(pv.policyName) << "\"}],";
        }
        // One sentence saying what was found, where it was going, how it was
        // sent and under which rule - written server-side for web activity, and
        // written here for the same reason: the verdict should read as a
        // decision someone made, not as a status code.
        std::string why = "Message to " + appName;
        if (!chat.empty()) why += " (" + chat + ")";
        if (!cls.labels.empty()) {
            why += " contained " + cls.labels[0];
            for (size_t i = 1; i < cls.labels.size(); ++i) why += ", " + cls.labels[i];
        } else {
            why += " contained sensitive data";
        }
        if (!cls.category.empty()) why += ", classified " + cls.category;
        why += ". ";
        why += (action == "BLOCK" ? "The send was blocked" : "The send was allowed and recorded");
        if (via == "enter_key")        why += " when Enter was pressed";
        else if (via == "send_button") why += " when the Send button was clicked";
        if (!pv.policyName.empty()) why += ", under the policy \"" + pv.policyName + "\"";
        why += ".";
        j << "\"policy_reason\":\"" << EscapeJson(why) << "\",";
    }

    j << "\"timestamp\":\"" << NowIso8601() << "\"";
    j << "}";
    try { g_cfg.sendEvent(j.str()); } catch (...) {}
}

// A blocked send with no explanation looks like the app is broken, and a user
// who thinks the app is broken files a ticket or works around the agent. Own
// thread: MessageBox is modal and must never stall the worker.
void ShowBlockedNotice(const std::string& appExe, const std::string& what) {
    std::string body =
        "Sending this message was blocked by your organisation's data-loss policy.\n\n"
        "Detected: " + (what.empty() ? std::string("sensitive data") : what) + "\n"
        "Application: " + appExe + "\n\n"
        "The text is still in the message box. Remove the sensitive details to send it.";
    // MessageBoxA, not W, was the bug the user saw as "unwanted characters" in
    // the dialog. Every string in this file is UTF-8; the A entry point decodes
    // its bytes with the machine's ANSI code page instead, so the em dash in the
    // title (E2 80 94) arrived on screen as three separate Latin-1 characters,
    // and any non-ASCII in the detection text did the same. Convert once and use
    // the wide call, which is what the bytes have always meant.
    std::thread([body]() {
        const std::wstring wbody  = Utf8ToWide(body);
        const std::wstring wtitle = Utf8ToWide("CyberSentinel DLP - Message blocked");
        MessageBoxW(nullptr, wbody.c_str(), wtitle.c_str(),
                    MB_OK | MB_ICONWARNING | MB_SYSTEMMODAL | MB_SETFOREGROUND);
    }).detach();
}

// ── Which detections count here ───────────────────────────────────────────
//
// The classifier reports everything it finds. Which of those findings should
// stop a CHAT MESSAGE is an operator's decision, not the classifier's, and the
// difference is not academic: a phone number is the single most ordinary thing
// anyone sends over WhatsApp, and the shared network-exfil table rates it
// Confidential because in an outbound curl it is a different proposition
// entirely. Blocking on it by default would train users to see the agent as
// broken within an afternoon.
//
// An empty selection means "everything the classifier considers sensitive",
// which is what the attachment path has always done.
NetworkExfilMonitor::ClassifyResult RestrictToTypes(
        const NetworkExfilMonitor::ClassifyResult& in,
        const std::vector<std::string>& selected) {
    if (selected.empty()) return in;

    NetworkExfilMonitor::ClassifyResult out;
    int best = 0, topSev = -1;
    for (const auto& label : in.labels) {
        bool wanted = false;
        for (const auto& s : selected) {
            if (EqualsIgnoreCase(label, s)) { wanted = true; break; }
        }
        if (!wanted) continue;
        out.labels.push_back(label);
        const int sev = NetworkExfilMonitor::TypeSeverity(label);
        if (sev > best)   best = sev;
        if (sev > topSev) { topSev = sev; out.matchedRule = label; }
    }
    switch (best) {
        case 3: out.category = "Restricted";   out.score = 0.95; break;
        case 2: out.category = "Confidential"; out.score = 0.85; break;
        case 1: out.category = "Internal";     out.score = 0.50; break;
        default: out.category = "Public";      out.score = 0.00; break;
    }
    return out;
}

// What was read, WITHOUT putting the message into a plaintext log on the
// endpoint. Length and character mix are enough to separate "we read the
// composer" from "we read the placeholder, or the wrong node entirely" — a
// 14-character all-letters read is "Type a message", not an Aadhaar number —
// and neither is the data this module exists to protect. The message itself
// still travels to the server on the event, where retention and read-redaction
// apply to it.
std::string TextProfile(const std::string& t) {
    size_t digits = 0, letters = 0;
    for (unsigned char c : t) {
        if (std::isdigit(c)) ++digits;
        else if (std::isalpha(c)) ++letters;
    }
    return std::to_string(t.size()) + " chars/" + std::to_string(digits) +
           " digits/" + std::to_string(letters) + " letters";
}

std::string DescribeLabels(const NetworkExfilMonitor::ClassifyResult& cls) {
    std::string what;
    for (const auto& l : cls.labels) {
        if (!what.empty()) what += ", ";
        what += l;
    }
    if (what.empty()) what = cls.matchedRule;
    return what;
}

bool IsSensitive(const NetworkExfilMonitor::ClassifyResult& cls) {
    const std::string cat = ToLowerAscii(cls.category);
    return cat == "confidential" || cat == "restricted";
}

std::string TrimText(std::string text) {
    if (text.size() > g_cfg.maxTextBytes) text.resize(g_cfg.maxTextBytes);
    const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    auto b = std::find_if(text.begin(), text.end(), notSpace);
    auto e = std::find_if(text.rbegin(), text.rend(), notSpace).base();
    return (b < e) ? std::string(b, e) : std::string();
}

// Report an app whose composer UI Automation cannot see — once per app per
// cooldown. This is the difference between "the policy is working and nobody
// typed anything sensitive" and "this build of the app is invisible to us",
// and from a dashboard those two look identical without it.
void ReportUninspectable(const std::string& exe, DWORD pid) {
    const long long now = NowSteadyMs();
    {
        std::lock_guard<std::mutex> lk(g_uninspectableMx);
        auto it = g_uninspectableAt.find(exe);
        if (it != g_uninspectableAt.end() &&
            now - it->second < (long long)g_cfg.uninspectableCooldownSec * 1000) {
            return;
        }
        g_uninspectableAt[exe] = now;
    }
    NetworkExfilMonitor::ClassifyResult none;
    EmitEvent(exe, pid, "ALLOW", "medium", none,
              "Typed-message inspection could not read the composer in " + exe +
              " - messages in this app are being sent uninspected", "");
    LogWarn("composer unreadable in " + exe + " - typed messages are NOT being inspected");
}

// ── Worker ────────────────────────────────────────────────────────────────

// BLOCK mode. The keystroke is being held right now; every path through here
// must resolve it exactly once.
void DecideAndAct(IUIAutomation* uia, HWND wnd, DWORD pid, bool withCtrl,
                  const std::vector<std::string>& types, const std::string& exeHint) {
    const std::string exe = exeHint.empty() ? ProcessExeName(pid) : exeHint;

    // If an attachment for this app is still being inspected, wait for it. The
    // comment below used to say the verdict was "already classified, on a thread,
    // at drop time" - true for a file dropped a while ago, false for the picture
    // the user attached two seconds before pressing Enter. The watchdog has been
    // told to extend the hold while this is outstanding.
    if (StagedInspectionInFlight(pid)) {
        g_holdForAttachment.store(true);
        if (!AwaitStagedInspection(kAttachmentHoldMs)) {
            LogWarn("attachment inspection exceeded " +
                    std::to_string(kAttachmentHoldMs) + "ms in " + exe +
                    " - send BLOCKED uninspected (fail closed)");
            ShowBlockedNotice(exe, "an attachment that could not be inspected in time");
            ResolveDrop();
            return;
        }
    }

    // A sensitive file was dropped into this window and is waiting to be sent.
    // Decided before anything is read: the message box may be empty or hold an
    // innocent caption, and neither says anything about the picture attached
    // to it. Already classified, on a thread, at drop time - so this costs a
    // mutex and the keystroke is not held while a file is inspected.
    {
        std::string dropPath;
        NetworkExfilMonitor::ClassifyResult dropCls;
        if (PendingDropFor(pid, exe, dropPath, dropCls)) {
            const std::string what = DescribeLabels(dropCls);
            const std::string severity =
                (ToLowerAscii(dropCls.category) == "restricted") ? "critical" : "high";
            EmitEvent(exe, pid, "BLOCK", severity, dropCls,
                      "Blocked sensitive file dropped into " + exe + " (" +
                      dropCls.category + ") - " + dropPath, dropPath,
                      "enter_key", wnd);
            LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" + dropCls.category +
                    " detected=[" + what + "] via=dropped-file path=" + dropPath);
            ShowBlockedNotice(exe, what.empty() ? std::string("a sensitive file") : what);
            ClearPendingDrop();
            return;                 // the send stays swallowed
        }
    }

    // Two thirds of the hold budget: enough for Chromium to build its tree,
    // with the rest left for classification so the watchdog is not what ends
    // this decision.
    // What the sampler saw while the user was still typing.
    //
    // Asking UI Automation for the composer at the instant Enter is swallowed is
    // the worst possible moment to ask. The hook has just taken the keystroke,
    // the app's input is mid-flight, and the answer has to come back across a
    // process boundary from a Chromium renderer. On WhatsApp for Windows that
    // round trip took SEVEN SECONDS: the watchdog released every send
    // uninspected at 1.2s, and the read returned an empty box long afterwards —
    // empty because the message had already been sent while we waited for the
    // answer about it. No amount of retrying fixes a question asked at the wrong
    // time. The sampler asks it a fraction of a second earlier, while the app is
    // idle and replies immediately.
    std::string snap;
    {
        std::lock_guard<std::mutex> lk(g_snapMx);
        const long long age = g_snapAtMs ? (NowSteadyMs() - g_snapAtMs) : -1;
        // Widened from 5s. A sample only goes stale when the box changes, and
        // the box does not change while the user is looking at what they typed.
        if (g_snapPid == pid && !g_snapText.empty() && age >= 0 && age <= 15000)
            snap = TrimText(g_snapText);
    }

    std::string text, via;

    // If what the sampler already holds is damning, block on it and make no UI
    // Automation call at all. This path cannot time out, which makes it the only
    // one that reliably fires on an app whose accessibility tree answers too
    // slowly to be read while a keystroke is held. Spending the budget is
    // reserved for trying to CLEAR a message, never for condemning one.
    if (!snap.empty()) {
        NetworkExfilMonitor::ClassifyResult sraw;
        try { sraw = g_cfg.classify(snap, "messaging_message"); } catch (...) {}
        if (IsSensitive(RestrictToTypes(sraw, types))) { text = snap; via = "sampled"; }
    }

    // What the user typed into this window, which owes UI Automation nothing.
    // Checked here beside the snapshot rather than after the live read: it is
    // already in hand, it costs one classifier pass, and it cannot time out. On
    // an app whose accessibility tree cannot be read it is the ONLY source, and
    // a control that fails open on a card number is not a control.
    const std::string typed = TypedTextFor(wnd);
    if (text.empty() && !typed.empty()) {
        NetworkExfilMonitor::ClassifyResult traw;
        try { traw = g_cfg.classify(typed, "messaging_message"); } catch (...) {}
        if (IsSensitive(RestrictToTypes(traw, types))) { text = typed; via = "typed"; }
    }

    if (text.empty()) {
        // Focused element only - no tree walk of any kind. Retried, because
        // Chromium builds its accessibility tree lazily and the request that
        // triggers the build is the one that returns nothing.
        const unsigned budget = (g_cfg.decisionTimeoutMs ? g_cfg.decisionTimeoutMs : 1200) * 2 / 3;
        const long long deadline = NowSteadyMs() + (long long)budget;
        const long long began = NowSteadyMs();
        ComposerRead read;
        int attempts = 0;
        for (;;) {
            ++attempts;
            try { read = ReadFocusedOnly(uia, pid); } catch (...) {}
            if (read.status == ReadStatus::Ok || NowSteadyMs() >= deadline) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(40));
        }
        text = TrimText(read.text);
        via  = read.source;

        if (text.empty()) {
            // How long it took, and what focus actually was. "No composer" is a
            // conclusion; this is the evidence behind it.
            LogInfo("focused read found nothing for " + exe + " after " +
                    std::to_string(NowSteadyMs() - began) + "ms / " +
                    std::to_string(attempts) + " attempt(s) - " + read.source);
        }

        // The live read is preferred because it is current — the sampler can be
        // up to one interval behind the last characters typed. But a stale
        // sample beats no inspection at all.
        if (text.empty() && !snap.empty())  { text = snap;  via = "sampled-fallback"; }
        if (text.empty() && !typed.empty()) { text = typed; via = "typed-fallback"; }

        if (text.empty()) {
            // Nothing readable. Could be an empty box, could be an app whose composer
            // UI Automation cannot see. Either way the user's Enter is not ours to
            // keep — release it. See the header on why this fails open.
            LogInfo("no composer text for " + exe + " (" +
                   (read.status == ReadStatus::NoComposer ? "no editable node" : "empty box") +
                   ", nothing typed either) - releasing keystroke");
            ResolveRelease(withCtrl);
            ClearTypedBuffer();          // whatever was there has now been sent
            if (read.status == ReadStatus::NoComposer) ReportUninspectable(exe, pid);
            return;
        }
    }

    NetworkExfilMonitor::ClassifyResult raw;
    try { raw = g_cfg.classify(text, "messaging_message"); } catch (...) {}
    const NetworkExfilMonitor::ClassifyResult cls = RestrictToTypes(raw, types);

    if (!IsSensitive(cls)) {
        // Why this says more than "clean": RestrictToTypes reports "Public" both
        // when the classifier found nothing AND when it found something the
        // policy did not select, so the one line an operator reads for a block
        // that did not happen could not tell those apart. Alert mode has said
        // this since it shipped; block mode is the mode people actually roll
        // out, and it was the one flying blind.
        std::string dropped;
        if (!raw.labels.empty() && cls.labels.empty()) {
            dropped = " (classifier saw [" + DescribeLabels(raw) +
                      "], none of them selected in this policy)";
        }
        LogInfo("message clean (" + (cls.category.empty() ? std::string("unclassified") : cls.category) +
               ") in " + exe + " via " + via + " [" + TextProfile(text) + "]" +
               dropped + " - releasing");
        ResolveRelease(withCtrl);
        ClearTypedBuffer();              // the message has gone; start the next one
        return;
    }

    const std::string what = DescribeLabels(cls);
    const std::string severity = (ToLowerAscii(cls.category) == "restricted") ? "critical" : "high";

    // Dropping the held Enter IS the block — but only if we still own it. If the
    // watchdog gave up on us first the message has already gone, and saying
    // "blocked" then would be a lie in the one record an analyst will trust.
    if (ResolveDrop()) {
        EmitEvent(exe, pid, "BLOCK", severity, cls,
                  "Blocked sensitive message in " + exe + " (" + cls.category + ")", text,
                  "enter_key", wnd);
        LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" + cls.category +
                " detected=[" + what + "] via=" + via);
        ShowBlockedNotice(exe, what);
        // The text stays in the box so the user can edit and resend.
    } else {
        EmitEvent(exe, pid, "ALERT", severity, cls,
                  "Sensitive message sent in " + exe + " (" + cls.category +
                  ") - inspection did not finish before the send was released", text,
                  "enter_key", wnd);
        LogWarn("MESSAGING_TEXT_LATE exe=" + exe + " category=" + cls.category +
                " detected=[" + what + "] - verdict arrived after the watchdog released the keystroke");
        ClearTypedBuffer();
    }
    // The block path deliberately does NOT clear: the text is still sitting in
    // the box for the user to edit, so the buffer must still match it.
}

// ALERT mode. Nothing was held and nothing may be touched; the send has already
// happened or is happening. Report it.
void AuditAndAct(IUIAutomation* uia, HWND wnd, DWORD pid,
                 const std::vector<std::string>& types, const std::string& exeHint) {
    const std::string exe = exeHint.empty() ? ProcessExeName(pid) : exeHint;

    // We are racing the app's own handling of the Enter. Sometimes we win and
    // the text is still in the box; when we lose, the sampler's last snapshot is
    // what was there a moment ago.
    // Short budget here on purpose: alert mode is racing the app's own clearing
    // of the box, so a long retry reads an empty composer rather than a full
    // one. It is still worth one or two attempts, because they are also what
    // wakes the accessibility tree for the sends that follow.
    ComposerRead read = ReadComposerRetry(uia, wnd, pid, 200);
    std::string text = TrimText(read.text);
    std::string via  = read.source;

    // Why the snapshot age is reported even when it was not needed: alert mode
    // is the mode an operator switches to FIRST, to see whether any of this
    // works before they let it touch anything. If its only visible output is an
    // event, then "no event" means both "nothing sensitive was sent" and "this
    // never read a single message", and there is no way to tell those apart
    // from a dashboard. Every path below therefore says what it did.
    std::string snapshotNote = "no snapshot";
    if (text.empty()) {
        std::lock_guard<std::mutex> lk(g_snapMx);
        const long long age = g_snapAtMs ? (NowSteadyMs() - g_snapAtMs) : -1;
        if (g_snapPid == pid && !g_snapText.empty() && age >= 0 && age <= 5000) {
            text = TrimText(g_snapText);
            via  = "sampled";
            snapshotNote = "snapshot " + std::to_string(age) + "ms old";
        } else if (!g_snapText.empty()) {
            snapshotNote = (g_snapPid != pid)
                ? "snapshot belongs to another process"
                : "snapshot too old (" + std::to_string(age) + "ms)";
        }
    }
    if (text.empty()) {
        const std::string typed = TypedTextFor(wnd);
        if (!typed.empty()) { text = TrimText(typed); via = "typed"; snapshotNote = "typed"; }
    }
    // Alert mode never holds anything, so by now the message has been sent
    // whatever we found. The next one starts from empty.
    ClearTypedBuffer();

    if (text.empty()) {
        LogInfo("alert: nothing to inspect in " + exe + " (" +
               (read.status == ReadStatus::NoComposer ? "no editable node"
                                                      : "empty box") +
               ", " + snapshotNote + ")");
        if (read.status == ReadStatus::NoComposer) ReportUninspectable(exe, pid);
        return;
    }

    // Enter pressed twice, or a send that left the text in place — either way
    // the operator does not need the same message again.
    {
        const long long now = NowSteadyMs();
        std::lock_guard<std::mutex> lk(g_snapMx);
        if (text == g_lastAuditText && now - g_lastAuditMs < 10000) {
            LogDbg("alert: same text already reported for " + exe + " - suppressed");
            return;
        }
        g_lastAuditText = text;
        g_lastAuditMs   = now;
    }

    NetworkExfilMonitor::ClassifyResult raw;
    try { raw = g_cfg.classify(text, "messaging_message"); } catch (...) {}
    const NetworkExfilMonitor::ClassifyResult cls = RestrictToTypes(raw, types);
    if (!IsSensitive(cls)) {
        // The selected-types filter is the difference an operator most often
        // needs to see: the classifier found something, and the policy said it
        // did not count here.
        std::string dropped;
        if (!raw.labels.empty() && cls.labels.empty()) {
            dropped = " (classifier saw [" + DescribeLabels(raw) +
                      "], none of them selected in this policy)";
        }
        LogInfo("alert: message clean in " + exe + " via " + via + " [" + TextProfile(text) + "] - " +
               (cls.category.empty() ? std::string("unclassified") : cls.category) +
               dropped);
        return;
    }

    const std::string what = DescribeLabels(cls);
    const std::string severity = (ToLowerAscii(cls.category) == "restricted") ? "critical" : "high";
    EmitEvent(exe, pid, "ALERT", severity, cls,
              "Sensitive message sent in " + exe + " (" + cls.category +
              ") - policy is in alert mode, the message was not stopped", text,
              "enter_key", wnd);
    LogWarn("MESSAGING_TEXT_ALERT exe=" + exe + " category=" + cls.category +
            " detected=[" + what + "] via=" + via);
}

// UI Automation, acquired lazily and retried for the life of the process.
//
// This used to be one CoCreateInstance at thread start. If it failed — COM not
// ready yet at boot, a transient RPC fault, the service starting before anyone
// has logged into the desktop — the pointer stayed null forever and every
// managed send took the silent release below. Typed-message inspection was
// then simply off until somebody restarted the agent, and the only evidence
// was a single warning thousands of lines earlier in the log. From the outside
// it looked exactly like the feature had never been built: the hook traced the
// keypress, and then nothing at all happened, every time, for days.
//
// A retry costs one failed CoCreateInstance. Not retrying costs the feature.
bool EnsureUia(IUIAutomation*& uia, long long& lastComplaintMs, bool complain = true) {
    if (uia) return true;

    const HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr,
                                        CLSCTX_INPROC_SERVER, IID_IUIAutomation,
                                        (void**)&uia);
    if (uia) {
        LogInfo("UIAutomation acquired - the message box can be read");
        lastComplaintMs = 0;
        return true;
    }

    if (complain) {
        const long long now = NowSteadyMs();
        if (!lastComplaintMs || now - lastComplaintMs > 60000) {
            lastComplaintMs = now;
            char hex[16];
            snprintf(hex, sizeof(hex), "0x%08lX", (unsigned long)hr);
            LogWarn(std::string("UIAutomation unavailable (hr=") + hex + ") - the message "
                    "box cannot be read, so typed messages are NOT being inspected. "
                    "Retrying on every send.");
        }
    }
    return false;
}

void WorkerThread() {
    // MTA: UI Automation is called from here and nowhere else on this thread.
    HRESULT hrCom = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comOk = SUCCEEDED(hrCom);

    if (!comOk) {
        LogWarn("COM could not be initialised on the inspection thread - typed "
                "messages cannot be inspected on this agent run");
    }

    IUIAutomation* uia = nullptr;
    long long uiaComplainedAt = 0;
    if (comOk) EnsureUia(uia, uiaComplainedAt);

    std::map<std::string, long long> lastProbeAt;

    while (!g_stop.load()) {
        HWND  wnd   = nullptr;
        DWORD pid   = 0;
        bool  ctrl  = false;
        bool  audit = false;
        std::string exe;
        std::vector<std::string> types;
        {
            std::unique_lock<std::mutex> lk(g_mx);
            g_cv.wait_for(lk, std::chrono::milliseconds(200),
                          [] { return g_pendingWork || g_stop.load(); });
            if (g_stop.load()) break;
        }
        {
            std::string probeExe;
            bool probeManaged = false, probeInspect = false, probeBlock = false;
            {
                std::lock_guard<std::mutex> lk(g_probeMx);
                if (g_probeReady) {
                    probeExe     = g_probeExe;
                    probeManaged = g_probeManaged;
                    probeInspect = g_probeInspect;
                    probeBlock   = g_probeBlock;
                    g_probeReady = false;
                }
            }
            // Per-app, so testing one app never silences the next. Held in the
            // worker because the hook must not own a container it might grow.
            if (!probeExe.empty()) {
                const long long now = NowSteadyMs();
                auto it = lastProbeAt.find(probeExe);
                if (it == lastProbeAt.end() || now - it->second > 30000) {
                    lastProbeAt[probeExe] = now;
                    if (probeExe == "(unknown)") {
                        LogInfo("send key pressed, but the foreground window could not be "
                                "attributed to a process - nothing to inspect");
                    } else if (!probeManaged) {
                        LogInfo("send key pressed in " + probeExe +
                                " - NOT in the policy's managed app list, so it is being ignored. "
                                "If this is the app you meant, add " + probeExe + " to it.");
                    } else if (!probeInspect) {
                        LogInfo("send key pressed in " + probeExe +
                                " - it IS a managed app, but typed-message inspection is off "
                                "for it (tick \"Also inspect typed messages\" on the policy)");
                    } else {
                        LogInfo("send key pressed in " + probeExe + " - managed, inspecting (" +
                                std::string(probeBlock ? "block" : "alert") + " mode)");
                    }
                }
            }
        }
        {
            std::unique_lock<std::mutex> lk(g_mx);
            if (!g_pendingWork) continue;
            wnd   = g_pendingWnd;
            pid   = g_pendingPid;
            exe   = g_pendingExe;
            ctrl  = g_pendingCtrl;
            audit = g_pendingAudit;
            types = g_pendingTypes;
            g_pendingWork = false;
        }

        try {
            const bool haveUia = comOk && EnsureUia(uia, uiaComplainedAt);
            if (!haveUia) {
                // This used to release the keystroke unread, because UI
                // Automation was the only way to learn what was in the box.
                // It no longer is: the typed-text buffer needs none of it, so
                // the send is still adjudicated - on what the user typed, just
                // not cross-checked against what the box actually holds.
                LogWarn("UI Automation unavailable for " + exe + " - judging this send "
                        "on typed text alone");
            }
            if (audit) AuditAndAct(haveUia ? uia : nullptr, wnd, pid, types, exe);
            else       DecideAndAct(haveUia ? uia : nullptr, wnd, pid, ctrl, types, exe);
        } catch (...) {
            LogWarn("decision threw - releasing keystroke");
            if (!audit) { try { ResolveRelease(ctrl); } catch (...) {} }
        }
    }

    if (uia) uia->Release();
    if (comOk) CoUninitialize();
}

// Report a timer-driven thread that has stopped ticking.
//
// Sixty seconds: the slowest of these loops runs on a multi-second cadence and
// can block briefly in UI Automation, so anything under that would cry wolf.
// Logged once per death - it is a permanent condition until restart, and
// repeating it four times a second would bury the line that matters.
void CheckThreadHealth() {
    static long long lastCheckMs = 0;
    static bool reported[3] = { false, false, false };

    const long long now = NowSteadyMs();
    if (now - lastCheckMs < 10000) return;
    lastCheckMs = now;

    struct { const char* name; std::atomic<long long>* beat; } t[3] = {
        { "locator",  &g_beatLocator  },
        { "sampler",  &g_beatSampler  },
        { "watchdog", &g_beatWatchdog },
    };
    for (int i = 0; i < 3; ++i) {
        const long long b = t[i].beat->load();
        if (!b) continue;                       // never started ticking yet
        const long long silent = now - b;
        if (silent > 60000) {
            if (!reported[i]) {
                reported[i] = true;
                LogWarn(std::string("the ") + t[i].name + " thread has not ticked for " +
                        std::to_string(silent / 1000) + "s - it has died. Messaging "
                        "inspection is degraded or off until the agent is restarted. "
                        "This is the cause of 'blocking worked and then stopped'.");
            }
        } else {
            reported[i] = false;
        }
    }
}

// ── Is the hook still there? ──────────────────────────────────────────────
//
// There is no API that answers "is my hook still installed" — SetWindowsHookEx
// hands back a handle and Windows never revokes it, even when it has stopped
// calling us. So we infer it. GetLastInputInfo reports when the OS last saw
// any input at all; if Windows has been receiving keystrokes and mouse moves
// this whole time and our two callbacks have not run once, there is only one
// explanation left, and it is not that the user went quiet.
void CheckHookHealth() {
    static long long lastCheckMs  = 0;
    static long long lastRehookMs = -1;

    const long long now = NowSteadyMs();
    if (lastRehookMs < 0) lastRehookMs = now;
    if (now - lastCheckMs < 5000) return;
    lastCheckMs = now;
    if (!g_hookThread) return;

    LASTINPUTINFO lii{};
    lii.cbSize = sizeof(lii);
    if (!GetLastInputInfo(&lii)) return;
    const DWORD systemIdleMs = GetTickCount() - lii.dwTime;   // wraps correctly

    const long long ours = (std::max)(g_lastKeyHookMs.load(), g_lastMouseHookMs.load());
    const long long silentMs = ours ? (now - ours) : 0;

    if (ours && systemIdleMs < 5000 && silentMs > 20000 &&
        now - lastRehookMs > 30000) {
        lastRehookMs = now;
        LogWarn("input hooks have seen nothing for " + std::to_string(silentMs / 1000) +
                "s while Windows was still receiving input - the OS has silently dropped "
                "them (a hook callback overran LowLevelHooksTimeout). Typed-message "
                "blocking has been OFF for that long. Reinstalling now.");
        PostThreadMessage(g_hookThread, WM_REHOOK, 0, 0);
        return;
    }

    // Belt and braces. The test above weighs BOTH hooks against system input,
    // so it cannot see the case where the keyboard hook alone was dropped and
    // ordinary mouse movement keeps the timestamp looking healthy. Nothing can
    // detect that from in here, so the remedy is to reinstall on a slow timer
    // whether or not anything looks wrong: two syscalls, no user-visible
    // effect, and it bounds the damage of any dropped hook to ten minutes
    // instead of until the next agent restart. Never mid-adjudication.
    if (now - lastRehookMs > 600000 && !g_decisionPending.load()) {
        lastRehookMs = now;
        LogDbg("periodic input-hook reinstall (guards a silently dropped hook)");
        PostThreadMessage(g_hookThread, WM_REHOOK, 0, 0);
    }
}

// ── Watchdog ──────────────────────────────────────────────────────────────
// The worker cannot time itself out: when UI Automation wedges, the worker is
// inside that call. Somebody outside it has to give the keystroke back.
void WatchdogThread() {
    while (!g_stop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        // Everything below is inside try/catch. This thread owns
        // CheckHookHealth, which is what reinstalls an input hook the OS has
        // silently dropped - so of all the threads here it is the one that must
        // not be allowed to die on an exception. Losing it turns a recoverable
        // 20-second outage into blocking being off until the agent restarts.
        try {
        g_beatWatchdog.store(NowSteadyMs());
        CheckThreadHealth();
        CheckHookHealth();
        if (g_decisionResolved.load()) continue;
        const long long started = g_holdStartMs.load();
        if (!started) continue;
        const long long heldFor = NowSteadyMs() - started;
        if (heldFor < (long long)g_cfg.decisionTimeoutMs) continue;

        // The normal budget is sized for reading a text box, not for OCR-ing a
        // screenshot. Releasing here is exactly what let a picture go out
        // uninspected while its inspection was still running.
        if (StagedInspectionInFlight(0) && heldFor < (long long)kAttachmentHoldMs) {
            g_holdForAttachment.store(true);
            continue;
        }

        const bool ctrl = g_holdCtrl.load();
        const bool wasAttachment = g_holdForAttachment.exchange(false);
        if (ClaimDecision()) {
            if (wasAttachment) {
                // Fail closed: a file nobody finished reading has not been shown
                // to be safe. The keystroke is dropped, not replayed.
                g_decisionPending.store(false);
                LogWarn("attachment inspection exceeded " +
                        std::to_string(kAttachmentHoldMs) +
                        "ms - keystroke BLOCKED uninspected (fail closed)");
                DWORD fpid = 0;
                GetWindowThreadProcessId(GetForegroundWindow(), &fpid);
                ShowBlockedNotice(ProcessExeName(fpid),
                                  "an attachment that could not be inspected in time");
            } else {
                ReleaseKeystroke(ctrl);
                g_decisionPending.store(false);
                LogWarn("inspection exceeded " + std::to_string(g_cfg.decisionTimeoutMs) +
                        "ms - keystroke released UNINSPECTED (the message was sent)");
            }
        }
        } catch (...) {
            // Never fatal here. A thrown decision is one lost keystroke; a dead
            // watchdog is every subsequent one.
            LogWarn("watchdog iteration threw - continuing");
        }
    }
}

// ── Locating things ────────────────────────────────────────────────
// Every tree walk in this file happens on the locator thread and nowhere else.
//
// FindAll(TreeScope_Descendants) over a Chromium document is the seven-second
// call this whole design exists to avoid, and the deadline argument does not
// bound it: a deadline can only be tested between results, so it limits the
// loop AFTER FindAll has returned and never FindAll itself. Running one on the
// sampler thread therefore stops the 250ms text sample for as long as the walk
// takes.
//
// That is how hunting for the Send button made things worse than before it
// existed: a walk every five seconds starved the snapshot that the Enter path
// reads, so Enter stopped blocking at all - and in an app that does not name
// its button "Send" the walk never succeeds, so the starvation is permanent
// and Enter never recovers. Splitting the threads is the fix; the sampler now
// does nothing but property reads, which is what made it fast in the first
// place.

void PublishComposer(IUIAutomationElement* el, DWORD pid) {
    IUIAutomationElement* old = nullptr;
    {
        std::lock_guard<std::mutex> lk(g_locMx);
        old = g_locComposer;
        if (el) el->AddRef();
        g_locComposer = el; g_locComposerPid = pid;
    }
    if (old) old->Release();   // outside the lock: Release can re-enter COM
}

void PublishSendBtn(IUIAutomationElement* el, DWORD pid) {
    IUIAutomationElement* old = nullptr;
    {
        std::lock_guard<std::mutex> lk(g_locMx);
        old = g_locSendBtn;
        if (el) el->AddRef();
        g_locSendBtn = el; g_locSendBtnPid = pid;
    }
    // Deliberately does NOT clear the published rectangle.
    //
    // 1.4.10 cleared it here, and that turned out to discard a rectangle that was
    // still exactly right: WhatsApp rebuilds its composer mid-conversation, this
    // is called with nullptr to re-acquire, and a click on the Send button 800ms
    // later was then refused as "no Send button has been located" - on a button
    // that had not moved a pixel. It also defeated the window-unchanged rule
    // added in the same release, by deleting the very data that rule reads.
    //
    // Losing the ELEMENT is not losing the BUTTON. The two cases that really
    // invalidate a rectangle are handled where they belong: focus leaving a
    // managed app clears it explicitly in the locator, and a window that has
    // moved is caught by the hook's GetWindowRect comparison.
    if (old) old->Release();
}

IUIAutomationElement* AcquireComposer(DWORD& pidOut) {
    std::lock_guard<std::mutex> lk(g_locMx);
    pidOut = g_locComposerPid;
    if (g_locComposer) g_locComposer->AddRef();
    return g_locComposer;
}

IUIAutomationElement* AcquireSendBtn(DWORD& pidOut) {
    std::lock_guard<std::mutex> lk(g_locMx);
    pidOut = g_locSendBtnPid;
    if (g_locSendBtn) g_locSendBtn->AddRef();
    return g_locSendBtn;
}

// ── Locator ───────────────────────────────────────────────────────
// Nothing on any critical path waits for this thread, so it is allowed to be
// slow. It publishes what it finds and the sampler reads through it.
void LocatorThread() {
    HRESULT hrCom = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comOk = SUCCEEDED(hrCom);

    IUIAutomation* uia = nullptr;
    long long uiaComplainedAt = 0;

    IUIAutomationElement* composer = nullptr;
    DWORD     composerPid      = 0;
    // The window the composer was actually found in, which in a browser-hosted
    // app is a child of the foreground window rather than the window itself.
    // Kept so the Send button search starts where the UI demonstrably is.
    HWND      contentRoot      = nullptr;
    long long lastFindMs       = 0;
    long long findComplainedAt = 0;

    IUIAutomationElement* sendBtn  = nullptr;
    DWORD     sendPid          = 0;
    long long lastSendFindMs   = 0;
    unsigned  sendMisses       = 0;
    bool      hadText          = false;
    // The window geometry everything below was located against. A resize moves
    // every control in the app, and a cached element that has died then hands
    // back its OLD rectangle - which is how the positional search came to lock
    // onto a 40x40 control at the TOP of the window and publish it as Send, while
    // the real button sat at the bottom right. Nothing downstream can tell a
    // stale rectangle from a current one, so the layout change has to be caught
    // here, where the elements are owned.
    RECT      locatedWndRect     = {0, 0, 0, 0};
    HWND      locatedWnd         = nullptr;

    while (!g_stop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        g_beatLocator.store(NowSteadyMs());
        if (g_stop.load()) break;
        if (!comOk) continue;

        try {
            TargetApp t = ResolveForegroundApp();
            if (t.exe.empty() || !g_cfg.messagingPolicy) continue;

            // Our own block dialog is MB_SETFOREGROUND | MB_SYSTEMMODAL, so the
            // instant we enforce, WE become the foreground window. The branch
            // below then read that as "the user left the managed app" and tore
            // down the composer, the Send button and the click rectangle.
            //
            // Every successful block therefore DISARMED the mouse path, which
            // re-armed only once the app regained focus and both threads had
            // ticked again. A click inside that window went through unexamined
            // and in complete silence - the hook simply returns.
            //
            // Enter never showed it, because that path classifies at send time
            // and depends on none of this precomputed state. Which is exactly
            // the shape of "Enter always blocks, the mouse blocks sometimes" on
            // a binary that did not change between the two.
            //
            // Our own window is not a focus change. Leave everything standing.
            if (t.pid == GetCurrentProcessId()) continue;

            const NetworkExfilMonitor::MessagingVerdict mv = VerdictForTarget(t);

            // Focus left everything we care about. Drop what we hold so the
            // sampler stops reading a box nobody is typing into, and so the
            // mouse hook stops recognising a rectangle that has moved on.
            if (!mv.managed || !mv.inspectMessages) {
                if (composer) {
                    PublishComposer(nullptr, 0);
                    composer->Release(); composer = nullptr; composerPid = 0;
                }
                contentRoot = nullptr;
                if (sendBtn) {
                    PublishSendBtn(nullptr, 0);
                    sendBtn->Release(); sendBtn = nullptr; sendPid = 0;
                    std::lock_guard<std::mutex> lk(g_sendMx);
                    g_sendPid = 0; g_sendAtMs = 0;
                    g_sendWnd = nullptr; g_sendWndRect = RECT{0, 0, 0, 0};
                }
                lastSendFindMs = 0; sendMisses = 0; hadText = false;
                g_hoverSaidSo.store(false);
                g_besideSaidSo.store(false);
                g_cornerSaidSo.store(false);
                continue;
            }

            // Acquired here rather than at thread start, and quietly: the
            // worker complains at the moment it matters - a real send.
            if (!EnsureUia(uia, uiaComplainedAt, false)) continue;

            // The sampler found its element dead. Re-acquire now rather than
            // waiting out the rate limit.
            if (g_refindComposer.exchange(false) && composer) {
                PublishComposer(nullptr, 0);
                composer->Release(); composer = nullptr; composerPid = 0;
                contentRoot = nullptr;
                lastFindMs = 0;
            }

            // Focus moved to another instance of a managed app.
            if (composer && t.pid != composerPid) {
                PublishComposer(nullptr, 0);
                composer->Release(); composer = nullptr; composerPid = 0;
                contentRoot = nullptr;
            }
            // Layout changed under us: drop every cached element and the published
            // rectangle, and re-find from scratch. Cheaper than reasoning about which
            // of them survived, and the only answer that cannot be subtly wrong.
            {
                RECT wr{};
                const bool haveWr = t.wnd && GetWindowRect(t.wnd, &wr);
                const bool moved  = haveWr && locatedWnd == t.wnd &&
                                    (wr.left != locatedWndRect.left || wr.top != locatedWndRect.top ||
                                     wr.right != locatedWndRect.right || wr.bottom != locatedWndRect.bottom);
                if (moved) {
                    LogInfo("the " + t.exe + " window was moved or resized - dropping the "
                            "located controls and re-finding (every rectangle just changed)");
                    if (composer) { PublishComposer(nullptr, 0); composer->Release(); composer = nullptr; composerPid = 0; }
                    contentRoot = nullptr;
                    if (sendBtn) { PublishSendBtn(nullptr, 0); sendBtn->Release(); sendBtn = nullptr; sendPid = 0; }
                    {
                        std::lock_guard<std::mutex> lk(g_sendMx);
                        g_sendRect = RECT{0, 0, 0, 0};
                        g_sendPid = 0; g_sendAtMs = 0;
                        g_sendWnd = nullptr; g_sendWndRect = RECT{0, 0, 0, 0};
                    }
                    lastSendFindMs = 0; sendMisses = 0;
                    g_hoverSaidSo.store(false); g_besideSaidSo.store(false); g_cornerSaidSo.store(false);
                }
                if (haveWr) { locatedWnd = t.wnd; locatedWndRect = wr; }
            }
            if (sendBtn && (t.pid != sendPid || !ElementAlive(sendBtn))) {
                PublishSendBtn(nullptr, 0);
                sendBtn->Release(); sendBtn = nullptr; sendPid = 0;
                lastSendFindMs = 0; sendMisses = 0;
            }

            if (!composer) {
                const long long now = NowSteadyMs();
                if (!lastFindMs || now - lastFindMs >= 3000) {
                    lastFindMs = now;
                    int seen = 0;
                    // Ask the app's embedded browser to build its accessibility
                    // tree BEFORE looking for anything in it. Chromium keeps it
                    // switched off until a client asks, and a search that runs
                    // before the ask finds nothing however long it is given.
                    NudgeAccessibility(t.wnd);
                    HWND usedRoot = t.wnd;
                    composer = FindComposerElement(uia, t.wnd, t.pid, now + 8000,
                                                   seen, &usedRoot);
                    if (composer) {
                        composerPid = t.pid;
                        contentRoot = usedRoot;
                        PublishComposer(composer, t.pid);
                        LogInfo("locator locked onto the composer in " + t.exe + " after " +
                                std::to_string(NowSteadyMs() - now) + "ms" +
                                (usedRoot != t.wnd
                                     ? " (inside an embedded browser window)" : ""));
                    } else if (!findComplainedAt || now - findComplainedAt > 60000) {
                        findComplainedAt = now;
                        // The root count matters: "0 editable nodes across 1
                        // root" is an app we never looked inside, and "across 6"
                        // is one we looked inside and genuinely cannot read.
                        LogWarn("locator cannot find a composer in " + t.exe + " (" +
                                std::to_string(seen) + " editable node(s) seen across " +
                                std::to_string(ContentRoots(t.wnd).size()) +
                                " window root(s) in " +
                                std::to_string(NowSteadyMs() - now) + "ms) - typed "
                                "messages in this app cannot be inspected");
                    }
                }
            }

            // ── Covering the Send button ─────────────────────────
            //
            // Enter is the feature; the button is what a user reaches for the
            // moment Enter stops working, so leaving it uncovered defeats the
            // control on the second attempt.
            //
            // Both searches are driven by there being something in the box,
            // not by a timer. On WhatsApp the control only becomes Send once
            // you type - before that it is a microphone - so searching an empty
            // window was guaranteed to miss, and the miss backed the search off
            // to once every 160 seconds. That is why clicking Send was never
            // blocked: by the time there was a message to send, the agent had
            // stopped looking.
            const bool typing = g_composerHasText.load();
            if (mv.block && typing) {
                // A new message deserves a fresh attempt, whatever the last one
                // cost. Without this the backoff outlives the reason for it.
                if (!hadText) { lastSendFindMs = 0; sendMisses = 0; }

                RECT cr{};
                // ElementAlive first. A dead element still answers ElementRect, with the
                // rectangle it had when it died - and "beside the message box" computed from
                // a message box that has moved is how a control at the top of the window got
                // published as Send.
                RECT cr2{};
                const bool haveCr = composer && ElementAlive(composer) && ElementRect(composer, cr2) &&
                                    cr2.right > cr2.left && cr2.bottom > cr2.top &&
                                    RectInsideWindow(cr2, t.wnd);
                if (haveCr) cr = cr2;

                // Cheap, every pass, and independent of the cached element.
                if (!sendBtn) {
                    if (ProbeHoveredSendControl(uia, t, haveCr ? &cr : nullptr)) {
                        if (!g_hoverSaidSo.exchange(true)) {
                            LogInfo("locator recognised the control under the pointer in " +
                                    t.exe + " as Send - a click on it is now inspected");
                        }
                    // The pointer is somewhere else, or has not arrived yet. Ask where the
                    // button has to be anyway - otherwise the first send of every session goes
                    // out uninspected, which is what the endpoint log showed.
                    } else if (ProbeSendBesideComposer(uia, t, haveCr ? &cr : nullptr)) {
                        if (!g_besideSaidSo.exchange(true)) {
                            LogInfo("locator found the Send control beside the message box in " +
                                    t.exe + " - a click on it is inspected without hovering first");
                        }
                    // Still nothing - and the composer may simply not be locked onto yet, which
                    // on WhatsApp took 4055ms while the user dropped a file and clicked Send
                    // inside 2.5s. Needs no composer rectangle; name-verified only.
                    } else if (ProbeSendInWindowCorner(uia, t)) {
                        if (!g_cornerSaidSo.exchange(true)) {
                            LogInfo("locator recognised a named Send control in " + t.exe +
                                    " from the window corner, before the message box was located");
                        }
                    }
                }

                if (!sendBtn) {
                    const long long now  = NowSteadyMs();
                    const long long wait = 3000LL << (sendMisses < 4 ? sendMisses : 4);
                    if (!lastSendFindMs || now - lastSendFindMs >= wait) {
                        lastSendFindMs = now;
                        bool viaPos = false;
                        sendBtn = FindSendButton(uia, contentRoot ? contentRoot : t.wnd,
                                                 t.pid, 0,
                                                 haveCr ? &cr : nullptr, &viaPos);
                        if (sendBtn) {
                            sendPid = t.pid; sendMisses = 0;
                            PublishSendBtn(sendBtn, t.pid);
                            LogInfo(std::string("locator located the Send button in ") +
                                    t.exe + (viaPos ? " by position (beside the message box)"
                                                    : " by name"));
                        } else {
                            if (sendMisses == 0) {
                                LogInfo("locator found no Send button in " + t.exe +
                                        " - by name or beside the message box. Enter is "
                                        "still inspected; a click is inspected only while "
                                        "the pointer rests on the control first");
                            }
                            if (sendMisses < 4) ++sendMisses;
                        }
                    }
                }
            }
            hadText = typing;
        } catch (...) {}
    }

    PublishComposer(nullptr, 0);
    PublishSendBtn(nullptr, 0);
    if (composer) composer->Release();
    if (sendBtn)  sendBtn->Release();
    if (uia) uia->Release();
    if (comOk) CoUninitialize();
}

// ── Sampler ───────────────────────────────────────────────────────
// Keeps the last thing seen in the composer of a managed app, and the verdict
// on it, so that neither the Enter path nor the mouse hook has to ask a slow
// question at the moment it is least able to wait for the answer.
//
// Everything here is a property read on an element somebody else located. That
// is the whole contract of this thread, and the reason it can run four times a
// second: the moment a tree walk creeps back in, the snapshot goes stale and
// both blocking paths quietly stop working.
void SamplerThread() {
    HRESULT hrCom = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comOk = SUCCEEDED(hrCom);

    IUIAutomation* uia = nullptr;
    long long uiaComplainedAt = 0;

    std::string lastClassified;
    bool        lastSensitive = false;
    std::string lastWhat;
    NetworkExfilMonitor::ClassifyResult lastCls;

    const unsigned interval = g_cfg.sampleIntervalMs ? g_cfg.sampleIntervalMs : 250;
    while (!g_stop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(interval));
        g_beatSampler.store(NowSteadyMs());
        // Report the last click that was not inspected, once per occurrence.
        if (const int gate = g_clickGate.exchange(CLICK_NONE)) {
            const int x = g_clickX.load(), y = g_clickY.load();
            const int l = g_clickRL.load(), t_ = g_clickRT.load();
            const int r = g_clickRR.load(), b = g_clickRB.load();
            const long long age = g_clickAgeMs.load();
            switch (gate) {
                case CLICK_NO_BUTTON:
                    LogWarn("click at (" + std::to_string(x) + "," + std::to_string(y) +
                            ") NOT inspected: no Send button has been located in this app. "
                            "Enter is still inspected. Hover over Send for a moment before "
                            "clicking and it will be recognised.");
                    break;
                case CLICK_STALE:
                    LogWarn("click at (" + std::to_string(x) + "," + std::to_string(y) +
                            ") NOT inspected: the Send button rectangle is " +
                            std::to_string(age) + "ms old (limit 3000ms) - the sampler has "
                            "not re-measured it recently enough.");
                    break;
                case CLICK_OUTSIDE:
                    LogInfo("click at (" + std::to_string(x) + "," + std::to_string(y) +
                            ") is outside the Send button rect [" + std::to_string(l) + "," +
                            std::to_string(t_) + " " + std::to_string(r) + "," +
                            std::to_string(b) + "] - not a send");
                    break;
                case CLICK_INSPECTED:
                    LogDbg("click landed on the Send button and was inspected");
                    break;
                default: break;
            }
        }
        // Checked from here as well as the watchdog, so that a dead WATCHDOG is
        // still reported by something.
        CheckThreadHealth();
        if (g_stop.load()) break;
        if (!comOk) continue;

        try {
            TargetApp t = ResolveForegroundApp();
            if (t.exe.empty() || !g_cfg.messagingPolicy) {
                g_managedWnd.store(nullptr, std::memory_order_relaxed);
                continue;
            }

            // See the locator: our own block dialog takes the foreground, and
            // treating that as a focus change is what disarmed the mouse path
            // after every block it performed.
            if (t.pid == GetCurrentProcessId()) continue;

            const NetworkExfilMonitor::MessagingVerdict mv = VerdictForTarget(t);
            // Block mode used to be excluded here, on the reasoning that it
            // reads at send time and did not want a sampler second-guessing it.
            // That reasoning was backwards: block mode is the one mode that
            // reads while holding the user's keystroke, so it is the mode that
            // can least afford to ask a slow question. It now decides on what
            // this thread saw a moment earlier - see DecideAndAct.
            if (!mv.managed || !mv.inspectMessages) {
                g_composerHasText.store(false);
                g_managedWnd.store(nullptr, std::memory_order_relaxed);
                continue;
            }

            // Published BEFORE the UI Automation check below, deliberately. The
            // typed-text buffer is the path that has to keep working on a
            // machine where UI Automation does not, so it cannot be gated on
            // acquiring it.
            g_managedWnd.store(t.wnd, std::memory_order_relaxed);
            if (g_pasteSeen.exchange(false, std::memory_order_relaxed))
                AppendClipboardText(t.wnd);

            if (!EnsureUia(uia, uiaComplainedAt, false)) continue;

            // ── Keep the Send button's rectangle current ─────────────────────────
            // Hoisted to the TOP of this loop. It used to sit at the bottom, below the
            // composer read and the classification - and this file already documents
            // that read taking seven seconds on a Chromium app. The loop ticks every
            // 250ms, but the rectangle was only re-measured once the slow work above it
            // finished, so a real click on Send was refused for being 3426ms old against
            // a 3000ms limit. Measuring first costs one property read and is not behind
            // anything that can stall.
            {
                DWORD spid = 0;
                IUIAutomationElement* btn = AcquireSendBtn(spid);
                if (btn) {
                    RECT r{};
                    if (spid == t.pid && ElementRect(btn, r) &&
                        r.right > r.left && r.bottom > r.top &&
                        ElementAlive(btn) && RectInsideWindow(r, t.wnd)) {
                        // The window is recorded with it, so the hook can ask whether
                        // the button can have moved rather than guessing from a clock.
                        RECT wr{};
                        const bool haveWr = t.wnd && GetWindowRect(t.wnd, &wr);
                        std::lock_guard<std::mutex> lk(g_sendMx);
                        g_sendRect = r; g_sendPid = spid; g_sendAtMs = NowSteadyMs();
                        g_sendWnd = haveWr ? t.wnd : nullptr;
                        g_sendWndRect = haveWr ? wr : RECT{0, 0, 0, 0};
                    }
                    btn->Release();
                }
            }

            // Who the message is going to. Refreshed every few seconds rather
            // than every pass - the user switching chat is a human-speed event,
            // and this costs a few hit tests. Cached because EmitEvent has no
            // UI Automation instance of its own.
            //
            // Skipped entirely while the answer is already known, so the usual
            // cost of this is a mutex and a comparison. Only a window whose
            // conversation we cannot name pays anything, and then rarely: this
            // is a label on an event, and it must never be why a message is
            // slow to send.
            if (!HaveConversationFor(t.wnd)) {
                const long long now  = NowSteadyMs();
                const long long last = g_convProbedMs.load(std::memory_order_relaxed);
                if (!last || now - last > 15000) {
                    g_convProbedMs.store(now, std::memory_order_relaxed);
                    const std::string conv =
                        ProbeConversationName(uia, t.wnd, FriendlyAppName(ToLowerAscii(t.exe)));
                    if (!conv.empty()) {
                        std::lock_guard<std::mutex> lk(g_convMx);
                        g_convName = conv; g_convWnd = t.wnd; g_convAtMs = now;
                    }
                }
            }

            // One element, one or two property reads. This is what makes the
            // sample a quarter of a second old rather than seven seconds old.
            std::string text;
            bool  readableBox = false;
            DWORD cpid = 0;
            IUIAutomationElement* composer = AcquireComposer(cpid);
            if (composer) {
                if (cpid != t.pid) {
                    // Belongs to a window nobody is typing into now. The
                    // locator will notice and re-point us.
                } else if (ElementAlive(composer)) {
                    try { text = TrimText(TextFromElement(composer)); } catch (...) {}
                    readableBox = true;
                } else if (!g_refindComposer.exchange(true)) {
                    // Chromium rebuilds the composer's accessibility node after
                    // a send, and again after a modal takes focus - so the
                    // element located before the first blocked message is dead
                    // by the time of the second. Nothing used to notice: a dead
                    // element reads as "" exactly like an empty box does, the
                    // snapshot went permanently empty, and blocking worked
                    // exactly once per lock-on. Which is worse than never
                    // working, because it demonstrates the control and then
                    // silently stops enforcing it. Logged once per death, not
                    // four times a second until the re-find lands.
                    LogInfo("the composer in " + t.exe + " went stale (the app "
                            "rebuilt it) - re-acquiring");
                }
                composer->Release();
            }

            // If the cached element said nothing, ask what actually has focus
            // before believing the box is empty. Two property reads, no tree
            // walk, so it is affordable every cycle - and it is what covers the
            // gap between the composer being rebuilt and the re-find landing.
            if (text.empty()) {
                ComposerRead fr;
                try { fr = ReadFocusedOnly(uia, t.pid); } catch (...) {}
                if (fr.status == ReadStatus::Ok) text = TrimText(fr.text);
                else if (fr.status == ReadStatus::EmptyBox) readableBox = true;
            }

            // The box is readable AND empty: whatever was typed has gone, by
            // whatever route — sent, selected and deleted, or cleared by the app
            // itself. Keeping the buffer past that is how a stale card number
            // blocks the next, innocent message. Acted on ONLY when the box
            // could actually be read: "no composer" means unknown, not empty,
            // and on an app whose tree cannot be read the buffer is the only
            // source there is.
            if (readableBox && text.empty()) ClearTypedBuffer();

            // Where the app's tree cannot be read at all - WhatsApp's WebView2
            // composer being the case this module exists for - every read above
            // returns nothing and `text` stays empty no matter what is in the
            // box. The keystroke buffer is then the only account of it, and it
            // is already what the Enter path falls back to.
            //
            // Without the same fallback HERE the sampler stayed blind, and two
            // things followed that made the Send button unenforceable while
            // Enter worked perfectly:
            //
            //   * g_composerHasText stayed false, so the whole "look for the
            //     Send control" block in the locator was gated off. The agent
            //     never went looking for the button while there was a message
            //     worth blocking.
            //   * g_snapSensitive stayed false, so even a correctly located
            //     button would have been clicked straight through: the mouse
            //     hook cannot classify anything itself - it runs inside a
            //     low-level hook, where a classifier pass would blow
            //     LowLevelHooksTimeout and cost us the hook entirely - so it can
            //     only act on a verdict the sampler reached in advance.
            //
            // One asymmetry, two symptoms, and it read as "Enter is enforced,
            // the mouse is not".
            if (text.empty()) {
                const std::string typed = TypedTextFor(t.wnd);
                if (!typed.empty()) text = typed;
            }

            // What the locator uses to decide whether to look for the Send
            // control at all: it only exists, and only matters, while there is
            // something to send.
            //
            // A dropped picture counts. Sending one usually means typing
            // nothing at all, and keying this on the message box alone meant the
            // Send button was never located for exactly that case - so the mouse
            // hook had no rectangle, and a click on Send went through before any
            // of the drop handling was reached.
            // StagedRecently, not just HasPendingDrop. HasPendingDrop is true only once
            // classification has finished AND come back sensitive - so for a picture sent
            // with no caption this was false for the entire OCR, the locator never went
            // looking for the Send button, the mouse hook had no rectangle, and the click
            // returned long before the attachment hold was reached. Enter was unaffected
            // because KeyProc does not consult this flag at all, which is precisely why
            // Enter blocked pictures and the Send button did not.
            //
            // Five minutes matches the window PendingDropFor already allows for adding a
            // caption, so both halves of the same send agree on how long a staged file
            // stays interesting.
            g_composerHasText.store(!text.empty() || HasPendingDrop(t.pid, t.exe) ||
                                    StagedRecently(t.pid, 300000));

            // ── Pre-decide, so the mouse hook never has to ───────────────
            // Only when the text actually changed: this runs four times a
            // second and a classifier pass on every tick would be pure waste.
            if (text != lastClassified) {
                lastClassified = text;
                lastSensitive  = false;
                lastWhat.clear();
                lastCls = NetworkExfilMonitor::ClassifyResult{};
                if (!text.empty() && mv.block) {
                    try {
                        const NetworkExfilMonitor::ClassifyResult raw =
                            g_cfg.classify(text, "messaging_message");
                        const NetworkExfilMonitor::ClassifyResult cls =
                            RestrictToTypes(raw, mv.messageDataTypes);
                        if (IsSensitive(cls)) {
                            lastSensitive = true;
                            lastWhat      = DescribeLabels(cls);
                            lastCls       = cls;
                        }
                    } catch (...) {}
                }
            }


            std::lock_guard<std::mutex> lk(g_snapMx);
            // Stored even when empty. A sample that is never cleared would block
            // an innocent message on a card number sent five minutes ago.
            g_snapText      = text;
            g_snapPid       = t.pid;
            g_snapAtMs      = NowSteadyMs();
            g_snapSensitive = lastSensitive;
            g_snapWhat      = lastWhat;
            g_snapCls       = lastCls;
        } catch (...) {}
    }

    if (uia) uia->Release();
    if (comOk) CoUninitialize();
}

// ── The hook ──────────────────────────────────────────────────────────────

LRESULT CALLBACK KeyProc(int nCode, WPARAM wParam, LPARAM lParam) {
    // Proof of life, before any decision to return early. The watchdog reads
    // this to tell "nobody is typing" apart from "we are no longer hooked".
    g_lastKeyHookMs.store(NowSteadyMs(), std::memory_order_relaxed);

    if (nCode != HC_ACTION) return CallNextHookEx(g_hook, nCode, wParam, lParam);

    KBDLLHOOKSTRUCT* k = (KBDLLHOOKSTRUCT*)lParam;
    if (!k) return CallNextHookEx(g_hook, nCode, wParam, lParam);

    if (k->vkCode != VK_RETURN) {
        // Every key that is not the send key is what the message is MADE of,
        // and this callback is the only place in the process that sees it.
        // Injected input is skipped so our own Enter replay is never counted.
        if ((wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN) &&
            !(k->flags & LLKHF_INJECTED)) {
            RecordTypedKey(k->vkCode);
        }
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }
    // Our own replay. Must be first: everything below would otherwise re-hold it.
    if (k->flags & LLKHF_INJECTED) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    const bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool isUp   = (wParam == WM_KEYUP   || wParam == WM_SYSKEYUP);

    // Swallow the keyup belonging to a keydown we already took.
    if (isUp && g_decisionPending.load()) return 1;
    if (!isDown) return CallNextHookEx(g_hook, nCode, wParam, lParam);

    // Shift+Enter is "new line" in every one of these apps — never a send.
    if (GetAsyncKeyState(VK_SHIFT) & 0x8000) {
        RecordTypedKey(VK_RETURN);
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }
    // A second Enter must NOT reach the app while the first is being judged.
    //
    // This is what made the log and the screen disagree. The first Enter is
    // held for up to decisionTimeoutMs, and during that time the window looks
    // like it ignored you - so you press Enter again. Windows does it for you
    // anyway: key auto-repeat starts after ~500ms and then fires ~30 times a
    // second, so merely holding Enter a beat too long produced a second
    // keydown. Passing those through handed the send straight to the app while
    // the first keystroke was still under inspection. The inspection then
    // finished, dropped the keystroke IT owned, and wrote
    // MESSAGING_TEXT_BLOCKED - entirely true about that keystroke, entirely
    // wrong about what the user watched happen, because the message had
    // already gone out on the repeat.
    //
    // Swallowing them costs nothing: if the message turns out clean,
    // ResolveRelease replays exactly one Enter and the send still happens. The
    // only thing lost is a duplicate nobody meant to send.
    if (g_decisionPending.load()) {
        const long long held = NowSteadyMs() - g_holdStartMs.load();
        const long long cap  =
            (long long)(g_cfg.decisionTimeoutMs ? g_cfg.decisionTimeoutMs : 1200) * 3;
        if (held >= 0 && held < cap) return 1;      // still deciding - hold it too

        // The latch looks stuck: the watchdog clears it within one timeout, so
        // being three timeouts late means something is wedged. Fail open rather
        // than leave Enter permanently dead on this machine.
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    // mayWalk=false, and this is the whole reason the hook kept dying.
    //
    // VerdictForTarget falls back to walking the process tree whenever the
    // foreground app is NOT managed — which is most windows on the machine, and
    // every one of them arrives here, because a hook sees Enter everywhere and
    // not just in WhatsApp. That walk is CreateToolhelp32Snapshot over every
    // process on the system plus an OpenProcess per hop, and its cache is keyed
    // by pid and flushed wholesale at 64 entries, so misses keep coming. The
    // old comment here argued the walk was already cached and cost single-digit
    // milliseconds; that is true for the app you are testing and false for the
    // editor, terminal or browser you press Enter in a hundred times an hour.
    // One such snapshot overrunning 300ms is all it takes for Windows to remove
    // this hook for good, and it removes the mouse hook with it — they share
    // this thread. Enter blocking stops dead, mid-session, in silence. That is
    // the regression.
    //
    // A hook may do pointer chases and cache reads. It may not query the OS for
    // a list of anything. The sampler owns the walk now; here we read what it
    // cached and, on a miss, let the keystroke through.
    TargetApp t = ResolveForegroundApp();
    const NetworkExfilMonitor::MessagingVerdict mv =
        VerdictForTarget(t, /*mayWalk=*/false);

    // Publish the trace BEFORE any early return, for managed and unmanaged apps
    // alike. The previous version only traced apps the policy did not cover, so
    // "the hook is installed and nothing whatsoever happens when I press Enter"
    // had two indistinguishable causes — the app was not matched, or the hook
    // was never reaching this line at all — and no way to tell them apart.
    // Unresolvable foreground windows report as "(unknown)" rather than
    // returning in silence, because that is a diagnosis too.
    {
        std::lock_guard<std::mutex> lk(g_probeMx);
        g_probeExe     = t.exe.empty() ? std::string("(unknown)") : t.exe;
        g_probeManaged = mv.managed;
        g_probeInspect = mv.inspectMessages;
        g_probeBlock   = mv.block;
        g_probeReady   = true;
    }
    g_cv.notify_one();

    if (t.exe.empty()) return CallNextHookEx(g_hook, nCode, wParam, lParam);
    if (!mv.managed || !mv.inspectMessages) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    const bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;

    // ALERT: never touch input. Ask the worker to record what was sent and let
    // the keystroke through untouched.
    if (!mv.block) {
        {
            std::lock_guard<std::mutex> lk(g_mx);
            if (!g_pendingWork) {          // worker busy? drop this one, never queue
                g_pendingWnd   = t.wnd;
                g_pendingPid   = t.pid;
                g_pendingExe   = t.exe;
                g_pendingCtrl  = false;
                g_pendingAudit = true;
                g_pendingTypes = mv.messageDataTypes;
                g_pendingWork  = true;
            }
        }
        g_cv.notify_one();
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    // BLOCK: hold it. Order matters — the watchdog acts on g_decisionResolved,
    // so that flag is set last, once everything it will read is in place.
    {
        std::lock_guard<std::mutex> lk(g_mx);
        g_pendingWnd   = t.wnd;
        g_pendingPid   = t.pid;
        g_pendingExe   = t.exe;
        g_pendingCtrl  = ctrl;
        g_pendingAudit = false;
        g_pendingTypes = mv.messageDataTypes;
        g_pendingWork  = true;
    }
    g_holdCtrl.store(ctrl);
    g_holdStartMs.store(NowSteadyMs());
    g_decisionPending.store(true);
    g_decisionResolved.store(false);
    g_cv.notify_one();

    return 1;   // hold it; the worker or the watchdog resolves it
}

// ── The mouse hook ────────────────────────────────────────────────────────
//
// Enter was only ever half the story. In testing a message was blocked on
// Enter, and the very next thing the user did was click Send with the mouse —
// which went straight out, because nothing was watching the button. A control
// that a user defeats by accident on their second attempt is not a control.
//
// This hook does NOT hold the click the way KeyProc holds the keystroke. It
// cannot afford to: a low-level mouse hook sees every movement on the machine
// and Windows evicts one that dawdles. Everything expensive has therefore
// already happened on the sampler thread — the button's rectangle is measured
// and the text is classified up to four times a second — so all that is left
// here is an integer comparison and reading a bool.
//
// It fails open at every step: unknown rectangle, stale rectangle, wrong
// process, stale snapshot, or any doubt at all, and the click goes through.
// ── Deciding a held click ─────────────────────────────────────────────────
//
// Until 1.4.16 a click was inspected only if it landed inside a Send rectangle
// located AHEAD of time, and every way that rectangle could be missing or wrong
// ended the same way - the click went through. Never found; found 1.5s after
// the send; stale; taken from the old layout after a resize; lost again after
// a snap to half the screen; a different control entirely. Seven failures, one
// cause: the question was asked at the wrong time. Enter never had this
// problem, because it holds the keystroke and decides afterwards.
//
// Clicks now work the same way. When no trustworthy rectangle exists AND the
// app has something sensitive waiting to be sent AND the policy says block,
// the click is held and the question is asked about the one point that
// matters - the one the user clicked - off the hook thread. Send: blocked.
// Anything else: the click is replayed, costing the user only the time it took
// to ask. A rectangle located in advance is now a fast path, not a
// precondition.
//
// While nothing sensitive is waiting, nothing is held. An ordinary click is not
// touched at all.

enum class SendAt { Send, NotSend, Unknown };

// How long a held click may wait for the answer. The same question, asked by
// the hover probe every pass, comes back well inside this; reaching it means
// UI Automation is wedged, and the click is then treated as a send.
constexpr int kHeldClickBudgetMs = 2000;

// Is there a message box level with this rectangle and to its left? WhatsApp's
// Send control carries no usable name, so position beside the composer is the
// only way to recognise it - and the composer has to be found NOW, because the
// one the locator cached may have died with the last layout change. Three
// ways, cheapest first.
bool ComposerBesideRect(IUIAutomation* uia, const RECT& cand, HWND wnd) {
    auto accept = [&](IUIAutomationElement* e) {
        RECT er{};
        return e && ElementIsEditable(e) && ElementRect(e, er) &&
               er.right > er.left && er.bottom > er.top &&
               RectInsideWindow(er, wnd) && RectBesideComposer(cand, er);
    };

    // 1. Focus. The click that would have moved it is the one being held, so
    //    the box the user just typed into still has it.
    {
        IUIAutomationElement* f = nullptr;
        if (SUCCEEDED(uia->GetFocusedElement(&f)) && f) {
            const bool ok = accept(f);
            f->Release();
            if (ok) return true;
        }
    }
    // 2. The locator's cached composer, if it is still alive.
    {
        DWORD cpid = 0;
        IUIAutomationElement* c = AcquireComposer(cpid);
        if (c) {
            const bool ok = ElementAlive(c) && accept(c);
            c->Release();
            if (ok) return true;
        }
    }
    // 3. Look left of the candidate. Nearest points first: a message box's text
    //    is left-aligned, so the space just left of Send is usually empty box,
    //    and a hit test there returns the box itself rather than a run of text
    //    inside it. (No parent walk: IUIAutomationTreeWalker is missing from the
    //    headers this is verified against, and focus above is the primary test.)
    const LONG cy = cand.top + (cand.bottom - cand.top) / 2;
    static const LONG kDx[] = { 24, 60, 110, 170, 240 };
    for (const LONG dx : kDx) {
        IUIAutomationElement* hit = nullptr;
        if (FAILED(uia->ElementFromPoint(POINT{ cand.left - dx, cy }, &hit)) || !hit) continue;
        const bool ok = accept(hit);
        hit->Release();
        if (ok) return true;
    }
    return false;
}

// What is under this point: the Send control, something else, or no answer.
// Makes its own UI Automation instance - it runs on a worker thread that has no
// apartment - and creates it directly rather than through EnsureUia, which
// announces every acquisition in the log.
SendAt IdentifySendAt(POINT pt, HWND wnd, std::string* desc) {
    const bool comOk = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    IUIAutomation* uia = nullptr;
    CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                     IID_IUIAutomation, (void**)&uia);
    SendAt v = SendAt::Unknown;
    if (uia) {
        IUIAutomationElement* el = nullptr;
        if (SUCCEEDED(uia->ElementFromPoint(pt, &el)) && el) {
            v = SendAt::NotSend;
            if (desc) *desc = ElementDescription(el);
            RECT r{};
            const CONTROLTYPEID ct = ElementControlType(el);
            // Image as well as Button: for an icon button the hit test returns
            // the Image inside it.
            const bool clickable = (ct == kButtonControlTypeId || ct == kImageControlTypeId);
            if (clickable && ElementRect(el, r) && ButtonSized(r) && RectInsideWindow(r, wnd) &&
                (ElementSuggestsSend(el) || ComposerBesideRect(uia, r, wnd))) {
                v = SendAt::Send;
            }
            el->Release();
        }
        uia->Release();
    }
    if (comOk) CoUninitialize();
    return v;
}

// IdentifySendAt with a deadline. A UI Automation call into a Chromium
// renderer cannot itself be timed out, so it runs on its own thread and this
// waits for it; a call that never returns is abandoned, not waited on forever.
SendAt IdentifySendAtBounded(POINT pt, HWND wnd, int budgetMs, std::string* desc) {
    struct Box {
        std::mutex m; std::condition_variable cv;
        bool done = false; SendAt v = SendAt::Unknown; std::string d;
    };
    auto box = std::make_shared<Box>();
    std::thread([box, pt, wnd]() {
        std::string d;
        SendAt v = SendAt::Unknown;
        try { v = IdentifySendAt(pt, wnd, &d); } catch (...) {}
        {
            std::lock_guard<std::mutex> lk(box->m);
            box->v = v; box->d = d; box->done = true;
        }
        box->cv.notify_all();
    }).detach();
    std::unique_lock<std::mutex> lk(box->m);
    if (!box->cv.wait_for(lk, std::chrono::milliseconds(budgetMs), [&] { return box->done; }))
        return SendAt::Unknown;
    if (desc) *desc = box->d;
    return box->v;
}

// Is anything sensitive waiting to be sent in this app? Hook-safe: mutexes,
// atomics and a clock - the same work the hook already did before this existed.
bool SensitivePendingFor(DWORD pid) {
    {
        std::lock_guard<std::mutex> lk(g_snapMx);
        const long long age = g_snapAtMs ? (NowSteadyMs() - g_snapAtMs) : -1;
        if (g_snapPid == pid && g_snapSensitive && age >= 0 && age <= 15000) return true;
    }
    if (StagedInspectionInFlight(pid)) return true;
    return HasPendingDrop(pid, std::string());
}

// The held click's decision, off the hook thread. Every path resolves the
// click exactly once: blocked, or replayed.
void DecideHeldClick(POINT pt, DWORD pid, HWND wnd) {
    const std::string exe = ProcessExeName(pid);

    // An attachment still being read decides nothing yet. Wait for it on the
    // 1.4.9 ceiling, with the same fail-closed rule.
    if (StagedInspectionInFlight(pid) && !AwaitStagedInspection(kAttachmentHoldMs)) {
        LogWarn("held click in " + exe + ": attachment inspection exceeded " +
                std::to_string(kAttachmentHoldMs) + "ms - BLOCKED uninspected (fail closed)");
        ShowBlockedNotice(exe, "an attachment that could not be inspected in time");
        return;
    }

    // What is waiting, now that any inspection has finished.
    std::string what, text, via;
    NetworkExfilMonitor::ClassifyResult cls;
    bool fromDrop = false;
    {
        std::string dropPath;
        NetworkExfilMonitor::ClassifyResult dropCls;
        if (PendingDropFor(pid, exe, dropPath, dropCls)) {
            cls = dropCls; text = dropPath; what = DescribeLabels(dropCls);
            via = "held-click-staged-file"; fromDrop = true;
        }
    }
    if (!fromDrop) {
        std::lock_guard<std::mutex> lk(g_snapMx);
        const long long age = g_snapAtMs ? (NowSteadyMs() - g_snapAtMs) : -1;
        if (g_snapPid == pid && g_snapSensitive && age >= 0 && age <= 15000) {
            what = g_snapWhat; cls = g_snapCls; text = g_snapText; via = "held-click";
        }
    }
    if (via.empty()) {
        // Nothing sensitive after all - the inspection cleared it, or the box
        // was emptied while we asked. The click is the user's; give it back.
        ReleaseClick(pt);
        return;
    }

    // Something sensitive IS waiting. Was this click the send?
    std::string desc;
    const SendAt at = IdentifySendAtBounded(pt, wnd, kHeldClickBudgetMs, &desc);
    if (at == SendAt::NotSend) {
        LogInfo("held click at (" + std::to_string(pt.x) + "," + std::to_string(pt.y) +
                ") in " + exe + " released - not the Send control: " + desc);
        ReleaseClick(pt);
        return;
    }

    // Send - or UI Automation gave no answer in time. With sensitive content
    // waiting and the policy set to block, an unanswered question is not
    // permission. Fail closed, and say which of the two it was.
    const std::string severity =
        (ToLowerAscii(cls.category) == "restricted") ? "critical" : "high";
    try {
        EmitEvent(exe, pid, "BLOCK", severity, cls,
                  (fromDrop
                     ? "Blocked sensitive file staged in " + exe + " (" + cls.category +
                       ") - " + text
                     : "Blocked sensitive message in " + exe + " (" + cls.category +
                       ") - Send button click"),
                  text, "send_button", wnd);
    } catch (...) {}
    LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" + cls.category +
            " detected=[" + what + "] via=" + via +
            (at == SendAt::Unknown
                 ? " (the clicked control could not be identified within " +
                   std::to_string(kHeldClickBudgetMs) + "ms - failed closed)"
                 : std::string()));
    ShowBlockedNotice(exe, what.empty() ? std::string("a sensitive file") : what);
    if (fromDrop) ClearPendingDrop();
}

// Hook-side half of a held click: decide whether to hold it, and if so hand
// the decision to a worker. Cheapest test first and cached reads only - see
// KeyProc for why a hook may not do more. Most clicks leave at the first line.
bool HoldUnlocatedClick(POINT pt) {
    const HWND managed = g_managedWnd.load(std::memory_order_relaxed);
    if (!managed) return false;
    // The click has to land in the managed app's own window...
    const HWND under = WindowFromPoint(pt);
    if (!under || GetAncestor(under, GA_ROOT) != GetAncestor(managed, GA_ROOT)) return false;
    // ...something sensitive has to be waiting to be sent there...
    DWORD pid = 0;
    GetWindowThreadProcessId(managed, &pid);
    if (!pid || !SensitivePendingFor(pid)) return false;
    // ...and the policy has to say block. Alert mode never holds input.
    TargetApp t = ResolveForegroundApp();
    const NetworkExfilMonitor::MessagingVerdict mv = VerdictForTarget(t, /*mayWalk=*/false);
    if (!mv.managed || !mv.block) return false;

    g_swallowNextUp.store(true);
    std::thread(DecideHeldClick, pt, pid, managed).detach();
    return true;
}

LRESULT CALLBACK MouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    g_lastMouseHookMs.store(NowSteadyMs(), std::memory_order_relaxed);

    if (nCode != HC_ACTION) return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);

    if (wParam == WM_LBUTTONUP) {
        if (g_swallowNextUp.exchange(false)) {
            return 1;   // the down half was ours; its up half must not escape either
        }
        // A button-up over a managed chat, far from where the button went down,
        // is a drop. Nothing is done here beyond an atomic read and a compare:
        // the work happens on a thread, because a low-level hook that overruns
        // its timeout is removed by Windows without telling anyone.
        MSLLHOOKSTRUCT* mu = (MSLLHOOKSTRUCT*)lParam;
        const HWND managed = g_managedWnd.load(std::memory_order_relaxed);
        if (mu && !(mu->flags & LLMHF_INJECTED) && managed) {
            POINT down{}; long long downMs = 0; bool seen = false; HWND srcWnd = nullptr;
            {
                std::lock_guard<std::mutex> lk(g_dragMx);
                seen = g_dragDownSeen; down = g_dragDownPt; downMs = g_dragDownMs;
                srcWnd = g_dragDownWnd;
                g_dragDownSeen = false; g_dragDownWnd = nullptr;
            }
            const long long dx = (long long)mu->pt.x - down.x;
            const long long dy = (long long)mu->pt.y - down.y;
            const long long now = NowSteadyMs();
            if (seen && (dx * dx + dy * dy) > (40 * 40) &&
                downMs && now - downMs < 60000) {
                std::thread(ResolveDroppedFiles, srcWnd, managed).detach();
            }
        }
        return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
    }
    if (wParam != WM_LBUTTONDOWN) {
        return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
    }

    MSLLHOOKSTRUCT* m = (MSLLHOOKSTRUCT*)lParam;
    if (!m || (m->flags & LLMHF_INJECTED)) {
        return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
    }

    // Where a drag would have started, and on what. WindowFromPoint is a single
    // non-blocking user32 call and is the only way to learn this: after the drop
    // the same point belongs to the chat window.
    {
        const HWND under = WindowFromPoint(m->pt);
        std::lock_guard<std::mutex> lk(g_dragMx);
        g_dragDownPt = m->pt; g_dragDownMs = NowSteadyMs(); g_dragDownSeen = true;
        g_dragDownWnd = under;
    }

    DWORD pid = 0;
    int unlocatedWhy = CLICK_NONE;    // why this click is not on a known Send rectangle
    {
        std::lock_guard<std::mutex> lk(g_sendMx);
        const long long age = g_sendAtMs ? (NowSteadyMs() - g_sendAtMs) : -1;
        // A rectangle goes stale when the button MOVES - which happens when its
        // window moves or resizes - not when a clock runs out. A real click on Send
        // was refused for being 3426ms old against this 3000ms limit, on a rectangle
        // that was still exactly right. So: inside 3s trust it outright; beyond that,
        // trust it for as long as the window is precisely where it was when we
        // measured. GetWindowRect is a non-blocking user32 call, which is the only
        // kind this hook is allowed to make.
        bool fresh = g_sendPid && g_sendAtMs && age >= 0 && age <= 3000;
        if (!fresh && g_sendPid && g_sendAtMs && age >= 0 && age <= 30000 && g_sendWnd) {
            RECT nowRect{};
            if (GetWindowRect(g_sendWnd, &nowRect) &&
                nowRect.left   == g_sendWndRect.left  &&
                nowRect.top    == g_sendWndRect.top   &&
                nowRect.right  == g_sendWndRect.right &&
                nowRect.bottom == g_sendWndRect.bottom) {
                fresh = true;
            }
        }
        const bool inside = m->pt.x >= g_sendRect.left && m->pt.x < g_sendRect.right &&
                            m->pt.y >= g_sendRect.top  && m->pt.y < g_sendRect.bottom;
        if (!fresh || !inside) {
            // Not in a managed app at all: nothing to decide.
            if (!g_managedWnd.load(std::memory_order_relaxed)) {
                return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
            }
            // Record WHY, for the sampler to report. Only stores happen here.
            g_clickX.store((int)m->pt.x); g_clickY.store((int)m->pt.y);
            g_clickRL.store((int)g_sendRect.left); g_clickRT.store((int)g_sendRect.top);
            g_clickRR.store((int)g_sendRect.right); g_clickRB.store((int)g_sendRect.bottom);
            g_clickAgeMs.store(age);
            unlocatedWhy = !g_sendPid || !g_sendAtMs ? CLICK_NO_BUTTON
                         : (!fresh ? CLICK_STALE : CLICK_OUTSIDE);
        } else {
            g_clickGate.store(CLICK_INSPECTED);
            pid = g_sendPid;
        }
    }

    // No Send rectangle we can trust for this click. That used to be the end of
    // it: the click went through, and every way the rectangle could be missing
    // or wrong was a way to send sensitive content by mouse. Now, if something
    // sensitive is waiting and the policy blocks, the click is held and the
    // control under it is identified directly - see DecideHeldClick. Outside
    // those conditions this returns false at once and nothing changes.
    if (unlocatedWhy != CLICK_NONE) {
        if (HoldUnlocatedClick(m->pt)) return 1;
        g_clickGate.store(unlocatedWhy);
        return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
    }

    std::string what, text, via = "send-button-click";
    NetworkExfilMonitor::ClassifyResult cls;
    bool fromDrop = false;
    {
        // A file dropped into this chat is judged on its own, before the message
        // box is consulted: the box is usually empty when a picture is sent, and
        // whatever it holds says nothing about the picture attached to it.
        std::string dropPath;
        NetworkExfilMonitor::ClassifyResult dropCls;
        if (PendingDropFor(pid, ProcessExeName(pid), dropPath, dropCls)) {
            cls = dropCls; text = dropPath; what = DescribeLabels(dropCls);
            via = "dropped-file"; fromDrop = true;
        }
    }
    // An attachment staged in this app is still being inspected. Hold the click
    // until the verdict lands rather than letting the send race the OCR: this is
    // exactly the case where the picture went out and the block notice arrived
    // seconds later, about a message that had already been sent.
    if (!fromDrop && StagedInspectionInFlight(pid)) {
        const POINT pt = m->pt;
        g_swallowNextUp.store(true);
        std::thread([pid, pt]() {
            const bool finished = AwaitStagedInspection(kAttachmentHoldMs);
            const std::string exe = ProcessExeName(pid);
    
            std::string dropPath;
            NetworkExfilMonitor::ClassifyResult dropCls;
            if (PendingDropFor(pid, exe, dropPath, dropCls)) {
                const std::string what = DescribeLabels(dropCls);
                const std::string severity =
                    (ToLowerAscii(dropCls.category) == "restricted") ? "critical" : "high";
                try {
                    EmitEvent(exe, pid, "BLOCK", severity, dropCls,
                              "Blocked sensitive file staged in " + exe + " (" +
                              dropCls.category + ") - " + dropPath, dropPath,
                              "send_button", GetForegroundWindow());
                } catch (...) {}
                LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" +
                        dropCls.category + " detected=[" + what +
                        "] via=staged-file-held-click path=" + dropPath);
                ShowBlockedNotice(exe, what.empty() ? std::string("a sensitive file") : what);
                ClearPendingDrop();
                return;                 // the send stays swallowed
            }
    
            if (!finished) {
                // Fail closed. An attachment nobody managed to finish reading has
                // not been shown to be safe, and releasing it here would be the
                // same silent leak this hold exists to close.
                LogWarn("attachment inspection exceeded " +
                        std::to_string(kAttachmentHoldMs) + "ms in " + exe +
                        " - send BLOCKED uninspected (fail closed)");
                ShowBlockedNotice(exe, "an attachment that could not be inspected in time");
                return;
            }
    
            // Cleared. Replay the click the user actually made.
            LogInfo("staged attachment cleared in " + exe + " - releasing the held send");
            ReleaseClick(pt);
        }).detach();
        return 1;                       // swallow while the verdict is pending
    }

    if (!fromDrop) {
        std::lock_guard<std::mutex> lk(g_snapMx);
        const long long age = g_snapAtMs ? (NowSteadyMs() - g_snapAtMs) : -1;
        if (!(g_snapPid == pid && g_snapSensitive && age >= 0 && age <= 15000)) {
            return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
        }
        what = g_snapWhat; cls = g_snapCls; text = g_snapText;
    }

    // Committed. Swallow both halves and report off the hook thread — every
    // line below this point must stay off anything that can block.
    g_swallowNextUp.store(true);
    if (fromDrop) ClearPendingDrop();
    std::thread([pid, what, cls, text, via, fromDrop]() {
        const std::string exe = ProcessExeName(pid);
        const std::string severity =
            (ToLowerAscii(cls.category) == "restricted") ? "critical" : "high";
        try {
            // Resolved here rather than in the hook: this runs on a detached
            // thread and the app is still foreground, the block notice not yet up.
            EmitEvent(exe, pid, "BLOCK", severity, cls,
                      (fromDrop
                         ? "Blocked sensitive file dropped into " + exe + " (" +
                           cls.category + ") - " + text
                         : "Blocked sensitive message in " + exe + " (" +
                           cls.category + ") - Send button click"),
                      text, "send_button", GetForegroundWindow());
        } catch (...) {}
        LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" + cls.category +
                " detected=[" + what + "] via=" + via);
        ShowBlockedNotice(exe, what.empty() ? std::string("a sensitive file") : what);
    }).detach();

    return 1;
}

// Installs, or reinstalls, both hooks. Hook-thread only.
//
// Unhooking first is deliberate even when we believe the hooks are already
// gone: if Windows dropped only one of them, the survivor would otherwise be
// leaked and go on delivering into a second registration.
bool InstallHooks(bool reinstall) {
    if (g_hook)      { UnhookWindowsHookEx(g_hook);      g_hook = nullptr; }
    if (g_mouseHook) { UnhookWindowsHookEx(g_mouseHook); g_mouseHook = nullptr; }

    g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyProc, GetModuleHandle(nullptr), 0);
    if (!g_hook) {
        LogWarn(std::string(reinstall ? "REINSTALL FAILED: " : "") +
                "SetWindowsHookEx(WH_KEYBOARD_LL) failed err=" +
                std::to_string((unsigned long)GetLastError()));
        return false;
    }

    // Non-fatal on purpose. Losing the mouse hook costs the Send-button path
    // and nothing else; Enter is still inspected, so a partial capability beats
    // refusing to start.
    g_mouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, GetModuleHandle(nullptr), 0);
    if (!g_mouseHook) {
        LogWarn("SetWindowsHookEx(WH_MOUSE_LL) failed err=" +
                std::to_string((unsigned long)GetLastError()) +
                " - clicking Send with the mouse will NOT be inspected");
    }

    // Fresh proof of life, so the watchdog does not immediately re-fire on the
    // silence that led us here.
    const long long now = NowSteadyMs();
    g_lastKeyHookMs.store(now);
    g_lastMouseHookMs.store(now);

    LogInfo(std::string(reinstall ? "typed-message hooks REINSTALLED"
                                  : "typed-message keyboard hook installed") +
            (g_mouseHook ? " (Send button covered)" : " (mouse hook unavailable)"));
    // The one line that says which capability this build has. Without it, an
    // operator cannot tell a machine that fell back to typed text from one
    // still relying entirely on an accessibility tree it cannot read.
    if (!reinstall) {
        LogInfo("typed-text capture armed - a message can now be inspected even where "
                "the app's accessibility tree cannot be read");
        // If this reads 100% on a display that is actually scaled, the process
        // is still DPI-unaware and no Send-button rectangle will ever contain
        // the click reported to the mouse hook.
        LogInfo("display scaling seen by this process: " + DescribeDisplayScaling() +
                " - Send-button rectangles and click positions are compared in "
                "this space");
    }
    return true;
}

void HookThread() {
    g_hookThread = GetCurrentThreadId();
    if (!InstallHooks(false)) {
        g_running.store(false);
        return;
    }

    // A low-level hook is only serviced while its installing thread pumps
    // messages. No window, no timers — just the pump.
    MSG msg;
    while (!g_stop.load()) {
        const BOOL got = GetMessage(&msg, nullptr, 0, 0);
        if (got <= 0) break;                      // WM_QUIT, or an error
        if (!msg.hwnd && msg.message == WM_REHOOK) {
            InstallHooks(true);                   // the watchdog says we went deaf
            continue;
        }
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    if (g_mouseHook) { UnhookWindowsHookEx(g_mouseHook); g_mouseHook = nullptr; }
    UnhookWindowsHookEx(g_hook);
    g_hook = nullptr;
    LogInfo("typed-message keyboard hook removed");
}

} // namespace

bool Start(const Config& cfg) {
    if (g_running.load()) return true;
    if (!cfg.classify || !cfg.sendEvent || !cfg.log || !cfg.messagingPolicy) {
        return false;
    }
    g_cfg = cfg;

    // A one-line proof, on every start, that the classifier this module was
    // handed actually detects something. Without it, "the classifier is not
    // wired up" and "we read the wrong box" produce the identical outcome —
    // every message reported clean — and the only way to tell them apart was to
    // find someone willing to type a card number into a chat app and then read
    // a log. The literal is Visa's published test PAN; it is a checksum-valid
    // number that belongs to nobody.
    try {
        const NetworkExfilMonitor::ClassifyResult probe =
            g_cfg.classify("card 4111 1111 1111 1111 end", "messaging_message");
        if (probe.labels.empty()) {
            LogWarn("classifier self-test FAILED - a known-good test card was not detected. "
                    "Every typed message will be reported clean until this is fixed.");
        } else {
            LogInfo("classifier self-test: detected [" + DescribeLabels(probe) + "] as " +
                    (probe.category.empty() ? std::string("(no category)") : probe.category));
        }
    } catch (...) {
        LogWarn("classifier self-test THREW - typed-message inspection cannot classify anything");
    }

    g_stop.store(false);
    g_decisionPending.store(false);
    g_decisionResolved.store(true);
    g_holdStartMs.store(0);
    g_running.store(true);

    g_workerObj     = std::thread(WorkerThread);
    g_watchdogObj   = std::thread(WatchdogThread);
    g_samplerObj    = std::thread(SamplerThread);
    g_locatorObj    = std::thread(LocatorThread);
    g_hookThreadObj = std::thread(HookThread);

    // Give the hook a moment to report failure so Start() reflects reality.
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    return g_running.load();
}

void Stop() {
    if (!g_running.load()) return;
    g_stop.store(true);
    if (g_hookThread) PostThreadMessage(g_hookThread, WM_QUIT, 0, 0);
    g_cv.notify_all();
    if (g_hookThreadObj.joinable()) g_hookThreadObj.join();
    if (g_workerObj.joinable())     g_workerObj.join();
    if (g_watchdogObj.joinable())   g_watchdogObj.join();
    if (g_samplerObj.joinable())    g_samplerObj.join();
    if (g_locatorObj.joinable())    g_locatorObj.join();

    // Both resolvers have now exited. If a keystroke was still held when the
    // stop came, nobody is left to give it back — and quietly eating the user's
    // Enter on agent shutdown is the same failure this module refuses
    // everywhere else, just at a moment nobody would think to test.
    ResolveRelease(g_holdCtrl.load());

    // Nothing typed outlives the monitor. The buffer exists to inspect a send
    // that is about to happen; once nothing is inspecting, holding it would be
    // keystroke capture with no purpose attached.
    g_managedWnd.store(nullptr, std::memory_order_relaxed);
    g_pasteSeen.store(false, std::memory_order_relaxed);
    ClearTypedBuffer();

    g_running.store(false);
}

bool IsRunning() { return g_running.load(); }

} // namespace MessagingTextMonitor
