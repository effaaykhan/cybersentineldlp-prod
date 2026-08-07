"""
Build-time helper: compile the CyberSentinel DLP backend to native .so modules.

Run inside the Docker 'compiler' stage from the build root. It Cythonizes the
compilable backend modules (see EXCLUDE_GLOBS) into C extensions; the Dockerfile
then deletes the .py that got a .so so the published image ships those modules as
compiled binaries only — no readable source for the crown-jewel logic
(classification/ML/policy-evaluation/detection/EDM/actions/…).

WHAT STAYS AS SOURCE (excluded on purpose):
  * package __init__.py — import wiring only; safest kept as .py.
  * the FastAPI framework layer — app/api/**, app/main.py, app/core/security.py.
    These declare route/handler functions whose parameters default to FastAPI
    markers (``= Depends(...)`` / ``= Query(...)`` / …). Cython 3 mis-handles
    those defaults ("TypeError: Expected unicode, got Depends"), so the thin
    request/response wiring is left as .py. It contains no proprietary
    algorithms — only routing that calls into the compiled services.

IMPORTANT: several package dirs (app, app/api, app/core, app/utils,
app/middleware, app/policies) have NO __init__.py (PEP 420 namespace packages),
so we build EXPLICIT Extension objects with the correct dotted name derived from
the path — otherwise cythonize misnames modules and --inplace drops the .so in
the wrong directory.
"""
import glob
import os
from setuptools import setup, Extension
from Cython.Build import cythonize

# Globs (relative to the build root) whose .py must NOT be compiled.
EXCLUDE_GLOBS = [
    "app/**/__init__.py",     # package init wiring
    "app/api/**/*.py",        # FastAPI routers — Depends/Query defaults break Cython
    "app/main.py",            # FastAPI app factory + inline endpoints (Depends)
    "app/core/security.py",   # shared FastAPI auth dependencies (Depends)
]


def _module_name(path: str) -> str:
    # app/api/v1/threat_intel.py -> app.api.v1.threat_intel
    return os.path.splitext(path.replace(os.sep, "/"))[0].replace("/", ".")


def _collect():
    all_py = {f.replace(os.sep, "/") for f in glob.glob("app/**/*.py", recursive=True)}
    excluded = set()
    for pattern in EXCLUDE_GLOBS:
        excluded |= {f.replace(os.sep, "/") for f in glob.glob(pattern, recursive=True)}
    return sorted(all_py - excluded)


if __name__ == "__main__":
    py_files = _collect()
    # Explicit (name, [source]) so the dotted module name is correct even for the
    # namespace-package dirs without __init__.py — this drives both compilation
    # and --inplace placement.
    #
    # Speed: the .so are for obfuscation, not runtime perf (this app is I/O-bound),
    # so compile at -O1 with debug info stripped (-g0) instead of Python's default
    # -O3 — far faster to build, functionally identical modules. Combined with a
    # parallel build_ext this cuts compile time to a fraction of the -O3 grind.
    extensions = [
        Extension(_module_name(f), [f], extra_compile_args=["-O1", "-g0"])
        for f in py_files
    ]
    jobs = str(os.cpu_count() or 4)
    print(f"[compile_app] compiling {len(extensions)} modules -> .so "
          f"(-O1, parallel={jobs}); framework layer kept as source", flush=True)
    setup(
        name="csdlp-backend",
        ext_modules=cythonize(
            extensions,
            compiler_directives={"language_level": "3"},
            quiet=True,
            nthreads=int(jobs),
        ),
        script_args=["build_ext", "--inplace", "--parallel", jobs],
    )
    print("[compile_app] done", flush=True)
