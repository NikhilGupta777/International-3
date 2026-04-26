"""
Video Translation Service — GPU-upgraded backend
Pipeline:
  1. Audio Extraction   (FFmpeg)
  2. Transcription      (faster-whisper large-v3 on GPU — word-level timestamps)
  3. Translation        (Gemini 2.5 Flash — best dubbing quality)
  4. Voice Cloning      (Coqui XTTS v2 on GPU → edge-tts neural → gTTS fallback)
  5. Lip Sync           (Wav2Lip GAN on GPU, optional)
  6. Video Merge        (FFmpeg)
"""

import os, re, uuid, time, asyncio, subprocess, json, base64, math, copy
import logging, threading, unicodedata
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone

# ── Transformer compat shims (same as original) ──────────────────────────────
try:
    import transformers as _t
    if not hasattr(_t, "BeamSearchScorer"):
        from transformers.generation.beam_search import BeamSearchScorer as _B
        _t.BeamSearchScorer = _B
except Exception:
    pass

try:
    from TTS.tts.layers.xtts import gpt_inference as _g
    from transformers.generation import GenerationMixin as _GM
    if _GM not in _g.GPT2InferenceModel.__bases__:
        _g.GPT2InferenceModel.__bases__ = (_g.GPT2InferenceModel.__bases__[0], _GM)
except Exception:
    pass

try:
    import torchaudio as _ta, soundfile as _sf, torch as _tp
    _orig_load = _ta.load
    def _sf_load(fp, *a, **kw):
        try: return _orig_load(fp, *a, **kw)
        except Exception:
            d, sr = _sf.read(str(fp), dtype="float32", always_2d=True)
            return _tp.from_numpy(d.T), sr
    _ta.load = _sf_load
except Exception:
    pass

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import aiofiles

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR   = Path(__file__).parent
UPLOADS    = BASE_DIR / "uploads"
OUTPUTS    = BASE_DIR / "outputs"
TEMP       = BASE_DIR / "temp"
MODEL_CACHE = Path(os.environ.get("MODEL_CACHE_DIR", "/model-cache"))

for d in [UPLOADS, OUTPUTS, TEMP]:
    d.mkdir(exist_ok=True)

JOBS: dict[str, dict] = {}

# ── Environment ───────────────────────────────────────────────────────────────
GEMINI_API_KEY    = os.environ.get("GEMINI_API_KEY", "")
ASSEMBLYAI_KEY    = os.environ.get("ASSEMBLYAI_API_KEY", "")
PIPELINE_SEM      = int(os.environ.get("PIPELINE_CONCURRENCY", "1"))
GC_TTL_HOURS      = int(os.environ.get("GC_FILE_TTL_HOURS", "24"))
AMBIENT_MIX_DB    = float(os.environ.get("AMBIENT_MIX_DB", "-24"))
PRESERVE_AMBIENT  = os.environ.get("PRESERVE_ORIGINAL_AMBIENT", "false").lower() in ("1","true","yes")
WHISPER_MODEL     = os.environ.get("WHISPER_MODEL", "large-v3")
USE_GPU           = os.environ.get("USE_GPU", "auto")   # auto|true|false

_pipeline_semaphore: Optional[asyncio.Semaphore] = None

GEMINI_MODEL = "gemini-2.5-flash"

# ── Language tables ───────────────────────────────────────────────────────────
LANG_NAMES = {
    "auto":"Auto","en":"English","es":"Spanish","fr":"French","de":"German",
    "pt":"Portuguese","it":"Italian","ja":"Japanese","ko":"Korean",
    "zh":"Chinese (Mandarin)","ar":"Arabic","ru":"Russian","hi":"Hindi",
    "nl":"Dutch","pl":"Polish","tr":"Turkish","uk":"Ukrainian","vi":"Vietnamese",
    "id":"Indonesian","fil":"Filipino","fi":"Finnish",
}
SUPPORTED_LANGS        = set(LANG_NAMES)
SUPPORTED_TARGET_LANGS = {c for c in SUPPORTED_LANGS if c != "auto"}

GTTS_LANG_MAP = {"zh": "zh-CN"}

# ── Timing constants ──────────────────────────────────────────────────────────
JOB_TIMEOUT_MS        = 30 * 60 * 1000
MIN_STRETCH           = 0.5
MAX_STRETCH           = 2.0
NEAR_LOW, NEAR_HIGH   = 0.90, 1.10
DUR_TOL               = 0.03

# ── Pipeline step template ────────────────────────────────────────────────────
STEPS_DEFAULT = [
    {"name":"audio_extraction","label":"Audio Extraction","status":"pending","progress":None,"message":None,"startedAt":None,"completedAt":None},
    {"name":"transcription",   "label":"Transcription",   "status":"pending","progress":None,"message":None,"startedAt":None,"completedAt":None},
    {"name":"translation",     "label":"Translation",     "status":"pending","progress":None,"message":None,"startedAt":None,"completedAt":None},
    {"name":"voice_generation","label":"Voice Cloning",   "status":"pending","progress":None,"message":None,"startedAt":None,"completedAt":None},
    {"name":"lip_sync",        "label":"Lip Sync",        "status":"pending","progress":None,"message":None,"startedAt":None,"completedAt":None},
    {"name":"video_merge",     "label":"Video Merge",     "status":"pending","progress":None,"message":None,"startedAt":None,"completedAt":None},
]

# ── Model state ───────────────────────────────────────────────────────────────
_whisper_model        = None
_whisper_status: str  = "warming_up"
_whisper_lock         = threading.Lock()

_xtts_model           = None
_xtts_status: str     = "warming_up"
_xtts_available       = None
_xtts_load_lock       = threading.Lock()
_xtts_latents_lock    = threading.Lock()
_xtts_speaker_cache: dict = {}

_wav2lip_status: str  = "warming_up"
_wav2lip_script       = None
_wav2lip_ckpt         = None
WAV2LIP_DIR           = BASE_DIR / "wav2lip"
WAV2LIP_CKPT_URL      = "https://github.com/justinjohn0306/Wav2Lip/releases/download/models/wav2lip_gan.pth"

