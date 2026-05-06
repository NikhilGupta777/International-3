# syntax=docker/dockerfile:1.7
# AWS Batch GPU Worker Container — Production Grade
# Base: CUDA 12.1 + cuDNN 8 on Ubuntu 22.04
# Pipeline: AssemblyAI → Gemini → CosyVoice 3.0 (Fun-CosyVoice3-0.5B-2512) → LatentSync 1.6
# Runs as a one-shot CLI job: python worker.py
# No HTTP server, no EXPOSE, no HEALTHCHECK.
# Requires BuildKit (heredoc COPY) — the deploy workflow uses `docker buildx build`.
# Trigger: rebuild to refresh GPU AMI with pre-pulled image (fixes 8-9 min cold start).

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_CACHE_DIR=/model-cache
# CosyVoice uses ModelScope (Alibaba) for iic/ model IDs — NOT HuggingFace
ENV MODELSCOPE_CACHE=/model-cache/modelscope
ENV HF_HOME=/model-cache/huggingface
# PyTorch hub downloads (used by Demucs) — baked into image at this path
ENV TORCH_HOME=/model-cache/torch
# ALLOW_RUNTIME_MODEL_DOWNLOADS=0 tells worker.py to treat missing models as a
# fatal error rather than downloading on the fly.  worker.py then sets
# HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 at runtime automatically.
# DO NOT set HF_HUB_OFFLINE here — it would also block model downloads
# during the Docker BUILD steps below, causing the image build to fail.
ENV ALLOW_RUNTIME_MODEL_DOWNLOADS=0

# PYTHONPATH must include CosyVoice root AND Matcha-TTS (third_party submodule).
# Both are required for CosyVoice imports to resolve without error.
ENV PYTHONPATH=/model-cache/CosyVoice:/model-cache/CosyVoice/third_party/Matcha-TTS

ARG DOWNLOAD_MODELS_AT_BUILD=true

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
# --recurse-submodules is CRITICAL — it pulls in third_party/Matcha-TTS.
RUN git clone --depth 1 --recurse-submodules \
    https://github.com/FunAudioLLM/CosyVoice.git /model-cache/CosyVoice

RUN git clone --depth 1 \
    https://github.com/bytedance/LatentSync.git /model-cache/LatentSync

# ── Pre-install LatentSync deps (filtered to avoid torch conflicts) ───────────
# LatentSync has its own requirements.txt. We install it here (skipping torch/
# torchvision/torchaudio which are already installed from CUDA wheels) so the
# first lip-sync job doesn't need a runtime pip install.
COPY runtime_deps.py /tmp/runtime_deps.py
RUN if [ -f /model-cache/LatentSync/requirements.txt ]; then \
      python -c "from pathlib import Path; exec(Path('/tmp/runtime_deps.py').read_text()); write_runtime_requirements(Path('/model-cache/LatentSync/requirements.txt'), Path('/tmp/ls_filtered.txt'))" \
      && pip install --no-cache-dir --prefer-binary -r /tmp/ls_filtered.txt \
      && touch /model-cache/LatentSync/.deps_installed; \
      rm -f /tmp/ls_filtered.txt; \
    fi && rm -f /tmp/runtime_deps.py


# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt constraints.txt ./

RUN pip install --no-cache-dir \
    "pip<26" "setuptools<81" wheel \
    && pip install --no-cache-dir --prefer-binary -r requirements.txt -c constraints.txt

# ── Pre-download Demucs htdemucs model weights (~80 MB) ──────────────────────
# Demucs uses PyTorch Hub which downloads to TORCH_HOME at runtime if not cached.
# Baking the weights in eliminates a 5-10 min cold-start download per job.
# TORCH_HOME is set to /model-cache/torch so weights persist in the image layer.
RUN python - <<'PY'
import os
os.environ.setdefault("TORCH_HOME", "/model-cache/torch")
from demucs.pretrained import get_model
print("[Demucs] Pre-downloading htdemucs model weights...")
model = get_model("htdemucs")
print(f"[Demucs] Model ready: {model.__class__.__name__}")
del model
PY

# ── modelscope — required for CosyVoice model download & loading ──────────────
# Must be its own RUN to guarantee it installs before the download step.
# NOTE: pynini + WeTextProcessing have an irreconcilable version conflict —
#   "Cannot install pynini==2.1.6 and wetextprocessing==1.0.3"
#   They are NOT needed for zero-shot inference, only for text normalization
#   preprocessing. CosyVoice still works without them.
RUN pip install --no-cache-dir modelscope==1.18.1

