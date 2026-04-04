#include "screen_capture_monitor.h"
#include <tlhelp32.h>
#include <iostream>
#include <algorithm>
#include <set>
#include <chrono>

// Static members
ScreenCaptureMonitor* ScreenCaptureMonitor::s_instance = nullptr;
HHOOK ScreenCaptureMonitor::s_keyboardHook = NULL;

const std::vector<std::string> ScreenCaptureMonitor::CAPTURE_PROCESSES = {
    "SnippingTool.exe", "ScreenClippingHost.exe", "ScreenSketch.exe",
    "Greenshot.exe", "ShareX.exe", "LightShot.exe", "lightshot.exe",
    "Snagit32.exe", "Snagit.exe", "obs64.exe", "obs32.exe",
    "CamtasiaStudio.exe", "Bandicam.exe", "ScreenToGif.exe",
    "FlameShot.exe", "PicPick.exe", "FastStone.exe"
};

ScreenCaptureMonitor::ScreenCaptureMonitor(CaptureCallback callback, LogCallback logger, ClassifyCallback classifier)
    : m_callback(std::move(callback)), m_logger(std::move(logger)), m_classifier(std::move(classifier)) {
    s_instance = this;
}

ScreenCaptureMonitor::~ScreenCaptureMonitor() {
    Stop();
    s_instance = nullptr;
}

bool ScreenCaptureMonitor::Start() {
    if (m_running) return true;
    m_running = true;
    m_hookThread = std::thread(&ScreenCaptureMonitor::HookThread, this);
    m_processThread = std::thread(&ScreenCaptureMonitor::ProcessMonitorThread, this);
    if (m_logger) m_logger("INFO", "Screen capture monitor started (keyboard hook + process monitor)");
    return true;
}

void ScreenCaptureMonitor::Stop() {
    m_running = false;
    // Unhook
    if (s_keyboardHook) {
        UnhookWindowsHookEx(s_keyboardHook);
        s_keyboardHook = NULL;
    }
    // Post quit to hook thread's message loop
    if (m_hookThread.joinable()) {
        PostThreadMessage(GetThreadId((HANDLE)m_hookThread.native_handle()), WM_QUIT, 0, 0);
        m_hookThread.join();
    }
    if (m_processThread.joinable()) m_processThread.join();
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
    t += 19800;
    struct tm tm_buf;
    gmtime_s(&tm_buf, &t);
    char buf[64];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d+05:30",
             tm_buf.tm_year + 1900, tm_buf.tm_mon + 1, tm_buf.tm_mday,
             tm_buf.tm_hour, tm_buf.tm_min, tm_buf.tm_sec);
    return buf;
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
                }
            }
        } while (Process32Next(hSnap, &pe));
    }
    CloseHandle(hSnap);
}

