#include "video_redactor.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <sstream>

#pragma comment(lib, "user32.lib")

namespace {

const std::vector<std::string>& VideoExtensions() {
    static const std::vector<std::string> v = {
        ".mp4", ".mkv", ".mov", ".webm", ".avi", ".wmv", ".m4v", ".flv"
    };
    return v;
}

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    return s;
}

std::string Narrow(const wchar_t* w, int wlen = -1) {
    if (!w) return {};
    int len = WideCharToMultiByte(CP_UTF8, 0, w, wlen, nullptr, 0, nullptr, nullptr);
    if (len <= 0) return {};
    std::string out(static_cast<size_t>(len), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, wlen, out.data(), len, nullptr, nullptr);
    if (wlen == -1 && !out.empty() && out.back() == '\0') out.pop_back();
    return out;
}

long long NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

long long FileSize(const std::string& path) {
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &fad)) return -1;
    LARGE_INTEGER li;
    li.HighPart = fad.nFileSizeHigh;
    li.LowPart  = fad.nFileSizeLow;
    return li.QuadPart;
}

// Quote a path for use inside a command-line argument list.
std::string QuoteArg(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (char c : s) {
        if (c == '"') out.push_back('\\');
        out.push_back(c);
    }
    out.push_back('"');
    return out;
}

} // namespace

// ══════════════════════════════════════════════════════════════════════════

VideoRedactor::VideoRedactor(std::vector<std::string> watchDirs,
                             std::string pythonExe,
                             std::string scriptPath,
                             EventCallback eventCb,
                             LogCallback logger)
    : m_watchDirs(std::move(watchDirs)),
      m_pythonExe(std::move(pythonExe)),
      m_scriptPath(std::move(scriptPath)),
      m_eventCb(std::move(eventCb)),
      m_logger(std::move(logger)) {}

VideoRedactor::~VideoRedactor() { Stop(); }

bool VideoRedactor::Start() {
    if (m_running.exchange(true)) return true;

    // Make sure each watch directory exists — create it if missing so the
    // ReadDirectoryChangesW handle is valid even on a fresh user profile.
    for (const auto& dir : m_watchDirs) {
        DWORD attrs = GetFileAttributesA(dir.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES) {
            CreateDirectoryA(dir.c_str(), nullptr);
        }
    }

    for (const auto& dir : m_watchDirs) {
        m_watcherThreads.emplace_back(&VideoRedactor::WatcherThread, this, dir);
    }
    m_processorThread = std::thread(&VideoRedactor::ProcessorThread, this);

    if (m_logger) {
        m_logger("INFO", "Video redactor started — watching " +
                         std::to_string(m_watchDirs.size()) + " director(ies)");
        for (const auto& d : m_watchDirs) m_logger("INFO", "  watch: " + d);
    }
    return true;
}

void VideoRedactor::Stop() {
    if (!m_running.exchange(false)) return;

    // Unblock the processor's condvar so it can exit.
    m_queueCv.notify_all();

    for (auto& t : m_watcherThreads) {
        if (t.joinable()) t.join();
    }
    m_watcherThreads.clear();
    if (m_processorThread.joinable()) m_processorThread.join();

    if (m_logger) m_logger("INFO", "Video redactor stopped");
}

void VideoRedactor::NotifyRecordingStarted(const std::string& processName) {
    // Pre-arm so a video file that appears slightly before our process scan
    // catches the recorder shutdown is still accepted.
    long long wasArmedUntil = m_armedUntilMs.load();
    long long now           = NowMs();
    m_armedUntilMs.store(now + kPreArmedMs + kArmedWindowMs);

    // Throttle logging — this is now called every 2s while a recorder is
    // resident, so we only log on the transition from unarmed → armed
    // and then roughly once a minute thereafter.
    bool wasUnarmed = (now > wasArmedUntil);
    static std::atomic<long long> lastLogMs{0};
    long long last = lastLogMs.load();
    if (wasUnarmed || (now - last) > 60000) {
        lastLogMs.store(now);
        if (m_logger) {
            if (wasUnarmed) {
                m_logger("INFO", "VIDEO_REDACTOR_ARMED: recording active (" + processName +
                                 "), acceptance window = " +
                                 std::to_string(kArmedWindowMs / 1000) + "s");
            } else {
                m_logger("INFO", "VIDEO_REDACTOR_REFRESHED: recording still active (" + processName + ")");
            }
        }
    }
}