# ── FastAPI ───────────────────────────────────────────────────────────────────
app = FastAPI(title="Video Translator API", version="3.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

# ── Helpers ───────────────────────────────────────────────────────────────────
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def update_step(job: dict, name: str, **kw):
    for s in job["steps"]:
        if s["name"] == name:
            s.update(kw); return

def compute_progress(job: dict) -> float:
    W = {"audio_extraction":5,"transcription":25,"translation":20,
         "voice_generation":35,"lip_sync":5,"video_merge":10}
    total = achieved = 0
    for s in job["steps"]:
        w = W.get(s["name"], 10)
        if s["status"] in ("skipped","completed"): achieved += w
        elif s["status"] == "running": achieved += w * ((s.get("progress") or 0) / 100)
        total += w
    return round(achieved / total * 100, 1) if total else 0.0

def run_ffmpeg(*args, timeout=600) -> tuple[bool, str]:
    try:
        r = subprocess.run(["ffmpeg","-y"]+list(args), capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stderr
    except subprocess.TimeoutExpired: return False, "FFmpeg timed out"
    except FileNotFoundError: return False, "FFmpeg not found"

def get_duration(path: Path) -> Optional[float]:
    try:
        r = subprocess.run(["ffprobe","-v","quiet","-print_format","json","-show_format",str(path)],
                           capture_output=True, text=True, timeout=30)
        return float(json.loads(r.stdout)["format"]["duration"])
    except Exception: return None

_dur_cache: dict = {}
_dur_lock = threading.Lock()

def get_audio_dur(path: Path) -> Optional[float]:
    key = str(path)
    with _dur_lock:
        c = _dur_cache.get(key)
    if c: return c
    try:
        import soundfile as sf
        info = sf.info(str(path))
        if info.samplerate > 0:
            dur = float(info.frames) / float(info.samplerate)
            with _dur_lock: _dur_cache[key] = dur
            return dur
    except Exception: pass
    dur = get_duration(path)
    if dur:
        with _dur_lock: _dur_cache[key] = dur
    return dur

def _safe_name(original: Optional[str], job_id: str) -> str:
    name = (original or "").strip()
    if not name: return f"translated_{job_id}.mp4"
    name = unicodedata.normalize("NFKD", name).encode("ascii","ignore").decode("ascii")
    name = re.sub(r'[\r\n\t"\\/:*?<>|\x00-\x1f]', "", name).strip()
    return f"translated_{name or job_id}.mp4"

# --------------------------- Startup warmup ----------------------------------

def _detect_gpu() -> bool:
    if USE_GPU == "true": return True
    if USE_GPU == "false": return False
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False

HAS_GPU = _detect_gpu()

def _warmup_whisper():
    global _whisper_model, _whisper_status
    try:
        from faster_whisper import WhisperModel
        device   = "cuda" if HAS_GPU else "cpu"
        compute  = "float16" if HAS_GPU else "int8"
        cache    = str(MODEL_CACHE / "whisper")
        logger.info(f"[startup] Loading faster-whisper {WHISPER_MODEL} on {device}...")
        _whisper_model  = WhisperModel(WHISPER_MODEL, device=device,
                                       compute_type=compute, download_root=cache)
        _whisper_status = "ready"
        logger.info("[startup] faster-whisper ready")
    except Exception as e:
        logger.warning(f"[startup] faster-whisper failed: {e}")
        _whisper_status = "unavailable"

def _warmup_xtts():
    global _xtts_status
    logger.info("[startup] Pre-warming XTTS v2...")
    _load_xtts()
    logger.info(f"[startup] XTTS status: {_xtts_status}")

def _warmup_wav2lip():
    global _wav2lip_status, _wav2lip_script, _wav2lip_ckpt
    import urllib.request, shutil
    script = WAV2LIP_DIR / "inference.py"
    ckpt   = WAV2LIP_DIR / "checkpoints" / "wav2lip_gan.pth"
    try:
        if not script.exists():
            subprocess.run(["git","clone","--depth=1",
                "https://github.com/Rudrabha/Wav2Lip.git", str(WAV2LIP_DIR)],
                timeout=180, check=True, capture_output=True)
        if not ckpt.exists():
            ckpt.parent.mkdir(parents=True, exist_ok=True)
            tmp = ckpt.with_suffix(".tmp")
            with urllib.request.urlopen(WAV2LIP_CKPT_URL, timeout=300) as r, open(tmp,"wb") as f:
                shutil.copyfileobj(r, f)
            tmp.rename(ckpt)
        if script.exists() and ckpt.exists():
            _wav2lip_script = script
            _wav2lip_ckpt   = ckpt
            _wav2lip_status = "ready"
            logger.info("[startup] Wav2Lip ready")
        else:
            _wav2lip_status = "unavailable"
    except Exception as e:
        logger.warning(f"[startup] Wav2Lip setup failed: {e}")
        _wav2lip_status = "unavailable"

def _gc_old_files():
    cutoff = time.time() - GC_TTL_HOURS * 3600
    for d in (UPLOADS, OUTPUTS, TEMP):
        for p in d.iterdir():
            try:
                if p.is_file() and p.stat().st_mtime < cutoff: p.unlink()
            except Exception: pass

@app.on_event("startup")
async def on_startup():
    global _pipeline_semaphore
    _pipeline_semaphore = asyncio.Semaphore(PIPELINE_SEM)
    _gc_old_files()
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, lambda: [
        threading.Thread(target=_warmup_whisper, daemon=True).start(),
        threading.Thread(target=_warmup_xtts,    daemon=True).start(),
        threading.Thread(target=_warmup_wav2lip, daemon=True).start(),
    ])
    logger.info("[startup] Model warmup kicked off � server ready")

# --------------------------- SRT helpers -------------------------------------

_SRT_ARROW = re.compile(r"^\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*$")

def _t2s(t: str) -> float:
    t = t.strip().replace(",",".")
    parts = t.split(":")
    h,m,s = (parts+["0","0"])[:3] if len(parts)==3 else (["0"]+parts)[:3]
    return int(h)*3600 + int(m)*60 + float(s)

def _s2t(t: float) -> str:
    if t < 0: t = 0.0
    h = int(t//3600); m = int((t%3600)//60); s = int(t%60)
    ms = int(round((t-int(t))*1000))
    if ms == 1000: s += 1; ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def parse_srt(text: str) -> list[dict]:
    text = (text or "").strip()
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1] if len(parts) > 1 else text
        text = re.sub(r"^(srt|vtt)\s*\n","",text,flags=re.IGNORECASE)
    text = text.replace("\r\n","\n").replace("\r","\n")
    lines = text.split("\n"); segs = []; i = 0
    while i < len(lines):
        while i < len(lines) and not _SRT_ARROW.match(lines[i]): i += 1
        if i >= len(lines): break
        m = _SRT_ARROW.match(lines[i])
        if not m: i += 1; continue
        start, end = _t2s(m.group(1)), _t2s(m.group(2)); i += 1; body = []
        while i < len(lines):
            if lines[i].strip() == "": i += 1; break
            if _SRT_ARROW.match(lines[i]): break
            body.append(lines[i].strip()); i += 1
        txt = " ".join(l for l in body if l)
        if txt and end > start: segs.append({"start":start,"end":end,"text":txt})
    return sorted(segs, key=lambda s: s["start"])

def build_srt(segs: list[dict], field="text") -> str:
    out = []
    for i, s in enumerate(segs, 1):
        out += [str(i), f"{_s2t(s['start'])} --> {_s2t(s['end'])}", (s.get(field) or s.get("text","")).strip(), ""]
    return "\n".join(out).strip() + "\n"

# --------------------------- Step 1: Audio extraction ------------------------

async def step_extract_audio(job, video_path: Path, audio_path: Path):
    update_step(job,"audio_extraction",status="running",startedAt=now_iso(),progress=10,message="Extracting audio...")
    job["overallProgress"] = compute_progress(job)
    ok, err = run_ffmpeg("-i",str(video_path),"-vn","-acodec","pcm_s16le","-ar","16000","-ac","1",str(audio_path))
    if not ok:
        update_step(job,"audio_extraction",status="failed",message=f"FFmpeg: {err[-200:]}", completedAt=now_iso())
        raise RuntimeError("Audio extraction failed")
    update_step(job,"audio_extraction",status="completed",progress=100,message="Done",completedAt=now_iso())
    job["overallProgress"] = compute_progress(job)

# --------------------------- Step 2: Transcription ---------------------------

def _transcribe_faster_whisper(audio_path: Path, src_lang: str) -> list[dict]:
    """GPU transcription via faster-whisper (word-level timestamps)."""
    global _whisper_model
    with _whisper_lock:
        model = _whisper_model
    if model is None:
        raise RuntimeError("faster-whisper model not loaded")

    lang = None if src_lang == "auto" else src_lang
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=lang,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=5,
    )
    result = []
    for seg in segments_iter:
        words = seg.words or []
        if words:
            result.append({"start": words[0].start, "end": words[-1].end,
                           "text": seg.text.strip()})
        elif seg.text.strip():
            result.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
    return sorted(result, key=lambda s: s["start"])

