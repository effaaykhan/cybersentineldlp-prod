/*
 * CyberSentinel DLP — app catalog (destination classification).
 *
 * Answers "the browser is on this host; what kind of app is it?". The answer —
 * a category (webmail / cloud_storage / collaboration / genai) plus an app
 * identity — is what turns an anonymous page into a policy-matchable activity:
 * "Confidential data posted to ChatGPT" rather than "a POST somewhere".
 *
 * THE AUTHORITY IS THE SERVER. This file's list is a seed and an offline
 * fallback, never the source of truth. The worker pulls /api/v1/app-catalog/sync
 * and caches it, so adding a GenAI vendor is a row an operator inserts, not an
 * extension release. That matters because the previous design kept 26 hostnames
 * in a JS array inside inject.js — it contained no AI vendor at all, and
 * extending it meant re-packing and re-deploying the extension to every
 * endpoint.
 *
 * Loaded as a classic script by both the service worker (importScripts) and the
 * content scripts, so it must not use ES module syntax.
 */
(function (root) {
  "use strict";

  var CATEGORIES = ["webmail", "cloud_storage", "collaboration", "genai"];

  // [host_pattern, app_id, app_name, category]. Mirrors
  // server/app/core/web_activity.py DEFAULT_CATALOG — keep the two in step.
  var DEFAULT_ENTRIES = [
    // Webmail
    ["mail.google.com", "gmail", "Gmail", "webmail"],
    ["outlook.live.com", "outlook_web", "Outlook Web", "webmail"],
    ["outlook.office.com", "outlook_web", "Outlook Web", "webmail"],
    ["outlook.office365.com", "outlook_web", "Outlook Web", "webmail"],
    ["mail.yahoo.com", "yahoo_mail", "Yahoo Mail", "webmail"],
    ["mail.proton.me", "proton_mail", "Proton Mail", "webmail"],
    ["protonmail.com", "proton_mail", "Proton Mail", "webmail"],
    ["mail.zoho.com", "zoho_mail", "Zoho Mail", "webmail"],
    ["mail.rediff.com", "rediffmail", "Rediffmail", "webmail"],
    // Cloud storage / file sharing
    ["drive.google.com", "google_drive", "Google Drive", "cloud_storage"],
    ["docs.google.com", "google_docs", "Google Docs", "cloud_storage"],
    ["googleapis.com", "google_apis", "Google APIs", "cloud_storage"],
    ["googleusercontent.com", "google_upload", "Google Upload", "cloud_storage"],
    ["dropbox.com", "dropbox", "Dropbox", "cloud_storage"],
    ["dropboxapi.com", "dropbox", "Dropbox", "cloud_storage"],
    ["dropboxusercontent.com", "dropbox", "Dropbox", "cloud_storage"],
    ["onedrive.live.com", "onedrive", "OneDrive", "cloud_storage"],
    ["1drv.ms", "onedrive", "OneDrive", "cloud_storage"],
    ["sharepoint.com", "sharepoint", "SharePoint", "cloud_storage"],
    ["box.com", "box", "Box", "cloud_storage"],
    ["boxcloud.com", "box", "Box", "cloud_storage"],
    ["wetransfer.com", "wetransfer", "WeTransfer", "cloud_storage"],
    ["mega.nz", "mega", "MEGA", "cloud_storage"],
    ["mediafire.com", "mediafire", "MediaFire", "cloud_storage"],
    ["icloud.com", "icloud", "iCloud", "cloud_storage"],
    ["amazonaws.com", "aws_s3", "Amazon S3", "cloud_storage"],
    ["wasabisys.com", "wasabi", "Wasabi", "cloud_storage"],
    ["pcloud.com", "pcloud", "pCloud", "cloud_storage"],
    ["sync.com", "sync_com", "Sync.com", "cloud_storage"],
    ["terabox.com", "terabox", "TeraBox", "cloud_storage"],
    ["file.io", "file_io", "File.io", "cloud_storage"],
    ["anonfiles.com", "anonfiles", "AnonFiles", "cloud_storage"],
    ["gofile.io", "gofile", "GoFile", "cloud_storage"],
    ["transfernow.net", "transfernow", "TransferNow", "cloud_storage"],
    ["send.vis.ee", "send_vis", "Send", "cloud_storage"],
    ["pastebin.com", "pastebin", "Pastebin", "cloud_storage"],
    ["github.com", "github", "GitHub", "cloud_storage"],
    ["gitlab.com", "gitlab", "GitLab", "cloud_storage"],
    // Collaboration
    ["slack.com", "slack", "Slack", "collaboration"],
    ["teams.microsoft.com", "teams", "Microsoft Teams", "collaboration"],
    ["teams.live.com", "teams", "Microsoft Teams", "collaboration"],
    ["discord.com", "discord", "Discord", "collaboration"],
    ["web.whatsapp.com", "whatsapp_web", "WhatsApp Web", "collaboration"],
    ["web.telegram.org", "telegram_web", "Telegram Web", "collaboration"],
    ["app.zoom.us", "zoom", "Zoom", "collaboration"],
    ["meet.google.com", "google_meet", "Google Meet", "collaboration"],
    ["chat.google.com", "google_chat", "Google Chat", "collaboration"],
    ["atlassian.net", "atlassian", "Atlassian (Jira/Confluence)", "collaboration"],
    ["notion.so", "notion", "Notion", "collaboration"],
    ["trello.com", "trello", "Trello", "collaboration"],
    ["asana.com", "asana", "Asana", "collaboration"],
    ["linkedin.com", "linkedin", "LinkedIn", "collaboration"],
    ["mattermost.com", "mattermost", "Mattermost", "collaboration"],
    ["rocket.chat", "rocketchat", "Rocket.Chat", "collaboration"],
    // Generative AI
    ["chatgpt.com", "chatgpt", "ChatGPT", "genai"],
    ["chat.openai.com", "chatgpt", "ChatGPT", "genai"],
    ["openai.com", "openai", "OpenAI", "genai"],
    ["claude.ai", "claude", "Claude", "genai"],
    ["anthropic.com", "anthropic", "Anthropic", "genai"],
    ["gemini.google.com", "gemini", "Gemini", "genai"],
    ["bard.google.com", "gemini", "Gemini", "genai"],
    ["aistudio.google.com", "google_ai_studio", "Google AI Studio", "genai"],
    ["copilot.microsoft.com", "copilot", "Microsoft Copilot", "genai"],
    ["bing.com/chat", "copilot", "Microsoft Copilot", "genai"],
    ["github.com/copilot", "github_copilot", "GitHub Copilot", "genai"],
    ["chatbotui.com", "chatbot_ui", "Chatbot UI", "genai"],
    ["perplexity.ai", "perplexity", "Perplexity", "genai"],
    ["deepseek.com", "deepseek", "DeepSeek", "genai"],
    ["chat.deepseek.com", "deepseek", "DeepSeek", "genai"],
    ["grok.com", "grok", "Grok", "genai"],
    ["x.ai", "grok", "Grok", "genai"],
    ["mistral.ai", "mistral", "Le Chat (Mistral)", "genai"],
    ["chat.mistral.ai", "mistral", "Le Chat (Mistral)", "genai"],
    ["poe.com", "poe", "Poe", "genai"],
    ["huggingface.co", "huggingface", "Hugging Face", "genai"],
    ["character.ai", "character_ai", "Character.AI", "genai"],
    ["you.com", "you_com", "You.com", "genai"],
    ["phind.com", "phind", "Phind", "genai"],
    ["cohere.com", "cohere", "Cohere", "genai"],
    ["groq.com", "groq", "Groq", "genai"],
    ["together.ai", "together_ai", "Together AI", "genai"],
    ["replicate.com", "replicate", "Replicate", "genai"],
    ["openrouter.ai", "openrouter", "OpenRouter", "genai"],
    ["notebooklm.google.com", "notebooklm", "NotebookLM", "genai"],
    ["chat.qwen.ai", "qwen", "Qwen Chat", "genai"],
    ["kimi.moonshot.cn", "kimi", "Kimi", "genai"],
    ["meta.ai", "meta_ai", "Meta AI", "genai"],
    ["lmarena.ai", "lmarena", "LMArena", "genai"]
  ];

  function toEntry(row) {
    return {
      host: row[0],
      app_id: row[1],
      app_name: row[2],
      category: row[3],
      // A pattern carrying a path ("github.com/copilot") is more specific than
      // the bare host and must win over it.
      priority: row[0].indexOf("/") >= 0 ? 10 : 0
    };
  }

  var entries = DEFAULT_ENTRIES.map(toEntry);

  /**
   * Replace the catalog with what the server sent. Rows arrive already sorted
   * by priority; we re-sort anyway so a hand-edited cache can't change matching
   * order. An empty list is REFUSED — a server that answered with nothing is
   * far more likely to be misconfigured than to genuinely have zero apps, and
   * accepting it would silently switch off every interception.
   */
  function replace(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return false;
    entries = rows
      .filter(function (r) { return r && r.host && r.category; })
      .map(function (r) {
        return {
          host: String(r.host).toLowerCase(),
          app_id: r.app_id || "unknown_app",
          app_name: r.app_name || r.host,
          category: String(r.category).toLowerCase(),
          priority: Number(r.priority) || 0
        };
      })
      .sort(function (a, b) { return b.priority - a.priority; });
    return true;
  }

  function reset() {
    entries = DEFAULT_ENTRIES.map(toEntry);
  }

  function all() {
    return entries.slice();
  }

  /**
   * Exact host, or a dot-suffix of it — NEVER a bare substring.
   *
   * A substring test would make "box.com" match "dropbox.evil.example", which
   * is the standard way a host allowlist gets walked around. Patterns may carry
   * a first path segment ("bing.com/chat") so two apps can share one host.
   */
  function matches(pattern, hostname, pathname) {
    var p = String(pattern || "").toLowerCase().replace(/^\.+/, "");
    var h = String(hostname || "").toLowerCase();
    if (!p || !h) return false;

    var slash = p.indexOf("/");
    var pHost = slash >= 0 ? p.slice(0, slash) : p;
    var pPath = slash >= 0 ? p.slice(slash) : "";

    // Ports are part of the host for a self-hosted UI ("localhost:11434"), and
    // location.hostname drops them, so compare against host-with-port too.
    var hostOk = h === pHost || h.endsWith("." + pHost);
    if (!hostOk) return false;
    if (!pPath) return true;
    return String(pathname || "").toLowerCase().indexOf(pPath) === 0;
  }

  /**
   * Which app is this URL? Returns {app_id, app_name, category, host} or null.
   * Highest priority wins, so a path-scoped row beats the bare-host row it
   * shares a hostname with.
   */
  function resolve(hostname, pathname, port) {
    var withPort = port ? hostname + ":" + port : hostname;
    var best = null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (matches(e.host, hostname, pathname) || matches(e.host, withPort, pathname)) {
        if (!best || e.priority > best.priority) best = e;
      }
    }
    return best;
  }

  function resolveUrl(url) {
    try {
      var u = new URL(url);
      return resolve(u.hostname, u.pathname, u.port);
    } catch (e) {
      return null;
    }
  }

  /**
   * Match patterns for chrome.scripting.registerContentScripts.
   *
   * The guard cannot be a static <all_urls> content script: loading the
   * scanner, the inspector and the guard into every page the user opens is a
   * real cost for a list that is mostly not applicable. Registering only the
   * catalogued hosts keeps that cost where it belongs, and re-registering when
   * the catalog changes is what makes a newly added vendor take effect without
   * an extension update.
   */
  // A hostname Chrome will accept inside a match pattern.
  //
  // Match patterns are far stricter than the catalog's own host syntax, and the
  // penalty for getting it wrong is severe: registerContentScripts rejects the
  // ENTIRE call on one malformed pattern, so a single bad catalog row would
  // leave the extension registered nowhere and silently enforcing nothing.
  // Two rules bite in practice:
  //
  //   * NO PORTS. "localhost:11434" is a perfectly good catalog key — the whole
  //     point is to name a self-hosted LLM UI — and an illegal match pattern.
  //     Patterns are port-agnostic, so the port is dropped here and the port
  //     itself is still honoured by resolve() once the script is running.
  //   * NO TRAILING DOT / WILDCARD PREFIX. A pattern like "roundcube." means
  //     "any host starting with roundcube." to resolve(), and means nothing at
  //     all to Chrome.
  var VALID_MATCH_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

  function matchPatterns() {
    var out = {};
    var skipped = [];
    for (var i = 0; i < entries.length; i++) {
      var host = entries[i].host.split("/")[0].split(":")[0];
      if (!host || !VALID_MATCH_HOST.test(host)) {
        skipped.push(entries[i].host);
        continue;
      }
      var local = host === "localhost" || host.indexOf("127.0.0.1") === 0;
      if (local) {
        // Local UIs are http. Everything else is https-only on purpose: an
        // http:// impersonation of a catalogued host must not inherit its
        // policy.
        out["http://" + host + "/*"] = 1;
      } else {
        out["https://" + host + "/*"] = 1;
        out["https://*." + host + "/*"] = 1;
      }
    }
    if (skipped.length) {
      console.warn(
        "[CS-DLP] " + skipped.length + " catalog host(s) cannot be expressed as a browser " +
        "match pattern and are not being guarded: " + skipped.join(", ")
      );
    }
    return Object.keys(out);
  }

  root.CSDLPCatalog = {
    CATEGORIES: CATEGORIES,
    all: all,
    replace: replace,
    reset: reset,
    resolve: resolve,
    resolveUrl: resolveUrl,
    matches: matches,
    matchPatterns: matchPatterns
  };
})(typeof self !== "undefined" ? self : this);
