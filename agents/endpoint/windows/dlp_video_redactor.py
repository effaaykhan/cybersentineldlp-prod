#!/usr/bin/env python3
"""
CyberSentinel DLP — Post-recording video redactor.

Invoked by the Windows agent's VideoRedactor module after a screen-recording
tool has finished writing a file. Reads the input video frame-by-frame, OCRs
sampled frames with Tesseract to find sensitive regions, and writes a new
video with opaque black rectangles drawn over those regions on every frame
in the sampling window. Audio from the original is muxed back via ffmpeg
when ffmpeg is available on PATH.

Usage:
    python dlp_video_redactor.py <input_video> <output_video>
    python dlp_video_redactor.py --selftest

Exit codes:
    0 = success (output file written, "REDACTED: M/T frames masked" on stdout)
    1 = bad arguments
    2 = cannot open input
    3 = cannot create writer
    4 = OCR / processing error

Diagnostics:
    Every invocation appends a detailed log to
    %PROGRAMDATA%\\CyberSentinel\\logs\\video_redactor.log
    Use --selftest to verify Python + OpenCV + pytesseract + tesseract.exe
    are all reachable.
"""

import datetime
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback


# ─── File logging ────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
                       "CyberSentinel", "logs")
LOG_PATH = os.path.join(LOG_DIR, "video_redactor.log")

def _log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] [pid={os.getpid()}] {msg}\n"
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    # Mirror to stderr so the C++ side captures it too.
    try:
        print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass

try:
    import cv2
except ImportError as e:
    _log(f"FATAL: opencv-python not installed: {e}")
    print(f"ERROR: opencv-python not installed: {e}", file=sys.stderr)
    sys.exit(4)

try:
    import pytesseract
    from pytesseract import Output
except ImportError as e:
    _log(f"FATAL: pytesseract not installed: {e}")
    print(f"ERROR: pytesseract not installed: {e}", file=sys.stderr)
    sys.exit(4)


# ─── Tesseract executable discovery ──────────────────────────────────────
# pytesseract calls `tesseract` from PATH by default. On Windows, the
# Chocolatey installer drops it under Program Files\Tesseract-OCR which is
# not always on the agent's PATH (the agent inherits its env from the
# scheduled task). Try common install locations explicitly.
def _find_tesseract():
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        r"C:\ProgramData\chocolatey\bin\tesseract.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


_tess = _find_tesseract()
if _tess:
    pytesseract.pytesseract.tesseract_cmd = _tess
    _log(f"Using tesseract.exe: {_tess}")
else:
    _log("WARN: tesseract.exe not found in any standard location — relying on PATH")