async def step_transcribe(job, audio_path: Path) -> list[dict]:
    update_step(job,"transcription",status="running",startedAt=now_iso(),progress=5,message="Initializing...")
    job["overallProgress"] = compute_progress(job)
    src_lang = job.get("sourceLang","auto")

    if _whisper_status == "ready":
        try:
            update_step(job,"transcription",progress=20,message=f"Transcribing with faster-whisper {WHISPER_MODEL} (GPU)...")
            job["overallProgress"] = compute_progress(job)
            loop = asyncio.get_event_loop()
            segs = await loop.run_in_executor(None, _transcribe_faster_whisper, audio_path, src_lang)
            segs = [s for s in segs if s.get("end",0) > s.get("start",0) and s.get("text","").strip()]
            if not segs: raise RuntimeError("No speech segments detected")
            update_step(job,"transcription",status="completed",progress=100,
                        message=f"Transcribed {len(segs)} segments (faster-whisper GPU)",completedAt=now_iso())
            job["overallProgress"] = compute_progress(job)
            return segs
        except Exception as e:
            logger.warning(f"faster-whisper failed: {e} � falling back to Gemini")

    # Gemini fallback
    if not GEMINI_API_KEY:
        update_step(job,"transcription",status="completed",progress=100,
                    message="Demo mode � no GEMINI_API_KEY",completedAt=now_iso())
        return [{"start":0.0,"end":4.0,"text":"Demo transcription. Add GEMINI_API_KEY for real results."}]

    from google import genai
    client = genai.Client(api_key=GEMINI_API_KEY)
    duration = get_duration(audio_path) or 60.0
    compressed = TEMP / f"{audio_path.stem}_c.ogg"
    run_ffmpeg("-i",str(audio_path),"-vn","-ac","1","-ar","16000","-c:a","libopus","-b:a","32k",str(compressed))
    src = compressed if compressed.exists() else audio_path
    mime = "audio/ogg" if src.suffix==".ogg" else "audio/wav"
    with open(src,"rb") as f: b64 = base64.b64encode(f.read()).decode()
    try: compressed.unlink()
    except Exception: pass

    prompt = (f"Transcribe this audio as SRT. Duration ~{duration:.1f}s. "
              "Output ONLY valid SRT, no markdown, strict chronological order, no overlaps.")
    resp = await asyncio.get_event_loop().run_in_executor(None, lambda: client.models.generate_content(
        model=GEMINI_MODEL, contents=[{"role":"user","parts":[
            {"inline_data":{"mime_type":mime,"data":b64}},{"text":prompt}]}],
        config={"max_output_tokens":8192}))
    segs = parse_srt(resp.text or "")
    if not segs: raise RuntimeError("Gemini returned no SRT output")
    update_step(job,"transcription",status="completed",progress=100,
                message=f"Transcribed {len(segs)} segments (Gemini fallback)",completedAt=now_iso())
    job["overallProgress"] = compute_progress(job)
    return segs

