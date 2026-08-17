/*
 * CyberSentinel DLP — activity guard.
 *
 * Intercepts the gesture that sends content OUT of the browser — Send in Gmail,
 * Enter in ChatGPT, the submit arrow in Slack — holds it, gets a verdict, and
 * either lets it go or stops it.
 *
 * ── WHAT THIS FILE USED TO BE ────────────────────────────────────────────
 *
 * This started as an email send-guard, and everything it learned the hard way
 * about intercepting a Send is preserved below: cancelling every event of a
 * gesture rather than trusting pointerdown, keying attachment tracking on the
 * compose BODY rather than a container, requiring two consecutive misses before
 * dropping a finding, recovering pasted images the paste event never reported.
 * Those comments are kept verbatim because each one marks a bug that shipped.
 *
 * What changed is the scope of the idea. A Send gesture in Gmail and an Enter
 * keypress in ChatGPT are the same event with the same payload — content
 * leaving the endpoint — so the machinery is now profile-driven rather than
 * email-specific, and the app it is running in comes from a database table
 * instead of a hardcoded list.
 *
 * ── WHY THE VERDICT IS THE SERVER'S ──────────────────────────────────────
 *
 * The old guard decided locally, from a regex list compiled into the extension.
 * That works offline and it is fast, and it also means the DLP platform's policy
 * engine, ML classifier, EDM index and document fingerprints — the entire
 * reason the product exists — had no say in what a browser was allowed to send.
 * Decisions now come from POST /agents/{id}/policy/evaluate. The bundled scanner
 * is the fallback for when that call cannot be made, not the primary.
 *
 * ── WHY AN UNRULED ACTIVITY IS NEVER HELD ────────────────────────────────
 *
 * A server round trip is tens to hundreds of milliseconds. Holding every Enter
 * keypress in every chat app for one would make the browser feel broken, and
 * would do it in aid of a question nobody asked — most activities have no policy
 * about them. So the cached policy matrix is consulted FIRST, synchronously, and
 * an activity whose cell is "allow" (or which no policy mentions) is not
 * intercepted at all: zero listeners fire, zero latency, no behaviour change.
 * Only cells set to alert or block hold the gesture; a cell set to log lets it
 * through and reports afterwards.
 */
