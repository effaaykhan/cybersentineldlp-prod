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

// Color-key transparency. Anything painted in this color becomes fully
// transparent / click-through. We use pure magenta because it almost never
// occurs in real screen content.
constexpr COLORREF kTransparentKey = RGB(255, 0, 255);

// ─── Known recorder process names (lowercase) ────────────────────────────
const std::vector<std::string>& KnownRecorders() {
    static const std::vector<std::string> v = {
        "obs64.exe", "obs32.exe", "obs.exe",
        "xboxgamebar.exe", "gamebar.exe", "gamebarft.exe", "gamebarftserver.exe",
        "gamingservices.exe", "broadcastdvr.exe", "broadcastdvrserver.exe",
        "screenclippinghost.exe", "snippingtool.exe", "screensketch.exe",
        "snipandsketch.exe",
        "zoom.exe", "cpthost.exe",
        "teams.exe", "ms-teams.exe", "msteams.exe",
        "webexmta.exe", "atmgr.exe",
        "camtasia.exe", "camtasiastudio.exe", "camrec.exe",
        "bandicam.exe", "bdcam.exe",
        "fraps.exe", "sharex.exe", "screenpresso.exe", "screenrec.exe",
        "screencast-o-matic.exe", "screencastomatic.exe", "som.exe",
        "action.exe", "mirillis.exe", "dxtory.exe", "ezvid.exe", "debut.exe",
        "icecreamscreenrecorder.exe", "flashback.exe", "fbrecorder.exe",
        "loom.exe", "vlc.exe", "ffmpeg.exe",
        "movavi.exe", "screen recorder.exe",
        "apowersoft.exe", "apowerrec.exe",
    };
    return v;
}

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

// ─── Sensitive-text patterns (mirrors agent.cpp screenClassifier) ────────
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

// ─── Tesseract TSV row (word level) ──────────────────────────────────────
struct OcrWord {
    int left = 0, top = 0, width = 0, height = 0;
    int conf = 0;
    int block = 0, par = 0, line = 0;
    std::string text;
};

