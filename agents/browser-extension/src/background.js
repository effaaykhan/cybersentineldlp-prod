/**
 * CyberSentinel DLP — service worker (MV3).
 *
 * One worker for the whole extension. It owns:
 *
 *   • enrolment with the DLP manager (registration, agent key, heartbeat)
 *   • the app catalog and the web-activity policy matrix, both cached
 *   • dynamic registration of the guard on catalogued hosts only
 *   • every decision — POST /agents/{id}/policy/evaluate — and every event
 *   • the offscreen document that runs OCR and PDF extraction
 *   • the download hook, which is how the Download verb is covered at all
 *
 * ── HOW THIS CAME TOGETHER ───────────────────────────────────────────────
 *
 * Two extensions were merged here. One guarded cloud file uploads by asking a
 * native-messaging host to call the DLP server; the other guarded Gmail and
 * Outlook, talked to the server over HTTP, and decided locally from a bundled
 * regex list. Running both meant two extensions, two enrolments, two agent rows
 * on the dashboard, two answers to "is this file sensitive", and a user who had
 * to install both to be covered.
 *
 * Transport is now HTTP, always. The native host is still supported but its role
 * has shrunk to answering "which agent is this machine?" — see resolveNativeHint.
 * Keeping it as a second *decision* path would have meant maintaining two
 * implementations of the same policy contract, which is exactly how the two
 * extensions drifted apart in the first place.
 *
 * ── WHY THE CATALOG AND POLICY ARE CACHED HERE ───────────────────────────
 *
 * MV3 tears this worker down aggressively and restarts it on the next event, so
 * anything held only in a local variable is gone within seconds of going idle.
 * Both caches are mirrored into chrome.storage.local and reloaded on wake; the
 * network sync is a refresh, never a prerequisite. A worker that had to reach
 * the server before it could answer a content script would leave the first page
 * of every browsing session unguarded.
 */
"use strict";

importScripts("catalog.js", "policy.js");

const DEFAULT_API_PATH = "/api/v1";

// The CyberSentinel dashboard host. Port 3023 serves the dashboard UI and
// proxies /api/v1 through to the API service, so one address covers both --
// events posted here land in the same Events view the endpoint agents feed.
// Seeded on install so a fresh profile reports somewhere real instead of
// silently dropping every event until someone opens Options; still fully
// overridable there.
const DEFAULT_SERVER_URL = "http://192.168.2.204:3023/api/v1";

const NATIVE_HOST = "com.cybersentineldlp.dlp";
const HEARTBEAT_ALARM = "cybersentinel-heartbeat";
const SYNC_ALARM = "cybersentinel-sync";
// Server treats an agent as disconnected after 120s without contact, so beat
// well inside that window to tolerate a missed beat.
const HEARTBEAT_PERIOD_MINUTES = 1;
// Catalog and policy change at human speed, not machine speed. Five minutes is
// fast enough that an operator who adds a GenAI vendor sees it take effect while
// they are still looking at the screen.
const SYNC_PERIOD_MINUTES = 5;
const REQUEST_TIMEOUT_MS = 10000;
const EVENT_SEND_ATTEMPTS = 3;
// Ceiling on the whole decision, including every attachment. Shorter than the
// content script's own timeout so the guard hears a real answer rather than its
// own fallback firing first.
const EVALUATE_TIMEOUT_MS = 9000;
// Prompts and email bodies can be enormous. Classification does not improve past
// a point, and an unbounded POST from a content script is a denial-of-service
// waiting to happen against the manager.
const MAX_TEXT_CHARS = 200000;

// Three registrations, because the pieces need different worlds and timings:
//
//   page   — MAIN world, document_start. Must patch fetch/XHR before the page
//            has a chance to use them, and must run in the page's own realm to
//            patch the same functions the page holds.
//   bridge — ISOLATED, document_start. Tiny; arms the page hook with the app
//            identity and policy it cannot look up for itself.
//   guard  — ISOLATED, document_idle. The heavy set (scanner, OCR client,
//            profiles, guard). Deferred because none of it is useful before
//            there is a DOM to guard.
const SCRIPT_SETS = [
  {
    id: "csdlp-page",
    world: "MAIN",
    runAt: "document_start",
    js: ["src/inject.js"]
  },
  {
    id: "csdlp-bridge",
    world: "ISOLATED",
    runAt: "document_start",
    js: ["src/policy.js", "src/content.js"]
  },
  {
    id: "csdlp-guard",
    world: "ISOLATED",
    runAt: "document_idle",
    js: [
      "src/catalog.js",
      "src/policy.js",
      "src/scanner.js",
      "src/attachment-inspector.js",
      "src/profiles.js",
      "src/activity-guard.js",
      "src/guard-boot.js"
    ]
  }
];

function log(...a) { console.log("[CS-DLP]", ...a); }
function warn(...a) { console.warn("[CS-DLP]", ...a); }

/* ── Configuration ─────────────────────────────────────────────────────── */

/**
 * Repair whatever the user typed in Options into a usable API base URL.
 *
 * Accepts "192.168.2.204:55100", "http://192.168.2.204:55100",
 * "http://192.168.2.204:55100/", "…/api/v1", "…/api/v1/" and even
 * "…/api/v1/events" — all normalise to "http://192.168.2.204:55100/api/v1".
 * Returns "" when the value can't be parsed as a URL at all.
 */
function normalizeServerUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return "";
  }

  let path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  // Keep everything up to and including the API version segment, and discard
  // any endpoint path pasted after it.
  const versioned = path.match(/^(.*\/api\/v\d+)(?:\/.*)?$/);
  path = versioned ? versioned[1] : path + DEFAULT_API_PATH;

  return url.origin + path;
}

function originPatternFor(serverUrl) {
  try {
    return new URL(serverUrl).origin + "/*";
  } catch (e) {
    return null;
  }
}

