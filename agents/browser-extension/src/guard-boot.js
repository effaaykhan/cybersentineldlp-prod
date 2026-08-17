/*
 * CyberSentinel DLP — activity guard bootstrap.
 *
 * Runs on every catalogued host. Asks the service worker two questions — "what
 * app is this?" and "what does policy say about it?" — and installs the guard
 * with the answers.
 *
 * WHY THE WORKER IS ASKED RATHER THAN THE BUNDLED CATALOG: the catalog is a
 * server-side table so that adding a GenAI vendor is an insert rather than an
 * extension release. The copy compiled into catalog.js is a seed and an offline
 * fallback; asking the worker is what makes an operator's edit this morning take
 * effect on this page load. The fallback still matters — a worker that was torn
 * down mid-navigation must not leave the page unguarded — so a failed lookup
 * degrades to the bundled list rather than to nothing.
 *
 * This file is deliberately the only content script that runs eagerly on a
 * catalogued page. Everything expensive (the scanner, the attachment inspector,
 * the guard itself) is loaded alongside it by the worker's dynamic registration,
 * which is scoped to catalogued hosts — so an ordinary page pays nothing.
 */
(function () {
  "use strict";

  // Frames are guarded too — a compose window or a chat widget in an iframe is
  // the same activity — but a 1x1 tracking iframe is not worth the work.
  if (window.top !== window.self) {
    if (window.innerWidth < 200 || window.innerHeight < 200) return;
  }

  var installed = false;

  function fallbackApp() {
    if (!window.CSDLPCatalog) return null;
    return window.CSDLPCatalog.resolve(location.hostname, location.pathname, location.port);
  }

  function start(app, policy) {
    if (installed || !app) return;
    if (!window.CSDLPProfiles || !window.CSDLPActivityGuard) {
      console.error(
        "[CyberSentinel] guard modules missing on " + location.hostname +
        " — profiles.js / activity-guard.js did not load. Nothing is being checked on this page."
      );
      return;
    }
    var profile = window.CSDLPProfiles.forApp(app);
    if (!profile) return;
    installed = true;
    window.CSDLPActivityGuard.install(profile, policy);
  }

  function boot() {
    var request = {
      type: "CSDLP_RESOLVE",
      host: location.hostname,
      path: location.pathname,
      port: location.port,
      url: location.href
    };

    var answered = false;
    try {
      chrome.runtime.sendMessage(request).then(
        function (res) {
          answered = true;
          if (res && res.app) {
            start(res.app, res.policy);
          } else {
            // The worker answered and said this host is not catalogued. Trust
            // it — the server catalog is the authority, and an operator who
            // disabled an entry expects it to stop being guarded.
            console.debug("[CyberSentinel] " + location.hostname + " is not a catalogued app.");
          }
        },
        function () {
          if (!answered) start(fallbackApp(), null);
        }
      );
    } catch (e) {
      start(fallbackApp(), null);
      return;
    }

    // A torn-down MV3 worker can leave sendMessage pending indefinitely rather
    // than rejecting. Without this the page would sit unguarded with no error
    // anywhere — the exact silent failure mode this codebase keeps being bitten
    // by — so fall back on a timer as well as on rejection.
    setTimeout(function () {
      if (!answered && !installed) {
        console.warn(
          "[CyberSentinel] service worker did not answer — using the bundled catalog. " +
          "Policy is unknown, so only locally-detectable content is enforced."
        );
        start(fallbackApp(), null);
      }
    }, 3000);
  }

  // A single-page app can swap its whole composer on navigation without a
  // document load, and several of these hosts do exactly that (Gmail, ChatGPT,
  // Slack). The guard attaches its listeners to `window` with capture, so it
  // survives that — but the boot itself must not run before there is anything
  // to guard.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
