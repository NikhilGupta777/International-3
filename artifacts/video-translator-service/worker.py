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
import uuid
import time
import json
import re
import logging
import tempfile
import shutil
import subprocess
import math
import base64
import inspect
import importlib.metadata
import importlib.util
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from runtime_deps import pip_install_command, write_runtime_requirements

# â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("translator-worker")

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
# Best-effort: derive code from SOURCE_LANG name when explicit code is absent
if not SOURCE_LANG_CODE and SOURCE_LANG not in ("", "auto"):
    SOURCE_LANG_CODE = SOURCE_LANG[:2].lower()
VOICE_CLONE         = os.environ.get("VOICE_CLONE", "true").lower() == "true"
LIP_SYNC            = os.environ.get("LIP_SYNC", "false").lower() == "true"
USE_DEMUCS          = os.environ.get("USE_DEMUCS", "false").lower() == "true"
MULTI_SPEAKER       = os.environ.get("MULTI_SPEAKER", "false").lower() == "true"
ASSEMBLYAI_API_KEY  = os.environ.get("ASSEMBLYAI_API_KEY", "")
LIP_SYNC_QUALITY    = os.environ.get("LIP_SYNC_QUALITY", "latentsync")  # latentsync (only supported mode)
TRANSLATION_MODE    = os.environ.get("TRANSLATION_MODE", "default")   # default | budget | premium

MODEL_CACHE_DIR     = Path(os.environ.get("MODEL_CACHE_DIR", "/model-cache"))
MODELSCOPE_CACHE    = Path(os.environ.get("MODELSCOPE_CACHE", str(MODEL_CACHE_DIR / "modelscope")))
HF_HOME             = Path(os.environ.get("HF_HOME", str(MODEL_CACHE_DIR / "huggingface")))
ALLOW_RUNTIME_MODEL_DOWNLOADS = os.environ.get("ALLOW_RUNTIME_MODEL_DOWNLOADS", "1").lower() == "1"
ALLOW_VOICE_CLONE_FALLBACK = os.environ.get("ALLOW_VOICE_CLONE_FALLBACK", "true").lower() == "true"
ALLOW_LIP_SYNC_FALLBACK = os.environ.get("ALLOW_LIP_SYNC_FALLBACK", "true").lower() == "true"
COSYVOICE_MODEL_ID  = os.environ.get("COSYVOICE_MODEL_ID", "iic/CosyVoice2-0.5B")
LATENTSYNC_REPO_ID  = os.environ.get("LATENTSYNC_REPO_ID", "ByteDance/LatentSync")
LATENTSYNC_CHECKPOINT = os.environ.get("LATENTSYNC_CHECKPOINT", "latentsync_unet.pt")

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

def update_progress(status: str, progress: int, step: str, extra: Optional[dict] = None):
    """Write progress to DynamoDB so the frontend can poll it."""
    try:
        global _LAST_PIPELINE_STATUS, _LAST_PIPELINE_PROGRESS
        if status != "FAILED":
            _LAST_PIPELINE_STATUS = status
            _LAST_PIPELINE_PROGRESS = progress
        extra = extra or {}
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
    update_progress("FAILED", _LAST_PIPELINE_PROGRESS, f"Error: {error}", {"error": error})


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

def run_ffmpeg(*args, check: bool = True):
    cmd = ["ffmpeg", "-y", *args]
    log.info(f"[FFmpeg] {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{result.stderr[-2000:]}")
    return result


def extract_audio(video_path: Path, out_dir: Path) -> Path:
    """Extract audio as 16kHz mono WAV."""
    wav_path = out_dir / "audio_full.wav"
    run_ffmpeg(
        "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        str(wav_path),
    )
    return wav_path


