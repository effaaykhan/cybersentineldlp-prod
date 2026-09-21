#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>
#include <mutex>

// Server-delivered screen-capture control policy (GET /agents/{id}/screen-capture-policy).
//
// This channel used to be hardcoded on, with no policy and no off switch. It is
// now inert until a policy says otherwise: a default-constructed instance means
// "no active policy", and in that state the monitor suppresses nothing, kills
// nothing and raises nothing.
//
// The server has already folded mode+action into the three suppression flags,
// so "audit" arrives here as blockKeyboard/terminateTools/clearClipboard all
// false. The agent does not re-derive that — one place decides, and it is the
// side an operator can actually inspect.
struct ScreenCapturePolicy {
    bool enforced = false;
    std::string mode   = "enforce";   // enforce | audit
    std::string action = "alert";     // alert | block
    std::vector<std::string> levels;  // classification levels treated as sensitive
    bool blockKeyboard     = false;   // swallow PrintScreen / Alt+PrintScreen / Win+Shift+S
    bool blockCaptureTools = false;   // watch for known capture applications
    bool terminateTools    = false;   // kill such a tool, vs. only raising an event
    bool clearClipboard    = false;   // wipe the clipboard after a blocked capture
    bool notifyUser        = true;    // show the endpoint popup
    std::vector<std::string> tools;           // capture-tool exe names (lowercased)
    std::vector<std::string> exceptUsers;     // users exempt (lowercased)
    std::vector<std::string> exceptProcesses; // foreground processes never sensitive
    std::string policyId;
    std::string policyName;
};

struct ScreenCaptureEvent {
    std::string eventType = "screen_capture";
    std::string method;             // printscreen, alt_printscreen, win_shift_s, capture_tool
    std::string processName;
    std::string activeWindow;
    std::string user;
    std::string classification;     // Public, Internal, Confidential, Restricted
    bool containsSensitiveData = false;
    std::string actionTaken;        // Allow, Block, Alert
    std::string timestamp;
    // WHICH policy decided. Without it a blocked screenshot reaches the console
    // with no way to tell which rule fired or which one to change.
    std::string policyId;
    std::string policyName;
};

class ScreenCaptureMonitor {
public:
    using CaptureCallback = std::function<void(ScreenCaptureEvent& event)>;
    using LogCallback = std::function<void(const std::string& level, const std::string& message)>;
    using ClassifyCallback = std::function<std::string(const std::string& windowTitle, const std::string& processName)>;

    ScreenCaptureMonitor(CaptureCallback callback, LogCallback logger = nullptr,
                         ClassifyCallback classifier = nullptr);
    ~ScreenCaptureMonitor();

    bool Start();
    void Stop();
    bool IsRunning() const;

    void SetClassifier(ClassifyCallback classifier) { m_classifier = classifier; }

    // Replace the active policy. Called on every policy sync, so a change in
    // the console reaches the endpoint within one sync interval without a
    // restart. Safe to call while the monitor is running.
    void ApplyPolicy(const ScreenCapturePolicy& policy);

    // Snapshot of the active policy, taken under the policy lock.
    ScreenCapturePolicy GetPolicy() const;

    // Static hook callback — must be static for Windows API
    static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam);

private:
    void HookThread();             // Thread that runs the keyboard hook message loop
    void ProcessMonitorThread();   // Thread that monitors capture tool processes
    void ContentScanThread();      // Background OCR — maintains m_screenIsSensitive
    std::string GetActiveWindowTitle();
    std::string GetForegroundProcessName();
    std::string GetTimestamp();
    void TerminateProcessByName(const std::string& processName);
    // suppressed = the capture was actually withheld. Passed in rather than
    // re-derived, because only the caller knows whether ITS path enforced:
    // the keyboard hook and the tool watcher have separate policy toggles.
    void HandleCaptureAttempt(const std::string& method, bool suppressed);

    CaptureCallback m_callback;
    LogCallback m_logger;
    ClassifyCallback m_classifier;
    std::thread m_hookThread;
    std::thread m_processThread;
    std::thread m_scanThread;
    std::atomic<bool> m_running{false};

    // Continuously updated by ContentScanThread. The keyboard hook ONLY
    // swallows PrintScreen / Win+Shift+S when this flag is true; otherwise
    // the key is passed to Windows unchanged and the screenshot happens
    // normally.
    std::atomic<bool> m_screenIsSensitive{false};

    // Cooldown — only show ONE blocked-screenshot popup per N milliseconds.
    // Stops the dialog from being spammed when the user mashes PrintScreen.
    std::atomic<long long> m_lastPopupMs{0};

    // Block grace — set true whenever the hook blocks a screenshot.
    // Cleared by ContentScanThread the moment it produces a fresh
    // classification on a real (non-transient) foreground window.
    // While true, every screenshot attempt is force-blocked regardless
    // of the m_screenIsSensitive flag. This eliminates the race where
    // the DLP popup steals focus and the scanner clears the flag
    // before it has had a chance to re-classify the user's actual
    // current window. As soon as the scanner sees a real window after
    // the block, the grace clears and the actual flag value takes over
    // — so switching to a normal window after a block correctly
    // allows screenshots of that normal window.
    std::atomic<bool> m_blockGraceActive{false};

    // Static instance pointer for the hook callback
    static ScreenCaptureMonitor* s_instance;
    static HHOOK s_keyboardHook;

    // Guards m_policy. The keyboard hook reads it on the input path, so the
    // critical sections it protects are deliberately tiny — copy out, act
    // outside. LowLevelHooksTimeout is 300ms and Windows silently evicts a
    // hook that misses it.
    mutable std::mutex m_policyMutex;
    ScreenCapturePolicy m_policy;

    // The classification the scanner last produced. The event used to report a
    // flat "Restricted" whenever the sensitive flag was set, which became a lie
    // as soon as the levels were configurable.
    mutable std::mutex m_classMutex;
    std::string m_lastClassification{"Public"};

    // Hot copies of the two flags the keyboard hook needs, so the input path
    // never takes a lock at all.
    std::atomic<bool> m_policyEnforced{false};
    std::atomic<bool> m_blockKeyboard{false};

    // True when the foreground process or the logged-in user is excepted.
    // Kept beside m_screenIsSensitive so the hook stays a single atomic read.
    bool IsExcepted(const std::string& processName, const std::string& user) const;

    static const std::vector<std::string> CAPTURE_PROCESSES;
};
