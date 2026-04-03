/**
 * CyberSentinel DLP — USB DLP Module
 *
 * Isolated USB monitoring, device control, file transfer detection,
 * content inspection, classification, and enforcement.
 *
 * This module is SEPARATE from clipboard logic and must not interfere with it.
 *
 * Components:
 *   1. UsbDeviceManager    — Device identification, whitelist, connect/disconnect
 *   2. UsbFileMonitor      — Real-time file transfer detection via ReadDirectoryChangesW
 *   3. UsbContentInspector — Content extraction, regex, keyword, fingerprint matching
 *   4. UsbEnforcer         — Block, allow, alert, quarantine, encrypt actions
 *
 * Architecture:
 *   USB Insert → DeviceManager.OnDeviceArrival()
 *     → Whitelist check → BLOCK if not whitelisted
 *     → FileMonitor.StartWatching(driveLetter)
 *       → File detected → ContentInspector.Analyze()
 *         → Classification → Enforcer.Execute(action)
 *           → Event logged to server
 */

#pragma once

#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <mutex>
#include <thread>
#include <atomic>
#include <functional>
#include <filesystem>
#include <regex>
#include <fstream>
#include <chrono>
#include <windows.h>
#include <setupapi.h>
#include <devguid.h>
#include <cfgmgr32.h>

#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "cfgmgr32.lib")

namespace fs = std::filesystem;

namespace cs_usb {

/* ════════════════════════════════════════════════════════════════════════════
 * DATA STRUCTURES
 * ════════════════════════════════════════════════════════════════════════════ */

struct UsbDeviceInfo {
    std::string vendorId;
    std::string productId;
    std::string serialNumber;
    std::string deviceName;
    std::string deviceClass;
    std::string driveLetter;
    std::string instanceId;
    bool isAllowed = false;
};

struct WhitelistEntry {
    std::string serialNumber;   // Primary key
    std::string username;       // "" = any user
    std::string hostname;       // "" = any host
    std::string description;
};

struct UsbFileEvent {
    std::string eventType;       // FILE_COPY, FILE_MOVE, FILE_RENAME, FILE_CREATE
    std::string sourcePath;
    std::string destinationPath;
    std::string fileName;
    uint64_t    fileSize = 0;
    std::string fileHash;        // SHA-256
    std::string processName;
    std::string user;
    std::string classificationRule;
    std::string category;        // Public, Internal, Confidential, Restricted
    std::string actionTaken;     // Allow, Block, Alert, Quarantine, Encrypt
    float       confidenceScore = 0.0f;
    std::vector<std::string> matchedRules;
    std::string timestamp;
    bool        evasionDetected = false;
    std::string evasionType;
};

struct UsbClassificationResult {
    std::string category;        // Public, Internal, Confidential, Restricted
    float       confidence = 0.0f;
    std::vector<std::string> matchedRules;
    std::vector<std::string> detectedTypes;
    std::string suggestedAction;
    std::string severity;
};

/* ════════════════════════════════════════════════════════════════════════════
 * 1. USB DEVICE MANAGER — Device identification & whitelist
 * ════════════════════════════════════════════════════════════════════════════ */

class UsbDeviceManager {
public:
    using DeviceCallback = std::function<void(const UsbDeviceInfo&, const std::string& eventType)>;
    using LogCallback = std::function<void(const std::string& level, const std::string& message)>;

    UsbDeviceManager(LogCallback logger) : logger_(logger) {}

