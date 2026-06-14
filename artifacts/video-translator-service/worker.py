"""
AWS Batch GPU Worker - Video Translator
=======================================
One-shot CLI script. Invoked by AWS Batch as:
    CMD ["python", "worker.py"]

All job config arrives via environment variables injected by the Batch job definition.

Pipeline:
  1. Download source video from S3
  2. Extract audio (FFmpeg)
  3. Optional: Demucs vocal/background separation
  4. Transcribe (AssemblyAI word-level timestamps)
  5. Optional: pyannote speaker diarization
  6. Translate segments (Gemini 3 Flash dubbing-aware)
  7. Voice clone (CosyVoice 3.0 â†’ edge-tts fallback â†’ gTTS emergency)
  8. Lip sync (LatentSync 1.6 -- graceful fallback to dubbed-audio-only on failure)
  9. Audio mix + normalize
 10. FFmpeg final mux
 11. Upload MP4 + SRT + transcript JSON to S3
 12. Update DynamoDB â†’ DONE
"""

import os
import sys
import time
import json
import re
import logging
import tempfile
import shutil
import subprocess
import math
import base64
from decimal import Decimal
import inspect
import threading
import importlib.metadata
import importlib.util
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

# ── Disable ONNX Runtime TensorRT engine caching ────────────────────────────
# Even if TRT is available, prevent it from writing multi-GB cache files to /tmp.
os.environ.setdefault("ORT_TENSORRT_ENGINE_CACHE_ENABLE", "0")

import boto3

from runtime_deps import pip_install_command, write_runtime_requirements

# â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("translator-worker")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        log.warning("Invalid integer env %s=%r; using %s", name, os.environ.get(name), default)
        return default

# â”€â”€ Environment config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
JOB_ID              = os.environ["JOB_ID"]
S3_BUCKET           = os.environ["S3_BUCKET"]
S3_INPUT_KEY        = os.environ["S3_INPUT_KEY"]          # translator-jobs/{jobId}/input.mp4
S3_OUTPUT_PREFIX    = os.environ.get("S3_OUTPUT_PREFIX", f"translator-jobs/{JOB_ID}")
DYNAMODB_TABLE      = os.environ["DYNAMODB_TABLE"]
DYNAMODB_REGION     = os.environ.get("DYNAMODB_REGION", "us-east-1")
GEMINI_API_KEY      = os.environ.get("GEMINI_API_KEY", "")
GEMINI_API_KEY_2    = os.environ.get("GEMINI_API_KEY_2", "")
GEMINI_API_KEY_3    = os.environ.get("GEMINI_API_KEY_3", "")
GOOGLE_GENAI_USE_VERTEXAI = os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("1", "true", "yes", "on")
GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEX_AI_PROJECT", "")
GOOGLE_CLOUD_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION") or os.environ.get("VERTEX_AI_LOCATION", "global")
GOOGLE_APPLICATION_CREDENTIALS_S3_KEY = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_S3_KEY", "")

TARGET_LANG         = os.environ.get("TARGET_LANG", "Hindi")
TARGET_LANG_CODE    = os.environ.get("TARGET_LANG_CODE", "hi")
SOURCE_LANG         = os.environ.get("SOURCE_LANG", "auto")
SOURCE_LANG_CODE    = os.environ.get("SOURCE_LANG_CODE", "")
# Best-effort: derive a BCP-47 code from SOURCE_LANG when an explicit
# SOURCE_LANG_CODE is absent.  The naive [:2] slice was broken for several
# languages (e.g. "Filipino" → "fi" which is Finnish, "Chinese" → "ch"
# which is invalid).  Use an explicit map keyed on both codes and display
# names so the worker handles every language the frontend exposes.
if not SOURCE_LANG_CODE and SOURCE_LANG not in ("", "auto"):
    _LANG_NAME_TO_CODE: dict[str, str] = {
        # language codes pass through unchanged
        "en": "en", "es": "es", "fr": "fr", "de": "de", "pt": "pt",
        "it": "it", "ja": "ja", "ko": "ko", "zh": "zh", "ar": "ar",
        "ru": "ru", "hi": "hi", "nl": "nl", "pl": "pl", "tr": "tr",
        "uk": "uk", "vi": "vi", "id": "id", "fil": "fil", "fi": "fi",
        "bn": "bn", "gu": "gu", "kn": "kn", "ml": "ml", "mr": "mr",
        "ta": "ta", "te": "te", "ur": "ur", "pa": "pa", "or": "or",
        "sa": "sa", "ne": "ne",
        # display names (lowercase) → code
        "english": "en", "spanish": "es", "french": "fr", "german": "de",
        "portuguese": "pt", "italian": "it", "japanese": "ja",
        "korean": "ko", "chinese": "zh", "arabic": "ar", "russian": "ru",
        "hindi": "hi", "dutch": "nl", "polish": "pl", "turkish": "tr",
        "ukrainian": "uk", "vietnamese": "vi", "indonesian": "id",
        "filipino": "fil", "finnish": "fi", "bengali": "bn",
        "gujarati": "gu", "kannada": "kn", "malayalam": "ml",
        "marathi": "mr", "tamil": "ta", "telugu": "te", "urdu": "ur",
        "punjabi": "pa", "odia": "or", "oriya": "or", "sanskrit": "sa",
        "nepali": "ne", "mandarin": "zh", "cantonese": "zh",
    }
    SOURCE_LANG_CODE = _LANG_NAME_TO_CODE.get(SOURCE_LANG.lower().strip(), "")
VOICE_CLONE         = os.environ.get("VOICE_CLONE", "true").lower() == "true"
LIP_SYNC            = os.environ.get("LIP_SYNC", "false").lower() == "true"
# Dynamic Video Length (advanced): never speed the voice up to fit the
# original timeline.  Instead, synthesize every line at its natural rate and
# let the OUTPUT video grow — inserting frozen-frame holds during the natural
# pauses between lines so audio and picture stay aligned (also keeps lip-sync
# valid).  The video gets a few seconds longer; the voice never sounds rushed.
DYNAMIC_VIDEO_LENGTH = os.environ.get("DYNAMIC_VIDEO_LENGTH", "false").lower() == "true"
# Demucs and diarization are quality-heavy options. The API/frontend decide
# when to enable them; default OFF prevents hidden multi-minute work in direct
# worker invocations that omit these env vars.
USE_DEMUCS          = os.environ.get("USE_DEMUCS", "false").lower() == "true"
MULTI_SPEAKER       = os.environ.get("MULTI_SPEAKER", "false").lower() == "true"
# Keep devotional content (sung bhajans/kirtan, chanting of divine names, and
# Sanskrit/Odia shlokas/mantras/verses) in the ORIGINAL audio instead of
# translating/dubbing it. Gemini flags those segments; the worker substitutes
# the original audio slice for them and leaves the rest dubbed as usual.
PRESERVE_CHANTS     = os.environ.get("PRESERVE_CHANTS", "false").lower() == "true"
ASSEMBLYAI_API_KEY  = os.environ.get("ASSEMBLYAI_API_KEY", "")
LIP_SYNC_QUALITY    = os.environ.get("LIP_SYNC_QUALITY", "latentsync")  # latentsync | latentsync_hq
TRANSLATION_MODE    = os.environ.get("TRANSLATION_MODE", "default")   # default | budget

MODEL_CACHE_DIR     = Path(os.environ.get("MODEL_CACHE_DIR", "/model-cache"))
MODELSCOPE_CACHE    = Path(os.environ.get("MODELSCOPE_CACHE", str(MODEL_CACHE_DIR / "modelscope")))
HF_HOME             = Path(os.environ.get("HF_HOME", str(MODEL_CACHE_DIR / "huggingface")))
# Runtime downloads disabled by default — all models must be baked into the
# Docker image.  Set =1 only for dev/testing.
ALLOW_RUNTIME_MODEL_DOWNLOADS = os.environ.get("ALLOW_RUNTIME_MODEL_DOWNLOADS", "0").lower() == "1"
# Allow automatic neural fallback when cloning fails (aligned with UI and API messaging).
ALLOW_VOICE_CLONE_FALLBACK = os.environ.get("ALLOW_VOICE_CLONE_FALLBACK", "true").lower() == "true"
ALLOW_LIP_SYNC_FALLBACK    = os.environ.get("ALLOW_LIP_SYNC_FALLBACK",    "true").lower() == "true"
# CosyVoice3 (Fun-CosyVoice3-0.5B-2512) is the current recommended model.
COSYVOICE_MODEL_ID  = os.environ.get("COSYVOICE_MODEL_ID", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512")
LATENTSYNC_REPO_ID  = os.environ.get("LATENTSYNC_REPO_ID", "ByteDance/LatentSync")
LATENTSYNC_CHECKPOINT = os.environ.get("LATENTSYNC_CHECKPOINT", "latentsync_unet.pt")
FFMPEG_TIMEOUT_SECONDS = _env_int("FFMPEG_TIMEOUT_SECONDS", 3600)
FFPROBE_TIMEOUT_SECONDS = _env_int("FFPROBE_TIMEOUT_SECONDS", 120)

# ── Phase 3: CosyVoice performance flags ─────────────────────────────────
# These are opt-in because they require specific GPU capabilities or Docker
# image contents.  Enable per-environment via env vars.
COSYVOICE_FP16  = os.environ.get("COSYVOICE_FP16", "false").lower() in ("1", "true", "yes", "on")
COSYVOICE_VLLM  = os.environ.get("COSYVOICE_VLLM", "false").lower() in ("1", "true", "yes", "on")
# Reserved for future parallel synthesis support.  Current inference remains
# sequential, so values >1 are accepted for forward compatibility but are a
# no-op today.
COSYVOICE_PARALLEL_SYNTH = _env_int("COSYVOICE_PARALLEL_SYNTH", 1)

# CosyVoice3's LLM asserts that either tts_text or prompt_text contains the
# "<|endofprompt|>" delimiter.  Keep this enabled by default; without it the
# model returns no audio and the worker can end up producing a silent dub.
COSYVOICE3_INJECT_PROMPT_PREFIX = os.environ.get(
    "COSYVOICE3_INJECT_PROMPT_PREFIX", "true"
).lower() in ("1", "true", "yes", "on")

# ── Force HuggingFace/ModelScope offline mode ─────────────────────────────────
# All model weights are baked into the Docker image at build time.
# Setting these prevents network calls at job runtime.
if ALLOW_RUNTIME_MODEL_DOWNLOADS:
    os.environ.setdefault("HF_HUB_OFFLINE", "0")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")
else:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("MODELSCOPE_CACHE", str(MODELSCOPE_CACHE))
os.environ.setdefault("HF_HOME", str(HF_HOME))

# â”€â”€ AWS Clients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
s3 = boto3.client("s3", region_name=DYNAMODB_REGION)
ddb = boto3.resource("dynamodb", region_name=DYNAMODB_REGION)
table = ddb.Table(DYNAMODB_TABLE)
_LAST_PIPELINE_STATUS = "STARTING"
_LAST_PIPELINE_PROGRESS = 0

PIPELINE_STEPS = [
    {"name": "download", "label": "Downloading video", "start": 0, "end": 3, "statuses": ["STARTING"]},
    {"name": "audio_extraction", "label": "Extracting audio", "start": 3, "end": 12, "statuses": ["EXTRACTING"]},
    {"name": "transcription", "label": "Transcribing speech", "start": 12, "end": 28, "statuses": ["TRANSCRIBING"]},
    {"name": "translation", "label": "Translating text", "start": 28, "end": 48, "statuses": ["TRANSLATING"]},
    {"name": "voice_generation", "label": "Cloning voice", "start": 48, "end": 65, "statuses": ["CLONING"]},
    {"name": "lip_sync", "label": "Running lip sync", "start": 65, "end": 82, "statuses": ["LIPSYNC"]},
    {"name": "video_merge", "label": "Merging & generating SRT", "start": 82, "end": 88, "statuses": ["MERGING"]},
    {"name": "upload", "label": "Uploading to cloud", "start": 88, "end": 100, "statuses": ["UPLOADING"]},
]

DEFAULT_SPEAKER_LABEL = "SPEAKER_UNKNOWN"
# (Phase 1: TAIL_FADE_SECONDS removed.  Hard-cut + fade was replaced with
#  silence-only tail trim in fit_audio_to_duration / assemble_dubbed_audio.)


def _stage_local_progress(progress: int, start: int, end: int) -> int:
    if end <= start:
        return 0
    return max(0, min(100, int((progress - start) / (end - start) * 100)))


def _stage_snapshot(status: str, progress: int, step: str) -> list[dict]:
    stage_status_key = _LAST_PIPELINE_STATUS if status == "FAILED" else status
    status_index = next(
        (idx for idx, item in enumerate(PIPELINE_STEPS) if stage_status_key in item["statuses"]),
        len(PIPELINE_STEPS) if status == "DONE" else -1,
    )
    snapshot: list[dict] = []
    for idx, item in enumerate(PIPELINE_STEPS):
        label = item["label"]
        if item["name"] == "voice_generation" and not VOICE_CLONE:
            label = "Generating voice"
        if item["name"] == "lip_sync" and not LIP_SYNC:
            snapshot.append({
                "name": item["name"],
                "label": label,
                "status": "skipped",
                "progress": 100,
                "message": "Lip sync disabled for this job.",
            })
            continue

        current = stage_status_key in item["statuses"]
        if status == "DONE" or idx < status_index:
            stage_status = "completed"
            stage_progress = 100
        elif status == "FAILED" and (current or idx == max(0, status_index)):
            stage_status = "failed"
            stage_progress = _stage_local_progress(progress, item["start"], item["end"])
        elif current:
            stage_status = "running"
            stage_progress = _stage_local_progress(progress, item["start"], item["end"])
        else:
            stage_status = "pending"
            stage_progress = 0

        snapshot.append({
            "name": item["name"],
            "label": label,
            "status": stage_status,
            "progress": stage_progress,
            "message": step if current or stage_status == "failed" else "",
        })
    return snapshot


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# DynamoDB progress helpers
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _ddb_safe(value):
    """
    Coerce a value into something the boto3 DynamoDB *resource* serializer
    accepts.  The resource API rejects Python ``float`` outright
    (``TypeError: Float types are not supported. Use Decimal types instead``),
    so any float — including 0.0 and values nested inside dicts/lists — must be
    converted to ``Decimal`` before it reaches ``table.update_item``.  Doing
    this centrally means callers can pass plain floats (e.g. round(x, 3)) and
    a single missed conversion can never silently abort the whole status write.
    """
    if isinstance(value, bool):
        return value  # bool is a subclass of int — keep it a BOOL, not a number
    if isinstance(value, float):
        if not math.isfinite(value):
            return None  # NaN/Inf are not representable in DynamoDB
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _ddb_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_ddb_safe(v) for v in value]
    return value


def update_progress(status: str, progress: int, step: str, extra: Optional[dict] = None):
    """Write progress to DynamoDB so the frontend can poll it."""
    try:
        global _LAST_PIPELINE_STATUS, _LAST_PIPELINE_PROGRESS
        if status != "FAILED":
            _LAST_PIPELINE_STATUS = status
            _LAST_PIPELINE_PROGRESS = progress
        # Sanitize floats → Decimal so a numeric extra (e.g. outputDurationSeconds)
        # can never abort the DDB write — see _ddb_safe.
        extra = {k: _ddb_safe(v) for k, v in (extra or {}).items()}
        now_ms = int(time.time() * 1000)
        stage_snapshot = _stage_snapshot(status, progress, step)
        item = {
            "status": status,
            "progress": progress,
            "step": step,
            "stepsJson": json.dumps(stage_snapshot, ensure_ascii=False),
            "updatedAt": now_ms,
            **extra,
        }
        table.update_item(
            Key={"jobId": JOB_ID},
            UpdateExpression=(
                "SET #s = :s, #p = :p, #st = :st, #steps = :steps, #ua = :ua"
                + ("".join(f", #{k} = :{k}" for k in extra))
            ),
            ExpressionAttributeNames={
                "#s": "status", "#p": "progress", "#st": "step", "#steps": "stepsJson", "#ua": "updatedAt",
                **{f"#{k}": k for k in extra},
            },
            ExpressionAttributeValues={
                ":s": status, ":p": progress, ":st": step,
                ":steps": item["stepsJson"],
                ":ua": item["updatedAt"],
                **{f":{k}": v for k, v in extra.items()},
            },
        )
        log.info(f"[DDB] {status} {progress}% â€” {step}")
    except Exception as e:
        log.warning(f"[DDB] Failed to update progress: {e}")


def mark_failed(error: str):
    log.error(f"[FATAL] Job failed: {error}")
    # Determine which pipeline stage failed based on the last known status.
    # This gives the frontend a clear "Failed at: Voice Cloning" instead of
    # the confusing "FAILED 65%" display.
    failed_stage = "unknown"
    for item in PIPELINE_STEPS:
        if _LAST_PIPELINE_STATUS in item["statuses"]:
            failed_stage = item["name"]
            break
    # We send the technical error to the 'step' field so it shows up prominently in the UI,
    # and also to a dedicated 'error' field for the API.
    update_progress("FAILED", _LAST_PIPELINE_PROGRESS, f"Error: {error}", {
        "error": error,
        "failedStage": failed_stage,
    })


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# S3 helpers
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def download_from_s3(key: str, dest: Path) -> Path:
    log.info(f"[S3] Downloading s3://{S3_BUCKET}/{key} â†’ {dest}")
    s3.download_file(S3_BUCKET, key, str(dest))
    return dest


def upload_to_s3(local_path: Path, key: str, content_type: str = "application/octet-stream"):
    log.info(f"[S3] Uploading {local_path} â†’ s3://{S3_BUCKET}/{key}")
    s3.upload_file(
        str(local_path), S3_BUCKET, key,
        ExtraArgs={"ContentType": content_type},
    )
    return key


def presigned_url(key: str, expires: int = 3600) -> str:
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=expires,
    )


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# FFmpeg helpers
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def run_ffmpeg(*args, check: bool = True, timeout: Optional[int] = None):
    cmd = ["ffmpeg", "-y", *args]
    log.info(f"[FFmpeg] {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout or FFMPEG_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg binary is not installed or not available on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        stderr = (exc.stderr or "")[-2000:]
        raise RuntimeError(
            f"FFmpeg timed out after {timeout or FFMPEG_TIMEOUT_SECONDS}s. "
            f"Command: {' '.join(cmd)}\n{stderr}"
        ) from exc
    if check and result.returncode != 0:
        raise RuntimeError(
            f"FFmpeg failed with exit {result.returncode}. "
            f"Command: {' '.join(cmd)}\n{result.stderr[-3000:]}"
        )
    return result


def run_ffprobe(*args, check: bool = True, timeout: Optional[int] = None):
    cmd = ["ffprobe", *args]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout or FFPROBE_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffprobe binary is not installed or not available on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        stderr = (exc.stderr or "")[-1000:]
        raise RuntimeError(
            f"ffprobe timed out after {timeout or FFPROBE_TIMEOUT_SECONDS}s. "
            f"Command: {' '.join(cmd)}\n{stderr}"
        ) from exc
    if check and result.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed with exit {result.returncode}. "
            f"Command: {' '.join(cmd)}\n{result.stderr[-2000:]}"
        )
    return result


def video_has_audio_stream(video_path: Path) -> bool:
    result = run_ffprobe(
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        str(video_path),
    )
    return bool(result.stdout.strip())


def extract_audio(
    video_path: Path,
    out_dir: Path,
    sample_rate: int = 16000,
    mono: bool = True,
    label: str = "audio_full",
) -> Path:
    """Extract audio as WAV at the requested sample rate."""
    if not video_has_audio_stream(video_path):
        raise RuntimeError("Input video has no audio stream; video translation requires spoken audio.")

    wav_path = out_dir / f"{label}_{sample_rate}hz.wav"
    channel_args = ["-ac", "1"] if mono else []
    run_ffmpeg(
        "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le",
        "-ar", str(sample_rate),
        *channel_args,
        str(wav_path),
    )
    if not wav_path.exists() or wav_path.stat().st_size == 0:
        raise RuntimeError(f"Audio extraction produced no WAV output at {wav_path}.")
    return wav_path


def resample_audio(audio_path: Path, out_path: Path, sample_rate: int = 16000, mono: bool = True) -> Path:
    """Resample audio to a target sample rate for ASR/TTS."""
    channel_args = ["-ac", "1"] if mono else []
    run_ffmpeg(
        "-i", str(audio_path),
        "-acodec", "pcm_s16le",
        "-ar", str(sample_rate),
        *channel_args,
        str(out_path),
    )
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError(f"Audio resample produced no WAV output at {out_path}.")
    return out_path


def get_video_duration(video_path: Path) -> float:
    result = run_ffprobe(
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    )
    raw = result.stdout.strip()
    try:
        duration = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"Could not read video duration from ffprobe output: {raw!r}") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"Invalid video duration from ffprobe: {duration!r}")
    return duration


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 1: Demucs vocal separation (optional)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def run_demucs(audio_path: Path, out_dir: Path) -> tuple[Path, Path]:
    """
    Separate vocals from background using Demucs htdemucs model.
    Returns (vocals_path, background_path).
    """
    import torch
    from demucs.apply import apply_model
    from demucs.audio import AudioFile, save_audio
    from demucs.pretrained import get_model

    log.info("[Demucs] Separating vocals from background...")
    model = get_model("htdemucs")
    model.eval()
    if torch.cuda.is_available():
        model.cuda()

    wav = AudioFile(audio_path).read(streams=0, samplerate=model.samplerate, channels=model.audio_channels)
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()

    with torch.no_grad():
        sources = apply_model(model, wav[None], device="cuda" if torch.cuda.is_available() else "cpu")[0]

    sources = sources * ref.std() + ref.mean()

    stem_names = model.sources
    vocals_idx = stem_names.index("vocals")
    other_indices = [i for i in range(len(stem_names)) if i != vocals_idx]

    vocals_path = out_dir / "vocals.wav"
    bg_path     = out_dir / "background.wav"

    save_audio(sources[vocals_idx], str(vocals_path), model.samplerate)

    # Mix all non-vocal stems together
    bg_mix = sources[other_indices[0]]
    for i in other_indices[1:]:
        bg_mix = bg_mix + sources[i]
    bg_mix = bg_mix / len(other_indices)
    save_audio(bg_mix, str(bg_path), model.samplerate)

    del model, wav, sources
    import torch; torch.cuda.empty_cache()

    log.info(f"[Demucs] Done. vocals={vocals_path}, bg={bg_path}")
    return vocals_path, bg_path


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 2: Transcription (AssemblyAI)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ASSEMBLYAI_LANG_MAP = {
    "hi": "hi", "en": "en", "es": "es", "fr": "fr", "de": "de",
    "it": "it", "pt": "pt", "nl": "nl", "ja": "ja", "ko": "ko",
    "zh": "zh", "ru": "ru", "tr": "tr",
}

def transcribe(audio_path: Path) -> list[dict]:
    """
    Transcribe audio to word-level timestamped segments using AssemblyAI.
    Groups words into sentences/segments by pauses.
    Returns list of: { id, start, end, text, words: [{word, start, end}] }
    """
    global SOURCE_LANG_CODE
    import assemblyai as aai

    if not ASSEMBLYAI_API_KEY:
        raise ValueError("ASSEMBLYAI_API_KEY environment variable is not set.")

    aai.settings.api_key = ASSEMBLYAI_API_KEY

    log.info(f"[AssemblyAI] Uploading and transcribing {audio_path.name}...")
    transcriber = aai.Transcriber()
    config_args = {"speaker_labels": MULTI_SPEAKER}

    # Use the resolved language code (not display name) for the AssemblyAI lookup.
    # SOURCE_LANG may be a display name like "English"; SOURCE_LANG_CODE is "en".
    _src_code = SOURCE_LANG_CODE or SOURCE_LANG.lower().strip()
    if SOURCE_LANG != "auto" and _src_code in ASSEMBLYAI_LANG_MAP:
        config_args["language_code"] = ASSEMBLYAI_LANG_MAP[_src_code]
    else:
        config_args["language_detection"] = True

    config = aai.TranscriptionConfig(**config_args)
    transcript = transcriber.transcribe(str(audio_path), config)

    if transcript.error:
        raise RuntimeError(f"AssemblyAI error: {transcript.error}")

    detected_code = transcript.json_response.get('language_code')
    if detected_code:
        SOURCE_LANG_CODE = detected_code
    log.info(f"[AssemblyAI] Transcribed. Detected language: {detected_code or 'unknown'}")

    # ── Helper: build segments from a flat word list (single-speaker path) ──────
    def _build_segments_from_words(word_list, speaker_label: Optional[str] = None) -> list[dict]:
        if not word_list:
            return []
        max_words = 6
        max_duration = 5.0
        gap_break = 0.45
        terminal_punctuation = re.compile(r"[.!?।！？]$")
        segs: list[dict] = []
        cur_words: list[dict] = []
        seg_start_t = word_list[0].start / 1000.0

        def flush(end_t):
            nonlocal cur_words
            if not cur_words:
                return
            text = " ".join(w["word"] for w in cur_words).strip()
            if text:
                entry: dict = {
                    "id": len(segs) + 1,
                    "start": seg_start_t,
                    "end": end_t,
                    "text": text,
                    "words": cur_words,
                }
                if speaker_label:
                    entry["speaker"] = speaker_label
                segs.append(entry)
            cur_words = []

        for w in word_list:
            w_start = w.start / 1000.0
            w_end   = w.end   / 1000.0
            if cur_words:
                prev_end = cur_words[-1]["end"]
                gap = w_start - prev_end
                dur = w_start - seg_start_t
                prev_word = str(cur_words[-1].get("word", "")).strip()
                if (
                    len(cur_words) >= max_words
                    or gap > gap_break
                    or dur >= max_duration
                    or terminal_punctuation.search(prev_word)
                ):
                    flush(prev_end)
                    seg_start_t = w_start
            cur_words.append({"word": w.text, "start": w_start, "end": w_end})

        if cur_words:
            flush(cur_words[-1]["end"])
        return segs

    # Lightweight adapter so utterance words (dicts) can be passed to
    # _build_segments_from_words which expects objects with .text/.start/.end.
    class _WordAdapter:
        __slots__ = ("text", "start", "end")
        def __init__(self, d: dict):
            self.text  = d["word"]
            self.start = int(d["start"] * 1000)
            self.end   = int(d["end"]   * 1000)

    # ── Path A: multi-speaker via AssemblyAI utterances ───────────────────────
    # When speaker_labels=True AssemblyAI returns utterances each tagged with a
    # speaker letter ('A', 'B', ...).  Use these directly — this is far more
    # accurate than the separate pyannote pass and requires no HF_TOKEN.
    all_words = transcript.words or []
    utterances = getattr(transcript, "utterances", None) or []

    if MULTI_SPEAKER and utterances:
        segments: list[dict] = []
        for utt in utterances:
            utt_start = utt.start / 1000.0
            utt_end   = utt.end   / 1000.0
            speaker   = f"SPEAKER_{utt.speaker}"  # 'A' → 'SPEAKER_A', etc.
            text      = (utt.text or "").strip()
            if not text:
                continue

            # Collect words that belong to this utterance time window
            utt_words = [
                {"word": w.text, "start": w.start / 1000.0, "end": w.end / 1000.0}
                for w in all_words
                if utt_start - 0.05 <= w.start / 1000.0 <= utt_end + 0.05
            ]

            if utt_words:
                sub = _build_segments_from_words(
                    [_WordAdapter(w) for w in utt_words], speaker_label=speaker
                )
                for s in sub:
                    s["id"] = len(segments) + 1
                    segments.append(s)
            else:
                segments.append({
                    "id":      len(segments) + 1,
                    "start":   utt_start,
                    "end":     utt_end,
                    "text":    text,
                    "speaker": speaker,
                    "words":   utt_words,
                })

        if segments:
            log.info(
                f"[AssemblyAI] Built {len(segments)} speaker-labelled segments "
                f"from utterances (speakers: "
                f"{sorted({s['speaker'] for s in segments})})."
            )
            return segments
        # If utterances yielded nothing, fall through to word-based path
        log.warning("[AssemblyAI] Utterances were empty after filtering; falling back to word segmentation.")

    # ── Path B: word-based segmentation (single-speaker / fallback) ──────────
    # P1-19: Even for single-speaker, prefer AssemblyAI utterances as natural
    # sentence boundaries (they're more linguistically accurate than our naive
    # 0.45s-gap heuristic).  Label all utterances as SPEAKER_A.
    if not MULTI_SPEAKER and utterances:
        segments: list[dict] = []
        for utt in utterances:
            utt_start = utt.start / 1000.0
            utt_end   = utt.end   / 1000.0
            text      = (utt.text or "").strip()
            if not text:
                continue

            utt_words = [
                {"word": w.text, "start": w.start / 1000.0, "end": w.end / 1000.0}
                for w in all_words
                if utt_start - 0.05 <= w.start / 1000.0 <= utt_end + 0.05
            ]

            if utt_words:
                sub = _build_segments_from_words(
                    [_WordAdapter(w) for w in utt_words], speaker_label="SPEAKER_A"
                )
                for s in sub:
                    s["id"] = len(segments) + 1
                    segments.append(s)
            else:
                segments.append({
                    "id":      len(segments) + 1,
                    "start":   utt_start,
                    "end":     utt_end,
                    "text":    text,
                    "speaker": "SPEAKER_A",
                    "words":   utt_words,
                })

        if segments:
            log.info(
                f"[AssemblyAI] Built {len(segments)} segments from utterances "
                f"(single-speaker mode, P1-19)."
            )
            return segments
        log.warning("[AssemblyAI] Utterances empty in single-speaker mode; falling back to word segmentation.")

    if not all_words:
        return []

    segments = _build_segments_from_words(all_words)
    log.info(f"[AssemblyAI] Grouped into {len(segments)} segments.")
    return segments


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 2b: Optional speaker diarization (pyannote)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def diarize(audio_path: Path, segments: list[dict], override_existing: bool = False) -> list[dict]:
    """
    Tag each segment with a speaker label using pyannote 3.1.
    Requires HF_TOKEN env var for gated model access.
    """
    try:
        # Check HF_TOKEN FIRST before any pip install — pyannote.audio is a heavy
        # package (~1 GB of deps) and takes 30-60 s to install.  Every voice-clone
        # job wasted that time before because the token check came AFTER the install.
        hf_token = os.environ.get("HF_TOKEN", "")
        if not hf_token:
            log.info("[Diarize] HF_TOKEN not set — skipping pyannote diarization "
                     "(AssemblyAI utterances already provide speaker labels).")
            return segments

        # Only reach here if HF_TOKEN is set — install pyannote lazily
        if (
            importlib.util.find_spec("pyannote") is None
            or importlib.util.find_spec("pyannote.audio") is None
        ):
            import subprocess as _spp, sys as _sysp
            _spp.run([_sysp.executable, '-m', 'pip', 'install',
                      '--quiet', '--prefer-binary', 'pyannote.audio>=3.1.0'], check=True)

        import torch
        from pyannote.audio import Pipeline

        log.info("[Diarize] Running pyannote speaker diarization...")
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
        device = "cuda" if torch.cuda.is_available() else "cpu"
        pipeline.to(torch.device(device))

        diarization = pipeline(str(audio_path))

        # Tag each segment with its dominant speaker by maximum overlap,
        # not just midpoint — handles speaker changes inside a segment correctly.
        from collections import defaultdict as _dd
        for seg in segments:
            # Skip segments that already have a reliable speaker label from AssemblyAI
            if (
                not override_existing
                and seg.get("speaker")
                and seg["speaker"] != DEFAULT_SPEAKER_LABEL
            ):
                continue
            overlap_scores: dict = _dd(float)
            for turn, _, spk in diarization.itertracks(yield_label=True):
                overlap = max(
                    0.0,
                    min(seg["end"], turn.end) - max(seg["start"], turn.start),
                )
                if overlap > 0:
                    overlap_scores[spk] += overlap
            if overlap_scores:
                seg["speaker"] = max(overlap_scores, key=overlap_scores.get)
            elif "speaker" not in seg:
                seg["speaker"] = DEFAULT_SPEAKER_LABEL

        del pipeline
        torch.cuda.empty_cache()
        log.info("[Diarize] Done.")
    except Exception as e:
        log.warning(f"[Diarize] Failed: {e}")
    return segments


