# syntax=docker/dockerfile:1.7
# Slim worker image — built on EVERY code push (~2-3 min).
# FROM the translator-base image which contains all model weights and heavy deps.
# Keeping code separate from models means worker.py fixes deploy in 2 min, not 25.
#
# Build-time validation (runs during docker build, FAILS BUILD on any error):
#   1. python -m py_compile  — catches SyntaxError before any runtime
#   2. pyflakes               — catches undefined names (e.g. 'final_mix' not defined),
#                               bad imports, unreachable code
# Both checks would have prevented the production bugs we hit.

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# WORKDIR /app is inherited from base. Just copy the worker script.
COPY worker.py runtime_deps.py ./

# ── Build-time code validation ────────────────────────────────────────────────
# These checks run during `docker build` and FAIL the build if any error is
# found. Broken code can never be pushed to ECR and never reach production.

# 1. Syntax check — fast, catches any Python SyntaxError
RUN python -m py_compile worker.py \
    && echo "[BUILD-VALIDATE] Syntax check passed"

# 2. Static analysis — catches undefined names, bad imports, etc.
#    Example: 'final_mix' referenced before assignment → caught here, build fails.
RUN pip install --no-cache-dir --quiet pyflakes \
    && pyflakes worker.py \
    && echo "[BUILD-VALIDATE] Static analysis passed (pyflakes)"

# ── Entrypoint ────────────────────────────────────────────────────────────────
# NVIDIA_DISABLE_REQUIRE=1: skips nvidia-smi driver version check that would
# crash containers where host driver != container CUDA version.
# ENTRYPOINT []: clears the inherited NVIDIA entrypoint script that can exit(0)
# before Python ever starts, making Batch think the job succeeded silently.
# -u: unbuffered stdout so every log line appears in CloudWatch immediately.
ENV NVIDIA_DISABLE_REQUIRE=1
ENTRYPOINT []
CMD ["python", "-u", "worker.py"]
