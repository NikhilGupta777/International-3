# AWS Batch GPU Worker Container
# Base: CUDA 12.1 + cuDNN 8 on Ubuntu 22.04
# Pipeline: faster-whisper → Gemini → CosyVoice 3.0 → LatentSync 1.6
# Runs as a one-shot CLI job: python worker.py
# No HTTP server, no EXPOSE, no HEALTHCHECK.

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_CACHE_DIR=/model-cache
ENV HF_HOME=/model-cache/huggingface

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-dev python3-pip python3.11-venv \
    ffmpeg git curl wget unzip \
    libsndfile1 libsox-dev sox espeak-ng \
    libgl1-mesa-glx libglib2.0-0 \
    build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

# Make python3.11 the default
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# ── PyTorch + torchaudio (CUDA 12.1 wheel) — installed FIRST to avoid conflicts
RUN pip install --no-cache-dir \
    torch==2.3.1+cu121 \
    torchaudio==2.3.1+cu121 \
    torchvision==0.18.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Model cache directory ─────────────────────────────────────────────────────
RUN mkdir -p /model-cache/whisper /model-cache/huggingface

# Preload model repos at build time to avoid runtime clone/install failures
RUN git clone --depth 1 https://github.com/FunAudioLLM/CosyVoice.git /model-cache/CosyVoice \
    && pip install --no-cache-dir -e /model-cache/CosyVoice/[all]

RUN git clone --depth 1 https://github.com/bytedance/LatentSync.git /model-cache/LatentSync \
    && pip install --no-cache-dir -r /model-cache/LatentSync/requirements.txt

RUN git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git /model-cache/MuseTalk \
    && if [ -f /model-cache/MuseTalk/requirements.txt ]; then pip install --no-cache-dir -r /model-cache/MuseTalk/requirements.txt; fi



# ── Copy worker script ────────────────────────────────────────────────────────
COPY worker.py .

# ── Entrypoint: one-shot CLI job ──────────────────────────────────────────────
CMD ["python", "worker.py"]
