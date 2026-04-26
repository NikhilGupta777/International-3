# Video Translator — Full Implementation Plan

## Goal
Deploy a HeyGen-like, GPU-accelerated video dubbing pipeline on AWS with:
- $0/month idle cost (true scale-to-zero via AWS Batch)
- No 24/7 EC2 or Fargate servers
- GPU only when a job is running
- Best available open-source models for each stage

---

## Architecture: AWS Batch GPU (Scale-to-Zero)

```
User (Browser)
  │
  ▼
React VideoTranslator Tab
  │  1. GET /api/translator/presign → S3 pre-signed URL
  │  2. PUT video directly to S3 (bypasses API server, no size limits)
  │  3. POST /api/translator/submit → creates DynamoDB job + submits Batch job
  │  4. POLL /api/translator/status/:jobId every 3s → shows progress cards
  │  5. GET /api/translator/result/:jobId → S3 pre-signed URL for final video
  │
  ▼
Lambda / Express API (existing api-server)
  │  - Generates S3 presigned PUT URL
  │  - Creates DynamoDB record: { jobId, status: "QUEUED", progress: 0 }
  │  - Calls aws batch submit-job (wakes GPU)
  │  - Reads DynamoDB for status polling
  │
  ▼
AWS Batch GPU Job Queue (translator-gpu-queue)
  │  - EC2-backed (NOT Fargate — Fargate has no GPU)
  │  - minvCpus = 0 → $0/month when idle
  │  - Spot Instances preferred (g4dn.xlarge or g5.xlarge)
  │  - On-Demand fallback
  │
  ▼
Docker Container: ytgrabber-green-translator (ECR)
  │  CMD ["python", "worker.py"]
  │  - Reads job config from env vars (S3_INPUT_KEY, TARGET_LANG, JOB_ID, ...)
  │  - Downloads video from S3
  │  - Runs full AI pipeline
  │  - Updates DynamoDB progress throughout
  │  - Uploads final MP4 + SRT + transcript JSON to S3
  │  - Exits cleanly → Batch scales GPU instance back to zero
  │
  ▼
S3 Output Bucket
  translator-jobs/{jobId}/output.mp4
  translator-jobs/{jobId}/subtitles.srt
  translator-jobs/{jobId}/transcript.json
```

---

## AI Pipeline (Best Models Per Stage)

### Stage 1 — Audio Extraction
- **Tool:** FFmpeg
- Extract audio track from video as WAV
- Optionally run **Demucs** to separate voice from background music
  - Keeps background music/effects under the new dubbed voice
  - Toggle: enabled only if video has background music

### Stage 2 — Transcription (ASR)
| Mode    | Model                               | Notes                              |
|---------|-------------------------------------|------------------------------------|
| Default | `whisper-large-v3-turbo`            | Fast, near-large-v3 quality        |
| Premium | `whisper-large-v3` + WhisperX align | Best timing for dubbing lip-sync   |

- Uses `faster-whisper` (CTranslate2 GPU backend)
- WhisperX adds forced word-level alignment for tight segment timing
- **mandatory (its needed) pyannote/speaker-diarization-3.1** for multi-speaker videos (podcast, interview mode)

### Stage 3 — Translation (Dubbing-Aware)
| Mode    | Model                           | Use Case                         |
|---------|---------------------------------|----------------------------------|
| Default | `gemini-3-flash-preview`        | Best quality/speed for dubbing   |
| Budget  | `gemini-3.1-flash-lite-preview` | High volume, cost-efficient      |
| Retry   | `gemini-3.1-pro-preview`        | Difficult segments, re-attempts  |

- Translation is **NOT literal** — it is dubbing-aware:
  - Preserves emotion, tone, speaking style
  - Keeps translated segment duration close to original
  - Returns structured JSON per segment: `{ segment_id, text, translated_text, emotion, speaking_rate }`

