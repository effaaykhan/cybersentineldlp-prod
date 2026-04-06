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

Exit codes:
    0 = success (output file written, "REDACTED: M/T frames masked" on stdout)
    1 = bad arguments
    2 = cannot open input
    3 = cannot create writer
    4 = OCR / processing error
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback

try:
    import cv2
except ImportError as e:
    print(f"ERROR: opencv-python not installed: {e}", file=sys.stderr)
    sys.exit(4)

try:
    import pytesseract
    from pytesseract import Output
except ImportError as e:
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
MIN_CONF = 35

# Padding (pixels) added around each masked rectangle.
MASK_PAD = 4


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


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input> <output>", file=sys.stderr)
        return 1

    inp = sys.argv[1]
    out = sys.argv[2]

    if not os.path.isfile(inp):
        print(f"ERROR: input not found: {inp}", file=sys.stderr)
        return 2

    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        print(f"ERROR: cannot open {inp}", file=sys.stderr)
        return 2

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    if width <= 0 or height <= 0:
        print(f"ERROR: invalid frame size {width}x{height}", file=sys.stderr)
        cap.release()
        return 2

    # Write the masked frames to a temp silent file first; we'll mux audio
    # from the original at the end if ffmpeg is available.
    tmp_dir = tempfile.gettempdir()
    silent_path = os.path.join(tmp_dir, f"dlp_silent_{os.getpid()}.mp4")

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(silent_path, fourcc, fps, (width, height))
    if not writer.isOpened():
        print(f"ERROR: cannot open VideoWriter for {silent_path}", file=sys.stderr)
        cap.release()
        return 3

    # Sample every Nth frame for OCR — between samples, reuse the regions
    # from the most recent OCR. ~2 OCR passes per second.
    sample_interval = max(1, int(round(fps / 2.0)))

    current_regions = []
    frame_idx = 0
    masked_frames = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break

            if frame_idx % sample_interval == 0:
                try:
                    current_regions = find_sensitive_regions(frame)
                except Exception:
                    traceback.print_exc(file=sys.stderr)
                    current_regions = []

            if current_regions:
                apply_mask(frame, current_regions)
                masked_frames += 1

            writer.write(frame)
            frame_idx += 1

    finally:
        cap.release()
        writer.release()

    # Try to preserve audio via ffmpeg.
    if has_ffmpeg() and mux_audio(silent_path, inp, out):
        try:
            os.remove(silent_path)
        except OSError:
            pass
    else:
        # No ffmpeg or mux failed — copy the silent file to the output path.
        try:
            shutil.move(silent_path, out)
        except Exception as e:
            print(f"ERROR: failed to move silent output to {out}: {e}", file=sys.stderr)
            return 4

    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        print("ERROR: output not produced", file=sys.stderr)
        return 4

    # The C++ side parses this line.
    print(f"REDACTED: {masked_frames}/{frame_idx} frames masked")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(4)