# --------------------------- Step 3: Translation -----------------------------

async def _gemini_text(prompt: str, attempts=4) -> str:
    from google import genai
    client = genai.Client(api_key=GEMINI_API_KEY)
    loop = asyncio.get_event_loop()
    for attempt in range(attempts):
        try:
            r = await loop.run_in_executor(None, lambda: client.models.generate_content(
                model=GEMINI_MODEL, contents=prompt, config={"max_output_tokens":8192}))
            return r.text or ""
        except Exception as e:
            msg = str(e).lower()
            if any(x in msg for x in ("429","quota","rate","503","500","504")):
                await asyncio.sleep(2**attempt * 5)
            elif attempt < attempts-1:
                await asyncio.sleep(2)
            else:
                raise
    return ""

def _translate_prompt(srt: str, src: str, tgt: str) -> str:
    return f"""You are a professional dubbing translator. Translate from {src} to {tgt}.
Rules: Output VALID SRT only. Keep every block index and timestamp EXACTLY. Replace only spoken text.
Translate meaning naturally as a native {tgt} speaker. Match speaking duration.

Input SRT:
{srt}

Output: translated SRT with same indices and timestamps."""

async def step_translate(job, segments: list[dict]) -> list[dict]:
    update_step(job,"translation",status="running",startedAt=now_iso(),progress=5,message="Translating...")
    job["overallProgress"] = compute_progress(job)
    tgt_lang  = job.get("targetLang","en")
    src_lang  = job.get("sourceLang","auto")
    tgt_name  = LANG_NAMES.get(tgt_lang, tgt_lang)
    src_name  = LANG_NAMES.get(src_lang, "detected language") if src_lang!="auto" else "detected language"

    if not GEMINI_API_KEY:
        result = [{**s,"translatedText":f"[Demo] {s['text']}"} for s in segments]
        update_step(job,"translation",status="completed",progress=100,message="Demo",completedAt=now_iso())
        return result

    BATCH = 50
    all_texts: list[str] = []
    batches = [segments[i:i+BATCH] for i in range(0,len(segments),BATCH)]
    for bi, batch in enumerate(batches):
        srt_in = build_srt(batch)
        raw = await _gemini_text(_translate_prompt(srt_in, src_name, tgt_name))
        translated = parse_srt(raw)
        by_ts = {int(round(s["start"]*1000)):s for s in translated}
        for seg in batch:
            hit = by_ts.get(int(round(seg["start"]*1000)))
            all_texts.append((hit or {}).get("text") or seg["text"])
        pct = 20 + int(70*(bi+1)/len(batches))
        update_step(job,"translation",progress=pct,message=f"Batch {bi+1}/{len(batches)}...")
        job["overallProgress"] = compute_progress(job)

    result = [{**s,"translatedText":all_texts[i] if i<len(all_texts) else s["text"]}
              for i,s in enumerate(segments)]
    update_step(job,"translation",status="completed",progress=100,
                message=f"Translated {len(result)} segments",completedAt=now_iso())
    job["overallProgress"] = compute_progress(job)
    return result

# --------------------------- XTTS v2 (GPU voice cloning) ---------------------

def _load_xtts():
    global _xtts_model, _xtts_available, _xtts_status
    if _xtts_model is not None: return _xtts_model
    if _xtts_available is False: return None
    with _xtts_load_lock:
        if _xtts_model is not None: return _xtts_model
        if _xtts_available is False: return None
        import torch as _torch
        _orig = _torch.load
        try:
            os.environ["COQUI_TOS_AGREED"] = "1"
            def _patched(f, *a, **kw): kw.setdefault("weights_only",False); return _orig(f,*a,**kw)
            _torch.load = _patched
            from TTS.api import TTS as CoquiTTS
            device = "cuda" if HAS_GPU else "cpu"
            cache  = str(MODEL_CACHE / "tts")
            logger.info(f"Loading XTTS v2 on {device}...")
            tts = CoquiTTS("tts_models/multilingual/multi-dataset/xtts_v2",
                           gpu=HAS_GPU, progress_bar=False)
            _xtts_model = tts; _xtts_available = True; _xtts_status = "ready"
            logger.info("XTTS v2 ready")
            return tts
        except Exception as e:
            logger.warning(f"XTTS v2 unavailable: {e}")
            _xtts_available = False; _xtts_status = "unavailable"; return None
        finally:
            _torch.load = _orig

def _xtts_latents(tts, wav: str):
    with _xtts_latents_lock:
        if wav in _xtts_speaker_cache: return _xtts_speaker_cache[wav]
        lat, emb = tts.synthesizer.tts_model.get_conditioning_latents(
            audio_path=[wav], gpt_cond_len=30, max_ref_length=60)
        _xtts_speaker_cache[wav] = (lat, emb)
        return lat, emb

XTTS_LANG = {"zh":"zh-cn","en":"en","es":"es","fr":"fr","de":"de","pt":"pt","it":"it",
              "ja":"ja","ko":"ko","ar":"ar","ru":"ru","hi":"hi","nl":"nl","pl":"pl","tr":"tr"}

def gen_xtts(text: str, lang: str, speaker_wav: Path, out: Path) -> bool:
    import numpy as np
    try:
        tts = _load_xtts()
        if tts is None or not speaker_wav.exists(): return False
        tts_lang = XTTS_LANG.get(lang,"en")
        lat, emb = _xtts_latents(tts, str(speaker_wav))
        result = tts.synthesizer.tts_model.inference(
            text=text.strip()[:1500], language=tts_lang,
            gpt_cond_latent=lat, speaker_embedding=emb,
            temperature=0.65, top_k=50, top_p=0.85,
            repetition_penalty=5.0, enable_text_splitting=True)
        wav = np.array(result["wav"], dtype=np.float32)
        if wav.size == 0: return False
        import soundfile as sf
        tmp = out.with_name(out.stem+"_24k.wav")
        sf.write(str(tmp), wav, 24000)
        ok, _ = run_ffmpeg("-i",str(tmp),"-acodec","pcm_s16le","-ar","44100","-ac","1",str(out))
        try: tmp.unlink()
        except Exception: pass
        return ok and out.exists()
    except Exception as e:
        logger.warning(f"XTTS error: {e}"); return False

