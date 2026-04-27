"""
AWS Batch GPU Worker â€” Video Translator
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
  8. Lip sync (LatentSync 1.6 default â†’ MuseTalk fast fallback)
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
import logging
import tempfile
import shutil
import subprocess
import math
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

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
GEMINI_API_KEY      = os.environ["GEMINI_API_KEY"]
GEMINI_API_KEY_2    = os.environ.get("GEMINI_API_KEY_2", "")
GEMINI_API_KEY_3    = os.environ.get("GEMINI_API_KEY_3", "")

TARGET_LANG         = os.environ.get("TARGET_LANG", "Hindi")
TARGET_LANG_CODE    = os.environ.get("TARGET_LANG_CODE", "hi")
SOURCE_LANG         = os.environ.get("SOURCE_LANG", "auto")
VOICE_CLONE         = os.environ.get("VOICE_CLONE", "true").lower() == "true"
LIP_SYNC            = os.environ.get("LIP_SYNC", "false").lower() == "true"
USE_DEMUCS          = os.environ.get("USE_DEMUCS", "false").lower() == "true"
MULTI_SPEAKER       = os.environ.get("MULTI_SPEAKER", "false").lower() == "true"
ASSEMBLYAI_API_KEY  = os.environ.get("ASSEMBLYAI_API_KEY", "")
LIP_SYNC_QUALITY    = os.environ.get("LIP_SYNC_QUALITY", "latentsync")  # latentsync | musetalk
TRANSLATION_MODE    = os.environ.get("TRANSLATION_MODE", "default")   # default | budget | premium

MODEL_CACHE_DIR     = Path(os.environ.get("MODEL_CACHE_DIR", "/model-cache"))

# â”€â”€ AWS Clients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
s3 = boto3.client("s3", region_name=DYNAMODB_REGION)
ddb = boto3.resource("dynamodb", region_name=DYNAMODB_REGION)
table = ddb.Table(DYNAMODB_TABLE)


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# DynamoDB progress helpers
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def update_progress(status: str, progress: int, step: str, extra: dict = {}):
    """Write progress to DynamoDB so the frontend can poll it."""
    try:
        now_ms = int(time.time() * 1000)
        item = {
            "status": status,
            "progress": progress,
            "step": step,
            "updatedAt": now_ms,
            **extra,
        }
        table.update_item(
            Key={"jobId": JOB_ID},
            UpdateExpression=(
                "SET #s = :s, #p = :p, #st = :st, #ua = :ua"
                + ("".join(f", #{k} = :{k}" for k in extra))
            ),
            ExpressionAttributeNames={
                "#s": "status", "#p": "progress", "#st": "step", "#ua": "updatedAt",
                **{f"#{k}": k for k in extra},
            },
            ExpressionAttributeValues={
                ":s": status, ":p": progress, ":st": step,
                ":ua": item["updatedAt"],
                **{f":{k}": v for k, v in extra.items()},
            },
        )
        log.info(f"[DDB] {status} {progress}% â€” {step}")
    except Exception as e:
        log.warning(f"[DDB] Failed to update progress: {e}")


def mark_failed(error: str):
    update_progress("FAILED", 0, f"Error: {error}", {"error": error})


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

    log.info(f"[AssemblyAI] Transcribed. Detected language: {transcript.json_response.get('language_code', 'unknown')}")

    # Group words into segments by pauses (>0.45s) or length (>8s)
    words = transcript.words
    if not words:
        return []

    segments = []
    current_seg_words = []
    seg_start = words[0].start / 1000.0

    def push_segment(end_time):
        nonlocal current_seg_words, seg_start
        if not current_seg_words: return
        text = " ".join(w["word"] for w in current_seg_words).strip()
        if text:
            segments.append({
                "id": len(segments),
                "start": seg_start,
                "end": end_time,
                "text": text,
                "words": current_seg_words
            })
        current_seg_words = []

    for i, w in enumerate(words):
        w_start = w.start / 1000.0
        w_end = w.end / 1000.0
        
        # Check gap before this word
        if current_seg_words:
            prev_end = current_seg_words[-1]["end"]
            gap = w_start - prev_end
            dur = w_start - seg_start
            
            # Split if gap is large or segment is getting too long
            if gap > 0.45 or dur > 8.0:
                push_segment(prev_end)
                seg_start = w_start
        
        current_seg_words.append({
            "word": w.text,
            "start": w_start,
            "end": w_end
        })
        
    if current_seg_words:
        push_segment(current_seg_words[-1]["end"])

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

        # Tag each segment with its dominant speaker
        for seg in segments:
            mid = (seg["start"] + seg["end"]) / 2
            speaker = "SPEAKER_00"
            for turn, _, spk in diarization.itertracks(yield_label=True):
                if turn.start <= mid <= turn.end:
                    speaker = spk
                    break
            seg["speaker"] = speaker

        del pipeline
        torch.cuda.empty_cache()
        log.info("[Diarize] Done.")
    except Exception as e:
        log.warning(f"[Diarize] Failed: {e}")
    return segments

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 3: Translation (Gemini dubbing-aware)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

GEMINI_KEYS = [k for k in [GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3] if k]
_gemini_key_idx = 0

def _get_gemini_client():
    global _gemini_key_idx
    from google import genai
    key = GEMINI_KEYS[_gemini_key_idx % len(GEMINI_KEYS)]
    _gemini_key_idx += 1
    return genai.Client(api_key=key)

def _gemini_model_for_mode(mode: str) -> str:
    return {
        "budget":  "gemini-3.1-flash-lite-preview",
        "premium": "gemini-3.1-pro-preview",
    }.get(mode, "gemini-3-flash-preview")


TRANSLATION_SYSTEM_PROMPT = """
You are a professional video dubbing translator. Your task is to translate speech segments for dubbing.