# ── Force-pin packages that modelscope may downgrade or remove ────────────────
# modelscope's pip resolver can silently downgrade packages installed earlier.
# Using --no-deps is CRITICAL: prevents pulling in incompatible transitive deps
# that would break the CUDA-built torchvision (torchvision::nms error).
RUN pip install --no-cache-dir --force-reinstall --no-deps \
    "rich==13.7.1" \
    "x-transformers==2.11.24" \
    "einops==0.8.0" \
    "lightning==2.2.4" \
    "pyarrow==18.1.0"

# ── Optional CosyVoice extras (non-fatal if any fail) ────────────────────────
RUN pip install --no-cache-dir pyopenjtalk==0.3.4 || true
RUN pip install --no-cache-dir onnxruntime-gpu==1.18.1 || true

# ── Build-time import smoke test ──────────────────────────────────────────────
# FAIL FAST: verify ALL CosyVoice + Matcha-TTS imports resolve BEFORE deployment.
# If any module is missing, the Docker build fails here — not in production.
COPY <<'PY' /tmp/smoke_test_imports.py
import sys, importlib
sys.path.insert(0, "/model-cache/CosyVoice")
sys.path.insert(0, "/model-cache/CosyVoice/third_party/Matcha-TTS")

modules = [
    # CosyVoice core
    "cosyvoice.cli.cosyvoice",
    "cosyvoice.flow.flow_matching",
    "cosyvoice.dataset.processor",
    "cosyvoice.utils.file_utils",
    # Matcha-TTS
    "matcha.models.components.flow_matching",
    "matcha.models.baselightningmodule",
    # Upstream deps
    "hydra",
    "omegaconf",
    "lightning",
    "torchmetrics",
    "x_transformers",
    "rich",
    "pyarrow",
    "pyworld",
    "inflect",
    "conformer",
    "diffusers",
    "grpc",
    "tensorboard",
    "rootutils",
    "networkx",
    "pandas",
    "scipy",
    "seaborn",
]

failed = []
for m in modules:
    try:
        importlib.import_module(m)
        print(f"  OK: {m}")
    except ImportError as e:
        print(f"  FAIL: {m} — {e}")
        failed.append(m)

if failed:
    print(f"\nSMOKE TEST FAILED — {len(failed)} missing module(s): {failed}")
    sys.exit(1)
else:
    print(f"\nSMOKE TEST PASSED — all {len(modules)} modules imported successfully")
PY
RUN python /tmp/smoke_test_imports.py && rm -f /tmp/smoke_test_imports.py

# ── Pre-download CosyVoice3 model weights ────────────────────────────────────
# Downloads FunAudioLLM/Fun-CosyVoice3-0.5B-2512 (the official CosyVoice3 model).
# Uses local_dir so the path is deterministic: /model-cache/modelscope/hub/iic/Fun-CosyVoice3-0.5B
# worker.py _find_cosyvoice_model() searches this exact path.
RUN mkdir -p /model-cache/modelscope /model-cache/huggingface
COPY <<'PY' /tmp/download_cosyvoice.py
import os, pathlib
from modelscope import snapshot_download

target = "/model-cache/modelscope/hub/iic/Fun-CosyVoice3-0.5B"
os.makedirs(target, exist_ok=True)
print(f"[ModelScope] Downloading FunAudioLLM/Fun-CosyVoice3-0.5B-2512 -> {target} ...")
p = snapshot_download(
    "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
    local_dir=target,
)
print(f"[ModelScope] CosyVoice3 downloaded to: {p}")
print(f"[ModelScope] Weights at: {target}")
PY
RUN if [ "$DOWNLOAD_MODELS_AT_BUILD" = "true" ]; then \
      python /tmp/download_cosyvoice.py; \
    else \
      echo "Skipping CosyVoice3 model download during Docker build"; \
    fi && rm -f /tmp/download_cosyvoice.py

# Verify the weights landed at the expected path
RUN if [ "$DOWNLOAD_MODELS_AT_BUILD" = "true" ]; then \
      test -d /model-cache/modelscope/hub/iic/Fun-CosyVoice3-0.5B || \
      (echo "ERROR: Fun-CosyVoice3-0.5B not found at /model-cache/modelscope/hub/iic/" && \
       find /model-cache/modelscope -maxdepth 6 -type d 2>/dev/null && exit 1); \
      echo "Fun-CosyVoice3-0.5B verified OK"; \
    fi

# ── Model-construction smoke test ─────────────────────────────────────────────
# Verify CosyVoice3 can be constructed via AutoModel (the official v3 entry point).
# CosyVoice3 drops load_jit; we use inspect.signature to pass only supported kwargs.
COPY <<'PY' /tmp/smoke_test_model.py
import sys, os, inspect
sys.path.insert(0, "/model-cache/CosyVoice")
sys.path.insert(0, "/model-cache/CosyVoice/third_party/Matcha-TTS")