# --------------------------- edge-tts fallback -------------------------------

EDGE_VOICES = {
    "en":["en-US-GuyNeural","en-US-JennyNeural"],"es":["es-ES-AlvaroNeural","es-ES-ElviraNeural"],
    "fr":["fr-FR-HenriNeural","fr-FR-DeniseNeural"],"de":["de-DE-ConradNeural","de-DE-KatjaNeural"],
    "it":["it-IT-DiegoNeural","it-IT-ElsaNeural"],"pt":["pt-BR-AntonioNeural","pt-BR-FranciscaNeural"],
    "ja":["ja-JP-KeitaNeural","ja-JP-NanamiNeural"],"ko":["ko-KR-InJoonNeural","ko-KR-SunHiNeural"],
    "zh":["zh-CN-YunxiNeural","zh-CN-XiaoxiaoNeural"],"hi":["hi-IN-MadhurNeural","hi-IN-SwaraNeural"],
    "ar":["ar-EG-ShakirNeural","ar-EG-SalmaNeural"],"ru":["ru-RU-DmitryNeural","ru-RU-SvetlanaNeural"],
    "tr":["tr-TR-AhmetNeural","tr-TR-EmelNeural"],"nl":["nl-NL-MaartenNeural","nl-NL-ColetteNeural"],
    "pl":["pl-PL-MarekNeural","pl-PL-AgnieszkaNeural"],"uk":["uk-UA-OstapNeural","uk-UA-PolinaNeural"],
    "vi":["vi-VN-NamMinhNeural","vi-VN-HoaiMyNeural"],"id":["id-ID-ArdiNeural","id-ID-GadisNeural"],
    "fil":["fil-PH-AngeloNeural","fil-PH-BlessicaNeural"],"fi":["fi-FI-HarriNeural","fi-FI-NooraNeural"],
}

async def gen_edge_tts(text: str, lang: str, out: Path, style="original") -> bool:
    try:
        import edge_tts
        voices = EDGE_VOICES.get(lang, EDGE_VOICES["en"])
        voice  = voices[1] if style=="female" and len(voices)>1 else voices[0]
        mp3    = out.with_suffix(".mp3")
        await edge_tts.Communicate(text.strip()[:3000], voice=voice).save(str(mp3))
        if not mp3.exists() or mp3.stat().st_size==0: return False
        loop = asyncio.get_event_loop()
        ok,_ = await loop.run_in_executor(None, run_ffmpeg,
            "-i",str(mp3),"-acodec","pcm_s16le","-ar","44100","-ac","1",str(out))
        try: mp3.unlink()
        except Exception: pass
        return ok and out.exists()
    except Exception as e:
        logger.warning(f"edge-tts: {e}"); return False

def gen_gtts(text: str, lang: str, out: Path) -> bool:
    try:
        import gtts
        gtts_lang = GTTS_LANG_MAP.get(lang, lang) if lang!="auto" else "en"
        mp3 = out.with_suffix(".mp3")
        gtts.gTTS(text=text.strip()[:2000], lang=gtts_lang).save(str(mp3))
        ok,_ = run_ffmpeg("-i",str(mp3),"-acodec","pcm_s16le","-ar","44100","-ac","1",str(out))
        try: mp3.unlink()
        except Exception: pass
        return ok and out.exists()
    except Exception as e:
        logger.warning(f"gTTS: {e}"); return False

# --------------------------- Audio timing helpers -----------------------------

def time_stretch(src: Path, dst: Path, ratio: float) -> bool:
    if ratio <= 0: return False
    filters = []
    r = ratio
    while r > 2.0: filters.append("atempo=2.0"); r /= 2.0
    while r < 0.5: filters.append("atempo=0.5"); r *= 2.0
    filters.append(f"atempo={r:.4f}")
    ok,_ = run_ffmpeg("-i",str(src),"-filter:a",",".join(filters),
                      "-acodec","pcm_s16le","-ar","44100","-ac","1",str(dst))
    return ok

def pad_trim(src: Path, dst: Path, secs: float) -> bool:
    ok,_ = run_ffmpeg("-i",str(src),"-af",f"apad=whole_dur={secs}","-t",str(secs),
                      "-acodec","pcm_s16le","-ar","44100","-ac","1",str(dst))
    return ok

def extract_voice_sample(audio: Path, out: Path, secs=15.0) -> bool:
    DENOISE = "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"
    try:
        dur = get_duration(audio) or 60.0
        start = 0.0 if dur <= secs+2 else dur/3.0
        length = min(secs, dur - start)
        ok,_ = run_ffmpeg("-i",str(audio),"-ss",str(start),"-t",str(length),
                          "-af",DENOISE,"-acodec","pcm_s16le","-ar","22050","-ac","1",str(out))
        return ok and out.exists() and out.stat().st_size > 0
    except Exception as e:
        logger.warning(f"Voice sample failed: {e}"); return False

def build_timed_track(segs: list[dict], total_dur: float, out: Path) -> bool:
    if not segs: return False
    inputs = ["-f","lavfi","-i",f"anullsrc=r=44100:cl=mono:d={total_dur+1}"]
    fparts = ["[0]aformat=sample_rates=44100:channel_layouts=mono[base]"]
    labels = ["[base]"]
    for i, s in enumerate(segs):
        d = int(s["start"]*1000)
        inputs += ["-i",str(s["path"])]
        lbl = f"[d{i}]"
        fparts.append(f"[{i+1}]aformat=sample_rates=44100:channel_layouts=mono,adelay={d}|{d}{lbl}")
        labels.append(lbl)
    n = len(labels)
    fparts.append("".join(labels)+f"amix=inputs={n}:duration=first:normalize=0[out]")
    ok,_ = run_ffmpeg(*inputs,"-filter_complex",";".join(fparts),
                      "-map","[out]","-t",str(total_dur),
                      "-acodec","pcm_s16le","-ar","44100","-ac","1",str(out))
    return ok

