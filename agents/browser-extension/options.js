/**
 * CyberSentinel DLP — Options / popup logic.
 *
 * ── WHY THE SAVE ORDER MATTERS ───────────────────────────────────────
 * This page is both the options_page AND the toolbar popup. An earlier
 * version awaited chrome.permissions.request() *before* writing anything
 * to storage. Chrome closes a popup the moment a permission prompt opens,
 * which tears down this script — so the await never resolved and the
 * chrome.storage.local.set() after it never ran. Pressing Save in the
 * popup could therefore look like it worked while silently persisting
 * nothing, leaving the service worker with an empty serverUrl and every
 * event dropped before it ever reached the network.
 *
 * Settings are written first and unconditionally, so a save can never be
 * lost. The server origin is already covered by the manifest's
 * host_permissions, so no runtime prompt normally happens at all.
 */

const DEFAULT_API_PATH = "/api/v1";
/** Mirrors DEFAULT_SERVER_URL in background.js — keep the two in step. */
const DEFAULT_SERVER_URL = "http://192.168.2.204:3023/api/v1";

/** Mirrors normalizeServerUrl() in background.js — keep the two in step. */
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
  const versioned = path.match(/^(.*\/api\/v\d+)(?:\/.*)?$/);
  path = versioned ? versioned[1] : path + DEFAULT_API_PATH;

  return url.origin + path;
}

const statusEl = () => document.getElementById("status");
const resolvedEl = () => document.getElementById("resolved");

function setStatusText(text, kind) {
  const el = statusEl();
  el.textContent = text;
  el.style.color = kind === "error" ? "#c62828" : kind === "ok" ? "#2e7d32" : "#555";
}

function showResolvedUrl() {
  const normalized = normalizeServerUrl(document.getElementById("serverUrl").value);
  resolvedEl().textContent = normalized ? `Will call: ${normalized}/events/` : "";
}

const CATEGORY_LABELS = {
  webmail: "Webmail",
  cloud_storage: "Cloud storage",
  collaboration: "Collaboration",
  genai: "Generative AI"
};
const ACTIVITY_LABELS = {
  upload: "Upload", download: "Download", attach: "Attach",
  send: "Send", post: "Post", ai_response: "AI response"
};

/**
 * When an administrator has pushed policy, the fields on this page are not the
 * source of truth and must not look like they are. Someone editing a server URL
 * that policy silently overrides, then watching events go nowhere, is a support
 * call that should never have been possible.
 */
function applyManagedState(state) {
  if (!state || !state.attached) return;
  for (const id of ["serverUrl", "agentId"]) {
    const el = document.getElementById(id);
    el.disabled = true;
    el.title = "Set by administrator policy - change it on the DLP server instead.";
    el.style.background = "#f1f3f4";
    el.style.color = "#5f6368";
  }
  if (state.serverUrl) document.getElementById("serverUrl").value = state.serverUrl;
  if (state.reportingAgentId) document.getElementById("agentId").value = state.reportingAgentId;
  const save = document.getElementById("save");
  save.disabled = true;
  save.style.background = "#9aa0a6";
  save.title = "Configuration is managed by policy.";
}

/**
 * What this browser is actually enforcing right now.
 *
 * Worth its own panel because "enrolled and healthy" and "enforcing nothing"
 * look identical otherwise, and with a policy-driven design the second is the
 * default. Someone who installs the extension, sees a green status line, pastes
 * a card number into ChatGPT and watches it go through needs to be able to find
 * out in one click that no policy covers that — rather than concluding the
 * product is broken.
 */
function renderCoverage(state) {
  const box = document.getElementById("coverage");
  const policy = (state && state.policy) || {};
  const count = (state && state.catalogCount) || 0;

  // Identity first. "Which agent am I?" is the question someone opens this page
  // to answer when a device turns up twice on the dashboard.
  const identity = state && state.attached
    ? '<span class="pill on">managed</span> reporting as endpoint agent <b>' +
      state.reportingAgentId + '</b> - one agent for this device'
    : state && state.reportingAgentId
      ? '<span class="pill">standalone</span> enrolled as <b>' + state.reportingAgentId + '</b>'
      : '';
  const idLine = identity ? '<b>Identity</b> ' + identity + '<br><br>' : '';

  if (!policy.enforced) {
    box.innerHTML = idLine +
      '<b>Coverage</b> <span class="pill off">no policy</span><br>' +
      `${count} destinations catalogued. Nothing is being blocked or alerted in this browser — ` +
      "create a Web Activity Control policy in the dashboard to enforce anything.";
    return;
  }

  const modePill = policy.mode === "audit"
    ? '<span class="pill audit">audit</span>'
    : '<span class="pill on">enforcing</span>';

  const rows = [];
  Object.keys(policy.matrix || {}).forEach((category) => {
    const cells = policy.matrix[category] || {};
    const parts = Object.keys(cells)
      .map((activity) => {
        const cell = cells[activity];
        const action = typeof cell === "object" ? cell.action : cell;
        if (action === "allow") return null;
        return `${ACTIVITY_LABELS[activity] || activity}: <b>${action}</b>`;
      })
      .filter(Boolean);
    if (parts.length) {
      rows.push(`${CATEGORY_LABELS[category] || category} — ${parts.join(", ")}`);
    }
  });

  box.innerHTML = idLine +
    `<b>Coverage</b> ${modePill}<br>` +
    (rows.length ? rows.join("<br>") : "Policy is active but defines no rules.") +
    `<br><span style="color:#666">${count} destinations catalogued` +
    (policy.min_level ? ` · acts on ${policy.min_level} and above` : "") +
    (policy.policy_names && policy.policy_names.length
      ? ` · ${policy.policy_names.join(", ")}` : "") +
    "</span>";
}

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get([
    "serverUrl", "agentId", "mode", "blockUninspectable", "diagnosticMode", "lastStatus"
  ]);
  document.getElementById("serverUrl").value = stored.serverUrl || DEFAULT_SERVER_URL;
  document.getElementById("agentId").value = stored.agentId || "";
  document.getElementById("mode").value = stored.mode || "protection";
  document.getElementById("blockUninspectable").checked = stored.blockUninspectable !== false;
  document.getElementById("diagnosticMode").checked = !!stored.diagnosticMode;
  // Shown so "did my reload take?" is answerable without leaving this page.
  document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;
  showResolvedUrl();

  if (stored.lastStatus && stored.lastStatus.message) {
    const when = new Date(stored.lastStatus.at).toLocaleTimeString();
    setStatusText(`${stored.lastStatus.message} (${when})`, stored.lastStatus.ok ? "ok" : "error");
  }

  const state = await ask({ type: "CYBERSENTINEL_STATE" });
  applyManagedState(state);
  renderCoverage(state);
});