/**
 * Configuration an administrator pushed by enterprise policy, if any.
 *
 * Written by manage-windows-agent.ps1 into the browser's 3rdparty extension
 * policy key and surfaced here as chrome.storage.managed. Always wins over
 * anything in the Options page — that is the point of it being policy.
 */
async function getManagedConfig() {
  try {
    if (!chrome.storage.managed) return {};
    return (await chrome.storage.managed.get([
      "serverUrl", "agentId", "diagnosticMode"
    ])) || {};
  } catch (e) {
    // No policy configured is the overwhelmingly common case on an unmanaged
    // browser, and it throws on some builds rather than returning empty.
    return {};
  }
}

/**
 * Who this browser reports as.
 *
 * ── ONE AGENT PER DEVICE ─────────────────────────────────────────────────
 * When policy supplies `agentId`, this extension ATTACHES to the endpoint
 * agent already installed on the machine instead of enrolling separately. A
 * device running both then appears once on the dashboard, with USB copies,
 * print jobs and ChatGPT prompts all on the same agent — which is what an
 * analyst correlating them needs.
 *
 * Two consequences follow, and both are deliberate:
 *   • We never call POST /agents/ when attached. Re-registering someone else's
 *     row would overwrite its os / version / ip_address with ours, quietly
 *     corrupting the real agent's record.
 *   • We never heartbeat when attached. The endpoint agent owns that signal;
 *     beating on its behalf would show a machine as "active" whenever a browser
 *     was open, even with the agent dead — turning liveness into a lie.
 *
 * With no policy (an extension-only install) it enrols on its own exactly as
 * before, so that deployment is unaffected.
 */
async function getConfig() {
  const [stored, managed] = await Promise.all([
    chrome.storage.local.get(["serverUrl", "agentId", "agentKey", "canonicalAgentId"]),
    getManagedConfig()
  ]);

  const managedAgentId = (managed.agentId || "").trim();
  const attached = !!managedAgentId;

  const agentId = managedAgentId
    || (stored.agentId || "").trim()
    || "browser-extension-unconfigured";
  const rawServerUrl = (managed.serverUrl || "").trim()
    || (stored.serverUrl || "").trim()
    || DEFAULT_SERVER_URL;

  return {
    rawServerUrl,
    serverUrl: normalizeServerUrl(rawServerUrl),
    agentId,
    attached,
    // Identity the server told us to use; falls back to the configured one.
    // When attached, the policy-supplied id is authoritative and a stale
    // canonical id from a previous self-enrolment must not override it.
    reportingAgentId: attached ? managedAgentId : (stored.canonicalAgentId || agentId),
    // Agent endpoints are backward-compatible keyless (verify_agent_key returns
    // None with no header), which is how the endpoint agent itself talks to
    // them — so an attached extension needs no credential of its own.
    agentKey: attached ? null : (stored.agentKey || null),
    managed
  };
}

function detectOs() {
  const ua = navigator.userAgent || "";
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Linux")) return "linux";
  if (ua.includes("Mac")) return "macos";
  return "unknown";
}

/** Record the last outcome so the Options popup can show real status. */
async function setStatus(ok, message) {
  await chrome.storage.local.set({
    lastStatus: { ok, message, at: new Date().toISOString() }
  });
}

/**
 * Do we hold host permission for this server? Without it the service worker's
 * fetch is subject to CORS and the server will reject it, so this is worth
 * reporting explicitly rather than as "Failed to fetch".
 */
async function hasHostPermission(serverUrl) {
  const pattern = originPatternFor(serverUrl);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch (e) {
    return false;
  }
}

/**
 * Single HTTP call to the DLP API. Never throws — always resolves to
 * {ok, status, data, error}.
 */
async function apiFetch(serverUrl, path, { method = "GET", body = null, agentKey = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {};
  if (body !== null) headers["Content-Type"] = "application/json";
  if (agentKey) headers["X-Agent-Key"] = agentKey;

  try {
    const resp = await fetch(`${serverUrl}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const text = await resp.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        data,
        error: `HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`
      };
    }
    return { ok: true, status: resp.status, data, error: null };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    const permitted = await hasHostPermission(serverUrl);
    let error;
    if (aborted) {
      error = `No response within ${timeoutMs / 1000}s — is ${serverUrl} reachable from this machine?`;
    } else if (!permitted) {
      // The give-away signature of a CORS rejection from an extension: fetch
      // rejects with an opaque TypeError and no status.
      error =
        "Blocked before reaching the server: this extension holds no host permission for " +
        `${originPatternFor(serverUrl)}. Reload the extension (chrome://extensions) so the ` +
        "manifest's host permissions apply, then Save the settings again.";
    } else {
      error = `Network error reaching ${serverUrl}: ${err && err.message ? err.message : String(err)}`;
    }
    return { ok: false, status: 0, data: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Enrolment ─────────────────────────────────────────────────────────── */

let registeredThisSession = false;

/**
 * Ask a native-messaging host, if one is installed, which agent this machine
 * already is.
 *
 * This is all that remains of the native host's former role. Where the endpoint
 * agent is installed, its identity is the RIGHT identity for browser events —
 * otherwise the same laptop shows up on the dashboard twice, once as the agent
 * and once as "some browser", and an analyst correlating a USB copy with a
 * ChatGPT paste has to know they are the same machine.
 *
 * Entirely optional. Every deployment without a native host — which includes the
 * Linux one this was first tested on — self-registers below and works.
 */
function resolveNativeHint() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      log("no native host (connect threw):", e && e.message);
      return done(null);
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "pong" || msg.type === "identity") {
        done({ agentId: msg.agent_id || null, serverUrl: msg.server || null });
        try { port.disconnect(); } catch (e) {}
      }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      log("native host unavailable:", err ? err.message : "(disconnected)");
      done(null);
    });

    try {
      port.postMessage({ type: "ping" });
    } catch (e) {
      done(null);
    }
    // A host that never answers must not stall enrolment.
    setTimeout(() => done(null), 1500);
  });
}