def _effective_speaker_labels(segments: list[dict]) -> list[str]:
    labels: set[str] = set()
    for seg in segments:
        label = str(seg.get("speaker", "")).strip()
        if label and label != DEFAULT_SPEAKER_LABEL:
            labels.add(label)
    return sorted(labels)


def _all_speaker_labels(segments: list[dict]) -> list[str]:
    labels: set[str] = set()
    for seg in segments:
        label = str(seg.get("speaker", "")).strip()
        if label:
            labels.add(label)
    return sorted(labels)


def collapse_speaker_label_noise(segments: list[dict]) -> list[dict]:
    """
    Collapse spurious low-coverage speaker labels into the dominant speaker.

    In single-speaker videos with background voices/noise, diarization may emit
    tiny runs of extra labels. Those fragments trigger per-speaker cloning and
    create audible voice hopping. If one speaker owns almost all timeline, map
    very small speaker shares back to the dominant label.
    """
    durations: dict[str, float] = {}
    for seg in segments:
        speaker = str(seg.get("speaker") or DEFAULT_SPEAKER_LABEL)
        duration = max(0.0, float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)))
        durations[speaker] = durations.get(speaker, 0.0) + duration

    total = sum(durations.values())
    if total <= 0 or len(durations) <= 1:
        return segments

    dominant_speaker = max(durations, key=durations.get)
    dominant_share = durations[dominant_speaker] / total
    if dominant_share < 0.75:
        return segments

    relabelled = 0
    for seg in segments:
        speaker = str(seg.get("speaker") or DEFAULT_SPEAKER_LABEL)
        speaker_share = durations.get(speaker, 0.0) / total
        if speaker != dominant_speaker and speaker_share < 0.08:
            seg["speaker"] = dominant_speaker
            relabelled += 1

    if relabelled:
        log.info(
            "[Diarize] Collapsed %s low-share speaker segments to dominant label %s (share=%.2f).",
            relabelled,
            dominant_speaker,
            dominant_share,
        )
    return segments

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2c: Per-speaker voice reference extraction
# ─────────────────────────────────────────────────────────────────────────────

def extract_speaker_reference(
    audio_path: Path,
    segments: list[dict],
    out_dir: Path,
    max_ref_duration: float = 10.0,
    min_segment_duration: float = 1.5,
) -> tuple[dict, dict]:
    """
    Build one clean reference WAV per unique speaker from the source audio.
    Returns ({speaker_label: Path}, {speaker_label: prompt_text}) for per-speaker cloning.

    Phase 3 (P1-5): Reference capped at 10s (was 24s).  Prefers the single
    longest clean clip rather than concatenating fragments.  Shorter, cleaner
    references produce better speaker embeddings — upstream recommends 5-10s.
    """
    import numpy as np
    import soundfile as sf
    import librosa

    speaker_refs: dict = {}
    speaker_prompt_texts: dict = {}

    try:
        full_audio, sr = sf.read(str(audio_path))
        if full_audio.ndim > 1:
            full_audio = full_audio.mean(axis=1)
    except Exception as exc:
        log.warning(f"[SpeakerRef] Could not read audio: {exc}")
        return speaker_refs, speaker_prompt_texts

    # Group segments by speaker
    speaker_map: dict = {}
    for seg in segments:
        spk = (seg.get("speaker") or DEFAULT_SPEAKER_LABEL)
        speaker_map.setdefault(spk, []).append(seg)

    for spk, spk_segs in speaker_map.items():
        # Score by duration * energy to prefer clean, loud segments
        scored: list[tuple[dict, float, float]] = []
        audio_cache: dict[int, np.ndarray] = {}
        for seg in spk_segs:
            dur = seg["end"] - seg["start"]
            if dur < min_segment_duration:
                continue
            s_idx = max(0, int(seg["start"] * sr))
            e_idx = min(len(full_audio), int(seg["end"] * sr))
            if e_idx <= s_idx:
                continue
            seg_audio = full_audio[s_idx:e_idx]
            if seg_audio.size == 0:
                continue
            trimmed, _ = librosa.effects.trim(seg_audio, top_db=40)
            if len(trimmed) < int(min_segment_duration * sr):
                continue
            energy = float(np.sqrt(np.mean(trimmed ** 2)))
            audio_cache[int(seg.get("id", len(audio_cache)))] = trimmed
            scored.append((seg, dur, energy))

        by_score = sorted(
            scored,
            key=lambda item: (item[1] * (item[2] + 1e-8), item[1]),
            reverse=True,
        )

        clips: list = []
        total_dur: float = 0.0
        for seg, dur, _energy in by_score:
            clips.append(seg)
            total_dur += dur
            if total_dur >= max_ref_duration:
                break

        # Fallback: take any segment if none are long enough
        if not clips:
            clips = sorted(spk_segs, key=lambda s: s["end"] - s["start"], reverse=True)[:3]

        if not clips:
            log.warning(f"[SpeakerRef] No usable clips for {spk}; using full audio.")
            speaker_refs[spk] = audio_path
            prompt_fallback = " ".join(
                str(s.get("text", "")).strip()
                for s in sorted(spk_segs, key=lambda s: s["start"])
                if str(s.get("text", "")).strip()
            ).strip()
            speaker_prompt_texts[spk] = normalize_tts_text(prompt_fallback)[:300] if prompt_fallback else ""
            continue

        ordered_clips = sorted(clips, key=lambda s: s["start"])
        prompt_text = " ".join(
            str(s.get("text", "")).strip()
            for s in ordered_clips
            if str(s.get("text", "")).strip()
        ).strip()
        speaker_prompt_texts[spk] = normalize_tts_text(prompt_text)[:300] if prompt_text else ""

        # Concatenate selected clips into one reference (chronological order)
        chunks: list = []
        for seg in ordered_clips:
            cached = audio_cache.get(int(seg.get("id", -1)))
            if cached is not None and len(cached) > 0:
                chunks.append(cached)
                continue
            s_idx = max(0, int(seg["start"] * sr))
            e_idx = min(len(full_audio), int(seg["end"] * sr))
            if e_idx > s_idx:
                chunks.append(full_audio[s_idx:e_idx])

        if not chunks:
            log.warning(f"[SpeakerRef] Empty chunks for {spk}; using full audio.")
            speaker_refs[spk] = audio_path
            continue

        ref_data = np.concatenate(chunks)
        # Trim to max_ref_duration samples
        ref_data = ref_data[: int(max_ref_duration * sr)]

        ref_path = out_dir / f"speaker_ref_{spk}.wav"
        sf.write(str(ref_path), ref_data, sr)
        speaker_refs[spk] = ref_path
        log.info(
            f"[SpeakerRef] {spk}: {len(chunks)} clip(s), "
            f"{len(ref_data)/sr:.1f}s reference → {ref_path.name}"
        )

    return speaker_refs, speaker_prompt_texts


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — Pacing primitives
# ─────────────────────────────────────────────────────────────────────────────
#
# We treat dub pacing as a duration-allocation problem instead of a panic-fit
# afterthought. There are three primitives:
#
#   1. CHARS_PER_SEC[lang]  — empirical natural speaking rate by language
#      (chars / second of natural speech, sourced from native speaker
#      averages).  Used to predict how long a translated string will sound.
#
#   2. predict_segment_speech_seconds(text, lang, base_rate)
#      Returns the heuristic spoken duration of `text` at speaking_rate=1.0.
#      Used BEFORE synthesis so we can pick a CosyVoice `speed=` value.
#
#   3. compute_target_speech_seconds(seg)
#      Returns the duration the dub *should* occupy.  This is NOT just
#      (end - start): it subtracts a small safety pad and clamps to a
#      reasonable minimum.  Cooperates with the post-synthesis QA retry.
#
# These are all pure functions and have no global side effects.  They are
# the foundation Phase 2 / Phase 3 work also depends on.

# Empirical chars-per-second of natural speech for each supported target
# language.  Values calibrated against native-speaker test recordings.
# These are deliberately on the slightly LOW side so the predicted duration
# is a slight over-estimate, which encourages CosyVoice to slow down a hair
# rather than rush — natural-sounding dubbing leans calm, not breathless.
CHARS_PER_SEC: dict[str, float] = {
    # Indo-Aryan / Devanagari languages — relatively slow per character due
    # to longer compound glyphs and inherent vowels.
    "hi": 13.5, "mr": 13.5, "ne": 13.5, "sa": 12.5,
    # Indic non-Devanagari
    "or": 12.5, "bn": 13.0, "pa": 13.5, "gu": 13.5,
    "ta": 11.5, "te": 12.5, "kn": 12.5, "ml": 11.5, "ur": 13.0,
    # European Latin-script languages — fast per character
    "en": 16.5, "es": 17.5, "fr": 16.5, "de": 15.5, "it": 17.0,
    "pt": 17.0, "nl": 16.0, "pl": 15.5, "tr": 15.5,
    # CJK — characters carry more meaning, so chars-per-second is lower
    "ja": 9.0, "ko": 10.5, "zh": 8.0,
    # Cyrillic
    "ru": 14.5, "uk": 14.5,
    # Arabic-derived
    "ar": 14.0,
    # SE Asian
    "vi": 15.0, "id": 15.5, "fil": 15.5, "fi": 15.0,
}
DEFAULT_CHARS_PER_SEC = 15.0

# Minimum safety pad subtracted from the segment slot when computing the
# target speech duration. Prevents back-to-back collisions and gives the
# crossfade pass (Phase 4) headroom.
TARGET_SLOT_SAFETY_PAD_SECONDS = 0.10

# Hard floor on per-segment target duration. Below this CosyVoice produces
# unnatural micro-utterances regardless of speed=.
TARGET_SLOT_MIN_SECONDS = 0.45

# ── Pause-aware pacing (the "artificial speed" fix) ───────────────────────────
# The dominant cause of rushed / chipmunk dubbing was sizing the dub to the
# *phonation-only* duration (the time the original speaker was actually
# vocalising) instead of the natural time slot available before the next line
# begins.  Translations — especially English→Indic — expand 30-60%, so forcing
# the longer translated line into the shorter phonation window pushed CosyVoice
# to speed= 1.20 and then the timing pass to atempo 1.10 (≈1.32× = unnatural).
#
# A real subtitle slot almost always has trailing silence (the speaker paused
# before the next sentence).  We let the dub reclaim a bounded amount of that
# pause so the voice keeps its natural rate.  GAP_REUSE_MAX_SECONDS caps how
# much of the following silence a segment may borrow — enough to absorb normal
# translation expansion, but not so much that the dub bleeds across a long
# deliberate pause or that Gemini's character budget balloons.
GAP_REUSE_MAX_SECONDS = 0.75


def chars_per_second_for_target() -> float:
    """Lookup CHARS_PER_SEC for the configured TARGET_LANG_CODE."""
    code = (TARGET_LANG_CODE or "").lower().strip()
    if code in CHARS_PER_SEC:
        return CHARS_PER_SEC[code]
    # Fall back to the prefix (e.g. 'zh-CN' -> 'zh') before the default.
    prefix = code.split("-", 1)[0] if "-" in code else code
    if prefix in CHARS_PER_SEC:
        return CHARS_PER_SEC[prefix]
    return DEFAULT_CHARS_PER_SEC


def _count_speakable_chars(text: str) -> int:
    """
    Count characters that contribute to spoken duration.
    Excludes whitespace and standalone punctuation; keeps letter/digit/CJK runs.
    """
    if not text:
        return 0
    # Strip whitespace then drop pure-punctuation runs but keep word internals.
    cleaned = re.sub(r"\s+", "", text)
    # Drop characters that are purely punctuation (Unicode category P*).
    # Doing this with a regex avoids a `unicodedata` per-char loop on 200-seg jobs.
    cleaned = re.sub(r"[\.\,\;\:\!\?\-\—\–\(\)\[\]\{\}\"'`\u0964\u00BF\u00A1。、，：；！？「」『』《》（）]+", "", cleaned)
    return len(cleaned)


def predict_segment_speech_seconds(
    text: str,
    speaking_rate: float = 1.0,
    chars_per_sec: Optional[float] = None,
) -> float:
    """
    Heuristic predicted spoken duration of `text` at the given speaking_rate.
    Chosen to slightly over-estimate so CosyVoice errs on the calm side.
    """
    cps = float(chars_per_sec) if chars_per_sec else chars_per_second_for_target()
    char_count = _count_speakable_chars(text)
    if char_count <= 0 or cps <= 0:
        return 0.0
    rate = float(speaking_rate) if speaking_rate and speaking_rate > 0 else 1.0
    # rate > 1.0 means faster speech = shorter duration.
    return char_count / (cps * rate)


def compute_target_speech_seconds(seg: dict) -> float:
    """
    Return the duration the dubbed audio for this segment should occupy.

    Pause-aware pacing (primary path): when annotate_dub_windows() has run it
    stores ``dub_window_seconds`` on every segment — the natural time available
    before the next line begins (its own slot plus a bounded reuse of the
    following silence).  Sizing the dub to that window is what keeps CosyVoice
    speaking at a natural rate instead of being sped up to cram a longer
    translation into the phonation-only window.  Translation char budgets, the
    CosyVoice speed= solver, the post-synthesis QA gate and the timing-fit pass
    all read this same value so they agree on one target.

    Legacy/unit-test fallback: when no window has been annotated (e.g. callers
    that build a bare segment dict) we fall back to the merged-segment
    ``speech_duration`` clamped into the slot, then to (end - start) minus a
    small safety pad.
    """
    window = seg.get("dub_window_seconds")
    if isinstance(window, (int, float)) and math.isfinite(window) and window > 0:
        return max(TARGET_SLOT_MIN_SECONDS, float(window))

    speech_duration = seg.get("speech_duration")
    slot_duration = float(seg.get("end", 0)) - float(seg.get("start", 0))
    if not isinstance(speech_duration, (int, float)) or speech_duration <= 0:
        speech_duration = slot_duration
    speech_duration = float(speech_duration)
    # Never let the speech budget exceed the slot — the dub must fit.
    target = min(float(speech_duration), float(slot_duration) - TARGET_SLOT_SAFETY_PAD_SECONDS)
    if not math.isfinite(target):
        return TARGET_SLOT_MIN_SECONDS
    return max(TARGET_SLOT_MIN_SECONDS, target)


def annotate_dub_windows(segments: list[dict], video_duration: float) -> list[dict]:
    """
    Stamp each segment with ``dub_window_seconds`` — the natural amount of time
    the dubbed line may occupy before the next line must start.

    window = own_slot + min(gap_to_next, GAP_REUSE_MAX_SECONDS) - safety_pad

    By reclaiming a bounded slice of the trailing pause, a translation that is
    30-60% longer than the source can still be spoken at a natural rate.  The
    cap (GAP_REUSE_MAX_SECONDS) keeps deliberate pauses intact and stops the
    translation character budget from ballooning.  Must run AFTER
    merge_segments_for_dubbing() and BEFORE translation so every downstream
    stage (Gemini budget, speed solver, QA, timing-fit) shares one target.
    """
    if not segments:
        return segments

    n = len(segments)
    valid_video_duration = (
        float(video_duration)
        if isinstance(video_duration, (int, float)) and math.isfinite(video_duration) and video_duration > 0
        else None
    )

    for i, seg in enumerate(segments):
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", 0.0))
        slot = max(0.0, end - start)

        if i + 1 < n:
            next_start = float(segments[i + 1].get("start", end))
        elif valid_video_duration is not None:
            next_start = valid_video_duration
        else:
            next_start = end

        gap = max(0.0, next_start - end)
        usable_gap = min(gap, GAP_REUSE_MAX_SECONDS)
        window = slot + usable_gap - TARGET_SLOT_SAFETY_PAD_SECONDS
        seg["dub_window_seconds"] = max(TARGET_SLOT_MIN_SECONDS, window)

    return segments


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2d: Merge micro-segments for TTS quality
# ─────────────────────────────────────────────────────────────────────────────

def _segment_speech_duration(seg: dict) -> float:
    """
    Return how much *speech* (not silence) lives inside this segment.

    Prefers the AssemblyAI word-level [start, end] timestamps because they
    reflect actual phonation; falls back to the segment's slot duration when
    word data is not available.
    """
    words = seg.get("words") or []
    if isinstance(words, list) and words:
        try:
            return max(0.0, float(words[-1]["end"]) - float(words[0]["start"]))
        except (KeyError, TypeError, ValueError):
            pass
    return max(0.0, float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)))


def merge_segments_for_dubbing(segments: list[dict]) -> list[dict]:
    """
    Merge micro-segments before translation/TTS to prevent choppy voice output.
    Sub-second segments are poison for TTS — a voice model cannot naturally
    synthesize speech into 0.1-0.8 second slots.

    Per-language merge thresholds (P1-18):
      Indic targets expand 30-60% over English source text.  Merging too
      aggressively creates mega-segments that CosyVoice must then rush
      through.  We tune the thresholds per target language family:
        - Indic (hi/mr/bn/ta/te/etc): max 7.5 s, gap ≤ 0.8 s normally,
          or ≤ 1.2 s for short segments; target 3-5 s
        - CJK (zh/ja/ko): max 7.5 s, gap ≤ 1.0 s normally, or ≤ 1.4 s
          for short segments; target 3-5 s
        - Latin/European (en/es/fr/de/etc): max 8.5 s, gap ≤ 1.2 s, target 3-6 s

    Respects speaker labels — never merges different speakers.

    Emits 'speech_duration' on every merged segment: the sum of the source
    spoken time, excluding any inter-segment silence we merged across.  This
    is what compute_target_speech_seconds() / synthesize_segments_cosyvoice()
    use to size the dub.  Without it, two short segments separated by a 1 s
    pause would otherwise stretch their dub into the silence and push the
    timing layer into emergency atempo.
    """
    if not segments:
        return segments

    # ── Per-language merge parameters ─────────────────────────────────────
    # Indic languages produce longer text for the same meaning, so we keep
    # merged segments shorter to avoid brutal speed-ups in the timing layer.
    _INDIC_CODES = {"hi", "mr", "ne", "sa", "bn", "pa", "gu", "or", "ta", "te", "kn", "ml", "ur"}
    _CJK_CODES = {"zh", "ja", "ko"}

    target_code = (TARGET_LANG_CODE or "").lower().strip()

    if target_code in _INDIC_CODES:
        max_merged_dur = 7.5      # keep Gemini/TTS units near subtitle timing
        gap_limit_short = 1.2     # was 2.4 — don't merge across long pauses
        gap_limit_normal = 0.8    # was 1.2 — tighter for normal segments
        short_threshold = 1.4     # was 1.6 — be slightly more eager to merge very short segs
        merge_trigger_dur = 2.5   # was 2.8 — merge sooner so we don't get too many micro-segs
    elif target_code in _CJK_CODES:
        max_merged_dur = 7.5
        gap_limit_short = 1.4
        gap_limit_normal = 1.0
        short_threshold = 1.5
        merge_trigger_dur = 2.5
    else:
        # Latin/European — keep closer to original thresholds
        max_merged_dur = 8.5
        gap_limit_short = 2.0     # slightly tighter than original 2.4
        gap_limit_normal = 1.2
        short_threshold = 1.6
        merge_trigger_dur = 2.8

    original_count = len(segments)
    merged: list[dict] = []
    buf: dict | None = None

    for seg in segments:
        if buf is None:
            buf = dict(seg)
            buf["speech_duration"] = _segment_speech_duration(seg)
            continue

        gap = float(seg["start"]) - float(buf["end"])
        buf_dur = float(buf["end"]) - float(buf["start"])
        seg_dur = float(seg["end"]) - float(seg["start"])
        word_count = len(str(buf.get("text", "")).split())
        merged_dur = float(seg["end"]) - float(buf["start"])
        short_segment = buf_dur < short_threshold or seg_dur < short_threshold
        gap_limit = gap_limit_short if short_segment else gap_limit_normal

        # Only merge same speaker (or when no speaker labels exist)
        buf_speaker = str(buf.get("speaker", "")).strip()
        seg_speaker = str(seg.get("speaker", "")).strip()
        same_speaker = (not buf_speaker and not seg_speaker) or (buf_speaker == seg_speaker)

        should_merge = (
            same_speaker
            and gap < gap_limit
            and merged_dur <= max_merged_dur
            and (
                buf_dur < merge_trigger_dur
                or seg_dur < merge_trigger_dur
                or word_count < 8
                or gap < 0.8
            )
        )

        if should_merge:
            buf["end"] = seg["end"]
            buf["text"] = (
                str(buf.get("text", "")).strip()
                + " "
                + str(seg.get("text", "")).strip()
            ).strip()
            buf["words"] = list(buf.get("words", [])) + list(seg.get("words", []))
            # Sum spoken time only — never the silence we just bridged.
            buf["speech_duration"] = (
                float(buf.get("speech_duration") or 0.0)
                + _segment_speech_duration(seg)
            )
        else:
            merged.append(buf)
            buf = dict(seg)
            buf["speech_duration"] = _segment_speech_duration(seg)

    if buf:
        merged.append(buf)

    # Re-index segment IDs sequentially and clamp speech_duration into the slot
    # (a noisy diarization edge case can briefly produce > slot values).
    for i, seg in enumerate(merged):
        seg["id"] = i
        slot = max(0.0, float(seg["end"]) - float(seg["start"]))
        speech = float(seg.get("speech_duration") or slot)
        seg["speech_duration"] = max(0.0, min(speech, slot))

    log.info(f"[Merge] {original_count} segments -> {len(merged)} after dubbing merge.")
    return merged


END_PUNCTUATION = {".", "?", "!", "。", "？", "！", "\u0964", "；", "：", "\u0965"}  # \u0964/\u0965 = Devanagari danda/double-danda

def _terminal_punctuation() -> str:
    code = (TARGET_LANG_CODE or "").lower()
    if code in {"hi", "mr", "ne", "sa"}:
        return "\u0964"
    if code in {"zh", "ja", "ko"}:
        return "。"
    return "."

def normalize_tts_text(text: str) -> str:
    """
    Clean translated text before passing to CosyVoice/TTS.
    Prevents phoneme encoder failures from fragments, ellipses, and missing punctuation.
    """
    text = text.strip()
    if not text:
        return text
    text = re.sub(r'\.{2,}', '.', text)    # ... or .. -> .
    text = re.sub(r'\s+', ' ', text)        # collapse whitespace
    # Ensure text ends with sentence-ending punctuation
    if text[-1] not in END_PUNCTUATION:
        text += _terminal_punctuation()
    return text


# Pronunciation fixes applied BEFORE text reaches TTS.
# These are a SAFETY NET only (P1-16).  Gemini is the primary source of truth
# for acronym expansion — the system prompt already instructs it to spell out
# all acronyms in the target script (e.g. BJP → बी जे पी for Hindi).
# This regex list catches cases where Gemini failed to expand an acronym and
# left it as raw uppercase Latin letters in the tts_text.  The guard in
# normalize_tts_pronunciation() ensures we only apply these when the text
# actually contains un-expanded ASCII acronyms, so we never double-expand
# text that Gemini already correctly transliterated.
_PRONUNCIATION_REPLACEMENTS = [
    # Acronyms: space each letter so TTS reads them individually.
    (r"\bBJP\b",   "B J P"),
    (r"\bRSS\b",   "R S S"),
    (r"\bAAP\b",   "A A P"),
    (r"\bCBI\b",   "C B I"),
    (r"\bEVM\b",   "E V M"),
    (r"\bPM\b",    "P M"),
    (r"\bCM\b",    "C M"),
    (r"\bDGP\b",   "D G P"),
    (r"\bIPS\b",   "I P S"),
    (r"\bIAS\b",   "I A S"),
    (r"\bIIT\b",   "I I T"),
    (r"\bIIM\b",   "I I M"),
    (r"\bUNO\b",   "U N O"),
    (r"\bNGO\b",   "N G O"),
    (r"\bMLA\b",   "M L A"),
    (r"\bMLC\b",   "M L C"),
    (r"\bMSP\b",   "M S P"),
    # Common proper noun transliteration corrections
    (r"\bSyama\b", "Shyama"),
]

PRONUNCIATION_LANG_CODES = {"hi", "en", "mr", "ne", "sa", "bn", "ta", "te", "gu", "kn", "ml", "pa", "or", "ur"}

# Quick check: does the text contain any ALL-CAPS ASCII word of 2+ letters?
# If not, Gemini already expanded all acronyms (into native script) and we
# can skip the regex pass entirely.  This is the "safety net only" guard.
_HAS_UNEXPANDED_ACRONYM = re.compile(r"\b[A-Z]{2,}\b")


def normalize_tts_pronunciation(text: str) -> str:
    """Apply pronunciation replacements (safety-net only) then standard text cleaning.

    P1-16: Gemini is the single source of truth for acronym expansion.  The
    regex replacements fire ONLY when the tts_text still contains unexpanded
    ALL-CAPS ASCII acronyms (2+ consecutive uppercase Latin letters).  When
    Gemini correctly transliterates (e.g. BJP → बी जे पी), the regex never
    matches and the native-script text passes through untouched.
    """
    if not text:
        return text
    if (TARGET_LANG_CODE or "").lower() in PRONUNCIATION_LANG_CODES:
        # Safety-net guard: only apply regex if raw ASCII acronyms are present.
        # This prevents double-expansion of text Gemini already handled correctly.
        if _HAS_UNEXPANDED_ACRONYM.search(text):
            for pattern, replacement in _PRONUNCIATION_REPLACEMENTS:
                text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return normalize_tts_text(text)


def _find_cosyvoice_model() -> Optional[Path]:
    candidates: list[Path] = []
    for root in [
        MODELSCOPE_CACHE / "hub" / "iic",
        MODELSCOPE_CACHE / "hub" / "models" / "iic",
        MODELSCOPE_CACHE / "iic",
        MODELSCOPE_CACHE / "models" / "iic",
        MODELSCOPE_CACHE,
    ]:
        # v3 first (best quality), v2 as fallback
        for model_name in (
            "Fun-CosyVoice3-0.5B",       # Dockerfile downloads here
            "Fun-CosyVoice3-0.5B-2512",  # alternate layout
            "CosyVoice3-0.5B",           # generic v3 name
            "CosyVoice2-0.5B",           # v2 fallback
        ):
            p = root / model_name
            if p.exists():
                return p
        if root.exists():
            candidates.extend(root.glob("Fun-CosyVoice3*"))
            candidates.extend(root.glob("CosyVoice3*"))
            candidates.extend(root.glob("CosyVoice2*"))
    for candidate in candidates:
        if candidate.is_dir() and (
            (candidate / "cosyvoice2.yaml").exists()
            or (candidate / "cosyvoice.yaml").exists()
            or (candidate / "configuration.json").exists()
        ):
            return candidate
    return None


