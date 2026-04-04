#include "screen_capture_monitor.h"
#include <tlhelp32.h>
#include <iostream>
#include <algorithm>
#include <set>
#include <chrono>

const std::vector<std::string> ScreenCaptureMonitor::CAPTURE_PROCESSES = {
    "SnippingTool.exe", "ScreenClippingHost.exe", "ScreenSketch.exe",
    "Greenshot.exe", "ShareX.exe", "LightShot.exe", "lightshot.exe",
    "Snagit32.exe", "Snagit.exe", "obs64.exe", "obs32.exe",
    "CamtasiaStudio.exe", "Bandicam.exe", "ScreenToGif.exe",
    "FlameShot.exe", "PicPick.exe", "FastStone.exe"
};

ScreenCaptureMonitor::ScreenCaptureMonitor(CaptureCallback callback, LogCallback logger, ClassifyCallback classifier)
    : m_callback(std::move(callback)), m_logger(std::move(logger)), m_classifier(std::move(classifier)) {}

ScreenCaptureMonitor::~ScreenCaptureMonitor() { Stop(); }

bool ScreenCaptureMonitor::Start() {
    if (m_running) return true;
    m_running = true;
    m_thread = std::thread(&ScreenCaptureMonitor::MonitorLoop, this);
    if (m_logger) m_logger("INFO", "Screen capture monitor started");
    return true;
}

void ScreenCaptureMonitor::Stop() {
    m_running = false;
    if (m_thread.joinable()) m_thread.join();
}

bool ScreenCaptureMonitor::IsRunning() const { return m_running; }

std::string ScreenCaptureMonitor::GetActiveWindowTitle() {
    char title[512] = {0};
    HWND hwnd = GetForegroundWindow();
    if (hwnd) GetWindowTextA(hwnd, title, sizeof(title));
    return std::string(title);
}

std::string ScreenCaptureMonitor::GetForegroundProcessName() {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return "unknown";
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!pid) return "unknown";
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc) return "unknown";
    char name[MAX_PATH] = {0};
    DWORD size = MAX_PATH;
    QueryFullProcessImageNameA(hProc, 0, name, &size);
    CloseHandle(hProc);
    std::string path(name);
    auto pos = path.rfind('\\');
    return pos != std::string::npos ? path.substr(pos + 1) : path;
}

std::string ScreenCaptureMonitor::GetTimestamp() {
    auto now = std::chrono::system_clock::now();
    auto t = std::chrono::system_clock::to_time_t(now);
    t += 19800; // IST
    struct tm tm_buf;
    gmtime_s(&tm_buf, &t);
    char buf[64];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d+05:30",
             tm_buf.tm_year + 1900, tm_buf.tm_mon + 1, tm_buf.tm_mday,
             tm_buf.tm_hour, tm_buf.tm_min, tm_buf.tm_sec);
    return buf;
}

void ScreenCaptureMonitor::BlockScreenshot() {
    // Clear clipboard to remove any captured screenshot
    if (OpenClipboard(NULL)) {
        EmptyClipboard();
        CloseClipboard();
    }
}

void ScreenCaptureMonitor::TerminateProcessByName(const std::string& processName) {
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return;

    PROCESSENTRY32 pe;
    pe.dwSize = sizeof(pe);

    std::string targetLower = processName;
    std::transform(targetLower.begin(), targetLower.end(), targetLower.begin(), ::tolower);

    if (Process32First(hSnap, &pe)) {
        do {
            std::string procLower = pe.szExeFile;
            std::transform(procLower.begin(), procLower.end(), procLower.begin(), ::tolower);
            if (procLower == targetLower) {
                HANDLE hProc = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
                if (hProc) {
                    TerminateProcess(hProc, 1);
                    CloseHandle(hProc);
                    if (m_logger) m_logger("WARNING", "SCREEN_ACTION_ENFORCED: Terminated " + processName);
                }
            }
        } while (Process32Next(hSnap, &pe));
    }
    CloseHandle(hSnap);
}

