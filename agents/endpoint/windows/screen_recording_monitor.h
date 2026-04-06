#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>
#include <mutex>

// Event emitted when a screen recording starts or stops.
struct ScreenRecordingEvent {
    std::string eventType = "screen_recording";
    std::string processName;       // detected recorder process (e.g. obs64.exe)
    std::string user;
    bool        recordingActive   = false;
    std::string actionTaken;       // STARTED / STOPPED
    std::string timestamp;
};

// Process-only screen-recording detector.
//
// This class no longer paints any live overlay. Recording is allowed to
// happen normally — the agent does NOT obscure sensitive content while a
// recording is in progress. Instead the recording-stop event triggers the
// VideoRedactor module which post-processes the saved video file to mask
// sensitive content frame-by-frame.
//
// Owns one thread (the process-detection loop).
class ScreenRecordingMonitor {
public:
    using EventCallback     = std::function<void(ScreenRecordingEvent& evt)>;
    using LogCallback       = std::function<void(const std::string& level, const std::string& msg)>;
    using LifecycleCallback = std::function<void(const std::string& processName)>;

    ScreenRecordingMonitor(EventCallback eventCb,
                           LogCallback logger = nullptr);
    ~ScreenRecordingMonitor();

    bool Start();
    void Stop();
    bool IsRunning() const { return m_running.load(); }

    // Optional callbacks invoked when the detector observes a transition.
    // Used by VideoRedactor to widen its file-watch acceptance window.
    void OnRecordingStarted(LifecycleCallback cb) { m_onStartedCb = std::move(cb); }
    void OnRecordingStopped(LifecycleCallback cb) { m_onStoppedCb = std::move(cb); }

private:
    void ProcessDetectionLoop();   // ~2s cadence — enumerate processes, toggle state

    bool IsKnownRecorderName(const std::string& exeNameLower, std::string& matchedOut) const;

    std::string GetCurrentUserName();
    std::string Timestamp();
    void EmitEvent(const std::string& action);

    EventCallback     m_eventCb;
    LogCallback       m_logger;
    LifecycleCallback m_onStartedCb;
    LifecycleCallback m_onStoppedCb;

    std::thread       m_processThread;
    std::atomic<bool> m_running{false};

    std::atomic<bool> m_recordingActive{false};
    std::mutex        m_recProcMutex;
    std::string       m_recordingProcess;
};
