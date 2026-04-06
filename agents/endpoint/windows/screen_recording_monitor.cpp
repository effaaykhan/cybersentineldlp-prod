#include "screen_recording_monitor.h"

#include <tlhelp32.h>
#include <psapi.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <regex>
#include <sstream>
#include <vector>

#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace {

constexpr wchar_t kOverlayClassName[] = L"CyberSentinelDLPProtectionOverlay";

// Color-key transparency. Anything painted in this colour becomes fully
// transparent / click-through. Pure magenta almost never occurs naturally.
constexpr COLORREF kTransparentKey = RGB(255, 0, 255);

// How long a region stays masked after the last OCR detection.
// Long enough to outlive 2-3 missed OCR cycles, short enough to react when
// content actually scrolls/changes.
constexpr auto kStickyTtl = std::chrono::milliseconds(2500);

// IoU threshold for merging a new OCR region into an existing sticky region.
constexpr float kMergeIoU = 0.30f;

// ─── Recording-tool whitelist ────────────────────────────────────────────
//
// STRICT: only processes that a user explicitly launches when they actually
// want to record the screen. NO Game Bar (gamebar.exe / broadcastdvr.exe /
// screenclippinghost.exe / gamingservices.exe — those run permanently on
// Win10/11 and would cause the masks to appear with no real recording).
// NO zoom/teams/webex (always running, screen-share is hard to detect from
// process list alone). NO vlc/ffmpeg (false positives).
const std::vector<std::string>& KnownRecorders() {
    static const std::vector<std::string> v = {
        // OBS family
        "obs64.exe", "obs32.exe", "obs.exe",

        // Windows Snipping Tool — modern Win11 SnippingTool.exe handles both
        // screenshots and screen recording. It's only spawned when the user
        // explicitly launches it, so it's safe to whitelist.
        "snippingtool.exe",

        // Dedicated screen recorders the user must explicitly launch
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

// ─── Sensitive-text patterns ─────────────────────────────────────────────
struct PatternEntry {
    const char* name;
    std::regex  rx;
};

const std::vector<PatternEntry>& Patterns() {
    static const std::vector<PatternEntry> v = []() {
        std::vector<PatternEntry> p;
        try { p.push_back({"AADHAAR",     std::regex(R"(\b\d{4}[\s-]\d{4}[\s-]\d{4}\b)")}); } catch (...) {}
        try { p.push_back({"PAN",         std::regex(R"(\b[A-Z]{5}\d{4}[A-Z]\b)")}); } catch (...) {}
        try { p.push_back({"CREDIT_CARD", std::regex(R"(\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b)")}); } catch (...) {}
        try { p.push_back({"SSN",         std::regex(R"(\b\d{3}-\d{2}-\d{4}\b)")}); } catch (...) {}
        try { p.push_back({"PRIVATE_KEY", std::regex(R"(-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----)")}); } catch (...) {}
        try { p.push_back({"AWS_KEY",     std::regex(R"(AKIA[0-9A-Z]{16})")}); } catch (...) {}
        try { p.push_back({"IFSC",        std::regex(R"(\b[A-Z]{4}0[A-Z0-9]{6}\b)")}); } catch (...) {}
        try { p.push_back({"PHONE_IN",    std::regex(R"(\b[6-9]\d{9}\b)")}); } catch (...) {}
        try { p.push_back({"EMAIL",       std::regex(R"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")}); } catch (...) {}
        return p;
    }();
    return v;
}

// ─── Tesseract TSV parsing ───────────────────────────────────────────────
struct OcrWord {
    int left = 0, top = 0, width = 0, height = 0;
    int conf = 0;
    int block = 0, par = 0, line = 0;
    std::string text;
};

std::vector<OcrWord> ParseTesseractTsv(const std::string& tsvPath) {
    std::vector<OcrWord> out;
    FILE* f = fopen(tsvPath.c_str(), "r");
    if (!f) return out;

    char line[8192];
    bool first = true;
    while (fgets(line, sizeof(line), f)) {
        if (first) { first = false; continue; }

        int level, page, block, par, lineN, wordN, l, t, w, h;
        float conf;
        char text[1024] = {0};
        int n = sscanf(line, "%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%f\t%1023[^\r\n]",
                       &level, &page, &block, &par, &lineN, &wordN,
                       &l, &t, &w, &h, &conf, text);
        if (n < 11) continue;
        if (level != 5) continue;
        if (conf < 30.0f) continue;
        if (text[0] == '\0') continue;

        OcrWord wd;
        wd.left  = l;  wd.top    = t;
        wd.width = w;  wd.height = h;
        wd.conf  = static_cast<int>(conf);
        wd.block = block; wd.par = par; wd.line = lineN;
        wd.text  = text;
        out.push_back(wd);
    }
    fclose(f);
    return out;
}

struct OcrLine {
    std::vector<size_t> wordIndices;
    std::vector<size_t> charOffsets;
    std::string         text;
};

std::vector<OcrLine> GroupIntoLines(const std::vector<OcrWord>& words) {
    std::vector<OcrLine> lines;
    if (words.empty()) return lines;

    auto sameLine = [](const OcrWord& a, const OcrWord& b) {
        return a.block == b.block && a.par == b.par && a.line == b.line;
    };

    OcrLine cur;
    for (size_t i = 0; i < words.size(); ++i) {
        if (!cur.wordIndices.empty() && !sameLine(words[cur.wordIndices.back()], words[i])) {
            lines.push_back(std::move(cur));
            cur = OcrLine();
        }
        if (!cur.wordIndices.empty()) cur.text += ' ';
        cur.charOffsets.push_back(cur.text.size());
        cur.text += words[i].text;
        cur.wordIndices.push_back(i);
    }
    if (!cur.wordIndices.empty()) lines.push_back(std::move(cur));
    return lines;
}

std::vector<SensitiveRegion> FindRegions(const std::vector<OcrWord>& words,
                                         const std::vector<OcrLine>& lines) {
    std::vector<SensitiveRegion> regions;
    for (const auto& ln : lines) {
        if (ln.text.empty()) continue;
        for (const auto& pat : Patterns()) {
            try {
                auto begin = std::sregex_iterator(ln.text.begin(), ln.text.end(), pat.rx);
                auto end   = std::sregex_iterator();
                for (auto it = begin; it != end; ++it) {
                    size_t mStart = static_cast<size_t>(it->position(0));
                    size_t mEnd   = mStart + static_cast<size_t>(it->length(0));

                    SensitiveRegion reg;
                    reg.label  = pat.name;
                    reg.left   = INT_MAX;
                    reg.top    = INT_MAX;
                    reg.right  = INT_MIN;
                    reg.bottom = INT_MIN;
                    bool any = false;

                    for (size_t wi = 0; wi < ln.wordIndices.size(); ++wi) {
                        size_t wStart = ln.charOffsets[wi];
                        size_t wEnd   = wStart + words[ln.wordIndices[wi]].text.size();
                        if (wStart < mEnd && wEnd > mStart) {
                            const OcrWord& w = words[ln.wordIndices[wi]];
                            reg.left   = std::min(reg.left,   w.left);
                            reg.top    = std::min(reg.top,    w.top);
                            reg.right  = std::max(reg.right,  w.left + w.width);
                            reg.bottom = std::max(reg.bottom, w.top  + w.height);
                            any = true;
                        }
                    }

                    if (any) {
                        const int pad = 4;
                        reg.left   -= pad;
                        reg.top    -= pad;
                        reg.right  += pad;
                        reg.bottom += pad;
                        regions.push_back(reg);
                    }
                }
            } catch (...) {}
        }
    }
    return regions;
}

// IoU between two regions in screen coords.
float RegionIoU(const SensitiveRegion& a, const SensitiveRegion& b) {
    int il = std::max(a.left, b.left);
    int it = std::max(a.top, b.top);
    int ir = std::min(a.right, b.right);
    int ib = std::min(a.bottom, b.bottom);
    if (ir <= il || ib <= it) return 0.0f;
    int inter  = (ir - il) * (ib - it);
    int aArea  = (a.right - a.left) * (a.bottom - a.top);
    int bArea  = (b.right - b.left) * (b.bottom - b.top);
    int uArea  = aArea + bArea - inter;
    if (uArea <= 0) return 0.0f;
    return static_cast<float>(inter) / static_cast<float>(uArea);
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
// Process detection — strict whitelist, no evasion guessing
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

bool ScreenRecordingMonitor::LooksLikeEvasiveRecorder(const std::string&,
                                                      const std::string&) const {
    // Disabled — substring heuristics produced false positives on legit
    // processes (e.g. anything with "record" in the name). Strict whitelist
    // is the only signal we trust now.
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
            m_firstOcrPending.store(true);
            if (m_logger) m_logger("WARNING", "SCREEN_RECORDING_STARTED: " + matchedProc);
            EmitEvent("ALLOW", false, "Public", std::string(), false, 0);
        } else if (!foundRecorder && wasActive) {
            std::string lastProc;
            {
                std::lock_guard<std::mutex> lk(m_recProcMutex);
                lastProc = m_recordingProcess;
                m_recordingProcess.clear();
            }
            m_recordingActive.store(false);
            // CRITICAL: drop overlay AND sticky state immediately on stop so
            // the next time recording starts we don't replay stale rectangles.
            {
                std::lock_guard<std::mutex> lk(m_stickyMutex);
                m_stickyRegions.clear();
            }
            m_lastWindowHadSensitive = false;
            m_lastForegroundHwnd = nullptr;
            RequestOverlayHide();
            if (m_logger) m_logger("INFO", "SCREEN_RECORDING_STOPPED: " + lastProc);
            EmitEvent("ALLOW", false, "Public", std::string(), false, 0);
        }

        for (int i = 0; i < 20 && m_running.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Foreground-window screen capture
// ══════════════════════════════════════════════════════════════════════════

bool ScreenRecordingMonitor::CaptureForegroundWindowBmp(HWND hwnd,
                                                        const std::string& outPath,
                                                        int& outOriginX, int& outOriginY,
                                                        int& outW, int& outH) {
    if (!hwnd) return false;
    RECT wr;
    if (!GetWindowRect(hwnd, &wr)) return false;

    int x = wr.left;
    int y = wr.top;
    int w = wr.right - wr.left;
    int h = wr.bottom - wr.top;
    if (w <= 0 || h <= 0) return false;

    // Clamp to virtual screen so off-screen areas don't blow up the BMP.
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (x < vx) { w -= (vx - x); x = vx; }
    if (y < vy) { h -= (vy - y); y = vy; }
    if (x + w > vx + vw) w = (vx + vw) - x;
    if (y + h > vy + vh) h = (vy + vh) - y;
    if (w <= 0 || h <= 0) return false;

    HDC hScreenDC = GetDC(nullptr);
    if (!hScreenDC) return false;
    HDC hMemDC = CreateCompatibleDC(hScreenDC);
    if (!hMemDC) { ReleaseDC(nullptr, hScreenDC); return false; }

    HBITMAP hBitmap = CreateCompatibleBitmap(hScreenDC, w, h);
    if (!hBitmap) { DeleteDC(hMemDC); ReleaseDC(nullptr, hScreenDC); return false; }

    HBITMAP hOld = (HBITMAP)SelectObject(hMemDC, hBitmap);
    BitBlt(hMemDC, 0, 0, w, h, hScreenDC, x, y, SRCCOPY);

    BITMAPINFOHEADER bi{};
    bi.biSize        = sizeof(BITMAPINFOHEADER);
    bi.biWidth       = w;
    bi.biHeight      = h;
    bi.biPlanes      = 1;
    bi.biBitCount    = 24;
    bi.biCompression = BI_RGB;

    int rowSize = ((w * 3 + 3) / 4) * 4;
    int imgSize = rowSize * h;
    bi.biSizeImage = imgSize;

    std::vector<BYTE> pixels(imgSize);
    GetDIBits(hMemDC, hBitmap, 0, h, pixels.data(),
              reinterpret_cast<BITMAPINFO*>(&bi), DIB_RGB_COLORS);

    BITMAPFILEHEADER bf{};
    bf.bfType    = 0x4D42;
    bf.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    bf.bfSize    = bf.bfOffBits + imgSize;

    bool ok = false;
    FILE* f = fopen(outPath.c_str(), "wb");
    if (f) {
        fwrite(&bf, sizeof(bf), 1, f);
        fwrite(&bi, sizeof(bi), 1, f);
        fwrite(pixels.data(), imgSize, 1, f);
        fclose(f);
        ok = true;
    }

    SelectObject(hMemDC, hOld);
    DeleteObject(hBitmap);
    DeleteDC(hMemDC);
    ReleaseDC(nullptr, hScreenDC);

    outOriginX = x; outOriginY = y;
    outW = w; outH = h;
    return ok;
}

std::vector<SensitiveRegion> ScreenRecordingMonitor::OcrForegroundWindow(HWND hwnd) {
    std::vector<SensitiveRegion> regions;
    if (!hwnd) return regions;

    char tempPath[MAX_PATH] = {0};
    GetTempPathA(MAX_PATH, tempPath);
    std::string bmpPath = std::string(tempPath) + "cs_dlp_rec_fg.bmp";
    std::string outPref = std::string(tempPath) + "cs_dlp_rec_fg_ocr";
    std::string tsvPath = outPref + ".tsv";

    int ox, oy, ow, oh;
    if (!CaptureForegroundWindowBmp(hwnd, bmpPath, ox, oy, ow, oh)) {
        return regions;
    }

    std::string cmd = "tesseract \"" + bmpPath + "\" \"" + outPref +
                      "\" --psm 6 -l eng tsv 1>nul 2>nul";
    int rc = std::system(cmd.c_str());
    if (rc != 0) {
        if (m_logger) m_logger("WARNING",
            "Tesseract OCR not available — install: choco install tesseract -y");
        DeleteFileA(bmpPath.c_str());
        return regions;
    }

    auto words = ParseTesseractTsv(tsvPath);
    auto lines = GroupIntoLines(words);
    auto raw   = FindRegions(words, lines);

    regions.reserve(raw.size());
    for (auto& r : raw) {
        SensitiveRegion sr = r;
        sr.left   += ox;
        sr.right  += ox;
        sr.top    += oy;
        sr.bottom += oy;
        regions.push_back(sr);
    }

    DeleteFileA(bmpPath.c_str());
    DeleteFileA(tsvPath.c_str());
    return regions;
}

// ══════════════════════════════════════════════════════════════════════════
// Content monitor — only runs while a real recorder is active
// ══════════════════════════════════════════════════════════════════════════

void ScreenRecordingMonitor::ContentMonitorLoop() {
    while (m_running.load()) {
        // ── HARD GUARD: never paint anything when no recording is active ──
        if (!m_recordingActive.load()) {
            if (m_overlayActive.load()) RequestOverlayHide();
            {
                std::lock_guard<std::mutex> lk(m_stickyMutex);
                m_stickyRegions.clear();
            }
            m_lastWindowHadSensitive = false;
            m_lastForegroundHwnd     = nullptr;
            std::this_thread::sleep_for(std::chrono::milliseconds(400));
            continue;
        }

        HWND fg = GetForegroundWindow();
        if (!fg) {
            if (m_overlayActive.load()) RequestOverlayHide();
            std::this_thread::sleep_for(std::chrono::milliseconds(300));
            continue;
        }

        // ── Pre-mask on focus change / first OCR ──────────────────────────
        // If the window changed AND the previous window had sensitive
        // content, OR this is the first OCR cycle right after recording
        // started, immediately paint a full-window black mask while OCR
        // runs. This eliminates the leak window where the recorder would
        // otherwise capture sensitive content for ~400ms before our masks
        // are computed.
        bool windowChanged = (fg != m_lastForegroundHwnd);
        bool firstOcr      = m_firstOcrPending.exchange(false);

        if (windowChanged) {
            // Old stickies belonged to the old window — drop them.
            std::lock_guard<std::mutex> lk(m_stickyMutex);
            m_stickyRegions.clear();
        }

        if (windowChanged && (m_lastWindowHadSensitive || firstOcr)) {
            RECT wr;
            if (GetWindowRect(fg, &wr) && wr.right > wr.left && wr.bottom > wr.top) {
                SensitiveRegion safety;
                safety.left   = wr.left;
                safety.top    = wr.top;
                safety.right  = wr.right;
                safety.bottom = wr.bottom;
                safety.label  = "TRANSITION_SAFETY";
                std::vector<SensitiveRegion> safetyList = { safety };
                UpdateOverlayRegions(safetyList);
                if (m_logger) {
                    m_logger("INFO", "SCREEN_PROTECTION_SAFETY_MASK: pre-masking new window pending OCR");
                }
            }
        }

        m_lastForegroundHwnd = fg;

        // ── Run OCR on the foreground window ──────────────────────────────
        auto fresh = OcrForegroundWindow(fg);

        // ── Merge fresh detections into sticky region pool ────────────────
        auto now = std::chrono::steady_clock::now();
        std::vector<SensitiveRegion> overlayRegions;
        {
            std::lock_guard<std::mutex> lk(m_stickyMutex);

            for (const auto& nr : fresh) {
                bool merged = false;
                for (auto& sr : m_stickyRegions) {
                    if (RegionIoU(nr, sr.region) >= kMergeIoU) {
                        // Update geometry to the latest detection so the box
                        // tracks scrolling text smoothly.
                        sr.region   = nr;
                        sr.lastSeen = now;
                        merged      = true;
                        break;
                    }
                }
                if (!merged) {
                    StickyRegion sr;
                    sr.region   = nr;
                    sr.lastSeen = now;
                    m_stickyRegions.push_back(sr);
                }
            }

            // Drop stickies whose TTL has expired (region disappeared from
            // view, was scrolled off, redacted, etc.).
            m_stickyRegions.erase(
                std::remove_if(m_stickyRegions.begin(), m_stickyRegions.end(),
                    [now](const StickyRegion& sr) {
                        return (now - sr.lastSeen) > kStickyTtl;
                    }),
                m_stickyRegions.end());

            for (const auto& sr : m_stickyRegions) overlayRegions.push_back(sr.region);
        }

        // ── Push to overlay (or hide) ─────────────────────────────────────
        std::string title   = GetForegroundWindowTitle();
        std::string process = GetForegroundProcessName();

        if (!overlayRegions.empty()) {
            if (!fresh.empty()) {
                std::string labels;
                for (size_t i = 0; i < fresh.size(); ++i) {
                    if (i) labels += ",";
                    labels += fresh[i].label;
                }
                if (m_logger) {
                    m_logger("INFO", "SCREEN_CONTENT_CLASSIFIED: Restricted — " +
                                     std::to_string(fresh.size()) + " region(s) [" + labels + "]");
                }
            }
            UpdateOverlayRegions(overlayRegions);
            if (!m_lastWindowHadSensitive) {
                if (m_logger) {
                    m_logger("WARNING", "SCREEN_PROTECTION_ENABLED: " +
                                        std::to_string(overlayRegions.size()) +
                                        " sensitive region(s) masked in " + process);
                }
                EmitEvent("BLUR", true, "Restricted", title, false,
                          static_cast<int>(overlayRegions.size()));
            }
            m_lastWindowHadSensitive = true;
        } else {
            if (m_lastWindowHadSensitive || m_overlayActive.load()) {
                RequestOverlayHide();
                if (m_logger) m_logger("INFO", "SCREEN_PROTECTION_DISABLED: no sensitive regions detected");
                EmitEvent("ALLOW", false, "Public", title, false, 0);
            }
            m_lastWindowHadSensitive = false;
        }

        // Cadence — foreground-window OCR is much smaller than full-screen
        // so we can run more often. ~350ms = ~3 cycles/sec.
        std::this_thread::sleep_for(std::chrono::milliseconds(350));
    }

    if (m_overlayActive.load()) RequestOverlayHide();
}

// ══════════════════════════════════════════════════════════════════════════
// Overlay window
// ══════════════════════════════════════════════════════════════════════════

LRESULT CALLBACK ScreenRecordingMonitor::OverlayWndProc(HWND hwnd, UINT msg,
                                                        WPARAM wParam, LPARAM lParam) {
    if (msg == WM_NCCREATE) {
        CREATESTRUCT* cs = reinterpret_cast<CREATESTRUCT*>(lParam);
        SetWindowLongPtr(hwnd, GWLP_USERDATA,
                         reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    auto* self = reinterpret_cast<ScreenRecordingMonitor*>(
        GetWindowLongPtr(hwnd, GWLP_USERDATA));

    switch (msg) {
        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hwnd, &ps);
            RECT rc; GetClientRect(hwnd, &rc);

            HBRUSH bgBrush = CreateSolidBrush(kTransparentKey);
            FillRect(hdc, &rc, bgBrush);
            DeleteObject(bgBrush);

            if (self) {
                std::vector<SensitiveRegion> regions;
                int originX = 0, originY = 0;
                {
                    std::lock_guard<std::mutex> lk(self->m_regionsMutex);
                    regions = self->m_regions;
                    originX = self->m_overlayOriginX;
                    originY = self->m_overlayOriginY;
                }

                HBRUSH black = CreateSolidBrush(RGB(0, 0, 0));
                HBRUSH redOutline = CreateSolidBrush(RGB(220, 30, 30));

                for (const auto& r : regions) {
                    RECT rr;
                    rr.left   = r.left   - originX;
                    rr.top    = r.top    - originY;
                    rr.right  = r.right  - originX;
                    rr.bottom = r.bottom - originY;

                    RECT outline = rr;
                    outline.left   -= 2; outline.top    -= 2;
                    outline.right  += 2; outline.bottom += 2;
                    FillRect(hdc, &outline, redOutline);
                    FillRect(hdc, &rr, black);
                }

                DeleteObject(black);
                DeleteObject(redOutline);
            }

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
    wc.hbrBackground = nullptr;
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

    HWND hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        kOverlayClassName,
        L"CyberSentinel DLP Protection",
        WS_POPUP,
        sx, sy, sw, sh,
        nullptr, nullptr, hInst, this);

    if (!hwnd) {
        if (m_logger) m_logger("ERROR", "Overlay CreateWindowEx failed: " + std::to_string(GetLastError()));
        return;
    }

    SetLayeredWindowAttributes(hwnd, kTransparentKey, 0, LWA_COLORKEY);
    m_overlayHwnd.store(hwnd);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message == WM_DLP_UPDATE_OVERLAY) {
            int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            SetWindowPos(hwnd, HWND_TOPMOST, vx, vy, vw, vh,
                         SWP_NOACTIVATE | SWP_SHOWWINDOW);
            InvalidateRect(hwnd, nullptr, TRUE);
            UpdateWindow(hwnd);
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

void ScreenRecordingMonitor::UpdateOverlayRegions(const std::vector<SensitiveRegion>& regions) {
    {
        std::lock_guard<std::mutex> lk(m_regionsMutex);
        m_regions          = regions;
        m_overlayOriginX   = GetSystemMetrics(SM_XVIRTUALSCREEN);
        m_overlayOriginY   = GetSystemMetrics(SM_YVIRTUALSCREEN);
    }
    if (m_overlayThreadId != 0) {
        PostThreadMessage(m_overlayThreadId, WM_DLP_UPDATE_OVERLAY, 0, 0);
    }
}

void ScreenRecordingMonitor::RequestOverlayHide() {
    {
        std::lock_guard<std::mutex> lk(m_regionsMutex);
        m_regions.clear();
    }
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
                                       bool evasion,
                                       int regionsCount) {
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
    evt.regionsCount      = regionsCount;
    evt.timestamp         = Timestamp();
    try { m_eventCb(evt); } catch (...) {}
}
