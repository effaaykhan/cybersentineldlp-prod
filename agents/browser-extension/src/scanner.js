/**
 * CyberSentinel DLP - shared email content scanner.
 *
 * Loaded before content-gmail.js / content-outlook.js in the same
 * content_scripts entry (see manifest.json), so both share this file's
 * top-level `window.CyberSentinelScanner` global -- same pattern as the
 * Linux/Windows endpoint agents' classification logic, just reimplemented
 * client-side since a browser extension has no access to a local Python
 * process.
 *
 * Detection has three independent layers:
 *   1. Keyword matching (same spirit as the endpoint agents' keyword list)
 *   2. ID-number PATTERN matching (Aadhaar / PAN / Indian passport formats)
 *   3. DOCUMENT IDENTIFICATION -- naming what a photographed document
 *      actually is (Aadhaar card, PAN card, passport, ...) from the printed
 *      boilerplate around the number rather than the number itself.
 *
 * Layers 1 and 2 run on the compose body, subject and attachment
 * filenames. All three run on text recovered from attachments (see ocr.js /
 * offscreen.js), which is what catches a photo or screenshot of an ID card
 * saved under a meaningless filename.
 *
 * Attachment text now comes from images (OCR), PDFs (embedded text, then
 * OCR of rendered pages), Word/Excel/PowerPoint and plain text. Archives
 * and unusual formats still cannot be read; those are reported as
 * *uninspected* rather than clean — see ocr.js's getResultsForContainer.
 */
