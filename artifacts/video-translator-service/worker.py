"""
AWS Batch GPU Worker — Video Translator
=======================================
One-shot CLI script. Invoked by AWS Batch as:
    CMD ["python", "worker.py"]

All job config arrives via environment variables injected by the Batch job definition.

Pipeline:
  1. Download source video from S3
  2. Extract audio (FFmpeg)
  3. Optional: Demucs vocal/background separation
  4. Transcribe (faster-whisper large-v3-turbo / large-v3 + WhisperX)
  5. Optional: pyannote speaker diarization
  6. Translate segments (Gemini 3 Flash dubbing-aware)
  7. Voice clone (XTTS v2 → edge-tts fallback → gTTS emergency)
  8. Lip sync (MuseTalk default → LatentSync premium → Wav2Lip fallback)
  9. Audio mix + normalize
 10. FFmpeg final mux
 11. Upload MP4 + SRT + transcript JSON to S3
 12. Update DynamoDB → DONE
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

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("translator-worker")

# ── Environment config ────────────────────────────────────────────────────────
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
PREMIUM_ASR         = os.environ.get("PREMIUM_ASR", "false").lower() == "true"
MULTI_SPEAKER       = os.environ.get("MULTI_SPEAKER", "false").lower() == "true"
LIP_SYNC_QUALITY    = os.environ.get("LIP_SYNC_QUALITY", "musetalk")  # musetalk | latentsync | wav2lip
ASR_MODEL           = os.environ.get("ASR_MODEL", "large-v3-turbo")   # large-v3-turbo | large-v3
TRANSLATION_MODE    = os.environ.get("TRANSLATION_MODE", "default")   # default | budget | premium

MODEL_CACHE_DIR     = Path(os.environ.get("MODEL_CACHE_DIR", "/model-cache"))

# ── AWS Clients ───────────────────────────────────────────────────────────────
s3 = boto3.client("s3", region_name=DYNAMODB_REGION)
ddb = boto3.resource("dynamodb", region_name=DYNAMODB_REGION)
table = ddb.Table(DYNAMODB_TABLE)


# ─────────────────────────────────────────────────────────────────────────────
# DynamoDB progress helpers
# ─────────────────────────────────────────────────────────────────────────────

def update_progress(status: str, progress: int, step: str, extra: dict = {}):
    """Write progress to DynamoDB so the frontend can poll it."""
    try:
        item = {
            "status": status,
            "progress": progress,
            "step": step,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
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
        log.info(f"[DDB] {status} {progress}% — {step}")
    except Exception as e:
        log.warning(f"[DDB] Failed to update progress: {e}")


def mark_failed(error: str):
    update_progress("FAILED", 0, f"Error: {error}", {"error": error})


# ─────────────────────────────────────────────────────────────────────────────
# S3 helpers
# ─────────────────────────────────────────────────────────────────────────────

def download_from_s3(key: str, dest: Path) -> Path:
    log.info(f"[S3] Downloading s3://{S3_BUCKET}/{key} → {dest}")
    s3.download_file(S3_BUCKET, key, str(dest))
    return dest


def upload_to_s3(local_path: Path, key: str, content_type: str = "application/octet-stream"):
    log.info(f"[S3] Uploading {local_path} → s3://{S3_BUCKET}/{key}")
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


# ─────────────────────────────────────────────────────────────────────────────
# FFmpeg helpers
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Demucs vocal separation (optional)
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Transcription (faster-whisper + optional WhisperX)
# ─────────────────────────────────────────────────────────────────────────────

def transcribe(audio_path: Path) -> list[dict]:
    """
    Transcribe audio to word-level timestamped segments.
    Returns list of: { id, start, end, text, words: [{word, start, end}] }
    """
    import torch
    from faster_whisper import WhisperModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    model_name = ASR_MODEL  # e.g. "large-v3-turbo" or "large-v3"
    cache = str(MODEL_CACHE_DIR / "whisper")

    log.info(f"[Whisper] Loading {model_name} on {device}...")
    model = WhisperModel(model_name, device=device, compute_type=compute_type,
                         download_root=cache)

    lang = None if SOURCE_LANG == "auto" else SOURCE_LANG
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=lang,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        beam_size=5,
    )

    segments = []
    for i, seg in enumerate(segments_iter):
        words = []
        if seg.words:
            words = [{"word": w.word, "start": w.start, "end": w.end} for w in seg.words]
        segments.append({
            "id": i,
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
            "words": words,
        })

    log.info(f"[Whisper] Transcribed {len(segments)} segments. Language: {info.language}")

    del model
    torch.cuda.empty_cache()

    # Optional: WhisperX forced alignment for tighter timing
    if PREMIUM_ASR and len(segments) > 0:
        segments = whisperx_align(segments, audio_path, info.language)

    return segments


def whisperx_align(segments: list[dict], audio_path: Path, language: str) -> list[dict]:
    """WhisperX forced alignment for more precise word timestamps."""
    try:
        import torch
        import whisperx

        device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info(f"[WhisperX] Aligning {len(segments)} segments...")
        align_model, metadata = whisperx.load_align_model(language_code=language, device=device)

        # Convert to WhisperX format
        wx_segments = [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in segments]
        import soundfile as sf
        audio_arr, sr = sf.read(str(audio_path))
        result = whisperx.align(wx_segments, align_model, metadata, audio_arr, device)

        aligned = result.get("segments", segments)
        log.info(f"[WhisperX] Alignment complete.")
        del align_model
        torch.cuda.empty_cache()
        return aligned
    except Exception as e:
        log.warning(f"[WhisperX] Alignment failed, using raw Whisper: {e}")
        return segments


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2b: Optional speaker diarization (pyannote)
# ─────────────────────────────────────────────────────────────────────────────

def diarize(audio_path: Path, segments: list[dict]) -> list[dict]:
    """
    Tag each segment with a speaker label using pyannote 3.1.
    Requires HF_TOKEN env var for gated model access.
    """
    try:
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

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Translation (Gemini dubbing-aware)
# ─────────────────────────────────────────────────────────────────────────────

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
1. Translate meaning, emotion, and tone — NOT word-for-word literal text.
2. Keep translated segment duration close to the original speaking duration.
3. Match the speaking style (formal, casual, excited, sad, etc.).
4. If the original is short and punchy, keep the translation short and punchy.
5. Return ONLY valid JSON — no markdown, no explanation.

Output format (array of objects):
[
  {
    "id": <segment_id>,
    "translated_text": "<translated text>",
    "emotion": "<neutral|happy|sad|excited|serious|questioning>",
    "speaking_rate": <0.8 to 1.3, where 1.0 is normal speed>
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
        f"These are dubbing segments — preserve emotion, tone, and keep each translation "
        f"close to the original duration.\n\n"
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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: Voice Cloning (XTTS v2 → edge-tts → gTTS)
# ─────────────────────────────────────────────────────────────────────────────

LANG_TO_XTTS = {
    "hi": "hi", "en": "en", "es": "es", "fr": "fr", "de": "de",
    "it": "it", "pt": "pt", "pl": "pl", "tr": "tr", "ru": "ru",
    "nl": "nl", "cs": "cs", "ar": "ar", "zh-cn": "zh-cn", "ja": "ja",
    "ko": "ko", "hu": "hu",
}

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


def synthesize_segments_xtts(segments: list[dict], reference_audio: Path, out_dir: Path) -> list[Path]:
    """
    Clone voice for each segment using XTTS v2.
    Returns list of per-segment audio file paths.
    """
    os.environ.setdefault("COQUI_TOS_AGREED", "1")
    import torch
    from TTS.api import TTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    xtts_lang = LANG_TO_XTTS.get(TARGET_LANG_CODE, "en")
    cache = str(MODEL_CACHE_DIR / "tts")

    log.info(f"[XTTS] Loading XTTS v2 on {device} for lang={xtts_lang}...")
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False).to(device)

    seg_audios = []
    for seg in segments:
        out_path = out_dir / f"seg_{seg['id']:04d}.wav"
        text = seg["translated_text"].strip()
        if not text:
            # Create silence for empty segment
            duration = seg["end"] - seg["start"]
            run_ffmpeg(
                "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono",
                "-t", str(duration), str(out_path)
            )
        else:
            try:
                tts.tts_to_file(
                    text=text,
                    file_path=str(out_path),
                    speaker_wav=str(reference_audio),
                    language=xtts_lang,
                    speed=seg.get("speaking_rate", 1.0),
                )
            except Exception as e:
                raise RuntimeError(f"XTTS failed for segment {seg['id']}: {e}") from e
        seg_audios.append(out_path)
        log.info(f"[XTTS] Segment {seg['id']}/{len(segments)} done.")

    del tts
    torch.cuda.empty_cache()
    log.info("[XTTS] Voice cloning complete.")
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
    gTTS(text=seg["translated_text"], lang=TARGET_LANG_CODE).save(str(out_path))
    run_ffmpeg("-i", str(out_path), "-ar", "24000", "-ac", "1", str(wav_path))
    return wav_path


def synthesize_all(segments: list[dict], reference_audio: Path, out_dir: Path) -> list[Path]:
    """Master TTS router: XTTS v2 → edge-tts → gTTS."""
    if VOICE_CLONE:
        try:
            return synthesize_segments_xtts(segments, reference_audio, out_dir)
        except Exception as e:
            raise RuntimeError(
                "Voice cloning was requested but XTTS failed. "
                "The job was stopped so it does not return the wrong voice."
            ) from e

    # edge-tts for all
    log.info("[TTS] Using edge-tts for all segments.")
    paths = []
    for seg in segments:
        try:
            paths.append(synthesize_edge_tts_single(seg, out_dir))
        except Exception as e:
            log.warning(f"[TTS] edge-tts seg {seg['id']} failed: {e}. gTTS fallback.")
            paths.append(synthesize_gtts_single(seg, out_dir))
    return paths


# ─────────────────────────────────────────────────────────────────────────────
# Stage 5: Timing adapter — fit TTS audio to original segment duration
# ─────────────────────────────────────────────────────────────────────────────

def fit_audio_to_duration(audio_path: Path, target_duration: float, out_dir: Path) -> Path:
    """
    Speed-up or slow-down audio to match target_duration.
    Uses FFmpeg atempo filter (0.5x – 2.0x range, chained for extremes).
    """
    import soundfile as sf
    data, sr = sf.read(str(audio_path))
    actual_dur = len(data) / sr

    if abs(actual_dur - target_duration) < 0.1:
        return audio_path  # close enough, no change needed

    ratio = actual_dur / max(target_duration, 0.1)
    ratio = max(0.5, min(2.0, ratio))  # clamp to safe range

    out_path = audio_path.with_stem(audio_path.stem + "_fitted")

    # Chain atempo filters for values outside 0.5–2.0
    if ratio > 2.0:
        tempo_filters = "atempo=2.0,atempo=" + str(round(ratio / 2.0, 3))
    elif ratio < 0.5:
        tempo_filters = "atempo=0.5,atempo=" + str(round(ratio / 0.5, 3))
    else:
        tempo_filters = f"atempo={round(ratio, 3)}"

    run_ffmpeg("-i", str(audio_path), "-filter:a", tempo_filters, str(out_path))
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
# Stage 6: Lip sync (MuseTalk → LatentSync → Wav2Lip)
# ─────────────────────────────────────────────────────────────────────────────

def run_lipsync_musetalk(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """MuseTalk lip sync — default quality."""
    try:
        import torch
        out_path = out_dir / "lipsync_output.mp4"

        musetalk_dir = MODEL_CACHE_DIR / "musetalk"
        if not musetalk_dir.exists():
            log.info("[MuseTalk] Cloning MuseTalk repo...")
            subprocess.run([
                "git", "clone", "https://github.com/TMElyralab/MuseTalk",
                str(musetalk_dir)
            ], check=True)

        result = subprocess.run([
            sys.executable, "-m", "musetalk.inference",
            "--video_path", str(video_path),
            "--audio_path", str(dubbed_audio),
            "--result_dir", str(out_dir),
            "--fps", "25",
        ], capture_output=True, text=True, cwd=str(musetalk_dir))

        if result.returncode != 0:
            raise RuntimeError(f"MuseTalk failed: {result.stderr[-1000:]}")

        # MuseTalk writes to result_dir/input_video_name.mp4
        candidates = list(out_dir.glob("*.mp4"))
        if candidates:
            return candidates[0]
        raise FileNotFoundError("MuseTalk did not produce output")

    except Exception as e:
        log.warning(f"[MuseTalk] Failed: {e}. Trying LatentSync or Wav2Lip fallback.")
        raise


def run_lipsync_latentsync(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """LatentSync 1.6 lip sync — premium quality."""
    try:
        out_path = out_dir / "latentsync_output.mp4"
        ls_dir = MODEL_CACHE_DIR / "latentsync"
        if not ls_dir.exists():
            subprocess.run([
                "git", "clone", "https://github.com/bytedance/LatentSync",
                str(ls_dir)
            ], check=True)

        result = subprocess.run([
            sys.executable, "inference.py",
            "--video_path", str(video_path),
            "--audio_path", str(dubbed_audio),
            "--output_path", str(out_path),
        ], capture_output=True, text=True, cwd=str(ls_dir))

        if result.returncode != 0:
            raise RuntimeError(f"LatentSync failed: {result.stderr[-1000:]}")
        return out_path
    except Exception as e:
        log.warning(f"[LatentSync] Failed: {e}. Falling back to Wav2Lip.")
        raise


def run_lipsync_wav2lip(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """Wav2Lip GAN lip sync — legacy fallback."""
    out_path = out_dir / "wav2lip_output.mp4"
    wav2lip_dir = MODEL_CACHE_DIR / "Wav2Lip"
    checkpoint = MODEL_CACHE_DIR / "wav2lip_gan.pth"

    if not wav2lip_dir.exists():
        subprocess.run([
            "git", "clone", "https://github.com/Rudrabha/Wav2Lip", str(wav2lip_dir)
        ], check=True)
    audio_py = wav2lip_dir / "audio.py"
    if audio_py.exists():
        text = audio_py.read_text(encoding="utf-8")
        patched = text.replace(
            "librosa.filters.mel(hp.sample_rate, hp.n_fft, n_mels=hp.num_mels,",
            "librosa.filters.mel(sr=hp.sample_rate, n_fft=hp.n_fft, n_mels=hp.num_mels,",
        )
        if patched != text:
            audio_py.write_text(patched, encoding="utf-8")
    if not checkpoint.exists():
        import urllib.request
        log.info("[Wav2Lip] Downloading GAN checkpoint...")
        urllib.request.urlretrieve(
            "https://huggingface.co/camenduru/Wav2Lip/resolve/main/checkpoints/wav2lip_gan.pth",
            str(checkpoint)
        )

    result = subprocess.run([
        sys.executable, "inference.py",
        "--checkpoint_path", str(checkpoint),
        "--face", str(video_path),
        "--audio", str(dubbed_audio),
        "--outfile", str(out_path),
        "--pads", "0", "20", "0", "0",
        "--resize_factor", "1",
    ], capture_output=True, text=True, cwd=str(wav2lip_dir))

    if result.returncode != 0:
        raise RuntimeError(f"Wav2Lip failed: {result.stderr[-1000:]}")
    return out_path


def run_lipsync(video_path: Path, dubbed_audio: Path, out_dir: Path) -> Path:
    """Lip sync router: MuseTalk → LatentSync → Wav2Lip."""
    quality = LIP_SYNC_QUALITY
    log.info(f"[LipSync] Using mode: {quality}")
    errors: list[str] = []

    if quality == "latentsync":
        try:
            return run_lipsync_latentsync(video_path, dubbed_audio, out_dir)
        except Exception as e:
            errors.append(f"LatentSync: {e}")
        try:
            return run_lipsync_musetalk(video_path, dubbed_audio, out_dir)
        except Exception as e:
            errors.append(f"MuseTalk: {e}")
    elif quality in ("musetalk", "default"):
        try:
            return run_lipsync_musetalk(video_path, dubbed_audio, out_dir)
        except Exception as e:
            errors.append(f"MuseTalk: {e}")

    # Final fallback: Wav2Lip
    try:
        return run_lipsync_wav2lip(video_path, dubbed_audio, out_dir)
    except Exception as e:
        errors.append(f"Wav2Lip: {e}")
        raise RuntimeError("Lip sync was requested but no backend produced output. " + " | ".join(errors)) from e

# ─────────────────────────────────────────────────────────────────────────────
# Stage 7: Assemble per-segment audio into one dubbed audio track
# ─────────────────────────────────────────────────────────────────────────────

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
    total_samples = int(math.ceil(video_duration * SR))
    mixed = np.zeros(total_samples, dtype=np.float32)

    for seg, audio_path in zip(segments, seg_audio_paths):
        if not audio_path.exists():
            log.warning(f"[Assemble] Missing audio for segment {seg['id']}")
            continue

        data, sr = sf.read(str(audio_path))
        if data.ndim > 1:
            data = data.mean(axis=1)  # stereo → mono

        # Resample if needed
        if sr != SR:
            import librosa
            data = librosa.resample(data, orig_sr=sr, target_sr=SR)

        start_sample = int(seg["start"] * SR)
        end_sample = min(start_sample + len(data), total_samples)
        actual_len = end_sample - start_sample
        mixed[start_sample:end_sample] += data[:actual_len]

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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 8: Generate SRT subtitle file
# ─────────────────────────────────────────────────────────────────────────────

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
    log.info(f"[SRT] Written {idx - 1} subtitle entries → {out_path}")


# ─────────────────────────────────────────────────────────────────────────────
# Stage 9: Final video mux (video + dubbed audio)
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 10: Generate transcript JSON
# ─────────────────────────────────────────────────────────────────────────────

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
    log.info(f"[Transcript] Written → {out_path}")


# ─────────────────────────────────────────────────────────────────────────────
# Main entrypoint
# ─────────────────────────────────────────────────────────────────────────────

def main():
    log.info(f"=== Translator Worker starting. JobId={JOB_ID} ===")
    log.info(f"Target: {TARGET_LANG} ({TARGET_LANG_CODE}), LipSync={LIP_SYNC}, VoiceClone={VOICE_CLONE}")

    work_dir = Path(tempfile.mkdtemp(prefix=f"translator_{JOB_ID}_"))
    log.info(f"Working directory: {work_dir}")

    try:
        # ── 1. Download video from S3 ─────────────────────────────────────
        update_progress("STARTING", 3, "Downloading video from cloud...")
        input_ext = Path(S3_INPUT_KEY).suffix or ".mp4"
        video_path = work_dir / f"input{input_ext}"
        download_from_s3(S3_INPUT_KEY, video_path)

        video_duration = get_video_duration(video_path)
        log.info(f"Video duration: {video_duration:.1f}s")

        # ── 2. Extract audio ──────────────────────────────────────────────
        update_progress("EXTRACTING", 8, "Extracting audio...")
        full_audio = extract_audio(video_path, work_dir)

        # ── 3. Optional Demucs ────────────────────────────────────────────
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

        # ── 4. Transcription ──────────────────────────────────────────────
        update_progress("TRANSCRIBING", 18, f"Transcribing speech ({ASR_MODEL})...")
        segments = transcribe(transcription_audio)

        if not segments:
            raise RuntimeError("No speech detected in the video.")

        # ── 5. Optional Diarization ───────────────────────────────────────
        if MULTI_SPEAKER:
            update_progress("TRANSCRIBING", 28, "Identifying speakers...")
            segments = diarize(transcription_audio, segments)

        log.info(f"Transcription: {len(segments)} segments")

        # ── 6. Translation ────────────────────────────────────────────────
        update_progress("TRANSLATING", 35, f"Translating to {TARGET_LANG}...")
        segments = translate_segments(segments)
        update_progress("TRANSLATING", 48, f"Translation complete. Generating voice...")

        # ── 7. Voice synthesis ────────────────────────────────────────────
        voice_message = "Cloning original voice..." if VOICE_CLONE else "Generating neural voice..."
        update_progress("CLONING", 52, voice_message)
        seg_dir = work_dir / "segments"
        seg_dir.mkdir()
        seg_audio_paths = synthesize_all(segments, transcription_audio, seg_dir)

        # ── 7b. Timing fit ────────────────────────────────────────────────
        update_progress("CLONING", 60, "Fitting audio timing to video...")
        fitted_paths = []
        for seg, audio_path in zip(segments, seg_audio_paths):
            target_dur = seg["end"] - seg["start"]
            fitted = fit_audio_to_duration(audio_path, target_dur, seg_dir)
            fitted_paths.append(fitted)

        # ── 8. Assemble dubbed audio track ────────────────────────────────
        update_progress("CLONING", 65, "Assembling dubbed audio track...")
        dubbed_audio = assemble_dubbed_audio(
            segments, fitted_paths, video_duration, work_dir, background_audio
        )

        # ── 9. Lip sync (optional) ────────────────────────────────────────
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

        # ── 10. Generate SRT and transcript ──────────────────────────────
        update_progress("MERGING", 88, "Generating subtitles...")
        srt_path = work_dir / "subtitles.srt"
        transcript_path = work_dir / "transcript.json"
        generate_srt(segments, srt_path)
        generate_transcript_json(segments, transcript_path)

        # ── 11. Upload to S3 ──────────────────────────────────────────────
        update_progress("UPLOADING", 93, "Uploading translated video to cloud...")
        output_key  = f"{S3_OUTPUT_PREFIX}/output.mp4"
        srt_key     = f"{S3_OUTPUT_PREFIX}/subtitles.srt"
        json_key    = f"{S3_OUTPUT_PREFIX}/transcript.json"

        upload_to_s3(final_video_path, output_key, "video/mp4")
        upload_to_s3(srt_path, srt_key, "text/plain")
        upload_to_s3(transcript_path, json_key, "application/json")

        # ── 12. Mark complete ─────────────────────────────────────────────
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