# --------------------------- Step 4: Voice generation ------------------------

async def step_generate_voice(job, translated: list[dict], tts_out: Path,
                               orig_audio: Path, video: Path, dur: float) -> bool:
    update_step(job,"voice_generation",status="running",startedAt=now_iso(),progress=2,message="Preparing voice engine...")
    job["overallProgress"] = compute_progress(job)
    tgt_lang   = job.get("targetLang","en")
    style      = job.get("voiceStyle","original")
    job_id     = job["jobId"]
    use_clone  = (style=="original")

    speaker_wav = TEMP / f"{job_id}_ref.wav"
    if use_clone:
        update_step(job,"voice_generation",progress=5,message="Extracting voice reference...")
        ok = extract_voice_sample(video, speaker_wav)
        if not ok: ok = extract_voice_sample(orig_audio, speaker_wav)
        if not ok: use_clone = False

    use_xtts = False
    if use_clone:
        loop = asyncio.get_event_loop()
        tts_m = await loop.run_in_executor(None, _load_xtts)
        use_xtts = tts_m is not None

    engine = "XTTS v2 GPU" if use_xtts else "edge-tts neural"
    valid  = sorted([s for s in translated if s.get("end",0)>s.get("start",0)], key=lambda s:s["start"])
    total  = len(valid)
    update_step(job,"voice_generation",progress=12,message=f"{engine} � {total} segments...")
    job["overallProgress"] = compute_progress(job)

    def eff_window(i, seg):
        avail = max(0.4, seg["end"]-seg["start"])
        if i+1 < total: return max(avail, valid[i+1]["start"]-seg["start"])
        return max(avail, dur-seg["start"])

    def apply_stretch(i, seg, raw: Path):
        adj = TEMP/f"{job_id}_s{i}_adj.wav"
        pad = TEMP/f"{job_id}_s{i}_pad.wav"
        actual = get_audio_dur(raw)
        if not actual or actual<=0: return raw
        win = eff_window(i, seg)
        if win <= 0: return raw
        ratio = actual / win
        if NEAR_LOW <= ratio <= NEAR_HIGH: return raw
        sr = min(MAX_STRETCH, max(MIN_STRETCH, ratio))
        ok = time_stretch(raw, adj, sr)
        if not ok: return raw
        adur = get_audio_dur(adj)
        if adur and (adur > win*(1+DUR_TOL) or adur < win*(1-DUR_TOL)):
            if pad_trim(adj, pad, win) and pad.exists(): return pad
        return adj

    with_audio = []
    xtts_n = edge_n = gtts_n = 0

    if use_xtts:
        for i, seg in enumerate(valid):
            text = (seg.get("translatedText") or seg.get("text","")).strip()
            if not text: continue
            update_step(job,"voice_generation",progress=12+int(72*i/max(total,1)),
                        message=f"Segment {i+1}/{total} � {engine}...")
            job["overallProgress"] = compute_progress(job)
            raw = TEMP/f"{job_id}_s{i}_raw.wav"
            ok = await asyncio.get_event_loop().run_in_executor(None, gen_xtts, text, tgt_lang, speaker_wav, raw)
            if ok: xtts_n += 1
            if not ok:
                ok = await gen_edge_tts(text, tgt_lang, raw, style)
                if ok: edge_n += 1
            if not ok:
                ok = await asyncio.get_event_loop().run_in_executor(None, gen_gtts, text, tgt_lang, raw)
                if ok: gtts_n += 1
            if not ok: continue
            final = apply_stretch(i, seg, raw)
            with_audio.append({"start":seg["start"],"path":final})
    else:
        sem = asyncio.Semaphore(8)
        async def do_edge(i, seg):
            text = (seg.get("translatedText") or seg.get("text","")).strip()
            if not text: return None, 0, 0
            raw = TEMP/f"{job_id}_s{i}_raw.wav"
            async with sem:
                ok = await gen_edge_tts(text, tgt_lang, raw, style)
                e = int(ok); g = 0
                if not ok:
                    ok = await asyncio.get_event_loop().run_in_executor(None, gen_gtts, text, tgt_lang, raw)
                    g = int(ok); e = 0
            if not ok: return None, 0, 0
            loop = asyncio.get_event_loop()
            final = await loop.run_in_executor(None, apply_stretch, i, seg, raw)
            return {"start":seg["start"],"path":final}, e, g
        gathered = await asyncio.gather(*[do_edge(i,s) for i,s in enumerate(valid)])
        for info,e,g in gathered:
            if info: with_audio.append(info); edge_n+=e; gtts_n+=g

    try: speaker_wav.unlink()
    except Exception: pass
    _xtts_speaker_cache.pop(str(speaker_wav), None)

    if not with_audio:
        update_step(job,"voice_generation",status="failed",message="No audio generated",completedAt=now_iso())
        return False

    update_step(job,"voice_generation",progress=90,message="Assembling dubbed track...")
    ok = build_timed_track(with_audio, dur, tts_out)
    parts = []
    if xtts_n: parts.append(f"XTTS v2 GPU ({xtts_n})")
    if edge_n: parts.append(f"edge-tts ({edge_n})")
    if gtts_n: parts.append(f"gTTS ({gtts_n})")
    lbl = " + ".join(parts) or "none"
    if ok:
        update_step(job,"voice_generation",status="completed",progress=100,
                    message=f"Dubbed via {lbl} ({len(with_audio)} segs)",completedAt=now_iso())
    else:
        update_step(job,"voice_generation",status="failed",message="Track assembly failed",completedAt=now_iso())
    job["overallProgress"] = compute_progress(job)
    return ok

