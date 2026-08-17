/**
 * CyberSentinel DLP - attachment inspection host (offscreen document).
 *
 * Runs Tesseract (images) and pdf.js (PDFs) in the extension's own origin
 * and returns only the *findings* -- reason tags and an identified document
 * type -- never the recognised text itself. The text of a photographed
 * Aadhaar card is exactly the data this tool exists to contain, so it stays
 * in this document and is discarded when inspection finishes.
 *
 * ── WHY OCR PRODUCED NOTHING BEFORE (the actual root cause) ───────────
 *
 * Moving Tesseract into this offscreen document fixed the *origin* problem
 * but not the *CSP* one. tesseract.js starts its worker like this
 * (tesseract.min.js, module 318):
 *
 *     new Worker(URL.createObjectURL(new Blob(['importScripts("…")'])))
 *
 * i.e. a worker whose script URL is `blob:`. An MV3 extension page's CSP is
 * `script-src 'self' 'wasm-unsafe-eval'`, and `worker-src` falls back
 * through `child-src` to `script-src` -- so `blob:` is not an allowed
 * worker source and Chrome refuses to create it. MV3 does not permit adding
 * `blob:` to extension_pages CSP either, so the CSP cannot be relaxed.
 *
 * tesseract.js exposes `workerBlobURL`, which when false constructs
 * `new Worker(workerPath)` directly. workerPath is a chrome-extension://
 * URL served by this very extension, so it is same-origin AND satisfies
 * 'self'. That single option is the difference between OCR never running
 * and OCR running.
 *
 * The visible symptom of the bug was subtle: every image "failed open", so
 * the only layer still catching attachments was the *filename* one. A file
 * called aadhaar.pdf was blocked (filename keyword) while a screenshot
 * called "Screenshot 2026-07-30 at 12.56.33.png" holding the very same card
 * sailed through -- which is exactly the reported behaviour.
 *
 * ── BEYOND IMAGES ─────────────────────────────────────────────────────
 * PDFs, Word/Excel/PowerPoint files and plain text are now inspected too,
 * so "block confidential documents" doesn't quietly mean "block confidential
 * JPEGs". PDFs get their embedded text layer read first (instant, and an
 * e-Aadhaar/salary slip is usually a text PDF); only if that finds nothing
 * are the pages rasterised and OCR'd, which is what catches a scanned card.
 */
