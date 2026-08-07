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
# Only gcc/g++ + Cython are needed — cythonize compiles the .py statically (it
# does not import them), so the app's runtime deps are not required here.
FROM python:3.11-slim AS compiler

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "cython>=3.0,<3.1"

# Bring in the source (build context = ./server; .dockerignore trims junk).
COPY . /build

# Compile app/**/*.py -> .so, then STRIP all backend source from the tree:
#   - delete the now-compiled .py (keep package __init__.py — import wiring only)
#   - delete the generated .c, build tree, bytecode caches, tests and the
#     compile helper itself, so none of it reaches the runtime stage.
# The final guard fails the build if any non-__init__ .py survives under
# app/services (the crown-jewel package) — a tripwire against a silent miscompile.
# Delete ONLY the .py that produced a .so (i.e. actually got compiled). The
# excluded framework layer (app/api/**, app/main.py, app/core/security.py) has no
# .so and MUST be kept as source. The guards assert a crown-jewel engine compiled,
# a sane .so count, and that NO source survives under app/services (the IP).
RUN python compile_app.py \
    && ls app/services/classification_engine.*.so >/dev/null 2>&1 || { echo "ERROR: crown-jewel engine did not compile/place correctly" >&2; exit 1; } \
    && test "$(find app -name '*.so' | wc -l)" -ge 70 || { echo "ERROR: too few .so under app/ — likely a module-name/placement problem" >&2; exit 1; } \
    && find app -name '*.cpython-*.so' | while read -r so; do rm -f "${so%%.cpython-*}.py"; done \
    && find app -name '*.c' -delete \
    && find app -type d -name '__pycache__' -prune -exec rm -rf {} + \
    && rm -rf build tests compile_app.py \
    && echo "[Dockerfile] compiled .so=$(find app -name '*.so' | wc -l), source .py kept=$(find app -name '*.py' | wc -l) (init + framework layer)" \
    && if find app/services -name '*.py' ! -name '__init__.py' 2>/dev/null | grep -q .; then \
         echo "ERROR: uncompiled source remains under app/services (crown jewels)" >&2; exit 1; \
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
# enters the final image — and it is .so binaries (+ package __init__.py and
# non-code assets like alembic/, data/, ml/), never the backend .py source.
COPY --from=compiler /build /app

# Runtime working dirs
RUN mkdir -p /app/logs /app/quarantine /app/ml/models

# Drop privileges — run as a non-root user
RUN useradd -m -u 1000 dlpuser && \
    chown -R dlpuser:dlpuser /app
USER dlpuser

EXPOSE 55000

ENV UVICORN_WORKERS=${UVICORN_WORKERS:-4}
ENV PORT=55000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Run application (exec form so signals propagate correctly)
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-55000} --workers ${UVICORN_WORKERS}"]