    /** Extract USB device info using SetupAPI */
    UsbDeviceInfo IdentifyDevice(const std::string& driveLetter) {
        UsbDeviceInfo info;
        info.driveLetter = driveLetter;

        logger_("INFO", "USB_DEVICE_DETECTED: Identifying device at " + driveLetter);

        // Get volume name
        char volumeName[MAX_PATH] = {0};
        char fsName[MAX_PATH] = {0};
        DWORD serialNum = 0;
        if (GetVolumeInformationA(driveLetter.c_str(), volumeName, MAX_PATH,
                                   &serialNum, NULL, NULL, fsName, MAX_PATH)) {
            info.deviceName = volumeName[0] ? volumeName : "USB Drive";
        }

        // Enumerate USB devices via SetupAPI to find VID/PID/Serial
        HDEVINFO hDevInfo = SetupDiGetClassDevsA(NULL, "USB", NULL,
            DIGCF_PRESENT | DIGCF_ALLCLASSES);

        if (hDevInfo != INVALID_HANDLE_VALUE) {
            SP_DEVINFO_DATA devInfoData;
            devInfoData.cbSize = sizeof(SP_DEVINFO_DATA);

            for (DWORD i = 0; SetupDiEnumDeviceInfo(hDevInfo, i, &devInfoData); i++) {
                char instanceId[512] = {0};
                if (CM_Get_Device_IDA(devInfoData.DevInst, instanceId, sizeof(instanceId), 0) == CR_SUCCESS) {
                    std::string id(instanceId);

                    // Look for mass storage USB devices
                    if (id.find("USB\\VID_") != std::string::npos ||
                        id.find("USBSTOR\\") != std::string::npos) {

                        // Extract VID
                        auto vidPos = id.find("VID_");
                        if (vidPos != std::string::npos && vidPos + 8 <= id.length()) {
                            info.vendorId = id.substr(vidPos + 4, 4);
                        }

                        // Extract PID
                        auto pidPos = id.find("PID_");
                        if (pidPos != std::string::npos && pidPos + 8 <= id.length()) {
                            info.productId = id.substr(pidPos + 4, 4);
                        }

                        // Extract Serial Number (after last \\)
                        auto lastSlash = id.rfind('\\');
                        if (lastSlash != std::string::npos && lastSlash + 1 < id.length()) {
                            std::string candidate = id.substr(lastSlash + 1);
                            // Serial numbers are typically alphanumeric, 8+ chars
                            if (candidate.length() >= 4 && candidate.find("&") == std::string::npos) {
                                info.serialNumber = candidate;
                            }
                        }

                        info.instanceId = id;

                        // Get device description
                        char desc[256] = {0};
                        if (SetupDiGetDeviceRegistryPropertyA(hDevInfo, &devInfoData,
                                SPDRP_DEVICEDESC, NULL, (BYTE*)desc, sizeof(desc), NULL)) {
                            if (info.deviceName.empty() || info.deviceName == "USB Drive") {
                                info.deviceName = desc;
                            }
                        }

                        // Get device class
                        char className[256] = {0};
                        if (SetupDiGetDeviceRegistryPropertyA(hDevInfo, &devInfoData,
                                SPDRP_CLASS, NULL, (BYTE*)className, sizeof(className), NULL)) {
                            info.deviceClass = className;
                        }

                        // If we found VID and PID, we have enough
                        if (!info.vendorId.empty() && !info.productId.empty()) {
                            break;
                        }
                    }
                }
            }
            SetupDiDestroyDeviceInfoList(hDevInfo);
        }

        logger_("INFO", "USB_DEVICE_IDENTIFIED: VID=" + info.vendorId +
                " PID=" + info.productId + " Serial=" + info.serialNumber +
                " Name=" + info.deviceName + " Class=" + info.deviceClass);

        return info;
    }

