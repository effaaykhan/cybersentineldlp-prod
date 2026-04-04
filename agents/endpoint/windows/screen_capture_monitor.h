#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>

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

    // Static hook callback — must be static for Windows API
    static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam);

private:
    void HookThread();           // Thread that runs the keyboard hook message loop
    void ProcessMonitorThread(); // Thread that monitors capture tool processes
    std::string GetActiveWindowTitle();
    std::string GetForegroundProcessName();
    std::string GetTimestamp();
    void TerminateProcessByName(const std::string& processName);
    void HandleCaptureAttempt(const std::string& method);

    CaptureCallback m_callback;
    LogCallback m_logger;
    ClassifyCallback m_classifier;
    std::thread m_hookThread;
    std::thread m_processThread;
    std::atomic<bool> m_running{false};

    // Static instance pointer for the hook callback
    static ScreenCaptureMonitor* s_instance;
    static HHOOK s_keyboardHook;

    static const std::vector<std::string> CAPTURE_PROCESSES;
};
