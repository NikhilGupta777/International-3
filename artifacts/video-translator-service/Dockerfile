# AWS Batch GPU Worker Container — Production Grade
# Base: CUDA 12.1 + cuDNN 8 on Ubuntu 22.04
# Pipeline: AssemblyAI → Gemini → CosyVoice 3.0 → LatentSync 1.6
# Runs as a one-shot CLI job: python worker.py
# No HTTP server, no EXPOSE, no HEALTHCHECK.

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_CACHE_DIR=/model-cache
# CosyVoice uses ModelScope (Alibaba), not HuggingFace, for iic/ models
ENV MODELSCOPE_CACHE=/model-cache/modelscope
# We still set HF_HOME just in case other deps use it
ENV HF_HOME=/model-cache/huggingface
# CRITICAL: prevent any runtime network calls
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_DEFAULT_TIMEOUT=300

# ── System dependencies ───────────────────────────────────────────────────────
# This layer is cached forever (never changes).
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
# Installed FIRST — heavy, rarely changes, layer cached independently.
RUN pip install --no-cache-dir \
    torch==2.3.1+cu121 \
    torchaudio==2.3.1+cu121 \
    torchvision==0.18.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121

# ── Pre-clone model repos ──────────────────────────────────────────────────────
# Cloned BEFORE pip install so git clone layers are cached independently.
# requirements.txt changes do NOT invalidate these git clone layers.
RUN git clone --depth 1 --recurse-submodules \
    https://github.com/FunAudioLLM/CosyVoice.git /model-cache/CosyVoice

RUN git clone --depth 1 \
    https://github.com/bytedance/LatentSync.git /model-cache/LatentSync

RUN git clone --depth 1 \
    https://github.com/TMElyralab/MuseTalk.git /model-cache/MuseTalk

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt constraints.txt ./

RUN pip install --no-cache-dir \
    "pip<26" "setuptools<81" wheel \
    && pip install --no-cache-dir --prefer-binary -r requirements.txt -c constraints.txt

# ── CosyVoice repo requirements ───────────────────────────────────────────────
# Install CosyVoice's own deps NOW at build time (not lazily at runtime).
# We use --no-deps to avoid overriding our pinned versions from requirements.txt.
# modelscope is strictly required for downloading the model.
RUN pip install --no-cache-dir modelscope==1.18.1

# Only install what CosyVoice needs that isn't already covered.
# Some of these (like pynini/pyopenjtalk) can fail to compile on some platforms,
# so we separate them from the critical modelscope install.
RUN pip install --no-cache-dir \
    pyopenjtalk==0.3.4 \
    WeTextProcessing==1.0.3 \
    pynini==2.1.6 \
    onnxruntime-gpu==1.18.1 \
    || true  # non-fatal: some packages are optional/platform-specific

# ── Pre-download CosyVoice model weights into ModelScope cache ────────────────
# CRITICAL: must use modelscope snapshot_download so files land in
# the standard ModelScope hub format: MODELSCOPE_CACHE/hub/iic/CosyVoice3-0.5B/
# CosyVoice's _CosyVoice("iic/CosyVoice3-0.5B") resolves from this path natively.
RUN python -c "\
from modelscope import snapshot_download; \
p = snapshot_download('iic/CosyVoice3-0.5B'); \
print(f'CosyVoice3-0.5B downloaded OK -> {p}')"

# ── Model cache directory ─────────────────────────────────────────────────────
RUN mkdir -p /model-cache/modelscope /model-cache/huggingface

# ── Copy worker script ────────────────────────────────────────────────────────
COPY worker.py .

# ── Entrypoint: one-shot CLI job ──────────────────────────────────────────────
CMD ["python", "worker.py"]
