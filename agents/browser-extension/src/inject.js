/*
 * CyberSentinel DLP — page-context upload interceptor (MAIN world).
 *
 * Wraps XMLHttpRequest.send / window.fetch so that a request carrying a
 * File/Blob to a catalogued app is PAUSED until a decision comes back. On
 * "block" the request is aborted before any bytes reach the network; on
 * "allow"/"alert" it proceeds untouched.
 *
 * This runs in the page's own JS context because it must patch the same
 * fetch/XHR the page uses. It cannot use chrome.* APIs, so it talks to the
 * ISOLATED content script (content.js) via window.postMessage.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERED ────────────────────────────────────
 *
 * 1. THE HOST LIST IS NO LONGER HERE. It used to be a 26-entry CLOUD_HOSTS
 *    array compiled into this file, containing no AI vendor at all. It now
 *    arrives from the server's app catalog, so an operator adding a vendor gets
 *    coverage without an extension release.
 *
 * 2. IT NO LONGER ARMS ITSELF. Previously every page had its fetch and XHR
 *    patched and every cloud-host request was inspected, whether or not any
 *    policy said anything about uploads. Now the interceptor stays a pure
 *    pass-through until content.js tells it this app's upload activity is
 *    actually ruled — so on an unruled app it costs one function call per
 *    request and nothing else.
 *
 * 3. IT NO LONGER ALWAYS FAILS OPEN. The old code allowed the upload on any
 *    timeout or error, unconditionally. That is defensible for an activity the
 *    operator only wants logged, and indefensible for one they have set to
 *    block: "the DLP server was slow" is not a reason to permit an exfiltration
 *    the policy forbids. The arm message carries failClosed, set when the cell
 *    says block, and the timeout honours it.
 */