void ScreenCaptureMonitor::HandleCaptureAttempt(const std::string& method) {
    std::string windowTitle = GetActiveWindowTitle();
    std::string processName = GetForegroundProcessName();

    std::string classification = "Public";
    if (m_classifier) classification = m_classifier(windowTitle, processName);

    if (m_logger) m_logger("INFO", "SCREEN_CONTEXT_CLASSIFIED: " + classification +
                           " | Window: " + windowTitle);

    bool isSensitive = (classification == "Restricted" || classification == "Confidential");
    std::string action = isSensitive ? "Block" : "Allow";

    if (m_logger) m_logger("INFO", "SCREEN_POLICY_DECISION: " + action +
                           " (classification=" + classification + ")");

    if (isSensitive) {
        // Clear clipboard to remove any screenshot that got through
        if (OpenClipboard(NULL)) {
            EmptyClipboard();
            CloseClipboard();
        }
        // Show popup on TOP of the sensitive window
        HWND fgWindow = GetForegroundWindow();
        std::thread([fgWindow]() {
            // Force our popup to the absolute foreground
            DWORD fgThread = GetWindowThreadProcessId(fgWindow, NULL);
            DWORD curThread = GetCurrentThreadId();
            AttachThreadInput(curThread, fgThread, TRUE);
            SetForegroundWindow(fgWindow);

            MessageBoxA(fgWindow,
                "Screenshot blocked by CyberSentinel DLP.\n\n"
                "The active window contains sensitive/restricted data.\n"
                "Screenshots are not allowed for this page.",
                "CyberSentinel DLP - Screenshot Blocked",
                MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND | MB_SYSTEMMODAL);

            AttachThreadInput(curThread, fgThread, FALSE);
        }).detach();

        if (m_logger) m_logger("WARNING", "SCREEN_ACTION_ENFORCED: BLOCKED " + method +
                               " — " + classification + " data visible in: " + windowTitle);
    }

    // Build and send event
    char username[256] = {0};
    DWORD userSize = sizeof(username);
    GetUserNameA(username, &userSize);

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

/*
 * LOW-LEVEL KEYBOARD HOOK — intercepts PrintScreen BEFORE Windows processes it.
 *
 * This is the ONLY reliable way to prevent screenshots.
 * GetAsyncKeyState detects AFTER the key is processed (too late).
 * WH_KEYBOARD_LL catches the key in the input pipeline BEFORE
 * the system captures the screen.
 *
 * Return 1 to SWALLOW the key (prevent screenshot).
 * Return CallNextHookEx to ALLOW it.
 */
LRESULT CALLBACK ScreenCaptureMonitor::LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && s_instance) {
        KBDLLHOOKSTRUCT* pKey = (KBDLLHOOKSTRUCT*)lParam;

        if (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN) {
            // Detect PrintScreen key (VK_SNAPSHOT = 0x2C)
            if (pKey->vkCode == VK_SNAPSHOT) {
                bool altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
                std::string method = altDown ? "alt_printscreen" : "printscreen";

                if (s_instance->m_logger) s_instance->m_logger("INFO", "SCREEN_CAPTURE_KEY_DETECTED: " + method);

                // Check if sensitive data is visible
                std::string windowTitle = s_instance->GetActiveWindowTitle();
                std::string processName = s_instance->GetForegroundProcessName();

                std::string classification = "Public";
                if (s_instance->m_classifier) classification = s_instance->m_classifier(windowTitle, processName);

                bool isSensitive = (classification == "Restricted" || classification == "Confidential");

                if (isSensitive) {
                    if (s_instance->m_logger) s_instance->m_logger("WARNING",
                        "SCREEN_ACTION_ENFORCED: SWALLOWED PrintScreen key — " +
                        classification + " data visible in: " + windowTitle);

                    // Send event
                    s_instance->HandleCaptureAttempt(method);

                    // SWALLOW the key — return 1 to prevent Windows from capturing screenshot
                    return 1;
                } else {
                    // Non-sensitive — allow the screenshot
                    s_instance->HandleCaptureAttempt(method);
                }
            }

            // Detect Win+Shift+S (Snip & Sketch)
            // S key = 0x53
            if (pKey->vkCode == 0x53) {
                bool winDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
                bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;

                if (winDown && shiftDown) {
                    if (s_instance->m_logger) s_instance->m_logger("INFO", "SCREEN_CAPTURE_KEY_DETECTED: win_shift_s");

                    std::string windowTitle = s_instance->GetActiveWindowTitle();
                    std::string classification = "Public";
                    if (s_instance->m_classifier) classification = s_instance->m_classifier(windowTitle, "");

                    bool isSensitive = (classification == "Restricted" || classification == "Confidential");

                    if (isSensitive) {
                        if (s_instance->m_logger) s_instance->m_logger("WARNING",
                            "SCREEN_ACTION_ENFORCED: SWALLOWED Win+Shift+S — " +
                            classification + " data visible");

                        s_instance->HandleCaptureAttempt("win_shift_s");
                        return 1; // SWALLOW
                    } else {
                        s_instance->HandleCaptureAttempt("win_shift_s");
                    }
                }
            }
        }
    }
    return CallNextHookEx(s_keyboardHook, nCode, wParam, lParam);
}

/*
 * Hook thread — installs the keyboard hook and runs the message loop.
 * The hook only works while a message loop is running in the same thread.
 */
void ScreenCaptureMonitor::HookThread() {
    // Install low-level keyboard hook
    s_keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc, NULL, 0);

    if (!s_keyboardHook) {
        if (m_logger) m_logger("ERROR", "Failed to install keyboard hook: " + std::to_string(GetLastError()));
        return;
    }

    if (m_logger) m_logger("INFO", "Low-level keyboard hook installed — PrintScreen interception active");

    // Message loop — REQUIRED for the hook to work
    MSG msg;
    while (m_running) {
        // Use PeekMessage with a timeout so we can check m_running
        if (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) break;
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        } else {
            Sleep(50); // Don't spin CPU
        }
    }

    if (s_keyboardHook) {
        UnhookWindowsHookEx(s_keyboardHook);
        s_keyboardHook = NULL;
    }
}

/*
 * Process monitor thread — detects screenshot tool processes.
 * Separate from the hook thread to avoid blocking the message loop.
 */
void ScreenCaptureMonitor::ProcessMonitorThread() {
    std::set<std::string> knownCapProcesses;

    while (m_running) {
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

                                std::string windowTitle = GetActiveWindowTitle();
                                std::string classification = "Public";
                                if (m_classifier) classification = m_classifier(windowTitle, procName);

                                bool isSensitive = (classification == "Restricted" || classification == "Confidential");

                                if (isSensitive) {
                                    TerminateProcessByName(procName);
                                    // Also clear clipboard
                                    if (OpenClipboard(NULL)) { EmptyClipboard(); CloseClipboard(); }
                                    if (m_logger) m_logger("WARNING", "SCREEN_ACTION_ENFORCED: Terminated " +
                                                           procName + " — " + classification + " data visible");
                                }

                                HandleCaptureAttempt("capture_tool");
                            }
                        }
                    }
                } while (Process32Next(hSnap, &pe));
            }
            CloseHandle(hSnap);
            knownCapProcesses = currentCapProcesses;
        }

        // Check every 2 seconds
        for (int i = 0; i < 20 && m_running; i++) Sleep(100);
    }
}
