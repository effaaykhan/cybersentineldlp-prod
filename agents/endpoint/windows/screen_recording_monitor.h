#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>
#include <mutex>
#include <chrono>

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
    int         regionsCount      = 0;  // number of sensitive rectangles masked
    std::string timestamp;
};

// Single sensitive region in *screen* coordinates (virtual desktop space).
struct SensitiveRegion {
    int left = 0, top = 0, right = 0, bottom = 0;
    std::string label;  // matched pattern name (AADHAAR, PAN, CC, ...)
};

// A sticky region keeps a sensitive box visible for a short TTL after the
// last OCR detection so transient OCR misses don't cause the mask to flicker.
struct StickyRegion {
    SensitiveRegion region;
    std::chrono::steady_clock::time_point lastSeen;
};

// Isolated screen-recording detector + sensitive-content protection overlay.
//
// Behaviour:
//   * Detects active screen-recording tools (process scan).
//   * NEVER blocks recording.
//   * While recording is active, captures the virtual screen, OCRs it with
//     Tesseract in TSV mode (word-level bounding boxes), regex-matches each
//     line for sensitive patterns (Aadhaar, PAN, CC, SSN, IFSC, secrets),
//     and pushes the resulting rectangles to a topmost click-through overlay
//     window which paints small black masks ONLY over those rectangles.
//   * The rest of the screen is fully transparent — normal screen content
//     is visible to the user and to the recorder.
//
// Owns its own threads. Does not touch keyboard hooks, USB, clipboard, or
// screenshot logic. No shared mutable state with the rest of the agent.
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
    void ContentMonitorLoop();     // ~700ms cadence (only while recording_active): OCR + regions
    void OverlayThread();          // dedicated UI thread that owns the overlay window + message pump

    // ── Process detection ───────────────────────────────────
    bool IsKnownRecorderName(const std::string& exeNameLower, std::string& matchedOut) const;
    bool LooksLikeEvasiveRecorder(const std::string& exeNameLower,
                                  const std::string& windowTitleLower) const;

    // ── OCR / region detection ──────────────────────────────
    bool CaptureForegroundWindowBmp(HWND hwnd,
                                    const std::string& outPath,
                                    int& outOriginX, int& outOriginY,
                                    int& outW, int& outH);
    std::vector<SensitiveRegion> OcrForegroundWindow(HWND hwnd);

    // ── Helpers ─────────────────────────────────────────────
    std::string GetForegroundWindowTitle();
    std::string GetForegroundProcessName();
    std::string GetCurrentUserName();
    std::string Timestamp();

    void UpdateOverlayRegions(const std::vector<SensitiveRegion>& regions);
    void RequestOverlayHide();
    void EmitEvent(const std::string& action,
                   bool sensitive,
                   const std::string& classification,
                   const std::string& activeWindow,
                   bool evasion,
                   int regionsCount);

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
    std::atomic<bool> m_firstOcrPending{false};   // set true on each recording start
    std::mutex        m_recProcMutex;
    std::string       m_recordingProcess;

    // Foreground window tracking + sticky regions (anti-flicker, anti-leak).
    HWND m_lastForegroundHwnd = nullptr;
    bool m_lastWindowHadSensitive = false;
    std::mutex                  m_stickyMutex;
    std::vector<StickyRegion>   m_stickyRegions;

    // overlay_active — written only by ContentMonitorLoop / overlay thread.
    std::atomic<bool> m_overlayActive{false};

    // Overlay window handle, set by OverlayThread once created.
    std::atomic<HWND> m_overlayHwnd{nullptr};
    DWORD m_overlayThreadId{0};

    // Region buffer shared between content thread (writer) and overlay
    // thread (reader inside WM_PAINT). Protected by m_regionsMutex.
    std::mutex                   m_regionsMutex;
    std::vector<SensitiveRegion> m_regions;
    int                          m_overlayOriginX = 0;
    int                          m_overlayOriginY = 0;

    static constexpr UINT WM_DLP_UPDATE_OVERLAY = WM_APP + 101;
    static constexpr UINT WM_DLP_HIDE_OVERLAY   = WM_APP + 102;
};
