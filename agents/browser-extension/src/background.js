/*
 * CyberSentinel DLP — background service worker (MV3).
 *
 * Owns the Native Messaging connection to the endpoint agent
 * ("com.cybersentinel.dlp"). Relays classify requests from content scripts to
 * the agent and returns the agent's allow/alert/block decision. The agent is
 * what actually calls the DLP server's /policy/evaluate and emits the
 * attempt/prevention events — the extension only enforces the decision.
 *
 * Fail-open everywhere: if the agent is missing, disconnected, or slow, the
 * upload is allowed (a DLP outage must never brick the browser). Blocks are
 * only asserted on an explicit "block" from the agent.
 */
"use strict";

const NATIVE_HOST = "com.cybersentinel.dlp";
const AGENT_TIMEOUT_MS = 7000;

let port = null;
const waiters = new Map(); // requestId -> sendResponse

function failOpenAll(reason) {
  for (const [, respond] of waiters) {
    try { respond({ action: "allow", reason }); } catch (e) {}
  }
  waiters.clear();
}

function connect() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    port.onMessage.addListener((msg) => {
      if (!msg || !msg.requestId) return;
      const respond = waiters.get(msg.requestId);
      if (respond) {
        waiters.delete(msg.requestId);
        respond({ action: msg.action || "allow", level: msg.level, reason: msg.reason });
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      failOpenAll("agent-disconnected");
    });
  } catch (e) {
    port = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.kind !== "classify") {
    // blocked-log and anything else: nothing to do here (agent logs the event).
    return false;
  }

  if (!port) connect();
  if (!port) { sendResponse({ action: "allow", reason: "agent-unavailable" }); return false; }

  waiters.set(message.requestId, sendResponse);
  try {
    port.postMessage(Object.assign({ type: "classify", requestId: message.requestId }, message.meta));
  } catch (e) {
    waiters.delete(message.requestId);
    sendResponse({ action: "allow", reason: "send-failed" });
    return false;
  }

  setTimeout(() => {
    const respond = waiters.get(message.requestId);
    if (respond) { waiters.delete(message.requestId); respond({ action: "allow", reason: "agent-timeout" }); }
  }, AGENT_TIMEOUT_MS);

  return true; // keep the message channel open for the async response
});
