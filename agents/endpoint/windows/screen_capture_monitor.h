#pragma once
#include <windows.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>

class ScreenCaptureMonitor {
public:
    using CaptureCallback = std::function<void(const std::string& method, const std::string& details)>;

    ScreenCaptureMonitor(CaptureCallback callback);
    ~ScreenCaptureMonitor();

    bool Start();
    void Stop();
    bool IsRunning() const;

private:
    void MonitorLoop();
    bool CheckForCaptureProcesses();

    CaptureCallback m_callback;
    std::thread m_thread;
    std::atomic<bool> m_running{false};

    // Known screen capture tool process names
    static const std::vector<std::string> CAPTURE_PROCESSES;
};