    /** Check device against whitelist */
    bool IsDeviceWhitelisted(const UsbDeviceInfo& device) {
        std::lock_guard<std::mutex> lock(whitelistMutex_);

        if (whitelist_.empty()) {
            // No whitelist configured = allow all
            return true;
        }

        std::string currentUser = GetCurrentUsername();
        std::string currentHost = GetCurrentHostname();

        for (const auto& entry : whitelist_) {
            // Match serial number
            if (!entry.serialNumber.empty() && entry.serialNumber != device.serialNumber) {
                continue;
            }

            // Match username (empty = any)
            if (!entry.username.empty() && entry.username != currentUser) {
                continue;
            }

            // Match hostname (empty = any)
            if (!entry.hostname.empty() && entry.hostname != currentHost) {
                continue;
            }

            logger_("INFO", "USB_POLICY_CHECK: Device WHITELISTED — Serial=" +
                    device.serialNumber + " User=" + currentUser);
            return true;
        }

        logger_("WARNING", "USB_POLICY_CHECK: Device NOT WHITELISTED — Serial=" +
                device.serialNumber + " VID=" + device.vendorId + " PID=" + device.productId);
        return false;
    }

    /** Add whitelist entry */
    void AddWhitelistEntry(const WhitelistEntry& entry) {
        std::lock_guard<std::mutex> lock(whitelistMutex_);
        whitelist_.push_back(entry);
    }

    /** Load whitelist from JSON config */
    void LoadWhitelist(const std::vector<WhitelistEntry>& entries) {
        std::lock_guard<std::mutex> lock(whitelistMutex_);
        whitelist_ = entries;
        logger_("INFO", "USB whitelist loaded: " + std::to_string(entries.size()) + " entries");
    }

    static std::string GetCurrentUsername() {
        char username[256] = {0};
        DWORD size = sizeof(username);
        GetUserNameA(username, &size);
        return std::string(username);
    }

    static std::string GetCurrentHostname() {
        char hostname[256] = {0};
        DWORD size = sizeof(hostname);
        GetComputerNameA(hostname, &size);
        return std::string(hostname);
    }

private:
    LogCallback logger_;
    std::vector<WhitelistEntry> whitelist_;
    std::mutex whitelistMutex_;
};

/* ════════════════════════════════════════════════════════════════════════════
 * 2. USB FILE MONITOR — Real-time detection via ReadDirectoryChangesW
 * ════════════════════════════════════════════════════════════════════════════ */

class UsbFileMonitor {
public:
    using FileEventCallback = std::function<void(const UsbFileEvent&)>;
    using LogCallback = std::function<void(const std::string&, const std::string&)>;

    UsbFileMonitor(FileEventCallback callback, LogCallback logger)
        : callback_(callback), logger_(logger) {}

    ~UsbFileMonitor() { StopAll(); }

    /** Start watching a USB drive for file changes (event-driven, not polling) */
    void StartWatching(const std::string& drivePath) {
        std::lock_guard<std::mutex> lock(mutex_);

        if (activeWatchers_.count(drivePath)) return;

        logger_("INFO", "FILE_TRANSFER_DETECTED: Starting real-time watch on " + drivePath);
        activeWatchers_[drivePath] = true;

        std::thread([this, drivePath]() {
            WatchDirectory(drivePath);
        }).detach();
    }

    /** Stop watching a specific drive */
    void StopWatching(const std::string& drivePath) {
        std::lock_guard<std::mutex> lock(mutex_);
        activeWatchers_[drivePath] = false;
    }

