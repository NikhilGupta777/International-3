# syntax=docker/dockerfile:1.7
# AWS Batch GPU Worker Container — Production Grade
# Base: CUDA 12.1 + cuDNN 8 on Ubuntu 22.04
# Pipeline: AssemblyAI → Gemini → CosyVoice 2.0 → LatentSync 1.6
# Runs as a one-shot CLI job: python worker.py
# No HTTP server, no EXPOSE, no HEALTHCHECK.
# Requires BuildKit (heredoc COPY) — the deploy workflow uses `docker buildx build`.

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_CACHE_DIR=/model-cache
# CosyVoice uses ModelScope (Alibaba) for iic/ model IDs — NOT HuggingFace
ENV MODELSCOPE_CACHE=/model-cache/modelscope
ENV HF_HOME=/model-cache/huggingface
# NOTE: HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE are set AFTER all model downloads
# below. Setting them here would block CosyVoice/LatentSync from downloading weights.

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_DEFAULT_TIMEOUT=300

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-dev python3-pip python3.11-venv \
    ffmpeg git curl wget unzip \
    libsndfile1 libsox-dev sox espeak-ng \
    libgl1-mesa-glx libglib2.0-0 \
    build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# ── PyTorch + torchaudio (CUDA 12.1 wheel) ────────────────────────────────────
# Installed FIRST — heavy layer, cached independently.
RUN pip install --no-cache-dir \
    torch==2.3.1+cu121 \
    torchaudio==2.3.1+cu121 \
    torchvision==0.18.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121

# ── Pre-clone model repos ──────────────────────────────────────────────────────
# Cloned BEFORE pip install so these layers are cached independently.
# requirements.txt changes do NOT invalidate these git clone layers.
RUN git clone --depth 1 --recurse-submodules \
    https://github.com/FunAudioLLM/CosyVoice.git /model-cache/CosyVoice

RUN git clone --depth 1 \
    https://github.com/bytedance/LatentSync.git /model-cache/LatentSync

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt constraints.txt ./

RUN pip install --no-cache-dir \
    "pip<26" "setuptools<81" wheel \
    && pip install --no-cache-dir --prefer-binary -r requirements.txt -c constraints.txt

# ── modelscope — required for CosyVoice model download & loading ──────────────
# Must be its own RUN to guarantee it installs before the download step.
# NOTE: pynini + WeTextProcessing have an irreconcilable version conflict —
#   "Cannot install pynini==2.1.6 and wetextprocessing==1.0.3"
#   They are NOT needed for zero-shot inference, only for text normalization
#   preprocessing. CosyVoice still works without them.
RUN pip install --no-cache-dir modelscope==1.18.1

# ── Optional CosyVoice extras (non-fatal if any fail) ────────────────────────
RUN pip install --no-cache-dir pyopenjtalk==0.3.4 || true
RUN pip install --no-cache-dir onnxruntime-gpu==1.18.1 || true

# ── Pre-download CosyVoice model weights into ModelScope cache ────────────────
# Uses iic/CosyVoice2-0.5B — publicly available on ModelScope.
# CRITICAL: pass cache_dir explicitly — do NOT rely on MODELSCOPE_CACHE env var
# alone, as some modelscope versions ignore it.
#
# modelscope >=1.16 lays the cache out at:
#     <cache>/hub/models/iic/CosyVoice2-0.5B
# older modelscope laid it out at:
#     <cache>/hub/iic/CosyVoice2-0.5B
# worker.py historically checked the OLD layout, so we capture the real
# download path and symlink the canonical legacy path to it. That way both
# layouts work for any future modelscope upgrade or downgrade.
RUN mkdir -p /model-cache/modelscope /model-cache/huggingface
COPY <<'PY' /tmp/download_cosyvoice.py
import os, pathlib, shutil
from modelscope import snapshot_download

cache = "/model-cache/modelscope"
os.makedirs(cache, exist_ok=True)
p = snapshot_download("iic/CosyVoice2-0.5B", cache_dir=cache)
print(f"[ModelScope] Downloaded to: {p}")

target = pathlib.Path(p).resolve()
legacy = pathlib.Path(cache) / "hub" / "iic" / "CosyVoice2-0.5B"
legacy.parent.mkdir(parents=True, exist_ok=True)

if legacy.exists() or legacy.is_symlink():
    if legacy.is_symlink() or legacy.is_file():
        legacy.unlink()
    elif legacy.is_dir():
        # Already a real dir from a prior layout — leave it alone.
        print(f"[ModelScope] Legacy dir already exists at {legacy}; skipping symlink")
        raise SystemExit(0)

legacy.symlink_to(target, target_is_directory=True)
print(f"[ModelScope] Legacy path: {legacy} -> {target}")
PY
RUN python /tmp/download_cosyvoice.py && rm -f /tmp/download_cosyvoice.py
# Verify the weights actually landed where worker.py will look for them.
# Accept either the legacy iic/ path or the new models/iic/ path.
RUN (ls -la /model-cache/modelscope/hub/iic/CosyVoice2-0.5B 2>/dev/null && echo "CosyVoice2-0.5B (legacy path) verified OK") || \
    (ls -la /model-cache/modelscope/hub/models/iic/CosyVoice2-0.5B 2>/dev/null && echo "CosyVoice2-0.5B (new path) verified OK") || \
    (echo "ERROR: CosyVoice2-0.5B not found at either /model-cache/modelscope/hub/iic/ or /model-cache/modelscope/hub/models/iic/" && \
     echo "--- /model-cache/modelscope tree ---" && find /model-cache/modelscope -maxdepth 5 -type d 2>/dev/null && \
     exit 1)

# ── Pre-download LatentSync checkpoint (~700 MB) ─────────────────────────────
# Must happen BEFORE HF_HUB_OFFLINE=1 is set below.
# The worker checks for this file at runtime and skips the download if present.
RUN python -c "
from huggingface_hub import hf_hub_download
import pathlib
ckpt_dir = pathlib.Path('/model-cache/LatentSync/checkpoints')
ckpt_dir.mkdir(parents=True, exist_ok=True)
print('[LatentSync] Downloading latentsync_unet.pt ...')
path = hf_hub_download('ByteDance/LatentSync', 'latentsync_unet.pt', local_dir=str(ckpt_dir))
print(f'[LatentSync] Checkpoint saved to {path}')
"

# ── Lock down all runtime network access — must be LAST before COPY ──────────
# All model weights are now baked in. No internet access allowed at job runtime.
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

# ── Copy worker script ────────────────────────────────────────────────────────
COPY worker.py .

# ── Entrypoint: one-shot CLI job ──────────────────────────────────────────────
CMD ["python", "worker.py"]