# --------------------------- Step 5: Lip Sync ---------------------------------

async def step_lip_sync(job, video: Path, audio: Path, out: Path) -> bool:
    if not job.get("lipSync", False):
        update_step(job,"lip_sync",status="skipped",message="Disabled",completedAt=now_iso())
        job["overallProgress"] = compute_progress(job)
        return False
    update_step(job,"lip_sync",status="running",startedAt=now_iso(),progress=5,message="Looking for Wav2Lip...")
    job["overallProgress"] = compute_progress(job)
    script, ckpt = _wav2lip_script, _wav2lip_ckpt
    if not (script and ckpt):
        update_step(job,"lip_sync",status="skipped",message="Wav2Lip not installed",completedAt=now_iso())
        job["overallProgress"] = compute_progress(job)
        return False
    try:
        import sys as _sys
        prep = TEMP/f"{job['jobId']}_ls_audio.wav"
        run_ffmpeg("-i",str(audio),"-vn","-acodec","pcm_s16le","-ar","16000","-ac","1",
                   "-af","loudnorm=I=-18:TP=-1.5:LRA=11",str(prep))
        audio_in = prep if prep.exists() else audio
        def _run():
            return subprocess.run([_sys.executable,str(script),
                "--checkpoint_path",str(ckpt),"--face",str(video),
                "--audio",str(audio_in),"--outfile",str(out),
                "--resize_factor","2","--wav2lip_batch_size","16 if HAS_GPU else 8",
                "--face_det_batch_size","8 if HAS_GPU else 4"],
                capture_output=True, timeout=1800)
        loop = asyncio.get_event_loop()
        fut  = loop.run_in_executor(None, _run)
        t0   = time.time()
        while True:
            try:
                res = await asyncio.wait_for(asyncio.shield(fut), timeout=15.0); break
            except asyncio.TimeoutError:
                e = int(time.time()-t0); m,s = divmod(e,60)
                pct = int(15+min(75,75*e/1200))
                update_step(job,"lip_sync",progress=pct,message=f"Wav2Lip � {m}m{s:02d}s...")
                job["overallProgress"] = compute_progress(job)
        try: prep.unlink()
        except Exception: pass
        if res.returncode==0 and out.exists():
            update_step(job,"lip_sync",status="completed",progress=100,
                        message="Lip sync applied",completedAt=now_iso())
            job["overallProgress"] = compute_progress(job)
            return True
        update_step(job,"lip_sync",status="failed",message=f"Wav2Lip rc={res.returncode}",completedAt=now_iso())
        job["overallProgress"] = compute_progress(job)
        return False
    except Exception as e:
        update_step(job,"lip_sync",status="failed",message=str(e)[:200],completedAt=now_iso())
        return False

# --------------------------- Step 6: Video merge ------------------------------

async def step_merge(job, video: Path, dubbed: Optional[Path], orig_audio: Optional[Path],
                     dur: float, out: Path):
    update_step(job,"video_merge",status="running",startedAt=now_iso(),progress=10,message="Merging...")
    job["overallProgress"] = compute_progress(job)
    t = ["-t",f"{dur:.3f}"]
    if dubbed and dubbed.exists():
        if PRESERVE_AMBIENT and orig_audio and orig_audio.exists():
            gain = 10**(AMBIENT_MIX_DB/20.0)
            ok,err = run_ffmpeg("-i",str(video),"-i",str(dubbed),"-i",str(orig_audio),
                "-filter_complex",
                f"[1:a]apad,volume=1.0[d];[2:a]aresample=44100,apad,volume={gain:.6f}[a];"
                "[d][a]amix=inputs=2:duration=first:normalize=0[aout]",
                "-map","0:v:0","-map","[aout]","-c:v","copy",*t,str(out))
        else:
            ok,err = run_ffmpeg("-i",str(video),"-i",str(dubbed),"-c:v","copy",
                "-map","0:v:0","-map","1:a:0",*t,str(out))
    else:
        ok,err = run_ffmpeg("-i",str(video),"-c","copy",str(out))
    if not ok:
        update_step(job,"video_merge",status="failed",message=err[-200:],completedAt=now_iso())
        raise RuntimeError("Merge failed")
    update_step(job,"video_merge",status="completed",progress=100,message="Done",completedAt=now_iso())
    job["overallProgress"] = 100.0

# --------------------------- Full pipeline ------------------------------------

async def _run_pipeline(job_id: str):
    job = JOBS.get(job_id)
    if not job: return
    job["status"] = "processing"
    video    = Path(job["videoPath"])
    audio    = TEMP/f"{job_id}_audio.wav"
    tts_out  = TEMP/f"{job_id}_tts.wav"
    synced   = TEMP/f"{job_id}_synced.mp4"
    output   = OUTPUTS/f"{job_id}_translated.mp4"
    try:
        await step_extract_audio(job, video, audio)
        dur = get_duration(video) or get_duration(audio) or 60.0
        job["videoDuration"] = dur
        segs        = await step_transcribe(job, audio)
        translated  = await step_translate(job, segs)
        job["transcript"] = translated
        tts_ok = await step_generate_voice(job, translated, tts_out, audio, video, dur)
        if not tts_ok or not tts_out.exists():
            raise RuntimeError("Voice generation failed")
        if job.get("lipSync"):
            lipped = await step_lip_sync(job, video, tts_out, synced)
        else:
            update_step(job,"lip_sync",status="skipped",message="Disabled",completedAt=now_iso())
            lipped = False
        src = synced if lipped and synced.exists() else video
        await step_merge(job, src, tts_out,
                         audio if PRESERVE_AMBIENT and audio.exists() else None,
                         dur, output)
        job["status"]     = "completed"
        job["completedAt"] = now_iso()
        job["outputPath"]  = str(output)
    except Exception as e:
        logger.exception(f"Job {job_id} failed")
        job["status"] = "failed"; job["error"] = str(e); job["completedAt"] = now_iso()
        for s in job["steps"]:
            if s["status"] == "pending": s["status"] = "skipped"
        job["overallProgress"] = compute_progress(job)
    finally:
        for p in [tts_out, synced, audio]:
            try: p.unlink()
            except Exception: pass

