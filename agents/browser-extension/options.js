/**
 * CyberSentinel DLP — popup / options page.
 *
 * ── WHY THIS IS ALMOST ENTIRELY READ-ONLY ────────────────────────────────
 *
 * It used to offer a server URL, an agent id, an enforcement mode, a
 * "block uninspectable attachments" checkbox and a diagnostic toggle. Every one
 * of those is decided somewhere else — the first two by the endpoint agent's
 * config, the rest by the Web Activity Control policy on the server. Offering
 * them here did not give anyone control; it gave them a way to disagree with the
 * server and then wonder why nothing happened. One was actively misleading: the
 * resolved-URL line went on showing a stale default after policy had already
 * overridden the field next to it.
 *
 * So the page answers the two questions someone actually opens it for:
 *   "which agent am I?"  and  "what is being enforced right now?"
 *
 * The editable form survives for exactly one case — an extension installed with
 * no endpoint agent to configure it, which would otherwise have no way to learn
 * where to report.
 */

const DEFAULT_API_PATH = "/api/v1";

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

const CATEGORY_LABELS = {
  webmail: "Webmail",
  cloud_storage: "Cloud storage",
  collaboration: "Collaboration",
  genai: "Generative AI"
};
const ACTIVITIES = ["upload", "download", "attach", "send", "post", "ai_response"];
const ACTIVITY_SHORT = {
  upload: "Up", download: "Down", attach: "Attach",
  send: "Send", post: "Post", ai_response: "AI reply"
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatusText(text, kind) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = kind === "error" ? "#c62828" : kind === "ok" ? "#2e7d32" : "#555";
}

/** Which agent this browser reports as, and where. */
function renderIdentity(state) {
  const box = document.getElementById("identity");
  if (!state) {
    box.textContent = "Could not reach the extension's service worker.";
    return;
  }
  const rows = [];
  if (state.attached) {
    rows.push('<b>Identity</b> <span class="pill on">managed</span>');
    rows.push('<span class="k">Agent</span><span class="v">' + esc(state.reportingAgentId) + "</span>");
    rows.push('<span class="k">Server</span><span class="v">' + esc(state.serverUrl || "not set") + "</span>");
    rows.push(
      '<span style="color:#5f6368">Shared with the endpoint agent, so this device ' +
      "counts as one agent. Both values come from the agent's own configuration — " +
      "change them there and restart the agent.</span>"
    );
  } else {
    rows.push('<b>Identity</b> <span class="pill">standalone</span>');
    rows.push('<span class="k">Agent</span><span class="v">' +
              esc(state.reportingAgentId || "not enrolled") + "</span>");
    rows.push('<span class="k">Server</span><span class="v">' + esc(state.serverUrl || "not set") + "</span>");
  }
  box.innerHTML = rows.join("<br>");
}

/**
 * What is actually being enforced.
 *
 * Rendered as the same grid the operator filled in on the dashboard, because
 * "enrolled and healthy" and "enforcing nothing" look identical otherwise — and
 * with a policy-driven design, enforcing nothing is the default.
 */
function renderCoverage(state) {
  const box = document.getElementById("coverage");
  const policy = (state && state.policy) || {};
  const count = (state && state.catalogCount) || 0;

  if (!policy.enforced) {
    box.innerHTML =
      '<b>Coverage</b> <span class="pill off">no policy</span><br>' +
      count + " destinations recognised, nothing enforced. Create a " +
      "<b>Web Activity Control</b> policy on the dashboard to enforce anything.";
    return;
  }

  const modePill = policy.mode === "audit"
    ? '<span class="pill audit">audit &mdash; records, never blocks</span>'
    : '<span class="pill on">enforcing</span>';

  const cats = Object.keys(policy.matrix || {});
  let table = "";
  if (cats.length) {
    const used = ACTIVITIES.filter((a) =>
      cats.some((c) => (policy.matrix[c] || {})[a] !== undefined));
    table =
      '<table class="matrix"><tr><th></th>' +
      used.map((a) => "<th>" + ACTIVITY_SHORT[a] + "</th>").join("") +
      "</tr>" +
      cats.map((c) => {
        const row = policy.matrix[c] || {};
        return '<tr><td class="cat">' + esc(CATEGORY_LABELS[c] || c) + "</td>" +
          used.map((a) => {
            const cell = row[a];
            if (cell === undefined) return '<td class="a-allow">&middot;</td>';
            const action = typeof cell === "object" ? cell.action : cell;
            return '<td class="a-' + esc(action) + '">' + esc(action) + "</td>";
          }).join("") + "</tr>";
      }).join("") +
      "</table>";
  }

  const names = (policy.policy_names || []).filter(Boolean);
  box.innerHTML =
    "<b>Coverage</b> " + modePill + table +
    '<div style="margin-top:6px;color:#5f6368">' +
    (policy.min_level
      ? "Acts on <b>" + esc(policy.min_level) + "</b> content and above. "
      : "Acts on any content. ") +
    (policy.block_uninspectable !== false
      ? "A file that could not be opened at all (encrypted archive, corrupt document) counts as sensitive. "
      : "A file that could not be opened is let through. ") +
    count + " destinations recognised." +
    (names.length ? "<br>From: " + esc(names.join(", ")) : "") +
    "</div>";
}

