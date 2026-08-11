"""
Build-time helper: compile the FastAPI *framework layer* to native .so modules.

This is the second half of the two-compiler build. ``compile_app.py`` (Cython)
handles the ~92 engine/service modules; this script (Nuitka) handles the ~29
files Cython cannot touch:

    app/main.py, app/core/security.py, app/api/**/*.py

Those declare route handlers whose parameters default to FastAPI markers
(``= Depends(...)`` / ``= Query(...)`` / ``= Body(...)``). Cython 3 mis-handles
such defaults ("TypeError: Expected unicode, got Depends"), which is why the
framework layer used to ship as readable .py. Nuitka compiles Python-as-Python
and has no such limitation, so with this pass the published image contains NO
readable backend source at all — only package ``__init__.py`` import wiring.

Both compilers emit ordinary CPython extension modules
(``name.cpython-311-x86_64-linux-gnu.so``); the runtime interpreter imports them
exactly like it imports numpy's or pydantic-core's binaries.

NOTES / GOTCHAS (learned the hard way, do not "simplify" these away):
  * Nuitka's Scons backend fails against the image's gcc 14 -> we force clang.
  * ``--module-name-choice=runtime`` (Nuitka's default for --module) makes the
    compiled module take ``__name__``/``__package__`` from the importing parent
    package. Required here: several dirs (app, app/api, app/core) are PEP-420
    namespace packages with no ``__init__.py``, and Pydantic resolves model
    forward-refs through ``sys.modules[cls.__module__]``.
  * Nuitka deliberately keeps ``__file__`` pointing at the original ``.py`` path
    (resolved relative to the .so at import time). app/main.py relies on
    ``Path(__file__).parent.parent / "data" / ...``, which therefore still
    resolves correctly even though main.py no longer exists on disk. Do NOT
    assert that ``__file__`` ends in ``.so``.
  * One Nuitka process per module, N in parallel; each child is told --jobs=1 so
    the pool -- not Scons -- controls oversubscription.
"""
import glob
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib.machinery import EXTENSION_SUFFIXES

# e.g. ".cpython-311-x86_64-linux-gnu.so" — must match the runtime interpreter,
# which is why the compiler stage uses the same python:3.11-slim base image.
SO_SUFFIX = next(s for s in EXTENSION_SUFFIXES if s.endswith(".so"))

# Globs (relative to the build root) that make up the framework layer.
FRAMEWORK_GLOBS = [
    "app/main.py",
    "app/core/security.py",
    "app/api/**/*.py",
]

# Package import wiring stays as source in every case.
EXCLUDE_NAMES = {"__init__.py"}

# Nuitka flags shared by every module build.
NUITKA_FLAGS = [
    "--module",
    "--no-pyi-file",           # no .pyi stubs leaking annotations into the image
    "--remove-output",         # drop the *.build/ scratch dir
    "--clang",                 # gcc 14 trips Nuitka's Scons backend
    "--assume-yes-for-downloads",
    "--module-name-choice=runtime",
    "--jobs=1",                # the pool below owns the parallelism
    "--quiet",
    "--no-progressbar",
]


def _collect():
    files = set()
    for pattern in FRAMEWORK_GLOBS:
        for f in glob.glob(pattern, recursive=True):
            f = f.replace(os.sep, "/")
            if os.path.basename(f) in EXCLUDE_NAMES:
                continue
            files.add(f)
    return sorted(files)


def _so_path(py_file: str) -> str:
    """Where Nuitka will drop the extension module for this source file."""
    stem = os.path.splitext(os.path.basename(py_file))[0]
    return os.path.join(os.path.dirname(py_file), stem + SO_SUFFIX)


def _compile(py_file: str):
    """Compile one module in its own Nuitka process. Returns (file, ok, seconds, log)."""
    started = time.time()
    out_dir = os.path.dirname(py_file) or "."
    cmd = [sys.executable, "-m", "nuitka", *NUITKA_FLAGS,
           f"--output-dir={out_dir}", py_file]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.time() - started
    ok = proc.returncode == 0 and os.path.exists(_so_path(py_file))
    log = (proc.stdout or "") + (proc.stderr or "")
    return py_file, ok, elapsed, log.strip()


if __name__ == "__main__":
    py_files = _collect()
    if not py_files:
        print("[compile_framework] ERROR: no framework sources found — wrong CWD?",
              file=sys.stderr)
        sys.exit(1)

    # Nuitka + clang are memory-hungry on the larger routers; cap the pool so a
    # small CI runner does not OOM mid-build.
    jobs = int(os.environ.get("NUITKA_JOBS") or max(1, min(os.cpu_count() or 2, 4)))
    print(f"[compile_framework] compiling {len(py_files)} framework modules -> .so "
          f"(nuitka/clang, pool={jobs})", flush=True)

    failures = []
    done = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(_compile, f): f for f in py_files}
        for fut in as_completed(futures):
            py_file, ok, elapsed, log = fut.result()
            done += 1
            status = "ok " if ok else "FAIL"
            print(f"[compile_framework] {status} ({done}/{len(py_files)}) "
                  f"{py_file}  {elapsed:5.1f}s", flush=True)
            if not ok:
                failures.append((py_file, log))

    if failures:
        print(f"\n[compile_framework] {len(failures)} module(s) FAILED to compile:",
              file=sys.stderr)
        for py_file, log in failures:
            print(f"\n--- {py_file} ---\n{log[-4000:]}", file=sys.stderr)
        sys.exit(1)

    print(f"[compile_framework] done — {len(py_files)} framework modules compiled",
          flush=True)