Rules:
1. Translate meaning, emotion, and tone â€” NOT word-for-word literal text.
2. Keep translated segment duration close to the original speaking duration.
3. Match the speaking style (formal, casual, excited, sad, etc.).
4. If the original is short and punchy, keep the translation short and punchy but not changing the meaning of the sentence.
5. Return ONLY valid JSON â€” no markdown, no explanation.

Output format (array of objects):
[
  {
    "id": <segment_id>,
    "translated_text": "<translated text>",
    "emotion": "<neutral|happy|sad|excited|serious|questioning>",
    "speaking_rate": <0.9 to 1.2, where 1.0 is normal speed keep between 0.9 to 1.2>
  }
]
"""

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
        f"Translate the following video segments from the source language to {TARGET_LANG}.\n"
        f"These are dubbing segments â€” preserve emotion, tone, and keep each translation "
        f"close to the original duration segments.\n\n"
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
                # Retry with premium model on failure
                if model != "gemini-3.1-pro-preview":
                    log.info("[Gemini] Retrying with premium model...")
                    model = "gemini-3.1-pro-preview"
                    attempts = 0
                else:
                    raise RuntimeError(f"Translation failed after all retries: {e}")
            time.sleep(2 ** attempts)

    # Merge translations back into segments
    trans_map = {t["id"]: t for t in translations}
    for seg in segments:
        t = trans_map.get(seg["id"], {})
        seg["translated_text"] = t.get("translated_text", seg["text"])
        seg["emotion"] = t.get("emotion", "neutral")
        seg["speaking_rate"] = float(t.get("speaking_rate", 1.0))

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
}


def _ensure_cosyvoice() -> Path:
    """Ensure CosyVoice repo is preloaded in the image."""
    cv_dir = MODEL_CACHE_DIR / "CosyVoice"
    if not cv_dir.exists():
        log.warning(f"CosyVoice repo not found at {cv_dir}. voice cloning disabled.")
        return None
    matcha_dir = cv_dir / "third_party" / "Matcha-TTS" / "matcha"
    if not matcha_dir.exists():
        log.warning(f"CosyVoice Matcha-TTS submodule missing — voice cloning disabled.")
        return None
    return cv_dir


def synthesize_segments_cosyvoice(
    segments: list[dict], reference_audio: Path, out_dir: Path
) -> list[Path]:
    """
    Zero-shot voice cloning via CosyVoice 3.0 (CosyVoice3-0.5B).
    Each segment synthesised with the original speaker's voice in target lang.
    """
    import torch
    import torchaudio

    cv_dir = _ensure_cosyvoice()
    if str(cv_dir) not in sys.path:
        sys.path.insert(0, str(cv_dir))
    matcha_root = cv_dir / "third_party" / "Matcha-TTS"
    if str(matcha_root) not in sys.path:
        sys.path.insert(0, str(matcha_root))

    try:
        from cosyvoice.cli.cosyvoice import CosyVoice2 as _CosyVoice  # type: ignore
    except Exception:
        from cosyvoice.cli.cosyvoice import CosyVoice as _CosyVoice  # type: ignore

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = None
    last_err: Optional[Exception] = None
    for model_id in ("iic/CosyVoice3-0.5B", "iic/CosyVoice2-0.5B"):
        try:
            log.info(f"[CosyVoice] Loading {model_id} on {device}...")
            model = _CosyVoice(model_id, load_jit=False, load_trt=False)
            break
        except Exception as e:
            last_err = e
            log.warning(f"[CosyVoice] Failed loading {model_id}: {e}")
    if model is None:
        raise RuntimeError(f"CosyVoice model load failed: {last_err}")

    # Prepare 16kHz mono reference clip (â‰¤30 s)
    ref_wav, ref_sr = torchaudio.load(str(reference_audio))
    if ref_wav.shape[0] > 1:
        ref_wav = ref_wav.mean(0, keepdim=True)
    if ref_sr != 16000:
        ref_wav = torchaudio.functional.resample(ref_wav, ref_sr, 16000)
    ref_wav = ref_wav[:, : 16000 * 30]  # max 30 s reference

    prompt_text = ""
    for seg in segments:
        source_text = str(seg.get("text", "")).strip()
        if source_text:
            prompt_text = source_text[:200]
            break

    seg_audios: list[Path] = []
    for seg in segments:
        out_path = out_dir / f"seg_{seg['id']:04d}.wav"
        text = seg["translated_text"].strip()
        if not text:
            duration = seg["end"] - seg["start"]
            run_ffmpeg("-f", "lavfi", "-i", f"anullsrc=r=22050:cl=mono",
                       "-t", str(duration), str(out_path))
        else:
            try:
                chunks = list(model.inference_zero_shot(
                    tts_text=text,
                    prompt_text=prompt_text,
                    prompt_speech_16k=ref_wav,
                    stream=False,
                    speed=float(seg.get("speaking_rate", 1.0)),
                ))
                audio_data = torch.cat([c["tts_speech"] for c in chunks], dim=1)
                torchaudio.save(str(out_path), audio_data, 22050)
            except Exception as e:
                raise RuntimeError(
                    f"CosyVoice failed for segment {seg['id']}: {e}"
                ) from e
        seg_audios.append(out_path)
        log.info(f"[CosyVoice] Segment {seg['id']}/{len(segments)} done.")

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

    # Convert mp3 â†’ wav
    wav_path = out_path.with_suffix(".wav")
    run_ffmpeg("-i", str(out_path), "-ar", "24000", "-ac", "1", str(wav_path))
    return wav_path


def synthesize_gtts_single(seg: dict, out_dir: Path) -> Path:
    """gTTS emergency fallback for a single segment."""
    from gtts import gTTS
    out_path = out_dir / f"seg_{seg['id']:04d}_gtts.mp3"
    wav_path = out_path.with_suffix(".wav")
    gTTS(text=seg["translated_text"], lang=TARGET_LANG_CODE).save(str(out_path))
    run_ffmpeg("-i", str(out_path), "-ar", "24000", "-ac", "1", str(wav_path))
    return wav_path
def synthesize_all(segments: list[dict], reference_audio: Path, out_dir: Path) -> list[Path]:
    """Master TTS router: CosyVoice 3.0 -> edge-tts -> gTTS (auto-fallback at every level)."""
    if VOICE_CLONE:
        try:
            return synthesize_segments_cosyvoice(segments, reference_audio, out_dir)
        except Exception as cv_err:
            # AUTO-FALLBACK: Do NOT raise. Log the failure and continue with edge-tts.
            # This ensures the job always completes even if GPU/CosyVoice is unavailable.
            log.warning(
                f"[TTS] CosyVoice failed ({cv_err}). Auto-fallback to edge-tts neural voice."
            )

    # Shared path: edge-tts for all segments, gTTS emergency
    log.info("[TTS] Using edge-tts neural voice (no voice clone).")
    paths = []
    for seg in segments:
        try:
            paths.append(synthesize_edge_tts_single(seg, out_dir))
        except Exception as e:
            log.warning(f"[TTS] edge-tts seg {seg['id']} failed: {e}. Falling back to gTTS.")
            paths.append(synthesize_gtts_single(seg, out_dir))
    return paths


# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stage 5: Timing adapter â€” fit TTS audio to original segment duration
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
# Stage 6: Lip sync (LatentSync 1.6 â†’ MuseTalk fallback)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--prefer-binary",
             "-r", str(ls_dir / "requirements.txt")],
            check=True
        )
        _latentsync_deps_flag.touch()

    # Download checkpoint from HuggingFace if missing
    ckpt_dir = ls_dir / "checkpoints"
    ckpt_dir.mkdir(exist_ok=True)
    ckpt_path = ckpt_dir / "latentsync_unet.pt"
    if not ckpt_path.exists():
        log.info("[LatentSync] Downloading checkpoint from HuggingFace...")
        subprocess.run([
            sys.executable, "-c",
            "from huggingface_hub import hf_hub_download; "
            f"hf_hub_download('ByteDance/LatentSync', 'latentsync_unet.pt', local_dir='{ckpt_dir}')"
        ], check=True)

    result = subprocess.run([
        sys.executable, "scripts/inference.py",
        "--unet_config", "configs/unet/stage2.yaml",
        "--inference_ckpt", str(ckpt_path),
        "--video_path", str(video_path),
        "--audio_path", str(dubbed_audio),
        "--video_out_path", str(out_path),
    ], capture_output=True, text=True, cwd=str(ls_dir))

    if result.returncode != 0:
        raise RuntimeError(f"LatentSync failed:\n{result.stderr[-1500:]}")
    if not out_path.exists():
        raise FileNotFoundError("LatentSync did not produce output file")
    log.info(f"[LatentSync] Done â†’ {out_path}")
    return out_path


def run_lipsync_musetalk(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """MuseTalk â€” fast real-time lip sync (30fps+), used as fallback."""
    musetalk_dir = MODEL_CACHE_DIR / "MuseTalk"

    if not musetalk_dir.exists():
        raise RuntimeError(
            f"MuseTalk repo not found at {musetalk_dir}. "
            "Translator image is missing preloaded model dependencies."
        )

    # Install MuseTalk deps lazily on first run (not in CI build to keep image fast)
    _musetalk_deps_flag = musetalk_dir / ".deps_installed"
    if not _musetalk_deps_flag.exists():
        log.info("[MuseTalk] Installing runtime deps (first run only)...")
        if (musetalk_dir / "requirements.txt").exists():
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--prefer-binary",
                 "-r", str(musetalk_dir / "requirements.txt")],
                check=True
            )
        _musetalk_deps_flag.touch()

    result = subprocess.run([
        sys.executable, "inference.py",
        "--video_path", str(video_path),
        "--audio_path", str(dubbed_audio),
        "--result_dir", str(out_dir),
        "--fps", "25",
    ], capture_output=True, text=True, cwd=str(musetalk_dir))

    if result.returncode != 0:
        raise RuntimeError(f"MuseTalk failed:\n{result.stderr[-1000:]}")

    candidates = list(out_dir.glob("*.mp4"))
    if not candidates:
        raise FileNotFoundError("MuseTalk did not produce output")
    log.info(f"[MuseTalk] Done â†’ {candidates[0]}")
    return candidates[0]


def run_lipsync(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """Lip sync router: LatentSync 1.6 (best) â†’ MuseTalk (fast fallback)."""
    quality = LIP_SYNC_QUALITY
    log.info(f"[LipSync] Requested mode: {quality}")
    errors: list[str] = []

    # LatentSync is default (best quality)
    if quality in ("latentsync", "default"):
        try:
            return run_lipsync_latentsync(video_path, dubbed_audio, out_dir)
        except Exception as e:
            errors.append(f"LatentSync: {e}")
            log.warning(f"[LipSync] LatentSync failed, falling back to MuseTalk: {e}")

    # MuseTalk as fast fallback or explicit choice
    try:
        return run_lipsync_musetalk(video_path, dubbed_audio, out_dir)
    except Exception as e:
        errors.append(f"MuseTalk: {e}")
        warn_msg = "Lip sync failed on all backends: " + " | ".join(errors)
        log.warning(f"[LipSync] {warn_msg}")
        # AUTO-FALLBACK: Do NOT raise — continue with the dubbed-audio video
        # (no mouth movement) so the translation still completes successfully.
        update_progress(
            "LIPSYNC", 82,
            f"⚠️ Lip sync unavailable (model deps issue) — continuing without lip sync. Video will have dubbed audio only.",
            {"lipsync_warning": warn_msg}
        )
        # Return the original (non-lip-synced) video so the rest of the pipeline continues
        return video_path

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        start_sample = max(0, int(seg["start"] * SR))
        end_sample = start_sample + len(data)
        if end_sample > len(mixed):
            mixed = np.pad(mixed, (0, end_sample - len(mixed)))
        mixed[start_sample:end_sample] += data

    # Normalize dubbed audio
    peak = np.abs(mixed).max()
    if peak > 0:
        mixed = mixed / peak * 0.9

    dubbed_path = out_dir / "dubbed_voice.wav"
    sf.write(str(dubbed_path), mixed, SR)

    # Mix with background music if Demucs was used
    if background_audio and background_audio.exists():
        log.info("[Assemble] Mixing with background audio...")
        final_mix = out_dir / "dubbed_final_mix.wav"
        run_ffmpeg(
            "-i", str(dubbed_path),
            "-i", str(background_audio),
            "-filter_complex",
            "[0]volume=1.0[v];[1]volume=0.4[b];[v][b]amix=inputs=2:duration=first:dropout_transition=0[out]",
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
):
    """Combine original video stream with new dubbed audio."""
    run_ffmpeg(
        "-i", str(video_path),
        "-i", str(audio_path),
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        str(out_path),
    )
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

        log.info(f"Transcription: {len(segments)} segments")

        # â”€â”€ 6. Translation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("TRANSLATING", 35, f"Translating to {TARGET_LANG}...")
        segments = translate_segments(segments)
        update_progress("TRANSLATING", 48, f"Translation complete. Generating voice...")

        # â”€â”€ 7. Voice synthesis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        voice_message = "Cloning original voice..." if VOICE_CLONE else "Generating neural voice..."
        update_progress("CLONING", 52, voice_message)
        seg_dir = work_dir / "segments"
        seg_dir.mkdir()
        seg_audio_paths = synthesize_all(segments, transcription_audio, seg_dir)

        # â”€â”€ 7b. Timing fit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("CLONING", 60, "Fitting audio timing to video...")
        fitted_paths = []
        for seg, audio_path in zip(segments, seg_audio_paths):
            target_dur = seg["end"] - seg["start"]
            fitted = fit_audio_to_duration(audio_path, target_dur, seg_dir)
            fitted_paths.append(fitted)

        # â”€â”€ 8. Assemble dubbed audio track â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("CLONING", 65, "Assembling dubbed audio track...")
        dubbed_audio = assemble_dubbed_audio(
            segments, fitted_paths, video_duration, work_dir, background_audio
        )

        # â”€â”€ 9. Lip sync (optional) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        final_video_path = work_dir / "output.mp4"

        if LIP_SYNC:
            update_progress("LIPSYNC", 70, f"Running lip sync ({LIP_SYNC_QUALITY})...")
            lip_dir = work_dir / "lipsync"
            lip_dir.mkdir()
            lipsync_video = run_lipsync(video_path, dubbed_audio, lip_dir)
            # Lipsync output has its own audio baked in, just copy
            shutil.copy(lipsync_video, final_video_path)
            update_progress("LIPSYNC", 82, "Lip sync complete.")
        else:
            update_progress("MERGING", 78, "Merging video and dubbed audio...")
            mux_final_video(video_path, dubbed_audio, final_video_path)

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
            "lipSync": LIP_SYNC,
            "lipSyncApplied": LIP_SYNC,
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