async function refresh() {
  const state = await ask({ type: "CYBERSENTINEL_STATE" });
  renderIdentity(state);
  renderCoverage(state);

  // The editable form appears only when no policy is configuring us.
  if (state && !state.attached) {
    document.getElementById("manual").style.display = "block";
    const stored = await chrome.storage.local.get(["serverUrl", "agentId"]);
    document.getElementById("serverUrl").value = stored.serverUrl || "";
    document.getElementById("agentId").value = stored.agentId || "";
  }
  return state;
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

  const stored = await chrome.storage.local.get(["lastStatus"]);
  if (stored.lastStatus && stored.lastStatus.message) {
    const when = new Date(stored.lastStatus.at).toLocaleTimeString();
    setStatusText(`${stored.lastStatus.message} (${when})`, stored.lastStatus.ok ? "ok" : "error");
  }
  await refresh();

  /*
    Keep it live.

    The coverage grid is the answer to "is my policy actually in force here",
    and it used to be a snapshot taken when the popup opened — of a cache that
    can be up to five minutes old. So an operator who changed a policy on the
    dashboard and immediately opened this saw the previous one, with nothing to
    say it was stale.

    Two halves. Ask the worker to sync the moment the popup opens, and re-render
    whenever the cached policy or catalog changes — which covers that sync, the
    five-minute alarm, and a managed-config push, without this having to know
    which of them happened.
  */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.webActivityPolicy || changes.appCatalog) refresh();
  });

  ask({ type: "CSDLP_SYNC_NOW" }).catch(() => {});
});

document.getElementById("save").addEventListener("click", async () => {
  const serverUrlRaw = document.getElementById("serverUrl").value.trim();
  const agentId = document.getElementById("agentId").value.trim();

  const normalized = normalizeServerUrl(serverUrlRaw);
  if (serverUrlRaw && !normalized) {
    setStatusText("That doesn't look like a valid URL — try http://192.168.2.204:55100/api/v1", "error");
    return;
  }
  setStatusText("Saving…", "info");

  // Persist FIRST and unconditionally: Chrome tears this popup down the moment
  // anything opens a prompt, and an earlier version lost the settings that way.
  const previous = await chrome.storage.local.get(["serverUrl", "agentId"]);
  await chrome.storage.local.set({ serverUrl: normalized, agentId });

  // A different manager has a different catalog, a different policy and a
  // different idea of who this agent is. Keeping the old caches would enforce
  // one server's rules against another's estate.
  if (previous.serverUrl !== normalized || previous.agentId !== agentId) {
    await chrome.storage.local.remove([
      "canonicalAgentId", "agentKey", "appCatalog", "catalogEtag", "webActivityPolicy"
    ]);
  }

  const result = await ask({ type: "CYBERSENTINEL_SETTINGS_SAVED" });
  setStatusText(
    result && result.ok
      ? `Connected — reporting as ${result.agentId}.`
      : `Saved, but the server didn't accept it: ${(result && result.error) || "no response"}`,
    result && result.ok ? "ok" : "error"
  );
  await refresh();
});

document.getElementById("test").addEventListener("click", async () => {
  setStatusText("Checking…", "info");
  const result = await ask({ type: "CYBERSENTINEL_TEST_CONNECTION" });
  setStatusText((result && result.message) || "No response from the extension's service worker.",
                result && result.ok ? "ok" : "error");
  await refresh();
});

/**
 * sendMessage rejects outright when the service worker can't be reached (e.g.
 * it crashed on load). Surface that as a readable status instead of an uncaught
 * rejection that leaves the user staring at "Checking…".
 */
async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return {
      ok: false,
      error: `service worker unreachable (${e.message})`,
      message: `Service worker unreachable (${e.message}). Open chrome://extensions → this extension → "Service worker" to see why.`
    };
  }
}