// Parse Tesseract --psm 6 tsv output. Skips header. Keeps level==5 (word)
// rows whose confidence is reasonable and whose text is non-empty.
std::vector<OcrWord> ParseTesseractTsv(const std::string& tsvPath) {
    std::vector<OcrWord> out;
    FILE* f = fopen(tsvPath.c_str(), "r");
    if (!f) return out;

    char line[8192];
    bool first = true;
    while (fgets(line, sizeof(line), f)) {
        if (first) { first = false; continue; }  // header

        int level, page, block, par, lineN, wordN, l, t, w, h;
        float conf;
        char text[1024] = {0};
        int n = sscanf(line, "%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%f\t%1023[^\r\n]",
                       &level, &page, &block, &par, &lineN, &wordN,
                       &l, &t, &w, &h, &conf, text);
        if (n < 11) continue;
        if (level != 5) continue;          // only word-level rows
        if (conf < 30.0f) continue;         // low-confidence noise
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

// Group consecutive words from the same (block, par, line) into one logical
// line. Returns the line text (words joined by single space) plus the char
// offset of each word in that text.
struct OcrLine {
    std::vector<size_t>  wordIndices;     // indices into the flat OcrWord vector
    std::vector<size_t>  charOffsets;     // start offset of each word in `text`
    std::string          text;
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
        if (!cur.wordIndices.empty()) {
            cur.text += ' ';
        }
        cur.charOffsets.push_back(cur.text.size());
        cur.text       += words[i].text;
        cur.wordIndices.push_back(i);
    }
    if (!cur.wordIndices.empty()) lines.push_back(std::move(cur));
    return lines;
}

// For each pattern match in each line, compute the union of the bounding
// boxes of every word the match covers. Returns boxes in *image* (BMP)
// pixel coordinates — caller adds the screen origin offset.
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
                        // Half-open [mStart, mEnd) overlap with [wStart, wEnd).
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
                        // Pad slightly so the mask fully covers the glyphs.
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
                        if (m_logger) m_logger("INFO", "RECORDING_PROCESS_DETECTED: " + matched);
                        break;
                    }

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
                if (m_logger) m_logger("WARNING",
                    "SCREEN_RECORDING_EVASION_DETECTED: suspicious process " + matchedProc);
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
            EmitEvent("ALLOW", false, "Public", std::string(), m_evasionFlagged.load(), 0);
        } else if (!foundRecorder && wasActive) {
            std::string lastProc;
            {
                std::lock_guard<std::mutex> lk(m_recProcMutex);
                lastProc = m_recordingProcess;
                m_recordingProcess.clear();
            }
            m_recordingActive.store(false);
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
// Content monitor — captures screen, OCRs, finds sensitive regions
// ══════════════════════════════════════════════════════════════════════════

bool ScreenRecordingMonitor::CaptureVirtualScreenBmp(const std::string& outPath,
                                                     int& outOriginX, int& outOriginY,
                                                     int& outW, int& outH) {
    int x = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
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
    bi.biHeight      = h;        // bottom-up DIB
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
    bf.bfType    = 0x4D42; // 'BM'
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

std::vector<SensitiveRegion> ScreenRecordingMonitor::RunOcrAndFindRegions(int originX,
                                                                          int originY) {
    std::vector<SensitiveRegion> regions;

    char tempPath[MAX_PATH] = {0};
    GetTempPathA(MAX_PATH, tempPath);
    std::string bmpPath  = std::string(tempPath) + "cs_dlp_rec_screen.bmp";
    std::string outPref  = std::string(tempPath) + "cs_dlp_rec_ocr";
    std::string tsvPath  = outPref + ".tsv";

    int ox, oy, ow, oh;
    if (!CaptureVirtualScreenBmp(bmpPath, ox, oy, ow, oh)) {
        if (m_logger) m_logger("ERROR", "Recording-monitor screen capture failed");
        return regions;
    }

    // Quote paths in case temp dir contains spaces.
    std::string cmd = "tesseract \"" + bmpPath + "\" \"" + outPref +
                      "\" --psm 6 -l eng tsv 1>nul 2>nul";
    int rc = std::system(cmd.c_str());
    if (rc != 0) {
        // Tesseract not installed or failed. Log once-ish and bail.
        if (m_logger) m_logger("WARNING",
            "Tesseract OCR not available for region detection (install: choco install tesseract -y)");
        DeleteFileA(bmpPath.c_str());
        return regions;
    }

    auto words = ParseTesseractTsv(tsvPath);
    auto lines = GroupIntoLines(words);
    auto rawRegions = FindRegions(words, lines);

    // Translate from BMP image coordinates to virtual-screen coordinates.
    regions.reserve(rawRegions.size());
    for (auto& r : rawRegions) {
        SensitiveRegion sr = r;
        sr.left   += originX;
        sr.right  += originX;
        sr.top    += originY;
        sr.bottom += originY;
        regions.push_back(sr);
    }

    DeleteFileA(bmpPath.c_str());
    DeleteFileA(tsvPath.c_str());
    return regions;
}

void ScreenRecordingMonitor::ContentMonitorLoop() {
    while (m_running.load()) {
        if (!m_recordingActive.load()) {
            if (m_overlayActive.load()) RequestOverlayHide();
            std::this_thread::sleep_for(std::chrono::milliseconds(400));
            continue;
        }

        int originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int originY = GetSystemMetrics(SM_YVIRTUALSCREEN);

        auto regions = RunOcrAndFindRegions(originX, originY);

        std::string title   = GetForegroundWindowTitle();
        std::string process = GetForegroundProcessName();

        if (!regions.empty()) {
            // Coalesce labels for logging.
            std::string labels;
            for (size_t i = 0; i < regions.size(); ++i) {
                if (i) labels += ",";
                labels += regions[i].label;
            }
            if (m_logger) {
                m_logger("INFO", "SCREEN_CONTENT_CLASSIFIED: Restricted — " +
                                 std::to_string(regions.size()) + " region(s) [" + labels + "]");
            }
            UpdateOverlayRegions(regions);
            if (!m_overlayActive.exchange(true) || true) {
                // (overlay paint handled inside Update via WM_PAINT invalidate)
            }
            if (m_logger) {
                m_logger("WARNING", "SCREEN_PROTECTION_ENABLED: " +
                                    std::to_string(regions.size()) +
                                    " sensitive region(s) masked in " + process);
            }
            EmitEvent("BLUR", true, "Restricted", title,
                      m_evasionFlagged.load(), static_cast<int>(regions.size()));
        } else {
            if (m_overlayActive.load()) {
                RequestOverlayHide();
                if (m_logger) m_logger("INFO", "SCREEN_PROTECTION_DISABLED: no sensitive regions detected");
                EmitEvent("ALLOW", false, "Public", title, m_evasionFlagged.load(), 0);
            }
        }

        // OCR-bound cadence. ~700ms gives us roughly 1 update/sec on common
        // hardware while keeping CPU acceptable. Tesseract on a 1080p frame
        // typically takes 400-900ms.
        std::this_thread::sleep_for(std::chrono::milliseconds(700));
    }

    if (m_overlayActive.load()) RequestOverlayHide();
}

// ══════════════════════════════════════════════════════════════════════════
// Overlay window — paints rectangles over sensitive regions only
// ══════════════════════════════════════════════════════════════════════════

LRESULT CALLBACK ScreenRecordingMonitor::OverlayWndProc(HWND hwnd, UINT msg,
                                                        WPARAM wParam, LPARAM lParam) {
    // The owning instance is stored in GWLP_USERDATA at WM_NCCREATE.
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

            // Fill the entire client area with the transparent color key.
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

                    // 2px red outline frame around each masked region for clarity.
                    RECT outline = rr;
                    outline.left   -= 2; outline.top    -= 2;
                    outline.right  += 2; outline.bottom += 2;
                    FillRect(hdc, &outline, redOutline);

                    // Solid black mask over the actual word bbox.
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
    wc.hbrBackground = nullptr;  // we paint everything ourselves
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

    // Color-key transparency: anything painted in `kTransparentKey` becomes
    // fully transparent and click-through. The black mask rectangles remain
    // opaque so they actually obscure the underlying sensitive content.
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