void ScreenCaptureMonitor::MonitorLoop() {
    bool printScreenWasDown = false;
    bool winShiftSWasDown = false;
    std::set<std::string> knownCapProcesses;
    char username[256] = {0};
    DWORD userSize = sizeof(username);
    GetUserNameA(username, &userSize);

    while (m_running) {
        // ── 1. Detect PrintScreen key ──
        SHORT keyState = GetAsyncKeyState(VK_SNAPSHOT);
        bool printScreenDown = (keyState & 0x8000) != 0;

        if (printScreenDown && !printScreenWasDown) {
            bool altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
            std::string method = altDown ? "alt_printscreen" : "printscreen";

            if (m_logger) m_logger("INFO", "SCREEN_CAPTURE_KEY_DETECTED: " + method);

            std::string windowTitle = GetActiveWindowTitle();
            std::string processName = GetForegroundProcessName();

            // Classify context
            std::string classification = "Public";
            if (m_classifier) {
                classification = m_classifier(windowTitle, processName);
            }

            if (m_logger) m_logger("INFO", "SCREEN_CONTEXT_CLASSIFIED: " + classification +
                                   " | Window: " + windowTitle);

            bool isSensitive = (classification == "Restricted" || classification == "Confidential");
            std::string action = isSensitive ? "Block" : "Allow";

            if (m_logger) m_logger("INFO", "SCREEN_POLICY_DECISION: " + action +
                                   " (classification=" + classification + ")");

            // Enforce
            if (isSensitive) {
                BlockScreenshot();
                if (m_logger) m_logger("WARNING", "SCREEN_ACTION_ENFORCED: BLOCKED screenshot — " +
                                       classification + " data visible in: " + windowTitle);
            }

            // Build event
            ScreenCaptureEvent event;
            event.method = method;
            event.processName = processName;
            event.activeWindow = windowTitle;
            event.user = username;
            event.classification = classification;
            event.containsSensitiveData = isSensitive;
            event.actionTaken = action;
            event.timestamp = GetTimestamp();

            if (m_callback) m_callback(event);
        }
        printScreenWasDown = printScreenDown;

        // ── 2. Detect Win+Shift+S (Snip & Sketch) ──
        bool winDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
        bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        bool sDown = (GetAsyncKeyState(0x53) & 0x8000) != 0; // 'S' key
        bool winShiftSDown = winDown && shiftDown && sDown;

        if (winShiftSDown && !winShiftSWasDown) {
            if (m_logger) m_logger("INFO", "SCREEN_CAPTURE_KEY_DETECTED: win_shift_s");

            std::string windowTitle = GetActiveWindowTitle();
            std::string processName = GetForegroundProcessName();

            std::string classification = "Public";
            if (m_classifier) classification = m_classifier(windowTitle, processName);

            bool isSensitive = (classification == "Restricted" || classification == "Confidential");
            std::string action = isSensitive ? "Block" : "Allow";

            if (isSensitive) {
                BlockScreenshot();
                if (m_logger) m_logger("WARNING", "SCREEN_ACTION_ENFORCED: BLOCKED Win+Shift+S — " +
                                       classification + " data visible");
            }

            ScreenCaptureEvent event;
            event.method = "win_shift_s";
            event.processName = processName;
            event.activeWindow = windowTitle;
            event.user = username;
            event.classification = classification;
            event.containsSensitiveData = isSensitive;
            event.actionTaken = action;
            event.timestamp = GetTimestamp();

            if (m_callback) m_callback(event);
        }
        winShiftSWasDown = winShiftSDown;

        // ── 3. Detect screen capture tool processes (every 3 seconds) ──
        static int processCheckCounter = 0;
        if (++processCheckCounter >= 30) {
            processCheckCounter = 0;

            HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (hSnap != INVALID_HANDLE_VALUE) {
                PROCESSENTRY32 pe;
                pe.dwSize = sizeof(pe);

                std::set<std::string> currentCapProcesses;

                if (Process32First(hSnap, &pe)) {
                    do {
                        std::string procName = pe.szExeFile;
                        std::string procLower = procName;
                        std::transform(procLower.begin(), procLower.end(), procLower.begin(), ::tolower);

                        for (const auto& capProc : CAPTURE_PROCESSES) {
                            std::string capLower = capProc;
                            std::transform(capLower.begin(), capLower.end(), capLower.begin(), ::tolower);

                            if (procLower == capLower) {
                                currentCapProcesses.insert(procName);

                                if (knownCapProcesses.find(procName) == knownCapProcesses.end()) {
                                    if (m_logger) m_logger("INFO", "SCREEN_CAPTURE_PROCESS_DETECTED: " + procName);

                                    // Classify active window context
                                    std::string windowTitle = GetActiveWindowTitle();
                                    std::string classification = "Public";
                                    if (m_classifier) classification = m_classifier(windowTitle, procName);

                                    bool isSensitive = (classification == "Restricted" || classification == "Confidential");
                                    std::string action = isSensitive ? "Block" : "Allow";

                                    if (isSensitive) {
                                        TerminateProcessByName(procName);
                                        if (m_logger) m_logger("WARNING", "SCREEN_ACTION_ENFORCED: Terminated " +
                                                               procName + " — " + classification + " data visible");
                                    }

                                    ScreenCaptureEvent event;
                                    event.method = "capture_tool";
                                    event.processName = procName;
                                    event.activeWindow = windowTitle;
                                    event.user = username;
                                    event.classification = classification;
                                    event.containsSensitiveData = isSensitive;
                                    event.actionTaken = action;
                                    event.timestamp = GetTimestamp();

                                    if (m_callback) m_callback(event);
                                }
                            }
                        }
                    } while (Process32Next(hSnap, &pe));
                }
                CloseHandle(hSnap);
                knownCapProcesses = currentCapProcesses;
            }
        }

        Sleep(100);
    }
}