async def process_video(job_id: str):
    sem = _pipeline_semaphore
    if sem and sem.locked(): JOBS[job_id]["status"] = "queued"
    if sem: await sem.acquire()
    try: await _run_pipeline(job_id)
    finally:
        if sem: sem.release()

# --------------------------- API endpoints ------------------------------------

def job_status(job):
    return {"jobId":job["jobId"],"status":job["status"],"overallProgress":job.get("overallProgress",0),
            "steps":job["steps"],"error":job.get("error"),"sourceLang":job["sourceLang"],
            "targetLang":job["targetLang"],"voiceStyle":job["voiceStyle"],"lipSync":job["lipSync"],
            "videoDuration":job.get("videoDuration"),"originalFilename":job.get("originalFilename"),
            "createdAt":job["createdAt"],"completedAt":job.get("completedAt")}

@app.get("/healthz")
async def health():
    return {"status":"ok","gpu":HAS_GPU,"whisper":_whisper_status,"xtts_v2":_xtts_status,"wav2lip":_wav2lip_status}

@app.get("/system-status")
async def system_status():
    ready = _whisper_status in ("ready","unavailable") and _xtts_status in ("ready","unavailable") and _wav2lip_status in ("ready","unavailable")
    return {"ready":ready,"gpu":HAS_GPU,"models":{
        "whisper":  {"status":_whisper_status, "label":f"faster-whisper {WHISPER_MODEL} {'GPU' if HAS_GPU else 'CPU'}"},
        "xtts_v2":  {"status":_xtts_status,    "label":"Voice Cloning (XTTS v2)"},
        "wav2lip":  {"status":_wav2lip_status,  "label":"Lip Sync (Wav2Lip GAN)"},
    }}

@app.post("/upload")
async def upload(bg: BackgroundTasks, file: UploadFile=File(...),
                 sourceLang: str=Form("auto"), targetLang: str=Form("en"),
                 voiceStyle: str=Form("original"), lipSync: str=Form("false")):
    if not file.filename: raise HTTPException(400,"No file")
    ext = Path(file.filename).suffix.lower()
    if ext not in (".mp4",".mov",".mkv",".avi",".webm"): raise HTTPException(400,"Unsupported format")
    if sourceLang not in SUPPORTED_LANGS: raise HTTPException(400,f"Bad sourceLang: {sourceLang}")
    if targetLang not in SUPPORTED_TARGET_LANGS: raise HTTPException(400,f"Bad targetLang: {targetLang}")
    if sourceLang!="auto" and sourceLang==targetLang: raise HTTPException(400,"Source=target lang")
    job_id = str(uuid.uuid4())
    path   = UPLOADS/f"{job_id}{ext}"
    async with aiofiles.open(path,"wb") as f:
        while chunk := await file.read(1024*1024): await f.write(chunk)
    job = {"jobId":job_id,"status":"pending","videoPath":str(path),
           "originalFilename":file.filename,"sourceLang":sourceLang,"targetLang":targetLang,
           "voiceStyle":voiceStyle,"lipSync":lipSync.lower()=="true","createdAt":now_iso(),
           "overallProgress":0.0,"videoDuration":None,"steps":copy.deepcopy(STEPS_DEFAULT),"transcript":[]}
    JOBS[job_id] = job
    bg.add_task(process_video, job_id)
    return {"jobId":job_id,"status":"pending","message":"Upload successful, processing started"}

@app.get("/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in JOBS: raise HTTPException(404,"Not found")
    return job_status(JOBS[job_id])

@app.get("/transcript/{job_id}")
async def get_transcript(job_id: str):
    if job_id not in JOBS: raise HTTPException(404,"Not found")
    job = JOBS[job_id]
    return {"jobId":job_id,"sourceLang":job["sourceLang"],"targetLang":job["targetLang"],
            "segments":[{"start":s.get("start",0),"end":s.get("end",0),
                         "originalText":s.get("text",""),"translatedText":s.get("translatedText","")}
                        for s in job.get("transcript",[])]}

@app.get("/preview/{job_id}")
async def preview(job_id: str):
    if job_id not in JOBS: raise HTTPException(404,"Not found")
    job = JOBS[job_id]
    if job["status"]!="completed": raise HTTPException(400,"Not completed")
    p = Path(job["outputPath"])
    if not p.exists(): raise HTTPException(404,"File missing")
    return FileResponse(str(p),media_type="video/mp4",headers={"Accept-Ranges":"bytes","Cache-Control":"no-cache"})

@app.get("/download/{job_id}")
async def download(job_id: str):
    if job_id not in JOBS: raise HTTPException(404,"Not found")
    job = JOBS[job_id]
    if job["status"]!="completed": raise HTTPException(400,"Not completed")
    p = Path(job["outputPath"])
    if not p.exists(): raise HTTPException(404,"File missing")
    return FileResponse(str(p),media_type="video/mp4",
                        filename=_safe_name(job.get("originalFilename"),job_id),
                        headers={"Accept-Ranges":"bytes"})

@app.get("/jobs")
async def list_jobs():
    return sorted([{"jobId":j["jobId"],"status":j["status"],"overallProgress":j.get("overallProgress",0),
                    "sourceLang":j["sourceLang"],"targetLang":j["targetLang"],
                    "originalFilename":j.get("originalFilename"),"createdAt":j["createdAt"],
                    "completedAt":j.get("completedAt")} for j in JOBS.values()],
                   key=lambda x: x["createdAt"], reverse=True)

@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    if job_id not in JOBS: raise HTTPException(404,"Not found")
    job = JOBS.pop(job_id)
    for k in ("videoPath","outputPath"):
        if p := job.get(k):
            try: Path(p).unlink()
            except Exception: pass
    return {"message":"deleted"}