(function () {
  "use strict";

  // ---- Keyword layer (same spirit as the endpoint agents' keyword list) ----
  const SENSITIVE_KEYWORDS = [
    "confidential", "restricted", "secret", "salary", "password",
    "bank account", "credit card", "internal only",
  ];

  // Attachment *filenames* that hint at a confidential document, since we
  // can't read scanned-image/PDF contents client-side (see module docstring).
  const FILENAME_KEYWORDS = [
    "passport", "aadhaar", "aadhar", "pan_card", "pancard", "pan-card",
    "id_proof", "idproof", "bank_statement", "salary_slip", "payslip",
    "driving_licence", "driving_license", "drivinglicence", "drivinglicense",
    "voter_id", "voterid", "epic_card",
    "passbook", "pass_book", "cheque", "cancelled_cheque", "bank_details",
    "account_statement", "statement",
    "confidential",
  ];

  // ---- ID-number pattern layer ----
  // PAN: 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F). India has no
  // public checksum for PAN, so format matching is the practical limit for
  // a client-side check -- same approach most DLP tools use for PAN.
  const PAN_REGEX = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;

  // Indian passport: 1 letter (excluding Q, X, Z per spec) + 7 digits.
  const PASSPORT_REGEX = /\b[A-PR-WYa-pr-wy][0-9]{7}\b/g;

  // Indian driving licence: 2-letter state code + 2-digit RTO code, then
  // either a 4-digit year plus a 7-digit serial (the current national
  // format, e.g. "MH12 2011 0012345") or an 11-digit run (older state
  // formats). Separators are optional because OCR drops them freely.
  // Used ONLY as a scoring signal for document identification, never on
  // its own — see the DOCUMENT_SIGNATURES comment below.
  const DL_REGEX = /\b[A-Z]{2}[\s-]?\d{2}[\s-]?(?:\d{4}[\s-]?\d{7}|\d{11})\b/g;

  // Voter ID (EPIC): 3 letters + 7 digits.
  const EPIC_REGEX = /\b[A-Z]{3}\d{7}\b/g;

  // IFSC: 4 bank letters, a literal 0, then 6 branch characters --
  // HDFC0001234, SBIN0000123. RBI-assigned and structurally distinctive, so
  // unlike a bare account number this is safe to treat as strong evidence on
  // its own. Case-insensitive because OCR of a passbook is rarely uniform.
  const IFSC_REGEX = /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g;

  // A LABELLED bank account number. The number alone (9-18 digits) is far
  // too generic -- invoice, order and reference numbers all look like that,
  // and matching it bare would flag ordinary business mail. Requiring the
  // "A/C No" style label right before it is what makes it specific.
  const BANK_ACCOUNT_REGEX =
    /\b(?:a\s*\/?\s*c|acc(?:ount)?)\s*(?:no|number|num|#)?\s*[:.\-]?\s*(\d[\d\s-]{7,20}\d)\b/gi;

  function hasBankAccountNumber(text) {
    BANK_ACCOUNT_REGEX.lastIndex = 0;
    let m;
    while ((m = BANK_ACCOUNT_REGEX.exec(text)) !== null) {
      const digits = (m[1] || "").replace(/[\s-]/g, "");
      if (digits.length >= 9 && digits.length <= 18) return true;
    }
    return false;
  }

  // Indian banks, for the many documents that carry the bank's name but not
  // the word "bank" in a form the markers below would catch on its own.
  const BANK_NAMES = [
    "state bank of india", "punjab national bank", "bank of baroda", "canara bank",
    "union bank of india", "bank of india", "central bank of india", "indian bank",
    "indian overseas bank", "uco bank", "bank of maharashtra", "punjab and sind bank",
    "hdfc bank", "icici bank", "axis bank", "kotak mahindra bank", "yes bank",
    "indusind bank", "idbi bank", "idfc first bank", "rbl bank", "federal bank",
    "south indian bank", "karnataka bank", "city union bank", "dcb bank", "csb bank",
    "tamilnad mercantile bank", "jammu and kashmir bank", "bandhan bank",
    "au small finance bank", "equitas small finance bank", "ujjivan small finance bank",
    "india post payments bank", "airtel payments bank", "paytm payments bank",
  ];

  // Aadhaar: any 12-digit run, optionally grouped in 4s with spaces/hyphens.
  // On its own this regex is very broad (matches lots of unrelated 12-digit
  // numbers), so every candidate is additionally verified against the real
  // Aadhaar check-digit algorithm (Verhoeff) below -- only numbers that pass
  // the checksum are actually flagged, which cuts false positives sharply
  // compared to a blind digit-count regex.
  const AADHAAR_CANDIDATE_REGEX = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

  // ---- Verhoeff checksum (the real algorithm UIDAI uses for Aadhaar) ----
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];

  function verhoeffIsValid(numStr) {
    let c = 0;
    const digits = numStr.split("").reverse().map(Number);
    for (let i = 0; i < digits.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
    }
    return c === 0;
  }

  function findAadhaarMatches(text) {
    const matches = [];
    let m;
    AADHAAR_CANDIDATE_REGEX.lastIndex = 0;
    while ((m = AADHAAR_CANDIDATE_REGEX.exec(text)) !== null) {
      const digitsOnly = m[0].replace(/[\s-]/g, "");
      if (digitsOnly.length === 12 && verhoeffIsValid(digitsOnly)) {
        matches.push(digitsOnly);
      }
    }
    return matches;
  }

  /**
   * Scan free text (email subject + body) for keywords and ID patterns.
   * Returns { matched: bool, reasons: string[] } -- reasons are short,
   * human-readable tags, not the raw sensitive value itself (an Aadhaar/PAN
   * match is reported as e.g. "pattern:Aadhaar Number", never the number).
   */
  function scanText(text) {
    if (!text) return { matched: false, reasons: [] };
    const reasons = [];
    const lower = text.toLowerCase();

    for (const kw of SENSITIVE_KEYWORDS) {
      if (lower.includes(kw)) reasons.push(`keyword:${kw}`);
    }

    PAN_REGEX.lastIndex = 0;
    if (PAN_REGEX.test(text)) reasons.push("pattern:PAN Number");

    PASSPORT_REGEX.lastIndex = 0;
    if (PASSPORT_REGEX.test(text)) reasons.push("pattern:Indian Passport Number");

    if (findAadhaarMatches(text).length > 0) reasons.push("pattern:Aadhaar Number");

    // Bank identifiers, added because typing account details into the body
    // is at least as common as attaching the passbook. Both are structurally
    // specific: IFSC has a fixed shape, and the account-number pattern
    // requires an "A/C No" style label rather than matching any long number.
    IFSC_REGEX.lastIndex = 0;
    if (IFSC_REGEX.test(text)) reasons.push("pattern:IFSC Code");
    if (hasBankAccountNumber(text)) reasons.push("pattern:Bank Account Number");

    return { matched: reasons.length > 0, reasons };
  }

  // ---- Payment-card numbers (used only by document identification) ----
  // Deliberately NOT wired into scanText(): 13-19 digit runs appear in
  // invoices, order ids and reference numbers, and adding them to the
  // body scan would change documented blocking behaviour. Inside an OCR'd
  // image, though, a Luhn-valid card number is strong evidence.
  const CARD_CANDIDATE_REGEX = /\b\d(?:[ -]?\d){12,18}\b/g;

  function luhnIsValid(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  function hasPaymentCardNumber(text) {
    CARD_CANDIDATE_REGEX.lastIndex = 0;
    let m;
    while ((m = CARD_CANDIDATE_REGEX.exec(text)) !== null) {
      const digits = m[0].replace(/[\s-]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnIsValid(digits)) return true;
    }
    return false;
  }

  // ---- Document identification ----
  //
  // Answers "what kind of document is this?" rather than merely "does this
  // contain something sensitive?", so an alert can say "Aadhaar Card"
  // instead of just "something confidential".
  //
  // This matters most where the ID *number* itself is unreadable: OCR of a
  // photographed card routinely mangles digits, which fails the Aadhaar
  // Verhoeff check and the PAN format regex. The printed boilerplate around
  // the number ("UNIQUE IDENTIFICATION AUTHORITY OF INDIA", "INCOME TAX
  // DEPARTMENT") survives OCR far more reliably than the number does, so
  // the card is still identified and still blocked.
  //
  // Scored, not first-match: several of these documents share boilerplate
  // ("GOVERNMENT OF INDIA" appears on Aadhaar, PAN and passports alike), so
  // a single shared marker must never decide the answer on its own.
  // A `decisive` marker is a phrase that essentially only appears on the
  // document itself -- "PERMANENT ACCOUNT NUMBER", "UNIQUE IDENTIFICATION
  // AUTHORITY", a passport MRZ line. One of those is enough on its own.
  //
  // WHY THIS TIER WAS ADDED: with only strong(3)/weak(1) against a
  // threshold of 4, no single marker could ever decide, so a real
  // photographed passport whose OCR recovered "PASSPORT" but mangled every
  // surrounding label scored 3 and was reported clean. Requiring two
  // independent hits is the right default for SHARED boilerplate
  // ("GOVERNMENT OF INDIA" is on Aadhaar, PAN and passports alike) -- which
  // is what strong/weak are for -- but it is the wrong bar for a phrase
  // that identifies the document by itself.
  const DECISIVE_MARKER_SCORE = 4;
  // A `title` marker names the document ("PASSPORT", "DRIVING LICENCE",
  // "AADHAAR") but is also ordinary vocabulary. In a PHOTOGRAPH it is the
  // document; in a Word file or a PDF's text layer it is just as likely to
  // be a sentence about one ("he got his driving licence renewed"). So it
  // is decisive for OCR'd images and merely strong for extracted document
  // text, which is why scanExtractedText takes a source.
  //
  // The residual false positive is a screenshot of a conversation that
  // mentions a passport. For a DLP control that is the right way round to
  // be wrong, and the reason shown to the user names the marker that fired.
  const STRONG_MARKER_SCORE = 3;
  const WEAK_MARKER_SCORE = 1;
  const NUMBER_PATTERN_SCORE = 4;
  const IDENTIFY_THRESHOLD = 4;

  /**
   * A machine-readable zone line, as printed along the bottom of every
   * passport on earth: a long run of A-Z, digits and '<' filler, e.g.
   *   P<INDKUMAR<<SHOUNAK<<<<<<<<<<<<<<<<<<<<<<<<<<
   * Nothing else in ordinary text looks like this, and unlike the Indian
   * passport number format it identifies a passport from ANY country.
   */
  function hasMrzLine(text) {
    for (const rawLine of String(text || "").split(/[\r\n]+/)) {
      const line = rawLine.trim();
      if (line.length < 18) continue;
      const fillers = (line.match(/</g) || []).length;
      if (fillers < 3) continue;
      const mrzChars = (line.match(/[A-Z0-9<]/g) || []).length;
      if (mrzChars / line.length >= 0.8) return true;
    }
    return false;
  }

  const DOCUMENT_SIGNATURES = [
    {
      type: "Aadhaar Card",
      decisive: ["unique identification authority", "uidai", "mera aadhaar meri pehchaan"],
      title: ["aadhaar", "aadhar"],
      strong: ["enrolment no", "enrollment no"],
      weak: [
        "government of india", "govt of india", "vid", "year of birth", "yob", "dob",
        "male", "female", "address", "issue date", "download date",
      ],
      hasNumber: (text) => findAadhaarMatches(text).length > 0,
    },
    {
      type: "PAN Card",
      decisive: ["permanent account number", "income tax department"],
      strong: ["pan card", "e pan"],
      weak: [
        "government of india", "govt of india", "father s name", "signature", "date of birth",
        "name", "account number card",
      ],
      hasNumber: (text) => {
        PAN_REGEX.lastIndex = 0;
        return PAN_REGEX.test(text);
      },
    },
    {
      type: "Passport",
      // The MRZ identifies a passport from any country by itself.
      decisive: ["p<ind"],
      title: ["republic of india", "passport"],
      strong: ["passeport", "pasaporte"],
      weak: [
        "place of issue", "place of birth", "date of issue", "date of expiry",
        "country code", "given name", "given names", "surname", "type", "nationality",
        "authority", "holder s signature", "sex", "date of birth", "file no",
        "old passport", "indian", "ind",
      ],
      hasNumber: (text) => {
        PASSPORT_REGEX.lastIndex = 0;
        return PASSPORT_REGEX.test(text);
      },
      hasMrz: true,
    },
    {
      type: "Driving Licence",
      decisive: [],
      title: ["driving licence", "driving license"],
      strong: ["dl no", "dlno", "transport department"],
      weak: [
        "valid till", "lmv", "mcwg", "issuing authority",
        "union of india", "authorisation to drive", "cov", "blood group", "date of first issue",
      ],
      hasNumber: (text) => {
        DL_REGEX.lastIndex = 0;
        return DL_REGEX.test(text);
      },
    },
    {
      type: "Voter ID (EPIC)",
      decisive: ["election commission of india", "elector s photo identity card", "epic no"],
      strong: [],
      weak: [
        "electoral registration officer", "assembly constituency", "part no",
        "identity card", "elector", "constituency",
      ],
      hasNumber: (text) => {
        EPIC_REGEX.lastIndex = 0;
        return EPIC_REGEX.test(text);
      },
    },
    // Bank documents are split by kind so an alert names what actually
    // leaked. They overlap freely -- a passbook page carries statement
    // columns too -- and the highest score wins.
    {
      type: "Bank Passbook",
      decisive: ["ifsc", "ifs code", "micr"],
      title: ["passbook", "pass book"],
      strong: ["customer id", "cif no", "cif number", "account statement", "statement of account"],
      weak: [
        ...BANK_NAMES,
        "bank", "branch", "branch code", "branch name", "account no", "account number",
        "a c no", "savings account", "savings bank", "sb account", "current account",
        "type of account", "nominee", "nomination", "joint holder", "account holder",
        "opening balance", "closing balance", "date of opening", "scheme", "mode of operation",
      ],
      hasNumber: (text) => {
        IFSC_REGEX.lastIndex = 0;
        return IFSC_REGEX.test(text) || hasBankAccountNumber(text);
      },
    },
    {
      type: "Bank Statement",
      decisive: ["statement of account", "account statement", "statement of transactions"],
      title: ["bank statement", "mini statement"],
      strong: ["ifsc", "ifs code", "micr", "statement period", "transaction statement"],
      weak: [
        ...BANK_NAMES,
        "bank", "branch", "account no", "account number", "a c no",
        "opening balance", "closing balance", "available balance", "balance",
        "withdrawal", "withdrawals", "deposit", "deposits", "debit", "credit",
        "narration", "particulars", "value date", "transaction date", "txn date",
        "cheque no", "chq no", "ref no", "utr", "neft", "imps", "rtgs", "upi",
      ],
      hasNumber: (text) => {
        IFSC_REGEX.lastIndex = 0;
        return IFSC_REGEX.test(text) || hasBankAccountNumber(text);
      },
    },
    {
      type: "Cheque",
      decisive: ["a c payee", "account payee", "or bearer"],
      title: ["cheque", "check leaf"],
      strong: ["ifsc", "ifs code", "micr", "valid for three months from the date of issue"],
      weak: [
        ...BANK_NAMES,
        "bank", "pay", "rupees", "date", "branch", "authorised signatory",
        "please sign above", "payable at par",
      ],
      hasNumber: (text) => {
        IFSC_REGEX.lastIndex = 0;
        return IFSC_REGEX.test(text);
      },
    },
    {
      type: "Salary Slip",
      decisive: ["salary slip", "pay slip", "payslip", "salary certificate", "earnings statement"],
      title: [],
      strong: ["gross salary", "net pay", "net salary", "ctc", "salary for the month"],
      weak: [
        "basic pay", "basic", "hra", "house rent allowance", "conveyance", "special allowance",
        "deductions", "earnings", "provident fund", "pf", "epf", "esi", "professional tax",
        "tds", "employee code", "employee id", "designation", "department", "days paid",
        "lop", "uan", "bank a c", "total deductions",
      ],
      hasNumber: null,
    },
    {
      type: "Payment Card",
      strong: ["valid thru", "valid from", "cvv", "card verification"],
      weak: ["mastercard", "visa", "rupay", "cardholder", "card holder", "debit", "credit"],
      hasNumber: hasPaymentCardNumber,
    },
  ];

  // OCR text is noisy: unpredictable case, dropped punctuation, stray
  // glyphs between words. Matching against a flattened copy means
  // "Govt. of India" and "GOVT OF INDIA," both hit the same marker.
  // "<" is kept because it carries the passport MRZ marker ("P<IND").
  function normalizeForMarkers(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9<]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Identify which kind of document some (usually OCR'd) text came from.
   * Returns { type, confidence, evidence } or null if nothing scores
   * highly enough to name -- callers should fall back to "unidentified"
   * rather than guessing.
   */
  // OCR reliably confuses a handful of glyph pairs -- I/l/1, O/0, S/5,
  // B/8, Z/2, G/6, A/4, E/3 -- so "UNIQUE IDENTIFICATION AUTHORITY OF
  // INDIA" comes back as "UNlQUE IDENTIFICATION AUTHORITY OF lNDIA" and a
  // literal comparison misses it. Both the text and the markers are folded
  // onto one representative per confusion group, so a card whose every
  // marker was mis-read still matches. Folding is used ONLY for marker
  // matching -- the ID-number regexes and the Verhoeff/Luhn checks always
  // run on the untouched text, since folding would invent digits.
  const OCR_CONFUSABLES = {
    "0": "o", "1": "l", i: "l", "5": "s", "8": "b",
    "2": "z", "6": "g", "9": "g", "4": "a", "3": "e",
  };

  function foldConfusables(value) {
    let out = "";
    for (const ch of value) out += OCR_CONFUSABLES[ch] || ch;
    return out;
  }

  // Whole-word matching, not substring: "vid" would otherwise hit inside
  // "provided" and "type" inside "typewritten", quietly inflating scores.
  // Passport MRZ fragments are the exception -- "P<IND" runs straight into
  // the surname ("P<INDKUMAR<<SHOUNAK") with no separator to anchor on --
  // so markers containing "<" match as substrings.
  function markerHit(flat, folded, marker) {
    if (marker.includes("<")) {
      return flat.includes(marker) || folded.includes(foldConfusables(marker));
    }
    return (
      ` ${flat} `.includes(` ${marker} `) ||
      ` ${folded} `.includes(` ${foldConfusables(marker)} `)
    );
  }

  /**
   * Score every signature against this text. Returned in full (not just the
   * winner) so a miss can be explained rather than guessed at -- see
   * explainDocument, which is what a "1378 characters read, nothing found"
   * result needs in order to be diagnosable at all.
   */
  function scoreDocuments(text, source) {
    const flat = normalizeForMarkers(text);
    if (!flat) return [];
    const folded = foldConfusables(flat);
    const mrz = hasMrzLine(text);
    // See DECISIVE_MARKER_SCORE: a document's own name identifies it when
    // the text came off a photograph, but not when it came out of prose.
    const titleScore = source === "image" ? DECISIVE_MARKER_SCORE : STRONG_MARKER_SCORE;

    return DOCUMENT_SIGNATURES.map((sig) => {
      const evidence = [];
      let score = 0;

      const tally = (markers, points) => {
        for (const marker of markers || []) {
          if (markerHit(flat, folded, marker)) {
            score += points;
            evidence.push(marker);
          }
        }
      };

      tally(sig.decisive, DECISIVE_MARKER_SCORE);
      tally(sig.title, titleScore);
      tally(sig.strong, STRONG_MARKER_SCORE);
      tally(sig.weak, WEAK_MARKER_SCORE);

      if (sig.hasMrz && mrz) {
        score += DECISIVE_MARKER_SCORE;
        evidence.push("machine-readable zone");
      }
      if (sig.hasNumber && sig.hasNumber(text)) {
        score += NUMBER_PATTERN_SCORE;
        evidence.push("id number format");
      }

      return { type: sig.type, score, evidence };
    });
  }

  function identifyDocument(text, source) {
    if (!text) return null;

    let best = null;
    for (const scored of scoreDocuments(text, source)) {
      if (scored.score >= IDENTIFY_THRESHOLD && (!best || scored.score > best.score)) {
        best = scored;
      }
    }

    if (!best) return null;
    return {
      type: best.type,
      confidence: best.score >= 7 ? "high" : "medium",
      evidence: best.evidence,
    };
  }

  /**
   * Why did (or didn't) this text identify as a document? Returns each
   * signature's score and the markers that actually hit, so a failure can
   * be read off directly instead of inferred. Contains only this file's own
   * constants -- never the scanned text.
   */
  function explainDocument(text, source) {
    return {
      threshold: IDENTIFY_THRESHOLD,
      source: source || "document",
      hasMrzLine: hasMrzLine(text),
      scores: scoreDocuments(text, source)
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score),
    };
  }

  /**
   * Full analysis of text extracted from an image: what's sensitive in it,
   * and what kind of document it appears to be. Used by the OCR pipeline.
   */
  function scanExtractedText(text, source) {
    const { reasons } = scanText(text);
    const doc = identifyDocument(text, source);
    const all = [...reasons];

    if (doc) {
      all.push(`document:${doc.type}`);
    } else if (reasons.length > 0) {
      // Something sensitive, but the document itself isn't recognisable --
      // say so plainly rather than inventing a type.
      all.push("document:Unidentified confidential document");
    }

    return {
      reasons: [...new Set(all)],
      documentType: doc ? doc.type : reasons.length > 0 ? "Unidentified confidential document" : null,
      confidence: doc ? doc.confidence : null,
      evidence: doc ? doc.evidence : [],
    };
  }

  /** Scan an attachment's filename only (see module docstring for why). */
  function scanFilename(name) {
    if (!name) return { matched: false, reasons: [] };
    const lower = name.toLowerCase();
    const reasons = FILENAME_KEYWORDS
      .filter((k) => lower.includes(k))
      .map((k) => `filename:${k}`);
    return { matched: reasons.length > 0, reasons };
  }

  /** Highest-severity classification implied by a set of reason tags. */
  function classifyFromReasons(reasons) {
    if (!reasons || reasons.length === 0) return "Public";
    const joined = reasons.join(" ").toLowerCase();
    if (
      joined.includes("aadhaar") ||
      joined.includes("aadhar") ||
      joined.includes("passport") ||
      joined.includes("pan number") ||
      // Identified-document tags: "document:PAN Card", "document:Voter ID
      // (EPIC)" etc. A photographed government ID is Restricted whether or
      // not its number itself came through OCR legibly.
      joined.includes("pan card") ||
      joined.includes("driving licence") ||
      joined.includes("voter id") ||
      joined.includes("payment card") ||
      joined.includes("bank document") ||
      joined.includes("bank passbook") ||
      joined.includes("bank statement") ||
      joined.includes("cheque") ||
      joined.includes("salary slip") ||
      joined.includes("ifsc") ||
      joined.includes("bank account number") ||
      joined.includes("restricted") ||
      joined.includes("bank account") ||
      joined.includes("credit card")
    ) {
      return "Restricted";
    }
    return "Confidential";
  }

  /** Pull the document type back out of a reason list, for reporting. */
  function documentTypeFromReasons(reasons) {
    if (!reasons) return null;
    const tag = reasons.find((r) => typeof r === "string" && r.startsWith("document:"));
    return tag ? tag.slice("document:".length) : null;
  }

  window.CyberSentinelScanner = {
    scanText,
    scanFilename,
    scanExtractedText,
    identifyDocument,
    explainDocument,
    classifyFromReasons,
    documentTypeFromReasons,
  };
})();
