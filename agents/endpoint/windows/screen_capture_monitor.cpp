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
/*
 * BLOCK-FIRST-OCR-SECOND ARCHITECTURE:
 *
 * 1. EVERY PrintScreen/Win+Shift+S is SWALLOWED immediately (return 1)
 * 2. Background thread captures screen → runs OCR → classifies text
 * 3. If Public → programmatically take screenshot and put it on clipboard
 *    + show "Snapshot allowed" toast
 * 4. If Sensitive → keep clipboard empty + show "Snapshot blocked" popup
 *
 * This ensures OCR has time to run without the Windows 200ms hook timeout.
 */
LRESULT CALLBACK ScreenCaptureMonitor::LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && s_instance) {
        KBDLLHOOKSTRUCT* pKey = (KBDLLHOOKSTRUCT*)lParam;

        if (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN) {

            // ── PrintScreen ──
            if (pKey->vkCode == VK_SNAPSHOT) {
                bool altDown = (pKey->flags & LLKHF_ALTDOWN) != 0;
                std::string method = altDown ? "alt_printscreen" : "printscreen";
                HWND targetWindow = altDown ? GetForegroundWindow() : NULL;

                if (s_instance->m_logger) s_instance->m_logger("INFO",
                    "SCREEN_CAPTURE_KEY_DETECTED: " + method + " — intercepted, running OCR...");

                // SWALLOW the key — then analyze in background
                std::thread([method, targetWindow]() {
                    if (!s_instance) return;

                    // Run the classifier (which does OCR)
                    std::string windowTitle = s_instance->GetActiveWindowTitle();
                    std::string classification = "Public";
                    if (s_instance->m_classifier) classification = s_instance->m_classifier(windowTitle, "");

                    bool isSensitive = (classification == "Restricted" || classification == "Confidential");

                    if (isSensitive) {
                        // BLOCKED — clear clipboard and notify
                        if (OpenClipboard(NULL)) { EmptyClipboard(); CloseClipboard(); }

                        if (s_instance->m_logger) s_instance->m_logger("WARNING",
                            "SCREEN_ACTION_ENFORCED: BLOCKED " + method +
                            " — " + classification + " content detected on screen");

                        // Show popup on top of active window
                        HWND fgWnd = GetForegroundWindow();
                        DWORD fgThread = GetWindowThreadProcessId(fgWnd, NULL);
                        DWORD curThread = GetCurrentThreadId();
                        AttachThreadInput(curThread, fgThread, TRUE);
                        MessageBoxA(fgWnd,
                            "Sensitive content detected. Snapshot blocked.\n\n"
                            "CyberSentinel DLP detected restricted/confidential data\n"
                            "on screen. Screenshots are not allowed.",
                            "CyberSentinel DLP - Snapshot Blocked",
                            MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND | MB_SYSTEMMODAL);
                        AttachThreadInput(curThread, fgThread, FALSE);

                        s_instance->HandleCaptureAttempt(method);

                    } else {
                        // ALLOWED — programmatically take the screenshot and put it on clipboard
                        if (s_instance->m_logger) s_instance->m_logger("INFO",
                            "SCREEN_POLICY_DECISION: ALLOW — no sensitive data on screen");

                        // Capture screen to clipboard programmatically
                        HDC hScreenDC = GetDC(targetWindow); // NULL = full screen
                        if (!hScreenDC) hScreenDC = GetDC(NULL);
                        int w = targetWindow ? 0 : GetSystemMetrics(SM_CXSCREEN);
                        int h = targetWindow ? 0 : GetSystemMetrics(SM_CYSCREEN);
                        if (targetWindow) {
                            RECT rc; GetClientRect(targetWindow, &rc);
                            w = rc.right - rc.left; h = rc.bottom - rc.top;
                        }

                        HDC hMemDC = CreateCompatibleDC(hScreenDC);
                        HBITMAP hBitmap = CreateCompatibleBitmap(hScreenDC, w, h);
                        SelectObject(hMemDC, hBitmap);
                        BitBlt(hMemDC, 0, 0, w, h, hScreenDC, 0, 0, SRCCOPY);

                        // Put on clipboard
                        if (OpenClipboard(NULL)) {
                            EmptyClipboard();
                            SetClipboardData(CF_BITMAP, hBitmap);
                            CloseClipboard();
                        }

                        DeleteDC(hMemDC);
                        ReleaseDC(targetWindow, hScreenDC);
                        // Note: hBitmap is now owned by clipboard, don't delete

                        // Show brief allowed notification
                        if (s_instance->m_logger) s_instance->m_logger("INFO",
                            "SCREEN_ACTION_ENFORCED: ALLOWED — screenshot placed on clipboard");

                        s_instance->HandleCaptureAttempt(method);
                    }
                }).detach();

                return 1; // ALWAYS swallow — background thread handles the rest
            }

            // ── Win+Shift+S ──
            if (pKey->vkCode == 0x53) {
                bool winDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
                bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;

                if (winDown && shiftDown) {
                    if (s_instance->m_logger) s_instance->m_logger("INFO",
                        "SCREEN_CAPTURE_KEY_DETECTED: win_shift_s — intercepted, running OCR...");

                    std::thread([]() {
                        if (!s_instance) return;

                        std::string windowTitle = s_instance->GetActiveWindowTitle();
                        std::string classification = "Public";
                        if (s_instance->m_classifier) classification = s_instance->m_classifier(windowTitle, "");

                        bool isSensitive = (classification == "Restricted" || classification == "Confidential");

                        if (isSensitive) {
                            if (OpenClipboard(NULL)) { EmptyClipboard(); CloseClipboard(); }

                            if (s_instance->m_logger) s_instance->m_logger("WARNING",
                                "SCREEN_ACTION_ENFORCED: BLOCKED Win+Shift+S — sensitive content on screen");

                            HWND fgWnd = GetForegroundWindow();
                            DWORD fgThread = GetWindowThreadProcessId(fgWnd, NULL);
                            DWORD curThread = GetCurrentThreadId();
                            AttachThreadInput(curThread, fgThread, TRUE);
                            MessageBoxA(fgWnd,
                                "Sensitive content detected. Snapshot blocked.\n\n"
                                "CyberSentinel DLP detected restricted/confidential data\n"
                                "on screen. Snip & Sketch is not allowed.",
                                "CyberSentinel DLP - Snapshot Blocked",
                                MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND | MB_SYSTEMMODAL);
                            AttachThreadInput(curThread, fgThread, FALSE);

                            s_instance->HandleCaptureAttempt("win_shift_s");
                        } else {
                            if (s_instance->m_logger) s_instance->m_logger("INFO",
                                "SCREEN_POLICY_DECISION: ALLOW Win+Shift+S — no sensitive data");

                            // Simulate Win+Shift+S by launching Snipping Tool
                            system("start ms-screenclip: >nul 2>&1");

                            s_instance->HandleCaptureAttempt("win_shift_s");
                        }
                    }).detach();

                    return 1; // ALWAYS swallow
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
