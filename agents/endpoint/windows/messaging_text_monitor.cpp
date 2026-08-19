// messaging_text_monitor.cpp — see messaging_text_monitor.h for the design and
// for why every failure path releases the keystroke.

// Feature macros first — they gate QueryFullProcessImageName and the UI
// Automation interface declarations, and only take effect before <windows.h>.
// Kept identical to network_exfil_monitor.cpp so both modules see one ABI.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601      // Windows 7+, matches agent.cpp
#endif
#define _WIN32_DCOM
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <psapi.h>
#include <UIAutomation.h>

#include "messaging_text_monitor.h"

#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <string>
#include <vector>
#include <sstream>
#include <algorithm>
#include <cctype>

namespace MessagingTextMonitor {
namespace {

Config            g_cfg;
std::atomic<bool> g_running{false};
std::atomic<bool> g_stop{false};

HHOOK       g_hook       = nullptr;
DWORD       g_hookThread = 0;
std::thread g_hookThreadObj;
std::thread g_workerObj;

// ── Hook -> worker handoff ────────────────────────────────────────────────
// The hook must never block, so it publishes the bare facts and wakes the
// worker. One pending send at a time: a second Enter while a decision is in
// flight is passed straight through rather than queued, because queueing
// keystrokes is how you end up delivering them in the wrong order.
std::mutex              g_mx;
std::condition_variable g_cv;
bool                    g_pendingWork = false;
HWND                    g_pendingWnd  = nullptr;
DWORD                   g_pendingPid  = 0;
bool                    g_pendingCtrl = false;

// True from the moment we swallow the Enter keydown until the decision is made.
// Read by the hook to also swallow the matching keyup (an app that sees a keyup
// with no keydown is not harmed, but it is untidy and some Electron composers
// do watch for it).
std::atomic<bool> g_decisionPending{false};

void LogMsg(const char* level, const std::string& m) {
    if (g_cfg.log) { try { g_cfg.log(level, "MessagingText: " + m); } catch (...) {} }
}
void LogInfo(const std::string& m) { LogMsg("INFO",  m); }
void LogWarn(const std::string& m) { LogMsg("WARNING", m); }
void LogDbg (const std::string& m) { LogMsg("DEBUG", m); }

std::string ToLowerAscii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return (char)std::tolower(c); });
    return s;
}

std::string WideToUtf8(const wchar_t* w) {
    if (!w) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string out((size_t)n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
    return out;
}

std::string ProcessExeName(DWORD pid) {
    if (!pid) return {};
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return {};
    wchar_t buf[MAX_PATH] = {0};
    DWORD sz = MAX_PATH;
    std::string out;
    if (QueryFullProcessImageNameW(h, 0, buf, &sz)) {
        std::string full = WideToUtf8(buf);
        size_t slash = full.find_last_of("\\/");
        out = (slash == std::string::npos) ? full : full.substr(slash + 1);
    }
    CloseHandle(h);
    return ToLowerAscii(out);
}

// ── Reading the composer ──────────────────────────────────────────────────

// Pull text out of one element: ValuePattern for a plain edit, TextPattern for
// the rich/contenteditable composers that Electron and WinUI apps actually use.
std::string TextFromElement(IUIAutomationElement* el) {
    if (!el) return {};
    std::string out;

    IUnknown* pat = nullptr;
    if (SUCCEEDED(el->GetCurrentPattern(UIA_ValuePatternId, &pat)) && pat) {
        IUIAutomationValuePattern* vp = nullptr;
        pat->QueryInterface(IID_IUIAutomationValuePattern, (void**)&vp);
        pat->Release();
        if (vp) {
            BSTR v = nullptr;
            if (SUCCEEDED(vp->get_CurrentValue(&v)) && v) {
                out = WideToUtf8(v);
                SysFreeString(v);
            }
            vp->Release();
        }
    }
    if (!out.empty()) return out;

    pat = nullptr;
    if (SUCCEEDED(el->GetCurrentPattern(UIA_TextPatternId, &pat)) && pat) {
        IUIAutomationTextPattern* tp = nullptr;
        pat->QueryInterface(IID_IUIAutomationTextPattern, (void**)&tp);
        pat->Release();
        if (tp) {
            IUIAutomationTextRange* range = nullptr;
            if (SUCCEEDED(tp->get_DocumentRange(&range)) && range) {
                BSTR t = nullptr;
                if (SUCCEEDED(range->GetText(-1, &t)) && t) {
                    out = WideToUtf8(t);
                    SysFreeString(t);
                }
                range->Release();
            }
            tp->Release();
        }
    }
    return out;
}

// The box the user is typing in is the focused element — true by construction,
// since they just pressed Enter into it. Falling back to a descendant sweep
// covers apps that put focus on a wrapper rather than the editable node itself.
std::string ReadComposerText(IUIAutomation* uia, HWND wnd) {
    if (!uia) return {};

    IUIAutomationElement* focused = nullptr;
    if (SUCCEEDED(uia->GetFocusedElement(&focused)) && focused) {
        std::string t = TextFromElement(focused);
        focused->Release();
        if (!t.empty()) return t;
    }

    if (!wnd) return {};
    IUIAutomationElement* root = nullptr;
    if (FAILED(uia->ElementFromHandle(wnd, &root)) || !root) return {};

    // Edit and Document are what every composer we care about reports as.
    std::string best;
    for (int controlType : { UIA_EditControlTypeId, UIA_DocumentControlTypeId }) {
        IUIAutomationCondition* cond = nullptr;
        VARIANT v; VariantInit(&v);
        v.vt = VT_I4; v.lVal = controlType;
        if (FAILED(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, v, &cond)) || !cond) {
            continue;
        }
        IUIAutomationElementArray* arr = nullptr;
        root->FindAll(TreeScope_Descendants, cond, &arr);
        if (arr) {
            int n = 0; arr->get_Length(&n);
            for (int i = 0; i < n && best.empty(); ++i) {
                IUIAutomationElement* el = nullptr;
                arr->GetElement(i, &el);
                if (!el) continue;
                std::string t = TextFromElement(el);
                // Longest wins: a chat window also contains the message history,
                // but the history is not an Edit/Document the user can type into,
                // and where it is, the composer is the one with focus above.
                if (t.size() > best.size()) best = t;
                el->Release();
            }
            arr->Release();
        }
        cond->Release();
    }
    root->Release();
    return best;
}