/**
 * Register (or re-register — idempotent server-side) this browser with the
 * server so events attribute to a real dashboard row instead of "Unknown
 * Agent". MV3 service workers are torn down freely, so this also runs
 * opportunistically before sending an event.
 */
async function registerAgent() {
  const cfg = await getConfig();
  if (cfg.attached) {
    // Attached to the endpoint agent by policy — its row is not ours to write.
    // See getConfig(): registering would overwrite the real agent's os,
    // version and ip_address with the browser's.
    registeredThisSession = true;
    await setStatus(true, `Reporting as endpoint agent "${cfg.reportingAgentId}" (set by policy).`);
    return { ok: true, agentId: cfg.reportingAgentId, attached: true };
  }
  if (!cfg.serverUrl) {
    const error = "No server URL configured — open the extension's Options and set the DLP Server URL.";
    warn(error);
    await setStatus(false, error);
    return { ok: false, error };
  }

  const body = {
    agent_id: cfg.reportingAgentId,
    name: cfg.agentId,
    os: detectOs(),
    ip_address: "browser-extension",  // extensions have no reliable local-IP API
    version: chrome.runtime.getManifest().version,
    capabilities: { email_dlp: true, ocr: true, web_activity_control: true }
  };

  // Deliberately sent WITHOUT X-Agent-Key: this is the enrollment call that
  // *issues* the key, and it needs no auth. Sending a stale key here would make
  // registration itself 401 — the one call that can recover from a stale key —
  // and deadlock the extension offline permanently.
  const res = await apiFetch(cfg.serverUrl, "/agents/", { method: "POST", body });
  if (!res.ok) {
    console.error("[CyberSentinel] Agent registration failed:", res.error);
    await setStatus(false, `Registration failed: ${res.error}`);
    return { ok: false, error: res.error };
  }

  const data = res.data || {};
  const updates = {};
  // Adopt the server's canonical id — it may differ from what we sent.
  if (data.agent_id) updates.canonicalAgentId = data.agent_id;
  if (data.api_key) updates.agentKey = data.api_key;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);

  registeredThisSession = true;
  log("registered with server as", data.agent_id || cfg.reportingAgentId);
  await setStatus(true, `Registered with ${cfg.serverUrl} as "${data.agent_id || cfg.reportingAgentId}".`);
  return { ok: true, agentId: data.agent_id || cfg.reportingAgentId, agentCode: data.agent_code };
}

async function ensureRegistered() {
  if (!registeredThisSession) await registerAgent();
}

/**
 * Keep the dashboard's agent row showing "active". A 404 means the agent record
 * was deleted server-side, so re-register and beat again.
 */