    /** Stop all watchers */
    void StopAll() {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& [path, active] : activeWatchers_) {
            active = false;
        }
    }

private:
    void WatchDirectory(const std::string& drivePath) {
        HANDLE hDir = CreateFileA(
            drivePath.c_str(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            NULL
        );

        if (hDir == INVALID_HANDLE_VALUE) {
            logger_("ERROR", "Failed to open directory for watching: " + drivePath);
            return;
        }

        const DWORD bufferSize = 64 * 1024;
        std::vector<BYTE> buffer(bufferSize);
        OVERLAPPED overlapped = {};
        overlapped.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);

        while (activeWatchers_.count(drivePath) && activeWatchers_[drivePath]) {
            DWORD bytesReturned = 0;
            ResetEvent(overlapped.hEvent);

            BOOL result = ReadDirectoryChangesW(
                hDir,
                buffer.data(),
                bufferSize,
                TRUE,  // Watch subtree
                FILE_NOTIFY_CHANGE_FILE_NAME |
                FILE_NOTIFY_CHANGE_SIZE |
                FILE_NOTIFY_CHANGE_LAST_WRITE |
                FILE_NOTIFY_CHANGE_CREATION,
                &bytesReturned,
                &overlapped,
                NULL
            );

            if (!result) {
                DWORD err = GetLastError();
                if (err == ERROR_NOTIFY_ENUM_DIR) {
                    logger_("WARNING", "Directory overflow on " + drivePath);
                    continue;
                }
                break;
            }

            // Wait with timeout so we can check if we should stop
            DWORD waitResult = WaitForSingleObject(overlapped.hEvent, 2000);
            if (waitResult == WAIT_TIMEOUT) continue;
            if (waitResult != WAIT_OBJECT_0) break;

            if (!GetOverlappedResult(hDir, &overlapped, &bytesReturned, FALSE)) break;
            if (bytesReturned == 0) continue;

            // Process notifications
            FILE_NOTIFY_INFORMATION* fni = (FILE_NOTIFY_INFORMATION*)buffer.data();
            do {
                std::wstring wFileName(fni->FileName, fni->FileNameLength / sizeof(WCHAR));
                std::string fileName(wFileName.begin(), wFileName.end());
                std::string fullPath = drivePath + "\\" + fileName;

                UsbFileEvent event;
                event.destinationPath = fullPath;
                event.fileName = fs::path(fullPath).filename().string();
                event.user = UsbDeviceManager::GetCurrentUsername();
                event.timestamp = GetTimestamp();

                // Determine event type
                switch (fni->Action) {
                case FILE_ACTION_ADDED:
                    event.eventType = "FILE_COPY";
                    event.sourcePath = ""; // Source unknown at this level
                    break;
                case FILE_ACTION_MODIFIED:
                    event.eventType = "FILE_MODIFY";
                    break;
                case FILE_ACTION_RENAMED_NEW_NAME:
                    event.eventType = "FILE_RENAME";
                    break;
                case FILE_ACTION_REMOVED:
                    event.eventType = "FILE_DELETE";
                    break;
                default:
                    event.eventType = "FILE_UNKNOWN";
                }

                // Get file size
                if (fni->Action != FILE_ACTION_REMOVED) {
                    try {
                        if (fs::exists(fullPath) && fs::is_regular_file(fullPath)) {
                            event.fileSize = fs::file_size(fullPath);
                        }
                    } catch (...) {}
                }

                // Get process name that triggered the write
                event.processName = GetForegroundProcessName();

                // Skip directories and temp files
                if (event.fileName.empty() || event.fileName[0] == '~' ||
                    event.fileName.find(".tmp") != std::string::npos) {
                    goto next;
                }

                // Only report file additions/modifications (not deletions of temp files)
                if (fni->Action == FILE_ACTION_ADDED || fni->Action == FILE_ACTION_MODIFIED ||
                    fni->Action == FILE_ACTION_RENAMED_NEW_NAME) {
                    logger_("INFO", "FILE_TRANSFER_DETECTED: " + event.eventType +
                            " — " + event.fileName + " (" + std::to_string(event.fileSize) + " bytes)");
                    callback_(event);
                }

                next:
                if (fni->NextEntryOffset == 0) break;
                fni = (FILE_NOTIFY_INFORMATION*)((BYTE*)fni + fni->NextEntryOffset);
            } while (true);
        }

        CloseHandle(overlapped.hEvent);
        CloseHandle(hDir);
        logger_("INFO", "Stopped watching: " + drivePath);
    }

