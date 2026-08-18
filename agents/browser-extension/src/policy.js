/*
 * CyberSentinel DLP — web activity policy matrix (client side).
 *
 * A mirror of the server's ``_match_web_activity`` in app/api/v1/agents.py.
 * The two must agree, and they are kept apart deliberately rather than merged,
 * because they answer subtly different questions:
 *
 *   actionFor()       — "is this activity ruled at all?" Consulted BEFORE
 *                       anything is intercepted, synchronously, with no
 *                       classification available. An "allow" here means the
 *                       guard installs no listeners and the user experiences no
 *                       latency whatsoever. This is what keeps the extension
 *                       invisible on the activities nobody wrote a policy for.
 *
 *   resolveFallback() — "the server is unreachable; what now?" Applies the same
 *                       matrix to whatever the bundled scanner managed to
 *                       detect, including the sensitivity threshold the server
 *                       would normally apply. Without this the only options
 *                       when the manager is down are block-everything or
 *                       allow-everything, and both are wrong.
 *
 * Loaded as a classic script by the worker and the content scripts alike.
 */
(function (root) {
  "use strict";

  // Mirrors app/core/web_activity.ACTION_RANK. mask sits below block: it lets
  // the work continue, so a cell that says block and a cell that says mask
  // must resolve to block.
  var ACTION_RANK = { allow: 0, log: 1, alert: 2, mask: 3, block: 4 };

  // Mirrors app/core/web_activity.ACTIVITY_ACTIONS. Which actions this endpoint
  // can actually PERFORM for each activity — a file cannot be rewritten on its
  // way out, a download never passes through the extension at all, and webmail
  // splits its text across a subject and a body that one redacted string cannot
  // be put back into.
  var ACTIVITY_ACTIONS = {
    upload:      ["allow", "log", "alert", "block"],
    download:    ["allow", "log", "alert", "block"],
    attach:      ["allow", "log", "alert", "block"],
    send:        ["allow", "log", "alert", "block"],
    post:        ["allow", "log", "alert", "mask", "block"],
    ai_response: ["allow", "log", "alert", "block"]
  };

  // Activities whose content the endpoint never sees, so a threshold cannot be
  // evaluated for them.
  var ACTIVITIES_WITHOUT_CONTENT = { download: true };

  /**
   * The nearest action this activity can carry out, never weaker than asked.
   *
   * Resolves UPWARD on purpose: an operator who asked for redaction wanted the
   * data not to leave un-redacted, so where it cannot be redacted, stopping it
   * honours the intent and logging it does not. Mirrors clamp_action() on the
   * server, which is the authority; this exists for the cached-policy path,
   * where there is no server to ask.
   */
  function clampAction(activity, action) {
    var allowed = ACTIVITY_ACTIONS[activity] || Object.keys(ACTION_RANK);
    if (allowed.indexOf(action) >= 0) return action;
    var want = ACTION_RANK[action] || 0;
    var best = null;
    for (var i = 0; i < allowed.length; i++) {
      var a = allowed[i];
      if ((ACTION_RANK[a] || 0) >= want && (best === null || ACTION_RANK[a] < ACTION_RANK[best])) best = a;
    }
    if (best) return best;
    for (var j = 0; j < allowed.length; j++) {
      if (best === null || ACTION_RANK[allowed[j]] > ACTION_RANK[best]) best = allowed[j];
    }
    return best || "allow";
  }
  var LEVEL_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };

  function normAction(value, fallback) {
    var v = String(value || "").toLowerCase();
    return Object.prototype.hasOwnProperty.call(ACTION_RANK, v) ? v : (fallback || "log");
  }

  function levelRank(level) {
    return LEVEL_RANK[String(level || "").toLowerCase()] || 0;
  }

  /**
   * The per-app exception, which beats the category row.
   *
   * This is what makes "GenAI is blocked, except the Copilot we pay for"
   * expressible without splitting the estate across two policies. The MOST
   * SPECIFIC match wins, so a broad rule can be carved out by a narrow one
   * regardless of the order they happen to sit in the list.
   *
   * SPECIFICITY IS WEIGHTED, not a count of populated fields — and this must
   * stay identical to _app_override in the server's agents.py, or the offline
   * verdict and the online one diverge on exactly the exceptions an operator
   * cared enough to write. Naming an app narrows the rule to ONE destination;
   * naming a category and an activity still covers dozens. Weights: app 4,
   * activity 2, category 1.
   */
  function appOverride(policy, category, activity, appId) {
    var overrides = policy.app_overrides || policy.appOverrides || [];
    var best = null;
    var bestSpecificity = -1;

    for (var i = 0; i < overrides.length; i++) {
      var e = overrides[i];
      if (!e || typeof e !== "object") continue;

      var eApp = String(e.app_id || e.appId || "").toLowerCase();
      var eCat = e.category ? String(e.category).toLowerCase() : "";
      var eAct = e.activity ? String(e.activity).toLowerCase() : "";

      var appPinned = eApp && eApp !== "*" && eApp !== "any";
      if (appPinned && eApp !== String(appId || "").toLowerCase()) continue;
      if (eCat && eCat !== category) continue;
      if (eAct && eAct !== activity) continue;

      var specificity = (appPinned ? 4 : 0) + (eAct ? 2 : 0) + (eCat ? 1 : 0);
      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        best = e;
      }
    }
    if (!best) return null;
    return {
      action: normAction(best.action, "log"),
      minLevel: best.minLevel || policy.min_level || policy.minLevel || null
    };
  }

  function matrixCell(policy, category, activity) {
    var matrix = policy.matrix || {};
    var row = matrix[category];
    if (!row || typeof row !== "object") return null;
    var cell = row[activity];
    if (cell === undefined || cell === null) return null;
    if (typeof cell === "object") {
      return {
        action: normAction(cell.action, "log"),
        minLevel: cell.minLevel || policy.min_level || policy.minLevel || null
      };
    }
    return {
      action: normAction(cell, "log"),
      minLevel: policy.min_level || policy.minLevel || null
    };
  }

  function lookup(policy, category, activity, appId) {
    if (!policy || !policy.enforced) return null;
    return appOverride(policy, category, activity, appId) || matrixCell(policy, category, activity);
  }

  /**
   * The action this policy defines for one cell, ignoring sensitivity.
   *
   * Audit mode is applied here so a matrix rolled out in audit engages the guard
   * (and therefore produces the "would have blocked" record the operator is
   * watching for) without ever stopping anyone.
   */
  function actionFor(policy, category, activity, appId) {
    var hit = lookup(policy, category, activity, appId);
    if (!hit) return "allow";
    var action = clampAction(activity, hit.action);
    if (String(policy.mode || "enforce").toLowerCase() === "audit" && action === "block") {
      action = "alert";
    }
    return action;
  }

  /**
   * What to do when the server could not be reached.
   *
   * Decisions are server-authoritative, so this is a degraded path by design and
   * says so in the reason it returns. It applies the cached matrix to the local
   * scanner's findings, including the threshold — which is the part that cannot
   * be skipped: a cell reading "block Confidential and above" must not block an
   * ordinary message just because the manager is down.
   *
   * Uninspectable content still counts as meeting the threshold, for the same
   * reason it does server-side: a password-protected archive classifies as
   * Public, so without that rule the documented way around a threshold is to zip
   * the file with a password.
   */
  function resolveFallback(policy, category, activity, appId, localLevel, uninspectable) {
    var hit = lookup(policy, category, activity, appId);
    if (!hit) return { action: "allow", reason: "no policy covers this activity" };

    var action = clampAction(activity, hit.action);
    if (action === "allow") return { action: "allow", reason: "policy allows this activity" };

    var threshold = hit.minLevel;
    var why = "";
    if (threshold) {
      var meets = levelRank(localLevel) >= levelRank(threshold);
      if (!meets && uninspectable && policy.block_uninspectable !== false) {
        meets = true;
        why = " (content could not be inspected)";
      }
      if (!meets) {
        return {
          action: "allow",
          reason: "below the " + threshold + " threshold this policy acts on"
        };
      }
    }

    if (String(policy.mode || "enforce").toLowerCase() === "audit" && action === "block") {
      action = "alert";
    }

    return {
      action: action,
      reason:
        "DLP server unreachable — applied the cached policy to local detection" + why +
        " (" + (localLevel || "unclassified") + ")"
    };
  }

  function strongest(a, b) {
    return (ACTION_RANK[a] || 0) >= (ACTION_RANK[b] || 0) ? a : b;
  }

  root.CSDLPPolicy = {
    ACTION_RANK: ACTION_RANK,
    ACTIVITY_ACTIONS: ACTIVITY_ACTIONS,
    ACTIVITIES_WITHOUT_CONTENT: ACTIVITIES_WITHOUT_CONTENT,
    clampAction: clampAction,
    actionFor: actionFor,
    resolveFallback: resolveFallback,
    strongest: strongest,
    levelRank: levelRank
  };
})(typeof self !== "undefined" ? self : this);
