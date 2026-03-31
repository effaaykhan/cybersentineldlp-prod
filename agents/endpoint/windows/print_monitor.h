#pragma once
#include <windows.h>
#include <winspool.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>

class PrintMonitor {
public:
    using PrintCallback = std::function<void(const std::string& printer, const std::string& document, int pages, const std::string& user)>;

    PrintMonitor(PrintCallback callback);
    ~PrintMonitor();

    bool Start();
    void Stop();
    bool IsRunning() const;

private:
    void MonitorLoop();
    PrintCallback m_callback;
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    HANDLE m_changeNotification{INVALID_HANDLE_VALUE};
};