### Stage 4 — Timing Adapter
- Adjusts translated text to fit original segment duration
- Can slightly speed up or slow down TTS output per segment
- Prevents audio/video timing drift

### Stage 5 — Voice Cloning (TTS)
| Mode       | Model              | Notes                                       |
|------------|--------------------|---------------------------------------------|
| Default    | XTTS v2            | 17 languages incl. Hindi, GPU, voice-clone  |
| Hindi+     | Hindi XTTS finetune| Better Hindi naturalness (after testing)    |
| Experimental| F5-TTS            | Check CC-BY-NC license before production    |
| Fallback   | edge-tts           | Neural voices, no GPU needed                |
| Emergency  | gTTS               | Last resort, robotic quality                |

- Load XTTS → synthesize all segments → **unload** before next model
- Call `torch.cuda.empty_cache()` between stages to prevent VRAM overflow

### Stage 6 — Lip Sync (Optional Toggle)
| Mode    | Model         | Notes                                        |
|---------|---------------|----------------------------------------------|
| Default | MuseTalk      | Real-time, better quality than Wav2Lip       |
| Premium | LatentSync 1.6| Diffusion-based, best 512×512 quality        |
| Fallback| Wav2Lip GAN   | Legacy, still works well for basic lip sync  |

- Users can toggle lip-sync on/off in the UI
- Load lip-sync model → process → **unload** before next stage

### Stage 7 — Audio Mixing + Normalization
- Mix new dubbed voice with separated background music (if Demucs was used)
- Apply loudness normalization (EBU R128 via ffmpeg-normalize)
- Adjust per-segment speech speed to fit original timing

### Stage 8 — Final Video Merge
- FFmpeg: mux dubbed audio + (optionally lip-synced) video
- Export: MP4 (H.264/AAC), SRT subtitle file, transcript JSON

---

## File Changes Required

### 1. `artifacts/video-translator-service/worker.py` (NEW — replaces main.py)
- CLI entrypoint, no FastAPI, no HTTP server
- Reads all config from environment variables injected by AWS Batch
- Updates DynamoDB progress at each stage checkpoint
- Uploads outputs to S3 when complete

### 2. `artifacts/video-translator-service/requirements.txt` (REWRITE)
Clean, sectioned requirements:
```
# Base worker
boto3, google-genai, typer, rich, python-dotenv

# ASR
faster-whisper, ctranslate2, whisperx, pyannote.audio

# Audio/video
soundfile, librosa, pydub, opencv-python-headless, demucs

# TTS
TTS==0.22.0, edge-tts, gtts, phonemizer

# Compatibility
numpy==1.26.4
```
Note: PyTorch installed separately in Dockerfile via CUDA wheel URL.

### 3. `artifacts/video-translator-service/Dockerfile` (UPDATE)
Changes:
- Remove `EXPOSE 8000`, `HEALTHCHECK`, `CMD ["uvicorn", "main:app", ...]`
- Add `CMD ["python", "worker.py"]`
- Update comment: "AWS Batch GPU worker container" (not Fargate)
- PyTorch installed via official CUDA 12.1 wheel
- Bake model weights into image OR mount EFS model cache

### 4. `artifacts/api-server/src/routes/translator.ts` (REWRITE)
Remove FastAPI proxy. Add:
- `GET /presign` → returns S3 pre-signed PUT URL
- `POST /submit` → creates DynamoDB job + calls `batch.submitJob()`
- `GET /status/:jobId` → reads DynamoDB for progress
- `GET /result/:jobId` → returns S3 pre-signed GET URL

### 5. `artifacts/yt-downloader/src/pages/VideoTranslator.tsx` (UPDATE)
- Step 1: Fetch presigned URL → upload directly to S3 (progress bar)
- Step 2: Submit job → get jobId back
- Step 3: Poll `/status/:jobId` every 3s → update progress cards
- Step 4: On complete → fetch result URL → play video inline