(function () {
  "use strict";

  const TARGET = "cybersentinel-offscreen";

  // Beyond this, recognition is assumed wedged rather than slow. Tesseract
  // offers no cancellation, so the worker is torn down and rebuilt.
  const OCR_TIMEOUT_MS = 90000;

  // Tesseract wants roughly 300 DPI of *printed text*. Two failure modes
  // sit either side of that:
  //   - a phone photo is far larger, costing seconds for no accuracy gain;
  //   - a screenshot crop is far SMALLER (a cropped Aadhaar screenshot is
  //     routinely 600-900 px wide), and Tesseract's accuracy falls off a
  //     cliff below roughly 20 px of glyph height.
  // The previous version only ever shrank, never grew, so screenshots were
  // handed to Tesseract at a resolution it cannot read reliably. Both
  // bounds are enforced now.
  const MAX_IMAGE_DIMENSION = 2200;
  const MIN_IMAGE_DIMENSION = 1600;
  const MAX_UPSCALE = 3;

  // PDF work is bounded so a 200-page attachment can't wedge the host.
  const PDF_MAX_TEXT_PAGES = 25;
  const PDF_MAX_OCR_PAGES = 5;
  const PDF_RASTER_DIMENSION = 2000;

  const scanner = window.CyberSentinelScanner;
  if (!scanner) {
    console.error("[CyberSentinel] offscreen: scanner.js failed to load — findings cannot be classified.");
  }

  /* ── Tesseract worker ───────────────────────────────────────────────── */

  let workerPromise = null;

  function createWorker() {
    if (typeof Tesseract === "undefined") {
      return Promise.reject(new Error("Tesseract failed to load (ocr/tesseract.min.js missing or blocked)"));
    }
    return Tesseract.createWorker("eng", 1, {
      workerPath: chrome.runtime.getURL("ocr/worker.min.js"),
      corePath: chrome.runtime.getURL("ocr/"),
      langPath: chrome.runtime.getURL("ocr/lang-data"),
      gzip: true,
      // THE FIX. See this file's header: with the default (true) tesseract
      // builds its worker from a blob: URL, which the extension CSP refuses,
      // and every recognition attempt dies before it starts.
      workerBlobURL: false,
      logger: () => {},
      // Tesseract otherwise rejects with `undefined` on a worker-level
      // failure, which is undiagnosable. Surface whatever it gives us.
      errorHandler: (err) => console.error("[CyberSentinel] offscreen: OCR worker error:", err),
    }).then(async (worker) => {
      // Canvas-rendered input carries no DPI metadata, so Tesseract assumes
      // 70 DPI and warns/degrades. Everything reaching it here has been
      // scaled to roughly 300 DPI of printed text by prepareVariants().
      try {
        await worker.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" });
      } catch (e) {
        /* older builds may not accept these; recognition still works */
      }
      return worker;
    });
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = createWorker().catch((err) => {
        workerPromise = null; // let the next attachment retry from scratch
        throw err;
      });
    }
    return workerPromise;
  }

  async function discardWorker() {
    const pending = workerPromise;
    workerPromise = null;
    if (!pending) return;
    try {
      const worker = await pending;
      await worker.terminate();
    } catch (e) {
      /* already broken — nothing to clean up */
    }
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Recognise one already-prepared canvas. Throws on worker failure. */
  async function recognizeCanvas(canvas) {
    try {
      const worker = await getWorker();
      const { data } = await withTimeout(worker.recognize(canvas), OCR_TIMEOUT_MS, "OCR");
      return (data && data.text) || "";
    } catch (err) {
      // A wedged or dead worker poisons every later job, so rebuild it.
      await discardWorker();
      throw err;
    }
  }

  /* ── Image preparation ──────────────────────────────────────────────── */

  function decodeImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image could not be decoded"));
      img.src = dataUrl;
    });
  }

  /** Scale factor that lands the longest side inside [MIN, MAX]. */
  function scaleFor(longest) {
    if (!longest) return 1;
    if (longest > MAX_IMAGE_DIMENSION) return MAX_IMAGE_DIMENSION / longest;
    if (longest < MIN_IMAGE_DIMENSION) return Math.min(MAX_UPSCALE, MIN_IMAGE_DIMENSION / longest);
    return 1;
  }

  function drawScaled(source, width, height, scale) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // A canvas starts transparent-black, and a PNG screenshot very often
    // has an alpha channel (window captures carry transparent corners and
    // shadow). Composited straight on, those pixels read as BLACK, so dark
    // text on a transparent background becomes black on black and OCR gets
    // nothing. Painting white first is what the image would look like on
    // screen, which is what Tesseract should see.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** Rotate a canvas by a right angle, swapping dimensions for 90/270. */
  function rotateCanvas(source, degrees) {
    const swap = degrees === 90 || degrees === 270;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? source.height : source.width;
    canvas.height = swap ? source.width : source.height;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    return canvas;
  }

  /**
   * Grayscale with a contrast stretch. Screenshots of ID cards sit on
   * coloured/gradient backgrounds where the raw channels give Tesseract a
   * weak signal; collapsing to luminance and stretching to full range makes
   * the printed text separable.
   */
  function toGrayscale(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;

    let min = 255;
    let max = 0;
    const lum = new Uint8ClampedArray(px.length / 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
      lum[j] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const span = max - min || 1;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = ((lum[j] - min) * 255) / span;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas, lum };
  }

  /** Otsu's method — the standard automatic threshold for document images. */
  function otsuThreshold(lum) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < lum.length; i++) hist[lum[i]]++;

    const total = lum.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];

    let sumB = 0;
    let wB = 0;
    let best = 0;
    let threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        threshold = t;
      }
    }
    return threshold;
  }

  function binarize(sourceCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0);

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;
    const lum = new Uint8ClampedArray(px.length / 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) lum[j] = px[i];

    const t = otsuThreshold(lum);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = lum[j] > t ? 255 : 0;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /**
   * Successive renderings of the same image, cheapest-and-most-general
   * first. Each is only recognised if the previous found nothing, so a card
   * that reads cleanly costs a single pass while a difficult screenshot
   * gets harder attempts instead of a silent miss.
   *
   * The untouched original is kept as a last resort deliberately. Measured
   * on a 380px-wide Aadhaar screenshot, rescaling recovered nearly four
   * times as much text overall (233 chars vs 62) yet mangled the ID number
   * that the native-size pass happened to read correctly. Neither rendering
   * dominates the other, so the one that costs nothing in the common case
   * -- it only runs when everything else came back empty -- stays.
   */
  function prepareVariants(source, width, height) {
    const scale = scaleFor(Math.max(width, height));
    const scaled = drawScaled(source, width, height, scale);
    const { canvas: gray } = toGrayscale(scaled);

    const variants = [
      { label: "grayscale", canvas: gray },
      { label: "binarised", canvas: binarize(gray) },
    ];
    if (scale !== 1) {
      variants.push({ label: "native size", canvas: drawScaled(source, width, height, 1) });
    }

    // ROTATION. Tesseract does not detect orientation on its own (that
    // needs the OSD model, which isn't bundled), and it does not silently
    // fail on sideways text -- it returns a page of confident nonsense.
    // Measured: a passport page rotated 90 degrees produced over a thousand
    // characters and matched not one marker, which is indistinguishable
    // from "this image is harmless" unless the rotation is tried.
    //
    // Phone photos and screen captures are rotated constantly, so this is
    // the common case, not an exotic one. These only ever run when
    // everything above has already come back empty -- an upright document
    // still costs a single pass.
    variants.push(
      { label: "rotated 90", canvas: rotateCanvas(gray, 90) },
      { label: "rotated 270", canvas: rotateCanvas(gray, 270) },
      { label: "rotated 180", canvas: rotateCanvas(gray, 180) }
    );
    return variants;
  }

  /**
   * Recognise an image source, stopping as soon as a variant yields
   * something the scanner flags. Returns { text, reasons, ... }.
   */
  async function recognizeWithVariants(source, width, height) {
    const variants = prepareVariants(source, width, height);
    let bestText = "";
    let bestAnalysis = analyze("", "image");

    for (const variant of variants) {
      const text = await recognizeCanvas(variant.canvas);
      const analysis = analyze(text, "image");
      if (text.trim().length > bestText.trim().length) bestText = text;
      if (analysis.reasons.length > 0) return { text, analysis, variant: variant.label };
      if (analysis.reasons.length > bestAnalysis.reasons.length) bestAnalysis = analysis;
    }
    return { text: bestText, analysis: analyze(bestText, "image"), variant: "none-matched" };
  }

  function analyze(text, source) {
    return scanner
      ? scanner.scanExtractedText(text, source)
      : { reasons: [], documentType: null, confidence: null, evidence: [] };
  }

  /**
   * Diagnostic mode, off by default and set in the extension's Options.
   *
   * The whole design of this file is that recognised text never leaves it:
   * the text of a photographed passport is exactly the data the tool exists
   * to contain. That is right for normal operation and useless when a scan
   * comes back "read 1378 characters, nothing sensitive found" and someone
   * has to work out why. This makes the text available on the user's OWN
   * machine, in their own console, only when they deliberately turn it on.
   * It is never sent to the DLP server.
   */
  let diagnosticMode = false;
  // Guarded because this runs at load: a throw here would take down the
  // whole inspection host, and "OCR stopped working" is a far worse outcome
  // than "the diagnostic toggle is stuck off".
  try {
    chrome.storage.local.get(["diagnosticMode"]).then((stored) => {
      diagnosticMode = !!stored.diagnosticMode;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.diagnosticMode) {
        diagnosticMode = !!changes.diagnosticMode.newValue;
      }
    });
  } catch (err) {
    console.warn("[CyberSentinel] offscreen: diagnostic mode unavailable:", err);
  }

  /* ── Attachment decoding ────────────────────────────────────────────── */

  function dataUrlToBytes(dataUrl) {
    const comma = String(dataUrl || "").indexOf(",");
    if (comma < 0) throw new Error("attachment data is not a data: URL");
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* ── PDF ────────────────────────────────────────────────────────────── */

  /**
   * pdf.js is an ES module, so offscreen.html loads it with a `type="module"`
   * shim that publishes it on window. Module scripts are deferred, so this
   * may briefly be unset while a very early attachment arrives.
   */
  async function getPdfLib() {
    for (let i = 0; i < 100 && !window.pdfjsLib; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!window.pdfjsLib) throw new Error("pdf.js did not load (pdf/pdf.min.mjs missing or blocked)");
    return window.pdfjsLib;
  }

  async function extractPdf(bytes) {
    const pdfjsLib = await getPdfLib();

    let doc;
    try {
      doc = await pdfjsLib.getDocument({
        data: bytes,
        // MV3's `script-src 'self'` forbids new Function()/eval, which
        // pdf.js uses for font translation unless told not to.
        isEvalSupported: false,
        standardFontDataUrl: chrome.runtime.getURL("pdf/standard_fonts/"),
        useSystemFonts: false,
        verbosity: 0,
      }).promise;
    } catch (err) {
      const name = (err && err.name) || "";
      if (name === "PasswordException") {
        // Fail CLOSED. An encrypted PDF is precisely the shape a leaked
        // e-Aadhaar takes, and "we couldn't read it" must never resolve to
        // "therefore it's fine".
        return {
          text: "",
          analysis: {
            reasons: ["attachment:password-protected document (contents could not be checked)"],
            documentType: "Password-protected document",
            confidence: "medium",
            evidence: [],
          },
          method: "encrypted",
        };
      }
      throw err;
    }

    // Every exit below has to release the pdf.js worker's copy of the
    // document; a hundred attachments in one session otherwise accumulate
    // in an offscreen page that is never reloaded.
    try {
      // 1) Text layer. Instant, and covers e-Aadhaar, PAN allotment
      //    letters, salary slips and bank statements, which are text PDFs.
      const textPages = Math.min(doc.numPages, PDF_MAX_TEXT_PAGES);
      let text = "";
      for (let i = 1; i <= textPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item) => (item && item.str) || "").join(" ") + "\n";
        page.cleanup();
      }

      let analysis = analyze(text, "document");
      if (analysis.reasons.length > 0) {
        return { text, analysis, method: `text layer (${textPages} page(s))` };
      }

      // 2) Nothing in the text layer — either a genuinely clean document or
      //    a scan with no text at all. Rasterise and OCR to tell those
      //    apart. This is the path a photographed/scanned Aadhaar takes.
      const ocrPages = Math.min(doc.numPages, PDF_MAX_OCR_PAGES);
      let ocrText = "";
      for (let i = 1; i <= ocrPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, PDF_RASTER_DIMENSION / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale: Math.max(1, scale) });

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        page.cleanup();

        const result = await recognizeWithVariants(canvas, canvas.width, canvas.height);
        ocrText += result.text + "\n";
        if (result.analysis.reasons.length > 0) {
          return { text: ocrText, analysis: result.analysis, method: `OCR of rendered page ${i}` };
        }
      }

      // Say plainly when coverage was capped. "Nothing found" in a 60-page
      // PDF of which 5 were OCR'd is a much weaker statement than the same
      // words about a 2-page one, and the log is where that gets noticed.
      if (doc.numPages > Math.max(textPages, ocrPages)) {
        console.warn(
          `[CyberSentinel] PDF has ${doc.numPages} pages; read text from ${textPages} and OCR'd ` +
          `${ocrPages}. Pages beyond that were NOT inspected.`
        );
      }

      const combined = `${text}\n${ocrText}`;
      // Mixed provenance; the OCR half is what the image rules exist for.
      analysis = analyze(combined, ocrText.trim() ? "image" : "document");
      return {
        text: combined,
        analysis,
        method: `text layer (${textPages} page(s)) + OCR (${ocrPages} page(s))`,
      };
    } finally {
      try {
        await doc.destroy();
      } catch (e) {
        /* nothing useful to do if teardown itself fails */
      }
    }
  }

  /* ── Office documents (OOXML) and plain text ────────────────────────── */

  const ZIP_EOCD_SIG = 0x06054b50;
  const ZIP_CEN_SIG = 0x02014b50;

  /**
   * Minimal ZIP central-directory reader. OOXML files (.docx/.xlsx/.pptx)
   * are ZIPs of XML, and DecompressionStream('deflate-raw') can inflate
   * their entries natively, so no third-party library is needed.
   */
  function listZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    const scanFrom = Math.max(0, bytes.length - 66000);
    for (let i = bytes.length - 22; i >= scanFrom; i--) {
      if (view.getUint32(i, true) === ZIP_EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a ZIP-based document");

    const entryCount = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);

    const entries = [];
    for (let n = 0; n < entryCount && offset + 46 <= bytes.length; n++) {
      if (view.getUint32(offset, true) !== ZIP_CEN_SIG) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

      entries.push({ name, method, compressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function readZipEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8) throw new Error(`unsupported ZIP compression method ${entry.method}`);

    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }

  function xmlToText(xml) {
    return String(xml || "")
      // Paragraph / row / cell boundaries must not glue words together.
      .replace(/<\/(w:p|a:p|w:tr|row|si)>/g, " \n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
      .replace(/[ \t]+/g, " ");
  }

  const OOXML_TEXT_PARTS = [
    /^word\/document\.xml$/,
    /^word\/(header|footer)\d*\.xml$/,
    /^xl\/sharedStrings\.xml$/,
    /^xl\/worksheets\/sheet\d+\.xml$/,
    /^ppt\/slides\/slide\d+\.xml$/,
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/,
  ];

  async function extractOffice(bytes) {
    const entries = listZipEntries(bytes);
    const wanted = entries.filter((e) => OOXML_TEXT_PARTS.some((re) => re.test(e.name)));
    if (wanted.length === 0) throw new Error("no readable text parts in this document");

    let text = "";
    for (const entry of wanted) {
      try {
        text += xmlToText(await readZipEntry(bytes, entry)) + "\n";
      } catch (e) {
        /* one unreadable part must not lose the rest of the document */
      }
    }
    return { text, analysis: analyze(text, "document"), method: `${wanted.length} document part(s)` };
  }

  async function extractPlainText(bytes) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { text, analysis: analyze(text, "document"), method: "plain text" };
  }

  /* ── Dispatch ───────────────────────────────────────────────────────── */

  const PDF_MIME = /^application\/pdf$/i;
  const OFFICE_MIME = /officedocument|msword|ms-excel|ms-powerpoint|opendocument/i;
  const TEXT_MIME = /^text\//i;

  function kindOf(mimeType, name) {
    const mime = String(mimeType || "").toLowerCase();
    const lower = String(name || "").toLowerCase();

    if (mime.startsWith("image/")) return "image";
    if (PDF_MIME.test(mime) || lower.endsWith(".pdf")) return "pdf";
    if (OFFICE_MIME.test(mime) || /\.(docx|xlsx|pptx|docm|xlsm)$/.test(lower)) return "office";
    if (TEXT_MIME.test(mime) || /\.(txt|csv|log|json|xml|md|rtf)$/.test(lower)) return "text";
    if (/\.(png|jpe?g|gif|bmp|webp|tiff?)$/.test(lower)) return "image";
    return "unknown";
  }

  async function inspect(dataUrl, mimeType, name) {
    const startedAt = Date.now();
    const kind = kindOf(mimeType, name);

    // Decoded lazily: the image path feeds the data: URL straight to
    // Image.src, so materialising a second copy of a 20 MB photo as bytes
    // would double peak memory for no reason.
    let bytesCache = null;
    const bytes = () => {
      if (!bytesCache) bytesCache = dataUrlToBytes(dataUrl);
      return bytesCache;
    };

    try {
      let result;
      if (kind === "image") {
        const img = await decodeImage(dataUrl);
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if (!width || !height) throw new Error("image has no dimensions");
        const recognised = await recognizeWithVariants(img, width, height);
        result = {
          text: recognised.text,
          analysis: recognised.analysis,
          source: "image",
          method: `OCR (${recognised.variant}, ${width}x${height})`,
        };
      } else if (kind === "pdf") {
        result = await extractPdf(bytes());
      } else if (kind === "office") {
        result = await extractOffice(bytes());
      } else if (kind === "text") {
        result = await extractPlainText(bytes());
      } else {
        return { ok: false, error: `unsupported attachment type "${mimeType || "unknown"}"`, unsupported: true };
      }

      const analysis = result.analysis;
      const text = result.text || "";
      return {
        ok: true,
        kind,
        method: result.method,
        reasons: analysis.reasons,
        documentType: analysis.documentType,
        confidence: analysis.confidence,
        evidence: analysis.evidence,
        // Length only — never the text. See the file header.
        textLength: text.trim().length,
        // The extracted text itself, returned to the content script so it can
        // be sent to the DLP server for classification.
        //
        // THIS IS A DELIBERATE CHANGE OF POSTURE from "findings never leave this
        // document". It is what makes decisions server-authoritative: the
        // server's classification engine, ML model, EDM index and document
        // fingerprints are the product, and none of them can see a photographed
        // ID card unless the text this file recovered is sent to them. The
        // bundled regex list is a fallback for when that call cannot be made,
        // not the primary detector.
        //
        // Note what did NOT change: this text still never reaches the page, and
        // it still only reaches the console under diagnosticText below. The new
        // recipient is the manager the endpoint is already enrolled with, over
        // the same authenticated channel every other event uses.
        extractedText: text,
        // Scores and matched markers only: this file's own constants, not
        // the scanned content. Enough to see WHY nothing matched.
        explain:
          analysis.reasons.length === 0 && scanner && scanner.explainDocument
            ? scanner.explainDocument(text, result.source || "document")
            : null,
        // The recognised text itself, only when the user has explicitly
        // turned on diagnostic mode. Stays on this machine.
        diagnosticText: diagnosticMode ? text : null,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = (err && err.message) || String(err) || "unknown inspection failure";
      return { ok: false, error: message, kind };
    }
  }

  // One job at a time: overlapping recognise calls (several attachments at
  // once) would queue unpredictably inside Tesseract's own worker, and
  // several 2000px canvases in flight is a real memory spike. Chaining here
  // keeps failures attributable to the attachment that caused them.
  let queue = Promise.resolve();

  /**
   * A whole-attachment ceiling, enforced HERE rather than by the caller.
   *
   * The caller cannot do this correctly: because jobs are serialised
   * through the queue above, a wall-clock timer started when the attachment
   * was handed over mostly measures how long the attachments ahead of it
   * took, not how long this one is taking. A caller-side timeout therefore
   * fires on innocent attachments that were merely queued behind a big PDF
   * -- and since a timed-out inspection reads as "could not be checked",
   * which is allowed by default, that turned a queue backlog into
   * confidential documents being sent.
   *
   * OCR_TIMEOUT_MS bounds a single recognise() call; a 5-page PDF at up to
   * three preprocessing variants per page can legitimately make many of
   * those, so the per-call cap is not a bound on the job. This is.
   */
  const ATTACHMENT_DEADLINE_MS = 240000;

  function enqueue(dataUrl, mimeType, name) {
    const job = queue.then(() =>
      withTimeout(inspect(dataUrl, mimeType, name), ATTACHMENT_DEADLINE_MS, "Attachment inspection")
        .catch(async (err) => {
          // Whatever wedged is very likely the OCR worker; rebuild it so the
          // next attachment isn't poisoned by the same stall.
          await discardWorker();
          return { ok: false, error: (err && err.message) || String(err) };
        })
    );
    queue = job.catch(() => {}); // keep the chain alive regardless of outcome
    return job;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // The service worker and this document share the message bus; ignore
    // anything not explicitly addressed here.
    if (!message || message.target !== TARGET) return false;

    if (message.type === "OCR_RUN") {
      enqueue(message.dataUrl, message.mimeType, message.name).then(sendResponse);
      return true;
    }
    return false;
  });

  console.info("[CyberSentinel] offscreen attachment-inspection host ready");
})();