// ── Releasing a held keystroke ────────────────────────────────────────────
// Replay as a genuine keypress. Windows stamps it LLKHF_INJECTED, which the
// hook checks first, so this cannot come back round to us.
void ReleaseKeystroke(bool withCtrl) {
    INPUT in[4] = {};
    int n = 0;
    if (withCtrl) {
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_CONTROL; ++n;
    }
    in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_RETURN; ++n;
    in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_RETURN;
    in[n].ki.dwFlags = KEYEVENTF_KEYUP; ++n;
    if (withCtrl) {
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_CONTROL;
        in[n].ki.dwFlags = KEYEVENTF_KEYUP; ++n;
    }
    SendInput(n, in, sizeof(INPUT));
}

// ── Events ────────────────────────────────────────────────────────────────

std::string EscapeJson(const std::string& s) {
    std::string out; out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    sprintf(buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;
                }
        }
    }
    return out;
}

std::string NowIso8601() {
    SYSTEMTIME st; GetSystemTime(&st);
    char buf[64];
    sprintf(buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    return buf;
}

std::string GenerateUuidLike() {
    GUID g;
    if (FAILED(CoCreateGuid(&g))) return "00000000-0000-0000-0000-000000000000";
    char buf[64];
    sprintf(buf, "%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            (unsigned long)g.Data1, g.Data2, g.Data3,
            g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3],
            g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7]);
    return buf;
}

void EmitEvent(const std::string& exe, DWORD pid, const std::string& action,
               const std::string& severity,
               const NetworkExfilMonitor::ClassifyResult& cls,
               const std::string& reason, const std::string& text) {
    if (!g_cfg.sendEvent) return;
    std::ostringstream j;
    j << "{";
    j << "\"event_id\":\""      << EscapeJson(GenerateUuidLike()) << "\",";
    j << "\"event_type\":\""    << "messaging"                    << "\",";
    j << "\"event_subtype\":\"" << "messaging_message"            << "\",";
    j << "\"agent_id\":\""      << EscapeJson(g_cfg.agentId)      << "\",";
    j << "\"source_type\":\""   << "agent"                        << "\",";
    j << "\"user_email\":\""    << EscapeJson(g_cfg.username + "@" + g_cfg.hostname) << "\",";
    j << "\"severity\":\""      << EscapeJson(severity)           << "\",";
    j << "\"action\":\""        << EscapeJson(action)             << "\",";
    j << "\"channel\":\""       << "MESSAGING"                    << "\",";
    j << "\"process_name\":\""  << EscapeJson(exe)                << "\",";
    j << "\"process_id\":"      << pid                            << ",";
    j << "\"destination\":\""   << EscapeJson(exe)                << "\",";
    j << "\"destination_type\":\"" << "messaging_app"             << "\",";
    j << "\"blocked\":"         << (action == "BLOCK" ? "true" : "false") << ",";
    if (!cls.category.empty()) {
        j << "\"classification_level\":\"" << EscapeJson(cls.category) << "\",";
        j << "\"classification_score\":"   << cls.score                << ",";
    }
    if (!cls.matchedRule.empty()) {
        j << "\"classification_rule_matched\":\"" << EscapeJson(cls.matchedRule) << "\",";
    }
    if (!cls.labels.empty()) {
        j << "\"classification_labels\":[";
        for (size_t i = 0; i < cls.labels.size(); ++i) {
            if (i) j << ",";
            j << "\"" << EscapeJson(cls.labels[i]) << "\"";
        }
        j << "],";
    }
    // The message itself is the evidence, exactly as the typed prompt is for the
    // browser extension: "an Aadhaar number went to WhatsApp" is not something an
    // analyst can triage without seeing what was actually about to be sent. It
    // travels the same authenticated channel and inherits the same retention and
    // read-redaction handling as every other captured content field.
    if (!text.empty()) {
        j << "\"content\":\"" << EscapeJson(text) << "\",";
    }
    if (!reason.empty()) {
        j << "\"description\":\"" << EscapeJson(reason) << "\",";
    }
    j << "\"timestamp\":\"" << NowIso8601() << "\"";
    j << "}";
    try { g_cfg.sendEvent(j.str()); } catch (...) {}
}