void VideoRedactor::NotifyRecordingStopped(const std::string& processName) {
    m_armedUntilMs.store(NowMs() + kArmedWindowMs);
    if (m_logger) m_logger("INFO", "VIDEO_REDACTOR_ARMED: recording stopped (" + processName +
                                   "), watching for saved file for " +
                                   std::to_string(kArmedWindowMs / 1000) + "s");
}

// ══════════════════════════════════════════════════════════════════════════
// Directory watcher thread
// ══════════════════════════════════════════════════════════════════════════

void VideoRedactor::WatcherThread(std::string dir) {
    HANDLE hDir = CreateFileA(
        dir.c_str(),
        FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr);

    if (hDir == INVALID_HANDLE_VALUE) {
        if (m_logger) m_logger("ERROR", "VideoRedactor: cannot open " + dir +
                                        " (err " + std::to_string(GetLastError()) + ")");
        return;
    }

    constexpr DWORD kBufBytes = 64 * 1024;
    std::vector<BYTE> buffer(kBufBytes);

    while (m_running.load()) {
        DWORD bytesReturned = 0;
        BOOL ok = ReadDirectoryChangesW(
            hDir,
            buffer.data(),
            kBufBytes,
            TRUE,  // recurse subdirs
            FILE_NOTIFY_CHANGE_FILE_NAME |
            FILE_NOTIFY_CHANGE_LAST_WRITE |
            FILE_NOTIFY_CHANGE_SIZE,
            &bytesReturned,
            nullptr,
            nullptr);

        if (!ok || bytesReturned == 0) {
            if (!m_running.load()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            continue;
        }

        BYTE* p = buffer.data();
        for (;;) {
            FILE_NOTIFY_INFORMATION* fni = reinterpret_cast<FILE_NOTIFY_INFORMATION*>(p);

            if (fni->Action == FILE_ACTION_ADDED ||
                fni->Action == FILE_ACTION_RENAMED_NEW_NAME ||
                fni->Action == FILE_ACTION_MODIFIED) {

                std::string name = Narrow(fni->FileName,
                                          fni->FileNameLength / sizeof(wchar_t));
                std::string fullPath = dir;
                if (!fullPath.empty() && fullPath.back() != '\\' && fullPath.back() != '/') {
                    fullPath.push_back('\\');
                }
                fullPath += name;

                if (IsVideoFile(fullPath)) {
                    EnqueueFile(fullPath);
                }
            }

            if (fni->NextEntryOffset == 0) break;
            p += fni->NextEntryOffset;
        }
    }

    CloseHandle(hDir);
}

bool VideoRedactor::IsVideoFile(const std::string& path) const {
    std::string lower = ToLower(path);
    for (const auto& ext : VideoExtensions()) {
        if (lower.size() >= ext.size() &&
            lower.compare(lower.size() - ext.size(), ext.size(), ext) == 0) {
            return true;
        }
    }
    return false;
}

void VideoRedactor::EnqueueFile(const std::string& path) {
    // Skip our own temporary output files outright.
    if (path.size() > 15 &&
        path.compare(path.size() - 15, 15, ".dlp_redact.tmp") == 0) {
        return;
    }

    // Self-redaction loop guard — any file we just successfully processed
    // is on the m_justWrote blocklist for ~5 minutes. This catches the
    // MoveFileEx-triggered MODIFIED event that would otherwise re-queue
    // our own output.
    {
        std::lock_guard<std::mutex> lk(m_justWroteMutex);
        auto cutoff = std::chrono::steady_clock::now() - std::chrono::minutes(5);
        m_justWrote.erase(
            std::remove_if(m_justWrote.begin(), m_justWrote.end(),
                [cutoff](const auto& p) { return p.second < cutoff; }),
            m_justWrote.end());
        for (const auto& [wrotePath, _] : m_justWrote) {
            if (wrotePath == path) {
                if (m_logger) m_logger("INFO",
                    "VIDEO_FILE_SKIPPED: " + path + " — recently processed by redactor");
                return;
            }
        }
    }

    // Acceptance window — only consider files that appeared close to a real
    // recording event. Falls back to "always armed" if NotifyRecording* was
    // never wired (defensive default of 0 means always-rejected, so callers
    // MUST call Notify*).
    long long now = NowMs();
    if (now > m_armedUntilMs.load()) {
        // Not currently armed — silently ignore.
        return;
    }

    // Suppress duplicates — same path within 10s.
    {
        std::lock_guard<std::mutex> lk(m_seenMutex);
        auto cutoff = std::chrono::steady_clock::now() - std::chrono::seconds(10);
        m_recentlySeen.erase(
            std::remove_if(m_recentlySeen.begin(), m_recentlySeen.end(),
                [cutoff](const auto& p) { return p.second < cutoff; }),
            m_recentlySeen.end());
        for (const auto& [seenPath, _] : m_recentlySeen) {
            if (seenPath == path) return;
        }
        m_recentlySeen.emplace_back(path, std::chrono::steady_clock::now());
    }

    if (m_logger) m_logger("INFO", "VIDEO_FILE_DETECTED: " + path);
    Emit(path, "detected", "new video file appeared in watched directory");

    {
        std::lock_guard<std::mutex> lk(m_queueMutex);
        m_pendingFiles.push(path);
    }
    m_queueCv.notify_one();
}

// ══════════════════════════════════════════════════════════════════════════
// Processor thread
// ══════════════════════════════════════════════════════════════════════════

void VideoRedactor::ProcessorThread() {
    while (m_running.load()) {
        std::string path;
        {
            std::unique_lock<std::mutex> lk(m_queueMutex);
            m_queueCv.wait(lk, [this] {
                return !m_running.load() || !m_pendingFiles.empty();
            });
            if (!m_running.load()) return;
            if (m_pendingFiles.empty()) continue;
            path = m_pendingFiles.front();
            m_pendingFiles.pop();
        }

        if (m_logger) m_logger("INFO", "VIDEO_REDACTION_QUEUED: " + path);

        // Wait for the recorder to finish flushing the file to disk.
        if (!WaitForFileStable(path)) {
            if (m_logger) m_logger("WARNING", "VIDEO_REDACTION_SKIPPED: " + path +
                                              " — file did not stabilize");
            Emit(path, "skipped", "file did not stabilize within timeout");
            continue;
        }

        long long origBytes = FileSize(path);
        Emit(path, "processing", "running redactor");
        if (m_logger) m_logger("INFO", "VIDEO_REDACTION_STARTED: " + path);

        int framesMasked = 0;
        int framesTotal  = 0;
        long long redactedBytes = 0;
        std::string err;

        bool ok = RunRedactor(path, framesMasked, framesTotal, redactedBytes, err);
        if (ok) {
            if (m_logger) m_logger("WARNING", "VIDEO_REDACTION_SUCCESS: " + path +
                                              " — masked " + std::to_string(framesMasked) +
                                              "/" + std::to_string(framesTotal) + " frames");
            Emit(path, "success", "redaction complete",
                 framesMasked, framesTotal, origBytes, redactedBytes);
        } else {
            if (m_logger) m_logger("ERROR", "VIDEO_REDACTION_FAILED: " + path + " — " + err);
            Emit(path, "failed", err);
        }
    }
}

bool VideoRedactor::WaitForFileStable(const std::string& path) {
    // Wait until the file size is unchanged for 3 consecutive checks at
    // 1.5s intervals (i.e. ≥4.5s of stability), with a hard timeout.
    long long lastSize = -1;
    int stableCount = 0;
    int totalChecks = 0;
    constexpr int kMaxChecks = 80; // ~120s ceiling

    while (m_running.load() && totalChecks < kMaxChecks) {
        long long sz = FileSize(path);
        if (sz < 0) {
            // File vanished — give up.
            return false;
        }
        if (sz == lastSize && sz > 0) {
            stableCount++;
            if (stableCount >= 3) return true;
        } else {
            stableCount = 0;
            lastSize = sz;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1500));
        totalChecks++;
    }
    return false;
}