async function sendHeartbeat() {
  const cfg = await getConfig();
  if (cfg.attached) {
    // The endpoint agent owns this signal. Beating on its behalf would report a
    // machine as active whenever a browser happened to be open, even with the
    // agent dead — see getConfig().
    return { ok: true, skipped: "attached" };
  }
  if (!cfg.serverUrl) return { ok: false, error: "No server URL configured." };

  if (!registeredThisSession) {
    const reg = await registerAgent();
    if (!reg.ok) return reg;
  }

  const fresh = await getConfig();
  const path = `/agents/${encodeURIComponent(fresh.reportingAgentId)}/heartbeat`;
  const body = { status: "active", ip_address: "browser-extension" };

  let res = await apiFetch(fresh.serverUrl, path, { method: "PUT", body, agentKey: fresh.agentKey });

  if (res.status === 404 || res.status === 401) {
    registeredThisSession = false;
    if (res.status === 401) await chrome.storage.local.remove("agentKey");
    const reg = await registerAgent();
    if (!reg.ok) return reg;
    const retryCfg = await getConfig();
    res = await apiFetch(
      retryCfg.serverUrl,
      `/agents/${encodeURIComponent(retryCfg.reportingAgentId)}/heartbeat`,
      { method: "PUT", body, agentKey: retryCfg.agentKey }
    );
  }

  if (!res.ok) {
    warn("heartbeat failed:", res.error);
    await setStatus(false, `Heartbeat failed: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true };
}

/* ── Catalog and policy ────────────────────────────────────────────────── */

let cachedPolicy = { enforced: false, mode: "off", matrix: {}, app_overrides: [] };
let catalogEtag = null;

/**
 * Reload both caches from storage. Called on every worker wake, because MV3
 * discards the worker's memory but not its storage — and a worker that answered
 * "not catalogued" while its cache was empty would leave a page unguarded for
 * the whole of that page's life.
 */
async function loadCaches() {
  const stored = await chrome.storage.local.get(["appCatalog", "catalogEtag", "webActivityPolicy"]);
  if (Array.isArray(stored.appCatalog) && stored.appCatalog.length) {
    self.CSDLPCatalog.replace(stored.appCatalog);
  }
  catalogEtag = stored.catalogEtag || null;
  if (stored.webActivityPolicy) cachedPolicy = stored.webActivityPolicy;
}

async function syncCatalog() {
  const cfg = await getConfig();
  if (!cfg.serverUrl) return false;
  await ensureRegistered();

  const query = catalogEtag ? `?etag=${encodeURIComponent(catalogEtag)}` : "";
  const res = await apiFetch(cfg.serverUrl, `/app-catalog/sync${query}`, {
    agentKey: cfg.agentKey
  });
  if (!res.ok) {
    warn("catalog sync failed (using cached/bundled list):", res.error);
    return false;
  }
  const data = res.data || {};
  if (data.unchanged) return false;
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    // Refused deliberately: a server that answered with nothing is far more
    // likely to be misconfigured than to genuinely have zero apps, and
    // accepting it would silently switch off every interception.
    warn("catalog sync returned no entries — keeping the previous list.");
    return false;
  }

  self.CSDLPCatalog.replace(data.entries);
  catalogEtag = data.etag || null;
  await chrome.storage.local.set({ appCatalog: data.entries, catalogEtag });
  log(`catalog updated: ${data.entries.length} destinations`);
  return true;
}

async function syncPolicy() {
  const cfg = await getConfig();
  if (!cfg.serverUrl) return false;
  await ensureRegistered();

  const fresh = await getConfig();
  const res = await apiFetch(
    fresh.serverUrl,
    `/agents/${encodeURIComponent(fresh.reportingAgentId)}/web-activity-policy`,
    { agentKey: fresh.agentKey }
  );
  if (!res.ok) {
    warn("policy sync failed (keeping cached matrix):", res.error);
    return false;
  }
  const before = JSON.stringify(cachedPolicy);
  cachedPolicy = res.data || cachedPolicy;
  await chrome.storage.local.set({ webActivityPolicy: cachedPolicy });
  const changed = JSON.stringify(cachedPolicy) !== before;
  if (changed) {
    const names = cachedPolicy.policy_names || [];
    log(
      `web-activity policy: ${cachedPolicy.enforced ? cachedPolicy.mode : "not enforced"}` +
      (names.length ? ` (${names.join(", ")})` : "")
    );
  }
  return changed;
}

/**
 * Register the guard on exactly the catalogued hosts.
 *
 * NOT a static <all_urls> content script, deliberately. The guard pulls in the
 * scanner, the attachment inspector and the profile table; loading all of that
 * into every page anyone opens is a real cost paid overwhelmingly on pages where
 * it does nothing. Registering from the catalog also means an operator adding a
 * vendor to the table gets it guarded on the next sync — no extension release,
 * which was the whole reason the catalog became a table.
 */
async function registerGuardScripts() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
    warn("chrome.scripting unavailable — the activity guard cannot be registered.");
    return;
  }
  const matches = self.CSDLPCatalog.matchPatterns();
  if (!matches.length) return;

  const specs = SCRIPT_SETS.map((s) => ({
    id: s.id,
    matches,
    js: s.js,
    runAt: s.runAt,
    world: s.world,
    allFrames: true,
    persistAcrossSessions: true
  }));

  for (const spec of specs) {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [spec.id] });
      if (existing && existing.length) {
        await chrome.scripting.updateContentScripts([spec]);
      } else {
        await chrome.scripting.registerContentScripts([spec]);
      }
    } catch (e) {
      // A single malformed pattern rejects the whole call, which would leave
      // this piece registered nowhere. Retry without the wildcard-subdomain
      // forms — the ones an odd catalog row can break — rather than losing
      // coverage entirely.
      warn(`${spec.id} registration failed, retrying with exact hosts only:`, e && e.message);
      try {
        const exact = Object.assign({}, spec, {
          matches: matches.filter((m) => m.indexOf("*.") < 0)
        });
        await chrome.scripting.updateContentScripts([exact]).catch(
          () => chrome.scripting.registerContentScripts([exact])
        );
      } catch (e2) {
        console.error(`[CyberSentinel] ${spec.id} could NOT be registered:`, e2 && e2.message);
      }
    }
  }
  log(`registered ${specs.length} script sets across ${matches.length} host patterns`);
}

async function syncAll() {
  const catalogChanged = await syncCatalog();
  await syncPolicy();
  if (catalogChanged) await registerGuardScripts();
}

/* ── Decisions ─────────────────────────────────────────────────────────── */

// category -> event_type. Mirrors core/web_activity.CATEGORY_EVENT_TYPE so the
// dashboard's per-type filters keep working for browser-sourced events.
const CATEGORY_EVENT_TYPE = {
  webmail: "email",
  cloud_storage: "cloud_upload",
  collaboration: "collaboration",
  genai: "genai"
};

function eventTypeFor(category) {
  return CATEGORY_EVENT_TYPE[category] || "web_activity";
}

function clip(text) {
  const s = String(text || "");
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
}

/**
 * One evaluate call. Returns {action, level, reason, severity} or null when the
 * server could not be reached — null is meaningful and must not be conflated
 * with "allow".
 */
async function evaluateOne(cfg, item, ctx) {
  const body = {
    file_name: item.fileName,
    file_content: clip(item.fileContent || ""),
    file_size: item.fileSize || undefined,
    event_type: eventTypeFor(ctx.category),
    destination_type: "web",
    destination_path: ctx.pageUrl,
    destination_host: ctx.pageHost,
    direction: "outbound",
    activity: ctx.activity,
    app_category: ctx.category,
    app_id: ctx.appId,
    app_name: ctx.appName,
    text_content: clip(item.textContent || "")
  };
  if (item.fileB64) body.file_content_b64 = item.fileB64;
  // An attachment we could not read is reported as such rather than as empty.
  // "We couldn't look inside" must never resolve to "therefore it's fine" — a
  // password-protected archive classifies as Public otherwise, which is the
  // single easiest way to walk past a content rule.
  if (item.uninspectable) body.inspection_skipped = "unreadable";

  const res = await apiFetch(
    cfg.serverUrl,
    `/agents/${encodeURIComponent(cfg.reportingAgentId)}/policy/evaluate`,
    { method: "POST", body, agentKey: cfg.agentKey, timeoutMs: EVALUATE_TIMEOUT_MS }
  );

  if (!res.ok) {
    if (res.status === 401) {
      // Key went stale. Drop it, re-enrol, and let the caller's fallback cover
      // this one decision rather than blocking the user while we recover.
      await chrome.storage.local.remove("agentKey");
      registeredThisSession = false;
      registerAgent();
    }
    return null;
  }

  const data = res.data || {};
  const level = (data.classification || {}).level || null;
  let action =
    data.action === "block" ? "block" :
    data.action === "mask" ? "mask" :
    (data.alert_severity ? "alert" : "allow");
  return {
    action,
    // The finished redacted text, authoritative. The guard writes exactly this
    // rather than applying offsets itself, so there is one implementation of
    // the substitution and no way for the two sides to disagree.
    maskedText: typeof data.masked_text === "string" ? data.masked_text : null,
    maskSummary: data.mask_summary || [],
    level,
    reason: data.reason || "",
    severity: data.alert_severity || null,
    extractionStatus: data.extraction_status || null
  };
}

/**
 * Decide one activity.
 *
 * Fans out to the evaluate endpoint once for the typed body and once per
 * readable attachment, because the endpoint classifies one item per call and a
 * single Send routinely carries both. The STRICTEST answer wins, which is the
 * only safe way to combine them: an innocent prompt attached to a photographed
 * passport is not an innocent activity.
 *
 * Returns the verdict AND emits the event, so the guard never has to make two
 * round trips through the message bus for one gesture.
 */
async function evaluateActivity(payload) {
  const cfg = await getConfig();

  // The upload interceptor runs in the page realm and cannot look anything up,
  // so it sends the host and lets us name the app. Filling this in here keeps
  // one resolution path rather than two that can disagree.
  if (!payload.category || !payload.appId) {
    await loadCaches();
    const app = self.CSDLPCatalog.resolve(payload.pageHost, "", "");
    if (app) {
      payload.category = payload.category || app.category;
      payload.appId = payload.appId || app.app_id;
      payload.appName = payload.appName || app.app_name;
    }
  }

  const ctx = {
    category: payload.category,
    activity: payload.activity,
    appId: payload.appId,
    appName: payload.appName,
    pageUrl: payload.pageUrl,
    pageHost: payload.pageHost
  };

  const items = [];
  if (payload.text && payload.text.trim()) {
    items.push({
      fileName: `${payload.appName || "web"} ${payload.activity || "activity"}`,
      textContent: payload.text
    });
  }
  for (const file of payload.attachments || []) {
    if (file.status === "pending") continue;
    items.push({
      fileName: file.name || "attachment",
      fileSize: file.size || 0,
      fileContent: file.text || "",
      // Raw bytes, when we have them. An intercepted upload is caught before any
      // local inspection could run, so there is no extracted text to send — the
      // server does its own extraction, hashing and document-type detection from
      // these bytes instead.
      fileB64: file.b64 || null,
      // Policy decides whether content nobody could open counts as sensitive.
      uninspectable: file.status === "unreadable" && cachedPolicy.block_uninspectable !== false
    });
  }
  // A submit with neither body text nor attachments is still an activity worth a
  // verdict — "post nothing to ChatGPT" is not interesting, but "upload" with an
  // unreadable attachment is, and it arrives here looking identical.
  if (items.length === 0) {
    items.push({ fileName: `${payload.appName || "web"} ${payload.activity || "activity"}`, textContent: "" });
  }

  let verdict = null;
  let anyServerAnswer = false;
  let worst = { action: "allow", level: null, reason: "", severity: null };

  if (cfg.serverUrl) {
    await ensureRegistered();
    const fresh = await getConfig();
    for (const item of items) {
      const one = await evaluateOne(fresh, item, ctx);
      if (!one) continue;
      anyServerAnswer = true;
      if (self.CSDLPPolicy.ACTION_RANK[one.action] > self.CSDLPPolicy.ACTION_RANK[worst.action]) {
        worst = one;
      } else if (!worst.level && one.level) {
        worst.level = one.level;
      }
      // No point asking about the rest once something has already been blocked.
      if (worst.action === "block") break;
    }
    if (anyServerAnswer) {
      verdict = {
        action: worst.action, level: worst.level, reason: worst.reason, source: "server",
        maskedText: worst.maskedText || null, maskSummary: worst.maskSummary || []
      };

      /*
        A mask has to be refused here in three cases the server cannot see.

        Attachments: the verdict is the worst across every item, and only the
        prose item can carry a redaction. Masking the message while its
        attachment goes out whole would be worse than doing nothing.

        Truncation: text longer than MAX_TEXT_CHARS is clipped before it is
        sent for inspection, so the redacted text that comes back is also
        clipped. Writing that into the composer would silently delete
        everything past the limit — a mask must never lose the user's work.

        No text at all: nothing to rewrite.
      */
      if (verdict.action === "mask") {
        const refuse =
          items.length > 1 ? "the submission carries an attachment" :
          (payload.text || "").length > MAX_TEXT_CHARS ? "the message is too long to redact without truncating it" :
          !verdict.maskedText ? "the server returned no redacted text" : "";
        if (refuse) {
          warn(`mask refused for ${payload.appName}: ${refuse} — blocking instead`);
          verdict.action = "block";
          verdict.reason = `${verdict.reason || "Redaction required"} — blocked because ${refuse}`;
          verdict.maskedText = null;
        }
      }
    }
  }

  if (!verdict) {
    // Server-authoritative means there is no verdict when the server cannot be
    // reached — so fall back to the cached matrix applied to whatever the
    // bundled scanner found. This is the ONLY place local detection decides
    // anything, and it says so in the reason.
    const uninspectable = (payload.uninspected || []).length > 0;
    const fb = self.CSDLPPolicy.resolveFallback(
      cachedPolicy, payload.category, payload.activity, payload.appId,
      payload.localLevel, uninspectable
    );
    verdict = {
      action: fb.action,
      level: payload.localLevel || null,
      reason: fb.reason,
      source: "cached-policy"
    };

    // A redaction is computed by the server from the rules that matched. With
    // no server there is nothing to compute it from, and a cell set to Redact
    // must not degrade into "send it anyway" — the stricter neighbour is the
    // only safe reading.
    if (verdict.action === "mask") {
      verdict.action = "block";
      verdict.reason = `${fb.reason} — blocked because redaction needs the server and it could not be reached`;
    }

    warn(`falling back to the cached policy for ${payload.appName}: ${verdict.action} — ${verdict.reason}`);
  }

  // Report it. Awaited only far enough to start; the guard is holding a user's
  // keystroke and must not wait on event ingestion to resume it.
  reportActivity(payload, verdict).catch(() => {});

  return verdict;
}

/* ── Events ────────────────────────────────────────────────────────────── */

function severityFor(level, action) {
  if (action === "block") return "critical";
  const map = { Restricted: "critical", Confidential: "high", Internal: "medium", Public: "low" };
  return map[level] || (action === "alert" ? "medium" : "low");
}

function describe(payload, verdict) {
  const app = payload.appName || payload.pageHost || "a web app";
  const verb = {
    upload: "Upload to", download: "Download from", attach: "Attachment added in",
    send: "Message sent via", post: "Content submitted to", ai_response: "Response received from"
  }[payload.activity] || "Activity in";

  if (payload.scanTimedOut) {
    return `${verb} ${app} held — attachment inspection did not finish in time`;
  }
  const outcome =
    verdict.action === "block" ? "BLOCKED" :
    verdict.action === "mask" ? "sent with sensitive values replaced" :
    verdict.action === "alert" ? "flagged" : "allowed";
  const what = payload.attachmentNames && payload.attachmentNames.length
    ? ` (${payload.attachmentNames.join(", ")})` : "";
  const to = payload.recipients ? ` — recipients: ${payload.recipients}` : "";
  return `${verb} ${app}${what} — ${outcome}${to}`;
}

async function postEventWithRetry(eventBody) {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= EVENT_SEND_ATTEMPTS; attempt++) {
    const cfg = await getConfig();
    if (!cfg.serverUrl) return { ok: false, error: "No server URL configured." };

    const res = await apiFetch(cfg.serverUrl, "/events/", {
      method: "POST",
      body: { ...eventBody, agent_id: cfg.reportingAgentId },
      agentKey: cfg.agentKey
    });
    if (res.ok) return { ok: true };

    lastError = res.error;

    if (res.status === 401) {
      await chrome.storage.local.remove("agentKey");
      registeredThisSession = false;
      await registerAgent();
      continue;
    }
    // 4xx other than 401 is a payload problem — retrying won't help.
    if (res.status >= 400 && res.status < 500) break;

    if (attempt < EVENT_SEND_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  return { ok: false, error: lastError };
}

/**
 * File one event for an activity.
 *
 * The typed text is included in full. That is a deliberate decision, not an
 * oversight: an analyst told "an Aadhaar number went to ChatGPT" and nothing
 * else cannot judge whether it was a customer record or a test string, and the
 * prompt IS the evidence. It travels the same authenticated channel and inherits
 * the same retention and redaction handling as every other captured content
 * field in the platform.
 */
async function reportActivity(payload, verdict) {
  const cfg = await getConfig();
  if (!cfg.serverUrl) {
    warn("no server URL — dropping activity event");
    return { ok: false };
  }
  await ensureRegistered();

  const level = verdict.level || payload.localLevel || null;
  const blocked = verdict.action === "block" || !!payload.scanTimedOut;
  const action = blocked ? "blocked"
    : verdict.action === "mask" ? "masked"
    : verdict.action === "alert" ? "alert" : "logged";
  const text = clip(payload.text || "");

  const eventBody = {
    event_id: crypto.randomUUID(),
    event_type: eventTypeFor(payload.category),
    event_subtype: `${payload.category || "web"}_${payload.activity || "activity"}`,
    agent_id: cfg.reportingAgentId,
    source_type: "browser_extension",
    severity: severityFor(level, verdict.action),
    classification_level: level,
    classification_labels: payload.localReasons || [],
    detected_content: (payload.localReasons || []).join(", "),
    action,
    blocked,
    description: payload.description || describe(payload, verdict),
    timestamp: new Date().toISOString(),
    // Web activity dimensions — the two facts that make this reportable per
    // activity rather than as an undifferentiated "cloud upload".
    activity: payload.activity,
    app_category: payload.category,
    app_id: payload.appId,
    app_name: payload.appName,
    page_url: payload.pageUrl,
    page_host: payload.pageHost,
    text_content: text,
    text_truncated: (payload.text || "").length > MAX_TEXT_CHARS,
    attachment_names: payload.attachmentNames || [],
    recipients: payload.recipients || null,
    destination: payload.pageHost,
    destination_type: "web",
    file_path: (payload.attachmentNames || [])[0] || null
  };

  const res = await postEventWithRetry(eventBody);
  if (res.ok) {
    await setStatus(true, `Last event sent to ${cfg.serverUrl}.`);
  } else {
    console.error("[CyberSentinel] Failed to report activity:", res.error);
    await setStatus(false, `Event send failed: ${res.error}`);
  }
  return res;
}

/* ── Downloads ─────────────────────────────────────────────────────────── */

/**
 * The Download verb.
 *
 * Every other activity here is outbound and can be caught in the page. Download
 * cannot: by the time the bytes are moving, the page is no longer involved and
 * the browser owns the transfer. chrome.downloads is the only vantage point that
 * sees it at all, which is why this is the one activity handled entirely in the
 * worker.
 *
 * Cancelling is genuinely possible here, unlike an AI response — the file has not
 * been written yet — so a matrix cell of "block" on download is enforceable.
 */
function installDownloadHook() {
  if (!chrome.downloads || !chrome.downloads.onCreated) {
    warn("chrome.downloads unavailable — the Download activity cannot be seen.");
    return;
  }

  chrome.downloads.onCreated.addListener(async (item) => {
    try {
      // referrer names the page that initiated it; url is where the bytes come
      // from. A Drive download serves from googleusercontent.com while the
      // referrer is drive.google.com — the referrer is the app the user is in,
      // so it is tried first.
      const app =
        self.CSDLPCatalog.resolveUrl(item.referrer || "") ||
        self.CSDLPCatalog.resolveUrl(item.url || "");
      if (!app) return;

      const action = self.CSDLPPolicy.actionFor(cachedPolicy, app.category, "download", app.app_id);
      if (action === "allow") return;

      const fileName = item.filename || (item.url || "").split("/").pop() || "download";
      const payload = {
        appId: app.app_id, appName: app.app_name, category: app.category,
        activity: "download",
        pageUrl: item.referrer || item.url,
        pageHost: (() => { try { return new URL(item.referrer || item.url).hostname; } catch (e) { return ""; } })(),
        attachmentNames: [fileName],
        text: "",
        localReasons: [],
        localLevel: null
      };

      if (action === "block") {
        try {
          await chrome.downloads.cancel(item.id);
          log("download cancelled by policy:", fileName, "from", app.app_name);
        } catch (e) {
          warn("could not cancel the download:", e && e.message);
        }
        await reportActivity(payload, {
          action: "block",
          level: null,
          reason: `Download from ${app.app_name} is blocked by policy`,
          source: "cached-policy"
        });
        return;
      }

      // A downloaded file's CONTENT is not available to the extension — the
      // bytes go to disk, not through us — so there is nothing to classify and
      // the event is an observation. The endpoint agent picks the file up from
      // the filesystem afterwards and classifies it there; this event is what
      // ties that file back to the app it came from.
      await reportActivity(payload, {
        action: action === "block" ? "alert" : action,
        level: null,
        reason: `Download from ${app.app_name} recorded by policy`,
        source: "cached-policy"
      });
    } catch (e) {
      warn("download hook failed:", e && e.message);
    }
  });
}

/* ── Offscreen OCR host ────────────────────────────────────────────────── */
/*
 * Tesseract cannot run in a content script: it starts its worker from a blob:
 * URL, which inherits the *page's* origin, making the worker's importScripts()
 * of a chrome-extension:// URL a blocked cross-origin request. It also cannot
 * run here — a service worker has no DOM, and Tesseract needs one to decode
 * images. An offscreen document is the one context that has both a DOM and the
 * extension's own origin.
 *
 * This worker owns that document's lifecycle and relays jobs to it.
 */
const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_TARGET = "cybersentinel-offscreen";
let offscreenCreating = null;

async function hasOffscreenDocument() {
  // getContexts is Chrome 116+; older builds fall through to the
  // create-and-catch path below, which is correct either way.
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("This Chrome build has no chrome.offscreen API (needs Chrome 109+), so image OCR cannot run.");
  }
  if (await hasOffscreenDocument()) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS"],
        justification: "Runs the bundled OCR engine in the extension's own origin to scan attachments."
      })
      .catch((err) => {
        // Two images attached at once can race here; losing that race is
        // success, not failure.
        if (/single offscreen/i.test((err && err.message) || "")) return;
        throw err;
      })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

/**
 * Close the inspection host when nothing has used it for a while.
 *
 * The offscreen document is a whole renderer process. Keeping one alive for the
 * rest of a browser session because someone attached a photo at 9am is exactly
 * the kind of cost that gets a security agent uninstalled. It is recreated
 * transparently on the next attachment — ensureOffscreenDocument already does
 * that — so the only price is a second on a cold inspection.
 *
 * Closing is also skipped while a job is in flight: lastOcrAt is stamped on
 * every request, so an inspection that outruns the window keeps the host alive.
 */
const OFFSCREEN_IDLE_MS = 5 * 60 * 1000;
let lastOcrAt = 0;
let ocrInFlight = 0;

async function closeIdleOffscreen() {
  if (ocrInFlight > 0) return;
  if (!lastOcrAt || Date.now() - lastOcrAt < OFFSCREEN_IDLE_MS) return;
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
    lastOcrAt = 0;
    log("inspection host closed after idle");
  } catch (e) {
    // Racing a document that is already gone is success, not failure.
  }
}

async function runOcrRequest(dataUrl, name, mimeType) {
  if (!dataUrl) return { ok: false, error: "no attachment data received" };
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    const error = `Could not start the attachment-inspection host: ${err && err.message ? err.message : String(err)}`;
    console.error("[CyberSentinel]", error);
    return { ok: false, error };
  }

  ocrInFlight++;
  lastOcrAt = Date.now();
  try {
    const result = await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET, type: "OCR_RUN", dataUrl, mimeType, name
    });
    if (!result) return { ok: false, error: "the attachment-inspection host returned no result" };
    if (result.ok) {
      log(
        `inspected "${name || "attachment"}" via ${result.method}: ` +
        (result.documentType ? `${result.documentType} (${result.confidence})` : "nothing sensitive") +
        ` — ${result.textLength} chars in ${((result.elapsedMs || 0) / 1000).toFixed(1)}s`
      );
    } else {
      console.error(`[CyberSentinel] Inspection of "${name || "attachment"}" failed:`, result.error);
    }
    return result;
  } catch (err) {
    const error = `Attachment-inspection host unreachable: ${err && err.message ? err.message : String(err)}`;
    console.error("[CyberSentinel]", error);
    return { ok: false, error };
  } finally {
    ocrInFlight--;
    lastOcrAt = Date.now();
  }
}

/* ── Connectivity test (Options page) ──────────────────────────────────── */

async function testConnection() {
  const cfg = await getConfig();

  if (!cfg.rawServerUrl) return { ok: false, message: "No server URL set. Enter it above and press Save." };
  if (!cfg.serverUrl) {
    return { ok: false, message: `"${cfg.rawServerUrl}" isn't a valid URL — use e.g. http://192.168.2.204:3023/api/v1` };
  }
  if (!(await hasHostPermission(cfg.serverUrl))) {
    return {
      ok: false,
      message:
        `No host permission for ${originPatternFor(cfg.serverUrl)}. Reload the extension on ` +
        "chrome://extensions (the manifest grants this), then try again."
    };
  }

  const reg = await registerAgent();
  if (!reg.ok) return { ok: false, message: reg.error };

  const beat = await sendHeartbeat();
  if (!beat.ok) return { ok: false, message: beat.error };

  await syncAll();

  const label = reg.agentCode ? `${reg.agentId} (${String(reg.agentCode).padStart(3, "0")})` : reg.agentId;
  const policyNote = cachedPolicy.enforced
    ? `Web activity policy: ${cachedPolicy.mode} (${(cachedPolicy.policy_names || []).join(", ") || "unnamed"}).`
    : "No web activity policy is active — nothing is being blocked in the browser.";
  return {
    ok: true,
    message: `Connected to ${cfg.serverUrl} — registered as ${label}. ` +
             `${self.CSDLPCatalog.all().length} destinations catalogued. ${policyNote}`
  };
}

/* ── Lifecycle ─────────────────────────────────────────────────────────── */

async function ensureAlarms() {
  const cfg = await getConfig();
  if (cfg.attached) {
    // Nothing to beat — drop any alarm left over from before policy attached us.
    await chrome.alarms.clear(HEARTBEAT_ALARM);
  } else if (!(await chrome.alarms.get(HEARTBEAT_ALARM))) {
    await chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 0.1, periodInMinutes: HEARTBEAT_PERIOD_MINUTES
    });
  }
  if (!(await chrome.alarms.get(SYNC_ALARM))) {
    await chrome.alarms.create(SYNC_ALARM, {
      delayInMinutes: 0.2, periodInMinutes: SYNC_PERIOD_MINUTES
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) sendHeartbeat();
  if (alarm.name === SYNC_ALARM) { syncAll(); closeIdleOffscreen(); }
});