// A blocked send with no explanation looks like the app is broken, and a user
// who thinks the app is broken files a ticket or works around the agent. Own
// thread: MessageBox is modal and must never stall the worker.
void ShowBlockedNotice(const std::string& appExe, const std::string& what) {
    std::string body =
        "Sending this message was blocked by your organisation's data-loss policy.\n\n"
        "Detected: " + (what.empty() ? std::string("sensitive data") : what) + "\n"
        "Application: " + appExe + "\n\n"
        "The text is still in the message box. Remove the sensitive details to send it.";
    std::thread([body]() {
        MessageBoxA(nullptr, body.c_str(), "CyberSentinel DLP — Message blocked",
                    MB_OK | MB_ICONWARNING | MB_SYSTEMMODAL | MB_SETFOREGROUND);
    }).detach();
}

// ── Worker ────────────────────────────────────────────────────────────────

void DecideAndAct(IUIAutomation* uia, HWND wnd, DWORD pid, bool withCtrl) {
    const std::string exe = ProcessExeName(pid);

    std::string text;
    try { text = ReadComposerText(uia, wnd); } catch (...) {}

    if (text.size() > g_cfg.maxTextBytes) text.resize(g_cfg.maxTextBytes);

    // Trim — a composer that "contains" only a newline is empty.
    const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    auto b = std::find_if(text.begin(), text.end(), notSpace);
    auto e = std::find_if(text.rbegin(), text.rend(), notSpace).base();
    text = (b < e) ? std::string(b, e) : std::string();

    if (text.empty()) {
        // Nothing readable. Could be an empty box, could be an app whose composer
        // UI Automation cannot see. Either way the user's Enter is not ours to
        // keep — release it. See the header on why this fails open.
        LogDbg("no composer text for " + exe + " — releasing keystroke");
        ReleaseKeystroke(withCtrl);
        return;
    }

    NetworkExfilMonitor::ClassifyResult cls;
    try { cls = g_cfg.classify(text, "messaging_message"); } catch (...) {}

    const std::string cat = ToLowerAscii(cls.category);
    const bool sensitive = (cat == "confidential" || cat == "restricted");

    if (!sensitive) {
        LogDbg("message clean (" + (cls.category.empty() ? std::string("unclassified") : cls.category) +
               ") in " + exe + " — releasing");
        ReleaseKeystroke(withCtrl);
        return;
    }

    std::string what;
    for (const auto& l : cls.labels) {
        if (!what.empty()) what += ", ";
        what += l;
    }
    if (what.empty()) what = cls.matchedRule;

    const std::string severity = (cat == "restricted") ? "critical" : "high";
    EmitEvent(exe, pid, "BLOCK", severity, cls,
              "Blocked sensitive message in " + exe + " (" + cls.category + ")", text);
    LogWarn("MESSAGING_TEXT_BLOCKED exe=" + exe + " category=" + cls.category +
            " detected=[" + what + "]");
    ShowBlockedNotice(exe, what);
    // Deliberately no ReleaseKeystroke: dropping the held Enter IS the block.
    // The text stays in the box so the user can edit and resend.
}

