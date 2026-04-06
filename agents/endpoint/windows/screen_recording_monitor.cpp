#include "screen_recording_monitor.h"

#include <tlhelp32.h>
#include <algorithm>
#include <chrono>

#pragma comment(lib, "user32.lib")

namespace {

// Strict whitelist of processes that a user only launches when they
// actually want to record the screen. NO Game Bar (always running on
// Win10/11), NO zoom/teams/webex (always running messengers), NO
// vlc/ffmpeg (false positives).
const std::vector<std::string>& KnownRecorders() {
    static const std::vector<std::string> v = {
        // OBS family
        "obs64.exe", "obs32.exe", "obs.exe",

        // Windows Snipping Tool — modern Win11 SnippingTool.exe handles
        // both screenshots and video recording. Only launched on demand.
        "snippingtool.exe",

        // Dedicated screen recorders
        "camtasia.exe", "camtasiastudio.exe", "camrec.exe", "camrecorder.exe",
        "bandicam.exe", "bdcam.exe",
        "screenrec.exe",
        "screenpresso.exe",
        "screencast-o-matic.exe", "screencastomatic.exe", "som.exe",
        "loom.exe",
        "action.exe",
        "mirillis.exe",
        "dxtory.exe",
        "icecreamscreenrecorder.exe",
        "flashback.exe", "fbrecorder.exe",
        "apowersoft.exe", "apowerrec.exe",
        "movavi.exe", "movaviscreenrecorder.exe",
        "debut.exe",
        "ezvid.exe",
        "fraps.exe",
        "sharex.exe",
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

ScreenRecordingMonitor::ScreenRecordingMonitor(EventCallback eventCb,
                                               LogCallback logger)
    : m_eventCb(std::move(eventCb)), m_logger(std::move(logger)) {}

ScreenRecordingMonitor::~ScreenRecordingMonitor() { Stop(); }

bool ScreenRecordingMonitor::Start() {
    if (m_running.exchange(true)) return true;
    m_processThread = std::thread(&ScreenRecordingMonitor::ProcessDetectionLoop, this);
    if (m_logger) m_logger("INFO", "Screen recording monitor started (process detection only)");
    return true;
}

void ScreenRecordingMonitor::Stop() {
    if (!m_running.exchange(false)) return;
    if (m_processThread.joinable()) m_processThread.join();
    if (m_logger) m_logger("INFO", "Screen recording monitor stopped");
}

bool ScreenRecordingMonitor::IsKnownRecorderName(const std::string& exeNameLower,
                                                 std::string& matchedOut) const {
    for (const auto& name : KnownRecorders()) {
        if (exeNameLower == name) { matchedOut = name; return true; }
    }
    return false;
}

void ScreenRecordingMonitor::ProcessDetectionLoop() {
    while (m_running.load()) {
        bool foundRecorder = false;
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
                        if (m_logger) m_logger("INFO", "RECORDING_PROCESS_DETECTED: " + matched);
                        break;
                    }
                } while (Process32NextW(snap, &pe));
            }
            CloseHandle(snap);
        }

        bool wasActive = m_recordingActive.load();
        if (foundRecorder && !wasActive) {
            {
                std::lock_guard<std::mutex> lk(m_recProcMutex);
                m_recordingProcess = matchedProc;
            }
            m_recordingActive.store(true);
            if (m_logger) m_logger("WARNING", "SCREEN_RECORDING_STARTED: " + matchedProc);
            EmitEvent("STARTED");
            if (m_onStartedCb) try { m_onStartedCb(matchedProc); } catch (...) {}
        } else if (!foundRecorder && wasActive) {
            std::string lastProc;
            {
                std::lock_guard<std::mutex> lk(m_recProcMutex);
                lastProc = m_recordingProcess;
                m_recordingProcess.clear();
            }
            m_recordingActive.store(false);
            if (m_logger) m_logger("WARNING", "SCREEN_RECORDING_STOPPED: " + lastProc +
                                              " — arming video redactor");
            EmitEvent("STOPPED");
            if (m_onStoppedCb) try { m_onStoppedCb(lastProc); } catch (...) {}
        }

        for (int i = 0; i < 20 && m_running.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
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

void ScreenRecordingMonitor::EmitEvent(const std::string& action) {
    if (!m_eventCb) return;
    ScreenRecordingEvent evt;
    {
        std::lock_guard<std::mutex> lk(m_recProcMutex);
        evt.processName = m_recordingProcess;
    }
    evt.user            = GetCurrentUserName();
    evt.recordingActive = m_recordingActive.load();
    evt.actionTaken     = action;
    evt.timestamp       = Timestamp();
    try { m_eventCb(evt); } catch (...) {}
}
