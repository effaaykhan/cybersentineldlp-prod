# Multi-stage build for the production FastAPI server.
#
# The backend is COMPILED to native .so modules (Cython) in a throw-away build
# stage; the final image copies only the compiled artifacts. Because this is a
# multi-stage build, the source-bearing stages are discarded — the published
# image (and anything `docker save`/`docker cp` can pull out of it) contains NO
# readable backend .py, only .so binaries. See compile_app.py.
#
# NOTE: dev (docker-compose.yml) bind-mounts ./server over /app, which shadows
# the compiled code with live source for hot-reload — so the SAME Dockerfile
# yields compiled PROD images while DEV keeps editing raw .py.

# ─── Stage 1: Python dependencies ─────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libpq-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
COPY constraints.txt .

# Make pip resilient to flaky networks (retry failed chunk downloads).
ENV PIP_DEFAULT_TIMEOUT=600 \
    PIP_RETRIES=10 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install --no-cache-dir --upgrade pip==24.0 setuptools wheel && \
    pip install --no-cache-dir --constraint constraints.txt -r requirements.txt

# Verify critical packages are installed correctly
RUN python -c "import numpy; print(f'NumPy {numpy.__version__}')" && \
    python -c "import pandas; print(f'Pandas {pandas.__version__}')" && \
    python -c "import sklearn; print(f'scikit-learn {sklearn.__version__}')"

# ─── Stage 2: compile the backend to native .so (source never ships) ──
# Same python:3.11-slim base as the runtime stage so the compiled ABI matches.
#
# TWO compilers, one artifact type. Both emit ordinary CPython extension modules
# (name.cpython-311-x86_64-linux-gnu.so); CPython in stage 3 merely imports them.
#   * Cython  (compile_app.py)       — the ~92 engine/service modules.
#   * Nuitka  (compile_framework.py) — app/main.py, app/core/security.py and
#     app/api/**, whose handler params default to FastAPI markers
#     (= Depends()/Query()) that Cython 3 cannot compile. Nuitka can, so with
#     this pass NO readable backend .py reaches the image — only package
#     __init__.py import wiring.
# Neither compiler imports the app, so the runtime deps are not needed here.
# clang is required: the image's gcc trips Nuitka's Scons backend.
FROM python:3.11-slim AS compiler

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    clang \
    ccache \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Nuitka is pinned: it drives a C backend, so an unattended minor bump is a
# build-breaking change, not a patch.
RUN pip install --no-cache-dir "cython>=3.0,<3.1" "nuitka==4.1.3"

# Bring in the source (build context = ./server; .dockerignore trims junk).
COPY . /build

# Pass 1 — Cython: engine/service/algorithm modules.
RUN python compile_app.py

# Pass 2 — Nuitka: the FastAPI framework layer Cython cannot take.
# NUITKA_JOBS caps concurrent clang processes; 4 suits the CI runner (4 vCPU /
# 16 GB). Lower it on a memory-tight host: --build-arg NUITKA_JOBS=2.
ARG NUITKA_JOBS=4
ENV NUITKA_JOBS=${NUITKA_JOBS}
RUN python compile_framework.py

# STRIP all backend source from the tree:
#   - delete the now-compiled .py (keep package __init__.py — import wiring only)
#   - delete the generated .c, build trees, bytecode caches, tests and the
#     compile helpers themselves, so none of it reaches the runtime stage.
# Guards (tripwires against a silent miscompile — each is a hard build failure):
#   1. the crown-jewel engine really produced a .so
#   2. the framework layer really produced a .so (proves the Nuitka pass ran)
#   3. a sane total .so count (~92 Cython + 29 Nuitka)
#   4. ZERO non-__init__ .py anywhere under app/ — the whole point of this stage
RUN find app -name '*.cpython-*.so' | while read -r so; do rm -f "${so%%.cpython-*}.py"; done \
    && find app -name '*.c' -delete \
    && find app -type d -name '*.build' -prune -exec rm -rf {} + \
    && find app -type d -name '__pycache__' -prune -exec rm -rf {} + \
    && rm -rf build tests compile_app.py compile_framework.py \
    && echo "[Dockerfile] compiled .so=$(find app -name '*.so' | wc -l), source .py kept=$(find app -name '*.py' | wc -l) (package __init__ only)" \
    && if ! ls app/services/classification_engine.*.so >/dev/null 2>&1; then \
         echo "ERROR: crown-jewel engine did not compile/place correctly" >&2; exit 1; \
       fi \
    && if ! ls app/main.*.so >/dev/null 2>&1; then \
         echo "ERROR: framework layer did not compile — Nuitka pass missing/failed" >&2; exit 1; \
       fi \
    && if [ "$(find app -name '*.so' | wc -l)" -lt 110 ]; then \
         echo "ERROR: too few .so under app/ — likely a module-name/placement problem" >&2; exit 1; \
       fi \
    && if find app -name '*.py' ! -name '__init__.py' | grep -q .; then \
         echo "ERROR: readable backend source survived the compile:" >&2; \
         find app -name '*.py' ! -name '__init__.py' >&2; exit 1; \
       fi

# ─── Stage 3: minimal runtime image (compiled binaries only) ──────────
FROM python:3.11-slim

WORKDIR /app

# Runtime system deps:
#   libpq5           - PostgreSQL client lib
#   curl             - container healthcheck
#   tesseract + eng  - OCR engine for scanned PDFs / images
#   poppler-utils    - pdftoppm, used by pdf2image to rasterise PDFs for OCR
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies from the builder stage
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Compiled application from the compiler stage. This is the ONLY place app code
# enters the final image, and under app/ it is .so binaries plus the package
# __init__.py import wiring — never the backend .py source.
#
# Still .py by necessity, and deliberately so: alembic/versions/* (alembic
# imports migration files by path at runtime — compiling them breaks
# `alembic upgrade head`) and scripts/* (one-off ops utilities run as
# `python scripts/foo.py`). Both are schema DDL / admin glue, not engine logic.
COPY --from=compiler /build /app

# Runtime working dirs
RUN mkdir -p /app/logs /app/quarantine /app/ml/models

# Drop privileges — run as a non-root user
RUN useradd -m -u 1000 dlpuser && \
    chown -R dlpuser:dlpuser /app
USER dlpuser

EXPOSE 55100

ENV UVICORN_WORKERS=${UVICORN_WORKERS:-4}
ENV PORT=55100

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Run application (exec form so signals propagate correctly)
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-55100} --workers ${UVICORN_WORKERS}"]