bool VideoRedactor::RunRedactor(const std::string& path,
                                int& outFramesMasked,
                                int& outFramesTotal,
                                long long& outRedactedBytes,
                                std::string& outError) {
    // The Python helper writes the redacted output to a sibling temp file
    // and then atomically replaces the original on success.
    std::string outPath = path + ".dlp_redact.tmp";

    std::string cmd = QuoteArg(m_pythonExe) + " " +
                      QuoteArg(m_scriptPath) + " " +
                      QuoteArg(path) + " " +
                      QuoteArg(outPath);

    // Capture stdout for the masked-frame summary line.
    std::string stdoutLine;

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE hRead = nullptr, hWrite = nullptr;
    if (!CreatePipe(&hRead, &hWrite, &sa, 0)) {
        outError = "CreatePipe failed: " + std::to_string(GetLastError());
        return false;
    }
    SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si{};
    si.cb         = sizeof(si);
    si.dwFlags    = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = hWrite;
    si.hStdError  = hWrite;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);

    PROCESS_INFORMATION pi{};
    std::vector<char> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back('\0');

    BOOL launched = CreateProcessA(
        nullptr, cmdBuf.data(),
        nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW,
        nullptr, nullptr,
        &si, &pi);

    CloseHandle(hWrite);
    if (!launched) {
        CloseHandle(hRead);
        outError = "CreateProcess failed: " + std::to_string(GetLastError());
        return false;
    }

    char buf[4096];
    DWORD readBytes = 0;
    while (ReadFile(hRead, buf, sizeof(buf) - 1, &readBytes, nullptr) && readBytes > 0) {
        buf[readBytes] = '\0';
        stdoutLine += buf;
    }
    CloseHandle(hRead);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    // Always echo the helper's captured stdout/stderr into the agent log
    // (line by line, trimmed) so we can see exactly what it said even on
    // success. This is critical for diagnosing why redactions might miss.
    if (m_logger && !stdoutLine.empty()) {
        std::istringstream iss(stdoutLine);
        std::string ln;
        while (std::getline(iss, ln)) {
            while (!ln.empty() && (ln.back() == '\r' || ln.back() == '\n')) ln.pop_back();
            if (!ln.empty()) m_logger("INFO", "  [redactor] " + ln);
        }
    }

    if (exitCode != 0) {
        DeleteFileA(outPath.c_str());
        std::string reason = stdoutLine;
        if (reason.size() > 400) reason.resize(400);
        outError = "redactor exited with code " + std::to_string(exitCode) +
                   (reason.empty() ? "" : (": " + reason));
        return false;
    }

    // Parse "REDACTED: M/T frames masked" from stdout.
    {
        size_t pos = stdoutLine.find("REDACTED:");
        if (pos != std::string::npos) {
            int m = 0, t = 0;
            if (sscanf(stdoutLine.c_str() + pos, "REDACTED: %d/%d", &m, &t) == 2) {
                outFramesMasked = m;
                outFramesTotal  = t;
            }
        }
    }

    if (FileSize(outPath) <= 0) {
        outError = "redactor produced empty output";
        DeleteFileA(outPath.c_str());
        return false;
    }

    // Register the target path on the blocklist BEFORE the replace so the
    // watcher's MODIFIED event for our own write is already suppressed by
    // the time it arrives.
    {
        std::lock_guard<std::mutex> lk(m_justWroteMutex);
        m_justWrote.emplace_back(path, std::chrono::steady_clock::now());
    }

    // Atomically replace the original. MoveFileEx with REPLACE_EXISTING.
    if (!MoveFileExA(outPath.c_str(), path.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        // Remove the blocklist entry since the move failed.
        {
            std::lock_guard<std::mutex> lk(m_justWroteMutex);
            m_justWrote.erase(
                std::remove_if(m_justWrote.begin(), m_justWrote.end(),
                    [&path](const auto& p) { return p.first == path; }),
                m_justWrote.end());
        }
        outError = "MoveFileEx replace failed: " + std::to_string(GetLastError());
        DeleteFileA(outPath.c_str());
        return false;
    }

    outRedactedBytes = FileSize(path);
    return true;
}

// ══════════════════════════════════════════════════════════════════════════

std::string VideoRedactor::GetCurrentUserName() {
    char name[256]{};
    DWORD sz = sizeof(name);
    if (GetUserNameA(name, &sz)) return std::string(name);
    return "unknown";
}

std::string VideoRedactor::Timestamp() {
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

void VideoRedactor::Emit(const std::string& path, const std::string& status,
                         const std::string& reason,
                         int framesMasked, int framesTotal,
                         long long originalBytes, long long redactedBytes) {
    if (!m_eventCb) return;
    VideoRedactionEvent evt;
    evt.originalPath   = path;
    evt.status         = status;
    evt.reason         = reason;
    evt.user           = GetCurrentUserName();
    evt.framesMasked   = framesMasked;
    evt.framesTotal    = framesTotal;
    evt.originalBytes  = originalBytes;
    evt.redactedBytes  = redactedBytes;
    evt.timestamp      = Timestamp();
    try { m_eventCb(evt); } catch (...) {}
}
