# AWS Batch GPU Worker Container — Production Grade
# Base: CUDA 12.1 + cuDNN 8 on Ubuntu 22.04
# Pipeline: AssemblyAI → Gemini → CosyVoice 2.0 → LatentSync 1.6
# Runs as a one-shot CLI job: python worker.py
# No HTTP server, no EXPOSE, no HEALTHCHECK.

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_CACHE_DIR=/model-cache
# CosyVoice uses ModelScope (Alibaba) for iic/ model IDs — NOT HuggingFace
ENV MODELSCOPE_CACHE=/model-cache/modelscope
ENV HF_HOME=/model-cache/huggingface
# Prevent any runtime HuggingFace/Transformers network calls
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
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

RUN git clone --depth 1 \
    https://github.com/TMElyralab/MuseTalk.git /model-cache/MuseTalk

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
# alone, as some modelscope versions ignore it. This guarantees the model lands
# at /model-cache/modelscope/hub/iic/CosyVoice2-0.5B which is what worker.py checks.
RUN mkdir -p /model-cache/modelscope /model-cache/huggingface
RUN python -c "\
import os; \
from modelscope import snapshot_download; \
cache = '/model-cache/modelscope'; \
os.makedirs(cache, exist_ok=True); \
p = snapshot_download('iic/CosyVoice2-0.5B', cache_dir=cache); \
print(f'[ModelScope] Downloaded to: {p}')"
# Verify the weights actually landed where worker.py will look for them
RUN ls -la /model-cache/modelscope/hub/iic/ && \
    echo "CosyVoice2-0.5B weights verified OK" || \
    (echo "ERROR: model not found at expected path" && exit 1)

# ── Copy worker script ────────────────────────────────────────────────────────
COPY worker.py .

# ── Entrypoint: one-shot CLI job ──────────────────────────────────────────────
CMD ["python", "worker.py"]
