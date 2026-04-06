#include "screen_recording_monitor.h"

#include <tlhelp32.h>
#include <psapi.h>
#include <algorithm>
#include <chrono>
#include <sstream>
#include <vector>

#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace {

constexpr wchar_t kOverlayClassName[] = L"CyberSentinelDLPProtectionOverlay";

// Known screen recording / capture tool executable names (lowercase, no path).
const std::vector<std::string>& KnownRecorders() {
    static const std::vector<std::string> v = {
        // OBS family
        "obs64.exe", "obs32.exe", "obs.exe",
        // Microsoft built-ins
        "xboxgamebar.exe", "gamebar.exe", "gamebarft.exe", "gamebarftserver.exe",
        "gamingservices.exe", "broadcastdvr.exe", "broadcastdvrserver.exe",
        "screenclippinghost.exe", "snippingtool.exe", "screensketch.exe",
        "snipandsketch.exe",
        // Conferencing tools (often record)
        "zoom.exe", "cpthost.exe",
        "teams.exe", "ms-teams.exe", "msteams.exe",
        "webexmta.exe", "atmgr.exe",
        // Dedicated recorders
        "camtasia.exe", "camtasiastudio.exe", "camrec.exe",
        "bandicam.exe", "bdcam.exe",
        "fraps.exe",
        "sharex.exe",
        "screenpresso.exe",
        "screenrec.exe",
        "screencast-o-matic.exe", "screencastomatic.exe", "som.exe",
        "action.exe", "mirillis.exe",
        "dxtory.exe",
        "ezvid.exe",
        "debut.exe",
        "icecreamscreenrecorder.exe",
        "flashback.exe", "fbrecorder.exe",
        "loom.exe",
        "vlc.exe",   // VLC can record desktop
        "ffmpeg.exe", // command-line capture
        "movavi.exe", "screen recorder.exe",
        "apowersoft.exe", "apowerrec.exe",
    };
    return v;
}

// Substrings that, when found in the executable name OR window title of an
// otherwise-unknown process, suggest a renamed/evasive recorder.
const std::vector<std::string>& EvasionKeywords() {
    static const std::vector<std::string> v = {
        "record", "recorder", "capture", "screencap", "screencast",
        "screen rec", "screen capture", "desktop dup", "screenshot"
    };
    return v;
}

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    return s;
}

std::string Narrow(const wchar_t* w) {
    if (!w) return {};
    int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 1) return {};
    std::string out(len - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
    return out;
}

} // namespace

// ══════════════════════════════════════════════════════════════════════════
// Construction / lifecycle
// ══════════════════════════════════════════════════════════════════════════

ScreenRecordingMonitor::ScreenRecordingMonitor(EventCallback eventCb,
                                               LogCallback logger,
                                               ClassifyCallback classifier)
    : m_eventCb(std::move(eventCb)),
      m_logger(std::move(logger)),
      m_classifier(std::move(classifier)) {}

ScreenRecordingMonitor::~ScreenRecordingMonitor() { Stop(); }

bool ScreenRecordingMonitor::Start() {
    if (m_running.exchange(true)) return true;

    m_overlayThread = std::thread(&ScreenRecordingMonitor::OverlayThread, this);
    m_processThread = std::thread(&ScreenRecordingMonitor::ProcessDetectionLoop, this);
    m_contentThread = std::thread(&ScreenRecordingMonitor::ContentMonitorLoop, this);

    if (m_logger) m_logger("INFO", "Screen recording monitor started");
    return true;
}

void ScreenRecordingMonitor::Stop() {
    if (!m_running.exchange(false)) return;

    // Tear down overlay thread message pump
    HWND hwnd = m_overlayHwnd.load();
    if (hwnd) {
        PostMessage(hwnd, WM_CLOSE, 0, 0);
    } else if (m_overlayThreadId != 0) {
        PostThreadMessage(m_overlayThreadId, WM_QUIT, 0, 0);
    }

    if (m_processThread.joinable()) m_processThread.join();
    if (m_contentThread.joinable()) m_contentThread.join();
    if (m_overlayThread.joinable()) m_overlayThread.join();

    if (m_logger) m_logger("INFO", "Screen recording monitor stopped");
}

