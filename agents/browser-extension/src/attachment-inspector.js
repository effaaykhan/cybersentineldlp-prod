/**
 * CyberSentinel DLP - attachment inspection client (content script side).
 *
 * WHY THIS EXISTS: filename-only attachment scanning misses the actual case
 * that matters. A real photo of a passport/Aadhaar/PAN card with a generic
 * camera filename (IMG_20260716_143022.jpg), or a screenshot saved as
 * "Screenshot 2026-07-30 at 12.56.33.png", has no keyword to match. This
 * ships the attachment to the extension's offscreen document, which reads
 * the text inside it and feeds that through the same detection logic used
 * for the email body, plus document identification (Aadhaar / PAN /
 * passport / ...).
 *
 * ── WHY THE ENGINE ISN'T HERE ────────────────────────────────────────
 * Tesseract starts its worker by building a Blob that calls
 * importScripts(<extension URL>) and constructing a Worker from a blob:
 * URL. A blob: worker inherits the origin of the document that created it
 * -- the Gmail page -- so that importScripts() was a cross-origin request
 * to chrome-extension://, which Chrome blocks. web_accessible_resources
 * does not help: it governs fetching a resource, not the origin a worker
 * runs under. The engine lives in an offscreen document (see
 * offscreen.html / offscreen.js) and this module just ships attachments to
 * it and remembers the answers.
 *
 * ── WHAT GETS INSPECTED ──────────────────────────────────────────────
 * Images (OCR), PDFs (embedded text first, then OCR of rendered pages),
 * Word/Excel/PowerPoint, and plain text. Anything else is recorded as
 * *unscanned* rather than silently treated as clean -- see
 * getResultsForContainer, which reports that separately so the caller can
 * decide, instead of this module quietly deciding for it.
 *
 * WHY TRACKED BY COMPOSE WINDOW, NOT BY FILENAME: an image pasted directly
 * into the message body (Ctrl+V) has no filename and no attachment chip to
 * key a cache off, so filename-keyed tracking skipped pasted images
 * entirely. Attachments are tracked against the compose window they were
 * added to, which covers file picker, drag-drop and paste identically.
 *
 * WHY "PRE-SCAN AT ATTACH TIME": recognising text in a real photo takes
 * seconds. Running that when Send is clicked would freeze the UI. Instead
 * inspection starts the moment an attachment is added, while the user is
 * still writing, so the send-time check is usually a lookup of an
 * already-finished result.
 *
 * ── THE "SENT BEFORE THE SCAN FINISHED" HOLE, NOW CLOSED ─────────────
 * This module used to expose only a synchronous lookup, so attaching a
 * photo and clicking Send within a second or two beat the scan: the send
 * proceeded and a "detected after send" alert was raised once OCR
 * finished. That is a DLP tool watching confidential data leave and filing
 * a report about it. waitForContainer() now lets the send handler hold the
 * gesture until every attachment has actually been checked.
 */