def _link_cosyvoice_legacy_path(target: Path) -> None:
    legacy = MODELSCOPE_CACHE / "hub" / "iic" / target.name
    legacy.parent.mkdir(parents=True, exist_ok=True)
    if legacy.exists() or legacy.is_symlink():
        return
    legacy.symlink_to(target.resolve(), target_is_directory=True)


def _download_cosyvoice_model() -> Optional[Path]:
    if not ALLOW_RUNTIME_MODEL_DOWNLOADS:
        return None
    log.info(f"[CosyVoice] Downloading {COSYVOICE_MODEL_ID} into {MODELSCOPE_CACHE}...")
    from modelscope import snapshot_download

    MODELSCOPE_CACHE.mkdir(parents=True, exist_ok=True)
    downloaded = Path(snapshot_download(COSYVOICE_MODEL_ID, cache_dir=str(MODELSCOPE_CACHE))).resolve()
    _link_cosyvoice_legacy_path(downloaded)
    log.info(f"[CosyVoice] Model cache ready at {downloaded}")
    return downloaded


def _ensure_cosyvoice() -> Path:
    """Verify CosyVoice repo and model weights are present in the Docker image."""
    cv_dir = MODEL_CACHE_DIR / "CosyVoice"
    if not cv_dir.exists():
        raise RuntimeError(
            f"CosyVoice repo not found at {cv_dir}. "
            "Rebuild the Docker image — the git clone step failed."
        )
    matcha_dir = cv_dir / "third_party" / "Matcha-TTS" / "matcha"
    if not matcha_dir.exists():
        raise RuntimeError(
            f"CosyVoice Matcha-TTS submodule missing at {matcha_dir}. "
            "The Dockerfile uses --recurse-submodules but the submodule may not have initialized. "
            "Rebuild the Docker image."
        )
    # Verify model weights are present (downloaded at build time via modelscope).
    # We prefer CosyVoice3, but still accept CosyVoice2 as an explicit
    # backward-compatible fallback if an old base image is still running.
    #
    # modelscope cache layout differs by version:
    #   modelscope >=1.16 → <cache>/hub/models/iic/<model>
    #   modelscope <1.16  → <cache>/hub/iic/<model>
    # The Dockerfile symlinks the legacy path → the real one, but we also
    # check both here so the worker is robust to any layout drift.
    found = _find_cosyvoice_model()
    if found is None:
        found = _download_cosyvoice_model()
    if found is None:
        raise RuntimeError(
            f"CosyVoice model weights not found under {MODELSCOPE_CACHE}/hub/(iic|models/iic)/. "
            "Expected Fun-CosyVoice3-0.5B, CosyVoice3-0.5B, or CosyVoice2-0.5B. "
            "Set ALLOW_RUNTIME_MODEL_DOWNLOADS=1 or rebuild with DOWNLOAD_MODELS_AT_BUILD=true."
        )
    log.info(f"[CosyVoice] Repo: {cv_dir}  |  Weights: {found} verified OK")
    return cv_dir


def _install_runtime_package(package: str) -> None:
    log.info(f"[RuntimeDeps] Installing {package}...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--prefer-binary", package],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Runtime install failed for {package}. pip stderr:\n{result.stderr[-2000:]}"
        )


def _import_cosyvoice_class():
    """Return the best available CosyVoice constructor.
    Priority: AutoModel (v3) → CosyVoice2 → CosyVoice (legacy).
    AutoModel auto-detects which version the weights are and is the
    official entry point for both v2 and v3.
    """
    def _try_import():
        try:
            from cosyvoice.cli.cosyvoice import AutoModel as _CosyVoice  # type: ignore
            return _CosyVoice
        except (ImportError, AttributeError):
            pass
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2 as _CosyVoice  # type: ignore
            return _CosyVoice
        except Exception:
            pass
        from cosyvoice.cli.cosyvoice import CosyVoice as _CosyVoice  # type: ignore
        return _CosyVoice

    try:
        return _try_import()
    except ModuleNotFoundError as exc:
        if exc.name != "whisper":
            raise
        _install_runtime_package("openai-whisper==20231117")
        return _try_import()


def _ensure_cosyvoice_yaml_compatibility() -> None:
    """
    CosyVoice/HyperPyYAML expects the older ruamel.yaml Loader API and a
    handful of upstream inference imports. Validate before model construction
    so dependency drift fails fast instead of wasting the whole translation job
    at "Cloning original voice".
    """
    try:
        version = importlib.metadata.version("ruamel.yaml")
    except importlib.metadata.PackageNotFoundError:
        version = ""
    hydra_available = importlib.util.find_spec("hydra") is not None
    einops_available = importlib.util.find_spec("einops") is not None
    lightning_available = importlib.util.find_spec("lightning") is not None
    pyarrow_available = importlib.util.find_spec("pyarrow") is not None
    pyworld_available = importlib.util.find_spec("pyworld") is not None
    rich_available = importlib.util.find_spec("rich") is not None
    x_transformers_available = importlib.util.find_spec("x_transformers") is not None

    def _major_minor(raw: str) -> tuple[int, int]:
        parts = raw.split(".")
        try:
            return int(parts[0]), int(parts[1])
        except Exception:
            return (999, 999)

    if (
        version
        and _major_minor(version) < (0, 18)
        and einops_available
        and hydra_available
        and lightning_available
        and pyarrow_available
        and pyworld_available
        and rich_available
        and x_transformers_available
    ):
        return

    log.warning(
        "[CosyVoice] Incompatible deps detected; ruamel.yaml=%s einops=%s hydra=%s lightning=%s pyarrow=%s pyworld=%s rich=%s x_transformers=%s. Installing compatible pins.",
        version or "missing",
        "present" if einops_available else "missing",
        "present" if hydra_available else "missing",
        "present" if lightning_available else "missing",
        "present" if pyarrow_available else "missing",
        "present" if pyworld_available else "missing",
        "present" if rich_available else "missing",
        "present" if x_transformers_available else "missing",
    )
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--quiet",
            "--prefer-binary",
            "einops==0.8.0",
            "gdown==5.1.0",
            "hydra-core==1.3.2",
            "hyperpyyaml==1.2.3",
            "lightning==2.2.4",
            "matplotlib==3.7.5",
            "phonemizer==3.3.0",
            "pyarrow==18.1.0",
            "pyworld==0.3.4",
            "rich==13.7.1",
            "ruamel.yaml>=0.17.28,<0.18.0",
            "Unidecode==1.3.8",
            "wget==3.2",
            "x-transformers==2.11.24",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Could not install CosyVoice-compatible dependencies. "
            f"pip stderr:\n{result.stderr[-2000:]}"
        )


def _verify_onnxruntime_cuda_stack() -> None:
    """Fail fast when the CosyVoice ONNX frontend cannot use CUDA.

    A CUDA-11 onnxruntime-gpu wheel inside our CUDA-12 image silently falls
    back to CPU with errors like missing libcublasLt.so.11. That makes short
    translator jobs look like CPU jobs even though torch.cuda is available.

    Also monkey-patches ``ort.InferenceSession`` to exclude TensorRT from the
    default provider list.  When TensorrtExecutionProvider is compiled into the
    ORT binary, it tries to compile TRT engines on first use (~2-3 min on T4).
    CUDAExecutionProvider is equally fast for CosyVoice's small frontend ONNX
    models, so we force CUDA-only to avoid the cold-start penalty.
    """
    try:
        import onnxruntime as ort
    except Exception as exc:
        raise RuntimeError(f"ONNXRuntime is not importable: {exc}") from exc

    providers = ort.get_available_providers()
    log.info("[ONNXRuntime] providers=%s", providers)
    if "CUDAExecutionProvider" not in providers:
        raise RuntimeError(
            "ONNXRuntime CUDAExecutionProvider is unavailable; CosyVoice "
            "frontend ONNX models would run on CPU."
        )

    # Monkey-patch InferenceSession to exclude TensorRT.  CosyVoice's frontend
    # creates sessions without specifying providers, so ORT picks TRT first
    # (highest priority in the compiled binary).  TRT engine compilation on
    # Tesla T4 takes 2-3 minutes per cold start — pure overhead since CUDA EP
    # is equally fast for these small ONNX models (~5 MB each).
    if "TensorrtExecutionProvider" in providers:
        _SAFE_PROVIDERS = [p for p in providers if p != "TensorrtExecutionProvider"]
        _OrigSession = ort.InferenceSession

        class _PatchedSession(_OrigSession):
            def __init__(self, *args, **kwargs):
                if "providers" not in kwargs:
                    kwargs["providers"] = _SAFE_PROVIDERS
                super().__init__(*args, **kwargs)

        ort.InferenceSession = _PatchedSession
        log.info(
            "[ONNXRuntime] TensorrtExecutionProvider excluded — using %s to avoid "
            "2-3 min TRT engine compilation on cold start.",
            _SAFE_PROVIDERS,
        )

    try:
        provider_lib = Path(ort.__file__).parent / "capi" / "libonnxruntime_providers_cuda.so"
        if not provider_lib.exists():
            raise RuntimeError(f"provider library missing: {provider_lib}")
        ldd = subprocess.run(
            ["ldd", str(provider_lib)],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        linked = f"{ldd.stdout}\n{ldd.stderr}"
        if "libcublasLt.so.11" in linked:
            raise RuntimeError(
                "ONNXRuntime is the CUDA-11 wheel inside a CUDA-12 image "
                "(links libcublasLt.so.11). Rebuild the translator base image "
                "with the CUDA-12 ONNXRuntime package."
            )
    except RuntimeError:
        raise
    except Exception as exc:
        log.warning("[ONNXRuntime] CUDA ABI check skipped: %s", exc)


def _patch_torch_load_for_fast_checkpoint_loading() -> None:
    """Speed up + log CosyVoice checkpoint loading on cold-start GPU jobs.

    CosyVoice's AutoModel constructor torch.load()s several multi-hundred-MB
    to multi-GB checkpoints (LLM, flow, HiFiGAN). On a cold Batch GPU
    instance the constructor has been observed taking 15+ minutes with zero
    log output, making it impossible to tell which file is slow. This patch:
      1. Opportunistically passes mmap=True so PyTorch memory-maps the
         checkpoint instead of fully deserializing it into RAM up front
         (falls back to a normal load if the torch/file doesn't support it).
      2. Logs the path/size/duration of every torch.load call so the
         breakdown is visible in CloudWatch.
    Idempotent — safe to call multiple times.
    """
    import torch

    if getattr(torch.load, "_vm_instrumented", False):
        return

    _original_load = torch.load

    def _instrumented_load(*args, **kwargs):
        path = args[0] if args else kwargs.get("f")
        try:
            size_mb = os.path.getsize(path) / (1024 * 1024) if isinstance(path, (str, Path)) else -1
        except OSError:
            size_mb = -1

        t0 = time.monotonic()
        if "mmap" not in kwargs:
            try:
                result = _original_load(*args, mmap=True, **kwargs)
                log.info("[torch.load] %s (%.1f MB) loaded in %.1fs (mmap)", path, size_mb, time.monotonic() - t0)
                return result
            except Exception as exc:
                log.info("[torch.load] mmap load failed for %s (%s); retrying without mmap", path, exc)
                t0 = time.monotonic()
        result = _original_load(*args, **kwargs)
        log.info("[torch.load] %s (%.1f MB) loaded in %.1fs", path, size_mb, time.monotonic() - t0)
        return result

    _instrumented_load._vm_instrumented = True
    torch.load = _instrumented_load
    log.info("[CosyVoice] Patched torch.load for mmap + per-file timing.")

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 3: Translation (Gemini dubbing-aware)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

GEMINI_KEYS = [k for k in [GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3] if k]
_gemini_key_idx = 0

def _hydrate_google_credentials():
    existing = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if existing and Path(existing).exists():
        return

    if GOOGLE_APPLICATION_CREDENTIALS_S3_KEY:
        path = Path(tempfile.gettempdir()) / "google-vertex-credentials.json"
        log.info("[Gemini] Loading Vertex credentials from private S3 object...")
        s3.download_file(S3_BUCKET, GOOGLE_APPLICATION_CREDENTIALS_S3_KEY, str(path))
        try:
            path.chmod(0o600)
        except Exception:
            pass
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(path)
        return

    raw_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "").strip()
    raw_base64 = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_BASE64", "").strip()
    if not raw_json and raw_base64:
        raw_json = base64.b64decode(raw_base64).decode("utf-8")
    if not raw_json:
        return
    path = Path(tempfile.gettempdir()) / "google-vertex-credentials.json"
    path.write_text(raw_json, encoding="utf-8")
    try:
        path.chmod(0o600)
    except Exception:
        pass
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(path)

def _get_gemini_client():
    global _gemini_key_idx
    from google import genai
    if GOOGLE_GENAI_USE_VERTEXAI:
        if not GOOGLE_CLOUD_PROJECT:
            raise RuntimeError("Vertex Gemini is enabled but GOOGLE_CLOUD_PROJECT is not configured")
        _hydrate_google_credentials()
        return genai.Client(
            vertexai=True,
            project=GOOGLE_CLOUD_PROJECT,
            location=GOOGLE_CLOUD_LOCATION,
        )
    if not GEMINI_KEYS:
        raise RuntimeError("No Gemini provider configured. Set Vertex Gemini env or GEMINI_API_KEY.")
    key = GEMINI_KEYS[_gemini_key_idx % len(GEMINI_KEYS)]
    _gemini_key_idx += 1
    return genai.Client(api_key=key)

def _gemini_model_for_mode(mode: str) -> str:
    """Return the Gemini model name for translation.

    Phase 2 change: default to Flash (fast + cheap), with Pro available as
    a quality fallback for segments that fail the native-script QA gate.

    Model: gemini-3.5-flash for all modes (thinking level handles quality differentiation).
    """
    env_override = os.environ.get("TRANSLATION_MODEL", "").strip()
    if env_override:
        return env_override
    return "gemini-3.5-flash"


def _gemini_fallback_model() -> str:
    """Return the stronger model used for QA retries (native-script failures).

    Uses Pro for maximum translation quality on the handful of segments
    that fail the script gate.
    """
    env_override = os.environ.get("TRANSLATION_MODEL_FALLBACK", "").strip()
    if env_override:
        return env_override
    return "gemini-3.5-flash"


TRANSLATION_SYSTEM_PROMPT = """
You are a professional dubbing translator for video voice-over.

Your task is to translate speech segments into natural spoken dubbing text for Text-To-Speech (TTS) engines.

Core rules:
1. Translate meaning, emotion, tone, and intent — NOT word-for-word.
2. Write speakable voice-over text, not subtitle fragments.
3. CRITICAL — each segment has a target_seconds and max_chars field. Your tts_text MUST NOT exceed max_chars. This is an absolute budget; violating it causes audible speed distortion.
4. Do NOT output ellipses, filler dots, broken phrases, half-words, pronunciation hints, labels, brackets, or explanations.
5. Every translated_text and tts_text must be natural when spoken aloud and must end with punctuation.
6. Preserve names, religious terms, cultural references, and important proper nouns accurately.
7. If source text is mixed-language or contains a verse/quote, translate the meaning naturally.
8. If the source segment is a fragment, translate it as a complete natural spoken phrase. Make output speakable.
9. Use prev_text and next_text ONLY as context. Do not translate them or include them in the output.
10. Return ONLY valid JSON. No markdown, no code fences, no commentary.

Duration budget rules (CRITICAL for natural pacing):
- Each segment includes target_seconds (how long the TTS slot is) and max_chars (hard character limit for tts_text).
- If your translation would exceed max_chars, SHORTEN it. Rephrase with fewer words rather than cramming.
- Prefer short natural phrasing over verbose literal translations.
- target_seconds < 1.5: 1-3 short words only.
- target_seconds 1.5-3.0: one short phrase (max 1 clause).
- target_seconds 3.0-6.0: one natural sentence.
- target_seconds 6.0-10.0: one or two short sentences.
- target_seconds > 10.0: two to three sentences maximum.
- Never produce a long sentence for a short target_seconds. Compress meaning instead.

TTS pronunciation rules (CRITICAL — apply in the tts_text field):
- Acronyms and abbreviations: NEVER write them as a single condensed word in tts_text.
  Spell each letter out the way it would be spoken in the TARGET language script.
  Examples for Hindi target: BJP → बी जे पी, RSS → आर एस एस, UP → यू पी, PM → पी एम.
  Examples for English target: BJP → B J P, RSS → R S S.
  Use the same letter-by-letter pattern for any ALL-CAPS abbreviation.
- Do NOT keep English acronyms as raw uppercase letters (e.g. "BJP") in non-English tts_text.
- Short numbers that appear alone: write as words in the target language.
- Political party names, government body abbreviations: expand or properly transliterate.
- Speaker names and proper nouns: keep them accurately transliterated; do not invent new spellings.
- The translated_text field is for human-readable subtitles (may retain familiar abbreviations).
  The tts_text field is for the TTS engine (always use the pronunciation-safe version).

Output exactly one object per input segment:
[
  {
    "id": <same segment_id>,
    "translated_text": "<human-readable subtitle text in target language>",
    "tts_text": "<TTS-optimised text — acronyms spelled out, numbers as words — MUST be ≤ max_chars>",
    "emotion": "<neutral|happy|sad|excited|serious|questioning>",
    "speaking_rate": <number from 0.8 to 1.3>
  }
]
"""

NATIVE_SCRIPT_RULE = (
    "Use the target language's native writing system. Do not romanize Hindi, Odia, Bengali, "
    "Telugu, Tamil, Kannada, Malayalam, Marathi, Sanskrit, Punjabi, Gujarati, Arabic, Urdu, "
    "Japanese, Korean, Chinese, Russian, or Ukrainian."
)

def target_script_instruction(target_lang: str, target_code: str) -> str:
    key = f"{target_code} {target_lang}".strip().lower()
    rules = [
        (("hi", "hindi", "mr", "marathi", "sa", "sanskrit", "ne", "nepali"), "Use native Devanagari script only. Do not romanize; do not output Hinglish."),
        (("or", "odia", "oriya"), "Use native Odia script only. Do not romanize."),
        (("bn", "bengali", "bangla"), "Use native Bengali script only. Do not romanize."),
        (("pa", "punjabi"), "Use native Gurmukhi script only. Do not romanize."),
        (("gu", "gujarati"), "Use native Gujarati script only. Do not romanize."),
        (("ta", "tamil"), "Use native Tamil script only. Do not romanize."),
        (("te", "telugu"), "Use native Telugu script only. Do not romanize."),
        (("kn", "kannada"), "Use native Kannada script only. Do not romanize."),
        (("ml", "malayalam"), "Use native Malayalam script only. Do not romanize."),
        (("ar", "arabic", "ur", "urdu"), "Use the language's native Arabic-derived script only. Do not romanize."),
        (("ja", "japanese"), "Use natural Japanese writing with kana/kanji. Do not romanize."),
        (("ko", "korean"), "Use Hangul. Do not romanize."),
        (("zh", "chinese", "mandarin", "cantonese"), "Use Chinese characters. Do not romanize."),
        (("ru", "russian", "uk", "ukrainian"), "Use Cyrillic script. Do not romanize."),
    ]
    for tokens, instruction in rules:
        if any(token in key for token in tokens):
            return instruction
    return "Use the normal native writing system for the target language. Do not romanize unless that language is normally written in Latin script."


def _normalise_translation_response(raw) -> list[dict]:
    if isinstance(raw, dict):
        for key in ("translations", "segments", "items", "data"):
            if isinstance(raw.get(key), list):
                raw = raw[key]
                break
        else:
            if "id" in raw:
                raw = [raw]
            else:
                raise RuntimeError(
                    "Gemini returned a JSON object instead of a translation list. "
                    f"Keys: {sorted(raw.keys())[:10]}"
                )
    if not isinstance(raw, list):
        raise RuntimeError(f"Gemini returned invalid JSON shape: {type(raw).__name__}, expected list.")
    cleaned: list[dict] = []
    seen_ids: set[int] = set()
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeError(f"Gemini translation item {idx} is {type(item).__name__}, expected object.")
        if "id" not in item:
            raise RuntimeError(f"Gemini translation item {idx} is missing id.")
        try:
            item["id"] = int(item["id"])
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"Gemini translation item {idx} has invalid id: {item.get('id')!r}") from exc
        if item["id"] in seen_ids:
            raise RuntimeError(f"Gemini returned duplicate translation id: {item['id']}")
        seen_ids.add(item["id"])
        cleaned.append(item)
    return cleaned


def _safe_speaking_rate(value) -> float:
    """Clamp speaking rate to safe bounds for TTS/voice models.

    Widened to [0.8, 1.3] (was [0.9, 1.2]) to allow more dynamic prosody.
    The Phase 1 speed solver already clamps the final CosyVoice speed= to
    [0.85, 1.20], so this outer bound is deliberately wider — it allows the
    duration-prediction heuristic to benefit from the full range before the
    model-level clamp kicks in.
    """
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(rate):
        return 1.0
    return max(0.8, min(1.3, rate))


# ── Phase 2: per-segment duration budget for translation ──────────────────────
# We compute a max_chars budget so Gemini knows exactly how much text can fit
# in the TTS slot.  The budget uses CHARS_PER_SEC (from Phase 1) and adds a
# small overshoot margin so the model doesn't under-translate.

# Budget overshoot factor: allow 10% more chars than strict budget.  This gives
# Gemini room for complete phrases.  The Phase 1 speed= solver + QA retry
# still catches the remainder.
_CHARS_BUDGET_OVERSHOOT = 1.10

# Absolute minimum chars (prevents degenerate "1 char" budgets on very short segments)
_MIN_CHARS_BUDGET = 8


def compute_segment_max_chars(target_seconds: float, chars_per_sec: float) -> int:
    """Compute maximum character budget for a segment's tts_text.

    Uses the target speech duration and the language's chars-per-second rate.
    Returns an integer character limit that Gemini must respect.
    """
    if target_seconds <= 0 or chars_per_sec <= 0:
        return _MIN_CHARS_BUDGET
    raw = target_seconds * chars_per_sec * _CHARS_BUDGET_OVERSHOOT
    return max(_MIN_CHARS_BUDGET, int(math.ceil(raw)))


def _parse_chant_indices(raw_text: str, num_segments: int) -> dict:
    """
    Parse Gemini's chant-classification JSON into {segment_index: type}.

    Accepts {"preserve": [{"index": i, "type": "bhajan"}, ...]}, a bare list of
    ints, or a list of objects.  Out-of-range / malformed entries are ignored.
    Pure function — unit-tested.
    """
    out: dict = {}
    if not raw_text or not str(raw_text).strip():
        return out
    text = str(raw_text).strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text).rsplit("```", 1)[0].strip()
    data = None
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"[\[{].*[\]}]", text, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                data = None
    if data is None:
        return out
    items = []
    if isinstance(data, dict):
        items = data.get("preserve") or data.get("segments") or data.get("indices") or []
    elif isinstance(data, list):
        items = data
    if not isinstance(items, list):
        return out
    for it in items:
        idx = None
        ctype = "chant"
        if isinstance(it, bool):
            continue
        if isinstance(it, (int, float)):
            idx = int(it)
        elif isinstance(it, dict):
            for k in ("index", "id", "i", "segment"):
                v = it.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    idx = int(v)
                    break
            ctype = str(it.get("type") or it.get("kind") or "chant").strip().lower()[:24] or "chant"
        if idx is not None and 0 <= idx < num_segments:
            out[idx] = ctype
    return out


def classify_chant_segments(segments: list[dict]) -> int:
    """
    Flag segments that are devotional content to PRESERVE in the original audio
    (not translated/dubbed): sung bhajans/kirtan, chanting of divine names, and
    Sanskrit/Odia shlokas/mantras/verses.  Sets seg["preserve_original"]=True and
    seg["preserve_type"] on matches.  Returns the count.  Best-effort: any
    failure leaves every segment as normal translatable speech.
    """
    if not segments:
        return 0
    payload = [
        {
            "index": i,
            "start": round(float(s.get("start", 0) or 0), 2),
            "end": round(float(s.get("end", 0) or 0), 2),
            "text": str(s.get("text", ""))[:400],
        }
        for i, s in enumerate(segments)
    ]
    prompt = (
        "Below are timed transcript segments from a spiritual/devotional video "
        "(a Hindi discourse that may also contain Sanskrit/Odia verses and sung "
        "bhajans). The ASR text for sung/chanted parts is often garbled or "
        "repetitive.\n\n"
        "Identify ONLY the segments that are NOT normal spoken explanation, i.e.:\n"
        "  - a sung bhajan / kirtan / devotional song,\n"
        "  - chanting or repetition of divine names (e.g. 'Govinda Govinda', "
        "'Hare Krishna', 'Radhe Radhe'),\n"
        "  - a Sanskrit shloka or mantra being recited,\n"
        "  - an Odia or Sanskrit devotional verse (e.g. lines of the Bhagavata) "
        "being recited or sung.\n\n"
        "These must stay in their ORIGINAL language/audio and must NOT be "
        "translated. Ordinary teaching/explanation is NOT preserved, even when it "
        "briefly quotes a phrase. Prefer contiguous ranges (a bhajan usually spans "
        "several consecutive segments).\n\n"
        "Return STRICT JSON only: "
        "{\"preserve\": [{\"index\": <int>, \"type\": "
        "\"bhajan|kirtan|shloka|mantra|verse|chant\"}]}. "
        "If there are none, return {\"preserve\": []}.\n\n"
        f"SEGMENTS:\n{json.dumps(payload, ensure_ascii=False)}"
    )
    try:
        client = _get_gemini_client()
        model = os.environ.get("PRESERVE_CHANTS_MODEL", "").strip() or _gemini_model_for_mode("default")
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config={
                "system_instruction": (
                    "You label transcript segments for a dubbing pipeline. You never "
                    "translate. You only return the requested JSON object."
                ),
                "temperature": 0.0,
                "response_mime_type": "application/json",
            },
        )
        marks = _parse_chant_indices(getattr(response, "text", "") or "", len(segments))
    except Exception as e:
        log.warning("[Chants] Classification failed (%s); translating everything normally.", e)
        return 0

    count = 0
    for idx, ctype in marks.items():
        segments[idx]["preserve_original"] = True
        segments[idx]["preserve_type"] = ctype
        count += 1
    if count:
        ranges = [
            f"{round(float(segments[i].get('start', 0) or 0), 1)}-"
            f"{round(float(segments[i].get('end', 0) or 0), 1)}s"
            f"({segments[i].get('preserve_type')})"
            for i in sorted(marks)
        ]
        log.info("[Chants] Preserving %d segment(s) in original audio: %s", count, ", ".join(ranges))
    else:
        log.info("[Chants] No devotional/chant segments detected.")
    return count


def extract_original_slice(src_audio: Path, start: float, end: float, out_path: Path,
                           sample_rate: int = 24000) -> Path:
    """
    Cut [start, end] from the ORIGINAL audio (full mix, including any music) as a
    mono WAV at sample_rate.  Used to keep bhajan/shloka segments untranslated by
    placing the original audio in the dubbed timeline.
    """
    dur = max(0.05, float(end) - float(start))
    run_ffmpeg(
        "-ss", f"{max(0.0, float(start)):.3f}",
        "-t", f"{dur:.3f}",
        "-i", str(src_audio),
        "-ac", "1",
        "-ar", str(sample_rate),
        str(out_path),
    )
    return out_path


def mute_background_windows(bg: Path, windows: list, out: Path) -> Path:
    """
    Silence the (Demucs) background track inside the given [start,end] windows so
    a preserved devotional segment — whose original slice already contains the
    music — doesn't get the separated background layered on top of it (double
    music).  Returns the original path unchanged if there is nothing to mute.
    """
    spans = [(float(a), float(b)) for a, b in (windows or []) if float(b) > float(a)]
    if not spans:
        return bg
    enable = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in spans)
    run_ffmpeg("-i", str(bg), "-af", f"volume=0:enable='{enable}'", str(out))
    return out


