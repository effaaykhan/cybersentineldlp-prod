#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <functional>
#include <chrono>

// Event emitted at every stage of the post-recording redaction pipeline.
struct VideoRedactionEvent {
    std::string eventType = "video_redaction";
    std::string originalPath;     // path to the saved recording
    std::string status;           // detected | processing | success | failed | skipped
    std::string reason;           // human-readable detail
    std::string user;
    int         framesMasked   = 0;
    int         framesTotal    = 0;
    long long   originalBytes  = 0;
    long long   redactedBytes  = 0;
    std::string timestamp;
};

// VideoRedactor monitors a list of directories for newly-created video files
// (mp4 / mkv / mov / webm / avi / wmv) and, when one appears within a short
// window after a screen-recording process exited, post-processes it by
// invoking a Python helper that:
//   1. Reads each frame.
//   2. Periodically OCRs sampled frames with Tesseract to find sensitive
//      regions (Aadhaar, PAN, CC, SSN, IFSC, AWS keys, private keys,
//      Indian phone numbers, emails).
//   3. Draws opaque black rectangles over those regions on every frame in
//      the sampling window.
//   4. Re-encodes and replaces the original file (audio is preserved when
//      ffmpeg is available).
//
// Owns its own threads:
//   * One ReadDirectoryChangesW watcher thread per watch directory.
//   * One processor thread that drains the pending-files queue.
class VideoRedactor {
public:
    using EventCallback = std::function<void(VideoRedactionEvent& evt)>;
    using LogCallback   = std::function<void(const std::string& level, const std::string& msg)>;

    VideoRedactor(std::vector<std::string> watchDirs,
                  std::string pythonExe,
                  std::string scriptPath,
                  EventCallback eventCb,
                  LogCallback logger = nullptr);
    ~VideoRedactor();

    bool Start();
    void Stop();
    bool IsRunning() const { return m_running.load(); }

    // Called by ScreenRecordingMonitor when a recorder transitions started/stopped.
    // Lets the redactor know that any newly-created video file in the next
    // ~10 minutes is almost certainly the saved recording.
    void NotifyRecordingStarted(const std::string& processName);
    void NotifyRecordingStopped(const std::string& processName);

private:
    void WatcherThread(std::string dir);
    void ProcessorThread();

    bool IsVideoFile(const std::string& path) const;
    bool WaitForFileStable(const std::string& path);
    bool RunRedactor(const std::string& path,
                     int& outFramesMasked,
                     int& outFramesTotal,
                     long long& outRedactedBytes,
                     std::string& outError);

    void EnqueueFile(const std::string& path);
    std::string GetCurrentUserName();
    std::string Timestamp();
    void Emit(const std::string& path, const std::string& status,
              const std::string& reason,
              int framesMasked = 0, int framesTotal = 0,
              long long originalBytes = 0, long long redactedBytes = 0);

    std::vector<std::string> m_watchDirs;
    std::string              m_pythonExe;
    std::string              m_scriptPath;
    EventCallback            m_eventCb;
    LogCallback              m_logger;

    std::atomic<bool> m_running{false};

    // The recording acceptance window. We only redact files that appear
    // close in time to a recording start/stop event, to avoid mangling
    // unrelated videos that were merely downloaded.
    std::atomic<long long> m_armedUntilMs{0};
    static constexpr long long kArmedWindowMs = 10 * 60 * 1000;  // 10 minutes
    static constexpr long long kPreArmedMs    = 30 * 1000;       // safety lookahead

    std::vector<std::thread> m_watcherThreads;
    std::thread              m_processorThread;

    std::mutex              m_queueMutex;
    std::condition_variable m_queueCv;
    std::queue<std::string> m_pendingFiles;

    // De-dupe — a single file can fire multiple ReadDirectoryChangesW events
    // (creation, write, rename). Track recently-seen paths.
    std::mutex                                       m_seenMutex;
    std::vector<std::pair<std::string,
                          std::chrono::steady_clock::time_point>> m_recentlySeen;
};