### 6. `deploy/aws-serverless/template.yml` (UPDATE)
Add CloudFormation parameters and resources:
- `TranslatorBatchJobQueue` parameter
- `TranslatorBatchJobDefinition` parameter
- Lambda IAM policy additions: `batch:SubmitJob`, `batch:DescribeJobs`
- Lambda env vars: `TRANSLATOR_BATCH_JOB_QUEUE`, `TRANSLATOR_BATCH_JOB_DEFINITION`

### 7. `.github/workflows/deploy.yml` (ALREADY DONE)
- `build-translator` job already pushes to ECR ✅
- Add AWS Batch job registration step after image push

---

## AWS Infrastructure Commands (One-Time Setup)

These will be run by the agent directly via AWS CLI:

1. Create EC2 GPU Compute Environment (Spot, minvCpus=0)
2. Create Job Queue (`translator-gpu-queue`)
3. Register Job Definition (`translator-job-def` pointing to ECR image)
4. Update IAM role to allow `batch:SubmitJob`
5. Add env vars to CloudFormation stack

---

## GPU Instance Recommendation

| Instance     | GPU        | VRAM  | Cost (Spot) | Use Case              |
|--------------|------------|-------|-------------|------------------------|
| g4dn.xlarge  | T4 16GB    | 16GB  | ~$0.15/hr   | Budget default         |
| g5.xlarge    | A10G 24GB  | 24GB  | ~$0.30/hr   | Recommended default    |
| g5.2xlarge   | A10G 24GB  | 24GB  | ~$0.45/hr   | LatentSync premium     |

**Recommended:** Start with `g4dn.xlarge`. Upgrade to `g5.xlarge` if MuseTalk quality needs improvement.

---

## Model VRAM Management (Critical)
Never load Whisper + XTTS + MuseTalk all at once. Load → run → unload sequentially:
```python
# Transcription
model = WhisperModel(...); segments = model.transcribe(...); del model; torch.cuda.empty_cache()

# Voice cloning
tts = TTS(...).to("cuda"); tts.tts_to_file(...); del tts; torch.cuda.empty_cache()

# Lip sync
musetalk = MuseTalk(...); musetalk.render(...); del musetalk; torch.cuda.empty_cache()
```

---

## DynamoDB Progress States
```json
{ "status": "QUEUED",       "progress": 0,   "step": "Waiting for GPU..." }
{ "status": "STARTING",     "progress": 5,   "step": "Starting GPU instance..." }
{ "status": "EXTRACTING",   "progress": 10,  "step": "Extracting audio..." }
{ "status": "TRANSCRIBING", "progress": 25,  "step": "Transcribing speech..." }
{ "status": "TRANSLATING",  "progress": 45,  "step": "Translating to Hindi..." }
{ "status": "CLONING",      "progress": 65,  "step": "Cloning voice..." }
{ "status": "LIPSYNC",      "progress": 80,  "step": "Syncing lip movements..." }
{ "status": "MERGING",      "progress": 92,  "step": "Merging final video..." }
{ "status": "UPLOADING",    "progress": 97,  "step": "Uploading to cloud..." }
{ "status": "DONE",         "progress": 100, "step": "Complete!", "outputKey": "..." }
{ "status": "FAILED",       "progress": 0,   "error": "..." }
```

---

## Execution Order
1. [ ] Write `worker.py` (AWS Batch CLI entrypoint)
2. [ ] Rewrite `requirements.txt` (clean, sectioned)
3. [ ] Update `Dockerfile` (remove FastAPI, add `CMD worker.py`)
4. [ ] Rewrite `translator.ts` (presign + submit + status + result)
5. [ ] Update `VideoTranslator.tsx` (S3 upload + polling UI)
6. [ ] Update `template.yml` (Batch params + IAM)
7. [ ] Run AWS CLI commands to provision Batch GPU infra
8. [ ] Push all to GitHub → CI/CD builds new image
9. [ ] Test end-to-end on live site