def translate_segments(segments: list[dict]) -> list[dict]:
    """
    Translate all segments using Gemini with dubbing-aware prompts.

    Phase 2 redesign:
      * Segments are split into chunks of TRANSLATION_CHUNK_SIZE (25).
      * Up to TRANSLATION_MAX_PARALLEL (3) chunks execute concurrently.
      * Each chunk has its own retry loop with:
        - Global cap of TRANSLATION_MAX_ATTEMPTS (9) total tries.
        - Exponential backoff with jitter.
        - Immediate key rotation on 429 / quota errors.
      * After all chunks resolve, the native-script QA gate (P1-15) checks
        each segment and retries failures with the Pro fallback model.
      * Pre-synthesis duration overshoot check retries segments whose
        translated text exceeds the max_chars budget.

    Adds 'translated_text', 'tts_text', 'emotion', 'speaking_rate' to each segment.
    """
    import random
    from concurrent.futures import ThreadPoolExecutor, as_completed

    log.info(f"[Gemini] Translating {len(segments)} segments to {TARGET_LANG}...")

    # ── Tunables ──────────────────────────────────────────────────────────────
    TRANSLATION_CHUNK_SIZE = _env_int("TRANSLATION_CHUNK_SIZE", 25)
    TRANSLATION_MAX_PARALLEL = _env_int("TRANSLATION_MAX_PARALLEL", 3)
    TRANSLATION_MAX_ATTEMPTS = _env_int("TRANSLATION_MAX_ATTEMPTS", 9)

    # ── Build the per-segment payload ─────────────────────────────────────────
    def _context_snippet(value: str, limit: int = 250) -> str:
        """Context window for prev/next text — bumped to 250 chars (P1-17)."""
        snippet = re.sub(r"\s+", " ", str(value or "")).strip()
        if len(snippet) > limit:
            snippet = snippet[:limit].rsplit(" ", 1)[0].strip()
        return snippet

    target_cps = chars_per_second_for_target()

    seg_payload_all = []
    for idx, s in enumerate(segments):
        # Preserved devotional segments (bhajans / shlokas) are kept in the
        # original audio — don't translate them. Pass the original text through
        # so the SRT shows the original, and leave tts_text empty (the original
        # audio slice is substituted during synthesis).
        if s.get("preserve_original"):
            s["translated_text"] = s.get("text", "")
            s["tts_text"] = ""
            s.setdefault("emotion", "neutral")
            s.setdefault("speaking_rate", 1.0)
            continue
        prev_text = segments[idx - 1]["text"] if idx > 0 else ""
        next_text = segments[idx + 1]["text"] if idx + 1 < len(segments) else ""
        seg_target_seconds = round(compute_target_speech_seconds(s), 2)
        seg_max_chars = compute_segment_max_chars(seg_target_seconds, target_cps)
        seg_payload_all.append({
            "id": s["id"],
            "start": s["start"],
            "end": s["end"],
            "duration": round(s["end"] - s["start"], 2),
            "target_seconds": seg_target_seconds,
            "max_chars": seg_max_chars,
            "text": s["text"],
            "speaker": s.get("speaker") or DEFAULT_SPEAKER_LABEL,
            "prev_text": _context_snippet(prev_text),
            "next_text": _context_snippet(next_text),
        })

    # ── Chunk the payload ─────────────────────────────────────────────────────
    def _chunk_list(lst: list, size: int) -> list[list]:
        return [lst[i : i + size] for i in range(0, len(lst), size)]

    chunks = _chunk_list(seg_payload_all, TRANSLATION_CHUNK_SIZE)
    log.info(
        f"[Gemini] Split {len(seg_payload_all)} segments into {len(chunks)} chunks "
        f"(chunk_size={TRANSLATION_CHUNK_SIZE}, max_parallel={TRANSLATION_MAX_PARALLEL})."
    )

    model = _gemini_model_for_mode(TRANSLATION_MODE)

    # ── Single-chunk translation with capped retry + backoff ──────────────────
    def _translate_chunk(chunk_payload: list[dict], chunk_idx: int) -> list[dict]:
        """Translate one chunk of segments.  Retries with backoff + key rotation."""
        user_prompt = (
            f"Translate these merged dubbing segments into {TARGET_LANG}.\n"
            f"{NATIVE_SCRIPT_RULE}\n"
            f"{target_script_instruction(TARGET_LANG, TARGET_LANG_CODE)}\n\n"
            f"Important:\n"
            f"- These segments will be passed directly into TTS/voice cloning.\n"
            f"- Make each translated_text natural, short, and speakable.\n"
            f"- Each segment has target_seconds and max_chars. Your tts_text MUST NOT exceed max_chars characters.\n"
            f"- If a faithful translation would exceed max_chars, rephrase more concisely — do not truncate.\n"
            f"- Do not output source text, transliteration, labels, explanations, or markdown.\n"
            f"- Keep religious/devotional terms respectful and accurate.\n\n"
            f"Segments JSON:\n{json.dumps(chunk_payload, ensure_ascii=False, indent=2)}"
        )

        total_attempts = 0
        last_error = None

        while total_attempts < TRANSLATION_MAX_ATTEMPTS:
            total_attempts += 1
            try:
                client = _get_gemini_client()
                response = client.models.generate_content(
                    model=model,
                    contents=user_prompt,
                    config={
                        "system_instruction": TRANSLATION_SYSTEM_PROMPT,
                        "temperature": 0.3,
                        "response_mime_type": "application/json",
                    },
                )
                result = _normalise_translation_response(json.loads(response.text))
                # Validate every segment ID is present
                result_ids = {t["id"] for t in result}
                expected_ids = {s["id"] for s in chunk_payload}
                missing = expected_ids - result_ids
                if missing:
                    raise RuntimeError(
                        f"Chunk {chunk_idx}: missing segment ids {sorted(missing)[:5]}"
                    )
                # Validate no empty translations
                for t in result:
                    txt = str(t.get("translated_text", "")).strip()
                    if not txt:
                        src = next(
                            (s for s in chunk_payload if s["id"] == t["id"]), {}
                        )
                        if str(src.get("text", "")).strip():
                            raise RuntimeError(
                                f"Chunk {chunk_idx}: empty translated_text for id {t['id']}"
                            )
                log.info(
                    f"[Gemini] Chunk {chunk_idx} ({len(chunk_payload)} segs) "
                    f"translated on attempt {total_attempts}."
                )
                return result
            except Exception as e:
                last_error = e
                err_str = str(e).lower()
                # Immediate key rotation on quota/rate errors
                is_rate_limit = any(
                    kw in err_str for kw in ("429", "quota", "rate_limit", "resource_exhausted")
                )
                if is_rate_limit:
                    log.warning(
                        f"[Gemini] Chunk {chunk_idx} attempt {total_attempts}: "
                        f"rate limit, rotating key."
                    )
                    # _get_gemini_client() already rotates; just retry quickly.
                    time.sleep(0.5 + random.uniform(0, 0.5))
                    continue
                # Backoff with jitter for other errors
                backoff = min(30.0, (2 ** total_attempts) + random.uniform(0, 1))
                log.warning(
                    f"[Gemini] Chunk {chunk_idx} attempt {total_attempts} failed: {e}. "
                    f"Retrying in {backoff:.1f}s..."
                )
                time.sleep(backoff)

        raise RuntimeError(
            f"[Gemini] Chunk {chunk_idx} failed after {TRANSLATION_MAX_ATTEMPTS} attempts. "
            f"Last error: {last_error}"
        )

    # ── Execute chunks in parallel ────────────────────────────────────────────
    all_translations: list[dict] = []
    if len(chunks) == 1:
        # Single chunk — skip thread overhead
        all_translations = _translate_chunk(chunks[0], 0)
    else:
        with ThreadPoolExecutor(max_workers=TRANSLATION_MAX_PARALLEL) as executor:
            futures = {
                executor.submit(_translate_chunk, chunk, idx): idx
                for idx, chunk in enumerate(chunks)
            }
            chunk_results: dict[int, list[dict]] = {}
            for future in as_completed(futures):
                chunk_idx = futures[future]
                # Let exceptions propagate — if one chunk fails after all retries,
                # the entire translation job should fail rather than produce
                # partial output.
                chunk_results[chunk_idx] = future.result()
            # Reassemble in order
            for idx in range(len(chunks)):
                all_translations.extend(chunk_results[idx])

    # ── Merge translations back into segments ─────────────────────────────────
    trans_map = {t["id"]: t for t in all_translations}
    missing = [seg["id"] for seg in segments if seg["id"] not in trans_map]
    if missing:
        raise RuntimeError(f"Gemini translation missing segment ids: {missing[:10]}")

    for seg in segments:
        t = trans_map.get(seg["id"], {})
        translated = str(t.get("translated_text", "")).strip()
        if not translated and seg["text"].strip():
            raise RuntimeError(f"Missing translated_text for segment {seg['id']}")
        seg["translated_text"] = translated
        tts_raw = str(t.get("tts_text", "")).strip()
        seg["tts_text"] = tts_raw if tts_raw else translated
        seg["emotion"] = t.get("emotion", "neutral")
        seg["speaking_rate"] = _safe_speaking_rate(t.get("speaking_rate", 1.0))

    log.info(
        f"[Gemini] Translation complete: {len(segments)} segments, "
        f"{len(chunks)} chunks, model={model}."
    )

    # ── Phase 2: Post-translation QA gates ────────────────────────────────────
    # 1. Native-script QA gate (P1-15)
    # 2. Duration overshoot retry (NEW)
    segments = _qa_native_script(segments, target_cps)
    segments = _qa_duration_overshoot(segments, target_cps)

    return segments


# ─── Phase 2: Native-script QA gate (P1-15) ──────────────────────────────────
# Validates that tts_text is written in the correct Unicode script for the
# target language.  Catches Hinglish, Roman Tamil, etc. and retries only the
# failing segments with the Pro model.

# Unicode ranges for script detection.  Each entry is a tuple of (start, end)
# code point ranges that count as "native" for that language family.
_SCRIPT_RANGES: dict[str, list[tuple[int, int]]] = {
    # Devanagari (Hindi, Marathi, Nepali, Sanskrit)
    "devanagari": [(0x0900, 0x097F), (0xA8E0, 0xA8FF), (0x11B00, 0x11B5F)],
    # Bengali
    "bengali": [(0x0980, 0x09FF)],
    # Gurmukhi (Punjabi)
    "gurmukhi": [(0x0A00, 0x0A7F)],
    # Gujarati
    "gujarati": [(0x0A80, 0x0AFF)],
    # Odia
    "odia": [(0x0B00, 0x0B7F)],
    # Tamil
    "tamil": [(0x0B80, 0x0BFF)],
    # Telugu
    "telugu": [(0x0C00, 0x0C7F)],
    # Kannada
    "kannada": [(0x0C80, 0x0CFF)],
    # Malayalam
    "malayalam": [(0x0D00, 0x0D7F)],
    # Arabic / Urdu
    "arabic": [(0x0600, 0x06FF), (0x0750, 0x077F), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)],
    # CJK (Chinese, Japanese kanji)
    "cjk": [(0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x2E80, 0x2EFF), (0x3000, 0x303F)],
    # Hiragana + Katakana (Japanese)
    "japanese_kana": [(0x3040, 0x309F), (0x30A0, 0x30FF), (0x31F0, 0x31FF)],
    # Hangul (Korean)
    "hangul": [(0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F)],
    # Cyrillic (Russian, Ukrainian)
    "cyrillic": [(0x0400, 0x04FF), (0x0500, 0x052F)],
}

# Map target language code → which script ranges to check
_LANG_TO_SCRIPT: dict[str, list[str]] = {
    "hi": ["devanagari"], "mr": ["devanagari"], "ne": ["devanagari"], "sa": ["devanagari"],
    "bn": ["bengali"], "pa": ["gurmukhi"], "gu": ["gujarati"],
    "or": ["odia"], "ta": ["tamil"], "te": ["telugu"],
    "kn": ["kannada"], "ml": ["malayalam"],
    "ar": ["arabic"], "ur": ["arabic"],
    "zh": ["cjk"], "ja": ["cjk", "japanese_kana"], "ko": ["hangul"],
    "ru": ["cyrillic"], "uk": ["cyrillic"],
}

# Threshold: at least this fraction of non-space, non-punctuation chars must
# be in the native script.  80% allows for embedded numbers, punctuation,
# and occasional transliterated proper nouns.
_NATIVE_SCRIPT_THRESHOLD = 0.80


def _is_native_char(ch: str, script_keys: list[str]) -> bool:
    """Check if a character falls within the given script ranges."""
    cp = ord(ch)
    for key in script_keys:
        for start, end in _SCRIPT_RANGES.get(key, []):
            if start <= cp <= end:
                return True
    return False


def check_native_script(text: str, target_lang_code: str) -> bool:
    """
    Return True if text passes the native-script check for the target language.

    Languages written in Latin script (English, Spanish, French, etc.) always pass.
    For non-Latin targets, at least _NATIVE_SCRIPT_THRESHOLD of speakable characters
    must be in the correct Unicode script range.
    """
    code = (target_lang_code or "").lower().strip()
    if code not in _LANG_TO_SCRIPT:
        # Latin-script languages or unknown — always pass
        return True

    script_keys = _LANG_TO_SCRIPT[code]
    # Count only non-space, non-digit, non-ascii-punctuation chars
    native_count = 0
    total_count = 0
    for ch in text:
        if ch.isspace() or ch.isdigit():
            continue
        # Skip common punctuation (ASCII + some Unicode)
        if ord(ch) < 0x0080 and not ch.isalpha():
            continue
        total_count += 1
        if _is_native_char(ch, script_keys):
            native_count += 1

    if total_count == 0:
        return True  # empty or all-digits/punctuation — pass
    return (native_count / total_count) >= _NATIVE_SCRIPT_THRESHOLD


def _qa_native_script(segments: list[dict], target_cps: float) -> list[dict]:
    """
    Post-translation QA: validate that tts_text uses the correct native script.

    Segments that fail are retried individually with the Pro fallback model and
    an explicit "Devanagari only" / "Tamil only" instruction.  If the retry also
    fails, the segment is kept as-is (better than crashing) but flagged.
    """
    import random

    code = (TARGET_LANG_CODE or "").lower().strip()
    if code not in _LANG_TO_SCRIPT:
        return segments  # Latin-script target — nothing to check

    failed_segments: list[dict] = []
    for seg in segments:
        tts_text = seg.get("tts_text", "")
        if tts_text and not check_native_script(tts_text, code):
            failed_segments.append(seg)

    if not failed_segments:
        return segments

    log.warning(
        f"[QA-Script] {len(failed_segments)} segments failed native-script check. "
        f"Retrying with Pro model..."
    )

    # Retry each failed segment individually with Pro
    fallback_model = _gemini_fallback_model()
    script_instruction = target_script_instruction(TARGET_LANG, TARGET_LANG_CODE)
    retried = 0
    fixed = 0

    for seg in failed_segments:
        seg_target_seconds = round(compute_target_speech_seconds(seg), 2)
        seg_max_chars = compute_segment_max_chars(seg_target_seconds, target_cps)

        retry_payload = [{
            "id": seg["id"],
            "start": seg["start"],
            "end": seg["end"],
            "duration": round(seg["end"] - seg["start"], 2),
            "target_seconds": seg_target_seconds,
            "max_chars": seg_max_chars,
            "text": seg["text"],
            "speaker": seg.get("speaker", ""),
            "prev_text": "",
            "next_text": "",
        }]

        retry_prompt = (
            f"Translate this segment into {TARGET_LANG}.\n"
            f"CRITICAL: {script_instruction}\n"
            f"Do NOT use Roman/Latin script for the target language. "
            f"Every word in tts_text MUST be in the native script.\n"
            f"The tts_text must be ≤ {seg_max_chars} characters.\n\n"
            f"Segment JSON:\n{json.dumps(retry_payload, ensure_ascii=False)}"
        )

        try:
            client = _get_gemini_client()
            response = client.models.generate_content(
                model=fallback_model,
                contents=retry_prompt,
                config={
                    "system_instruction": TRANSLATION_SYSTEM_PROMPT,
                    "temperature": 0.2,
                    "response_mime_type": "application/json",
                },
            )
            result = _normalise_translation_response(json.loads(response.text))
            if result and result[0].get("id") == seg["id"]:
                new_tts = str(result[0].get("tts_text", "")).strip()
                new_trans = str(result[0].get("translated_text", "")).strip()
                if new_tts and check_native_script(new_tts, code):
                    seg["tts_text"] = new_tts
                    if new_trans:
                        seg["translated_text"] = new_trans
                    seg["emotion"] = result[0].get("emotion", seg.get("emotion", "neutral"))
                    seg["speaking_rate"] = _safe_speaking_rate(
                        result[0].get("speaking_rate", seg.get("speaking_rate", 1.0))
                    )
                    seg.setdefault("_translation_qa", {})["script_retry"] = "fixed"
                    fixed += 1
                else:
                    seg.setdefault("_translation_qa", {})["script_retry"] = "still_failed"
            else:
                seg.setdefault("_translation_qa", {})["script_retry"] = "bad_response"
        except Exception as e:
            log.warning(f"[QA-Script] Pro retry failed for seg {seg['id']}: {e}")
            seg.setdefault("_translation_qa", {})["script_retry"] = "error"
        retried += 1
        time.sleep(0.3 + random.uniform(0, 0.3))  # gentle rate limiting

    log.info(
        f"[QA-Script] Retried {retried} segments with Pro. "
        f"Fixed {fixed}/{retried}."
    )
    return segments


# ─── Phase 2: Duration overshoot retry (NEW) ─────────────────────────────────
# After translation, predict the speech duration of each tts_text.  If it would
# exceed the target by >15%, ask Gemini to shorten just that segment.  This
# catches over-long translations BEFORE synthesis, preventing emergency speed
# warping in Phase 1's synthesize loop.

_DURATION_OVERSHOOT_THRESHOLD = 1.15  # 15% over budget → trigger retry
_DURATION_OVERSHOOT_MAX_RETRIES = 1   # Only one "shorten" pass (diminishing returns)


def _qa_duration_overshoot(segments: list[dict], target_cps: float) -> list[dict]:
    """
    Pre-synthesis duration check: if predicted TTS duration of tts_text exceeds
    target_seconds by more than 15%, ask Gemini to shorten the segment.
    """
    import random

    overshoot_segments: list[dict] = []
    for seg in segments:
        tts_text = seg.get("tts_text", "")
        if not tts_text:
            continue
        target_seconds = compute_target_speech_seconds(seg)
        if target_seconds <= 0:
            continue
        predicted = predict_segment_speech_seconds(tts_text, 1.0, target_cps)
        if predicted / target_seconds > _DURATION_OVERSHOOT_THRESHOLD:
            overshoot_segments.append(seg)

    if not overshoot_segments:
        return segments

    log.info(
        f"[QA-Duration] {len(overshoot_segments)} segments exceed duration budget "
        f"by >{int((_DURATION_OVERSHOOT_THRESHOLD - 1) * 100)}%. Requesting shorter translations..."
    )

    model = _gemini_model_for_mode(TRANSLATION_MODE)
    script_instruction = target_script_instruction(TARGET_LANG, TARGET_LANG_CODE)
    shortened = 0

    for seg in overshoot_segments:
        seg_target_seconds = round(compute_target_speech_seconds(seg), 2)
        seg_max_chars = compute_segment_max_chars(seg_target_seconds, target_cps)

        shorten_prompt = (
            f"The following translated TTS text is too long for its time slot.\n"
            f"Target: {seg_target_seconds} seconds, max {seg_max_chars} characters.\n"
            f"Current tts_text ({len(seg.get('tts_text', ''))} chars): "
            f"{seg.get('tts_text', '')}\n\n"
            f"Rewrite it shorter in {TARGET_LANG}. Keep the same meaning but use fewer words.\n"
            f"{script_instruction}\n"
            f"Return JSON: {{\"id\": {seg['id']}, \"tts_text\": \"<shortened>\", "
            f"\"translated_text\": \"<subtitle version>\"}}"
        )

        try:
            client = _get_gemini_client()
            response = client.models.generate_content(
                model=model,
                contents=shorten_prompt,
                config={
                    "system_instruction": "You are a translation editor. Shorten the text to fit the time budget. Return only valid JSON.",
                    "temperature": 0.2,
                    "response_mime_type": "application/json",
                },
            )
            result = json.loads(response.text)
            if isinstance(result, list) and result:
                result = result[0]
            if isinstance(result, dict):
                new_tts = str(result.get("tts_text", "")).strip()
                new_trans = str(result.get("translated_text", "")).strip()
                if new_tts and len(new_tts) < len(seg.get("tts_text", "")):
                    # Verify the shortened version actually fits better
                    new_predicted = predict_segment_speech_seconds(new_tts, 1.0, target_cps)
                    old_predicted = predict_segment_speech_seconds(
                        seg.get("tts_text", ""), 1.0, target_cps
                    )
                    if new_predicted < old_predicted:
                        seg["tts_text"] = new_tts
                        if new_trans:
                            seg["translated_text"] = new_trans
                        seg.setdefault("_translation_qa", {})["duration_retry"] = "shortened"
                        shortened += 1
                    else:
                        seg.setdefault("_translation_qa", {})["duration_retry"] = "no_improvement"
                else:
                    seg.setdefault("_translation_qa", {})["duration_retry"] = "longer_or_empty"
            else:
                seg.setdefault("_translation_qa", {})["duration_retry"] = "bad_response"
        except Exception as e:
            log.warning(f"[QA-Duration] Shorten retry failed for seg {seg['id']}: {e}")
            seg.setdefault("_translation_qa", {})["duration_retry"] = "error"
        time.sleep(0.2 + random.uniform(0, 0.2))

    log.info(
        f"[QA-Duration] Shortened {shortened}/{len(overshoot_segments)} over-long segments."
    )
    return segments


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 4: Voice Cloning (CosyVoice 3.0 â†’ edge-tts â†’ gTTS)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# CosyVoice 3.0 is zero-shot multilingual â€” no language mapping table needed.
# It auto-handles 50+ languages via the prompt speech reference.

LANG_TO_EDGE_TTS = {
    "hi": "hi-IN-SwaraNeural",
    "en": "en-US-AriaNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "it": "it-IT-ElsaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "ar": "ar-EG-SalmaNeural",
    "nl": "nl-NL-ColetteNeural",
    "pl": "pl-PL-ZofiaNeural",
    "tr": "tr-TR-EmelNeural",
    "uk": "uk-UA-PolinaNeural",
    "vi": "vi-VN-HoaiMyNeural",
    "id": "id-ID-GadisNeural",
    "fil": "fil-PH-BlessicaNeural",
    "fi": "fi-FI-NooraNeural",
    "bn": "bn-IN-TanishaaNeural",
    "gu": "gu-IN-DhwaniNeural",
    "kn": "kn-IN-SapnaNeural",
    "ml": "ml-IN-SobhanaNeural",
    "mr": "mr-IN-AarohiNeural",
    "ta": "ta-IN-PallaviNeural",
    "te": "te-IN-ShrutiNeural",
    "ur": "ur-IN-GulNeural",
}

GTTS_LANG_MAP = {
    "fil": "tl",
    "zh": "zh-CN",
}



