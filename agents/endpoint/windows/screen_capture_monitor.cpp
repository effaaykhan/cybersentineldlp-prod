#include "screen_capture_monitor.h"
#include <tlhelp32.h>
#include <iostream>
#include <algorithm>
#include <set>

const std::vector<std::string> ScreenCaptureMonitor::CAPTURE_PROCESSES = {
    "SnippingTool.exe", "ScreenClippingHost.exe", "ScreenSketch.exe",
    "Greenshot.exe", "ShareX.exe", "LightShot.exe", "lightshot.exe",
    "Snagit32.exe", "Snagit.exe", "obs64.exe", "obs32.exe",
    "CamtasiaStudio.exe", "Bandicam.exe"
};

ScreenCaptureMonitor::ScreenCaptureMonitor(CaptureCallback callback)
    : m_callback(std::move(callback)) {}

ScreenCaptureMonitor::~ScreenCaptureMonitor() { Stop(); }

bool ScreenCaptureMonitor::Start() {
    if (m_running) return true;
    m_running = true;
    m_thread = std::thread(&ScreenCaptureMonitor::MonitorLoop, this);
    std::cout << "[ScreenCaptureMonitor] Started" << std::endl;
    return true;
}

void ScreenCaptureMonitor::Stop() {
    m_running = false;
    if (m_thread.joinable()) m_thread.join();
}

bool ScreenCaptureMonitor::IsRunning() const { return m_running; }

void ScreenCaptureMonitor::MonitorLoop() {
    // Track PrintScreen key state
    bool printScreenWasDown = false;
    std::set<std::string> knownCapProcesses;

    while (m_running) {
        // Check for PrintScreen key press
        SHORT keyState = GetAsyncKeyState(VK_SNAPSHOT);
        bool printScreenDown = (keyState & 0x8000) != 0;

        if (printScreenDown && !printScreenWasDown) {
            // Check for Alt+PrintScreen (window capture) vs PrintScreen (full screen)
            bool altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
            std::string method = altDown ? "alt_printscreen" : "printscreen";
            std::string details = altDown ? "Active window capture detected" : "Full screen capture detected";

            if (m_callback) {
                m_callback(method, details);
            }
        }
        printScreenWasDown = printScreenDown;

        // Check for screen capture tool processes (every 3 seconds)
        static int processCheckCounter = 0;
        if (++processCheckCounter >= 30) {  // 30 * 100ms = 3 seconds
            processCheckCounter = 0;

            HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (hSnap != INVALID_HANDLE_VALUE) {
                PROCESSENTRY32 pe;
                pe.dwSize = sizeof(pe);

                std::set<std::string> currentCapProcesses;

                if (Process32First(hSnap, &pe)) {
                    do {
                        std::string procName = pe.szExeFile;
                        for (const auto& capProc : CAPTURE_PROCESSES) {
                            // Case-insensitive compare
                            std::string lower1 = procName, lower2 = capProc;
                            std::transform(lower1.begin(), lower1.end(), lower1.begin(), ::tolower);
                            std::transform(lower2.begin(), lower2.end(), lower2.begin(), ::tolower);

                            if (lower1 == lower2) {
                                currentCapProcesses.insert(procName);

                                // Only alert on newly detected processes
                                if (knownCapProcesses.find(procName) == knownCapProcesses.end()) {
                                    if (m_callback) {
                                        m_callback("capture_tool_launched",
                                            "Screen capture tool detected: " + procName);
                                    }
                                }
                            }
                        }
                    } while (Process32Next(hSnap, &pe));
                }
                CloseHandle(hSnap);
                knownCapProcesses = currentCapProcesses;
            }
        }

        Sleep(100);  // 100ms polling interval
    }
}