    static std::string GetForegroundProcessName() {
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

    static std::string GetTimestamp() {
        auto now = std::chrono::system_clock::now();
        auto t = std::chrono::system_clock::to_time_t(now);
        // IST = UTC + 5:30
        t += 19800;
        struct tm tm_buf;
        gmtime_s(&tm_buf, &t);
        char buf[64];
        snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d+05:30",
                 tm_buf.tm_year + 1900, tm_buf.tm_mon + 1, tm_buf.tm_mday,
                 tm_buf.tm_hour, tm_buf.tm_min, tm_buf.tm_sec);
        return buf;
    }

    FileEventCallback callback_;
    LogCallback logger_;
    std::unordered_map<std::string, bool> activeWatchers_;
    std::mutex mutex_;
};

/* ════════════════════════════════════════════════════════════════════════════
 * 3. USB CONTENT INSPECTOR — Content extraction, regex, keyword, fingerprint
 * ════════════════════════════════════════════════════════════════════════════ */

class UsbContentInspector {
public:
    using LogCallback = std::function<void(const std::string&, const std::string&)>;

    UsbContentInspector(LogCallback logger) : logger_(logger) {
        InitializePatterns();
    }

    /** Full content inspection pipeline */
    UsbClassificationResult Analyze(UsbFileEvent& event) {
        UsbClassificationResult result;
        result.category = "Public";
        result.confidence = 0.0f;
        result.suggestedAction = "Allow";
        result.severity = "low";

        logger_("INFO", "CONTENT_ANALYZED: Inspecting " + event.fileName);

        // Step 1: File type analysis — check extension vs magic bytes
        std::string ext = GetExtension(event.fileName);
        bool isSupportedType = IsSupportedFileType(ext);

        if (!isSupportedType) {
            logger_("DEBUG", "Skipping unsupported file type: " + ext);
            return result;
        }

        // Step 2: Extract content
        std::string content;
        if (!ExtractContent(event.destinationPath, content)) {
            logger_("WARNING", "CONTENT_EXTRACTION_FAILED: " + event.fileName);
            return result;
        }

        // Step 3: Compute file hash
        event.fileHash = ComputeSHA256(event.destinationPath);

        // Step 4: Check fingerprint database
        if (IsKnownFingerprint(event.fileHash)) {
            result.category = "Restricted";
            result.confidence = 1.0f;
            result.matchedRules.push_back("FINGERPRINT_MATCH");
            result.suggestedAction = "Block";
            result.severity = "critical";
            logger_("INFO", "CLASSIFICATION_RESULT: FINGERPRINT MATCH — " + event.fileName);
            return result;
        }

        // Step 5: Regex pattern matching
        float totalWeight = 0.0f;
        std::vector<std::string> detectedTypes;

        for (const auto& [name, patternInfo] : patterns_) {
            try {
                auto begin = std::sregex_iterator(content.begin(), content.end(), patternInfo.regex);
                auto end = std::sregex_iterator();
                int count = (int)std::distance(begin, end);

                if (count > 0) {
                    // Validate matches (Luhn for CC, etc.)
                    int validated = ValidateMatches(name, begin, std::sregex_iterator(), content);
                    if (validated > 0) {
                        detectedTypes.push_back(name);
                        result.matchedRules.push_back(name);
                        totalWeight += patternInfo.weight;
                        logger_("INFO", "  Pattern matched: " + name + " (" +
                                std::to_string(validated) + " validated matches)");
                    }
                }
            } catch (...) {}
        }

        // Step 6: Keyword matching
        std::string contentLower = content;
        std::transform(contentLower.begin(), contentLower.end(), contentLower.begin(), ::tolower);

        for (const auto& [keyword, weight] : keywords_) {
            if (contentLower.find(keyword) != std::string::npos) {
                totalWeight += weight;
                result.matchedRules.push_back("KEYWORD:" + keyword);
            }
        }

        // Step 7: Evasion detection
        if (DetectEvasion(event, ext, content)) {
            event.evasionDetected = true;
            totalWeight += 0.3f;
            result.matchedRules.push_back("EVASION_DETECTED:" + event.evasionType);
            logger_("WARNING", "EVASION_ATTEMPT_DETECTED: " + event.evasionType +
                    " — " + event.fileName);
        }

        // Step 8: Classify
        result.confidence = std::min(1.0f, totalWeight);
        result.detectedTypes = detectedTypes;

        if (result.confidence >= 0.8f) {
            result.category = "Restricted";
            result.suggestedAction = "Block";
            result.severity = "critical";
        } else if (result.confidence >= 0.6f) {
            result.category = "Confidential";
            result.suggestedAction = "Block";
            result.severity = "high";
        } else if (result.confidence >= 0.3f) {
            result.category = "Internal";
            result.suggestedAction = "Alert";
            result.severity = "medium";
        } else {
            result.category = "Public";
            result.suggestedAction = "Allow";
            result.severity = "low";
        }

        logger_("INFO", "CLASSIFICATION_RESULT: " + event.fileName +
                " → " + result.category + " (confidence=" +
                std::to_string((int)(result.confidence * 100)) + "%)");

        return result;
    }