# ─── Sensitive-data patterns (mirrors agent.cpp + screen_recording_monitor) ──
PATTERNS = [
    ("AADHAAR",     re.compile(r'\b\d{4}[\s-]\d{4}[\s-]\d{4}\b')),
    ("PAN",         re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b')),
    ("CREDIT_CARD", re.compile(r'\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b')),
    ("SSN",         re.compile(r'\b\d{3}-\d{2}-\d{4}\b')),
    ("PRIVATE_KEY", re.compile(r'-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----')),
    ("AWS_KEY",     re.compile(r'AKIA[0-9A-Z]{16}')),
    ("IFSC",        re.compile(r'\b[A-Z]{4}0[A-Z0-9]{6}\b')),
    ("PHONE_IN",    re.compile(r'\b[6-9]\d{9}\b')),
    ("EMAIL",       re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')),
]

# OCR confidence floor — ignore words below this.
# Tesseract is conservative; 20 catches more matches with acceptable noise.
MIN_CONF = 20

# Padding (pixels) added around each masked rectangle.
MASK_PAD = 6

# Sample rate divisor: how many OCR passes per second of video. 4 means
# OCR every fps/4 frames (~250ms apart). Higher = more accurate but slower.
SAMPLES_PER_SECOND = 4


def find_sensitive_regions(frame):
    """Run Tesseract on a single frame, return list of (l, t, r, b) rects in
    image pixel coordinates that cover sensitive matches."""
    if frame is None:
        return []

    # Convert to grayscale for slightly faster, more reliable OCR.
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # --psm 6 = assume uniform block of text. Best general default for
    # screen content (terminals, editors, browsers).
    try:
        data = pytesseract.image_to_data(
            gray,
            output_type=Output.DICT,
            config="--psm 6 -l eng",
        )
    except Exception as e:
        print(f"OCR failed on frame: {e}", file=sys.stderr)
        return []

    n = len(data["text"])
    # Group OCR words by (block, par, line) into logical lines.
    lines = {}
    for i in range(n):
        try:
            conf = int(float(data["conf"][i]))
        except (TypeError, ValueError):
            conf = -1
        if conf < MIN_CONF:
            continue
        text = (data["text"][i] or "").strip()
        if not text:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append({
            "text":   text,
            "left":   int(data["left"][i]),
            "top":    int(data["top"][i]),
            "width":  int(data["width"][i]),
            "height": int(data["height"][i]),
        })

    regions = []
    for words in lines.values():
        # Build the line text and remember each word's char offset within it.
        line_text = ""
        offsets = []
        for w in words:
            offsets.append(len(line_text))
            line_text += w["text"]
            line_text += " "
        line_text = line_text.rstrip()

        for name, rx in PATTERNS:
            for m in rx.finditer(line_text):
                m_start, m_end = m.start(), m.end()
                # Find every word that overlaps the match's char range and
                # union their bounding boxes.
                left = top = float("inf")
                right = bottom = float("-inf")
                hit = False
                for i, w in enumerate(words):
                    w_start = offsets[i]
                    w_end = w_start + len(w["text"])
                    if w_start < m_end and w_end > m_start:
                        left = min(left, w["left"])
                        top = min(top, w["top"])
                        right = max(right, w["left"] + w["width"])
                        bottom = max(bottom, w["top"] + w["height"])
                        hit = True
                if hit:
                    l = max(0, int(left)   - MASK_PAD)
                    t = max(0, int(top)    - MASK_PAD)
                    r = int(right)  + MASK_PAD
                    b = int(bottom) + MASK_PAD
                    regions.append((l, t, r, b, name))
    return regions


def apply_mask(frame, regions):
    """Draw opaque black filled rectangles on every region. In-place."""
    if not regions or frame is None:
        return frame
    h, w = frame.shape[:2]
    for (l, t, r, b, _name) in regions:
        l2 = max(0, min(w, l))
        t2 = max(0, min(h, t))
        r2 = max(0, min(w, r))
        b2 = max(0, min(h, b))
        if r2 > l2 and b2 > t2:
            cv2.rectangle(frame, (l2, t2), (r2, b2), (0, 0, 0), thickness=-1)
            # Subtle red outline so the user can see redactions clearly.
            cv2.rectangle(frame, (l2, t2), (r2, b2), (30, 30, 220), thickness=2)
    return frame


def has_ffmpeg():
    return shutil.which("ffmpeg") is not None


def mux_audio(silent_video, original_video, output_video):
    """Use ffmpeg to copy the masked video stream and the original audio
    stream into the final output. Returns True on success."""
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", silent_video,
                "-i", original_video,
                "-map", "0:v:0",
                "-map", "1:a:0?",
                "-c:v", "copy",
                "-c:a", "aac",
                "-shortest",
                output_video,
            ],
            check=True,
            capture_output=True,
            timeout=900,
        )
        return os.path.isfile(output_video) and os.path.getsize(output_video) > 0
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError) as e:
        print(f"ffmpeg mux failed: {e}", file=sys.stderr)
        return False


