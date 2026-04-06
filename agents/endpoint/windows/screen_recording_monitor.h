#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>
#include <mutex>

// Event emitted when a screen recording is detected.
// Reused per-state-change (started/stopped/protection toggled).
struct ScreenRecordingEvent {
    std::string eventType = "screen_recording";
    std::string processName;       // detected recorder process (e.g. obs64.exe)
    std::string user;
    bool        recordingActive   = false;
    bool        sensitiveDetected = false;
    std::string classification;    // Public / Internal / Confidential / Restricted
    std::string activeWindow;      // foreground window title at the moment of decision
    std::string actionTaken;       // BLUR / ALLOW
    bool        evasion           = false;
    std::string timestamp;
};

// Isolated screen-recording detector + sensitive-content protection overlay.
//
// Design notes (kept intentionally separate from ScreenCaptureMonitor / PrintMonitor):
//   * Owns its own threads. Does not touch keyboard hooks, USB, clipboard, or
//     screenshot logic.
//   * NEVER blocks recording. Only obscures sensitive content with a topmost
//     layered overlay window while a recording tool is active.
//   * Reuses the agent's existing classifier callback (window title + process
//     name → classification level). Classification logic is NOT duplicated.
class ScreenRecordingMonitor {
public:
    using EventCallback   = std::function<void(ScreenRecordingEvent& evt)>;
    using LogCallback     = std::function<void(const std::string& level, const std::string& msg)>;
    using ClassifyCallback = std::function<std::string(const std::string& windowTitle,
                                                       const std::string& processName)>;

    ScreenRecordingMonitor(EventCallback eventCb,
                           LogCallback logger = nullptr,
                           ClassifyCallback classifier = nullptr);
    ~ScreenRecordingMonitor();

    bool Start();
    void Stop();
    bool IsRunning() const { return m_running.load(); }

    void SetClassifier(ClassifyCallback classifier) { m_classifier = std::move(classifier); }

private:
    // ── Threads ─────────────────────────────────────────────
    void ProcessDetectionLoop();   // ~2s cadence: enumerate processes, toggle recording state
    void ContentMonitorLoop();     // ~250ms cadence (only while recording_active): classify foreground
    void OverlayThread();          // dedicated UI thread that owns the overlay window + message pump

    // ── Helpers ─────────────────────────────────────────────
    bool IsKnownRecorderName(const std::string& exeNameLower, std::string& matchedOut) const;
    bool LooksLikeEvasiveRecorder(const std::string& exeNameLower,
                                  const std::string& windowTitleLower) const;

    std::string GetForegroundWindowTitle();
    std::string GetForegroundProcessName();
    std::string GetCurrentUserName();
    std::string Timestamp();

    void RequestOverlayShow();
    void RequestOverlayHide();
    void EmitEvent(const std::string& action,
                   bool sensitive,
                   const std::string& classification,
                   const std::string& activeWindow,
                   bool evasion);

    // ── Window proc (must be static for WinAPI) ─────────────
    static LRESULT CALLBACK OverlayWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

    // ── State ───────────────────────────────────────────────
    EventCallback    m_eventCb;
    LogCallback      m_logger;
    ClassifyCallback m_classifier;

    std::thread m_processThread;
    std::thread m_contentThread;
    std::thread m_overlayThread;

    std::atomic<bool> m_running{false};

    // recording_active / recording_process — written only by ProcessDetectionLoop,
    // read by ContentMonitorLoop. Atomic + mutex for the string.
    std::atomic<bool> m_recordingActive{false};
    std::atomic<bool> m_evasionFlagged{false};
    std::mutex        m_recProcMutex;
    std::string       m_recordingProcess;

    // overlay_active — written only by ContentMonitorLoop / overlay thread.
    std::atomic<bool> m_overlayActive{false};
    std::atomic<bool> m_overlayShouldShow{false};

    // Overlay window handle, set by OverlayThread once created.
    std::atomic<HWND> m_overlayHwnd{nullptr};
    DWORD m_overlayThreadId{0};

    // Classification cache to avoid spamming events / re-running OCR every 250ms
    // when nothing changed. Read/written only by ContentMonitorLoop.
    std::string m_lastWindowSig;
    std::string m_lastClassification;

    static constexpr UINT WM_DLP_SHOW_OVERLAY = WM_APP + 101;
    static constexpr UINT WM_DLP_HIDE_OVERLAY = WM_APP + 102;
};