    /** Add known fingerprint hash */
    void AddFingerprint(const std::string& hash) {
        std::lock_guard<std::mutex> lock(fpMutex_);
        fingerprints_.insert(hash);
    }

private:
    struct PatternInfo {
        std::regex regex;
        float weight;
    };

    void InitializePatterns() {
        // C++ std::regex — no lookbehind, use word boundaries and digit validation
        auto addPattern = [this](const std::string& name, const std::string& pattern, float weight) {
            try {
                patterns_[name] = {std::regex(pattern, std::regex::optimize), weight};
            } catch (const std::regex_error& e) {
                // Skip invalid patterns
            }
        };

        addPattern("AADHAAR", R"(\b\d{4}[\s-]\d{4}[\s-]\d{4}\b)", 0.9f);
        addPattern("PAN_CARD", R"(\b[A-Z]{5}\d{4}[A-Z]\b)", 0.9f);
        addPattern("CREDIT_CARD", R"(\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b)", 0.95f);
        addPattern("SSN", R"(\b\d{3}-\d{2}-\d{4}\b)", 0.9f);
        addPattern("IFSC", R"(\b[A-Z]{4}0[A-Z0-9]{6}\b)", 0.7f);
        addPattern("EMAIL", R"(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)", 0.3f);
        addPattern("AWS_KEY", R"(AKIA[0-9A-Z]{16})", 0.95f);
        addPattern("PRIVATE_KEY", R"(-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----)", 0.95f);
        addPattern("API_KEY", R"((?:api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{32,})", 0.85f);
        addPattern("DB_CONNECTION", R"((?:jdbc:|mongodb://|postgresql://|mysql://)\S+)", 0.8f);

        // Keywords
        keywords_["confidential"] = 0.2f;
        keywords_["restricted"] = 0.3f;
        keywords_["internal only"] = 0.15f;
        keywords_["do not distribute"] = 0.25f;
        keywords_["top secret"] = 0.4f;
        keywords_["classified"] = 0.25f;
    }

    bool ExtractContent(const std::string& path, std::string& content) {
        try {
            std::ifstream file(path, std::ios::binary);
            if (!file.is_open()) return false;

            // Read up to 10MB
            const size_t maxSize = 10 * 1024 * 1024;
            std::vector<char> buf(maxSize);
            file.read(buf.data(), maxSize);
            auto bytesRead = file.gcount();

            content.assign(buf.data(), bytesRead);
            return !content.empty();
        } catch (...) {
            return false;
        }
    }

    std::string ComputeSHA256(const std::string& path) {
        // Use Windows CNG for SHA-256
        BCRYPT_ALG_HANDLE hAlg = nullptr;
        BCRYPT_HASH_HANDLE hHash = nullptr;
        UCHAR hash[32];

        if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0)
            return "";

        if (BCryptCreateHash(hAlg, &hHash, nullptr, 0, nullptr, 0, 0) != 0) {
            BCryptCloseAlgorithmProvider(hAlg, 0);
            return "";
        }