void WorkerThread() {
    // MTA: UI Automation is called from here and nowhere else.
    HRESULT hrCom = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comOk = SUCCEEDED(hrCom);

    IUIAutomation* uia = nullptr;
    if (comOk) {
        CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                         IID_IUIAutomation, (void**)&uia);
    }
    if (!uia) {
        LogWarn("UIAutomation unavailable — typed-message inspection disabled "
                "(keystrokes will not be held)");
    }

    while (!g_stop.load()) {
        HWND  wnd  = nullptr;
        DWORD pid  = 0;
        bool  ctrl = false;
        {
            std::unique_lock<std::mutex> lk(g_mx);
            g_cv.wait_for(lk, std::chrono::milliseconds(200),
                          [] { return g_pendingWork || g_stop.load(); });
            if (g_stop.load()) break;
            if (!g_pendingWork) continue;
            wnd = g_pendingWnd; pid = g_pendingPid; ctrl = g_pendingCtrl;
            g_pendingWork = false;
        }

        try {
            if (uia) {
                DecideAndAct(uia, wnd, pid, ctrl);
            } else {
                // We swallowed a keystroke we now cannot adjudicate. Give it back.
                ReleaseKeystroke(ctrl);
            }
        } catch (...) {
            LogWarn("decision threw — releasing keystroke");
            try { ReleaseKeystroke(ctrl); } catch (...) {}
        }
        g_decisionPending.store(false);
    }

    if (uia) uia->Release();
    if (comOk) CoUninitialize();
}

// ── The hook ──────────────────────────────────────────────────────────────

LRESULT CALLBACK KeyProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode != HC_ACTION) return CallNextHookEx(g_hook, nCode, wParam, lParam);

    KBDLLHOOKSTRUCT* k = (KBDLLHOOKSTRUCT*)lParam;
    if (!k || k->vkCode != VK_RETURN) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }
    // Our own replay. Must be first: everything below would otherwise re-hold it.
    if (k->flags & LLKHF_INJECTED) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    const bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool isUp   = (wParam == WM_KEYUP   || wParam == WM_SYSKEYUP);

    // Swallow the keyup belonging to a keydown we already took.
    if (isUp && g_decisionPending.load()) return 1;
    if (!isDown) return CallNextHookEx(g_hook, nCode, wParam, lParam);

    // Shift+Enter is "new line" in every one of these apps — never a send.
    if (GetAsyncKeyState(VK_SHIFT) & 0x8000) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }
    // One decision at a time; a second Enter goes straight through.
    if (g_decisionPending.load()) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    HWND fg = GetForegroundWindow();
    if (!fg) return CallNextHookEx(g_hook, nCode, wParam, lParam);
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    if (!pid || pid == GetCurrentProcessId()) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    const std::string exe = ProcessExeName(pid);
    if (exe.empty()) return CallNextHookEx(g_hook, nCode, wParam, lParam);

    NetworkExfilMonitor::MessagingVerdict mv;
    if (g_cfg.messagingPolicy) {
        try { mv = g_cfg.messagingPolicy(exe, g_cfg.username); } catch (...) {}
    }
    // Hold ONLY for a managed app, with typed-message inspection on, in block
    // mode. In alert mode we never touch input — see the header.
    if (!mv.managed || !mv.inspectMessages || !mv.block) {
        return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    const bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;

    g_decisionPending.store(true);
    {
        std::lock_guard<std::mutex> lk(g_mx);
        g_pendingWnd  = fg;
        g_pendingPid  = pid;
        g_pendingCtrl = ctrl;
        g_pendingWork = true;
    }
    g_cv.notify_one();

    return 1;   // hold it; the worker releases or drops it
}

void HookThread() {
    g_hookThread = GetCurrentThreadId();
    g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyProc, GetModuleHandle(nullptr), 0);
    if (!g_hook) {
        LogWarn("SetWindowsHookEx(WH_KEYBOARD_LL) failed err=" +
                std::to_string((unsigned long)GetLastError()));
        g_running.store(false);
        return;
    }
    LogInfo("typed-message keyboard hook installed");

    // A low-level hook is only serviced while its installing thread pumps
    // messages. No window, no timers — just the pump.
    MSG msg;
    while (!g_stop.load() && GetMessage(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    UnhookWindowsHookEx(g_hook);
    g_hook = nullptr;
    LogInfo("typed-message keyboard hook removed");
}

} // namespace

bool Start(const Config& cfg) {
    if (g_running.load()) return true;
    if (!cfg.classify || !cfg.sendEvent || !cfg.log || !cfg.messagingPolicy) {
        return false;
    }
    g_cfg = cfg;
    g_stop.store(false);
    g_decisionPending.store(false);
    g_running.store(true);

    g_workerObj    = std::thread(WorkerThread);
    g_hookThreadObj = std::thread(HookThread);

    // Give the hook a moment to report failure so Start() reflects reality.
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    return g_running.load();
}

void Stop() {
    if (!g_running.load()) return;
    g_stop.store(true);
    if (g_hookThread) PostThreadMessage(g_hookThread, WM_QUIT, 0, 0);
    g_cv.notify_all();
    if (g_hookThreadObj.joinable()) g_hookThreadObj.join();
    if (g_workerObj.joinable())     g_workerObj.join();
    g_running.store(false);
}

bool IsRunning() { return g_running.load(); }

} // namespace MessagingTextMonitor