(function () {
  "use strict";

  var BLOCK_MESSAGE = "cybersentinel dlp cant send this document due to policy";

  var NOTICE_ID = "cybersentinel-dlp-notice";
  var GESTURE_MS = 1500;
  // Upper bound on one press-and-release. Generous because the user, not the
  // code, decides how long to hold the button down.
  var GESTURE_MAX_MS = 15000;
  // Ceiling on how long a user is made to wait for their own submit.
  //
  // Sized for the worst case rather than the typical one: an upright document is
  // identified on the first OCR pass in a few seconds, but an image that matches
  // nothing is retried binarised, at native size, and at three rotations before
  // it is believed. Cutting that off early would hand back "still checking, press
  // Send again" on exactly the images that most need the extra passes.
  var WAIT_FOR_SCAN_MS = 120000;
  // How long to wait for the server's verdict before falling back to the local
  // scanner. Short: this is on the critical path of a user's keystroke.
  var VERDICT_TIMEOUT_MS = 12000;

  /* ── Shared DOM heuristics ──────────────────────────────────────────────── */

  // Real attachment names virtually always end in a file extension; toolbar
  // action labels never do. Filtering on that shape is far more robust than
  // guessing any app's undocumented CSS class names.
  //
  // A bare [data-tooltip]/[title] catch-all previously swept up the mail app's
  // own toolbar icons — including Gmail's "Toggle confidential mode", whose
  // tooltip literally contains the word "confidential", which made every single
  // email falsely block.
  var FILENAME_SHAPE = /\.[a-zA-Z0-9]{2,5}$/;
  // An email address or a URL also ends in a dot plus 2-5 characters, and
  // neither is ever a real attachment name.
  var NOT_A_FILENAME = /@|^https?:\/\//i;

  // Below this, an <img> is a UI glyph (emoji, icon, spacer), not a document
  // someone is exfiltrating.
  var MIN_INLINE_IMAGE_PX = 64;

  // Extensions worth insisting on a verdict for. Deliberately narrower than
  // "any filename": a stray bit of text shaped like a filename must not be able
  // to block a clean message.
  var SENSITIVE_ATTACHMENT_SHAPE =
    /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt|csv)$/i;

  /* ── User-visible notice ────────────────────────────────────────────────── */

  // Deliberately fixed to the viewport rather than inserted next to the submit
  // button: a compose window is small, often scrolled, and sometimes clips its
  // own overflow, so a banner placed inside it can end up invisible — which for
  // a blocked send means the user sees nothing happen at all and simply clicks
  // Send harder.
  //
  // ONE NOTICE PER COMPOSE, stacked. A single shared element forced a choice
  // between two wrong behaviours: let anything overwrite anything, and a second
  // compose finishing its scan wipes the first one's block message off the
  // screen; or give "block" priority, and a held send in another compose shows
  // no feedback at all while the button quietly stops responding. Worse, with
  // priority a *successful* send could complete while a stale block banner was
  // still on screen, telling the user something had been stopped that in fact
  // went out. Separate elements make the question moot.
  function noticeHost() {
    var host = document.getElementById(NOTICE_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = NOTICE_ID;
    host.style.cssText = [
      "position:fixed", "top:16px", "left:50%", "transform:translateX(-50%)",
      "z-index:2147483647", "display:flex", "flex-direction:column", "gap:8px",
      "align-items:center", "pointer-events:none"
    ].join(";");
    document.documentElement.appendChild(host);
    return host;
  }

  var composeNotices = new WeakMap();

  function noticeFor(key) {
    var existing = key && composeNotices.get(key);
    if (existing && existing.isConnected) return existing;

    var notice = document.createElement("div");
    notice.className = "cybersentinel-dlp-notice";
    notice.style.cssText = [
      "max-width:min(640px, 92vw)", "padding:14px 18px", "border-radius:8px",
      "font-family:Arial,Helvetica,sans-serif", "font-size:14px", "line-height:1.45",
      "color:#fff", "box-shadow:0 6px 24px rgba(0,0,0,.35)", "white-space:normal",
      "pointer-events:auto"
    ].join(";");
    noticeHost().appendChild(notice);
    if (key) composeNotices.set(key, notice);
    return notice;
  }

  function showNotice(key, html, background, autoHideMs) {
    var notice = noticeFor(key);
    notice.style.background = background;
    notice.innerHTML = html;
    notice.style.display = "block";

    if (notice.dlpTimer) clearTimeout(notice.dlpTimer);
    notice.dlpTimer = autoHideMs ? setTimeout(function () { notice.remove(); }, autoHideMs) : null;
  }

  function hideNotice(key) {
    var notice = key && composeNotices.get(key);
    if (!notice) return;
    if (notice.dlpTimer) clearTimeout(notice.dlpTimer);
    notice.remove();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showBlockNotice(key, reasons, why) {
    var detail = reasons.length
      ? '<div style="margin-top:8px;font-size:12px;opacity:.92">Detected: ' +
        escapeHtml(reasons.join(", ")) + "</div>"
      : "";
    // The policy reason, when the server gave one, is far more actionable than
    // a list of matched patterns — it names the rule the operator wrote.
    var policy = why
      ? '<div style="margin-top:6px;font-size:12px;opacity:.92">' + escapeHtml(why) + "</div>"
      : "";
    showNotice(
      key,
      '<div style="font-weight:700;font-size:15px">' + escapeHtml(BLOCK_MESSAGE) + "</div>" +
        '<div style="margin-top:6px;font-size:12px;opacity:.92">Remove the confidential content or ' +
        "attachment to continue.</div>" + policy + detail,
      "#c62828",
      15000
    );
  }

  function showCheckingNotice(key, appName, what) {
    showNotice(
      key,
      '<div style="font-weight:700;font-size:15px">CyberSentinel DLP is checking ' +
        escapeHtml(what) + "…</div>" +
        '<div style="margin-top:6px;font-size:12px;opacity:.92">This will continue automatically ' +
        "if nothing confidential is found.</div>",
      "#1565c0",
      0
    );
  }

  function showTimeoutNotice(key) {
    showNotice(
      key,
      '<div style="font-weight:700;font-size:15px">Still checking</div>' +
        '<div style="margin-top:6px;font-size:12px;opacity:.92">Inspection has not finished, so this ' +
        "was held. Try again in a moment.</div>",
      "#ef6c00",
      12000
    );
  }

  /* ── Install ────────────────────────────────────────────────────────────── */

  /**
   * @param {object} profile   Resolved app profile — see profiles.js.
   * @param {object} policy    Cached web-activity matrix — see background.js.
   */
  function install(profile, policy) {
    var scanner = window.CyberSentinelScanner;
    if (!scanner) {
      console.error(
        "[CyberSentinel] FATAL: window.CyberSentinelScanner is missing — scanner.js did not load, " +
        "so the offline fallback is unavailable. Check chrome://extensions for a load error."
      );
    }
    var scanText = scanner ? scanner.scanText : function () { return { matched: false, reasons: [] }; };
    var scanFilename = scanner ? scanner.scanFilename : function () { return { matched: false, reasons: [] }; };
    var classifyFromReasons = scanner ? scanner.classifyFromReasons : function () { return "Public"; };

    // NEVER let a missing/failed inspection module take down the rest of this
    // script. An unguarded destructure of a missing global throws at the top of
    // the IIFE, which means not one listener below gets attached and detection
    // fails *completely silently* — keyword, pattern and filename layers
    // included, not just OCR.
    var ocrModule = window.CyberSentinelOCR;
    if (!ocrModule) {
      console.error(
        "[CyberSentinel] window.CyberSentinelOCR is not available — attachment inspection is " +
        "disabled, but body-text detection will still run normally."
      );
      ocrModule = {
        prescanAttachment: function () { return null; },
        noteInlineNode: function () {},
        getResultsForContainer: function () {
          return { reasons: [], pending: [], unscanned: [], trackedNames: [], texts: [], files: [] };
        },
        waitForContainer: function () {
          return Promise.resolve({ reasons: [], pending: [], unscanned: [], trackedNames: [], texts: [], files: [] });
        }
      };
    }
    // The stand-in above once exported a *different* name than the one
    // destructured here, so the fallback that exists to keep detection alive
    // instead left the function undefined — every send then threw, hit the
    // "fail open" catch, and silently let sensitive mail through. These names
    // must stay identical.
    var prescanAttachment = ocrModule.prescanAttachment;
    var getResultsForContainer = ocrModule.getResultsForContainer;
    var waitForContainer = ocrModule.waitForContainer;

    var BODY_SELECTOR = profile.bodySelector;
    var SUBMIT_SELECTOR = profile.submitSelector;
    var APP = profile.appName || profile.appId || location.hostname;

    /* -- policy-driven engagement ------------------------------------------ */
    //
    // Which action the cached matrix defines for this app's submit activity.
    // Everything below keys off it, and "allow" means the guard installs
    // nothing at all.
    var currentPolicy = policy || { enforced: false, mode: "off", matrix: {}, app_overrides: [] };

    function cellAction(activity) {
      return window.CSDLPPolicy
        ? window.CSDLPPolicy.actionFor(currentPolicy, profile.category, activity, profile.appId)
        : "allow";
    }

    var submitActivity = profile.activity || "post";

    /* -- everything below comes from policy --------------------------------
     *
     * There is no local enforcement mode and no local "block uninspectable"
     * toggle. Both used to live in the extension's own settings, which meant a
     * user could disagree with the server and then wonder why nothing happened.
     * Audit-vs-enforce and the uninspectable rule are properties of the POLICY,
     * so they are read from it and change when it does.
     */
    function auditMode() {
      return String(currentPolicy.mode || "enforce").toLowerCase() === "audit";
    }
    function blockUninspectable() {
      // Defaults ON. Content nobody could open is exactly the case this exists
      // to catch — a password-protected archive classifies as Public — so the
      // safe reading has to be what you get when a policy says nothing.
      return currentPolicy.block_uninspectable !== false;
    }

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      // A policy edit on the server reaches here through the worker's cache.
      // Re-deriving engagement matters as much as storing the new policy: an
      // operator who switches GenAI posts from Allow to Block expects the next
      // prompt to be checked, not the next browser restart. applyEngagement is
      // idempotent, so this can run on every change.
      if (changes.webActivityPolicy && changes.webActivityPolicy.newValue) {
        currentPolicy = changes.webActivityPolicy.newValue;
        applyEngagement();
      }
    });

    /* -- compose scoping --------------------------------------------------- */

    /**
     * Walk up from the element actually involved (the submit button, or the
     * file input / paste target) to the nearest ancestor holding this compose's
     * own body.
     *
     * Scoping instead to `closest('div[role="dialog"]')` was a real bug:
     * Gmail's bottom-corner compose window doesn't use role="dialog", so the
     * lookup fell through to `document` and scanning picked up whichever
     * compose window appeared first in DOM order — not necessarily the one
     * being sent.
     */
    function getComposeContainer(startElement) {
      var node = startElement;
      for (var i = 0; i < 15 && node; i++) {
        if (node.querySelector && node.querySelector(BODY_SELECTOR)) return node;
        node = node.parentElement;
      }
      console.warn(
        "[CyberSentinel] Could not scope the compose window; falling back to the whole document — " +
        "results may be inaccurate if several composers are open."
      );
      return document;
    }

    /**
     * The compose's body element, resolved identically from any starting point
     * inside that compose. This is the identity attachments are tracked
     * against, and getting it wrong is silent and total.
     *
     * getComposeContainer() alone cannot serve: it returns the lowest
     * *ancestor* holding a body, which depends on where the walk started. A
     * paste fires on the body itself, whose lowest qualifying ancestor is its
     * immediate wrapper; the submit button sits outside the body, so its walk
     * stops several levels higher, at the compose root. Two different elements,
     * so a WeakMap keyed on "the container" stored the OCR result under one key
     * at attach time and looked it up under another at send time — finding
     * nothing, reporting no findings AND no pending scans, and letting a pasted
     * screenshot of a passport go out with an "allowed" event. Keying on the
     * body itself is stable from both directions.
     */
    function getComposeKey(startElement) {
      var node = startElement;
      for (var i = 0; i < 20 && node; i++) {
        // The paste/drop target frequently IS the body, and querySelector only
        // searches descendants, so self has to be tested separately.
        if (node.matches && node.matches(BODY_SELECTOR)) return node;
        if (node.querySelector) {
          var body = node.querySelector(BODY_SELECTOR);
          if (body) return body;
        }
        node = node.parentElement;
      }
      return null;
    }

    /**
     * The text the user actually typed.
     *
     * Prefers the element the caret is in over the first match in document
     * order. On a chat page the prompt box is usually the only editable, but on
     * an app with an inline reply box AND a main composer, document order picks
     * the wrong one — and a guard that reads an empty box classifies every
     * message as clean.
     */
    function getBodyText(container) {
      var active = document.activeElement;
      if (active && active.matches && active.matches(BODY_SELECTOR)) {
        if (container === document || container.contains(active)) {
          return readEditable(active);
        }
      }
      var body = container.querySelector(BODY_SELECTOR);
      return body ? readEditable(body) : "";
    }

    function readEditable(el) {
      if (!el) return "";
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
      // innerText is the right reading (it respects rendering), but falling back
      // matters: a scanner that throws here fails open, so a missing property
      // would silently disable body scanning rather than degrade it.
      return el.innerText || el.textContent || "";
    }

    function getSubjectText(container) {
      if (!profile.subject) return "";
      var input = container.querySelector(profile.subject);
      return input ? input.value || "" : "";
    }

    function getAttachmentNames(container) {
      var body = container.querySelector(BODY_SELECTOR);
      var names = {};

      function consider(raw) {
        var label = (raw || "").trim();
        if (!label || label.length > 200) return;
        if (!FILENAME_SHAPE.test(label) || NOT_A_FILENAME.test(label)) return;
        names[label] = 1;
      }

      // Names carried on attributes: chip tooltips, download links, etc.
      container.querySelectorAll("[data-tooltip], [aria-label], [title]").forEach(function (el) {
        consider(el.getAttribute("data-tooltip"));
        consider(el.getAttribute("aria-label"));
        consider(el.getAttribute("title"));
      });

      // Apps also render the attachment name as plain text in an element
      // carrying none of those attributes, so an attribute-only sweep returned
      // nothing at all — a compose holding Shounak_passport.jpg logged
      // "attachments=[]" and the filename layer never ran. The body is excluded
      // so prose mentioning a filename (or ending in ".com") isn't mistaken for
      // an attachment.
      container.querySelectorAll("*").forEach(function (el) {
        if (el.children.length > 0) return;
        if (body && (el === body || body.contains(el))) return;
        consider(el.textContent);
      });

      return Object.keys(names);
    }

    function getRecipients(container) {
      if (!profile.recipients) return "";
      var nodes = container.querySelectorAll(profile.recipients);
      var emails = {};
      Array.prototype.forEach.call(nodes, function (el) {
        var v = el.getAttribute("email") || el.getAttribute("data-lpc-email") || el.getAttribute("title");
        if (v && v.indexOf("@") >= 0) emails[v] = 1;
      });
      return Object.keys(emails).join(", ");
    }

    /* -- attach-time pre-scan ---------------------------------------------- */

    // <img> nodes already claimed by a tracked paste, so two screenshots pasted
    // in quick succession don't both latch onto the first one.
    var claimedInlineNodes = new WeakSet();

    /**
     * The compose the user is currently working in.
     *
     * WHY THIS EXISTS: resolving the compose by walking up from the element that
     * fired the attach event assumes that element is INSIDE the compose. For a
     * paste or a drop it is. For the file picker it very often is not — a hidden
     * <input type="file"> does not have to live in the compose subtree at all,
     * and when it doesn't, the walk finds no body, prescanAttachment is handed a
     * null key and returns without tracking anything.
     *
     * The consequence is silent and total: nothing is inspected, so at send time
     * there are no findings AND nothing pending, the compose scans clean, and
     * the attachment goes out. That is precisely the "I attached a screenshot of
     * a passport and it sent" symptom.
     */
    var lastComposeKey = null;

    function rememberCompose(element) {
      if (!element) return;
      var key = getComposeKey(element);
      if (key) lastComposeKey = key;
    }
    ["focusin", "pointerdown", "keydown", "input"].forEach(function (type) {
      window.addEventListener(type, function (event) { rememberCompose(event.target); }, true);
    });

    function resolveComposeKey(startElement) {
      var direct = getComposeKey(startElement);
      if (direct) return direct;

      if (lastComposeKey && lastComposeKey.isConnected) {
        console.info("[CyberSentinel] Attach event fired outside the composer — using the active one.");
        return lastComposeKey;
      }

      // Exactly one composer open means there is no ambiguity to resolve.
      var bodies = document.querySelectorAll(BODY_SELECTOR);
      if (bodies.length === 1) return bodies[0];

      return null;
    }

    /**
     * Find the <img> the app inserts for a pasted image and bind it to that
     * attachment's tracking entry, so "is it still attached?" becomes an
     * identity check on a specific node instead of a count of every image in the
     * body (quoted replies and image signatures are images too, and they made a
     * deleted screenshot look permanently present).
     *
     * The app inserts the node asynchronously and there is no event for it,
     * hence the observer. It gives up after a few seconds rather than watching
     * forever; presence then falls back to the count heuristic, which is
     * imprecise but never worse than what it replaced.
     */
    function captureInlineImage(body, id) {
      function claim() {
        var imgs = body.querySelectorAll("img");
        for (var i = 0; i < imgs.length; i++) {
          if (claimedInlineNodes.has(imgs[i])) continue;
          claimedInlineNodes.add(imgs[i]);
          ocrModule.noteInlineNode(id, imgs[i]);
          return true;
        }
        return false;
      }

      if (claim()) return;

      var observer = new MutationObserver(function () {
        if (claim()) {
          observer.disconnect();
          clearTimeout(giveUp);
        }
      });
      observer.observe(body, { childList: true, subtree: true });
      var giveUp = setTimeout(function () { observer.disconnect(); }, 10000);
    }

    // Kick off inspection the instant an attachment is added — via file picker,
    // drag-drop, OR pasted straight into the body (Ctrl+V). Pasted images need
    // their own handling because they have no filename and no attachment chip,
    // which is exactly how a pasted screenshot used to slip past.
    //
    // Registered whenever attach OR the submit activity is ruled: inspection is
    // what makes a later decision possible, and it costs nothing until an
    // attachment actually appears.
    function installAttachHooks() {
      window.addEventListener("change", function (event) {
        var input = event.target;
        if (!input || input.tagName !== "INPUT" || input.type !== "file" || !input.files) return;
        var key = resolveComposeKey(input);
        for (var i = 0; i < input.files.length; i++) {
          prescanAttachment(input.files[i], APP, key, "file");
        }
        reportAttach(input.files, "file");
      }, true);

      window.addEventListener("drop", function (event) {
        var files = event.dataTransfer && event.dataTransfer.files;
        if (!files || files.length === 0) return;
        var key = resolveComposeKey(event.target);
        for (var i = 0; i < files.length; i++) prescanAttachment(files[i], APP, key, "drop");
        reportAttach(files, "drop");
      }, true);

      window.addEventListener("paste", function (event) {
        var items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        var key = resolveComposeKey(event.target);
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind !== "file") continue;
          var file = items[i].getAsFile();
          if (!file) continue;
          var id = prescanAttachment(file, APP, key, "paste");
          if (id !== null && key) captureInlineImage(key, id);
        }
      }, true);
    }

    /**
     * Report the attach verb itself.
     *
     * Distinct from the send that follows: the requirement lists Attach and Send
     * as separate controls, and they genuinely are — attaching a design document
     * to a ChatGPT conversation is an event whether or not the user then presses
     * Enter. Never blocks here; the file has not left yet, and the submit guard
     * is where stopping it belongs.
     */
    function reportAttach(files, source) {
      if (cellAction("attach") === "allow") return;
      var names = [];
      for (var i = 0; i < files.length; i++) names.push(files[i].name || "(pasted)");
      send({
        type: "CSDLP_ACTIVITY_EVENT",
        payload: {
          appId: profile.appId, appName: APP, category: profile.category,
          activity: "attach",
          pageUrl: location.href, pageHost: location.hostname,
          attachmentNames: names,
          description: names.length + " file(s) attached in " + APP + " (" + source + ")",
          blocked: false
        }
      });
    }

    /* -- worker bridge ------------------------------------------------------ */

    function send(message) {
      try {
        return chrome.runtime.sendMessage(message).catch(function () { return null; });
      } catch (e) {
        // Extension context invalidated (reload/update). Nothing to do but
        // stop — and say so, because a silent failure here means the guard is
        // running with no way to reach the server.
        console.warn("[CyberSentinel] extension bridge unavailable:", e && e.message);
        return Promise.resolve(null);
      }
    }

    function requestVerdict(payload) {
      return Promise.race([
        send({ type: "CSDLP_EVALUATE", payload: payload }),
        new Promise(function (resolve) {
          setTimeout(function () { resolve({ action: "timeout" }); }, VERDICT_TIMEOUT_MS);
        })
      ]);
    }

    /* -- attachment presence ------------------------------------------------ */

    /**
     * Is this tracked attachment still in the compose?
     *
     * A picked or dropped file appears as a named chip; a pasted image has no
     * filename at all and shows up as an inline <img> in the body. Both need an
     * answer, because "the user removed it" is the difference between a block
     * the user can clear and one they cannot.
     */
    function attachmentPresence(container) {
      var body = container.querySelector && container.querySelector(BODY_SELECTOR);
      var names = {};
      getAttachmentNames(container).forEach(function (n) { names[n.toLowerCase()] = 1; });
      var inlineImages = body ? body.querySelectorAll("img").length : 0;

      function named(entry) {
        return !!entry.name && !!names[entry.name.toLowerCase()];
      }

      return function (entry) {
        // Exact, when the node was bound (see captureInlineImage).
        if (entry.node) return body ? body.contains(entry.node) : entry.node.isConnected;

        // A paste can land either way: an image goes inline into the body, a
        // copied file lands as a named chip. Neither signal alone covers both,
        // and a wrong "gone" DISCARDS a finding, so either saying "present" is
        // enough.
        if (entry.source === "paste") return inlineImages > 0 || named(entry);

        if (entry.name) return named(entry);
        return inlineImages > 0;
      };
    }

    /** Inline images in the compose body that nothing has claimed yet. */
    function untrackedInlineImages(container) {
      var body = container.querySelector && container.querySelector(BODY_SELECTOR);
      if (!body) return [];
      return Array.prototype.filter.call(body.querySelectorAll("img"), function (img) {
        if (claimedInlineNodes.has(img)) return false;
        var w = img.naturalWidth || img.width || 0;
        var h = img.naturalHeight || img.height || 0;
        // Not yet loaded (0x0) counts as worth checking rather than skipping.
        if (w && h && (w < MIN_INLINE_IMAGE_PX || h < MIN_INLINE_IMAGE_PX)) return false;
        return !!(img.currentSrc || img.src);
      });
    }

    /**
     * Fetch each unclaimed inline image out of the page and put it through
     * inspection. Same-origin blob:/data: URLs are readable from the content
     * script, so a pasted screenshot can be recovered from the DOM even when the
     * paste event itself was never seen.
     */
    function inspectUntrackedInlineImages(container, key) {
      if (!key) return Promise.resolve();
      var images = untrackedInlineImages(container);
      var chain = Promise.resolve();
      images.forEach(function (img) {
        claimedInlineNodes.add(img);
        var src = img.currentSrc || img.src;
        chain = chain.then(function () {
          return fetch(src)
            .then(function (r) { return r.blob(); })
            .then(function (blob) {
              if (!blob.type.indexOf || blob.type.indexOf("image/") !== 0) return;
              console.info(
                "[CyberSentinel] Found an un-inspected inline image (" + blob.type + ", " +
                (blob.size / 1024).toFixed(0) + " KB) — inspecting it now."
              );
              var file = new File([blob], img.getAttribute("alt") || "inline image", { type: blob.type });
              var id = prescanAttachment(file, APP, key, "paste");
              if (id !== null) ocrModule.noteInlineNode(id, img);
            })
            .catch(function (err) {
              console.error(
                "[CyberSentinel] Could not read an inline image out of the page — it is UNCHECKED:",
                String(src).slice(0, 80), err
              );
            });
        });
      });
      return chain;
    }

    /**
     * Attachment chips naming a document we hold no inspection result for.
     *
     * Unlike an inline image there is no way to get the bytes back — the app has
     * already uploaded it — so this cannot be fixed by inspecting harder. It can
     * only be reported honestly, and the operator decides (Options -> "Block
     * attachments that cannot be inspected") whether an unchecked document may
     * leave.
     */
    function untrackedAttachmentNames(attachmentNames, trackedNames) {
      return attachmentNames.filter(function (name) {
        return SENSITIVE_ATTACHMENT_SHAPE.test(name) && trackedNames.indexOf(name.toLowerCase()) < 0;
      });
    }

    /* -- gathering ---------------------------------------------------------- */

    /**
     * Everything the server needs to decide, read out of the live DOM.
     *
     * Send time re-derives what is actually in the composer rather than trusting
     * what was seen arriving. That is deliberate: an app can attach a file
     * through a code path that fires no event we hear, insert an image without a
     * paste, or restore a draft that already had attachments. Every one of those
     * ends the same way — nothing tracked, nothing pending, composer scans
     * clean, attachment sent.
     */
    function gather(submitButton, containerOverride) {
      var container = containerOverride || getComposeContainer(submitButton);
      var key = containerOverride ? getComposeKey(containerOverride) : getComposeKey(submitButton);
      var bodyText = getBodyText(container);
      var subjectText = getSubjectText(container);
      var attachmentNames = getAttachmentNames(container);

      // Local findings. Under normal operation these are advisory — the server
      // decides — but they are what the fallback path runs on, and they are
      // cheap.
      var localReasons = scanText(subjectText + "\n" + bodyText).reasons.slice();
      attachmentNames.forEach(function (name) {
        localReasons = localReasons.concat(scanFilename(name).reasons);
      });

      var attachmentScan = getResultsForContainer(key, attachmentPresence(container));
      localReasons = localReasons.concat(attachmentScan.reasons);
      var pending = attachmentScan.pending.slice();

      // SAFETY NET 1 — inline images nothing has a result for. These can be
      // recovered from the DOM and inspected, so they become `pending`, which
      // holds the gesture until there is a real answer instead of letting an
      // unseen paste read as clean.
      var strayImages = untrackedInlineImages(container);
      if (strayImages.length > 0) {
        console.warn(
          "[CyberSentinel] " + strayImages.length + " image(s) here have not been inspected — " +
          "holding while they are read out of the page."
        );
        for (var i = 0; i < strayImages.length; i++) pending.push("inline image " + (i + 1));
      }

      // SAFETY NET 2 — attachment chips naming a document with no result. The
      // bytes are gone (already uploaded), so this cannot be inspected after the
      // fact; it can only be surfaced honestly.
      var trackedNames = attachmentScan.trackedNames || [];
      var strayNames = untrackedAttachmentNames(attachmentNames, trackedNames);
      var uninspected = (attachmentScan.unscanned || []).concat(strayNames);
      if (uninspected.length > 0) {
        console.warn(
          "[CyberSentinel] " + uninspected.length + " attachment(s) have NO inspection result:",
          uninspected,
          blockUninspectable()
            ? "— reported as uninspectable (policy decides)"
            : '— reported but not enforced. Turn on "Block attachments that cannot be inspected" ' +
              "in the extension's Options to stop these."
        );
      }

      localReasons = localReasons.filter(function (v, i, a) { return a.indexOf(v) === i; });

      // Makes a failed test diagnosable from the console alone. If a sensitive
      // message scans clean, this says whether the problem is that nothing was
      // read (body=0 / scoped=document -> selector drift) or that the text was
      // read and simply didn't match.
      console.info(
        "[CyberSentinel] gather: app=%s scoped=%s subject=%d chars body=%d chars attachments=%o pending=%o local=%o",
        APP,
        container === document ? "document (FALLBACK — selectors may have drifted)" : "composer",
        subjectText.length, bodyText.length, attachmentNames, pending,
        localReasons.length ? localReasons : "(clean)"
      );

      return {
        container: container,
        key: key,
        bodyText: bodyText,
        subjectText: subjectText,
        attachmentNames: attachmentNames,
        localReasons: localReasons,
        pending: pending,
        uninspected: uninspected,
        // Text the inspector recovered from each attachment, and the raw bytes
        // where it still holds them, so the server can run its own extraction,
        // hashing, EDM and fingerprint checks on the real file.
        attachments: attachmentScan.files || []
      };
    }

    function buildPayload(info, activity) {
      return {
        appId: profile.appId,
        appName: APP,
        category: profile.category,
        activity: activity,
        pageUrl: location.href,
        pageHost: location.hostname,
        subject: info.subjectText,
        text: [info.subjectText, info.bodyText].filter(Boolean).join("\n"),
        recipients: getRecipients(info.container),
        attachmentNames: info.attachmentNames,
        attachments: info.attachments,
        localReasons: info.localReasons,
        localLevel: classifyFromReasons(info.localReasons),
        uninspected: info.uninspected,
        blockUninspectable: blockUninspectable()
      };
    }

    /* -- gesture interception ----------------------------------------------- */

    function suppress(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }

    // Caches the VERDICT, not merely the fact that a button was handled. The
    // old guard let every event after the first return early WITHOUT
    // cancelling, which — since cancelling pointerdown does not suppress the
    // follow-up click — sent the blocked email anyway.
    var lastVerdict = new WeakMap();

    /**
     * Does this event belong to the gesture the previous verdict was reached
     * for?
     *
     * `pointerdown` never does: a fresh press is unambiguously a new gesture,
     * and treating it as one is what lets a second attempt — after the user has
     * removed the offending attachment — get rescanned instead of blocked from a
     * stale verdict.
     */
    function shouldReuseVerdict(prior, now, eventLabel, event) {
      if (eventLabel === "pointerdown") return false;
      if (eventLabel.indexOf("keydown") === 0) {
        // Held Enter auto-repeats keydown many times a second. Without this, a
        // blocked composer re-scanned and re-reported on every repeat, so a few
        // seconds of hold filed several duplicate blocked events. `repeat` marks
        // exactly those synthesised presses.
        if (event && event.repeat) return true;
        return now - prior.at < GESTURE_MS;
      }
      // Bounded mainly by `completed`; the clock is only a backstop for a
      // gesture whose click never arrives AND whose pointerdown was missed.
      return !prior.completed && now - prior.at < GESTURE_MAX_MS;
    }

    var bypassing = new WeakSet();   // submits this script is itself replaying
    var awaitingVerdict = new WeakSet();

    /**
     * Replay the gesture after a held submit came back clean. The full sequence
     * is dispatched, not just .click(), because an app may act on mousedown
     * rather than click.
     */
    function resumeSubmit(submitButton, viaKeyboard, target) {
      bypassing.add(submitButton);

      try {
        if (viaKeyboard && target) {
          // Replaying a click on a chat app whose Enter handler lives on the
          // textarea does nothing at all, so a keyboard-triggered submit has to
          // be replayed as a keyboard event on the element that received it.
          //
          // ONE replay, not both. Dispatching the key sequence AND the click
          // makes an app that listens to both send the message twice — the user
          // pressed Enter once and two prompts appear. The gesture is replayed
          // in the same form it arrived in.
          var keyInit = {
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true,
            ctrlKey: !!viaKeyboard.ctrlKey, metaKey: !!viaKeyboard.metaKey
          };
          target.dispatchEvent(new KeyboardEvent("keydown", keyInit));
          target.dispatchEvent(new KeyboardEvent("keypress", keyInit));
          target.dispatchEvent(new KeyboardEvent("keyup", keyInit));
          return;
        }
        var rect = submitButton.getBoundingClientRect();
        var init = {
          bubbles: true, cancelable: true, composed: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        };
        submitButton.dispatchEvent(new PointerEvent("pointerdown", init));
        submitButton.dispatchEvent(new MouseEvent("mousedown", init));
        submitButton.dispatchEvent(new PointerEvent("pointerup", init));
        submitButton.dispatchEvent(new MouseEvent("mouseup", init));
        submitButton.dispatchEvent(new MouseEvent("click", init));
      } catch (err) {
        console.warn("[CyberSentinel] Could not replay the gesture — press Send again.", err);
      } finally {
        // Cleared the instant the replay finishes rather than on a timer.
        // dispatchEvent is synchronous, so by here every replayed event has been
        // delivered; a lingering window would be a free pass in which a real
        // click — for instance if the app ignored the synthetic events and the
        // user pressed Send themselves — went out entirely unscanned and
        // unreported.
        bypassing.delete(submitButton);
      }
    }

    /**
     * Hold the gesture, get a verdict, then block or resume.
     *
     * Fails CLOSED on an unfinished inspection: an attachment that never came
     * back is never treated as clean. Fails OPEN on a transport failure the user
     * cannot act on, but only after the cached policy has had its say — see
     * resolveFallback in background.js.
     */
    function holdAndDecide(submitButton, info, activity, keyboardCtx) {
      var key = info.key;
      var container = info.container;

      awaitingVerdict.add(submitButton);
      showCheckingNotice(key, APP, info.pending.length
        ? (info.pending.length === 1 ? '"' + info.pending[0] + '"' : info.pending.length + " attachments")
        : "this " + (activity === "send" ? "message" : "submission"));

      // Recover anything in the composer that was never seen arriving — an
      // inline image from a paste we missed, a restored draft's contents — and
      // put it through inspection before deciding.
      return inspectUntrackedInlineImages(container, key)
        .then(function () {
          return info.pending.length
            ? waitForContainer(key, WAIT_FOR_SCAN_MS, attachmentPresence(container))
            : null;
        })
        .then(function () {
          // The composer can be discarded while the scan runs. Re-deriving the
          // scope from a detached submit button falls back to `document`, which
          // sweeps the entire page for attachment names and reads some other
          // thread's contenteditable — producing a block banner and a "blocked"
          // event for a message that no longer exists.
          if (!submitButton.isConnected) {
            console.info("[CyberSentinel] Composer closed while held — nothing to resume.");
            hideNotice(key);
            return null;
          }

          // Re-gather against the container captured when the gesture was
          // intercepted rather than re-scoping, for the same reason.
          var fresh = gather(submitButton, container);
          if (fresh.pending.length > 0) {
            console.warn("[CyberSentinel] Inspection did not finish in time — still held.", fresh.pending);
            showTimeoutNotice(key);
            send({
              type: "CSDLP_ACTIVITY_EVENT",
              payload: Object.assign(buildPayload(fresh, activity), {
                blocked: true, scanTimedOut: true,
                description: "Held in " + APP + " — attachment inspection did not finish in time"
              })
            });
            return null;
          }

          return requestVerdict(buildPayload(fresh, activity)).then(function (verdict) {
            return { verdict: verdict || { action: "timeout" }, info: fresh };
          });
        })
        .then(function (result) {
          if (!result) return;
          var verdict = result.verdict;
          var fresh = result.info;
          var action = verdict.action;

          if (action === "timeout") {
            // No answer at all — not even from the fallback. The user has
            // already been told this is held, so quietly doing nothing would be
            // the one misleading outcome.
            console.error("[CyberSentinel] No verdict within " + VERDICT_TIMEOUT_MS + "ms — holding.");
            showTimeoutNotice(key);
            return;
          }

          if (action === "block" && !auditMode()) {
            console.warn("[CyberSentinel] BLOCKED by " + (verdict.source || "server") + ":", verdict.reason);
            showBlockNotice(key, fresh.localReasons, verdict.reason);
            return;
          }

          if (action === "block") {
            // Audit never blocks — but this gesture was already suppressed, so
            // simply not blocking would silently drop the message while the
            // dashboard recorded it as allowed and the user believed it had
            // gone. A held gesture must always be resumed.
            console.warn("[CyberSentinel] Would have blocked (audit mode) — resuming:", verdict.reason);
          }

          hideNotice(key);
          resumeSubmit(submitButton, keyboardCtx, keyboardCtx && keyboardCtx.target);
        })
        .catch(function (err) {
          // Fail CLOSED here, unlike the synchronous path: the user has already
          // been told the submit is held, so quietly doing nothing is the one
          // outcome that would be misleading.
          console.error("[CyberSentinel] Error while holding:", err);
          showTimeoutNotice(key);
        })
        .then(function () {
          awaitingVerdict.delete(submitButton);
        });
    }

    function handleSubmitAttempt(event, submitButton, eventLabel, keyboardCtx) {
      // A submit this script is itself replaying, already cleared.
      if (bypassing.has(submitButton)) return;

      // Already held pending a verdict: cancel every further attempt rather than
      // starting a second wait that could double-send.
      if (awaitingVerdict.has(submitButton)) {
        suppress(event);
        return;
      }

      var action = cellAction(submitActivity);
      if (action === "allow") return;      // never reached — listeners aren't installed

      var now = Date.now();
      var prior = lastVerdict.get(submitButton);
      if (prior && shouldReuseVerdict(prior, now, eventLabel, event)) {
        // `click` ends the gesture. Bounding by that rather than by elapsed time
        // alone is what makes a slow press safe: with a plain 1.5s window,
        // holding the button down for two seconds put mouseup and click outside
        // it, so one send was scanned twice and reported twice.
        if (eventLabel === "click") prior.completed = true;
        if (prior.held) {
          suppress(event);
          console.warn("[CyberSentinel] (" + eventLabel + ") also cancelled — same held gesture.");
        }
        return;
      }

      var verdict = { at: now, held: false, completed: false };
      lastVerdict.set(submitButton, verdict);

      try {
        var info = gather(submitButton, null);

        // "log" is visibility only: never hold the gesture, report what
        // happened. This is what makes a matrix safe to roll out — an operator
        // can watch every GenAI prompt for a week without anyone noticing the
        // extension is there.
        if (action === "log") {
          send({
            type: "CSDLP_ACTIVITY_EVENT",
            payload: Object.assign(buildPayload(info, submitActivity), { blocked: false })
          });
          return;
        }

        // alert / block: the decision is the server's, and a server round trip
        // is asynchronous, so the gesture MUST be suppressed first and replayed
        // on allow. There is no synchronous way to be server-authoritative.
        verdict.held = true;
        suppress(event);
        holdAndDecide(submitButton, info, submitActivity, keyboardCtx).catch(function (err) {
          // Unhandled rejections here would leave awaitingVerdict set and the
          // submit button permanently dead, so the failure has to be visible.
          console.error("[CyberSentinel] Held submit failed unexpectedly:", err);
          awaitingVerdict.delete(submitButton);
          showTimeoutNotice(info.key);
        });
      } catch (err) {
        // Fail open: never let a guard bug become an unexplained inability to
        // use the application.
        console.error("[CyberSentinel] " + APP + " guard error, failing open:", err);
      }
    }

    /* -- listeners ----------------------------------------------------------- */

    // event.target is not always an Element (it can be `document` or a
    // non-Element node), and `.closest` on one of those throws — inside a
    // capture listener that aborts the whole handler before any scan runs.
    function findSubmitButton(event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return null;
      return target.closest(SUBMIT_SELECTOR);
    }

    /**
     * The submit control belonging to the composer `startElement` is in.
     *
     * Walking up until an ancestor CONTAINS a submit button, rather than scoping
     * to the body container first, is the whole point. The previous version did
     * `getComposeContainer(activeElement).querySelector(submit)`, and
     * getComposeContainer stops at the lowest ancestor holding the body — which,
     * when the caret is in the body (the only place anyone actually presses
     * Enter from) is the body's immediate wrapper. The submit button lives in
     * the footer, a sibling subtree, so the lookup returned null and the handler
     * bailed: no scan, no block, no event, message sent. It appeared to work
     * only when focus happened to be in a Subject field, whose walk stops at the
     * composer root, which made it look like intermittent selector drift.
     */
    function findSubmitButtonFor(startElement) {
      var node = startElement;
      for (var i = 0; i < 20 && node; i++) {
        if (node.querySelector) {
          var button = node.querySelector(SUBMIT_SELECTOR);
          if (button) return button;
        }
        node = node.parentElement;
      }
      return document.querySelector(SUBMIT_SELECTOR);
    }

    function installSubmitHooks() {
      // Listening on `window` with capture:true so this runs before any listener
      // attached deeper in the page (capture dispatch is outside-in by DOM
      // depth, not by registration order).
      ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
        window.addEventListener(type, function (event) {
          var submitButton = findSubmitButton(event);
          if (!submitButton) return;
          handleSubmitAttempt(event, submitButton, type, null);
        }, true);
      });

      // Keyboard-triggered submit bypasses pointer events entirely, so it needs
      // its own hook — and WHICH combination submits is a per-app fact. In
      // Gmail, Enter is a newline and Ctrl+Enter sends; in every chat UI it is
      // the other way round. A guard that watches only Ctrl+Enter never sees a
      // single ChatGPT prompt.
      window.addEventListener("keydown", function (event) {
        var isEnter = event.key === "Enter" || event.keyCode === 13;
        if (!isEnter) return;

        var mod = event.ctrlKey || event.metaKey;
        var plain = !mod && !event.shiftKey && !event.altKey && !event.isComposing;

        var wantsSubmit =
          (mod && profile.submitOnModEnter !== false) ||
          (plain && profile.submitOnEnter === true);
        if (!wantsSubmit) return;

        // Only when the caret is actually in this app's composer. Enter in a
        // search box is not a submit, and holding it would break the page.
        var active = document.activeElement;
        if (!active || !active.matches || !active.matches(BODY_SELECTOR)) return;

        var submitButton = findSubmitButtonFor(active);
        if (!submitButton) {
          console.warn(
            "[CyberSentinel] Enter pressed in a composer but no submit control was found — " +
            "this submission is NOT being checked. The selector may have drifted."
          );
          return;
        }
        handleSubmitAttempt(event, submitButton, "keydown Enter", {
          ctrlKey: event.ctrlKey, metaKey: event.metaKey, target: active
        });
      }, true);
    }

    /* -- AI response capture ------------------------------------------------- */

    /**
     * The model's reply, logged and never blocked.
     *
     * The requirement lists "AI Response" alongside the outbound verbs, and it
     * belongs in the record: what came back is half of what an investigator
     * needs when a prompt turns out to have carried customer data. But blocking
     * it is the wrong control — the data has already left by then, the reply
     * streams in token by token so there is no single moment to intercept, and
     * tearing text out of the page mid-render breaks the application for no
     * security gain. So this observes and reports.
     */
    function installResponseObserver() {
      var selector = profile.response;
      if (!selector) return;

      var seen = new WeakSet();
      var pendingTimer = null;

      function harvest() {
        var nodes = document.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (seen.has(node)) continue;
          var text = (node.innerText || node.textContent || "").trim();
          // A streaming reply fires this observer dozens of times while it is
          // still a few characters long. Waiting for it to settle is what stops
          // one answer becoming forty events.
          if (text.length < 40) continue;
          seen.add(node);
          send({
            type: "CSDLP_ACTIVITY_EVENT",
            payload: {
              appId: profile.appId, appName: APP, category: profile.category,
              activity: "ai_response",
              pageUrl: location.href, pageHost: location.hostname,
              text: text,
              description: APP + " returned a response",
              blocked: false
            }
          });
        }
      }

      var observer = new MutationObserver(function () {
        if (pendingTimer) clearTimeout(pendingTimer);
        // Debounced well past the streaming cadence so a reply is captured once,
        // complete, rather than at every intermediate length.
        pendingTimer = setTimeout(harvest, 2500);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    /* -- go ------------------------------------------------------------------ */

    // What is installed, so applyEngagement can be called repeatedly without
    // stacking duplicate listeners — which on a capture-phase submit handler
    // would mean scanning, holding and reporting the same gesture twice.
    var installed = { attach: false, submit: false, response: false };
    var guardsSubmit = false;
    var guardsAttach = false;
    var guardsResponse = false;

    /**
     * Install exactly the hooks the current policy calls for.
     *
     * Engagement is re-derived rather than fixed at load because the policy can
     * change under a page that stays open for hours. Hooks are only ever ADDED:
     * a listener that is no longer needed early-returns on the "allow" check at
     * the top of its handler, which costs nothing, whereas removing and
     * re-adding capture listeners risks losing the outside-in ordering the whole
     * interception depends on.
     */
    function applyEngagement() {
      guardsSubmit = !profile.noSubmitGuard && cellAction(submitActivity) !== "allow";
      guardsAttach = cellAction("attach") !== "allow";
      guardsResponse = profile.category === "genai" && cellAction("ai_response") !== "allow";

      if ((guardsSubmit || guardsAttach) && !installed.attach) {
        installAttachHooks();
        installed.attach = true;
      }
      if (guardsSubmit && !installed.submit) {
        installSubmitHooks();
        installed.submit = true;
      }
      if (guardsResponse && !installed.response) {
        installResponseObserver();
        installed.response = true;
      }
    }

    applyEngagement();

    /**
     * Paste `CyberSentinelDebug()` into the page console to get everything
     * needed to diagnose a miss in one shot: whether this script is live,
     * whether the composer and submit control resolve, what the guard actually
     * sees, and which policy cell decided to engage.
     */
    window.CyberSentinelDebug = function () {
      var out = {
        app: APP, appId: profile.appId, category: profile.category,
        version: chrome.runtime.getManifest().version,
        auditMode: auditMode(), blockUninspectable: blockUninspectable(),
        policyEnforced: !!currentPolicy.enforced, policyMode: currentPolicy.mode,
        cells: {
          submit: cellAction(submitActivity), attach: cellAction("attach"),
          upload: cellAction("upload"), download: cellAction("download"),
          ai_response: cellAction("ai_response")
        },
        engaged: { submit: guardsSubmit, attach: guardsAttach, response: guardsResponse }
      };

      out.composersFound = document.querySelectorAll(BODY_SELECTOR).length;
      out.namedComposerMatched = profile.namedBodySelector
        ? document.querySelectorAll(profile.namedBodySelector).length > 0
        : null;

      var submitButton = document.querySelector(SUBMIT_SELECTOR);
      out.submitFound = !!submitButton;
      out.namedSubmitMatched = profile.namedSubmitSelector
        ? !!document.querySelector(profile.namedSubmitSelector)
        : null;
      if (submitButton) {
        out.submitTag = submitButton.outerHTML.slice(0, 200);
        try {
          var info = gather(submitButton, null);
          out.gather = {
            scopedToDocument: info.container === document,
            bodyChars: info.bodyText.length,
            attachmentNames: info.attachmentNames,
            pending: info.pending,
            uninspected: info.uninspected,
            localReasons: info.localReasons,
            keyResolved: !!info.key
          };
        } catch (err) {
          out.gatherError = String(err);
        }
      } else {
        out.buttonsLookingLikeSubmit = Array.prototype.map
          .call(document.querySelectorAll('[role="button"], button'), function (el) {
            return (el.getAttribute("data-testid") || el.getAttribute("aria-label") ||
                    el.getAttribute("data-tooltip") || el.textContent || "").trim();
          })
          .filter(function (t) { return /send|submit/i.test(t); })
          .slice(0, 10);
      }

      console.log("[CyberSentinel] DIAGNOSTIC", out);
      return out;
    };

    console.info(
      "[CyberSentinel] activity guard loaded for " + APP + " (" + profile.category + ") — " +
      "submit:" + (guardsSubmit ? cellAction(submitActivity) : "not ruled") +
      " attach:" + (guardsAttach ? cellAction("attach") : "not ruled") +
      " response:" + (guardsResponse ? cellAction("ai_response") : "not ruled")
    );
  }

  window.CSDLPActivityGuard = { install: install };
})();