        std::ifstream file(path, std::ios::binary);
        if (file.is_open()) {
            char buf[8192];
            while (file.read(buf, sizeof(buf)) || file.gcount() > 0) {
                BCryptHashData(hHash, (PUCHAR)buf, (ULONG)file.gcount(), 0);
                if (file.gcount() < sizeof(buf)) break;
            }
        }

        BCryptFinishHash(hHash, hash, sizeof(hash), 0);
        BCryptDestroyHash(hHash);
        BCryptCloseAlgorithmProvider(hAlg, 0);

        char hex[65];
        for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", hash[i]);
        hex[64] = '\0';
        return std::string(hex);
    }

    bool IsKnownFingerprint(const std::string& hash) {
        std::lock_guard<std::mutex> lock(fpMutex_);
        return fingerprints_.count(hash) > 0;
    }

    int ValidateMatches(const std::string& type, std::sregex_iterator begin,
                        std::sregex_iterator end, const std::string& content) {
        int count = 0;
        auto it = std::sregex_iterator(content.begin(), content.end(), patterns_[type].regex);
        for (; it != end; ++it) {
            std::string match = it->str();

            if (type == "CREDIT_CARD") {
                // Luhn validation
                std::string digits;
                for (char c : match) if (isdigit(c)) digits += c;
                if (digits.length() == 16 && LuhnCheck(digits)) count++;
            } else if (type == "AADHAAR") {
                std::string digits;
                for (char c : match) if (isdigit(c)) digits += c;
                if (digits.length() == 12) count++;
            } else {
                count++;
            }
        }
        return count;
    }

    static bool LuhnCheck(const std::string& digits) {
        int sum = 0;
        for (int i = (int)digits.length() - 1; i >= 0; i--) {
            int d = digits[i] - '0';
            if ((digits.length() - 1 - i) % 2 == 1) { d *= 2; if (d > 9) d -= 9; }
            sum += d;
        }
        return sum % 10 == 0;
    }

    bool DetectEvasion(UsbFileEvent& event, const std::string& ext,
                       const std::string& content) {
        // Check 1: Extension doesn't match content (e.g., .txt file with JPEG header)
        if (ext == ".txt" || ext == ".log") {
            if (content.substr(0, 4) == "\x89PNG" || content.substr(0, 2) == "\xFF\xD8" ||
                content.substr(0, 4) == "%PDF" || content.substr(0, 2) == "PK") {
                event.evasionType = "EXTENSION_MISMATCH";
                return true;
            }
        }

        // Check 2: Renamed executable
        if (content.substr(0, 2) == "MZ" && ext != ".exe" && ext != ".dll" && ext != ".sys") {
            event.evasionType = "HIDDEN_EXECUTABLE";
            return true;
        }

        // Check 3: Double extension (e.g., file.pdf.txt)
        std::string name = event.fileName;
        int dotCount = 0;
        for (char c : name) if (c == '.') dotCount++;
        if (dotCount >= 2) {
            event.evasionType = "DOUBLE_EXTENSION";
            return true;
        }

        return false;
    }

    std::string GetExtension(const std::string& fileName) {
        auto pos = fileName.rfind('.');
        if (pos != std::string::npos) {
            std::string ext = fileName.substr(pos);
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            return ext;
        }
        return "";
    }

    bool IsSupportedFileType(const std::string& ext) {
        static const std::unordered_set<std::string> supported = {
            ".txt", ".csv", ".json", ".xml", ".yaml", ".yml", ".conf", ".cfg", ".env",
            ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
            ".sql", ".py", ".js", ".ts", ".java", ".cpp", ".c", ".h", ".cs", ".go",
            ".pem", ".key", ".cer", ".crt", ".p12", ".pfx",
            ".log", ".ini", ".properties", ".rtf",
            ".zip", ".tar", ".gz", ".7z", ".rar",
        };
        return supported.count(ext) > 0;
    }

    std::unordered_map<std::string, PatternInfo> patterns_;
    std::unordered_map<std::string, float> keywords_;
    std::unordered_set<std::string> fingerprints_;
    std::mutex fpMutex_;
    LogCallback logger_;
};

