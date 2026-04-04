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
    // New callback receives full event structure
    using CaptureCallback = std::function<void(ScreenCaptureEvent& event)>;
    using LogCallback = std::function<void(const std::string& level, const std::string& message)>;
    // Classifier takes window title + process → returns classification level
    using ClassifyCallback = std::function<std::string(const std::string& windowTitle, const std::string& processName)>;

    ScreenCaptureMonitor(CaptureCallback callback, LogCallback logger = nullptr,
                         ClassifyCallback classifier = nullptr);
    ~ScreenCaptureMonitor();

    bool Start();
    void Stop();
    bool IsRunning() const;

    void SetClassifier(ClassifyCallback classifier) { m_classifier = classifier; }

private:
    void MonitorLoop();
    std::string GetActiveWindowTitle();
    std::string GetForegroundProcessName();
    std::string GetTimestamp();
    void BlockScreenshot();
    void TerminateProcessByName(const std::string& processName);

    CaptureCallback m_callback;
    LogCallback m_logger;
    ClassifyCallback m_classifier;
    std::thread m_thread;
    std::atomic<bool> m_running{false};

    static const std::vector<std::string> CAPTURE_PROCESSES;
};
