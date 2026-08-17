/*
 * CyberSentinel DLP — per-app DOM profiles for the activity guard.
 *
 * A profile tells the guard three things about one web app: where the user
 * types, what they press to submit, and (for GenAI) where the answer appears.
 *
 * ── WHY SELECTORS ARE HINTS, NOT REQUIREMENTS ────────────────────────────
 *
 * None of these apps has a documented DOM. Gmail's compose markup, ChatGPT's
 * prompt box and Claude's editor all change without notice, and the previous
 * generation of this code staked detection entirely on exact selectors — so a
 * rename upstream silently turned blocking off, with the only symptom being an
 * absence of console lines nobody was reading.
 *
 * So the backbone here is STRUCTURAL, not nominal: find the editable element the
 * user is actually typing in, and find the button that submits the form it
 * belongs to. That works on an app this file has never heard of, which is the
 * whole point — the catalog is a database table, so a GenAI vendor added by an
 * operator this morning has no profile and must still be guarded. The named
 * selectors below are tried first purely because they are faster and more
 * precise when they do match; every one of them is allowed to fail.
 *
 * ── WHY THE ENTER KEY IS A PER-APP FACT ──────────────────────────────────
 *
 * In Gmail, Enter is a newline and Ctrl+Enter sends. In every chat UI, bare
 * Enter sends and Shift+Enter is the newline. Getting this backwards is not a
 * cosmetic bug: a guard that only watches Ctrl+Enter never sees a single
 * ChatGPT prompt, and one that treats Enter as submit in Gmail holds the
 * gesture every time someone starts a new paragraph.
 */
