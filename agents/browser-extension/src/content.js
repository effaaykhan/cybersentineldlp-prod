/*
 * CyberSentinel DLP — content script (ISOLATED world).
 *
 * Two jobs:
 *
 *   1. ARM the page-context upload interceptor. inject.js runs in the page's own
 *      JS realm and therefore has no chrome.* access, so it cannot look up which
 *      app this is or what policy says about it. This script asks the worker and
 *      posts the answer across. Until it does, inject.js is a pass-through — an
 *      unruled app costs one function call per request and nothing more.
 *
 *   2. Relay upload decisions between inject.js and the worker, and render the
 *      on-page "blocked" banner.
 *
 * This is the only piece that runs on EVERY page. It is deliberately tiny: the
 * scanner, the attachment inspector and the activity guard are registered
 * dynamically by the worker against catalogued hosts only.
 */
(function () {
  "use strict";

  function post(msg) {
    window.postMessage(Object.assign({ __csdlp: 1, dir: "toPage" }, msg), "*");
  }

  /* ── Arm the interceptor ────────────────────────────────────────────────── */

  function arm() {
    try {
      chrome.runtime
        .sendMessage({
          type: "CSDLP_RESOLVE",
          host: location.hostname,
          path: location.pathname,
          port: location.port,
          url: location.href
        })
        .then(function (res) {
          if (!res || !res.app) return;   // not a catalogued destination

          var policy = res.policy || {};
          var action = window.CSDLPPolicy
            ? window.CSDLPPolicy.actionFor(policy, res.app.category, "upload", res.app.app_id)
            : "allow";
          if (action === "allow") return;  // nothing to enforce — stay dormant

          // Only the hosts that share this app's identity need watching. The
          // full catalog would arm the interceptor against destinations this
          // page has no business talking to, which is noise, not coverage.
          var hosts = [];
          if (res.catalogHosts && res.catalogHosts.length) {
            hosts = res.catalogHosts;
          } else {
            hosts = [location.hostname];
          }

          post({
            kind: "arm",
            config: {
              hosts: hosts,
              appId: res.app.app_id,
              appName: res.app.app_name,
              category: res.app.category,
              // The fix for the old unconditional fail-open. "The DLP server was
              // slow" is not a reason to permit an upload the operator has set
              // to block; it is a perfectly good reason to permit one they only
              // wanted logged.
              failClosed: action === "block"
            }
          });
        })
        .catch(function () {});
    } catch (e) {
      // Extension context invalidated (reload/update) — nothing to arm with.
    }
  }

  arm();

  /* ── Decision relay ─────────────────────────────────────────────────────── */

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__csdlp !== 1 || d.dir !== "toContent") return;

    if (d.kind === "classify") {
      var meta = d.meta || {};
      try {
        chrome.runtime
          .sendMessage({
            type: "CSDLP_EVALUATE",
            payload: {
              appId: d.appId || null,
              appName: meta.host,
              category: null,          // filled in by the worker from the catalog
              activity: "upload",
              pageUrl: location.href,
              pageHost: location.hostname,
              text: "",
              attachments: [
                {
                  name: meta.fileName,
                  size: meta.fileSize,
                  mime: meta.mimeType,
                  // Raw bytes, so the server runs its own extraction: an upload
                  // is intercepted before any local inspection has happened, so
                  // unlike an attachment in a composer there is no OCR result to
                  // send instead.
                  b64: meta.contentB64,
                  status: "raw"
                }
              ],
              localReasons: [],
              localLevel: null
            }
          })
          .then(function (resp) {
            var dec = resp && resp.action ? resp : { action: "allow", reason: "no-decision" };
            post({
              kind: "decision", requestId: d.requestId,
              action: dec.action, level: dec.level, reason: dec.reason
            });
          })
          .catch(function () {
            // Let inject.js's own timeout decide — it knows whether this
            // activity is set to block and must fail closed.
          });
      } catch (err) {
        // Extension context invalidated. Same reasoning: say nothing and let the
        // timeout apply the failClosed policy rather than asserting "allow"
        // here, which is what the old build did unconditionally.
      }
    } else if (d.kind === "blocked") {
      showBanner(d);
    }
  });

  function showBanner(d) {
    try {
      var id = "csdlp-blocked-banner";
      if (document.getElementById(id)) return;
      var el = document.createElement("div");
      el.id = id;
      el.textContent =
        "⛔  Upload blocked — " +
        (d.reason || "this file is classified " + (d.level || "Sensitive") +
          " and may not be uploaded from this endpoint.") +
        " (CyberSentinel DLP)";
      el.style.cssText = [
        "position:fixed", "z-index:2147483647", "top:16px", "left:50%",
        "transform:translateX(-50%)", "max-width:540px", "background:#b3261e",
        "color:#fff", "font:600 13px/1.4 system-ui,-apple-system,sans-serif",
        "padding:12px 18px", "border-radius:10px",
        "box-shadow:0 10px 34px rgba(0,0,0,.35)"
      ].join(";");
      (document.body || document.documentElement).appendChild(el);
      setTimeout(function () { try { el.remove(); } catch (e) {} }, 8000);
    } catch (e) {}
  }
})();