(function () {
  "use strict";

  // Guarantees window.CyberSentinelOCR ends up callable no matter what
  // fails below -- an undefined export here previously crashed the whole
  // content script and disabled keyword/pattern/filename detection too.
  try {
    // Deliberate hard dependency check, not a leftover: without scanner.js
    // the offscreen host has nothing to classify findings with, and failing
    // here routes to the catch below, which installs no-op stand-ins and
    // says so loudly instead of reporting every attachment as clean.
    if (!window.CyberSentinelScanner) throw new Error("scanner.js has not loaded");

    // Chrome's message bus is not a bulk transport, and base64 inflates the
    // payload by a third. An attachment beyond this is refused loudly
    // rather than failing as an opaque messaging error.
    const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

    // Types the offscreen host can actually read. Anything else is tracked
    // as unscanned rather than assumed clean.
    const INSPECTABLE_EXTENSIONS =
      /\.(png|jpe?g|gif|bmp|webp|tiff?|pdf|docx|xlsx|pptx|docm|xlsm|txt|csv|log|json|xml|md|rtf)$/i;

    function isInspectable(file) {
      const type = (file.type || "").toLowerCase();
      if (type.startsWith("image/")) return true;
      if (type === "application/pdf") return true;
      if (type.startsWith("text/")) return true;
      if (/officedocument|msword|ms-excel|ms-powerpoint|opendocument/.test(type)) return true;
      // Chrome sometimes reports an empty MIME type for drag-dropped files.
      return INSPECTABLE_EXTENSIONS.test(file.name || "");
    }

    // NOTE ON TIMEOUTS -- deliberately none here.
    //
    // A hung inspection must not become a permanently unsendable compose,
    // but the bound has to live in the offscreen host, not in this file.
    // The host serialises every attachment through one queue, so a timer
    // started here would mostly be counting how long the attachments AHEAD
    // of this one took. Attachment three of three would "time out" without
    // having been looked at once -- and a timed-out entry reads as "could
    // not be inspected", which is allowed unless strict mode is on. That
    // turns a queue backlog into confidential documents being sent, which
    // is worse than the hang it was meant to prevent.
    //
    // The host now enforces its own per-attachment deadline and always
    // answers (see ATTACHMENT_DEADLINE_MS in offscreen.js). A host that
    // dies outright rejects the sendMessage promise, which the catch below
    // already handles.

    // Unique id -> {
    //   status: 'pending'|'done'|'error'|'skipped',
    //   reasons: string[], label, name, source, seenInCompose, settled
    // }
    const attachmentResults = new Map();
    // Compose body element -> Set of attachment ids added to it. WeakMap so
    // entries die with the compose window.
    const containerAttachments = new WeakMap();

    let nextAttachmentId = 1;

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("could not read the attached file"));
        reader.readAsDataURL(file);
      });
    }

    /**
     * Start inspection of an attachment in the background, associating the
     * result with `key` -- the compose window's message-body element, which
     * both the attach-time and the send-time lookups can resolve to. Safe to
     * call repeatedly; each call tracks a new attachment.
     *
     * `source` is 'file' | 'drop' | 'paste' and exists so the send-time
     * reconciliation can tell how to check whether an attachment is still
     * there: a picked file shows up as a named chip, a pasted image as an
     * inline <img> with no filename at all.
     *
     * Returns the tracking id, so the caller can hand back the actual DOM
     * node a pasted image became once the mail app has inserted it (see
     * noteInlineNode).
     */
    function prescanAttachment(file, provider, key, source) {
      if (!file) return null;
      if (!key) {
        console.warn("[CyberSentinel] no compose window resolved for this attachment — skipping.");
        return null;
      }

      const id = nextAttachmentId++;
      const label = file.name || "pasted/embedded attachment";
      const base = {
        reasons: [],
        label,
        name: file.name || null,
        size: file.size || 0,
        mime: file.type || "",
        text: "",
        source: source || "file",
        seenInCompose: false,
      };
      const track = (entry) => {
        attachmentResults.set(id, { ...base, ...entry });
        if (!containerAttachments.has(key)) containerAttachments.set(key, new Set());
        containerAttachments.get(key).add(id);
      };

      if (!isInspectable(file)) {
        console.warn(
          `[CyberSentinel] "${label}" (${file.type || "unknown type"}) is a type this extension cannot read — ` +
          "it is recorded as UNSCANNED, not as safe."
        );
        track({ status: "skipped", settled: Promise.resolve() });
        return id;
      }

      if (file.size > MAX_ATTACHMENT_BYTES) {
        console.error(
          `[CyberSentinel] "${label}" is ${(file.size / 1048576).toFixed(1)} MB, over the ` +
          `${MAX_ATTACHMENT_BYTES / 1048576} MB inspection limit — recorded as UNSCANNED.`
        );
        track({ status: "skipped", settled: Promise.resolve() });
        return id;
      }

      console.info(`[CyberSentinel] Inspecting "${label}" in the background (attachment id ${id})`);

      const settled = (async () => {
        try {
          const dataUrl = await readAsDataUrl(file);
          const result = await chrome.runtime.sendMessage({
            type: "CYBERSENTINEL_OCR_REQUEST",
            dataUrl,
            mimeType: file.type || "",
            name: label,
          });

          // Gone means the user removed this attachment while it was being
          // inspected. Writing the result back would resurrect a dropped
          // entry into a Map nothing can reach it through again.
          const entry = attachmentResults.get(id);
          if (!entry) return;

          if (!result || !result.ok) {
            const why = (result && result.error) || "no response from the extension's inspection host";
            console.error(
              `[CyberSentinel] Could not inspect "${label}" (attachment id ${id}) — ` +
              `recorded as UNSCANNED, not as safe: ${why}`
            );
            attachmentResults.set(id, { ...entry, status: "error", reasons: [], error: why });
            return;
          }

          const reasons = result.reasons || [];
          // The recovered text is kept on the entry so the send-time gather can
          // hand it to the server. This is the whole point of running OCR in the
          // browser: the manager has no OCR engine, so a photographed Aadhaar
          // card is invisible to its classifier unless we send it the text.
          attachmentResults.set(id, {
            ...entry,
            status: "done",
            reasons,
            text: result.extractedText || "",
            mime: entry.mime,
          });

          const summary = result.documentType
            ? `identified as ${result.documentType} (${result.confidence} confidence)`
            : "(nothing sensitive found)";
          console.info(
            `[CyberSentinel] Finished "${label}" via ${result.method} in ` +
            `${((result.elapsedMs || 0) / 1000).toFixed(1)}s — read ${result.textLength} chars — ${summary}`,
            reasons.length ? reasons : ""
          );

          // "Read 1378 characters, found nothing" is not actionable on its
          // own — it cannot distinguish "OCR returned garbage" from "the
          // text was fine and the signatures are wrong". These two lines
          // make that difference readable straight from the console.
          if (reasons.length === 0 && result.explain) {
            console.warn(
              `[CyberSentinel] Nothing matched in "${label}". Scores (need ` +
              `${result.explain.threshold} to identify), MRZ line seen: ${result.explain.hasMrzLine}:`,
              result.explain.scores.length ? result.explain.scores : "(no marker matched at all)"
            );
          }
          if (result.diagnosticText != null) {
            console.warn(
              `[CyberSentinel] DIAGNOSTIC MODE — text OCR read from "${label}". This stays in this ` +
              "browser and is never sent to the DLP server. Turn diagnostic mode off in the " +
              "extension's Options when you are done.\n" + result.diagnosticText
            );
          }
        } catch (err) {
          const why = (err && err.message) || String(err);
          console.error(
            `[CyberSentinel] Could not inspect "${label}" (attachment id ${id}) — recorded as UNSCANNED:`,
            err
          );
          const entry = attachmentResults.get(id);
          if (!entry) return; // removed mid-inspection — see above
          attachmentResults.set(id, { ...entry, status: "error", reasons: [], error: why });
        }
      })();

      track({ status: "pending", settled });
      return id;
    }

    /**
     * Bind a tracked pasted image to the actual <img> the mail app inserted
     * into the message body.
     *
     * Without this, "is that pasted image still here?" had to be answered by
     * counting <img> elements in the body -- a number every other image in
     * the compose contributes to. Replying to a thread with a quoted image,
     * or having an image signature, kept the count above zero forever, so a
     * flagged screenshot the user HAD deleted still blocked every send: the
     * banner said "remove the attachment to send" and doing so changed
     * nothing. Identity makes the question exact.
     */
    function noteInlineNode(id, node) {
      const entry = attachmentResults.get(id);
      if (!entry || !node) return;
      attachmentResults.set(id, { ...entry, node });
    }

    /**
     * Synchronous send-time lookup for every attachment tracked against this
     * compose window.
     *
     * Returns findings AND the things it could not vouch for, kept apart on
     * purpose: `pending` is "not finished yet" (worth waiting for),
     * `unscanned` is "will never have an answer". The caller decides what to
     * do about each; this module does not quietly treat either as clean,
     * which is the mistake that let an unscanned attachment read as safe.
     *
     * `isStillAttached(entry) -> boolean` reconciles what is tracked against
     * what is still in the compose. Without it, findings were permanent: the
     * block banner told the user to "remove the attachment to send", they
     * removed it, and the very same finding blocked the next attempt and
     * every one after -- the instruction the product gives was literally
     * impossible to follow, and the only escape was discarding the draft.
     *
     * An entry is only ever dropped once it has been positively SEEN in the
     * compose at least once. Otherwise a caller whose DOM lookup simply
     * cannot spot this attachment (a chip rendered in a way the selectors
     * miss) would read as "removed" and quietly discard a real finding --
     * turning a fail-closed miss into a fail-open one.
     */
    function getResultsForContainer(key, isStillAttached) {
      const ids = containerAttachments.get(key);
      if (!ids || ids.size === 0) {
        return { reasons: [], pending: [], unscanned: [], trackedNames: [], files: [] };
      }

      let reasons = [];
      const pending = [];
      const unscanned = [];
      // Names this module holds a record for, so the caller can tell an
      // attachment it has never heard of from one it has already handled.
      const trackedNames = [];
      // One record per attachment still present, carrying the text recovered
      // from it. The caller ships these to the server, which is what lets a
      // photographed document be classified by the real engine rather than by
      // this file's regex list.
      const files = [];

      for (const id of [...ids]) {
        const entry = attachmentResults.get(id);
        if (!entry) {
          ids.delete(id);
          continue;
        }

        if (isStillAttached) {
          const present = isStillAttached(entry);
          if (present) {
            entry.seenInCompose = true;
            entry.misses = 0;
          } else if (entry.seenInCompose) {
            // Two consecutive misses, not one. Dropping an entry discards
            // its findings, so a single unlucky observation -- the app
            // re-rendering the attachment row, an inline image swapped out
            // mid-upload -- must not be enough to turn a blocked send into
            // a clean one. Removal by the user persists; a re-render does
            // not.
            entry.misses = (entry.misses || 0) + 1;
            if (entry.misses >= 2) {
              console.info(`[CyberSentinel] "${entry.label}" is no longer attached — dropping its result.`);
              attachmentResults.delete(id);
              ids.delete(id);
              continue;
            }
          }
        }

        if (entry.name) trackedNames.push(entry.name.toLowerCase());

        if (entry.status === "pending") pending.push(entry.label);
        else if (entry.status === "done") reasons = reasons.concat(entry.reasons);
        else unscanned.push(entry.label);

        files.push({
          name: entry.name || entry.label,
          size: entry.size || 0,
          mime: entry.mime || "",
          text: entry.text || "",
          reasons: entry.reasons || [],
          // readable | pending | unreadable — mirrors the server's
          // extraction_status vocabulary so "uninspectable is not clean" means
          // the same thing on both sides of the wire.
          status:
            entry.status === "done" ? "readable"
              : entry.status === "pending" ? "pending"
              : "unreadable",
        });
      }

      return { reasons: [...new Set(reasons)], pending, unscanned, trackedNames, files };
    }

    /**
     * Wait for every in-flight inspection on this compose window, then
     * return the same shape getResultsForContainer does.
     *
     * The timeout is a deliberate ceiling on how long a user can be made to
     * wait for their own Send. Anything still running when it expires stays
     * in `pending`, and the caller treats it as unverified -- it is never
     * folded into "clean".
     */
    async function waitForContainer(key, timeoutMs = 45000, isStillAttached) {
      const ids = containerAttachments.get(key);
      if (!ids || ids.size === 0) return getResultsForContainer(key, isStillAttached);

      const inFlight = [];
      for (const id of ids) {
        const entry = attachmentResults.get(id);
        if (entry && entry.status === "pending" && entry.settled) inFlight.push(entry.settled);
      }
      if (inFlight.length === 0) return getResultsForContainer(key, isStillAttached);

      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      return getResultsForContainer(key, isStillAttached);
    }

    window.CyberSentinelOCR = {
      prescanAttachment,
      noteInlineNode,
      getResultsForContainer,
      waitForContainer,
    };
  } catch (err) {
    console.error(
      "[CyberSentinel] ocr.js failed to initialize -- attachment inspection " +
      "is disabled, but this will NOT affect keyword/pattern/filename " +
      "detection, which run independently. Error:", err
    );
    window.CyberSentinelOCR = {
      prescanAttachment: () => null,
      noteInlineNode: () => {},
      getResultsForContainer: () => ({ reasons: [], pending: [], unscanned: [], trackedNames: [], files: [] }),
      waitForContainer: async () => ({ reasons: [], pending: [], unscanned: [], trackedNames: [], files: [] }),
    };
  }
})();