document.getElementById("serverUrl").addEventListener("input", showResolvedUrl);

document.getElementById("save").addEventListener("click", async () => {
  const serverUrlRaw = document.getElementById("serverUrl").value.trim();
  const agentId = document.getElementById("agentId").value.trim();
  const mode = document.getElementById("mode").value;
  const blockUninspectable = document.getElementById("blockUninspectable").checked;
  const diagnosticMode = document.getElementById("diagnosticMode").checked;

  setStatusText("Saving…", "info");

  const normalized = normalizeServerUrl(serverUrlRaw);
  if (serverUrlRaw && !normalized) {
    setStatusText("That doesn't look like a valid URL — try http://192.168.2.204:3023/api/v1", "error");
    return;
  }

  // Persist FIRST — nothing below may cost the user their settings.
  const previous = await chrome.storage.local.get(["serverUrl", "agentId"]);
  await chrome.storage.local.set({ serverUrl: normalized, agentId, mode, blockUninspectable, diagnosticMode });

  // Pointing at a different server, or renaming this browser, invalidates the
  // identity/key the old server handed us — drop them so the worker
  // re-registers cleanly instead of reporting under a stale agent row. The
  // caches go too: a different manager has a different catalog and a different
  // policy, and keeping the old ones would enforce one server's rules against
  // another's estate.
  if (previous.serverUrl !== normalized || previous.agentId !== agentId) {
    await chrome.storage.local.remove([
      "canonicalAgentId", "agentKey", "appCatalog", "catalogEtag", "webActivityPolicy"
    ]);
  }

  // Normally a no-op: manifest.json already declares host access. Only matters
  // if those host_permissions are narrowed later.
  if (normalized) {
    const pattern = new URL(normalized).origin + "/*";
    try {
      const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });
      if (!alreadyGranted) {
        const granted = await chrome.permissions.request({ origins: [pattern] });
        if (!granted) {
          setStatusText(`Saved, but access to ${pattern} was denied — events can't send until it's granted.`, "error");
          return;
        }
      }
    } catch (e) {
      setStatusText(`Saved, but requesting access to ${pattern} failed: ${e.message}`, "error");
      return;
    }
  }

  setStatusText("Saved. Registering with server…", "info");

  const result = await ask({ type: "CYBERSENTINEL_SETTINGS_SAVED" });
  if (result && result.ok) {
    setStatusText(`Saved and connected — registered as ${result.agentId}.`, "ok");
  } else {
    setStatusText(`Saved, but the server didn't accept it: ${(result && result.error) || "no response"}`, "error");
  }
  renderCoverage(await ask({ type: "CYBERSENTINEL_STATE" }));
});

document.getElementById("test").addEventListener("click", async () => {
  setStatusText("Testing connection…", "info");
  const result = await ask({ type: "CYBERSENTINEL_TEST_CONNECTION" });
  if (result && result.ok) {
    setStatusText(result.message, "ok");
  } else {
    setStatusText((result && result.message) || "No response from the extension's service worker.", "error");
  }
  renderCoverage(await ask({ type: "CYBERSENTINEL_STATE" }));
});

/**
 * sendMessage rejects outright when the service worker can't be reached (e.g.
 * it crashed on load). Surface that as a readable status instead of an uncaught
 * rejection that leaves the user staring at "Testing…".
 */
async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return {
      ok: false,
      error: `service worker unreachable (${e.message}) — check its console via chrome://extensions → Service worker.`,
      message: `Service worker unreachable (${e.message}). Open chrome://extensions → this extension → "Service worker" to see why.`
    };
  }
}