(function () {
  "use strict";

  var MAX_CLASSIFY_BYTES = 10 * 1024 * 1024; // cap content sent for classification
  var DECISION_TIMEOUT_MS = 10000;

  var pending = new Map(); // requestId -> resolve()
  var seq = 0;

  // Set by content.js once the app and its policy are known. Until then this
  // interceptor does nothing at all.
  var armed = null; // { hosts: [...], appId, appName, category, failClosed }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__csdlp !== 1) return;

    if (d.dir === "toPage" && d.kind === "arm") {
      armed = d.config || null;
      return;
    }
    if (d.dir === "toPage" && d.kind === "decision") {
      var r = pending.get(d.requestId);
      if (r) {
        pending.delete(d.requestId);
        r({ action: d.action, level: d.level, reason: d.reason });
      }
    }
  });

  /**
   * Is this URL an upload destination worth inspecting?
   *
   * Exact host or dot-suffix, never a bare substring — a substring test would
   * make "box.com" match "dropbox.attacker.example", which is how host
   * allowlists get walked around. Same rule the server's catalog uses.
   */
  function isWatchedUrl(url) {
    if (!armed || !armed.hosts || !armed.hosts.length) return false;
    try {
      var host = new URL(url, location.href).hostname.toLowerCase();
      for (var i = 0; i < armed.hosts.length; i++) {
        var p = String(armed.hosts[i]).toLowerCase().split("/")[0];
        if (host === p || host.endsWith("." + p)) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function requestDecision(meta) {
    return new Promise(function (resolve) {
      var requestId = Date.now() + "-" + (seq++);
      pending.set(requestId, resolve);
      window.postMessage(
        { __csdlp: 1, dir: "toContent", kind: "classify", requestId: requestId, meta: meta }, "*"
      );
      setTimeout(function () {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        // The honest answer when nothing came back. failClosed is set only for
        // an activity the operator has set to block — where letting the upload
        // through because the decision was slow would defeat the control.
        if (armed && armed.failClosed) {
          resolve({
            action: "block",
            reason: "no DLP decision within " + (DECISION_TIMEOUT_MS / 1000) + "s and this upload is set to block"
          });
        } else {
          resolve({ action: "allow", reason: "decision-timeout" });
        }
      }, DECISION_TIMEOUT_MS);
    });
  }

  function asFile(bytes, name, type) {
    return new File([bytes], name || "upload.bin", { type: type || "application/octet-stream" });
  }

  function collectFiles(body) {
    var files = [];
    if (body instanceof File) files.push(body);
    else if (body instanceof Blob) files.push(asFile(body, "upload.bin", body.type));
    // Resumable uploads (Google Drive, etc.) send raw bytes, not File/Blob.
    else if (body instanceof ArrayBuffer) files.push(asFile(body, "upload.bin"));
    else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
      files.push(asFile(
        body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body,
        "upload.bin"
      ));
    } else if (typeof FormData !== "undefined" && body instanceof FormData) {
      try {
        body.forEach(function (v) {
          if (v instanceof File) files.push(v);
          else if (v instanceof Blob) files.push(asFile(v, "upload.bin", v.type)); // bare Blob part
        });
      } catch (e) {}
    }
    return files;
  }

  function fileToBase64(file) {
    var slice = file.slice(0, MAX_CLASSIFY_BYTES);
    return slice.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), bin = "", chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    });
  }

  /** Strictest decision across every file in the body. */
  function decideForBody(url, body) {
    if (!armed || !isWatchedUrl(url) || body == null) return Promise.resolve({ action: "allow" });
    var files = collectFiles(body);
    // Diagnostic (page console): shows every watched request this page realm
    // sees. If an upload produces NO such line, it ran in a worker the page hook
    // cannot reach — the known limitation.
    try {
      console.debug("[CS-DLP] watched request →", new URL(url, location.href).hostname,
        "| bodyType:", body && body.constructor && body.constructor.name, "| files:", files.length);
    } catch (e) {}
    if (!files.length) return Promise.resolve({ action: "allow" });

    var worst = { action: "allow" };
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function (blocked) {
        if (blocked) return blocked; // short-circuit once a block is decided
        return fileToBase64(f).then(function (b64) {
          return requestDecision({
            host: location.hostname,
            url: String(url),
            fileName: f.name || "upload.bin",
            fileSize: f.size,
            mimeType: f.type || "application/octet-stream",
            contentB64: b64
          }).then(function (dec) {
            if (dec.action === "block") return dec;
            if (dec.action === "alert" && worst.action === "allow") worst = dec;
            return null;
          });
        });
      });
    });
    return chain.then(function (blocked) { return blocked || worst; });
  }

  function announceBlock(dec, fileName) {
    window.postMessage({
      __csdlp: 1, dir: "toContent", kind: "blocked",
      level: dec.level, reason: dec.reason, fileName: fileName
    }, "*");
  }

  /**
   * What to do when the interception machinery itself throws.
   *
   * Distinct from a decision timeout: this is a bug in our own code path, not a
   * slow server. It still respects failClosed, because a crash in the guard is
   * not a reason to permit what policy forbids — but it is logged loudly, since
   * unlike a timeout it always indicates something is actually wrong here.
   */
  function onInterceptError(err, proceed, blockFn) {
    console.error("[CS-DLP] upload interception failed:", err);
    if (armed && armed.failClosed) {
      blockFn({ reason: "DLP inspection failed and this upload is set to block" });
    } else {
      proceed();
    }
  }

  // ---- patch XMLHttpRequest ----
  var XHRopen = XMLHttpRequest.prototype.open;
  var XHRsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__csdlpUrl = url;
    return XHRopen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var url = this.__csdlpUrl || "";
    if (!armed || !isWatchedUrl(url) || body == null) return XHRsend.apply(this, arguments);
    var xhr = this, args = arguments;

    function fail(dec) {
      announceBlock(dec, "");
      // Make the page observe a failed upload without any bytes leaving.
      try { Object.defineProperty(xhr, "status", { value: 403, configurable: true }); } catch (e) {}
      try { xhr.dispatchEvent(new ProgressEvent("error")); } catch (e) {}
      try { xhr.dispatchEvent(new Event("loadend")); } catch (e) {}
    }

    decideForBody(url, body).then(function (dec) {
      if (dec.action === "block") fail(dec);
      else XHRsend.apply(xhr, args);
    }, function (err) {
      onInterceptError(err, function () { XHRsend.apply(xhr, args); }, fail);
    });
  };

  // ---- patch fetch ----
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      var body = init && init.body;
      if (!armed || !isWatchedUrl(url) || body == null) return origFetch.apply(this, arguments);

      return decideForBody(url, body).then(function (dec) {
        if (dec.action === "block") {
          announceBlock(dec, "");
          return new Response("", { status: 403, statusText: "Blocked by CyberSentinel DLP" });
        }
        return origFetch.call(window, input, init);
      }, function (err) {
        return new Promise(function (resolve) {
          onInterceptError(
            err,
            function () { resolve(origFetch.call(window, input, init)); },
            function (dec) {
              announceBlock(dec, "");
              resolve(new Response("", { status: 403, statusText: "Blocked by CyberSentinel DLP" }));
            }
          );
        });
      });
    };
  }
})();