// ══════════════════════════════════════════════════════════════════════════
// Process detection
// ══════════════════════════════════════════════════════════════════════════

bool ScreenRecordingMonitor::IsKnownRecorderName(const std::string& exeNameLower,
                                                 std::string& matchedOut) const {
    for (const auto& name : KnownRecorders()) {
        if (exeNameLower == name) {
            matchedOut = name;
            return true;
        }
    }
    return false;
}

bool ScreenRecordingMonitor::LooksLikeEvasiveRecorder(const std::string& exeNameLower,
                                                      const std::string& windowTitleLower) const {
    for (const auto& kw : EvasionKeywords()) {
        if (exeNameLower.find(kw) != std::string::npos) return true;
        if (!windowTitleLower.empty() && windowTitleLower.find(kw) != std::string::npos) return true;
    }
    return false;
}

void ScreenRecordingMonitor::ProcessDetectionLoop() {
    while (m_running.load()) {
        bool foundRecorder = false;
        bool foundEvasive  = false;
        std::string matchedProc;

        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe{};
            pe.dwSize = sizeof(pe);
            if (Process32FirstW(snap, &pe)) {
                do {
                    std::string exeName = ToLower(Narrow(pe.szExeFile));
                    if (exeName.empty()) continue;

                    std::string matched;
                    if (IsKnownRecorderName(exeName, matched)) {
                        foundRecorder = true;
                        matchedProc   = matched;
                        if (m_logger) {
                            m_logger("INFO", "RECORDING_PROCESS_DETECTED: " + matched);
                        }
                        break;
                    }

                    // Cheap evasion heuristic: name itself contains "record"/"capture"/etc.
                    if (LooksLikeEvasiveRecorder(exeName, std::string())) {
                        foundEvasive = true;
                        matchedProc  = exeName;
                    }
                } while (Process32NextW(snap, &pe));
            }
            CloseHandle(snap);
        }

        if (!foundRecorder && foundEvasive) {
            foundRecorder = true;
            if (!m_evasionFlagged.exchange(true)) {
                if (m_logger) {
                    m_logger("WARNING",
                             "SCREEN_RECORDING_EVASION_DETECTED: suspicious process " + matchedProc);
                }
            }
        } else if (!foundEvasive) {
            m_evasionFlagged.store(false);
        }

        bool wasActive = m_recordingActive.load();
        if (foundRecorder && !wasActive) {
            {
                std::lock_guard<std::mutex> lk(m_recProcMutex);
                m_recordingProcess = matchedProc;
            }
            m_recordingActive.store(true);
            if (m_logger) m_logger("WARNING", "SCREEN_RECORDING_STARTED: " + matchedProc);
            EmitEvent("ALLOW", false, "Public", std::string(), m_evasionFlagged.load());
        } else if (!foundRecorder && wasActive) {
            std::string lastProc;
            {
                std::lock_guard<std::mutex> lk(m_recProcMutex);
                lastProc = m_recordingProcess;
                m_recordingProcess.clear();
            }
            m_recordingActive.store(false);
            // Make sure overlay is dropped on stop.
            RequestOverlayHide();
            if (m_logger) m_logger("INFO", "SCREEN_RECORDING_STOPPED: " + lastProc);
            EmitEvent("ALLOW", false, "Public", std::string(), false);
        }

        // 2 second cadence — process scanning is the expensive part.
        for (int i = 0; i < 20 && m_running.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Content monitoring (only runs while a recorder is active)
// ══════════════════════════════════════════════════════════════════════════

void ScreenRecordingMonitor::ContentMonitorLoop() {
    while (m_running.load()) {
        if (!m_recordingActive.load()) {
            // No recording — sleep cheaply, ensure overlay hidden, drop cache.
            if (m_overlayShouldShow.load()) RequestOverlayHide();
            m_lastWindowSig.clear();
            m_lastClassification.clear();
            std::this_thread::sleep_for(std::chrono::milliseconds(300));
            continue;
        }

        std::string title   = GetForegroundWindowTitle();
        std::string process = GetForegroundProcessName();
        std::string sig     = process + "|" + title;

        std::string classification = "Public";
        if (sig == m_lastWindowSig && !m_lastClassification.empty()) {
            classification = m_lastClassification;
        } else if (m_classifier) {
            try {
                classification = m_classifier(title, process);
            } catch (...) {
                classification = "Public";
            }
            m_lastWindowSig      = sig;
            m_lastClassification = classification;

            if (m_logger) {
                m_logger("INFO", "SCREEN_CONTENT_CLASSIFIED: " + classification +
                                 " — " + process + " — " + title);
            }
        }

        bool sensitive = (classification == "Confidential" || classification == "Restricted");

        if (sensitive && !m_overlayShouldShow.load()) {
            RequestOverlayShow();
            if (m_logger) {
                m_logger("WARNING", "SCREEN_PROTECTION_ENABLED: " + classification +
                                    " content visible during recording (" + process + ")");
            }
            EmitEvent("BLUR", true, classification, title, m_evasionFlagged.load());
        } else if (!sensitive && m_overlayShouldShow.load()) {
            RequestOverlayHide();
            if (m_logger) m_logger("INFO", "SCREEN_PROTECTION_DISABLED: foreground no longer sensitive");
            EmitEvent("ALLOW", false, classification, title, m_evasionFlagged.load());
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }

    // On shutdown, make sure overlay is gone.
    if (m_overlayShouldShow.load()) RequestOverlayHide();
}

// ══════════════════════════════════════════════════════════════════════════
// Overlay window — owns its own UI thread + message pump
// ══════════════════════════════════════════════════════════════════════════

LRESULT CALLBACK ScreenRecordingMonitor::OverlayWndProc(HWND hwnd, UINT msg,
                                                        WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hwnd, &ps);
            RECT rc; GetClientRect(hwnd, &rc);

            // Heavy black mask. The window itself uses LWA_ALPHA to set translucency,
            // so painting solid black gives a uniform "blackout" effect that obscures
            // any sensitive content from desktop-duplication / GDI screen captures.
            HBRUSH bg = CreateSolidBrush(RGB(0, 0, 0));
            FillRect(hdc, &rc, bg);
            DeleteObject(bg);

            // Status banner so the user understands what's happening.
            const wchar_t* line1 = L"DLP — PROTECTED CONTENT";
            const wchar_t* line2 = L"Sensitive data is hidden while screen recording is active.";
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, RGB(255, 80, 80));

            HFONT bigFont = CreateFontW(48, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
                                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                        DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
            HFONT oldFont = (HFONT)SelectObject(hdc, bigFont);

            RECT r1 = rc; r1.bottom = rc.bottom / 2;
            DrawTextW(hdc, line1, -1, &r1, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

            HFONT smallFont = CreateFontW(24, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                          DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
            SelectObject(hdc, smallFont);
            SetTextColor(hdc, RGB(220, 220, 220));
            RECT r2 = rc; r2.top = rc.bottom / 2 + 16;
            DrawTextW(hdc, line2, -1, &r2, DT_CENTER | DT_TOP | DT_SINGLELINE);

            SelectObject(hdc, oldFont);
            DeleteObject(bigFont);
            DeleteObject(smallFont);

            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_ERASEBKGND:
            return 1;
        case WM_CLOSE:
            DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

void ScreenRecordingMonitor::OverlayThread() {
    m_overlayThreadId = GetCurrentThreadId();

    HINSTANCE hInst = GetModuleHandleW(nullptr);

    WNDCLASSEXW wc{};
    wc.cbSize        = sizeof(wc);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = OverlayWndProc;
    wc.hInstance     = hInst;
    wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.lpszClassName = kOverlayClassName;

    if (!RegisterClassExW(&wc)) {
        DWORD err = GetLastError();
        if (err != ERROR_CLASS_ALREADY_EXISTS) {
            if (m_logger) m_logger("ERROR", "Overlay RegisterClass failed: " + std::to_string(err));
            return;
        }
    }

    int sx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int sy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int sw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int sh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

    // WS_EX_TOPMOST  → always on top, captured by desktop duplication.
    // WS_EX_LAYERED  → required for SetLayeredWindowAttributes (alpha).
    // WS_EX_TRANSPARENT → click-through, mouse passes to underlying window.
    // WS_EX_TOOLWINDOW + WS_EX_NOACTIVATE → no taskbar entry, never steals focus.
    HWND hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        kOverlayClassName,
        L"CyberSentinel DLP Protection",
        WS_POPUP,
        sx, sy, sw, sh,
        nullptr, nullptr, hInst, nullptr);

    if (!hwnd) {
        if (m_logger) m_logger("ERROR", "Overlay CreateWindowEx failed: " + std::to_string(GetLastError()));
        return;
    }

    // Heavy alpha (≈92%) → effectively a blackout that obscures whatever is
    // underneath in any desktop-duplication or GDI capture.
    SetLayeredWindowAttributes(hwnd, 0, 235, LWA_ALPHA);

    m_overlayHwnd.store(hwnd);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message == WM_DLP_SHOW_OVERLAY) {
            // Re-assert geometry every show in case the virtual screen changed
            // (monitor (un)plugged, DPI change).
            int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            SetWindowPos(hwnd, HWND_TOPMOST, vx, vy, vw, vh,
                         SWP_NOACTIVATE | SWP_SHOWWINDOW);
            InvalidateRect(hwnd, nullptr, TRUE);
            m_overlayActive.store(true);
        } else if (msg.message == WM_DLP_HIDE_OVERLAY) {
            ShowWindow(hwnd, SW_HIDE);
            m_overlayActive.store(false);
        } else {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    m_overlayHwnd.store(nullptr);
}

void ScreenRecordingMonitor::RequestOverlayShow() {
    m_overlayShouldShow.store(true);
    if (m_overlayThreadId != 0) {
        PostThreadMessage(m_overlayThreadId, WM_DLP_SHOW_OVERLAY, 0, 0);
    }
}

void ScreenRecordingMonitor::RequestOverlayHide() {
    m_overlayShouldShow.store(false);
    if (m_overlayThreadId != 0) {
        PostThreadMessage(m_overlayThreadId, WM_DLP_HIDE_OVERLAY, 0, 0);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

std::string ScreenRecordingMonitor::GetForegroundWindowTitle() {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return {};
    wchar_t buf[1024]{};
    int n = GetWindowTextW(hwnd, buf, 1024);
    if (n <= 0) return {};
    return Narrow(buf);
}

std::string ScreenRecordingMonitor::GetForegroundProcessName() {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return {};
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!pid) return {};

    HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) return {};

    wchar_t path[MAX_PATH]{};
    DWORD len = MAX_PATH;
    std::string out;
    if (QueryFullProcessImageNameW(proc, 0, path, &len)) {
        std::wstring wp(path);
        size_t slash = wp.find_last_of(L"\\/");
        if (slash != std::wstring::npos) wp = wp.substr(slash + 1);
        out = Narrow(wp.c_str());
    }
    CloseHandle(proc);
    return out;
}

std::string ScreenRecordingMonitor::GetCurrentUserName() {
    char name[256]{};
    DWORD sz = sizeof(name);
    if (GetUserNameA(name, &sz)) return std::string(name);
    return "unknown";
}

std::string ScreenRecordingMonitor::Timestamp() {
    auto now = std::chrono::system_clock::now();
    auto t   = std::chrono::system_clock::to_time_t(now);
    t += 19800; // IST
    struct tm tmb;
    gmtime_s(&tmb, &t);
    char buf[64];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d+05:30",
             tmb.tm_year + 1900, tmb.tm_mon + 1, tmb.tm_mday,
             tmb.tm_hour, tmb.tm_min, tmb.tm_sec);
    return buf;
}

void ScreenRecordingMonitor::EmitEvent(const std::string& action,
                                       bool sensitive,
                                       const std::string& classification,
                                       const std::string& activeWindow,
                                       bool evasion) {
    if (!m_eventCb) return;
    ScreenRecordingEvent evt;
    {
        std::lock_guard<std::mutex> lk(m_recProcMutex);
        evt.processName = m_recordingProcess;
    }
    evt.user              = GetCurrentUserName();
    evt.recordingActive   = m_recordingActive.load();
    evt.sensitiveDetected = sensitive;
    evt.classification    = classification;
    evt.activeWindow      = activeWindow;
    evt.actionTaken       = action;
    evt.evasion           = evasion;
    evt.timestamp         = Timestamp();
    try { m_eventCb(evt); } catch (...) {}
}