/** Write the defaults into storage if the user has never set any. */
async function seedDefaults() {
  const managed = await getManagedConfig();
  if (managed.agentId) {
    // Fully configured by policy — nothing to seed, and nothing the user needs
    // to type. This is the deployed path.
    log(`managed by policy: reporting as endpoint agent "${managed.agentId}"`);
    return;
  }
  const stored = await chrome.storage.local.get(["serverUrl", "agentId"]);
  const updates = {};
  if (!(stored.serverUrl || "").trim()) {
    // A native host, where one exists, already knows which manager this machine
    // reports to — better than a compiled-in default that is right for exactly
    // one network.
    const hint = await resolveNativeHint();
    updates.serverUrl = (hint && hint.serverUrl) || DEFAULT_SERVER_URL;
    if (hint && hint.agentId && !(stored.agentId || "").trim()) {
      updates.agentId = hint.agentId;
    }
  }
  // A blank identifier registers as "browser-extension-unconfigured", which is
  // indistinguishable between machines on the dashboard.
  if (!(stored.agentId || "").trim() && !updates.agentId) {
    updates.agentId = `browser-${detectOs()}-${crypto.randomUUID().slice(0, 8)}`;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
}

async function boot() {
  await loadCaches();
  await ensureAlarms();
  await registerGuardScripts();   // from cache/bundle, immediately — no network wait
  syncAll().catch(() => {});      // refresh in the background
}

chrome.runtime.onInstalled.addListener(() => {
  seedDefaults().then(() => { boot(); registerAgent(); });
});
chrome.runtime.onStartup.addListener(() => {
  seedDefaults().then(() => { boot(); registerAgent(); });
});
// Also on a bare worker wake, which MV3 does constantly and which fires neither
// of the events above.
boot().catch((e) => console.error("[CyberSentinel] boot failed:", e));
installDownloadHook();

/* ── Message router ────────────────────────────────────────────────────── */

/**
 * Returning true keeps the message channel — and with it this service worker —
 * alive until the async handler responds. Without it Chrome can tear the worker
 * down mid-fetch and the decision is silently lost.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;
  // Messages this worker sends *to* the offscreen document come back around on
  // the same bus; they are not ours to answer.
  if (message.target === OFFSCREEN_TARGET) return false;

  switch (message.type) {
    case "CSDLP_RESOLVE":
      loadCaches()
        .then(() => {
          const app = self.CSDLPCatalog.resolve(message.host, message.path, message.port);
          // Every host that belongs to the SAME app, so the upload interceptor
          // watches the destinations this app actually uploads to. Google Drive
          // is the reason this exists: the page is drive.google.com but the
          // bytes go to googleapis.com, and watching only the page's own host
          // would miss every upload it makes.
          let catalogHosts = [];
          if (app) {
            catalogHosts = self.CSDLPCatalog.all()
              .filter((e) => e.app_id === app.app_id || e.category === app.category)
              .map((e) => e.host);
          }
          sendResponse({ app, policy: cachedPolicy, catalogHosts });
        })
        .catch(() => sendResponse({ app: null, policy: cachedPolicy, catalogHosts: [] }));
      return true;

    case "CSDLP_EVALUATE":
      evaluateActivity(message.payload)
        .then(sendResponse)
        .catch((err) => {
          console.error("[CyberSentinel] evaluate failed:", err);
          // Never leave the guard waiting: a thrown worker error must resolve to
          // something, and the cached policy is the honest answer.
          sendResponse({ action: "allow", reason: "decision failed: " + (err && err.message), source: "error" });
        });
      return true;

    case "CSDLP_ACTIVITY_EVENT":
      reportActivity(message.payload, { action: message.payload.blocked ? "block" : "log", level: null, reason: "" })
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;

    case "CYBERSENTINEL_OCR_REQUEST":
      runOcrRequest(message.dataUrl, message.name, message.mimeType).then(sendResponse);
      return true;

    case "CYBERSENTINEL_SETTINGS_SAVED":
      registeredThisSession = false;   // force a fresh registration with the new settings
      ensureAlarms()
        .then(registerAgent)
        .then(async (reg) => { await syncAll(); return reg; })
        .then(sendResponse);
      return true;

    case "CYBERSENTINEL_TEST_CONNECTION":
      testConnection().then(sendResponse);
      return true;

    case "CYBERSENTINEL_STATE":
      loadCaches()
        .then(getConfig)
        .then((cfg) => sendResponse({
          catalogCount: self.CSDLPCatalog.all().length,
          policy: cachedPolicy,
          attached: cfg.attached,
          reportingAgentId: cfg.reportingAgentId,
          serverUrl: cfg.serverUrl,
          managedKeys: Object.keys(cfg.managed || {})
        }));
      return true;

    default:
      return false;
  }
});