def get_video_duration(video_path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 1: Demucs vocal separation (optional)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def run_demucs(audio_path: Path, out_dir: Path) -> tuple[Path, Path]:
    """
    Separate vocals from background using Demucs htdemucs model.
    Returns (vocals_path, background_path).
    """
    # Lazy install demucs (stripped from base image to keep CI fast)
    try:
        import demucs  # noqa: F401
    except ImportError:
        import subprocess as _spd, sys as _sysd
        _spd.run([_sysd.executable, '-m', 'pip', 'install',
                  '--quiet', '--prefer-binary', 'demucs==4.0.1'], check=True)

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
    import assemblyai as aai

    if not ASSEMBLYAI_API_KEY:
        raise ValueError("ASSEMBLYAI_API_KEY environment variable is not set.")

    aai.settings.api_key = ASSEMBLYAI_API_KEY

    log.info(f"[AssemblyAI] Uploading and transcribing {audio_path.name}...")
    transcriber = aai.Transcriber()
    config_args = {"speaker_labels": MULTI_SPEAKER}

    if SOURCE_LANG != "auto" and SOURCE_LANG in ASSEMBLYAI_LANG_MAP:
        config_args["language_code"] = ASSEMBLYAI_LANG_MAP[SOURCE_LANG]
    else:
        config_args["language_detection"] = True

    config = aai.TranscriptionConfig(**config_args)
    transcript = transcriber.transcribe(str(audio_path), config)

    if transcript.error:
        raise RuntimeError(f"AssemblyAI error: {transcript.error}")

    global SOURCE_LANG_CODE
    detected_code = transcript.json_response.get('language_code')
    if detected_code:
        SOURCE_LANG_CODE = detected_code
    log.info(f"[AssemblyAI] Transcribed. Detected language: {detected_code or 'unknown'}")

    # ── Helper: build segments from a flat word list (single-speaker path) ──────
    def _build_segments_from_words(word_list, speaker_label: Optional[str] = None) -> list[dict]:
        if not word_list:
            return []
        segs: list[dict] = []
        cur_words: list[dict] = []
        seg_start_t = word_list[0].start / 1000.0

        def flush(end_t):
            nonlocal cur_words, seg_start_t
            if not cur_words:
                return
            text = " ".join(w["word"] for w in cur_words).strip()
            if text:
                entry: dict = {
                    "id": len(segs),
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
                if gap > 0.45 or dur > 8.0:
                    flush(prev_end)
                    seg_start_t = w_start
            cur_words.append({"word": w.text, "start": w_start, "end": w_end})

        if cur_words:
            flush(cur_words[-1]["end"])
        return segs

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

            # Split utterances longer than 10 s at natural pause boundaries
            if utt_end - utt_start > 10.0 and utt_words:
                # Build dummy Word-like objects the helper can use
                class _FakeWord:
                    def __init__(self, d):
                        self.text  = d["word"]
                        self.start = int(d["start"] * 1000)
                        self.end   = int(d["end"]   * 1000)
                sub = _build_segments_from_words(
                    [_FakeWord(w) for w in utt_words], speaker_label=speaker
                )
                for s in sub:
                    s["id"] = len(segments)
                    segments.append(s)
            else:
                segments.append({
                    "id":      len(segments),
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
    if not all_words:
        return []

    segments = _build_segments_from_words(all_words)
    log.info(f"[AssemblyAI] Grouped into {len(segments)} segments.")
    return segments


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 2b: Optional speaker diarization (pyannote)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def diarize(audio_path: Path, segments: list[dict]) -> list[dict]:
    """
    Tag each segment with a speaker label using pyannote 3.1.
    Requires HF_TOKEN env var for gated model access.
    """
    try:
        # Lazy install pyannote (stripped from base image to keep CI fast)
        try:
            import pyannote.audio  # noqa: F401
        except ImportError:
            import subprocess as _spp, sys as _sysp
            _spp.run([_sysp.executable, '-m', 'pip', 'install',
                      '--quiet', '--prefer-binary', 'pyannote.audio>=3.1.0'], check=True)

        import torch
        from pyannote.audio import Pipeline

        hf_token = os.environ.get("HF_TOKEN", "")
        if not hf_token:
            log.warning("[Diarize] HF_TOKEN not set, skipping diarization.")
            return segments

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
            if seg.get("speaker") and seg["speaker"] != "SPEAKER_00":
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
                seg["speaker"] = "SPEAKER_00"

        del pipeline
        torch.cuda.empty_cache()
        log.info("[Diarize] Done.")
    except Exception as e:
        log.warning(f"[Diarize] Failed: {e}")
    return segments

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2c: Per-speaker voice reference extraction
# ─────────────────────────────────────────────────────────────────────────────

def extract_speaker_reference(
    audio_path: Path,
    segments: list[dict],
    out_dir: Path,
    max_ref_duration: float = 15.0,
    min_segment_duration: float = 1.5,
) -> dict:
    """
    Build one clean reference WAV per unique speaker from the source audio.
    Returns {speaker_label: Path} — used by CosyVoice for per-speaker cloning.

    Strategy: for each speaker, concatenate their longest clean segments
    (up to max_ref_duration total).  Falls back to full audio if a speaker
    has no sufficiently long segments.
    """
    import numpy as np
    import soundfile as sf

    speaker_refs: dict = {}

    try:
        full_audio, sr = sf.read(str(audio_path))
        if full_audio.ndim > 1:
            full_audio = full_audio.mean(axis=1)
    except Exception as exc:
        log.warning(f"[SpeakerRef] Could not read audio: {exc}")
        return speaker_refs

    # Group segments by speaker
    speaker_map: dict = {}
    for seg in segments:
        spk = (seg.get("speaker") or "SPEAKER_00")
        speaker_map.setdefault(spk, []).append(seg)

    for spk, spk_segs in speaker_map.items():
        # Sort by duration descending — pick longest clean clips first
        by_dur = sorted(spk_segs, key=lambda s: s["end"] - s["start"], reverse=True)

        clips: list = []
        total_dur: float = 0.0
        for seg in by_dur:
            dur = seg["end"] - seg["start"]
            if dur < min_segment_duration:
                continue
            clips.append(seg)
            total_dur += dur
            if total_dur >= max_ref_duration:
                break

        # Fallback: take any segment if none are long enough
        if not clips:
            clips = by_dur[:3]

        if not clips:
            log.warning(f"[SpeakerRef] No usable clips for {spk}; using full audio.")
            speaker_refs[spk] = audio_path
            continue

        # Concatenate selected clips into one reference
        chunks: list = []
        for seg in clips:
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

    return speaker_refs


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2d: Merge micro-segments for TTS quality
# ─────────────────────────────────────────────────────────────────────────────

def merge_segments_for_dubbing(segments: list[dict]) -> list[dict]:
    """
    Merge micro-segments before translation/TTS to prevent choppy voice output.
    Sub-second segments are poison for TTS — a voice model cannot naturally
    synthesize speech into 0.1-0.8 second slots.
    Target: 2.5-7s merged segments. Hard max 8s.
    Respects speaker labels — never merges different speakers.
    """
    if not segments:
        return segments

    original_count = len(segments)
    merged: list[dict] = []
    buf: dict | None = None

    for seg in segments:
        if buf is None:
            buf = dict(seg)
            continue

        gap = float(seg["start"]) - float(buf["end"])
        buf_dur = float(buf["end"]) - float(buf["start"])
        word_count = len(str(buf.get("text", "")).split())
        merged_dur = float(seg["end"]) - float(buf["start"])

        # Only merge same speaker (or when no speaker labels exist)
        buf_speaker = str(buf.get("speaker", "")).strip()
        seg_speaker = str(seg.get("speaker", "")).strip()
        same_speaker = (not buf_speaker and not seg_speaker) or (buf_speaker == seg_speaker)

        should_merge = (
            same_speaker
            and (buf_dur < 1.2 or word_count < 3 or gap < 0.8)
            and merged_dur <= 8.0
        )

        if should_merge:
            buf["end"] = seg["end"]
            buf["text"] = (
                str(buf.get("text", "")).strip()
                + " "
                + str(seg.get("text", "")).strip()
            ).strip()
            buf["words"] = list(buf.get("words", [])) + list(seg.get("words", []))
        else:
            merged.append(buf)
            buf = dict(seg)

    if buf:
        merged.append(buf)

    # Re-index segment IDs sequentially
    for i, seg in enumerate(merged):
        seg["id"] = i

    log.info(f"[Merge] {original_count} segments -> {len(merged)} after dubbing merge.")
    return merged


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
    if text[-1] not in '.?!\u0964':         # \u0964 = Devanagari danda
        text += '.'
    return text


def _find_cosyvoice_model() -> Optional[Path]:
    candidates: list[Path] = []
    for root in [
        MODELSCOPE_CACHE / "hub" / "iic",
        MODELSCOPE_CACHE / "hub" / "models" / "iic",
        MODELSCOPE_CACHE / "iic",
        MODELSCOPE_CACHE / "models" / "iic",
        MODELSCOPE_CACHE,
    ]:
        for model_name in ("CosyVoice2-0.5B", "CosyVoice3-0.5B"):
            p = root / model_name
            if p.exists():
                return p
        if root.exists():
            candidates.extend(root.glob("CosyVoice2*"))
            candidates.extend(root.glob("CosyVoice3*"))
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
    # We accept either CosyVoice2-0.5B or CosyVoice3-0.5B — the Dockerfile
    # downloads v2 (publicly available). v3 is tried at runtime but falls back to v2.
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
            "Expected CosyVoice2-0.5B or CosyVoice3-0.5B. "
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
    def _try_import():
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2 as _CosyVoice  # type: ignore
        except Exception:
            from cosyvoice.cli.cosyvoice import CosyVoice as _CosyVoice  # type: ignore
        return _CosyVoice

    try:
        return _try_import()
    except ModuleNotFoundError as exc:
        if exc.name != "whisper":
            raise
        # CosyVoice imports openai-whisper internally for its frontend. AssemblyAI is
        # still the only transcription provider used by this worker.
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
    # Allow a hard override via env var (useful for A/B testing or cost control).
    env_override = os.environ.get("TRANSLATION_MODEL", "").strip()
    if env_override:
        return env_override
    # Always use Gemini 3.1 Pro for translation — the Pro model produces the
    # most natural dubbing phrasing, correct acronym handling, and tts_text
    # quality that Flash cannot reliably match.  'mode' is kept as a parameter
    # for backward compatibility but is intentionally ignored here.
    return "gemini-3.1-pro-preview"


TRANSLATION_SYSTEM_PROMPT = """
You are a professional dubbing translator for video voice-over.

Your task is to translate speech segments into natural spoken dubbing text for Text-To-Speech (TTS) engines.

Core rules:
1. Translate meaning, emotion, tone, and intent — NOT word-for-word.
2. Write speakable voice-over text, not subtitle fragments.
3. Keep each translation close to the original segment duration.
4. Do NOT output ellipses, filler dots, broken phrases, half-words, pronunciation hints, labels, brackets, or explanations.
5. Every translated_text and tts_text must be natural when spoken aloud and must end with punctuation.
6. Preserve names, religious terms, cultural references, and important proper nouns accurately.
7. If source text is mixed-language or contains a verse/quote, translate the meaning naturally.
8. If the source segment is a fragment, translate it as a complete natural spoken phrase. Make output speakable.
9. Return ONLY valid JSON. No markdown, no code fences, no commentary.

Duration rules:
- duration < 1.5s: 1-3 short words only.
- 1.5s-3s: one short phrase.
- 3s-6s: one natural sentence.
- 6s-8s: one or two short sentences.
Never write a long sentence for a short duration.

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
    "tts_text": "<TTS-optimised text — acronyms spelled out, numbers as words>",
    "emotion": "<neutral|happy|sad|excited|serious|questioning>",
    "speaking_rate": <number from 0.9 to 1.2>
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

def translate_segments(segments: list[dict]) -> list[dict]:
    """
    Translate all segments using Gemini with dubbing-aware prompts.
    Adds 'translated_text', 'emotion', 'speaking_rate' to each segment.
    """
    log.info(f"[Gemini] Translating {len(segments)} segments to {TARGET_LANG}...")

    # Build the translation request payload
    seg_payload = [
        {
            "id": s["id"],
            "start": s["start"],
            "end": s["end"],
            "duration": round(s["end"] - s["start"], 2),
            "text": s["text"],
            "speaker": s.get("speaker", "SPEAKER_00"),
        }
        for s in segments
    ]

    user_prompt = (
        f"Translate these merged dubbing segments into {TARGET_LANG}.\n"
        f"{NATIVE_SCRIPT_RULE}\n"
        f"{target_script_instruction(TARGET_LANG, TARGET_LANG_CODE)}\n\n"
        f"Important:\n"
        f"- These segments will be passed directly into TTS/voice cloning.\n"
        f"- Make each translated_text natural, short, and speakable.\n"
        f"- Respect each segment duration.\n"
        f"- Do not output source text, transliteration, labels, explanations, or markdown.\n"
        f"- Keep religious/devotional terms respectful and accurate.\n\n"
        f"Segments JSON:\n{json.dumps(seg_payload, ensure_ascii=False, indent=2)}"
    )

    model = _gemini_model_for_mode(TRANSLATION_MODE)
    translations = None
    attempts = 0

    while attempts < 3:
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
            translations = json.loads(response.text)
            break
        except Exception as e:
            attempts += 1
            log.warning(f"[Gemini] Attempt {attempts} failed: {e}")
            if attempts >= 3:
                # On persistent failure, rotate to a different API key and retry once.
                # If already exhausted, raise.
                if _gemini_key_idx < len(GEMINI_KEYS):
                    log.info(f"[Gemini] Rotating key and retrying (key index {_gemini_key_idx})...")
                    attempts = 0  # reset counter for fresh attempt with new key
                else:
                    raise RuntimeError(f"Translation failed after all retries: {e}")
            time.sleep(2 ** attempts)

    # Merge translations back into segments
    trans_map = {t["id"]: t for t in translations}
    missing = [seg["id"] for seg in segments if seg["id"] not in trans_map]
    if missing:
        raise RuntimeError(f"Gemini translation missing segment ids: {missing[:10]}")

    for seg in segments:
        t = trans_map.get(seg["id"], {})
        translated = str(t.get("translated_text", "")).strip()
        if not translated and seg["text"].strip():
            raise RuntimeError(f"Missing translated_text for segment {seg['id']}")
        seg["translated_text"] = translated
        # tts_text is the TTS-optimised version (acronyms spelled out, etc.).
        # Fall back to translated_text if Gemini didn't return it.
        tts_raw = str(t.get("tts_text", "")).strip()
        seg["tts_text"] = tts_raw if tts_raw else translated
        seg["emotion"] = t.get("emotion", "neutral")
        seg["speaking_rate"] = max(0.9, min(1.2, float(t.get("speaking_rate", 1.0))))

    log.info(f"[Gemini] Translation complete using {model}.")
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
) -> list[Path]:
    """
    Zero-shot / cross-lingual voice cloning via CosyVoice.
    When speaker_refs is provided each speaker gets their own voice reference,
    so a multi-speaker video is dubbed with the correct voice per speaker.
    Falls back to default_reference_audio for any unknown speaker.
    """
    import torch
    import torchaudio

    cv_dir = _ensure_cosyvoice()
    if str(cv_dir) not in sys.path:
        sys.path.insert(0, str(cv_dir))
    matcha_root = cv_dir / "third_party" / "Matcha-TTS"
    if str(matcha_root) not in sys.path:
        sys.path.insert(0, str(matcha_root))

    _ensure_cosyvoice_yaml_compatibility()
    _CosyVoice = _import_cosyvoice_class()

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

    tried_model_paths: set[str] = set()
    for model_name in ("CosyVoice2-0.5B", "CosyVoice3-0.5B"):
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
            model = _CosyVoice(str(model_path), load_jit=False, load_trt=False)
            break
        except Exception as e:
            last_err = e
            log.warning(f"[CosyVoice] Failed loading {model_name}: {e}")
    if model is None:
        raise RuntimeError(f"CosyVoice model load failed: {last_err}")

    # ── Decide inference mode (cross-lingual vs zero-shot) ──────────────────
    is_cross_lingual = (
        bool(TARGET_LANG_CODE)
        and TARGET_LANG_CODE.lower() not in ("", "auto")
        and TARGET_LANG_CODE.lower() != SOURCE_LANG_CODE.lower()
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
        if rs != 16000:
            rw = torchaudio.functional.resample(rw, rs, 16000)
        rw = rw[:, : 16000 * 30]  # cap at 30 s
        # Use a safe filename for the cached 16 kHz WAV
        safe_spk = re.sub(r"[^A-Za-z0-9_\-]", "_", speaker)
        fname = out_dir / f"ref_{safe_spk}_16k.wav"
        torchaudio.save(str(fname), rw, 16000)
        _ref_cache[key] = (rw, str(fname))
        return rw, str(fname)

    # Pre-warm default reference
    default_ref_wav, default_ref_prompt_path = _load_ref(default_reference_audio, "default")

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
    speaker_prompt_texts: dict = {}
    if not use_cross_lingual:
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

        # Per-speaker: collect that speaker's source text from the first 12 s of their clips
        from collections import defaultdict as _dd2
        spk_segs: dict = _dd2(list)
        for seg in segments:
            spk_segs[seg.get("speaker") or "SPEAKER_00"].append(seg)
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

    # ── Synthesize each segment ───────────────────────────────────────────────
    seg_audios: list[Path] = []
    total_segments = max(1, len(segments))

    for index, seg in enumerate(segments, start=1):
        update_progress(
            "CLONING",
            52 + int((index - 1) / total_segments * 7),
            f"Cloning voice ({index}/{total_segments})…",
        )
        out_path = out_dir / f"seg_{seg['id']:04d}.wav"

        # Use tts_text (TTS-optimised) if Gemini produced it, else translated_text
        text = normalize_tts_text(
            seg.get("tts_text") or seg.get("translated_text") or ""
        )

        if not text:
            duration = max(0.1, seg["end"] - seg["start"])
            run_ffmpeg("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                       "-t", str(duration), str(out_path))
            seg_audios.append(out_path)
            continue

        # Resolve which reference to use for this speaker
        speaker = (seg.get("speaker") or "SPEAKER_00")
        if speaker_refs and speaker in speaker_refs:
            try:
                seg_ref_wav, seg_ref_prompt_path = _load_ref(
                    Path(speaker_refs[speaker]), speaker
                )
            except Exception:
                seg_ref_wav, seg_ref_prompt_path = default_ref_wav, default_ref_prompt_path
        else:
            seg_ref_wav, seg_ref_prompt_path = default_ref_wav, default_ref_prompt_path

        seg_prompt_text = speaker_prompt_texts.get(speaker, global_prompt_text)

        try:
            if use_cross_lingual:
                cl_params = inspect.signature(model.inference_cross_lingual).parameters
                cl_args: dict = {"tts_text": text, "stream": False}
                if "prompt_wav" in cl_params:
                    cl_args["prompt_wav"] = seg_ref_prompt_path
                elif "prompt_speech_16k" in cl_params:
                    cl_args["prompt_speech_16k"] = seg_ref_wav
                else:
                    raise RuntimeError(
                        f"Unsupported CosyVoice cross_lingual signature: "
                        f"{', '.join(cl_params.keys())}"
                    )
                if "speed" in cl_params:
                    cl_args["speed"] = 1.0
                chunks = list(model.inference_cross_lingual(**cl_args))
            else:
                zs_params = inspect.signature(model.inference_zero_shot).parameters
                zs_args: dict = {
                    "tts_text": text,
                    "prompt_text": seg_prompt_text,
                    "stream": False,
                }
                if "prompt_wav" in zs_params:
                    zs_args["prompt_wav"] = seg_ref_prompt_path
                elif "prompt_speech_16k" in zs_params:
                    zs_args["prompt_speech_16k"] = seg_ref_wav
                else:
                    raise RuntimeError(
                        f"Unsupported CosyVoice zero-shot signature: "
                        f"{', '.join(zs_params.keys())}"
                    )
                if "speed" in zs_params:
                    zs_args["speed"] = 1.0
                chunks = list(model.inference_zero_shot(**zs_args))

            audio_data = torch.cat([c["tts_speech"] for c in chunks], dim=1)
            torchaudio.save(str(out_path), audio_data, 24000)  # CosyVoice native SR=24kHz
        except Exception as exc:
            raise RuntimeError(
                f"CosyVoice failed for segment {seg['id']} speaker={speaker}: {exc}"
            ) from exc

        seg_audios.append(out_path)
        log.info(f"[CosyVoice] Seg {seg['id']}/{len(segments)} done (speaker={speaker}).")

    update_progress("CLONING", 59, "Voice cloning complete.")
    del model
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

    async def _run():
        c = edge_tts.Communicate(text=seg["translated_text"], voice=voice, rate=rate_str)
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
    gTTS(text=seg["translated_text"], lang=gtts_lang).save(str(out_path))
    run_ffmpeg("-i", str(out_path), "-ar", "24000", "-ac", "1", str(wav_path))
    return wav_path

def synthesize_silence_single(seg: dict, out_dir: Path) -> Path:
    """Last-resort segment fallback so one bad TTS segment does not fail the video."""
    out_path = out_dir / f"seg_{seg['id']:04d}_silence.wav"
    duration = max(0.25, float(seg.get("end", 0)) - float(seg.get("start", 0)))
    run_ffmpeg("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(duration), str(out_path))
    return out_path

def synthesize_all(
    segments: list[dict],
    reference_audio: Path,
    out_dir: Path,
    speaker_refs: Optional[dict] = None,
) -> tuple[list[Path], bool]:
    """
    Master TTS router: CosyVoice -> edge-tts -> gTTS (auto-fallback at every level).
    speaker_refs: {speaker_label: Path} for per-speaker voice cloning.
    Returns (seg_audio_paths, voice_was_cloned).
    """
    if VOICE_CLONE:
        try:
            paths = synthesize_segments_cosyvoice(
                segments, reference_audio, out_dir, speaker_refs=speaker_refs
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

def fit_audio_to_duration(audio_path: Path, target_duration: float, out_dir: Path) -> Path:
    """
    Speed-up or slow-down audio to match target_duration.
    Uses FFmpeg atempo filter (0.5x â€“ 2.0x range, chained for extremes).
    """
    import soundfile as sf
    data, sr = sf.read(str(audio_path))
    actual_dur = len(data) / sr

    if abs(actual_dur - target_duration) < 0.1:
        return audio_path  # close enough, no change needed

    ratio = actual_dur / max(target_duration, 0.1)
    # Relax the clamp so we don't get chipmunk voices (max 1.25x speedup)
    ratio = max(0.85, min(1.25, ratio))

    out_path = audio_path.with_stem(audio_path.stem + "_fitted")

    tempo_filters = f"atempo={round(ratio, 3)}"

    run_ffmpeg("-i", str(audio_path), "-filter:a", tempo_filters, str(out_path))
    return out_path


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
    """LatentSync 1.6 â€” best quality lip sync (diffusion-based, 512Ã—512)."""
    out_path = out_dir / "latentsync_output.mp4"
    ls_dir = MODEL_CACHE_DIR / "LatentSync"

    if not ls_dir.exists():
        raise RuntimeError(
            f"LatentSync repo not found at {ls_dir}. "
            "Translator image is missing preloaded model dependencies."
        )

    # Install LatentSync deps lazily on first run (not in CI build to keep image fast)
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
                f"pip stderr:\n{result.stderr[-2000:]}"
            )
        _latentsync_deps_flag.touch()

    # Checkpoint is pre-downloaded into the Docker image at build time.
    # HF_HUB_OFFLINE=1 is set at runtime — network downloads will fail.
    # If the checkpoint is missing, the image must be rebuilt.
    ckpt_dir = ls_dir / "checkpoints"
    ckpt_path = _ensure_latentsync_checkpoint(ckpt_dir)
    if not ckpt_path.exists():
        raise RuntimeError(
            f"LatentSync checkpoint not found at {ckpt_path}. "
            "Rebuild the Docker image — the build-time checkpoint download step failed."
        )

    ls_whisper = ls_dir / "checkpoints" / "whisper" / "tiny.pt"
    if not ls_whisper.exists():
        raise RuntimeError(
            f"LatentSync whisper model missing at {ls_whisper}. "
            "Rebuild the Docker image."
        )

    latentsync_env = os.environ.copy()
    existing_pythonpath = latentsync_env.get("PYTHONPATH", "")
    latentsync_env["PYTHONPATH"] = (
        str(ls_dir)
        if not existing_pythonpath
        else f"{ls_dir}{os.pathsep}{existing_pythonpath}"
    )

    result = subprocess.run([
        sys.executable, "scripts/inference.py",
        "--unet_config", "configs/unet/stage2.yaml",
        "--inference_ckpt", str(ckpt_path),
        "--video_path", str(video_path),
        "--audio_path", str(dubbed_audio),
        "--video_out_path", str(out_path),
    ], capture_output=True, text=True, cwd=str(ls_dir), env=latentsync_env)

    if result.returncode != 0:
        raise RuntimeError(f"LatentSync failed:\n{result.stderr[-1500:]}")
    if not out_path.exists():
        raise FileNotFoundError("LatentSync did not produce output file")
    log.info(f"[LatentSync] Done â†’ {out_path}")
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
    Returns path to final dubbed audio WAV.
    """
    SR = 24000
    import numpy as np
    import soundfile as sf

    log.info("[Assemble] Assembling final dubbed audio track...")
    min_samples = int(math.ceil(video_duration * SR))
    mixed = np.zeros(min_samples, dtype=np.float32)

    for seg, audio_path in zip(segments, seg_audio_paths):
        if not audio_path.exists():
            log.warning(f"[Assemble] Missing audio for segment {seg['id']}")
            continue

        data, sr = sf.read(str(audio_path))
        if data.ndim > 1:
            data = data.mean(axis=1)  # stereo â†’ mono

        # Resample if needed
        if sr != SR:
            import librosa
            data = librosa.resample(data, orig_sr=sr, target_sr=SR)

        # Truncate to segment duration so this segment's audio never bleeds
        # into the next segment's slot and causes two voices to overlap.
        max_seg_samples = max(1, int((seg["end"] - seg["start"]) * SR))
        if len(data) > max_seg_samples:
            data = data[:max_seg_samples]

        start_sample = max(0, int(seg["start"] * SR))
        end_sample = start_sample + len(data)
        if end_sample > len(mixed):
            mixed = np.pad(mixed, (0, end_sample - len(mixed)))
        mixed[start_sample:end_sample] += data

    # Normalise dubbed voice track
    peak = np.abs(mixed).max()
    if peak > 0:
        mixed = mixed / peak * 0.9

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
                "[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[v];"
                "[1:a]loudnorm=I=-28:TP=-2:LRA=14[b];"
                "[v][b]amix=inputs=2:duration=first:dropout_transition=0[out]"
            ),
            "-map", "[out]",
            "-ar", str(SR),
            str(final_mix),
        )
        return final_mix

    return dubbed_path


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 8: Generate SRT subtitle file
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fmt_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(segments: list[dict], out_path: Path):
    lines = []
    idx = 1
    for seg in segments:
        text = seg.get("translated_text", seg.get("text", "")).strip()
        if not text:
            continue
        lines.append(str(idx))
        lines.append(f"{_fmt_timestamp(seg['start'])} --> {_fmt_timestamp(seg['end'])}")
        lines.append(text)
        lines.append("")
        idx += 1
    out_path.write_text("\n".join(lines), encoding="utf-8")
    log.info(f"[SRT] Written {idx - 1} subtitle entries â†’ {out_path}")


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


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 10: Generate transcript JSON
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
                "speaker": s.get("speaker", "SPEAKER_00"),
            }
            for s in segments
        ],
    }
    out_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info(f"[Transcript] Written â†’ {out_path}")


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Main entrypoint
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main():
    log.info(f"=== Translator Worker starting. JobId={JOB_ID} ===")
    log.info(f"Target: {TARGET_LANG} ({TARGET_LANG_CODE}), LipSync={LIP_SYNC}, VoiceClone={VOICE_CLONE}")

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
        update_progress("EXTRACTING", 8, "Extracting audio...")
        full_audio = extract_audio(video_path, work_dir)

        # â”€â”€ 3. Optional Demucs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        background_audio = None
        transcription_audio = full_audio

        if USE_DEMUCS:
            update_progress("EXTRACTING", 12, "Separating voice from background music...")
            try:
                vocals_path, bg_path = run_demucs(full_audio, work_dir)
                transcription_audio = vocals_path
                background_audio = bg_path
            except Exception as e:
                log.warning(f"[Demucs] Skipped: {e}")

        # â”€â”€ 4. Transcription â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("TRANSCRIBING", 18, "Transcribing speech (AssemblyAI)...")
        segments = transcribe(transcription_audio)

        if not segments:
            raise RuntimeError("No speech detected in the video.")

        # â”€â”€ 5. Optional Diarization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if MULTI_SPEAKER:
            update_progress("TRANSCRIBING", 28, "Identifying speakers...")
            segments = diarize(transcription_audio, segments)

        # ── 5b. Merge micro-segments for TTS quality ─────────────────
        # Must run AFTER diarization so speaker labels are available.
        # Prevents choppy voice from sub-second segments.
        segments = merge_segments_for_dubbing(segments)

        log.info(f"Transcription: {len(segments)} segments (after merge)")

        # â”€â”€ 6. Translation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("TRANSLATING", 35, f"Translating to {TARGET_LANG}...")
        segments = translate_segments(segments)
        update_progress("TRANSLATING", 48, f"Translation complete. Generating voice...")

        # -- 7. Extract per-speaker voice references (when voice cloning + multiple speakers) -
        speaker_refs: dict = {}
        if VOICE_CLONE:
            unique_speakers = {seg.get("speaker") or "SPEAKER_00" for seg in segments}
            if len(unique_speakers) > 1:
                update_progress("CLONING", 50, "Extracting per-speaker voice references...")
                try:
                    speaker_refs = extract_speaker_reference(
                        transcription_audio, segments, work_dir
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
            segments, transcription_audio, seg_dir, speaker_refs=speaker_refs
        )

        if VOICE_CLONE and not voice_was_cloned:
            log.warning("[Main] Voice clone requested but CosyVoice fell back to edge-tts.")
        elif voice_was_cloned:
            log.info("[Main] Voice cloning successful -- CosyVoice used.")

        # -- 7c. Timing fit ----------------------------------------------------
        update_progress("CLONING", 60, "Fitting audio timing to video...")
        fitted_paths = []
        for seg, audio_path in zip(segments, seg_audio_paths):
            target_dur = seg["end"] - seg["start"]
            fitted = fit_audio_to_duration(audio_path, target_dur, seg_dir)
            fitted_paths.append(fitted)

        # -- 8. Assemble dubbed audio track ------------------------------------
        update_progress("CLONING", 65, "Assembling dubbed audio track...")
        dubbed_audio = assemble_dubbed_audio(
            segments, fitted_paths, video_duration, work_dir, background_audio
        )

        # -- 9. Lip sync (optional) --------------------------------------------
        final_video_path = work_dir / "output.mp4"
        lip_sync_applied = False

        if LIP_SYNC:
            update_progress("LIPSYNC", 70, f"Running lip sync ({LIP_SYNC_QUALITY})...")
            lip_dir = work_dir / "lipsync"
            lip_dir.mkdir()
            lipsync_video = run_lipsync(video_path, dubbed_audio, lip_dir)
            if lipsync_video is not None:
                shutil.copy(lipsync_video, final_video_path)
                lip_sync_applied = True
                update_progress("LIPSYNC", 82, "Lip sync complete.")
            else:
                log.warning("[Main] Lip sync failed, muxing dubbed audio without lip sync.")
                update_progress("MERGING", 78, "Merging video and dubbed audio (no lip sync)...")
                mux_final_video(video_path, dubbed_audio, final_video_path, video_duration=video_duration)
        else:
            update_progress("MERGING", 78, "Merging video and dubbed audio...")
            mux_final_video(video_path, dubbed_audio, final_video_path, video_duration=video_duration)

        # â”€â”€ 10. Generate SRT and transcript â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("MERGING", 88, "Generating subtitles...")
        srt_path = work_dir / "subtitles.srt"
        transcript_path = work_dir / "transcript.json"
        generate_srt(segments, srt_path)
        generate_transcript_json(segments, transcript_path)

        # â”€â”€ 11. Upload to S3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("UPLOADING", 93, "Uploading translated video to cloud...")
        output_key  = f"{S3_OUTPUT_PREFIX}/output.mp4"
        srt_key     = f"{S3_OUTPUT_PREFIX}/subtitles.srt"
        json_key    = f"{S3_OUTPUT_PREFIX}/transcript.json"

        upload_to_s3(final_video_path, output_key, "video/mp4")
        upload_to_s3(srt_path, srt_key, "text/plain")
        upload_to_s3(transcript_path, json_key, "application/json")

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