model_dir = "/model-cache/modelscope/hub/iic/Fun-CosyVoice3-0.5B"
if not os.path.isdir(model_dir):
    print("Model weights not baked in — skipping construction smoke test")
    sys.exit(0)

print(f"Testing CosyVoice3 construction from: {model_dir}")
from cosyvoice.cli.cosyvoice import AutoModel
_sig = inspect.signature(AutoModel)
_kw = {}
if "load_jit" in _sig.parameters:
    _kw["load_jit"] = False
if "load_trt" in _sig.parameters:
    _kw["load_trt"] = False
model = AutoModel(model_dir=model_dir, **_kw)
print("CosyVoice3 AutoModel construction OK")
PY
RUN if [ "$DOWNLOAD_MODELS_AT_BUILD" = "true" ]; then \
      python /tmp/smoke_test_model.py; \
    else \
      echo "Skipping model construction smoke test (models not baked in)"; \
    fi && rm -f /tmp/smoke_test_model.py

# ── Pre-download LatentSync checkpoint (~700 MB) ─────────────────────────────
# Optional build-time cache warmup; runtime can download if this is skipped.
# The worker checks for this file at runtime and skips the download if present.
COPY <<'PY' /tmp/download_latentsync.py
from huggingface_hub import hf_hub_download
import pathlib
import whisper

ckpt_dir = pathlib.Path('/model-cache/LatentSync/checkpoints')
ckpt_dir.mkdir(parents=True, exist_ok=True)
print('[LatentSync] Downloading latentsync_unet.pt ...')
path = hf_hub_download('ByteDance/LatentSync', 'latentsync_unet.pt', local_dir=str(ckpt_dir))
print(f'[LatentSync] Checkpoint saved to {path}')

dst = ckpt_dir / "whisper"
dst.mkdir(parents=True, exist_ok=True)
print('[LatentSync] Downloading Whisper tiny.pt ...')
whisper.load_model("tiny", download_root=str(dst))
assert (dst / "tiny.pt").exists(), "missing LatentSync whisper tiny.pt"
print("LatentSync whisper tiny.pt OK")
PY
RUN if [ "$DOWNLOAD_MODELS_AT_BUILD" = "true" ]; then \
      python /tmp/download_latentsync.py && \
      test -f /model-cache/LatentSync/checkpoints/whisper/tiny.pt; \
    else \
      echo "Skipping LatentSync checkpoint download during Docker build"; \
    fi && rm -f /tmp/download_latentsync.py

# ── Pre-download VAE used by LatentSync at inference time (~330 MB) ──────────
# LatentSync inference.py calls AutoencoderKL.from_pretrained("stabilityai/sd-vae-ft-mse").
# Pre-baking it into the image means every translation job doesn't pay a 330 MB
# HuggingFace download on cold start and avoids failures if the network is slow.
COPY <<'PY' /tmp/download_vae.py
import os, sys
sys.path.insert(0, "/model-cache/CosyVoice")
sys.path.insert(0, "/model-cache/CosyVoice/third_party/Matcha-TTS")
os.environ.setdefault("HF_HOME", "/model-cache/huggingface")
from diffusers import AutoencoderKL
import torch
print("[VAE] Downloading stabilityai/sd-vae-ft-mse ...")
vae = AutoencoderKL.from_pretrained(
    "stabilityai/sd-vae-ft-mse",
    torch_dtype=torch.float32,
    cache_dir="/model-cache/huggingface",
)
print(f"[VAE] Downloaded OK — config: {vae.config.scaling_factor}")
del vae
PY
RUN if [ "$DOWNLOAD_MODELS_AT_BUILD" = "true" ]; then \
      python /tmp/download_vae.py; \
    else \
      echo "Skipping VAE pre-download during Docker build"; \
    fi && rm -f /tmp/download_vae.py

# ── Copy worker script ────────────────────────────────────────────────────────
COPY worker.py runtime_deps.py ./

# ── Entrypoint: one-shot CLI job ──────────────────────────────────────────────
# CRITICAL: Clear the inherited NVIDIA entrypoint.
# nvidia/cuda base images ship with ENTRYPOINT ["/opt/nvidia/nvidia_entrypoint.sh"].
# That script does driver/CUDA compatibility checks and can exit(0) before ever
# executing our CMD — making AWS Batch think the job succeeded while Python
# never ran.  ENTRYPOINT [] wipes the inherited script so CMD runs directly.
# NVIDIA_DISABLE_REQUIRE=1 skips the nvidia-smi driver requirement check that
# would otherwise crash containers where the host driver version is mismatched.
ENV NVIDIA_DISABLE_REQUIRE=1
ENTRYPOINT []
# -u = unbuffered stdout/stderr so every log line appears in CloudWatch
# immediately rather than being held in Python's I/O buffer.
CMD ["python", "-u", "worker.py"]