(function (root) {
  "use strict";

  /* ── Structural selectors, ordered most-specific-first ─────────────────── */

  // Where a user types. contenteditable covers rich composers (Gmail, Claude,
  // Slack); textarea covers the plainer ones (Copilot, Perplexity).
  var EDITABLE_SELECTOR = [
    'div[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    "textarea",
    'input[type="text"][aria-label*="message" i]'
  ].join(", ");

  // Anything that plausibly submits. Ordered so a labelled control wins over a
  // bare type=submit, which on a search page is usually the wrong button.
  var SUBMIT_SELECTOR = [
    '[data-testid*="send" i]',
    '[data-testid*="submit" i]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
    'div[role="button"][aria-label*="send" i]',
    'div[role="button"][data-tooltip*="send" i]',
    'button[title*="send" i]',
    'button[title*="submit" i]',
    'button[type="submit"]',
    'button[data-testid="send-button"]'
  ].join(", ");

  /* ── Profiles ──────────────────────────────────────────────────────────── */
  //
  // Fields:
  //   category        webmail | cloud_storage | collaboration | genai
  //   activity        which verb a submit gesture represents
  //   body            selector for the compose/prompt element (hint)
  //   subject         selector for a subject line, webmail only (hint)
  //   submit          selector for the submit control (hint)
  //   submitOnEnter   true when bare Enter submits (every chat UI)
  //   submitOnModEnter true when Ctrl/Cmd+Enter submits (mail, and most chats
  //                   accept it too)
  //   response        selector for the model's reply, GenAI only
  //
  // Everything is optional. A profile of {} still works — see resolve().

  var PROFILES = {
    /* ── Webmail ── */
    gmail: {
      category: "webmail",
      activity: "send",
      body:
        'div[aria-label="Message Body"][contenteditable="true"], ' +
        'div[aria-label="Message body"][contenteditable="true"], ' +
        'div[g_editable="true"], ' +
        'div[role="textbox"][contenteditable="true"]',
      subject: 'input[name="subjectbox"], input[aria-label^="Subject"]',
      submit:
        'div[role="button"][data-tooltip*="Send" i], div[role="button"][aria-label*="Send" i]',
      submitOnEnter: false,
      submitOnModEnter: true,
      recipients: "[email], [data-lpc-email], [title*='@']"
    },
    outlook_web: {
      category: "webmail",
      activity: "send",
      body:
        'div[aria-label="Message body"][contenteditable="true"], ' +
        'div[role="textbox"][contenteditable="true"]',
      subject: 'input[aria-label="Add a subject"], input[placeholder^="Subject" i]',
      submit:
        'button[aria-label*="Send" i], button[name="Send"], div[role="button"][aria-label*="Send" i]',
      submitOnEnter: false,
      submitOnModEnter: true,
      recipients: "[email], [data-lpc-email], [title*='@']"
    },
    yahoo_mail: {
      category: "webmail",
      activity: "send",
      subject: 'input[data-test-id="compose-subject"]',
      submit: 'button[data-test-id="compose-send-button"], button[aria-label*="Send" i]',
      submitOnEnter: false,
      submitOnModEnter: true
    },
    proton_mail: {
      category: "webmail",
      activity: "send",
      submit: 'button[data-testid="composer:send-button"], button[aria-label*="Send" i]',
      submitOnEnter: false,
      submitOnModEnter: true
    },
    zoho_mail: { category: "webmail", activity: "send", submitOnEnter: false, submitOnModEnter: true },
    rediffmail: { category: "webmail", activity: "send", submitOnEnter: false, submitOnModEnter: true },

    /* ── Generative AI ──
     *
     * Selectors below were correct when written and are expected to rot. They
     * are a fast path only; resolve() falls through to the structural search
     * the moment one stops matching, so rot degrades precision, never coverage.
     */
    chatgpt: {
      category: "genai",
      activity: "post",
      body: '#prompt-textarea, div[contenteditable="true"]#prompt-textarea, textarea#prompt-textarea',
      submit: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
      submitOnEnter: true,
      response: '[data-message-author-role="assistant"]'
    },
    claude: {
      category: "genai",
      activity: "post",
      body: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
      submit: 'button[aria-label*="Send" i], button[type="submit"]',
      submitOnEnter: true,
      response: '[data-testid="assistant-message"], div.font-claude-message'
    },
    gemini: {
      category: "genai",
      activity: "post",
      body: 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]',
      submit: 'button.send-button, button[aria-label*="Send" i]',
      submitOnEnter: true,
      response: "model-response, message-content"
    },
    google_ai_studio: {
      category: "genai",
      activity: "post",
      body: 'textarea[aria-label*="prompt" i], textarea',
      submit: 'button[aria-label*="Run" i], button[type="submit"]',
      submitOnEnter: false,
      submitOnModEnter: true
    },
    copilot: {
      category: "genai",
      activity: "post",
      body: "textarea#userInput, textarea",
      submit: 'button[title*="Submit" i], button[aria-label*="Submit" i], button[aria-label*="Send" i]',
      submitOnEnter: true
    },
    perplexity: {
      category: "genai",
      activity: "post",
      body: 'textarea[placeholder*="Ask" i], div[contenteditable="true"], textarea',
      submit: 'button[aria-label*="Submit" i], button[type="submit"]',
      submitOnEnter: true
    },
    deepseek: {
      category: "genai",
      activity: "post",
      body: "textarea#chat-input, textarea",
      submit: 'div[role="button"][aria-disabled], button[type="submit"]',
      submitOnEnter: true
    },
    grok: { category: "genai", activity: "post", submitOnEnter: true },
    mistral: { category: "genai", activity: "post", submitOnEnter: true },
    poe: { category: "genai", activity: "post", submitOnEnter: true },
    huggingface: { category: "genai", activity: "post", submitOnEnter: true },
    character_ai: { category: "genai", activity: "post", submitOnEnter: true },
    you_com: { category: "genai", activity: "post", submitOnEnter: true },
    phind: { category: "genai", activity: "post", submitOnEnter: true },
    qwen: { category: "genai", activity: "post", submitOnEnter: true },
    kimi: { category: "genai", activity: "post", submitOnEnter: true },
    meta_ai: { category: "genai", activity: "post", submitOnEnter: true },
    notebooklm: { category: "genai", activity: "post", submitOnEnter: true },
    ollama: { category: "genai", activity: "post", submitOnEnter: true },
    openrouter: { category: "genai", activity: "post", submitOnEnter: true },
    lmarena: { category: "genai", activity: "post", submitOnEnter: true },

    /* ── Collaboration ── */
    slack: {
      category: "collaboration",
      activity: "post",
      body: 'div[data-qa="message_input"] div[contenteditable="true"], div[contenteditable="true"]',
      submit: 'button[data-qa="texty_send_button"], button[aria-label*="Send" i]',
      submitOnEnter: true
    },
    teams: {
      category: "collaboration",
      activity: "post",
      body: 'div[contenteditable="true"][role="textbox"]',
      submit: 'button[name="send"], button[aria-label*="Send" i]',
      submitOnEnter: true
    },
    discord: {
      category: "collaboration",
      activity: "post",
      body: 'div[role="textbox"][contenteditable="true"]',
      submitOnEnter: true
    },
    whatsapp_web: {
      category: "collaboration",
      activity: "post",
      body: 'div[contenteditable="true"][data-tab]',
      submit: 'button[aria-label*="Send" i], span[data-icon="send"]',
      submitOnEnter: true
    },
    telegram_web: {
      category: "collaboration",
      activity: "post",
      body: 'div[contenteditable="true"].input-message-input',
      submitOnEnter: true
    },
    google_chat: { category: "collaboration", activity: "post", submitOnEnter: true },
    mattermost: { category: "collaboration", activity: "post", submitOnEnter: true },
    rocketchat: { category: "collaboration", activity: "post", submitOnEnter: true },
    linkedin: { category: "collaboration", activity: "post", submitOnEnter: false, submitOnModEnter: true },
    notion: { category: "collaboration", activity: "post", submitOnEnter: false }
  };

  /* ── Category defaults ──────────────────────────────────────────────────
   *
   * What an app gets when the catalog knows its category but this file has
   * never heard of it — the newly-added-vendor case, which is the normal case
   * once the catalog is a table an operator edits.
   */
  var CATEGORY_DEFAULTS = {
    webmail: { activity: "send", submitOnEnter: false, submitOnModEnter: true },
    // Cloud storage has no compose box; its activities are upload/download,
    // handled by the request interceptor and the download hook rather than by a
    // submit gesture. A guard is still installed so an attach event is
    // attributed to the right app.
    cloud_storage: { activity: "upload", submitOnEnter: false, submitOnModEnter: false, noSubmitGuard: true },
    collaboration: { activity: "post", submitOnEnter: true, submitOnModEnter: true },
    genai: { activity: "post", submitOnEnter: true, submitOnModEnter: true }
  };

  /**
   * The profile for a resolved catalog app. Always returns something usable:
   * a named profile merged over its category default, or the category default
   * alone. Never null — "we don't have a profile" must not mean "unguarded".
   */
  function forApp(app) {
    if (!app) return null;
    var base = CATEGORY_DEFAULTS[app.category] || CATEGORY_DEFAULTS.genai;
    var named = PROFILES[app.app_id] || {};
    var merged = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
    for (k in named) if (Object.prototype.hasOwnProperty.call(named, k)) merged[k] = named[k];

    merged.appId = app.app_id;
    merged.appName = app.app_name;
    merged.category = app.category;
    // Structural fallbacks, appended so the named hint is tried first.
    merged.bodySelector = merged.body ? merged.body + ", " + EDITABLE_SELECTOR : EDITABLE_SELECTOR;
    merged.submitSelector = merged.submit ? merged.submit + ", " + SUBMIT_SELECTOR : SUBMIT_SELECTOR;
    merged.namedBodySelector = merged.body || null;
    merged.namedSubmitSelector = merged.submit || null;
    return merged;
  }

  root.CSDLPProfiles = {
    forApp: forApp,
    EDITABLE_SELECTOR: EDITABLE_SELECTOR,
    SUBMIT_SELECTOR: SUBMIT_SELECTOR,
    PROFILES: PROFILES
  };
})(typeof self !== "undefined" ? self : this);