def synthesize_segments_cosyvoice(
    segments: list[dict],
    default_reference_audio: Path,
    out_dir: Path,
    speaker_refs: Optional[dict] = None,
    speaker_prompt_texts: Optional[dict] = None,
) -> list[Path]:
    """
    Zero-shot / cross-lingual voice cloning via CosyVoice.
    When speaker_refs is provided each speaker gets their own voice reference,
    so a multi-speaker video is dubbed with the correct voice per speaker.
    Falls back to default_reference_audio for any unknown speaker.
    """
    import torch
    import torchaudio

    log.info(
        "[GPU] torch=%s cuda=%s",
        getattr(torch, "__version__", "unknown"),
        torch.cuda.is_available(),
    )
    if torch.cuda.is_available():
        try:
            log.info("[GPU] device=%s", torch.cuda.get_device_name(0))
        except Exception as exc:
            log.warning("[GPU] Could not read CUDA device name: %s", exc)
        try:
            smi = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader"],
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if smi.stdout.strip():
                log.info("[GPU] nvidia-smi: %s", smi.stdout.strip())
            elif smi.stderr.strip():
                log.warning("[GPU] nvidia-smi stderr: %s", smi.stderr.strip()[-500:])
        except Exception as exc:
            log.warning("[GPU] nvidia-smi unavailable: %s", exc)

    update_progress("CLONING", 52, "Loading CosyVoice model (CUDA init)...")
    _model_load_t0 = time.monotonic()
    _patch_torch_load_for_fast_checkpoint_loading()

    cv_dir = _ensure_cosyvoice()
    if str(cv_dir) not in sys.path:
        sys.path.insert(0, str(cv_dir))
    matcha_root = cv_dir / "third_party" / "Matcha-TTS"
    if str(matcha_root) not in sys.path:
        sys.path.insert(0, str(matcha_root))
    log.info("[CosyVoice] Repo/path setup: %.1fs", time.monotonic() - _model_load_t0)

    _t = time.monotonic()
    _verify_onnxruntime_cuda_stack()
    _ensure_cosyvoice_yaml_compatibility()
    log.info("[CosyVoice] ONNXRuntime + dep verification: %.1fs", time.monotonic() - _t)

    _t = time.monotonic()
    _CosyVoice = _import_cosyvoice_class()
    log.info("[CosyVoice] Class import: %.1fs", time.monotonic() - _t)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = None
    last_err: Optional[Exception] = None

    def _resolve_model_path(model_name: str) -> Optional[Path]:
        for root in [
            MODELSCOPE_CACHE / "hub" / "iic",
            MODELSCOPE_CACHE / "hub" / "models" / "iic",
            MODELSCOPE_CACHE / "iic",
            MODELSCOPE_CACHE / "models" / "iic",
        ]:
            p = root / model_name
            if p.exists():
                return p
            for candidate in root.glob(f"{model_name.split('-')[0]}*") if root.exists() else []:
                if candidate.is_dir():
                    return candidate
        return None

    primary_model_name = COSYVOICE_MODEL_ID.split("/")[-1].strip()
    candidate_models: list[str] = []
    for name in (
        primary_model_name,
        "Fun-CosyVoice3-0.5B-2512",
        "Fun-CosyVoice3-0.5B",
        "CosyVoice3-0.5B",
        "CosyVoice2-0.5B",
    ):
        if name and name not in candidate_models:
            candidate_models.append(name)

    tried_model_paths: set[str] = set()
    for model_name in candidate_models:
        model_path = _resolve_model_path(model_name)
        if model_path is None:
            model_path = _find_cosyvoice_model()
        if model_path is None:
            log.warning(f"[CosyVoice] {model_name} not found in cache, skipping.")
            continue
        model_path_key = str(model_path.resolve())
        if model_path_key in tried_model_paths:
            continue
        tried_model_paths.add(model_path_key)
        try:
            log.info(f"[CosyVoice] Loading {model_name} from {model_path} on {device}...")
            # CosyVoice3 (AutoModel) dropped load_jit — only pass what the
            # constructor accepts so v2 and v3 both work.
            _init_sig = inspect.signature(_CosyVoice)
            _init_kw: dict = {}
            if "load_jit" in _init_sig.parameters:
                _init_kw["load_jit"] = False
            if "load_trt" in _init_sig.parameters:
                _init_kw["load_trt"] = False
            # Phase 3 (P1-8): fp16 when enabled and constructor supports it.
            if COSYVOICE_FP16 and "fp16" in _init_sig.parameters:
                _init_kw["fp16"] = True
                log.info("[CosyVoice] fp16=True enabled via COSYVOICE_FP16 flag.")
            # Phase 3 (P1-10): vLLM when enabled and constructor supports it.
            if COSYVOICE_VLLM and "load_vllm" in _init_sig.parameters:
                # Verify the vllm directory exists before enabling (prevents
                # hard crash if Docker image doesn't have vLLM weights).
                _vllm_dir = model_path / "vllm"
                if _vllm_dir.exists():
                    _init_kw["load_vllm"] = True
                    log.info("[CosyVoice] load_vllm=True enabled via COSYVOICE_VLLM flag.")
                else:
                    log.warning(
                        "[CosyVoice] COSYVOICE_VLLM=true but %s does not exist. "
                        "Skipping vLLM. Rebuild Docker image with vLLM weights.",
                        _vllm_dir,
                    )
            _t_construct = time.monotonic()
            model = _CosyVoice(model_dir=str(model_path), **_init_kw)
            log.info("[CosyVoice] AutoModel(model_dir=...) constructor: %.1fs", time.monotonic() - _t_construct)
            break
        except Exception as e:
            last_err = e
            log.warning(f"[CosyVoice] Failed loading {model_name}: {e}")
    if model is None:
        raise RuntimeError(f"CosyVoice model load failed: {last_err}")
    cosy_model = model
    _model_load_dur = time.monotonic() - _model_load_t0
    log.info("[CosyVoice] Model loaded in %.1fs", _model_load_dur)

    # ── Phase 3 (P1-4): Detect CosyVoice version via class name ────────────
    # Upstream hierarchy: CosyVoice3 extends CosyVoice2 extends CosyVoice.
    # AutoModel returns the appropriate subclass.  Inspecting __class__.__name__
    # is robust to path layout changes and model renames.
    _model_class_name = type(model).__name__
    is_cosyvoice3 = "CosyVoice3" in _model_class_name
    is_cosyvoice2 = "CosyVoice2" in _model_class_name and not is_cosyvoice3
    # Note: CosyVoice3 inherits from CosyVoice2, so "CosyVoice2" would also
    # match for v3.  We check v3 first, then v2 explicitly.
    if is_cosyvoice3:
        log.info("[CosyVoice] CosyVoice3 detected (class=%s) — instruction prefix will be applied.", _model_class_name)
    elif is_cosyvoice2:
        log.info("[CosyVoice] CosyVoice2 detected (class=%s).", _model_class_name)
    else:
        log.info("[CosyVoice] CosyVoice legacy detected (class=%s).", _model_class_name)

    # ── Decide inference mode (cross-lingual vs zero-shot) ──────────────────
    source_code = (SOURCE_LANG_CODE or "").lower().strip()
    target_code = (TARGET_LANG_CODE or "").lower().strip()
    is_cross_lingual = bool(
        target_code
        and target_code not in ("", "auto")
        and (not source_code or source_code in ("", "auto") or target_code != source_code)
    )
    has_cross_lingual = hasattr(model, "inference_cross_lingual")
    use_cross_lingual = is_cross_lingual and has_cross_lingual

    if use_cross_lingual:
        log.info(f"[CosyVoice] CROSS-LINGUAL: {SOURCE_LANG_CODE or 'auto'} → {TARGET_LANG_CODE}")
    else:
        if is_cross_lingual and not has_cross_lingual:
            log.warning(
                "[CosyVoice] Cross-lingual needed but model lacks inference_cross_lingual; "
                "falling back to zero_shot."
            )
        log.info(f"[CosyVoice] ZERO-SHOT: {SOURCE_LANG_CODE or 'auto'} → {TARGET_LANG_CODE}")

    # ── Pre-load per-speaker reference WAVs (cached by speaker label) ────────
    # Each entry: speaker_label → (tensor[1,T], prompt_wav_file_path_str)
    _ref_cache: dict = {}

    def _load_ref(ref_path: Path, speaker: str):
        key = str(ref_path.resolve())
        if key in _ref_cache:
            return _ref_cache[key]
        rw, rs = torchaudio.load(str(ref_path))
        if rw.shape[0] > 1:
            rw = rw.mean(0, keepdim=True)
        # CosyVoice's frontend re-loads the prompt audio at TWO sample rates:
        # 16 kHz for the speech-token + speaker-embedding extractors and
        # 24 kHz for the speech-feature extractor (mel/flow conditioning).
        # If we save the cached file at 16 kHz, the 24 kHz extractor has to
        # upsample and gets no useful information above 8 kHz, which audibly
        # dulls the cloned timbre.  We keep an in-memory 16 kHz tensor for
        # forks that take a tensor argument, but write the cached WAV at
        # 24 kHz so upstream's load_wav(prompt_wav, 24000) sees real
        # high-frequency content.
        if rs != 16000:
            rw_16k = torchaudio.functional.resample(rw, rs, 16000)
        else:
            rw_16k = rw
        if rs != 24000:
            rw_24k = torchaudio.functional.resample(rw, rs, 24000)
        else:
            rw_24k = rw
        rw_16k = rw_16k[:, : 16000 * 10]  # cap at 10 s — upstream best practice (5-10 s)
        rw_24k = rw_24k[:, : 24000 * 10]  # cap at 10 s — longer refs confuse speaker encoder
        safe_spk = re.sub(r"[^A-Za-z0-9_\-]", "_", speaker)
        fname = out_dir / f"ref_{safe_spk}_24k.wav"
        torchaudio.save(str(fname), rw_24k, 24000)
        _ref_cache[key] = (rw_16k, str(fname))
        return rw_16k, str(fname)

    # Pre-warm default reference
    default_ref_wav, default_ref_prompt_path = _load_ref(default_reference_audio, "default")

    # ── Warmup inference — pre-compile CUDA kernels / JIT graphs ────────────
    # The first CosyVoice inference triggers CUDA kernel JIT compilation,
    # cuDNN autotuning, and ONNX session initialization.  Without a warmup
    # this shows up as a mysterious 1-3 min silence before the first real
    # segment produces audio.  Running a tiny dummy inference here makes all
    # that overhead visible and shifts it into a named pipeline phase.
    # Uses the capped 10s reference (default_ref_prompt_path) — NOT the raw
    # full-length video audio — to keep the warmup fast.
    update_progress("CLONING", 52, "Warming up CUDA kernels...")
    _warmup_t0 = time.monotonic()
    try:
        log.info("[CosyVoice] Running warmup inference (pre-compiling CUDA kernels)...")
        _warmup_text = "Warmup."
        if is_cosyvoice3 and COSYVOICE3_INJECT_PROMPT_PREFIX:
            _warmup_text = "<|endofprompt|>Warmup."
        _warmup_done = False
        if hasattr(model, "inference_zero_shot"):
            for _wchunk in model.inference_zero_shot(
                _warmup_text, _warmup_text, default_ref_prompt_path
            ):
                _warmup_done = True
                break  # one chunk is enough to trigger all kernel compilation
        if not _warmup_done and hasattr(model, "inference_cross_lingual"):
            for _wchunk in model.inference_cross_lingual(
                _warmup_text, default_ref_prompt_path
            ):
                break
        _warmup_dur = time.monotonic() - _warmup_t0
        log.info("[CosyVoice] Warmup complete in %.1fs — CUDA kernels ready.", _warmup_dur)
    except Exception as _warmup_err:
        _warmup_dur = time.monotonic() - _warmup_t0
        log.warning("[CosyVoice] Warmup failed after %.1fs (non-fatal): %s", _warmup_dur, _warmup_err)

    update_progress("CLONING", 53, "CUDA kernels ready. Preparing voice synthesis...")

    # Pre-warm per-speaker refs so load errors are caught before synthesis
    if speaker_refs:
        for spk, rp in speaker_refs.items():
            try:
                _load_ref(Path(rp), spk)
                log.info(f"[CosyVoice] Pre-loaded reference for {spk}.")
            except Exception as exc:
                log.warning(f"[CosyVoice] Could not load speaker ref for {spk}: {exc}. "
                            "Will use default reference.")

    # ── Pre-compute per-speaker prompt_text for zero-shot mode ───────────────
    # prompt_text must match what is SPOKEN in the reference audio for that speaker.
    # Only needed for zero-shot (same source/target language).
    global_prompt_text = ""
    speaker_prompt_texts = speaker_prompt_texts or {}
    if not use_cross_lingual:
        if speaker_prompt_texts:
            for value in speaker_prompt_texts.values():
                if value:
                    global_prompt_text = value
                    break
            if not global_prompt_text and all(not v for v in speaker_prompt_texts.values()):
                log.info("[CosyVoice] Speaker prompt texts provided but all were empty; using fallback prompts.")

        if not global_prompt_text:
            # Global fallback: first 12 s of the recording
            parts: list[str] = []
            for seg in segments:
                if float(seg.get("start", 0)) < 12.0:
                    src = str(seg.get("text", "")).strip()
                    if src:
                        parts.append(src)
                else:
                    break
            global_prompt_text = normalize_tts_text(" ".join(parts))[:300]
            if not global_prompt_text:
                for seg in segments:
                    src = str(seg.get("text", "")).strip()
                    if src:
                        global_prompt_text = normalize_tts_text(src[:200])
                        break

        if not speaker_prompt_texts:
            # Per-speaker fallback if reference extraction did not provide matched prompt text.
            from collections import defaultdict as _dd2
            spk_segs: dict = _dd2(list)
            for seg in segments:
                spk_segs[seg.get("speaker") or DEFAULT_SPEAKER_LABEL].append(seg)
            for spk, s_list in spk_segs.items():
                p_parts: list[str] = []
                total = 0.0
                for s in sorted(s_list, key=lambda x: x["start"]):
                    txt = str(s.get("text", "")).strip()
                    if txt:
                        p_parts.append(txt)
                        total += s["end"] - s["start"]
                        if total >= 12.0:
                            break
                pt = normalize_tts_text(" ".join(p_parts))[:300]
                speaker_prompt_texts[spk] = pt or global_prompt_text

    # ── Pre-compute inference method signatures ONCE (outside the loop) ─────────
    # inspect.signature() is non-trivial; calling it on every segment iteration
    # (15-20 times per job) is wasteful.  Compute once and reuse.
    if use_cross_lingual:
        _cl_params_set = set(inspect.signature(model.inference_cross_lingual).parameters.keys())
    else:
        _zs_params_set = set(inspect.signature(model.inference_zero_shot).parameters.keys())

    # Phase 3 (P1-2): inference_instruct2 for non-neutral emotions.
    # Available on CosyVoice2 and CosyVoice3.  Signature:
    #   inference_instruct2(tts_text, instruct_text, prompt_wav, ..., speed=1.0)
    # instruct_text format: "You are a helpful assistant. {instruction}.<|endofprompt|>"
    _has_instruct2 = hasattr(model, "inference_instruct2")
    _instruct2_params_set: set[str] = set()
    if _has_instruct2:
        _instruct2_params_set = set(inspect.signature(model.inference_instruct2).parameters.keys())
        log.info("[CosyVoice] inference_instruct2 available — non-neutral emotions will use it.")

    def _instruct_param(params: set[str]) -> Optional[str]:
        for key in ("instruct_text", "instruct", "instruction", "prompt_instruction"):
            if key in params:
                return key
        return None

    # ── Phase 1: pacing prep ─────────────────────────────────────────────────
    # Use the model's actual sample_rate (P1-7).  Both CosyVoice 2 and 3
    # report 24000 today, but anchoring on model.sample_rate means the worker
    # will follow if a future variant ships a different rate.
    model_sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)
    if model_sample_rate <= 0:
        log.warning(f"[CosyVoice] Invalid model.sample_rate={model_sample_rate!r}; falling back to 24000.")
        model_sample_rate = 24000

    target_chars_per_sec = chars_per_second_for_target()

    # Whether the underlying inference signature accepts our `speed=` argument.
    # Upstream cosyvoice/cli/cosyvoice.py (verified) accepts speed on both
    # inference_zero_shot and inference_cross_lingual, but defending against
    # forks that strip it lets us degrade gracefully instead of crashing.
    _params_set = _cl_params_set if use_cross_lingual else _zs_params_set
    speed_supported = "speed" in _params_set

    # Tunables for the speed solver.  These are intentionally narrow:
    # CosyVoice degrades audibly past speed=1.20, and below 0.85 the prosody
    # gets sluggish.  When the natural rate falls outside this band we let
    # the post-pass atempo (Task #5) take a small additional bite.
    SPEED_MIN = 0.85
    SPEED_MAX = 1.20
    # QA threshold: retry if produced audio is more than 15% over target.
    QA_OVER_RATIO = 1.15
    # Slack so we don't retry on tiny over/undershoots.
    QA_NEAR_TARGET = 0.07  # ±7% considered "good enough"

    def _instruct_param_value(params: set[str], emotion_instruction: str) -> dict:
        instruct_param = _instruct_param(params)
        if instruct_param and emotion_instruction:
            return {instruct_param: emotion_instruction}
        return {}

    def _cosyvoice3_prompt(value: str, assistant_prompt: str = "") -> str:
        """Inject CosyVoice3's '<|endofprompt|>' delimiter without polluting
        the text with the instruct2-only assistant prefix.

        The CosyVoice3 LLM asserts that either tts_text or prompt_text
        contains '<|endofprompt|>'.  Without it the worker silently emits
        no audio.  Earlier this helper prepended
        'You are a helpful assistant.<|endofprompt|>' — but that prefix is
        the instruct2 calling convention.  For zero-shot it gets baked into
        prompt_text (which is supposed to be the verbatim transcription of
        the reference audio), confusing the speaker conditioning; for
        cross-lingual it gets prepended to tts_text, which the model can
        partially synthesise as audible filler.

        We now inject only the bare delimiter at the head of the value, so
        upstream's frontend.text_normalize gets clean content followed by
        the required token.  The optional assistant_prompt argument is kept
        for callers that explicitly want the instruct-style prefix.
        """
        cleaned = str(value or "").strip()
        if not is_cosyvoice3 or not COSYVOICE3_INJECT_PROMPT_PREFIX:
            return cleaned
        if "<|endofprompt|>" in cleaned:
            return cleaned
        if assistant_prompt:
            return f"{assistant_prompt}<|endofprompt|>{cleaned}"
        return f"<|endofprompt|>{cleaned}"

    # ── Synthesize each segment ───────────────────────────────────────────────
    # Phase 3 performance notes:
    # - vLLM (COSYVOICE_VLLM=true): CosyVoice's internal continuous batching
    #   gives ~3× throughput improvement without any Python-level parallelism.
    #   The model handles GPU scheduling internally per upstream vllm_example.py.
    # - fp16 (COSYVOICE_FP16=true): ~1.5-2× faster inference on A10G/T4.
    # - COSYVOICE_PARALLEL_SYNTH: reserved for future Phase 4 pipelining of
    #   post-synthesis I/O (timing-fit, ffmpeg) while synthesis runs.  The
    #   model inference itself is NOT thread-safe without vLLM, so we keep it
    #   sequential in the main loop.
    _vllm_loaded = _init_kw.get("load_vllm", False)
    if _vllm_loaded:
        log.info("[CosyVoice] vLLM continuous batching active — expect ~3× throughput.")
    if COSYVOICE_FP16 and _init_kw.get("fp16", False):
        log.info("[CosyVoice] fp16 active — expect ~1.5-2× faster inference.")

    seg_audios: list[Path] = []
    total_segments = max(1, len(segments))

    # P1-25: Throttle DDB writes during cloning loop.
    # Writing progress for every single segment (80+ writes) wastes DDB WCUs
    # and adds 30-80ms blocking latency per write.  Instead, write at most
    # every 2 seconds OR every 5 segments, whichever comes first.  Always
    # write on the first and last segment so the UI sees start/end promptly.
    _DDB_THROTTLE_INTERVAL_S = 2.0
    _DDB_THROTTLE_EVERY_N = 5
    _last_ddb_write_time = 0.0

    for index, seg in enumerate(segments, start=1):
        # Throttled progress update — reduces DDB writes from N to ~N/5
        now = time.monotonic()
        is_first_or_last = (index == 1 or index == total_segments)
        elapsed_since_last = now - _last_ddb_write_time
        should_write = (
            is_first_or_last
            or (index % _DDB_THROTTLE_EVERY_N == 0)
            or (elapsed_since_last >= _DDB_THROTTLE_INTERVAL_S)
        )
        if should_write:
            update_progress(
                "CLONING",
                54 + int((index - 1) / total_segments * 14),
                f"Cloning voice ({index}/{total_segments})…",
            )
            _last_ddb_write_time = now
        out_path = out_dir / f"seg_{seg['id']:04d}.wav"

        # Use tts_text (TTS-optimised) if Gemini produced it, else translated_text
        text = normalize_tts_pronunciation(
            seg.get("tts_text") or seg.get("translated_text") or ""
        )

        # ── Phase 1: per-segment pacing solver ─────────────────────────────
        # We size the dub so CosyVoice's *internal* speed= shoulders most of
        # the duration fit, leaving the post-pass atempo bite small (≤ 1.10×).
        # All values are recorded into seg["_pacing"] for telemetry / debug.
        seg_speaker_rate = float(seg.get("speaking_rate", 1.0) or 1.0)
        target_speech_seconds = compute_target_speech_seconds(seg)
        predicted_seconds = predict_segment_speech_seconds(
            text, speaking_rate=1.0, chars_per_sec=target_chars_per_sec,
        )
        # Combine duration-fit ratio with Gemini's per-segment speaking_rate.
        # speed > 1 = faster speech = shorter duration.
        if DYNAMIC_VIDEO_LENGTH:
            # Dynamic Video Length: never compress the voice to fit a slot.
            # Speak at the natural rate (only the prosodic speaking_rate
            # applies); the timeline is grown later to fit.
            duration_speed = 1.0
        elif predicted_seconds > 0 and target_speech_seconds > 0:
            duration_speed = predicted_seconds / target_speech_seconds
        else:
            duration_speed = 1.0
        initial_speed = max(SPEED_MIN, min(SPEED_MAX, duration_speed * seg_speaker_rate))

        seg.setdefault("_pacing", {})
        seg["_pacing"].update({
            "target_speech_seconds": round(target_speech_seconds, 3),
            "predicted_seconds": round(predicted_seconds, 3),
            "speaker_rate": round(seg_speaker_rate, 3),
            "duration_speed": round(duration_speed, 3),
            "model_speed": round(initial_speed, 3),
            "speed_supported": speed_supported,
            "chars_per_sec": round(target_chars_per_sec, 2),
            "char_count": _count_speakable_chars(text),
        })

        if not text:
            duration = max(0.1, seg["end"] - seg["start"])
            run_ffmpeg("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                       "-t", str(duration), str(out_path))
            seg_audios.append(out_path)
            seg["_pacing"]["actual_seconds"] = round(duration, 3)
            seg["_pacing"]["synth_method"] = "empty_text_silence"
            continue

        # Resolve which reference to use for this speaker
        speaker = (seg.get("speaker") or DEFAULT_SPEAKER_LABEL)
        if speaker_refs and speaker in speaker_refs:
            try:
                seg_ref_wav, seg_ref_prompt_path = _load_ref(
                    Path(speaker_refs[speaker]), speaker
                )
            except Exception:
                seg_ref_wav, seg_ref_prompt_path = default_ref_wav, default_ref_prompt_path
        else:
            seg_ref_wav, seg_ref_prompt_path = default_ref_wav, default_ref_prompt_path

        seg_prompt_text = speaker_prompt_texts.get(speaker)
        if not seg_prompt_text:
            seg_prompt_text = global_prompt_text
        # CosyVoice3 zero-shot: ensure prompt_text includes the required
        # delimiter. Missing it causes the LLM worker to assert and emit no
        # audio.
        if seg_prompt_text:
            seg_prompt_text = _cosyvoice3_prompt(seg_prompt_text)

        emotion = str(seg.get("emotion", "neutral")).strip().lower()
        emotion_instruction = (
            f"Speak in a {emotion} tone." if emotion and emotion != "neutral" else ""
        )

        # ── Single-shot inference helper.  Returns (audio_tensor, num_samples).
        # Factored out so the QA retry can call it again with a tighter speed.
        def _one_shot(speed_value: float):
            speed_value = float(max(SPEED_MIN, min(SPEED_MAX, speed_value)))
            inference_mode = "unknown"
            inference_started = time.perf_counter()

            # Phase 3 (P1-2): Use inference_instruct2 for non-neutral emotions.
            # This gives audible tone variation (happy/sad/excited/serious)
            # instead of flat neutral on every segment.
            # Only used when:
            #  - model has inference_instruct2
            #  - CosyVoice3 (on CosyVoice2-0.5B, instruct2 speaks the
            #    instruct_text aloud instead of applying it as style control —
            #    upstream bug github.com/FunAudioLLM/CosyVoice/issues/1802)
            #  - emotion is non-neutral
            #  - we're NOT in cross-lingual mode (instruct2 works like zero-shot
            #    with added instruct_text; cross-lingual has a different flow)
            use_instruct2 = (
                _has_instruct2
                and is_cosyvoice3
                and emotion_instruction
                and not use_cross_lingual
            )

            if use_instruct2:
                inference_mode = "instruct2"
                # Format per upstream example.py:
                # instruct_text = "You are a helpful assistant. {instruction}.<|endofprompt|>"
                normalized_emotion_instruction = (emotion_instruction or "").strip()
                if (
                    normalized_emotion_instruction
                    and normalized_emotion_instruction[-1] not in ".!?"
                ):
                    normalized_emotion_instruction += "."
                instruct2_text = (
                    f"You are a helpful assistant. "
                    f"{normalized_emotion_instruction}<|endofprompt|>"
                )
                i2_args: dict = {
                    "tts_text": text,
                    "instruct_text": instruct2_text,
                    "stream": False,
                }
                if "prompt_wav" in _instruct2_params_set:
                    i2_args["prompt_wav"] = seg_ref_prompt_path
                elif "prompt_speech_16k" in _instruct2_params_set:
                    i2_args["prompt_speech_16k"] = seg_ref_wav
                if "speed" in _instruct2_params_set:
                    i2_args["speed"] = speed_value
                chunks = list(cosy_model.inference_instruct2(**i2_args))
            elif use_cross_lingual:
                inference_mode = "cross_lingual"
                # CosyVoice3's cross-lingual path still needs the delimiter in
                # the text stream. Removing it makes the model return no audio
                # for every segment, which then triggers a full neural fallback.
                _cl_tts = _cosyvoice3_prompt(text)
                cl_args: dict = {"tts_text": _cl_tts, "stream": False}
                if "prompt_wav" in _cl_params_set:
                    cl_args["prompt_wav"] = seg_ref_prompt_path
                elif "prompt_speech_16k" in _cl_params_set:
                    cl_args["prompt_speech_16k"] = seg_ref_wav
                else:
                    raise RuntimeError(
                        f"Unsupported CosyVoice cross_lingual signature: {_cl_params_set}"
                    )
                cl_args.update(_instruct_param_value(_cl_params_set, emotion_instruction))
                if speed_supported:
                    cl_args["speed"] = speed_value
                chunks = list(cosy_model.inference_cross_lingual(**cl_args))
            else:
                inference_mode = "zero_shot"
                zs_args: dict = {
                    "tts_text": text,
                    "prompt_text": seg_prompt_text,
                    "stream": False,
                }
                if "prompt_wav" in _zs_params_set:
                    zs_args["prompt_wav"] = seg_ref_prompt_path
                elif "prompt_speech_16k" in _zs_params_set:
                    zs_args["prompt_speech_16k"] = seg_ref_wav
                else:
                    raise RuntimeError(
                        f"Unsupported CosyVoice zero-shot signature: {_zs_params_set}"
                    )
                zs_args.update(_instruct_param_value(_zs_params_set, emotion_instruction))
                if speed_supported:
                    zs_args["speed"] = speed_value
                chunks = list(cosy_model.inference_zero_shot(**zs_args))

            tts_chunks = [
                c["tts_speech"]
                for c in chunks
                if isinstance(c, dict) and c.get("tts_speech") is not None
            ]
            if not tts_chunks:
                raise RuntimeError("CosyVoice returned no audio chunks.")
            tensor = torch.cat(tts_chunks, dim=1)
            if tensor.numel() == 0:
                raise RuntimeError("CosyVoice returned empty audio.")
            inference_wall_seconds = time.perf_counter() - inference_started
            return tensor, tensor.shape[-1], inference_wall_seconds, inference_mode

        # ── Phase 3 (P1-11): Per-segment retry chain ──────────────────────
        # Instead of failing the whole job on a single segment error, we try
        # progressively degraded fallbacks:
        #   1. Clear CUDA cache + retry with same params
        #   2. Retry with default reference (in case speaker ref is corrupt)
        #   3. Fall back to edge-tts (neural voice, no cloning)
        #   4. Last resort: silence (job continues, one seg is muted)
        try:
            audio_data, num_samples, inference_wall_seconds, inference_mode = _one_shot(initial_speed)
            actual_seconds = num_samples / float(model_sample_rate)
            applied_speed = initial_speed
            qa_retry = "no"

            # ── Post-synthesis QA gate (Phase 1: missing-from-audit item) ──
            # Skipped under Dynamic Video Length — that mode never speeds the
            # voice up to hit a duration target.
            if (
                not DYNAMIC_VIDEO_LENGTH
                and speed_supported
                and target_speech_seconds > 0
                and actual_seconds / target_speech_seconds > QA_OVER_RATIO
            ):
                bumped_speed = max(
                    SPEED_MIN,
                    min(
                        SPEED_MAX,
                        applied_speed * (actual_seconds / target_speech_seconds),
                    ),
                )
                if bumped_speed > applied_speed * (1.0 + QA_NEAR_TARGET):
                    log.info(
                        "[CosyVoice] QA retry seg %s: actual=%.2fs target=%.2fs "
                        "speed %.3f → %.3f",
                        seg["id"], actual_seconds, target_speech_seconds,
                        applied_speed, bumped_speed,
                    )
                    try:
                        retry_audio, retry_samples, retry_wall_seconds, retry_mode = _one_shot(bumped_speed)
                        retry_actual = retry_samples / float(model_sample_rate)
                        if abs(retry_actual - target_speech_seconds) < abs(actual_seconds - target_speech_seconds):
                            audio_data = retry_audio
                            num_samples = retry_samples
                            actual_seconds = retry_actual
                            inference_wall_seconds = retry_wall_seconds
                            inference_mode = retry_mode
                            applied_speed = bumped_speed
                            qa_retry = "improved"
                        else:
                            qa_retry = "rejected"
                    except Exception as retry_err:
                        log.warning(
                            "[CosyVoice] QA retry failed for seg %s: %s",
                            seg["id"], retry_err,
                        )
                        qa_retry = "errored"

            torchaudio.save(str(out_path), audio_data, model_sample_rate)
            seg["_pacing"].update({
                "actual_seconds": round(actual_seconds, 3),
                "applied_speed": round(applied_speed, 3),
                "qa_retry": qa_retry,
                "model_sample_rate": model_sample_rate,
                "synth_method": inference_mode,
                "inference_wall_seconds": round(inference_wall_seconds, 3),
                "rtf": round(inference_wall_seconds / max(actual_seconds, 0.001), 3),
            })
        except Exception as first_exc:
            # ── Fallback level 1: CUDA cache clear + retry ─────────────────
            _fallback_succeeded = False
            log.warning(
                "[CosyVoice] Seg %s first attempt failed: %s. Trying cache-clear retry...",
                seg["id"], first_exc,
            )
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                audio_data, num_samples, inference_wall_seconds, inference_mode = _one_shot(initial_speed)
                actual_seconds = num_samples / float(model_sample_rate)
                torchaudio.save(str(out_path), audio_data, model_sample_rate)
                seg["_pacing"].update({
                    "actual_seconds": round(actual_seconds, 3),
                    "applied_speed": round(initial_speed, 3),
                    "qa_retry": "no",
                    "model_sample_rate": model_sample_rate,
                    "synth_method": "retry_cache_clear",
                    "inference_wall_seconds": round(inference_wall_seconds, 3),
                    "rtf": round(inference_wall_seconds / max(actual_seconds, 0.001), 3),
                })
                _fallback_succeeded = True
            except Exception as retry_exc:
                log.warning(
                    "[CosyVoice] Seg %s cache-clear retry failed: %s",
                    seg["id"], retry_exc,
                )

            # ── Fallback level 2: default reference ────────────────────────
            if not _fallback_succeeded and (seg_ref_prompt_path != default_ref_prompt_path):
                log.warning(
                    "[CosyVoice] Seg %s retrying with default reference...",
                    seg["id"],
                )
                try:
                    # Temporarily swap reference for this retry
                    _orig_ref_path = seg_ref_prompt_path
                    _orig_ref_wav = seg_ref_wav
                    seg_ref_prompt_path = default_ref_prompt_path
                    seg_ref_wav = default_ref_wav
                    audio_data, num_samples, inference_wall_seconds, inference_mode = _one_shot(initial_speed)
                    actual_seconds = num_samples / float(model_sample_rate)
                    torchaudio.save(str(out_path), audio_data, model_sample_rate)
                    seg["_pacing"].update({
                        "actual_seconds": round(actual_seconds, 3),
                        "applied_speed": round(initial_speed, 3),
                        "qa_retry": "no",
                        "model_sample_rate": model_sample_rate,
                        "synth_method": "fallback_default_ref",
                        "inference_wall_seconds": round(inference_wall_seconds, 3),
                        "rtf": round(inference_wall_seconds / max(actual_seconds, 0.001), 3),
                    })
                    _fallback_succeeded = True
                except Exception as default_ref_err:
                    log.warning(
                        "[CosyVoice] Seg %s default-reference retry failed: %s",
                        seg["id"], default_ref_err,
                    )
                finally:
                    seg_ref_prompt_path = _orig_ref_path
                    seg_ref_wav = _orig_ref_wav

            # ── Fallback level 3: edge-tts ─────────────────────────────────
            if not _fallback_succeeded:
                log.warning(
                    "[CosyVoice] Seg %s falling back to edge-tts...",
                    seg["id"],
                )
                try:
                    edge_path = synthesize_edge_tts_single(seg, out_dir)
                    # Copy to expected path
                    import shutil as _shutil_fb
                    _shutil_fb.copy2(str(edge_path), str(out_path))
                    seg["_pacing"].update({
                        "actual_seconds": round(float(seg["end"]) - float(seg["start"]), 3),
                        "applied_speed": 1.0,
                        "qa_retry": "no",
                        "model_sample_rate": 24000,
                        "synth_method": "fallback_edge_tts",
                    })
                    _fallback_succeeded = True
                except Exception as edge_err:
                    log.warning(
                        "[CosyVoice] Seg %s edge-tts also failed: %s",
                        seg["id"], edge_err,
                    )

            # ── Fallback level 4: gTTS emergency voice ─────────────────────
            if not _fallback_succeeded:
                log.warning(
                    "[CosyVoice] Seg %s falling back to gTTS emergency voice...",
                    seg["id"],
                )
                try:
                    gtts_path = synthesize_gtts_single(seg, out_dir)
                    import shutil as _shutil_gtts
                    _shutil_gtts.copy2(str(gtts_path), str(out_path))
                    seg["_pacing"].update({
                        "actual_seconds": round(float(seg["end"]) - float(seg["start"]), 3),
                        "applied_speed": 1.0,
                        "qa_retry": "no",
                        "model_sample_rate": 24000,
                        "synth_method": "fallback_gtts",
                    })
                    _fallback_succeeded = True
                except Exception as gtts_err:
                    log.warning(
                        "[CosyVoice] Seg %s gTTS also failed: %s",
                        seg["id"], gtts_err,
                    )

            # ── Fallback level 5: silence ──────────────────────────────────
            if not _fallback_succeeded:
                log.warning(
                    "[CosyVoice] Seg %s all fallbacks exhausted. Inserting silence.",
                    seg["id"],
                )
                silence_path = synthesize_silence_single(seg, out_dir)
                import shutil as _shutil_fb2
                _shutil_fb2.copy2(str(silence_path), str(out_path))
                seg["_pacing"].update({
                    "actual_seconds": round(float(seg["end"]) - float(seg["start"]), 3),
                    "applied_speed": 1.0,
                    "qa_retry": "no",
                    "model_sample_rate": 24000,
                    "synth_method": "fallback_silence",
                })

        seg_audios.append(out_path)
        log.info(
            "[CosyVoice] Seg %s/%s done (speaker=%s, speed=%.3f, "
            "actual/target=%.2fs/%.2fs, wall=%.2fs, rtf=%.2f, method=%s).",
            seg["id"], len(segments), speaker,
            seg["_pacing"]["applied_speed"],
            seg["_pacing"]["actual_seconds"],
            seg["_pacing"]["target_speech_seconds"],
            float(seg["_pacing"].get("inference_wall_seconds", 0.0) or 0.0),
            float(seg["_pacing"].get("rtf", 0.0) or 0.0),
            seg["_pacing"].get("synth_method", "unknown"),
        )

    update_progress("CLONING", 59, "Voice cloning complete.")
    model = None
    cosy_model = None
    torch.cuda.empty_cache()
    log.info("[CosyVoice] Voice cloning complete.")
    return seg_audios


def synthesize_edge_tts_single(seg: dict, out_dir: Path) -> Path:
    """edge-tts synthesis for a single segment (fallback)."""
    import asyncio, edge_tts
    voice = LANG_TO_EDGE_TTS.get(TARGET_LANG_CODE, "en-US-AriaNeural")
    out_path = out_dir / f"seg_{seg['id']:04d}_edgetts.mp3"
    rate_pct = int((seg.get("speaking_rate", 1.0) - 1.0) * 100)
    rate_str = f"{rate_pct:+d}%"
    text = normalize_tts_pronunciation(seg.get("tts_text") or seg.get("translated_text") or "")

    async def _run():
        c = edge_tts.Communicate(text=text, voice=voice, rate=rate_str)
        await c.save(str(out_path))

    asyncio.run(_run())

    # Convert mp3 → wav
    wav_path = out_path.with_suffix(".wav")
    run_ffmpeg("-i", str(out_path), "-ar", "24000", "-ac", "1", str(wav_path))
    return wav_path


def synthesize_gtts_single(seg: dict, out_dir: Path) -> Path:
    """gTTS emergency fallback for a single segment."""
    from gtts import gTTS
    out_path = out_dir / f"seg_{seg['id']:04d}_gtts.mp3"
    wav_path = out_path.with_suffix(".wav")
    gtts_lang = GTTS_LANG_MAP.get(TARGET_LANG_CODE, TARGET_LANG_CODE)
    text = normalize_tts_pronunciation(seg.get("tts_text") or seg.get("translated_text") or "")
    gTTS(text=text, lang=gtts_lang).save(str(out_path))
    run_ffmpeg("-i", str(out_path), "-ar", "24000", "-ac", "1", str(wav_path))
    return wav_path

def synthesize_silence_single(seg: dict, out_dir: Path) -> Path:
    """Last-resort segment fallback so one bad TTS segment does not fail the video."""
    seg.setdefault("_pacing", {})["synth_method"] = "fallback_silence"
    out_path = out_dir / f"seg_{seg['id']:04d}_silence.wav"
    duration = max(0.25, float(seg.get("end", 0)) - float(seg.get("start", 0)))
    run_ffmpeg("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(duration), str(out_path))
    return out_path

def synthesize_all(
    segments: list[dict],
    reference_audio: Path,
    out_dir: Path,
    speaker_refs: Optional[dict] = None,
    speaker_prompt_texts: Optional[dict] = None,
) -> tuple[list[Path], bool]:
    """
    Master TTS router: CosyVoice -> edge-tts -> gTTS (auto-fallback at every level).
    speaker_refs: {speaker_label: Path} for per-speaker voice cloning.
    Returns (seg_audio_paths, voice_was_cloned).
    """
    if VOICE_CLONE:
        try:
            paths = synthesize_segments_cosyvoice(
                segments,
                reference_audio,
                out_dir,
                speaker_refs=speaker_refs,
                speaker_prompt_texts=speaker_prompt_texts,
            )
            cloned_methods = {
                "zero_shot",
                "cross_lingual",
                "instruct2",
                "retry_cache_clear",
                "fallback_default_ref",
            }
            # Segments that legitimately produced silence because the source
            # had no spoken content there.  These should not pollute the
            # clone-ratio metric — there was nothing to clone in the first
            # place, so calling them "fallback" is misleading and can cause
            # the 80% clone-ratio gate to fail on perfectly fine jobs that
            # happened to contain a few non-speech windows.
            non_clone_legitimate_methods = {"empty_text_silence"}
            synth_methods = [
                str((seg.get("_pacing") or {}).get("synth_method", "unknown"))
                for seg in segments
            ]
            cloned_count = sum(1 for method in synth_methods if method in cloned_methods)
            legitimate_count = sum(1 for method in synth_methods if method in non_clone_legitimate_methods)
            audit_total = max(1, len(synth_methods) - legitimate_count)
            fallback_count = len(synth_methods) - cloned_count - legitimate_count
            silence_count = sum(1 for method in synth_methods if method == "fallback_silence")
            clone_ratio = cloned_count / audit_total
            log.info(
                "[TTS] CosyVoice segment audit: cloned=%s fallback=%s silence=%s legitimate_silence=%s total=%s methods=%s",
                cloned_count, fallback_count, silence_count, legitimate_count, len(synth_methods), synth_methods,
            )
            if clone_ratio < 0.80 or silence_count > 0:
                raise RuntimeError(
                    f"CosyVoice did not produce a reliable cloned dub "
                    f"({cloned_count}/{audit_total} cloned, {silence_count} silent)."
                )
            log.info("[TTS] CosyVoice voice cloning succeeded.")
            return paths, True
        except Exception as cv_err:
            clone_fail_msg = f"Voice clone failed ({cv_err})."
            log.warning(f"[TTS] {clone_fail_msg}")
            if not ALLOW_VOICE_CLONE_FALLBACK:
                raise RuntimeError(
                    f"Voice clone was requested but CosyVoice failed: {cv_err}"
                ) from cv_err
            update_progress(
                "CLONING", 55,
                "⚠️ Voice clone unavailable — using neural voice instead.",
                {"voice_clone_warning": clone_fail_msg}
            )

    # Shared path: edge-tts for all segments, gTTS emergency
    log.info("[TTS] Using edge-tts neural voice (no voice clone).")
    paths = []
    total_segments = max(1, len(segments))
    for index, seg in enumerate(segments, start=1):
        update_progress(
            "CLONING",
            52 + int((index - 1) / total_segments * 7),
            f"Generating neural voice ({index}/{total_segments})...",
        )
        try:
            paths.append(synthesize_edge_tts_single(seg, out_dir))
        except Exception as e:
            log.warning(f"[TTS] edge-tts seg {seg['id']} failed: {e}. Falling back to gTTS.")
            try:
                paths.append(synthesize_gtts_single(seg, out_dir))
            except Exception as gtts_err:
                log.warning(f"[TTS] gTTS seg {seg['id']} failed: {gtts_err}. Inserting silence for this segment.")
                paths.append(synthesize_silence_single(seg, out_dir))
    update_progress("CLONING", 59, "Voice generation complete.")
    return paths, False  # ← clone was NOT used


# ——————————————————————————————————————————————————————————————————————————————————————————————————
# Stage 5: Timing adapter — fit TTS audio to original segment duration
# ——————————————————————————————————————————————————————————————————————————————————————————————————

# Phase 1: residual atempo bounds.  CosyVoice's internal speed= already
# absorbed most of the duration fit, so atempo runs only on the small residual.
# Going past these bounds was the dominant cause of "chipmunk" / "drugged"
# dub audio.
ATEMPO_MIN = 0.92
ATEMPO_MAX = 1.10
# Hard ceiling on the COMBINED speed-up a segment may ever receive
# (CosyVoice speed= × post-pass atempo).  The model's internal speed= is the
# higher-quality, prosody-aware mechanism; atempo is a raw tempo stretch.  We
# let the model do the heavy lifting (up to SPEED_MAX) and only allow atempo to
# add whatever headroom remains under this ceiling.  Anything still over budget
# leans into the pause (overflow) or is silence-trimmed rather than warped into
# an unnatural, rushed delivery.
MAX_COMBINED_SPEED = 1.25
# How much the dub may overflow past the slot boundary into the inter-segment
# gap.  Lets CosyVoice keep natural prosody without colliding with the next
# segment's start.  Phase 4 will add equal-power crossfades that benefit
# from this headroom too.
SLOT_OVERFLOW_MAX_SECONDS = 0.40


def fit_audio_to_duration(
    audio_path: Path,
    target_duration: float,
    out_dir: Path,
    *,
    next_seg_start: Optional[float] = None,
    seg_start: Optional[float] = None,
    pacing: Optional[dict] = None,
) -> Path:
    """
    Fit synthesized segment audio to its slot.

    Phase 1 redesign:
      * CosyVoice's internal `speed=` has already done the heavy duration
        fit, so this pass only nudges the residual.
      * atempo is clamped to [ATEMPO_MIN, ATEMPO_MAX] (0.92x-1.10x).  A bit
        further than 1.0 in either direction is the maximum that still
        sounds natural after the in-model speed adjustment.
      * The dub is allowed to overflow up to SLOT_OVERFLOW_MAX_SECONDS into
        the inter-segment gap (capped at the actual gap when known) so we
        don't clip end syllables or speed-warp the line into nonsense.
      * Tail silence is trimmed first (silence-only) so we never speed up
        a line just because CosyVoice added a polite trailing pause.
      * All decisions are recorded into `pacing` (the seg["_pacing"] dict)
        for telemetry.
    """
    import numpy as np
    import soundfile as sf

    def _atempo_chain(value: float) -> str:
        # Phase 1 keeps the chain helper for one-shot in-bounds atempo, but
        # since we now clamp to [0.92, 1.10] we never actually need >1 stage.
        # The chain handler stays here as a defensive guard against bugs.
        filters: list[str] = []
        ratio = float(value)
        while ratio > 2.0:
            filters.append("atempo=2.0")
            ratio /= 2.0
        while ratio < 0.5:
            filters.append("atempo=0.5")
            ratio *= 2.0
        filters.append(f"atempo={round(ratio, 3)}")
        return ",".join(filters)

    pacing = pacing if pacing is not None else {}

    data, sr = sf.read(str(audio_path))
    if sr <= 0:
        raise RuntimeError(f"Invalid sample rate {sr} while reading {audio_path}.")
    if data.ndim > 1:
        data = data.mean(axis=1)
    actual_dur = len(data) / sr
    if not math.isfinite(actual_dur) or actual_dur <= 0:
        log.warning("[Timing] Empty audio for %s; inserting silence.", audio_path.name)
        out_path = audio_path.with_stem(audio_path.stem + "_silence")
        duration = max(0.25, float(target_duration or 0.25))
        run_ffmpeg("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(duration), str(out_path))
        pacing.update({
            "applied_atempo": 1.0,
            "final_seconds": round(duration, 3),
            "overflow_into_gap": 0.0,
            "fit_action": "silence",
        })
        return out_path

    # 1. Compute the maximum length we can safely write.
    # The dub may overflow into the gap before next_seg_start, capped at
    # SLOT_OVERFLOW_MAX_SECONDS.  When next_seg_start is unknown (final
    # segment), we still allow the small overflow - main() places audio
    # by start timestamp, so a tiny tail past the slot is harmless.
    if (
        next_seg_start is not None
        and seg_start is not None
        and math.isfinite(next_seg_start)
        and math.isfinite(seg_start)
    ):
        gap = max(0.0, float(next_seg_start) - float(seg_start) - float(target_duration))
        overflow_budget = max(0.0, min(SLOT_OVERFLOW_MAX_SECONDS, gap))
    else:
        overflow_budget = SLOT_OVERFLOW_MAX_SECONDS
    max_dur = float(target_duration) + overflow_budget

    # 2. Tail silence trim BEFORE atempo.
    # CosyVoice often adds a 100-300 ms polite tail.  Trim only that
    # silence (top_db=40, conservative) so we never speed up a line just
    # to fit a pause that no listener would notice.
    trimmed_seconds = 0.0
    try:
        import librosa  # local import; main worker may already have it loaded
        trimmed_data, _ = librosa.effects.trim(data, top_db=40)
        if len(trimmed_data) > 0 and len(trimmed_data) < len(data):
            trimmed_seconds = (len(data) - len(trimmed_data)) / sr
            data = trimmed_data
            actual_dur = len(data) / sr
    except Exception as trim_err:
        log.debug("[Timing] Tail trim skipped for %s: %s", audio_path.name, trim_err)

    overflow_into_gap = max(0.0, actual_dur - float(target_duration))
    overflow_into_gap = min(overflow_into_gap, overflow_budget)

    # 3. Decide the final action.
    out_path = audio_path.with_stem(audio_path.stem + "_fitted")

    # 3a. Already inside slot+overflow -> keep, optionally just rewrite.
    if actual_dur <= max_dur + 0.05:
        pacing.update({
            "applied_atempo": 1.0,
            "final_seconds": round(actual_dur, 3),
            "overflow_into_gap": round(overflow_into_gap, 3),
            "tail_trimmed_seconds": round(trimmed_seconds, 3),
            "fit_action": "passthrough" if trimmed_seconds == 0.0 else "trim_only",
        })
        if trimmed_seconds > 0.0:
            sf.write(str(out_path), data.astype(np.float32, copy=False), sr)
            return out_path
        return audio_path

    # 3b. Still too long -> atempo clamped to [ATEMPO_MIN, ATEMPO_MAX].
    # We pick the ratio that lands at exactly max_dur, but never above
    # ATEMPO_MAX (= 1.10x) AND never so far that the COMBINED speed-up
    # (CosyVoice speed= × atempo) exceeds MAX_COMBINED_SPEED.  The model's
    # speed= is the higher-quality mechanism, so when a segment was already
    # sped up in-model we shrink the atempo headroom accordingly.  Any
    # remaining overshoot is then silence-trimmed by assemble_dubbed_audio()
    # — bounded to a couple of frames of voiced samples at most.
    raw_ratio = actual_dur / max(max_dur, 0.1)
    model_speed = float(pacing.get("applied_speed", 1.0) or 1.0)
    atempo_ceiling = ATEMPO_MAX
    if model_speed > 1.0:
        # Keep model_speed × atempo ≤ MAX_COMBINED_SPEED; never force a
        # slowdown in this (too-long) branch, so floor the ceiling at 1.0.
        atempo_ceiling = max(1.0, min(ATEMPO_MAX, MAX_COMBINED_SPEED / model_speed))
    applied_atempo = max(ATEMPO_MIN, min(atempo_ceiling, raw_ratio))
    final_seconds = actual_dur / applied_atempo

    # If the trim already fit, write the trimmed buffer; otherwise re-run
    # ffmpeg from the trimmed buffer to apply atempo.
    if trimmed_seconds > 0.0:
        # Persist the trimmed buffer so atempo input is clean.
        sf.write(str(out_path), data.astype(np.float32, copy=False), sr)
        atempo_input = out_path
    else:
        atempo_input = audio_path

    tempo_filters = _atempo_chain(applied_atempo)
    atempo_out = audio_path.with_stem(audio_path.stem + "_fitted_tempo")
    run_ffmpeg("-i", str(atempo_input), "-filter:a", tempo_filters, str(atempo_out))

    overflow_into_gap = max(0.0, final_seconds - float(target_duration))
    overflow_into_gap = min(overflow_into_gap, overflow_budget)

    pacing.update({
        "applied_atempo": round(applied_atempo, 3),
        "final_seconds": round(final_seconds, 3),
        "overflow_into_gap": round(overflow_into_gap, 3),
        "tail_trimmed_seconds": round(trimmed_seconds, 3),
        "fit_action": "atempo_clamped" if raw_ratio > applied_atempo + 1e-6 else "atempo",
        "raw_atempo_needed": round(raw_ratio, 3),
        "atempo_ceiling": round(atempo_ceiling, 3),
    })
    return atempo_out


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 6: Lip sync (LatentSync 1.6 — graceful fallback to dubbed-audio-only)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _ensure_latentsync_checkpoint(ckpt_dir: Path) -> Path:
    ckpt_path = ckpt_dir / LATENTSYNC_CHECKPOINT
    if ckpt_path.exists():
        return ckpt_path
    if not ALLOW_RUNTIME_MODEL_DOWNLOADS:
        raise RuntimeError(
            f"LatentSync checkpoint not found at {ckpt_path}. "
            "Set ALLOW_RUNTIME_MODEL_DOWNLOADS=1 or rebuild with DOWNLOAD_MODELS_AT_BUILD=true."
        )

    log.info(f"[LatentSync] Downloading {LATENTSYNC_CHECKPOINT} from {LATENTSYNC_REPO_ID}...")
    from huggingface_hub import hf_hub_download

    ckpt_dir.mkdir(parents=True, exist_ok=True)
    path = Path(
        hf_hub_download(
            LATENTSYNC_REPO_ID,
            LATENTSYNC_CHECKPOINT,
            local_dir=str(ckpt_dir),
        )
    )
    log.info(f"[LatentSync] Checkpoint ready at {path}")
    return path


def run_lipsync_latentsync(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """LatentSync — diffusion-based lip sync.
    Defaults to 256x256 (stage2.yaml) which fits on a T4 GPU (16 GB VRAM).
    Set LIP_SYNC_QUALITY="latentsync_hq" for 512x512 (needs 24 GB+ VRAM).
    """
    out_path = out_dir / "latentsync_output.mp4"
    ls_dir = MODEL_CACHE_DIR / "LatentSync"

    if not ls_dir.exists():
        raise RuntimeError(
            f"LatentSync repo not found at {ls_dir}. "
            "Translator image is missing preloaded model dependencies."
        )

    # Install LatentSync runtime deps on first job (lazily, not in CI build)
    _latentsync_deps_flag = ls_dir / ".deps_installed"
    if not _latentsync_deps_flag.exists():
        log.info("[LatentSync] Installing runtime deps (first run only)...")
        runtime_requirements = ls_dir / "requirements.runtime.txt"
        write_runtime_requirements(ls_dir / "requirements.txt", runtime_requirements)
        constraints = Path("/app/constraints.txt")
        result = subprocess.run(
            pip_install_command(runtime_requirements, constraints),
            check=False,
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            raise RuntimeError(
                "LatentSync runtime dependency install failed. "
                f"pip stderr:\n{result.stderr[-3000:]}"
            )
        _latentsync_deps_flag.touch()

    # Verify checkpoint files
    ckpt_dir  = ls_dir / "checkpoints"
    ckpt_path = _ensure_latentsync_checkpoint(ckpt_dir)
    if not ckpt_path.exists():
        raise RuntimeError(
            f"LatentSync checkpoint not found at {ckpt_path}. "
            "Rebuild the Docker image."
        )
    ls_whisper = ckpt_dir / "whisper" / "tiny.pt"
    if not ls_whisper.exists():
        raise RuntimeError(
            f"LatentSync whisper/tiny.pt missing at {ls_whisper}. "
            "Rebuild the Docker image."
        )

    # Choose resolution config based on quality setting.
    # stage2_512.yaml = 512x512 (official recommended, needs ~18-24 GB VRAM)
    # stage2.yaml     = 256x256 (T4-compatible, 16 GB VRAM sufficient)
    if LIP_SYNC_QUALITY in ("latentsync_hq", "hq", "512"):
        config_file = "configs/unet/stage2_512.yaml"
        log.info("[LatentSync] 512x512 HQ mode (requires 24 GB+ VRAM)")
    else:
        config_file = "configs/unet/stage2.yaml"
        log.info("[LatentSync] 256x256 standard mode (T4 / 16 GB VRAM compatible)")

    # Per-job isolated temp dir — auto-cleaned with the job work_dir
    temp_dir = out_dir / "latentsync_temp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Prepend LatentSync repo to PYTHONPATH so its internal imports resolve
    latentsync_env = os.environ.copy()
    existing_pythonpath = latentsync_env.get("PYTHONPATH", "")
    latentsync_env["PYTHONPATH"] = (
        str(ls_dir)
        if not existing_pythonpath
        else f"{ls_dir}{os.pathsep}{existing_pythonpath}"
    )

    # Background thread that ticks DynamoDB progress every 30 s while
    # LatentSync runs, so the frontend shows elapsed time instead of freezing.
    stop_event = threading.Event()
    def _progress_updater():
        start = time.monotonic()
        while not stop_event.is_set():
            elapsed = int(time.monotonic() - start)
            m, s = divmod(elapsed, 60)
            # Creep from 70 % to 81 % over the run (82 % is marked complete)
            pct = min(81, 70 + int(elapsed / 45))
            update_progress(
                "LIPSYNC", pct,
                f"Lip sync running... {m}m {s:02d}s elapsed"
            )
            stop_event.wait(30)
    progress_thread = threading.Thread(target=_progress_updater, daemon=True)
    progress_thread.start()

    try:
        result = subprocess.run(
            [
                sys.executable, "scripts/inference.py",
                # FIXED: correct argparse argument names (--unet_config and
                # --inference_ckpt would be silently ignored / raise errors)
                "--unet_config_path",   config_file,
                "--inference_ckpt_path", str(ckpt_path),
                "--inference_steps",    "20",
                "--guidance_scale",     "1.5",   # official inference.sh value
                "--enable_deepcache",            # ~2-3x faster, minimal quality loss
                "--temp_dir",           str(temp_dir),  # per-job, cleaned with work_dir
                "--video_path",         str(video_path),
                "--audio_path",         str(dubbed_audio),
                "--video_out_path",     str(out_path),
            ],
            capture_output=True,
            text=True,
            cwd=str(ls_dir),
            env=latentsync_env,
            timeout=4500,  # 75-minute hard stop prevents hanging jobs
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            "LatentSync timed out after 75 minutes. "
            "Consider disabling lip sync for very long videos."
        )
    finally:
        stop_event.set()
        progress_thread.join(timeout=2)

    # Always emit stderr to CloudWatch for post-job debugging
    if result.stderr.strip():
        log.info(f"[LatentSync] stderr (last 3000 chars):\n{result.stderr[-3000:]}")

    if result.returncode != 0:
        raise RuntimeError(
            f"LatentSync failed (exit {result.returncode}):\n"
            f"{result.stderr[-4000:]}"
        )
    if not out_path.exists():
        raise FileNotFoundError(
            f"LatentSync exited 0 but produced no output at {out_path}. "
            f"stdout: {result.stdout[-1000:]}"
        )
    log.info(f"[LatentSync] Done => {out_path}")
    return out_path

def run_lipsync(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Optional[Path]:
    """
    Lip sync via LatentSync 1.6.
    Returns lipsync output path on success, or None on failure.
    Caller is responsible for falling back to plain audio mux.
    """
    log.info("[LipSync] Running LatentSync...")
    try:
        return run_lipsync_latentsync(video_path, dubbed_audio, out_dir)
    except Exception as e:
        warn_msg = f"LatentSync failed: {e}"
        if not ALLOW_LIP_SYNC_FALLBACK:
            raise RuntimeError(warn_msg) from e
        log.warning(f"[LipSync] {warn_msg} -- continuing with dubbed audio only.")
        update_progress(
            "LIPSYNC", 82,
            "Lip sync unavailable -- video will have dubbed audio only.",
            {"lipsync_warning": warn_msg}
        )
        return None  # Caller will mux dubbed audio into original video

# Stage 7: Assemble per-segment audio into one dubbed audio track
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def assemble_dubbed_audio(
    segments: list[dict],
    seg_audio_paths: list[Path],
    video_duration: float,
    out_dir: Path,
    background_audio: Optional[Path] = None,
) -> Path:
    """
    Place per-segment audio at correct timestamps, mix with background if provided.

    Phase 1 redesign:
      * No more hard-cut + 60 ms fade.  fit_audio_to_duration() has already
        sized the dub to slot + bounded gap-overflow (SLOT_OVERFLOW_MAX_SECONDS).
      * Each segment is placed at its original start time and is allowed to
        run up to the *next* segment's start (so we never collide with the
        next line).
      * If the segment audio is somehow still longer than that available
        window, we silence-only-trim the tail (top_db=40) before placing.
        That removes only quiet pauses CosyVoice may have appended; it
        never speed-warps voiced samples and it never chops mid-syllable.
      * Per-segment placement telemetry is recorded into seg["_pacing"]
        (placed_seconds, placed_overflow_seconds, placed_action).

    Phase 6 addition (P1-9): Emotion transition smoothing.
      * Minimum emotion window: if a single segment has a different emotion
        from both its neighbours, flatten it to the surrounding emotion
        (prevents jittery single-frame emotion flips).
      * At boundaries where emotion changes, apply a wider crossfade
        (EMOTION_TRANSITION_CROSSFADE_MS) to smooth the tonal shift.
    """
    SR = 24000
    import numpy as np
    import soundfile as sf

    # ── P1-9: Emotion transition smoothing — minimum emotion window ───────
    # Very short bounded emotion runs are likely Gemini glitches (e.g.
    # "excited" sandwiched between two "neutral" runs). Flatten any run shorter
    # than EMOTION_MIN_WINDOW to the surrounding emotion when both sides match.
    EMOTION_MIN_WINDOW = 2  # minimum consecutive segments for an emotion to hold
    EMOTION_TRANSITION_CROSSFADE_MS = 100  # wider crossfade at emotion boundaries

    if len(segments) >= 3 and EMOTION_MIN_WINDOW > 1:
        normalized_emotions = [
            str(seg.get("emotion", "neutral")).strip().lower() for seg in segments
        ]
        i = 0
        while i < len(segments):
            run_start = i
            run_emo = normalized_emotions[i]
            while i + 1 < len(segments) and normalized_emotions[i + 1] == run_emo:
                i += 1
            run_end = i
            run_len = run_end - run_start + 1

            if 0 < run_start and run_end < len(segments) - 1 and run_len < EMOTION_MIN_WINDOW:
                prev_emo = normalized_emotions[run_start - 1]
                next_emo = normalized_emotions[run_end + 1]
                if prev_emo == next_emo and run_emo != prev_emo:
                    for j in range(run_start, run_end + 1):
                        segments[j]["emotion"] = prev_emo
                        segments[j].setdefault("_pacing", {})["emotion_smoothed"] = f"{run_emo}->{prev_emo}"
                        normalized_emotions[j] = prev_emo

            i += 1

    # Pre-compute emotion transition flags for the placement loop
    _emotion_transitions: set[int] = set()
    for i in range(1, len(segments)):
        prev_emo = str(segments[i - 1].get("emotion", "neutral")).strip().lower()
        curr_emo = str(segments[i].get("emotion", "neutral")).strip().lower()
        if prev_emo != curr_emo:
            _emotion_transitions.add(i)

    log.info("[Assemble] Assembling final dubbed audio track...")
    if not math.isfinite(video_duration) or video_duration <= 0:
        raise RuntimeError(f"Cannot assemble dubbed audio for invalid video duration: {video_duration!r}")
    if len(seg_audio_paths) < len(segments):
        raise RuntimeError(
            f"Only {len(seg_audio_paths)} synthesized audio files for {len(segments)} segments."
        )
    min_samples = max(1, int(math.ceil(video_duration * SR)))
    mixed = np.zeros(min_samples, dtype=np.float32)
    prev_placed_end_sample = 0

    for idx, (seg, audio_path) in enumerate(zip(segments, seg_audio_paths)):
        seg.setdefault("_pacing", {})
        if not audio_path.exists():
            log.warning(f"[Assemble] Missing audio for segment {seg['id']}")
            seg["_pacing"]["placed_action"] = "missing"
            continue

        try:
            data, sr = sf.read(str(audio_path))
        except Exception as exc:
            log.warning(f"[Assemble] Could not read segment audio {audio_path}: {exc}")
            seg["_pacing"]["placed_action"] = f"read_error:{exc!r}"
            continue
        if sr <= 0 or len(data) == 0:
            log.warning(f"[Assemble] Empty/invalid audio for segment {seg['id']}: {audio_path}")
            seg["_pacing"]["placed_action"] = "empty"
            continue
        if data.ndim > 1:
            data = data.mean(axis=1)  # stereo -> mono

        # Resample if needed
        if sr != SR:
            import librosa
            data = librosa.resample(data, orig_sr=sr, target_sr=SR)

        # ── Phase 1 placement window ───────────────────────────────────────
        # Slot is the original ASR window.  The dub may run past slot end up
        # to the start of the next segment (or video_duration for the last
        # segment).  This is the headroom fit_audio_to_duration's overflow
        # was sized for.
        slot_end_sec = float(seg["end"])
        if idx + 1 < len(segments):
            collision_sec = float(segments[idx + 1]["start"])
        else:
            collision_sec = float(video_duration)
        # Never let the placement reach into the next segment's slot.  Leave
        # a 30 ms guard so a future crossfade pass (Phase 4) has headroom.
        max_end_sec = max(slot_end_sec, collision_sec - 0.030)
        # Pathological diarization: keep at least the slot.
        if max_end_sec < slot_end_sec:
            max_end_sec = slot_end_sec
        max_seg_samples = max(1, int((max_end_sec - float(seg["start"])) * SR))

        original_samples = len(data)
        placed_action = "passthrough"
        if len(data) > max_seg_samples:
            # Try a silence-only tail trim first (top_db=40 is conservative;
            # only inaudible silence is trimmed).  This usually fits the dub
            # within the available window without losing any speech.
            try:
                import librosa as _librosa
                trimmed_data, _ = _librosa.effects.trim(
                    data.astype(np.float32, copy=False), top_db=40,
                )
                if len(trimmed_data) > 0 and len(trimmed_data) < len(data):
                    data = trimmed_data
                    placed_action = "tail_trim"
            except Exception as trim_err:
                log.debug("[Assemble] Tail trim skipped seg %s: %s", seg["id"], trim_err)

            # If we still don't fit, perform a *silence-only* hard cap at the
            # collision boundary.  We keep voiced frames whenever the cap
            # lands inside silence; if the cap lands inside speech this is
            # the bounded-but-unavoidable safety net.
            if len(data) > max_seg_samples:
                placed_action = "boundary_cut"
                data = data[:max_seg_samples]
        if len(data) == 0:
            continue

        start_sample = max(0, int(seg["start"] * SR))
        end_sample = start_sample + len(data)
        if end_sample > len(mixed):
            mixed = np.pad(mixed, (0, end_sample - len(mixed)))

        # Track the furthest sample written by previous iterations so we can
        # crossfade only over the true overlap, not over a fixed probe window.
        # ── Phase 4 (P1-22): Equal-power crossfade at segment boundaries ──
        # When this segment overlaps with already-placed audio (from a
        # previous segment's overflow into the gap), we apply an equal-power
        # crossfade over the actual overlap region. This eliminates clicks,
        # avoids attenuating non-overlapping leading audio, and handles long
        # overlaps consistently by blending the full overlap.
        #
        # Phase 6 (P1-9): At emotion transitions, we apply a wider crossfade
        # (EMOTION_TRANSITION_CROSSFADE_MS) even when there's no natural
        # overlap, by blending the tail of the previous segment's placed
        # audio with the head of this segment.  This smooths the tonal shift
        # between e.g. "neutral" → "excited" without an abrupt hard cut.
        overlap_start = start_sample
        overlap_end = min(end_sample, prev_placed_end_sample)
        overlap_len = max(0, overlap_end - overlap_start)

        # Determine crossfade length: use wider window at emotion transitions
        is_emotion_transition = idx in _emotion_transitions
        if is_emotion_transition and overlap_len == 0:
            # No natural overlap, but we want to smooth the emotion boundary.
            # Create a synthetic crossfade zone over the last N ms of the
            # previously placed audio and the first N ms of this segment.
            emotion_xfade_samples = int(EMOTION_TRANSITION_CROSSFADE_MS / 1000.0 * SR)
            # Only apply if there's enough data on both sides
            xfade_len = min(
                emotion_xfade_samples,
                max(0, prev_placed_end_sample - start_sample),  # available tail
                len(data),  # available head
            )
            if xfade_len > 0 and start_sample < prev_placed_end_sample:
                # There IS some overlap we missed detecting — use it
                overlap_len = min(xfade_len, prev_placed_end_sample - start_sample)
                overlap_end = start_sample + overlap_len

        if overlap_len > 0:
            existing_region = mixed[overlap_start:overlap_end].copy()
            # Equal-power: sqrt-based fade curves (energy-preserving)
            t = np.linspace(0, 1, overlap_len, dtype=np.float32)
            fade_in = np.sqrt(t)
            fade_out = np.sqrt(1.0 - t)
            # Blend only the true overlap: fade out existing, fade in new
            blended = existing_region * fade_out + data[:overlap_len] * fade_in
            mixed[overlap_start:overlap_end] = blended
            # Place the rest of the new segment without blending
            if overlap_len < len(data):
                mixed[overlap_end:end_sample] += data[overlap_len:]
            placed_action = placed_action if placed_action != "passthrough" else (
                "emotion_crossfade" if is_emotion_transition else "crossfade"
            )
        else:
            mixed[start_sample:end_sample] += data

        prev_placed_end_sample = max(prev_placed_end_sample, end_sample)

        placed_seconds = len(data) / float(SR)
        placed_overflow_seconds = max(0.0, placed_seconds - (slot_end_sec - float(seg["start"])))
        seg["_pacing"].update({
            "placed_seconds": round(placed_seconds, 3),
            "placed_overflow_seconds": round(placed_overflow_seconds, 3),
            "placed_action": placed_action,
            "placed_dropped_samples": max(0, original_samples - len(data)),
        })

    # Clip-safe pre-write guard.  Previously we peak-normalised every
    # segment-mixed track to 0.9, which throws away dynamic range AND
    # fights the loudnorm pass that runs immediately after.  We now only
    # scale the buffer down when the summed segment audio would otherwise
    # clip when written as PCM_16 (sf.write default).  Quiet tracks pass
    # through untouched and arrive at loudnorm with their original SNR.
    peak = float(np.abs(mixed).max()) if mixed.size else 0.0
    if peak > 1.0:
        mixed = mixed * (0.98 / peak)

    dubbed_path = out_dir / "dubbed_voice.wav"
    sf.write(str(dubbed_path), mixed, SR)

    # Mix with background music when Demucs separated it.
    # loudnorm normalises both tracks to broadcast levels before mixing.
    if background_audio and background_audio.exists():
        log.info("[Assemble] Mixing dubbed voice with background (loudness-normalised)...")
        final_mix = out_dir / "dubbed_final_mix.wav"
        run_ffmpeg(
            "-i", str(dubbed_path),
            "-i", str(background_audio),
            "-filter_complex",
            (
                # Sidechain-compress the background so it ducks under the voice,
                # then sum (NOT average) the voice with the ducked background.
                #
                # Volume math:
                #   * Voice is loudnorm'd to I=-16 LUFS — the broadcast target.
                #   * Background is loudnorm'd to I=-24 LUFS, then ratio=4
                #     sidechain-ducked under the voice control signal.
                #   * amix `normalize=0` keeps the inputs at their original
                #     gain (default normalize=1 averages, halving each input
                #     and giving a perceived ~-22 LUFS final voice — the
                #     "quiet output" symptom).
                #   * `duration=longest` lets the background continue past
                #     the last spoken segment so the video tail isn't silent.
                #   * alimiter at 0.95 catches any sum overshoot without
                #     squashing the dynamic range.
                "[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aformat=channel_layouts=mono,asplit=2[voice_mix][voice_ctrl];"
                "[1:a]loudnorm=I=-24:TP=-2:LRA=18,aformat=channel_layouts=mono[bg];"
                "[bg][voice_ctrl]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=250[bd];"
                "[voice_mix][bd]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
                "alimiter=limit=0.95[out]"
            ),
            "-map", "[out]",
            "-ar", str(SR),
            str(final_mix),
        )
        return final_mix

    # No background separation (Demucs off or failed) — apply loudnorm to
    # the voice-only track so output levels are broadcast-standard regardless
    # of per-segment volume differences from CosyVoice.
    # Phase 4 (P1-21): previously this path returned the raw WAV which had
    # inconsistent per-segment loudness.
    log.info("[Assemble] Applying loudnorm to voice-only track...")
    normalised_path = out_dir / "dubbed_voice_normalised.wav"
    run_ffmpeg(
        "-i", str(dubbed_path),
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95",
        "-ar", str(SR),
        str(normalised_path),
    )
    return normalised_path


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 8: Generate SRT subtitle file
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fmt_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(segments: list[dict], out_path: Path, video_duration: Optional[float] = None):
    lines = []
    idx = 1
    skipped = 0
    out_of_bounds = 0
    clamped = 0
    for seg in segments:
        # Use only the translated text -- never fall back to source-language
        # text. For a dubbed video the SRT must match the dubbed audio; a
        # source-language subtitle on a translated audio track is confusing
        # and incorrect. If a segment has no translation, skip it.
        text = seg.get("translated_text", "").strip()
        if not text:
            skipped += 1
            continue
        start = float(seg.get("start", 0.0) or 0.0)
        end = float(seg.get("end", 0.0) or 0.0)
        if start < 0 or end <= start:
            skipped += 1
            continue
        if video_duration and video_duration > 0:
            if start >= video_duration + 0.25:
                out_of_bounds += 1
                continue
            if end > video_duration:
                if video_duration - start < 0.25:
                    out_of_bounds += 1
                    continue
                end = video_duration
                clamped += 1
        lines.append(str(idx))
        lines.append(f"{_fmt_timestamp(start)} --> {_fmt_timestamp(end)}")
        lines.append(text)
        lines.append("")
        idx += 1
    out_path.write_text("\n".join(lines), encoding="utf-8")
    if skipped:
        log.warning(f"[SRT] Skipped {skipped} segment(s) with no translated_text.")
    if out_of_bounds or clamped:
        log.warning(f"[SRT] Repaired bounds: skipped {out_of_bounds} out-of-range, clamped {clamped} to video duration.")
    log.info(f"[SRT] Written {idx - 1} subtitle entries -> {out_path}")


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 9: Final video mux (video + dubbed audio)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def mux_final_video(
    video_path: Path,
    audio_path: Path,
    out_path: Path,
    video_duration: Optional[float] = None,
):
    """Combine original video stream with new dubbed audio.
    video_duration: explicit -t trim prevents tail clipping when dubbed audio
    is slightly longer than the source video.
    """
    ffmpeg_args = [
        "-i", str(video_path),
        "-i", str(audio_path),
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-map", "0:v:0",
        "-map", "1:a:0",
    ]
    if video_duration is not None:
        # Explicit duration is safer than -shortest; prevents single-frame
        # tail clips when dubbed audio is fractionally longer than the video.
        ffmpeg_args.extend(["-t", str(round(video_duration, 3))])
    else:
        ffmpeg_args.append("-shortest")
    ffmpeg_args.append(str(out_path))
    run_ffmpeg(*ffmpeg_args)
    log.info(f"[Mux] Final video: {out_path}")


# ─────────────────────────────────────────────────────────────────────────────
# Dynamic Video Length — grow the timeline instead of speeding up the voice
# ─────────────────────────────────────────────────────────────────────────────
# Minimum silence kept between two consecutive lines on the rebuilt timeline.
DYNAMIC_MIN_GAP_SECONDS = 0.12
# Below this, a tail/freeze hold is treated as negligible and skipped (avoids
# a needless full video re-encode for sub-frame rounding).
DYNAMIC_HOLD_EPSILON_SECONDS = 0.05


def measure_audio_seconds(path: Path) -> float:
    """Duration of an audio file in seconds (soundfile, ffprobe fallback)."""
    try:
        import soundfile as sf
        info = sf.info(str(path))
        if info.samplerate and info.frames:
            return float(info.frames) / float(info.samplerate)
    except Exception as exc:
        log.debug("[Dynamic] soundfile.info failed for %s: %s", path, exc)
    try:
        result = run_ffprobe(
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        )
        return max(0.0, float(result.stdout.strip()))
    except Exception as exc:
        log.warning("[Dynamic] Could not measure duration for %s: %s", path, exc)
        return 0.0


def build_dynamic_timeline(
    segments: list[dict],
    natural_durations: list[float],
    video_duration: float,
    min_gap: float = DYNAMIC_MIN_GAP_SECONDS,
):
    """
    Re-time the dub so every line plays at its natural (un-sped) length.

    Walks segments in order, keeping each line's original start when there is
    room; when a line's natural audio would run into the next line, the
    following content is pushed later and that pushed time is recorded as a
    frozen-frame hold to insert into the video at that point.  This keeps the
    voice at a natural rate and the picture in sync.

    Returns (placements, freezes, new_total, extra_seconds, tail_hold):
      placements    list[float]            new start time per segment
      freezes       list[(orig_sec, hold)] frame-holds to insert in the source
      new_total     float                  final timeline / output duration
      extra_seconds float                  total mid-timeline time inserted
      tail_hold     float                  extra frozen seconds appended at end
    """
    placements: list[float] = []
    freezes: list[tuple[float, float]] = []
    extra = 0.0
    cursor = 0.0
    valid_vd = (
        float(video_duration)
        if isinstance(video_duration, (int, float)) and math.isfinite(video_duration) and video_duration > 0
        else 0.0
    )

    for i, seg in enumerate(segments):
        orig_start = max(0.0, float(seg.get("start", 0.0)))
        nat = max(0.0, float(natural_durations[i])) if i < len(natural_durations) else 0.0
        new_start = orig_start + extra
        if new_start < cursor:
            push = cursor - new_start
            freezes.append((orig_start, push))
            extra += push
            new_start = cursor
        placements.append(new_start)
        cursor = new_start + nat + max(0.0, min_gap)

    base = valid_vd + extra            # length of source after mid-freezes
    new_total = max(base, cursor)
    tail_hold = max(0.0, new_total - base)
    return placements, freezes, new_total, extra, tail_hold


# ── Smooth time-warp (no freezing): the picture keeps moving ─────────────────
# Instead of freezing a frame to make room for a longer dubbed line, we gently
# slow the *video* for that line so it keeps playing, and warp the background
# audio by the exact same factor so it stays locked to the picture.  The cap
# keeps the slow-down subtle so the flow isn't broken; only genuinely dense
# lines (dub far longer than the source span even at max slow-down) fall back
# to a small voice speed-up.
DYNAMIC_MAX_VIDEO_STRETCH = max(
    1.05, min(2.0, float(os.environ.get("DYNAMIC_MAX_VIDEO_STRETCH", "1.25")))
)
DYNAMIC_MIN_CHUNK_SECONDS = 0.05

# ── Smooth speed "curve" (eased slow-down, not a hard step) ──────────────────
# A constant per-line slow-down factor makes the speed jump abruptly at line
# boundaries (normal → slow → normal): the eye catches the "snap".  When
# smoothing is on we keep the SAME amount of slow-down for a line but spread it
# over a gentle curve: the video eases from normal speed into the slow-down and
# back out, so the change is felt but never seen as a sudden jump.  We realise
# the curve by subdividing a stretched line's source span into several small
# slices whose factors follow a flat-top profile with smoothstep shoulders
# (≈1.0× at the edges, peaking in the middle).  The peak is capped at
# max_stretch so the slow-down never gets stronger than the configured limit.
DYNAMIC_SMOOTH_TIMEWARP = os.environ.get("DYNAMIC_SMOOTH_TIMEWARP", "true").lower() == "true"
# Target length of each micro-slice (seconds).  Smaller = smoother but more
# ffmpeg filter nodes.
DYNAMIC_TIMEWARP_SLICE_SECONDS = max(
    0.08, min(1.0, float(os.environ.get("DYNAMIC_TIMEWARP_SLICE_SECONDS", "0.25")))
)
DYNAMIC_TIMEWARP_MIN_SLICES = 4
DYNAMIC_TIMEWARP_MAX_SLICES = 12
# Fraction of each stretched span used to ease in / ease out (each side).
DYNAMIC_TIMEWARP_SHOULDER = max(
    0.05, min(0.5, float(os.environ.get("DYNAMIC_TIMEWARP_SHOULDER", "0.30")))
)
# Upper bound on the total number of video slices across the whole timeline, so
# a very long / very dense video can't explode the ffmpeg filter graph.  When
# exceeded, slices-per-line are reduced (the curve gets coarser but stays
# smooth-ish and still never freezes).
DYNAMIC_TIMEWARP_SLICE_BUDGET = max(
    64, int(os.environ.get("DYNAMIC_TIMEWARP_SLICE_BUDGET", "800"))
)


def _ease_weight(x: float, shoulder: float) -> float:
    """
    Flat-top easing weight in [0, 1] over normalised position x∈[0, 1].

    0.0 at the edges (x=0, x=1), rising via a smoothstep over `shoulder` on
    each side to a 1.0 plateau in the middle.  Its zero slope at the edges is
    what makes neighbouring lines join without a visible speed jump.
    """
    if shoulder <= 0.0:
        return 1.0
    if x <= shoulder:
        t = x / shoulder
    elif x >= 1.0 - shoulder:
        t = (1.0 - x) / shoulder
    else:
        return 1.0
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)  # smoothstep


def _eased_subchunks(
    src_start: float,
    src_end: float,
    target_avg: float,
    max_stretch: float,
    seg_index: int,
    max_slices: int,
    shoulder: float = DYNAMIC_TIMEWARP_SHOULDER,
    slice_seconds: float = DYNAMIC_TIMEWARP_SLICE_SECONDS,
):
    """
    Subdivide one stretched line's source span [src_start, src_end] into slices
    whose per-slice factors follow an eased (flat-top smoothstep) curve.

    The slices are chosen so their output durations sum EXACTLY to
    `src_span * achieved_avg`, where `achieved_avg <= target_avg` is whatever
    the eased profile can deliver without the peak factor exceeding
    `max_stretch`.  Returns (subchunks, out_total, achieved_avg).
    """
    span = max(DYNAMIC_MIN_CHUNK_SECONDS, src_end - src_start)
    max_slices = max(2, int(max_slices))
    n = int(round(span / slice_seconds)) if slice_seconds > 0 else max_slices
    n = max(DYNAMIC_TIMEWARP_MIN_SLICES, min(max_slices, n))
    if n < 2:
        n = 2

    xs = [(j + 0.5) / n for j in range(n)]
    ws = [_ease_weight(x, shoulder) for x in xs]
    mean_w = sum(ws) / n

    # The eased profile can lift the average to at most this, given the peak
    # factor is capped at max_stretch.
    cap_avg = 1.0 + (max_stretch - 1.0) * mean_w if mean_w > 1e-9 else max_stretch
    avg = max(1.0, min(float(target_avg), cap_avg))

    # No meaningful stretch (or degenerate weights) → single passthrough chunk.
    if mean_w <= 1e-9 or avg <= 1.0 + 1e-9:
        return (
            [{
                "src_start": src_start, "src_end": src_end,
                "out_dur": span, "factor": 1.0, "seg_index": seg_index,
            }],
            span,
            1.0,
        )

    peak_minus_1 = (avg - 1.0) / mean_w  # ≤ max_stretch - 1 by construction
    width = span / n
    sub: list[dict] = []
    out_total = 0.0
    for j in range(n):
        a = src_start + j * width
        b = src_end if j == n - 1 else src_start + (j + 1) * width
        f = 1.0 + peak_minus_1 * ws[j]
        od = (b - a) * f
        sub.append({
            "src_start": a, "src_end": b,
            "out_dur": od, "factor": f, "seg_index": seg_index,
        })
        out_total += od
    return sub, out_total, avg


def _apply_atempo(in_path: Path, speed: float, out_dir: Path, label: str) -> Path:
    """Change an audio clip's tempo (pitch-preserving) by `speed`×."""
    speed = max(0.5, min(2.0, float(speed)))
    if abs(speed - 1.0) < 1e-3:
        return in_path
    out = out_dir / f"{label}.wav"
    run_ffmpeg("-i", str(in_path), "-filter:a", f"atempo={speed:.5f}", str(out))
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(f"atempo produced no output for {in_path}")
    return out


def build_timewarp_plan(
    segments: list[dict],
    natural_durations: list[float],
    video_duration: float,
    max_stretch: float = DYNAMIC_MAX_VIDEO_STRETCH,
    smooth: bool = False,
):
    """
    Plan a continuous, never-freezing output timeline.

    The source video is split at segment starts into contiguous chunks that
    together cover [0, video_duration].  Each chunk that owns a spoken line is
    stretched (slowed) just enough for that line's natural dub to fit, capped
    at `max_stretch` so the slow-down stays subtle.  Chunks whose dub already
    fits keep factor 1.0 — the picture plays exactly as-is there.

    When `smooth` is True, each stretched line is emitted as several micro
    slices whose factors follow an eased curve (≈1.0× at the edges, peaking in
    the middle) instead of one constant factor.  This removes the abrupt
    speed "snap" at line boundaries while keeping each line's output slot —
    and therefore the dubbed-audio sync — exactly the same.  Because the eased
    profile caps the PEAK factor at `max_stretch`, a stretched line's *average*
    slow-down is a little gentler than the hard-step mode, so a few very dense
    lines lean slightly more on the small voice speed-up; the picture never
    freezes and never jumps.

    Returns (chunks, seg_plan, total):
      chunks   list[{src_start, src_end, out_dur, factor, seg_index}]
               factor = out_dur / source_dur  (>= 1.0; 1.0 == untouched).
               In smooth mode a single line maps to several consecutive chunks.
      seg_plan list[{out_start, out_dur, dub_speed, placed_dur}] per segment
               dub_speed > 1.0 only for the rare clamped (very dense) line.
      total    float  final output duration
    """
    n = len(segments)
    vd = (
        float(video_duration)
        if isinstance(video_duration, (int, float)) and math.isfinite(video_duration) and video_duration > 0
        else None
    )
    starts = [max(0.0, float(s.get("start", 0.0))) for s in segments]
    nats = [
        max(0.0, float(natural_durations[i])) if i < len(natural_durations) else 0.0
        for i in range(n)
    ]
    if vd is None:
        vd = (starts[-1] + nats[-1] + 1.0) if n else 1.0

    # Per-line source spans (used both for planning and the slice budget).
    spans: list[float] = []
    for i in range(n):
        s = starts[i]
        e = starts[i + 1] if i + 1 < n else vd
        if e <= s:
            e = s + DYNAMIC_MIN_CHUNK_SECONDS
        spans.append(max(DYNAMIC_MIN_CHUNK_SECONDS, e - s))

    # Distribute the global slice budget across the lines that actually need
    # stretching, so a long/dense video can't explode the ffmpeg filter graph.
    per_line_max_slices = DYNAMIC_TIMEWARP_MAX_SLICES
    if smooth:
        stretched = sum(1 for i in range(n) if nats[i] > spans[i] + 1e-3)
        if stretched > 0:
            budget_each = DYNAMIC_TIMEWARP_SLICE_BUDGET // stretched
            per_line_max_slices = max(
                2, min(DYNAMIC_TIMEWARP_MAX_SLICES, budget_each)
            )

    chunks: list[dict] = []
    seg_plan: list[dict] = []
    out_cursor = 0.0

    # Lead chunk before the first line (intro / no dub) — plays untouched.
    if n and starts[0] > DYNAMIC_MIN_CHUNK_SECONDS:
        chunks.append({
            "src_start": 0.0, "src_end": starts[0],
            "out_dur": starts[0], "factor": 1.0, "seg_index": None,
        })
        out_cursor += starts[0]

    for i in range(n):
        s = starts[i]
        e = starts[i + 1] if i + 1 < n else vd
        if e <= s:
            e = s + DYNAMIC_MIN_CHUNK_SECONDS
        src = spans[i]
        nd = nats[i]

        # Preserved devotional segments keep their ORIGINAL audio and must never
        # be time-warped — the picture plays at natural speed (factor 1.0) and
        # the original slice is placed unchanged.
        if i < len(segments) and segments[i].get("preserve_original"):
            chunks.append({
                "src_start": s, "src_end": e,
                "out_dur": src, "factor": 1.0, "seg_index": i,
            })
            seg_plan.append({
                "out_start": out_cursor, "out_dur": src,
                "dub_speed": 1.0, "placed_dur": src,
            })
            out_cursor += src
            continue

        if smooth and nd > src + 1e-3:
            # Eased slow-down across several slices.  target_avg is how much we
            # *want* to stretch (to fit the natural dub); _eased_subchunks
            # returns what it could deliver with the peak capped at max_stretch.
            target_avg = nd / src
            subs, out_dur, _achieved = _eased_subchunks(
                s, e, target_avg, max_stretch, i, per_line_max_slices,
            )
            chunks.extend(subs)
        else:
            # Hard-step mode, or a line whose dub already fits (factor 1.0).
            out_dur = min(max(nd, src), src * max_stretch)
            factor = out_dur / src
            chunks.append({
                "src_start": s, "src_end": e,
                "out_dur": out_dur, "factor": factor, "seg_index": i,
            })

        if nd > out_dur + 1e-3:
            dub_speed = nd / out_dur          # rare: very dense line
            placed = out_dur
        else:
            dub_speed = 1.0                    # voice stays natural
            placed = nd
        seg_plan.append({
            "out_start": out_cursor, "out_dur": out_dur,
            "dub_speed": dub_speed, "placed_dur": placed,
        })
        out_cursor += out_dur

    return chunks, seg_plan, out_cursor


def build_timewarped_video(video_path: Path, chunks: list[dict], total: float, out_dir: Path) -> Path:
    """
    Re-time the video per the plan via per-chunk setpts (no frame freezing).
    Chunks with factor 1.0 pass through untouched; chunks that own a longer
    dubbed line are slowed smoothly.  Returns the original video when nothing
    needs warping.
    """
    if not chunks or all(abs(c["factor"] - 1.0) < 1e-3 for c in chunks):
        return video_path

    filters: list[str] = []
    labels: list[str] = []
    last = len(chunks) - 1
    for k, c in enumerate(chunks):
        a = float(c["src_start"]); b = float(c["src_end"]); f = float(c["factor"])
        trim = f"trim=start={a:.3f}" if k == last else f"trim=start={a:.3f}:end={b:.3f}"
        if abs(f - 1.0) < 1e-3:
            filters.append(f"[0:v]{trim},setpts=PTS-STARTPTS[v{k}]")
        else:
            filters.append(f"[0:v]{trim},setpts={f:.5f}*(PTS-STARTPTS)[v{k}]")
        labels.append(f"[v{k}]")
    concat = f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[outv]"
    filter_complex = ";".join(filters + [concat])

    out_path = out_dir / "video_timewarped.mp4"
    run_ffmpeg(
        "-i", str(video_path),
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        str(out_path),
    )
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Time-warped video build produced no output.")
    warped = sum(1 for c in chunks if abs(c["factor"] - 1.0) >= 1e-3)
    log.info("[Dynamic] Time-warped video: %d/%d chunk(s) slowed, total=%.2fs", warped, len(chunks), total)
    return out_path


def timewarp_background(
    background_audio: Path,
    chunks: list[dict],
    total: float,
    out_dir: Path,
    sample_rate: int = 44100,
) -> Path:
    """
    Warp the Demucs background track by the SAME per-chunk factor as the video
    (atempo = 1/factor) so music/ambience stays locked to the picture.  Guard
    with try/except; fall back to the original track on failure.
    """
    if not chunks or all(abs(c["factor"] - 1.0) < 1e-3 for c in chunks):
        return background_audio

    sr = int(sample_rate)
    parts: list[str] = []
    labels: list[str] = []
    last = len(chunks) - 1
    for k, c in enumerate(chunks):
        a = float(c["src_start"]); b = float(c["src_end"]); f = float(c["factor"])
        atrim = f"atrim=start={a:.3f}" if k == last else f"atrim=start={a:.3f}:end={b:.3f}"
        base = f"[0:a]aresample={sr},aformat=channel_layouts=mono,{atrim},asetpts=PTS-STARTPTS"
        tempo = (1.0 / f) if f > 1e-6 else 1.0
        if abs(tempo - 1.0) > 1e-3:
            base += f",atempo={tempo:.5f}"
        base += f"[b{k}]"
        parts.append(base)
        labels.append(f"[b{k}]")
    concat = f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[outa]"
    filter_complex = ";".join(parts + [concat])

    out_path = out_dir / "background_timewarped.wav"
    run_ffmpeg(
        "-i", str(background_audio),
        "-filter_complex", filter_complex,
        "-map", "[outa]", "-ar", str(sr),
        str(out_path),
    )
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Background time-warp produced no output.")
    log.info("[Dynamic] Background track time-warped to match the picture.")
    return out_path


def build_extended_video(
    video_path: Path,
    freezes: list[tuple[float, float]],
    tail_hold: float,
    total_duration: float,
    out_dir: Path,
) -> Path:
    """
    Produce a video that matches the dynamic (grown) timeline by inserting
    frozen-frame holds at the given source timestamps and (optionally) holding
    the final frame for `tail_hold` seconds.

    The held frame is the last frame before each cut, cloned via ffmpeg
    `tpad=stop_mode=clone`, so a pause shows a still picture (natural during
    the gap between sentences and lip-sync-safe).  Returns the original video
    untouched when there is nothing meaningful to insert.
    """
    # Coalesce holds that land on the same timestamp; drop negligible ones.
    hold_by_time: dict[float, float] = {}
    for t, d in freezes:
        if d <= 0:
            continue
        key = round(max(0.0, float(t)), 3)
        hold_by_time[key] = hold_by_time.get(key, 0.0) + float(d)
    cut_times = sorted(k for k, v in hold_by_time.items() if v > 0)
    tail_hold = max(0.0, float(tail_hold))

    if not cut_times and tail_hold <= DYNAMIC_HOLD_EPSILON_SECONDS:
        # Nothing to insert — source already matches the timeline.
        return video_path

    filters: list[str] = []
    labels: list[str] = []
    prev = 0.0
    idx = 0
    for t in cut_times:
        if t <= prev + 1e-3:
            # Degenerate/coincident cut (shouldn't occur given strictly
            # increasing starts).  Preserve total duration by deferring this
            # hold to the tail rather than emitting an empty trim.
            tail_hold += hold_by_time[t]
            continue
        hold = hold_by_time[t]
        filters.append(
            f"[0:v]trim=start={prev:.3f}:end={t:.3f},setpts=PTS-STARTPTS,"
            f"tpad=stop_mode=clone:stop_duration={hold:.3f}[v{idx}]"
        )
        labels.append(f"[v{idx}]")
        prev = t
        idx += 1

    # Final chunk: from the last cut to the end of the source, plus tail hold.
    final_chunk = f"[0:v]trim=start={prev:.3f},setpts=PTS-STARTPTS"
    if tail_hold > DYNAMIC_HOLD_EPSILON_SECONDS:
        final_chunk += f",tpad=stop_mode=clone:stop_duration={tail_hold:.3f}"
    final_chunk += f"[v{idx}]"
    filters.append(final_chunk)
    labels.append(f"[v{idx}]")

    concat = f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[outv]"
    filter_complex = ";".join(filters + [concat])

    out_path = out_dir / "video_extended.mp4"
    run_ffmpeg(
        "-i", str(video_path),
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        str(out_path),
    )
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Extended-video build produced no output.")
    log.info(
        "[Dynamic] Extended video built: %d freeze insert(s), tail=%.2fs, total=%.2fs",
        len(cut_times), tail_hold, total_duration,
    )
    return out_path


def align_background_to_timeline(
    background_audio: Path,
    freezes: list[tuple[float, float]],
    tail_hold: float,
    out_dir: Path,
    sample_rate: int = 44100,
) -> Path:
    """
    Insert silence into the Demucs background track at the same points the
    video is frozen, so background music/ambience stays aligned with the
    (grown) picture under Dynamic Video Length.  Mirrors build_extended_video
    but for audio.  Returns the original track unchanged when there is nothing
    to insert.  Caller should guard with try/except and fall back to the
    original background on failure.
    """
    hold_by_time: dict[float, float] = {}
    for t, d in freezes:
        if d <= 0:
            continue
        key = round(max(0.0, float(t)), 3)
        hold_by_time[key] = hold_by_time.get(key, 0.0) + float(d)
    cut_times = sorted(k for k, v in hold_by_time.items() if v > 0)
    tail_hold = max(0.0, float(tail_hold))

    if not cut_times and tail_hold <= DYNAMIC_HOLD_EPSILON_SECONDS:
        return background_audio

    parts: list[str] = []
    labels: list[str] = []
    prev = 0.0
    idx = 0
    sr = int(sample_rate)
    for t in cut_times:
        if t <= prev + 1e-3:
            tail_hold += hold_by_time[t]
            continue
        hold = hold_by_time[t]
        # Chunk of real background [prev, t], then `hold` seconds of silence.
        parts.append(
            f"[0:a]aresample={sr},aformat=channel_layouts=mono,"
            f"atrim=start={prev:.3f}:end={t:.3f},asetpts=PTS-STARTPTS[b{idx}]"
        )
        labels.append(f"[b{idx}]")
        parts.append(
            f"anullsrc=r={sr}:cl=mono,atrim=duration={hold:.3f},asetpts=PTS-STARTPTS[s{idx}]"
        )
        labels.append(f"[s{idx}]")
        prev = t
        idx += 1

    parts.append(
        f"[0:a]aresample={sr},aformat=channel_layouts=mono,"
        f"atrim=start={prev:.3f},asetpts=PTS-STARTPTS[b{idx}]"
    )
    labels.append(f"[b{idx}]")
    if tail_hold > DYNAMIC_HOLD_EPSILON_SECONDS:
        parts.append(
            f"anullsrc=r={sr}:cl=mono,atrim=duration={tail_hold:.3f},asetpts=PTS-STARTPTS[s{idx}]"
        )
        labels.append(f"[s{idx}]")

    concat = f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[outa]"
    filter_complex = ";".join(parts + [concat])

    out_path = out_dir / "background_aligned.wav"
    run_ffmpeg(
        "-i", str(background_audio),
        "-filter_complex", filter_complex,
        "-map", "[outa]",
        "-ar", str(sr),
        str(out_path),
    )
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Background alignment produced no output.")
    log.info("[Dynamic] Background track aligned to grown timeline.")
    return out_path


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 10: Generate transcript JSON
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _round_or_none(value, digits: int = 3):
    """JSON-safe rounding helper that preserves None/NaN."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return round(f, digits)


def summarize_pacing(segments: list[dict]) -> dict:
    """
    Aggregate per-segment _pacing telemetry into job-level stats.

    This is what we watch in CloudWatch / the translation report to detect
    pacing regressions:
      * mean / max / p95 of applied_speed and applied_atempo
      * count of segments with QA retry, boundary cuts, atempo clamped
      * histogram of fit_action / placed_action

    All keys are JSON-serializable.
    """
    speeds: list[float] = []
    atempos: list[float] = []
    overflows: list[float] = []
    target_speech: list[float] = []
    actuals: list[float] = []
    qa_retries = {"no": 0, "improved": 0, "rejected": 0, "errored": 0}
    fit_actions: dict[str, int] = {}
    placed_actions: dict[str, int] = {}

    for seg in segments:
        pacing = seg.get("_pacing") or {}
        if not isinstance(pacing, dict):
            continue
        speed = pacing.get("applied_speed")
        if isinstance(speed, (int, float)) and math.isfinite(speed):
            speeds.append(float(speed))
        atempo = pacing.get("applied_atempo")
        if isinstance(atempo, (int, float)) and math.isfinite(atempo):
            atempos.append(float(atempo))
        overflow = pacing.get("overflow_into_gap")
        if isinstance(overflow, (int, float)) and math.isfinite(overflow):
            overflows.append(float(overflow))
        ts = pacing.get("target_speech_seconds")
        if isinstance(ts, (int, float)) and math.isfinite(ts):
            target_speech.append(float(ts))
        actual = pacing.get("actual_seconds")
        if isinstance(actual, (int, float)) and math.isfinite(actual):
            actuals.append(float(actual))
        qa_key = str(pacing.get("qa_retry") or "no")
        qa_retries[qa_key] = qa_retries.get(qa_key, 0) + 1
        fit_key = str(pacing.get("fit_action") or "unknown")
        fit_actions[fit_key] = fit_actions.get(fit_key, 0) + 1
        placed_key = str(pacing.get("placed_action") or "unknown")
        placed_actions[placed_key] = placed_actions.get(placed_key, 0) + 1

    def _stats(values: list[float]) -> dict:
        if not values:
            return {"count": 0}
        sv = sorted(values)
        n = len(sv)
        # p95 via linear interpolation; fine for our small N.
        idx = max(0, min(n - 1, int(round(0.95 * (n - 1)))))
        return {
            "count": n,
            "mean": _round_or_none(sum(sv) / n),
            "min": _round_or_none(sv[0]),
            "max": _round_or_none(sv[-1]),
            "p95": _round_or_none(sv[idx]),
        }

    return {
        "appliedSpeed": _stats(speeds),
        "appliedAtempo": _stats(atempos),
        "overflowIntoGap": _stats(overflows),
        "targetSpeechSeconds": _stats(target_speech),
        "actualSeconds": _stats(actuals),
        "qaRetries": qa_retries,
        "fitActions": fit_actions,
        "placedActions": placed_actions,
    }


def generate_transcript_json(segments: list[dict], out_path: Path):
    transcript = {
        "jobId": JOB_ID,
        "targetLang": TARGET_LANG,
        "targetLangCode": TARGET_LANG_CODE,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "segments": [
            {
                "id": s["id"],
                "start": s["start"],
                "end": s["end"],
                "originalText": s.get("text", ""),
                "translatedText": s.get("translated_text", ""),
                "emotion": s.get("emotion", "neutral"),
                "speakingRate": s.get("speaking_rate", 1.0),
                "speaker": s.get("speaker") or DEFAULT_SPEAKER_LABEL,
                # Phase 1 telemetry: every segment carries the full pacing
                # decision trail (target/predicted/applied speed, atempo,
                # final length, overflow, QA retry verdict, placement action).
                # Frontends + post-job analysis tooling read from here.
                "pacing": s.get("_pacing") or {},
            }
            for s in segments
        ],
        "pacingSummary": summarize_pacing(segments),
    }
    out_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info(f"[Transcript] Written â†’ {out_path}")


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Main entrypoint
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main():
    # ── Immediate DDB heartbeat ───────────────────────────────────────────────
    # This is the FIRST thing main() does — before any imports, before work_dir,
    # before the try block.  If Python actually started, the frontend will
    # immediately update from "GPU instance starting..." to "Worker initialised."
    # If this never fires, it proves the NVIDIA entrypoint exited before Python.
    update_progress("STARTING", 1, "Worker process initialised. Python running...")

    log.info(f"=== Translator Worker starting. JobId={JOB_ID} ===")
    log.info(f"Target: {TARGET_LANG} ({TARGET_LANG_CODE}), LipSync={LIP_SYNC}, VoiceClone={VOICE_CLONE}")
    log.info(
        "[Config] useDemucs=%s multiSpeaker=%s model=%s runtimeDownloads=%s fp16=%s vllm=%s",
        USE_DEMUCS,
        MULTI_SPEAKER,
        COSYVOICE_MODEL_ID,
        ALLOW_RUNTIME_MODEL_DOWNLOADS,
        COSYVOICE_FP16,
        COSYVOICE_VLLM,
    )

    work_dir = Path(tempfile.mkdtemp(prefix=f"translator_{JOB_ID}_"))
    log.info(f"Working directory: {work_dir}")

    try:
        # â”€â”€ 1. Download video from S3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("STARTING", 3, "Downloading video from cloud...")
        input_ext = Path(S3_INPUT_KEY).suffix or ".mp4"
        video_path = work_dir / f"input{input_ext}"
        download_from_s3(S3_INPUT_KEY, video_path)

        video_duration = get_video_duration(video_path)
        log.info(f"Video duration: {video_duration:.1f}s")

        # â”€â”€ 2. Extract audio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("EXTRACTING", 8, "Extracting high-quality audio...")
        full_audio_hq = extract_audio(video_path, work_dir, sample_rate=44100, mono=True, label="audio_full")
        transcription_audio = resample_audio(full_audio_hq, work_dir / "audio_full_16k.wav", 16000, mono=True)
        reference_audio = full_audio_hq

        # â”€â”€ 3. Optional Demucs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        background_audio = None

        demucs_applied = False
        demucs_warning = ""

        # Phase 4 (P1-24): Demucs (GPU, ~30s) and AssemblyAI (HTTP, ~20-40s)
        # are independent when transcription runs on the original audio.
        # We launch Demucs in a background thread and run AssemblyAI
        # concurrently.  This saves ~30s per job on average.
        #
        # Demucs output is used ONLY for:
        #   - Background track (final mix)
        # Transcription runs on the original 16k audio (not Demucs vocals).
        # This is a deliberate tradeoff: ASR quality on original audio is
        # slightly lower when there's loud background music, but the ~30s
        # wall-time savings is worth it for the 95% of videos where music
        # is ambient/low-level.  Heavy-music videos should use the
        # DEMUCS_BEFORE_ASR=true flag to force sequential mode.
        _demucs_before_asr = os.environ.get("DEMUCS_BEFORE_ASR", "false").lower() in ("1", "true", "yes")

        if USE_DEMUCS and not _demucs_before_asr:
            # ── Parallel path: Demucs + ASR run concurrently ──────────────
            from concurrent.futures import ThreadPoolExecutor as _TPE_demucs
            from concurrent.futures import Future as _Future_demucs

            update_progress("EXTRACTING", 12, "Separating voice & transcribing (parallel)...")

            def _run_demucs_task():
                return run_demucs(full_audio_hq, work_dir)

            with _TPE_demucs(max_workers=1, thread_name_prefix="demucs") as demucs_pool:
                demucs_future: _Future_demucs = demucs_pool.submit(_run_demucs_task)

                # Run transcription on original audio while Demucs processes
                update_progress("TRANSCRIBING", 18, "Transcribing speech (AssemblyAI)...")
                segments = transcribe(transcription_audio)

                # Collect Demucs result
                try:
                    _vocals_path, bg_path = demucs_future.result(timeout=600)
                    background_audio = bg_path
                    demucs_applied = True
                    log.info("[Demucs+ASR] Parallel execution complete. Demucs OK.")
                except Exception as e:
                    demucs_warning = str(e)
                    log.warning(f"[Demucs+ASR] Demucs failed (ASR still succeeded): {e}")

        elif USE_DEMUCS and _demucs_before_asr:
            # ── Sequential path: Demucs first, then ASR on vocals ─────────
            # Use DEMUCS_BEFORE_ASR=true when the video has heavy background
            # music and ASR on original audio would miss words.
            update_progress("EXTRACTING", 12, "Separating voice from background music...")
            try:
                vocals_path, bg_path = run_demucs(full_audio_hq, work_dir)
                transcription_audio = resample_audio(vocals_path, work_dir / "vocals_16k.wav", 16000, mono=True)
                background_audio = bg_path
                demucs_applied = True
            except Exception as e:
                demucs_warning = str(e)
                log.warning(f"[Demucs] Skipped: {e}")

            update_progress("TRANSCRIBING", 18, "Transcribing speech (AssemblyAI)...")
            segments = transcribe(transcription_audio)

        else:
            # ── No Demucs ─────────────────────────────────────────────────
            update_progress("TRANSCRIBING", 18, "Transcribing speech (AssemblyAI)...")
            segments = transcribe(transcription_audio)


        if not segments:
            raise RuntimeError("No speech detected in the video.")

        # â”€â”€ 5. Optional Diarization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if MULTI_SPEAKER:
            pre_labels = _effective_speaker_labels(segments)
            label_counts: dict[str, int] = {}
            for seg in segments:
                label = str(seg.get("speaker") or DEFAULT_SPEAKER_LABEL)
                label_counts[label] = label_counts.get(label, 0) + 1
            total_labels = sum(label_counts.values()) or 1
            dominant_share = max(label_counts.values(), default=0) / total_labels
            override_labels = len(pre_labels) <= 1 or dominant_share > 0.9
            if not pre_labels and not os.environ.get("HF_TOKEN", ""):
                warn_msg = (
                    "Multi-speaker requested but no reliable speaker labels were detected and HF_TOKEN is missing. "
                    "Speaker cloning will default to a single voice unless labels are provided."
                )
                log.warning(f"[Diarize] {warn_msg}")
                update_progress("TRANSCRIBING", 28, "Identifying speakers...", {"speaker_warning": warn_msg})
            else:
                update_progress("TRANSCRIBING", 28, "Identifying speakers...")
            segments = diarize(transcription_audio, segments, override_existing=override_labels)
            post_labels = _effective_speaker_labels(segments)
            if len(post_labels) <= 1:
                all_labels = _all_speaker_labels(segments)
                warn_msg = (
                    "Multi-speaker requested but diarization produced only one speaker label. "
                    "Voice cloning will use a single reference unless additional labels are provided."
                )
                log.warning(
                    "[Diarize] Speaker labels collapsed to a single voice (%s). %s",
                    all_labels[0] if all_labels else "none",
                    warn_msg,
                )
                update_progress("TRANSCRIBING", 28, "Identifying speakers...", {"speaker_warning": warn_msg})
            else:
                segments = collapse_speaker_label_noise(segments)

        # ── 5b. Merge micro-segments for TTS quality ─────────────────
        # Must run AFTER diarization so speaker labels are available.
        # Prevents choppy voice from sub-second segments.
        segments = merge_segments_for_dubbing(segments)

        log.info(f"Transcription: {len(segments)} segments (after merge)")

        # ── 5c. Annotate pause-aware dub windows ──────────────────────
        # Establishes one shared per-segment duration target (own slot + a
        # bounded slice of the following pause).  Every downstream stage —
        # Gemini's character budget, the CosyVoice speed= solver, the QA gate
        # and the timing-fit pass — sizes the dub to this window so a longer
        # translation is spoken at a natural rate instead of being sped up.
        segments = annotate_dub_windows(segments, video_duration)

        # -- 5b. Detect devotional content to keep in the original audio -------
        # Bhajans/kirtan, chanting of divine names, and Sanskrit/Odia shlokas
        # are flagged here so translation + synthesis skip them and the original
        # audio is used instead.
        preserved_count = 0
        if PRESERVE_CHANTS:
            update_progress("TRANSLATING", 33, "Detecting bhajans/shlokas to keep original...")
            try:
                preserved_count = classify_chant_segments(segments)
            except Exception as ch_err:
                log.warning("[Chants] preserve step failed (%s); continuing normally.", ch_err)
                preserved_count = 0

        # â”€â”€ 6. Translation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("TRANSLATING", 35, f"Translating to {TARGET_LANG}...")
        segments = translate_segments(segments)
        update_progress("TRANSLATING", 48, "Translation complete. Generating voice...")

        # -- 7. Extract per-speaker voice references (when voice cloning + multiple speakers) -
        speaker_refs: dict = {}
        speaker_prompt_texts: dict = {}
        if VOICE_CLONE:
            unique_speakers = {seg.get("speaker") or DEFAULT_SPEAKER_LABEL for seg in segments}
            if len(unique_speakers) > 1:
                update_progress("CLONING", 50, "Extracting per-speaker voice references...")
                try:
                    speaker_refs, speaker_prompt_texts = extract_speaker_reference(
                        reference_audio, segments, work_dir
                    )
                    log.info(
                        f"[Main] Per-speaker refs: "
                        f"{list(speaker_refs.keys())}"
                    )
                except Exception as sr_err:
                    log.warning(
                        f"[Main] Speaker reference extraction failed: {sr_err}. "
                        "Using single shared reference for all speakers."
                    )

        # -- 7b. Voice synthesis -----------------------------------------------
        voice_message = "Cloning original voice..." if VOICE_CLONE else "Generating neural voice..."
        update_progress("CLONING", 52, voice_message)
        seg_dir = work_dir / "segments"
        seg_dir.mkdir()
        seg_audio_paths, voice_was_cloned = synthesize_all(
            segments,
            reference_audio,
            seg_dir,
            speaker_refs=speaker_refs,
            speaker_prompt_texts=speaker_prompt_texts,
        )

        if VOICE_CLONE and not voice_was_cloned:
            log.warning("[Main] Voice clone requested but CosyVoice fell back to edge-tts.")
        elif voice_was_cloned:
            log.info("[Main] Voice cloning successful -- CosyVoice used.")

        # -- 7b-2. Substitute ORIGINAL audio for preserved devotional segments -
        # Bhajans / shlokas keep the original audio (full mix, incl. music)
        # instead of a synthesized dub. We cut the slice from the original audio
        # here so all downstream timing (dynamic time-warp measurement, fixed
        # fit, assembly) treats it as a natural-rate, fixed-length segment.
        if PRESERVE_CHANTS and preserved_count:
            for i, seg in enumerate(segments):
                if not seg.get("preserve_original"):
                    continue
                try:
                    slice_path = extract_original_slice(
                        full_audio_hq, float(seg["start"]), float(seg["end"]),
                        seg_dir / f"orig_{i}.wav",
                    )
                    seg_audio_paths[i] = slice_path
                    seg.setdefault("_pacing", {})["synth_method"] = "preserved_original"
                except Exception as ex:
                    log.warning(
                        "[Chants] Could not extract original slice for seg %d (%s); "
                        "it will be dubbed instead.", i, ex,
                    )
                    seg["preserve_original"] = False

        # -- 7c. Timing fit (or dynamic-length timeline) -----------------------
        # Defaults: dub fitted into the original fixed-length timeline.
        dynamic_applied = False
        dynamic_extra_seconds = 0.0
        mux_video = video_path
        mux_duration = video_duration

        if DYNAMIC_VIDEO_LENGTH:
            # Voice was synthesized at natural rate (speed solver locked above).
            # Keep the picture MOVING: gently slow the video for each line that
            # needs more room (capped, so flow isn't broken) and warp the
            # background audio by the same factor.  No frame freezing.
            update_progress("CLONING", 60, "Time-stretching video to match natural voice...")
            natural_durations = [measure_audio_seconds(p) for p in seg_audio_paths]
            chunks, seg_plan, new_total = build_timewarp_plan(
                segments, natural_durations, video_duration,
                smooth=DYNAMIC_SMOOTH_TIMEWARP,
            )
            dynamic_extra_seconds = max(0.0, new_total - float(video_duration))
            try:
                # Defensive guard: an empty/degenerate plan (e.g. zero usable
                # segments) would yield new_total <= 0 and produce a broken,
                # zero-length mux.  Bail to the fixed-length path instead.
                if not chunks or not seg_plan or not (new_total > 0):
                    raise RuntimeError(
                        f"empty/invalid time-warp plan "
                        f"(chunks={len(chunks)}, segs={len(seg_plan)}, total={new_total})"
                    )
                warped_video = build_timewarped_video(video_path, chunks, new_total, work_dir)
                # Re-time each line onto the warped timeline and, for the rare
                # clamped (very dense) line, apply a small voice speed-up.
                warped_paths: list[Path] = []
                for i, (seg, plan, audio_path) in enumerate(zip(segments, seg_plan, seg_audio_paths)):
                    path = audio_path
                    if plan["dub_speed"] > 1.001 and not seg.get("preserve_original"):
                        try:
                            path = _apply_atempo(audio_path, plan["dub_speed"], seg_dir, f"dyn_speed_{i}")
                        except Exception as sp_err:
                            log.warning("[Dynamic] dub speed-up failed for seg %d (%s); using natural.", i, sp_err)
                    seg["start"] = round(float(plan["out_start"]), 4)
                    seg["end"] = round(float(plan["out_start"]) + max(0.0, float(plan["placed_dur"])), 4)
                    warped_paths.append(path)
                fitted_paths = warped_paths
                mux_video = warped_video
                mux_duration = new_total
                dynamic_applied = True
                # Warp the background by the SAME factor so it stays locked to
                # the picture.
                if background_audio is not None and background_audio.exists():
                    try:
                        background_audio = timewarp_background(background_audio, chunks, new_total, work_dir)
                    except Exception as bg_err:
                        log.warning(
                            "[Dynamic] Background time-warp failed (%s); "
                            "using original background (may drift slightly).", bg_err,
                        )
                log.info(
                    "[Dynamic] Applied (time-warp): +%.2fs; output duration %.2fs",
                    dynamic_extra_seconds, new_total,
                )
            except Exception as dyn_err:
                log.warning(
                    "[Dynamic] Time-warp build failed (%s). "
                    "Falling back to fixed-length timing.", dyn_err,
                )
                dynamic_applied = False
                mux_video = video_path
                mux_duration = video_duration

        if not dynamic_applied:
            update_progress("CLONING", 60, "Fitting audio timing to video...")
            fitted_paths = []
            for idx, (seg, audio_path) in enumerate(zip(segments, seg_audio_paths)):
                # Preserved devotional segments keep their original audio as-is
                # — never speed/trim them to fit a slot.
                if seg.get("preserve_original"):
                    fitted_paths.append(audio_path)
                    continue
                # Use the same pause-aware window the speed solver and QA gate
                # used so the timing-fit pass agrees on one target.  Falling
                # back to the raw slot keeps legacy/un-annotated segments working.
                target_dur = compute_target_speech_seconds(seg)
                if not (isinstance(target_dur, (int, float)) and target_dur > 0):
                    target_dur = seg["end"] - seg["start"]
                # Pass the next segment's start so fit_audio_to_duration knows
                # how far it can let the dub overflow without colliding with the
                # next line.  When this is the final segment, use video_duration
                # as the virtual "next start".
                next_seg_start = (
                    segments[idx + 1]["start"] if idx + 1 < len(segments) else video_duration
                )
                seg.setdefault("_pacing", {})
                fitted = fit_audio_to_duration(
                    audio_path,
                    target_dur,
                    seg_dir,
                    next_seg_start=float(next_seg_start),
                    seg_start=float(seg["start"]),
                    pacing=seg["_pacing"],
                )
                fitted_paths.append(fitted)

        # -- 8. Assemble dubbed audio track ------------------------------------
        update_progress("CLONING", 65, "Assembling dubbed audio track...")
        # If we're keeping the separated background AND preserving devotional
        # segments, silence the background under those windows — the preserved
        # original slice already contains the music, so we must not layer the
        # Demucs background on top of it.  (seg start/end are in the output
        # timeline here: dynamic mode rewrote them; fixed mode == original.)
        if (PRESERVE_CHANTS and preserved_count
                and background_audio is not None and background_audio.exists()):
            preserve_windows = [
                (float(seg["start"]), float(seg["end"]))
                for seg in segments if seg.get("preserve_original")
            ]
            try:
                background_audio = mute_background_windows(
                    background_audio, preserve_windows, work_dir / "background_muted.wav",
                )
            except Exception as mb_err:
                log.warning(
                    "[Chants] Could not mute background under preserved windows (%s); "
                    "using background as-is (may double the music there).", mb_err,
                )
        dubbed_audio = assemble_dubbed_audio(
            segments, fitted_paths, mux_duration, work_dir, background_audio
        )

        # -- 9. Lip sync (optional) --------------------------------------------
        final_video_path = work_dir / "output.mp4"
        lip_sync_applied = False

        if LIP_SYNC:
            update_progress("LIPSYNC", 70, f"Running lip sync ({LIP_SYNC_QUALITY})...")
            lip_dir = work_dir / "lipsync"
            lip_dir.mkdir()
            lipsync_video = run_lipsync(mux_video, dubbed_audio, lip_dir)
            if lipsync_video is not None:
                shutil.copy(lipsync_video, final_video_path)
                lip_sync_applied = True
                update_progress("LIPSYNC", 82, "Lip sync complete.")
            else:
                log.warning("[Main] Lip sync failed, muxing dubbed audio without lip sync.")
                update_progress("MERGING", 78, "Merging video and dubbed audio (no lip sync)...")
                mux_final_video(mux_video, dubbed_audio, final_video_path, video_duration=mux_duration)
        else:
            update_progress("MERGING", 78, "Merging video and dubbed audio...")
            mux_final_video(mux_video, dubbed_audio, final_video_path, video_duration=mux_duration)

        # â”€â”€ 10. Generate SRT and transcript â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("MERGING", 88, "Generating subtitles...")
        srt_path = work_dir / "subtitles.srt"
        transcript_path = work_dir / "transcript.json"
        generate_srt(segments, srt_path, video_duration=mux_duration)
        generate_transcript_json(segments, transcript_path)

        # â”€â”€ 11. Upload to S3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("UPLOADING", 93, "Uploading translated video to cloud...")
        output_key  = f"{S3_OUTPUT_PREFIX}/output.mp4"
        srt_key     = f"{S3_OUTPUT_PREFIX}/subtitles.srt"
        json_key    = f"{S3_OUTPUT_PREFIX}/transcript.json"

        upload_to_s3(final_video_path, output_key, "video/mp4")
        upload_to_s3(srt_path, srt_key, "text/plain")
        upload_to_s3(transcript_path, json_key, "application/json")

        # -- 11b. Upload translation report (metadata for debugging/auditing) --
        report_key = f"{S3_OUTPUT_PREFIX}/translation_report.json"
        try:
            report = {
                "jobId": JOB_ID,
                "cosyvoiceModelId": COSYVOICE_MODEL_ID,
                "voiceCloneRequested": VOICE_CLONE,
                "voiceCloneApplied": voice_was_cloned,
                "multiSpeaker": MULTI_SPEAKER,
                "useDemucs": USE_DEMUCS,
                "demucsApplied": demucs_applied,
                "demucsWarning": demucs_warning,
                "lipSync": LIP_SYNC,
                "lipSyncApplied": lip_sync_applied,
                "dynamicVideoLength": DYNAMIC_VIDEO_LENGTH,
                "dynamicVideoLengthApplied": dynamic_applied,
                "dynamicSmoothTimewarp": DYNAMIC_SMOOTH_TIMEWARP,
                "dynamicExtraSeconds": round(dynamic_extra_seconds, 3),
                "outputDurationSeconds": round(mux_duration, 3),
                "preserveChants": PRESERVE_CHANTS,
                "preservedSegmentCount": preserved_count,
                "translationMode": TRANSLATION_MODE,
                "targetLang": TARGET_LANG,
                "segmentCount": len(segments),
                # Phase 3: performance flags for debugging
                "cosyvoiceFp16": COSYVOICE_FP16,
                "cosyvoiceVllm": COSYVOICE_VLLM,
                "cosyvoiceParallelSynth": COSYVOICE_PARALLEL_SYNTH,
                # Phase 1: aggregate pacing telemetry so we can detect
                # regressions (e.g. mean atempo creeping up) without parsing
                # every segment's transcript entry.
                "pacingSummary": summarize_pacing(segments),
            }
            report_path = work_dir / "translation_report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            upload_to_s3(report_path, report_key, "application/json")
        except Exception as rpt_err:
            log.warning(f"[Report] Could not upload translation report: {rpt_err}")

        # â”€â”€ 12. Mark complete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("DONE", 100, "Translation complete!", {
            "outputKey": output_key,
            "srtKey": srt_key,
            "transcriptKey": json_key,
            "segmentCount": len(segments),
            "targetLang": TARGET_LANG,
            "voiceClone": VOICE_CLONE,
            "voiceCloneApplied": voice_was_cloned,
            "lipSync": LIP_SYNC,
            "lipSyncApplied": lip_sync_applied,
            "dynamicVideoLength": DYNAMIC_VIDEO_LENGTH,
            "dynamicVideoLengthApplied": dynamic_applied,
            "dynamicExtraSeconds": round(dynamic_extra_seconds, 3),
            "outputDurationSeconds": round(mux_duration, 3),
            "preserveChants": PRESERVE_CHANTS,
            "preservedSegmentCount": preserved_count,
            "reportKey": report_key,
        })

        log.info(f"=== Job {JOB_ID} complete. Output: s3://{S3_BUCKET}/{output_key} ===")

    except Exception as e:
        log.exception(f"[FATAL] Job failed: {e}")
        mark_failed(str(e))
        sys.exit(1)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        log.info(f"[Cleanup] Work dir removed: {work_dir}")


if __name__ == "__main__":
    main()