/* ════════════════════════════════════════════════════════════════════════════
 * 4. USB ENFORCER — Execute block/allow/alert/quarantine/encrypt actions
 * ════════════════════════════════════════════════════════════════════════════ */

class UsbEnforcer {
public:
    using LogCallback = std::function<void(const std::string&, const std::string&)>;

    UsbEnforcer(const std::string& quarantineDir, LogCallback logger)
        : quarantineDir_(quarantineDir), logger_(logger) {
        try { fs::create_directories(quarantineDir_); } catch (...) {}
    }

    /** Execute enforcement action */
    std::string Execute(const std::string& action, UsbFileEvent& event) {
        logger_("INFO", "POLICY_DECISION: " + action + " for " + event.fileName);

        if (action == "Block") {
            return Block(event);
        } else if (action == "Quarantine") {
            return Quarantine(event);
        } else if (action == "Alert") {
            return Alert(event);
        } else if (action == "Encrypt") {
            return Encrypt(event);
        }

        logger_("INFO", "ACTION_ENFORCED: ALLOW — " + event.fileName);
        return "Allow";
    }

private:
    std::string Block(UsbFileEvent& event) {
        try {
            if (fs::exists(event.destinationPath)) {
                fs::remove(event.destinationPath);
                logger_("WARNING", "ACTION_ENFORCED: BLOCKED — Deleted " +
                        event.fileName + " from USB");
                return "Block";
            }
        } catch (const std::exception& e) {
            logger_("ERROR", "Block failed for " + event.fileName + ": " + e.what());
        }
        return "Block_Failed";
    }

    std::string Quarantine(UsbFileEvent& event) {
        try {
            auto now = std::chrono::system_clock::now();
            auto t = std::chrono::system_clock::to_time_t(now);
            std::string timestamp = std::to_string(t);

            std::string quarPath = quarantineDir_ + "\\" +
                                   timestamp + "_" + event.fileName;

            if (fs::exists(event.destinationPath)) {
                fs::rename(event.destinationPath, quarPath);
                logger_("WARNING", "ACTION_ENFORCED: QUARANTINED — " +
                        event.fileName + " → " + quarPath);
                return "Quarantine";
            }
        } catch (const std::exception& e) {
            logger_("ERROR", "Quarantine failed: " + std::string(e.what()));
        }
        return "Quarantine_Failed";
    }

    std::string Alert(UsbFileEvent& event) {
        logger_("INFO", "ACTION_ENFORCED: ALERT — " + event.fileName +
                " (category=" + event.category + ")");
        return "Alert";
    }

    std::string Encrypt(UsbFileEvent& event) {
        // Basic XOR encryption as placeholder — production should use AES-256
        try {
            std::string path = event.destinationPath;
            std::ifstream in(path, std::ios::binary);
            if (!in.is_open()) return "Encrypt_Failed";

            std::string content((std::istreambuf_iterator<char>(in)),
                                 std::istreambuf_iterator<char>());
            in.close();

            // XOR with key (production: replace with proper AES)
            const std::string key = "CyberSentinelDLP";
            for (size_t i = 0; i < content.size(); i++) {
                content[i] ^= key[i % key.size()];
            }

            std::ofstream out(path + ".encrypted", std::ios::binary);
            out.write(content.data(), content.size());
            out.close();

            fs::remove(path);
            logger_("INFO", "ACTION_ENFORCED: ENCRYPTED — " + event.fileName);
            return "Encrypt";
        } catch (...) {
            return "Encrypt_Failed";
        }
    }

    std::string quarantineDir_;
    LogCallback logger_;
};

} /* namespace cs_usb */