def selftest():
    """Diagnostic — verify every dependency is reachable. Run this manually
    if redactions aren't happening."""
    print("=" * 60)
    print("CyberSentinel DLP Video Redactor — self-test")
    print("=" * 60)
    print(f"Python:           {sys.version.split()[0]} ({sys.executable})")
    print(f"Log file:         {LOG_PATH}")
    print(f"OpenCV version:   {cv2.__version__}")
    print(f"pytesseract:      {pytesseract.__version__}")
    print(f"Tesseract cmd:    {pytesseract.pytesseract.tesseract_cmd}")
    try:
        v = pytesseract.get_tesseract_version()
        print(f"Tesseract ver:    {v}")
    except Exception as e:
        print(f"Tesseract ver:    ERROR — {e}")
        print()
        print("FAIL: Tesseract is not installed or not on PATH.")
        print("      Run: choco install tesseract -y")
        return 4
    print(f"ffmpeg on PATH:   {has_ffmpeg()}")

    # Synthetic OCR test — create a 600x300 white image with sensitive text.
    import numpy as np
    img = np.full((300, 600, 3), 255, dtype=np.uint8)
    cv2.putText(img, "Aadhaar: 1234 5678 9012", (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.putText(img, "Email: test@example.com", (10, 120),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.putText(img, "Normal sentence here.", (10, 180),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)

    regions = find_sensitive_regions(img)
    print(f"Synthetic OCR:    {len(regions)} sensitive region(s) detected")
    for r in regions:
        print(f"   - {r[4]} at ({r[0]},{r[1]})-({r[2]},{r[3]})")

    if not regions:
        print()
        print("FAIL: OCR ran but found no sensitive regions in the synthetic image.")
        print("      Tesseract is installed but the regex patterns aren't matching.")
        return 4

    print()
    print("PASS — all dependencies are reachable and OCR is matching.")
    return 0


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        return selftest()

    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input> <output>", file=sys.stderr)
        print(f"       {sys.argv[0]} --selftest", file=sys.stderr)
        return 1

    inp = sys.argv[1]
    out = sys.argv[2]

    _log(f"START: input={inp} output={out}")

    if not os.path.isfile(inp):
        _log(f"FATAL: input not found: {inp}")
        print(f"ERROR: input not found: {inp}", file=sys.stderr)
        return 2

    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        _log(f"FATAL: cannot open input {inp}")
        print(f"ERROR: cannot open {inp}", file=sys.stderr)
        return 2

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    _log(f"Video: {width}x{height} @ {fps:.1f} fps, {total_frames} frames")

    if width <= 0 or height <= 0:
        _log(f"FATAL: invalid frame size {width}x{height}")
        print(f"ERROR: invalid frame size {width}x{height}", file=sys.stderr)
        cap.release()
        return 2

    # Verify Tesseract is callable BEFORE we waste time decoding the video.
    try:
        tv = pytesseract.get_tesseract_version()
        _log(f"Tesseract version: {tv}")
    except Exception as e:
        _log(f"FATAL: tesseract not callable: {e}")
        print(f"ERROR: tesseract not available: {e}", file=sys.stderr)
        cap.release()
        return 4

    tmp_dir = tempfile.gettempdir()
    silent_path = os.path.join(tmp_dir, f"dlp_silent_{os.getpid()}.mp4")

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(silent_path, fourcc, fps, (width, height))
    if not writer.isOpened():
        _log(f"FATAL: VideoWriter open failed for {silent_path}")
        print(f"ERROR: cannot open VideoWriter for {silent_path}", file=sys.stderr)
        cap.release()
        return 3

    sample_interval = max(1, int(round(fps / SAMPLES_PER_SECOND)))
    _log(f"Sampling every {sample_interval} frames "
         f"(~{SAMPLES_PER_SECOND} OCR passes per video second)")

    current_regions = []
    frame_idx = 0
    masked_frames = 0
    sample_count = 0
    total_regions_seen = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break

            if frame_idx % sample_interval == 0:
                sample_count += 1
                try:
                    current_regions = find_sensitive_regions(frame)
                    if current_regions:
                        total_regions_seen += len(current_regions)
                        labels = ",".join(r[4] for r in current_regions)
                        _log(f"frame {frame_idx}: {len(current_regions)} region(s) [{labels}]")
                except Exception:
                    _log(f"frame {frame_idx}: OCR exception\n{traceback.format_exc()}")
                    current_regions = []

            if current_regions:
                apply_mask(frame, current_regions)
                masked_frames += 1

            writer.write(frame)
            frame_idx += 1

    finally:
        cap.release()
        writer.release()

    _log(f"Decode complete: {frame_idx} frames processed, "
         f"{sample_count} OCR samples, {total_regions_seen} total regions, "
         f"{masked_frames} frames masked")

    # Try to preserve audio via ffmpeg.
    if has_ffmpeg():
        _log("ffmpeg present — muxing audio")
        if mux_audio(silent_path, inp, out):
            try: os.remove(silent_path)
            except OSError: pass
            _log(f"ffmpeg mux OK → {out}")
        else:
            _log("ffmpeg mux failed — falling back to silent output")
            try:
                shutil.move(silent_path, out)
            except Exception as e:
                _log(f"FATAL: move silent → out failed: {e}")
                print(f"ERROR: failed to move silent output to {out}: {e}", file=sys.stderr)
                return 4
    else:
        _log("ffmpeg not on PATH — output will be silent")
        try:
            shutil.move(silent_path, out)
        except Exception as e:
            _log(f"FATAL: move silent → out failed: {e}")
            print(f"ERROR: failed to move silent output to {out}: {e}", file=sys.stderr)
            return 4

    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        _log("FATAL: output not produced")
        print("ERROR: output not produced", file=sys.stderr)
        return 4

    out_sz = os.path.getsize(out)
    _log(f"DONE: {out} ({out_sz} bytes), masked {masked_frames}/{frame_idx} frames")

    # The C++ side parses this line.
    print(f"REDACTED: {masked_frames}/{frame_idx} frames masked")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        _log(f"UNCAUGHT EXCEPTION:\n{traceback.format_exc()}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(4)
