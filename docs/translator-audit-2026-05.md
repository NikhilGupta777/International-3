# Video Translator — Deep Audit Report

**Date:** 2026-05-18
**Scope:** The entire Translator tab end-to-end: frontend, API routes, GPU/CPU workers, CosyVoice 2/3 integration, translation prompts, timing/pacing, parallelism, infrastructure, and UX.
**Status:** AUDIT ONLY — no code changes performed. This is a recommendation document.

---

## TL;DR — Why dubbed speech sounds "2x sometimes 0.5x"

The pacing problem is **not** randomness in CosyVoice. It is caused by 5 stacked design choices in `worker.py`:

1. **CosyVoice's native `speed` parameter is never used.** The upstream API supports `speed=0.5–1.5` directly inside `inference_zero_shot` / `inference_cross_lingual`, which warps the duration *inside the model* with high-quality interpolation on the mel-spectrogram. Our code passes `speed=1.0` (default) and instead time-stretches the WAV afterwards with `ffmpeg atempo`, which is a phase-vocoder hack that mangles intonation.
2. **`fit_audio_to_duration()` allows up to ~1.82× speedup and ~1.5× slowdown**, with `min_ratio = 0.55` for short segments and `0.65` otherwise. For Hindi/Marathi/Tamil targets — which expand the source by 30–60% — this routinely fires at 1.5×–1.82×, producing the "chipmunk" / "2× speech" the user described.
3. **Hard-cut + 60 ms fade when CosyVoice audio exceeds the source segment duration** (in `assemble_dubbed_audio`). End syllables are clipped, then the next segment slot starts on the original (ASR) timestamp regardless. So either the ending of segment N is chopped off, or the start of segment N+1 collides with the tail.
4. **The translation prompt asks Gemini to "keep duration close to original" but never measures or enforces it.** When it produces a too-long sentence, the entire pacing burden falls on step (1)+(2) — i.e., a 1.8× speedup hack.
5. **`speaking_rate` from Gemini (clamped to 0.9–1.2) is wired only into `edge-tts`, never into CosyVoice**, even though CosyVoice would honor it via `speed`.

**Net effect:** every dub sentence is run at default CosyVoice speed, then post-hoc time-warped by an aggressive ffmpeg ratio that is allowed to go up to 1.82×. That is the audible defect.

The fix is a redesign of the timing layer, not a parameter tweak. See **Section 2** for the full plan.

---

## 0. Architecture map (as built today)

```
Frontend  artifacts/yt-downloader/src/pages/VideoTranslator.tsx (1147 LOC)
          ─ uploads via S3 presigned PUT
          ─ POST /submit → polls /status every 2s
          ─ derives stage breakdown from progress thresholds (also uses backend stepsJson)

API       artifacts/api-server/src/routes/translator.ts (1587 LOC)
          ─ /presign, /submit, /submit-from-url
          ─ /status/:id, /result/:id, /history, /share/:id, /cancel/:id
          ─ 3 runtimes:
              ─ batch     (GPU clone + lipsync)
              ─ batch-cpu (Fargate Neural Voice via edge-tts)
              ─ lambda-fast (subtitle-only, ≤10 min videos)

Worker    artifacts/video-translator-service/worker.py (2623 LOC, one-shot CLI)
          ─ Stages: download → extract audio → Demucs → AssemblyAI ASR → diarize
                    → merge segments → Gemini translate → CosyVoice clone
                    → atempo timing fit → assemble + mix → optional LatentSync
                    → mux + SRT + transcript → S3 upload → DDB DONE

State     DynamoDB (jobId pk, type='translator')
Storage   S3 (translator-jobs/{jobId}/input.mp4 → output.mp4 + subtitles.srt + transcript.json + translation_report.json)
```

Reference docs verified against upstream:
- [FunAudioLLM/CosyVoice main `cosyvoice/cli/cosyvoice.py`](https://github.com/FunAudioLLM/CosyVoice) (zero_shot/cross_lingual/instruct2 signatures)
- [CosyVoice2 cosyvoice2.yaml](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B/raw/main/cosyvoice2.yaml) (`sample_rate: 24000`)
- [Fun-CosyVoice3 cosyvoice3.yaml](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/raw/main/cosyvoice3.yaml) (`sample_rate: 24000`)

> Content sourced from public upstream repos and rephrased for licensing compliance.

---

## 1. Severity buckets

| Sev | Count | Theme |
|-----|-----|------|
| **P0 — Causes the user's complaint** | 7 | Pacing, timing, CosyVoice misuse |
| **P1 — Quality regressions** | 11 | Reference selection, prompt quality, Demucs side-effects, parallelism missing |
| **P2 — Robustness / cost / UX** | 14 | Retry loops, model-name correctness, cost controls, UX preview |
| **P3 — Hygiene / nits** | 8 | Hardcoded constants, dead code, log noise |

Every finding below is labeled with `WHAT IT IS / WHY IT HURTS / WHAT TO DO INSTEAD`. None of them are "just style".

---

## 2. P0 — Pacing & timing (the actual user complaint)

### P0-1. CosyVoice `speed` is never passed to the model
- **What it is.** `synthesize_segments_cosyvoice` builds `cl_args` / `zs_args` with `tts_text`, `prompt_*`, `stream=False`, but never sets `speed`. Upstream signatures: `inference_zero_shot(..., speed=1.0)` and `inference_cross_lingual(..., speed=1.0)`.
- **Why it hurts.** CosyVoice mel-interpolates the duration *during synthesis*. We do nothing inside the model and instead apply `ffmpeg atempo` afterwards.
- **What to do instead.** Pass `speed = clamp(target_dur / predicted_dur, 0.85, 1.15)` to the inference call, then run **only a small** `atempo` (≤1.05× / ≥0.95×) for residual fitting. This is what upstream demos use. It eliminates the 1.5–1.8× post-hoc warp.

### P0-2. `fit_audio_to_duration` allows extreme ratios
- **What it is.** `min_ratio = 0.55` (short segs) / `0.65` (≥2 s). Equivalent to letting voice run at up to ≈1.82× / 1.54× speed.
- **Why it hurts.** This is the audible "2× sometimes" defect. Hindi translations are typically 25–40% longer than English; a 6 s English line can become a 9 s Hindi line, then we squash it back to 6 s ⇒ ≈1.5×.
- **What to do instead.** Cap atempo at `0.95–1.10` once `speed=` is used inside the model. If the residual is still > 1.10×, prefer to:
  - (a) ask Gemini for a tighter rewrite (one retry pass with `target_chars` budget), or
  - (b) extend the segment slot by stealing time from the gap before/after (only when the gap > 250 ms), or
  - (c) overflow into the next gap silently — never truncate mid-word.

### P0-3. Hard truncation + 60 ms fade clips end syllables
- **What it is.** In `assemble_dubbed_audio`: `if len(data) > max_seg_samples: data = data[:max_seg_samples]` with a fixed 60 ms fade.
- **Why it hurts.** Hindi/Tamil endings carry semantic vowels (ता, ें, ं). Truncation drops them. Even with the fade it sounds like a swallowed word.
- **What to do instead.** Eliminate truncation. After (P0-1)+(P0-2) the residual overflow should be sub-200 ms. Allow up to 300 ms overflow into the inter-segment gap; only when the *next* segment is about to start do you trim — and trim **silence padding** at the tail (`librosa.effects.trim` with `top_db=40`) instead of voiced samples.

### P0-4. Translation does not encode a duration budget
- **What it is.** The prompt says *"Keep each translation close to the original segment duration"* and gives qualitative ranges ("3 s–6 s: one natural sentence"), but no per-segment character/word budget. No second pass when output is too long.
- **Why it hurts.** The model frequently overruns by 30–60%, then the timing layer must compensate with brutal speedup.
- **What to do instead.** Compute a per-segment **target speaking duration** = `(end - start) - 0.10 s` and pass it as `target_seconds` AND a `max_chars` budget (calibrated per language: e.g. Hindi ~14 chars/s, English ~17 chars/s, Tamil ~12 chars/s). Add a JSON field `tts_text_short` so we can take a tighter rewrite when the first one overshoots. After translate, measure each `tts_text` length — if `predicted_dur > target * 1.15`, fire **one** Gemini "shorten this segment" retry per overshoot.

### P0-5. `speaking_rate` from Gemini is dead code for CosyVoice
- **What it is.** Gemini returns `speaking_rate ∈ [0.9, 1.2]` per segment. We clamp it. We feed it to `edge-tts` (`rate_pct = (rate-1)*100`). We never feed it to CosyVoice.
- **Why it hurts.** A finely tuned per-segment rate is computed and discarded.
- **What to do instead.** Multiply `speed` (P0-1) by `seg["speaking_rate"]` before clamping, so emotion-driven rate variation actually reaches the model.

### P0-6. Original ASR timestamps used as fixed targets
- **What it is.** Each TTS segment is placed at `seg["start"]` regardless of how long the produced audio is. Overflow is hard-cut.
- **Why it hurts.** A 5.0 s source segment that becomes a 6.2 s Hindi line at `speed=1.0` is squashed to 5.0 s; the next segment starts at the original next start, so there is no ripple-extension mechanism. This is why some sentences sound rushed and the next one sounds fine.
- **What to do instead.** Treat segment placement as a **time-allocation problem** with constraints, not a fixed schedule:
  1. Compute predicted CosyVoice duration per segment (run a fast heuristic: ~0.075 s × characters for Hindi).
  2. Build a "budget table": for each segment, target = (next_start - this_start - safe_pad).
  3. Greedy fit: allow up to 10% overrun and steal time from the *next* gap if the next segment starts with > 250 ms silence.
  4. Only then call CosyVoice with a per-segment `speed`.

### P0-7. `merge_segments_for_dubbing` includes inter-segment gaps in target duration
- **What it is.** Two short segments `[0.0–1.5]` and `[1.7–3.2]` (gap 0.2 s) merge to `[0.0–3.2]`. TTS produces audio for the **3-second sentence**, but the slot now includes the 200 ms of original silence. So the synthesized audio either:
  - (a) drifts later (if it's shorter than 3.2 s), or
  - (b) has to be fitted to 3.2 s via atempo (longer if the merged sentence is naturally short).
- **Why it hurts.** Subtle bunched/sparse pacing; not the dominant complaint but it compounds with P0-2.
- **What to do instead.** When merging, store both `merged_speech_duration ≈ sum(source speech durations)` AND `merged_slot_duration = end - start`. Use the slot for placement and the speech duration for the speed target.

---

## 3. P1 — CosyVoice 2/3 integration quality

> Cross-checked against upstream `cosyvoice/cli/cosyvoice.py`. All claims below are based on actual upstream signatures.

### P1-1. `inference_*` is called with a file path for `prompt_wav`, but upstream expects a 16 kHz tensor
- **What it is.** `_load_ref()` saves a 16 kHz file then passes the path string when the constructor signature contains `"prompt_wav"`. Upstream `frontend_zero_shot(i, prompt_text, prompt_wav, sample_rate, ...)` calls `prompt_wav` like a tensor: `prompt_wav.to(self.device)` etc.
- **Why it hurts.** With official upstream, this would raise `AttributeError`. The fact that it works in our deployment means the build is using a fork that accepts paths, OR the only working path is the `prompt_speech_16k` branch (which IS what upstream uses but under a different keyword in older forks). This makes the code fragile across CosyVoice releases.
- **What to do instead.** Always pass the loaded **tensor** under the canonical kwarg `prompt_speech_16k`. Drop the `"prompt_wav" if present, else prompt_speech_16k"` heuristic.

### P1-2. `inference_instruct_text` flag is a no-op
- **What it is.** `_instruct_param()` looks for `instruct_text/instruct/instruction/prompt_instruction` in the parameter set of `inference_zero_shot` / `inference_cross_lingual`. Upstream signatures have **none** of these. Only `inference_instruct2` does.
- **Why it hurts.** Emotion ("excited", "serious", etc.) returned by Gemini is silently dropped. The dub is always neutral-toned.
- **What to do instead.** When emotion ≠ neutral and the model is CosyVoice2/3, switch to `inference_instruct2(tts_text, instruct_text=f"用{emotion}的语气说", prompt_wav=...)` (works for Chinese instruction, generalizes for English with `"speak in a {emotion} tone"`). For neutral lines, keep zero_shot/cross_lingual.

### P1-3. CosyVoice 3 prefix `You are a helpful assistant.<|endofprompt|>` is being injected in the wrong field
- **What it is.** When `is_cosyvoice3` we prepend that prefix to BOTH `prompt_text` (in zero-shot) AND `tts_text` (in cross-lingual). Upstream CosyVoice3 inherits CosyVoice2's frontend; the special token is part of the **chat-style prompt template** that the upstream `frontend_*` functions construct internally. Manually injecting it again is double-wrapping.
- **Why it hurts.** The Qwen2 tokenizer treats `<|endofprompt|>` as `<|endoftext|>`-class; injecting it in `tts_text` truncates the TTS context, leading to dropped or hallucinated content.
- **What to do instead.** Remove this manual prefix entirely. The upstream frontend handles it. If newer Fun-CosyVoice3 changes the format, surface that as a `cosyvoice3 API change` upgrade in code rather than a hand-mangled string.

### P1-4. AutoModel selection is correct but `is_cosyvoice3` detection is fragile
- **What it is.** `is_cosyvoice3 = bool(re.search(r"fun.cosyvoice3|cosyvoice3", _model_path_lower))`. Path string matching breaks when the model is symlinked to `iic/Fun-CosyVoice3-0.5B`.
- **What to do instead.** Inspect `model.__class__.__name__` (`CosyVoice3`, `CosyVoice2`, `CosyVoice`) — same source-of-truth that upstream `AutoModel` uses.

### P1-5. Reference audio capped at 30 s (best practice ~5–10 s)
- **What it is.** `_load_ref` clamps to 30 s.
- **Why it hurts.** Long, varied references confuse the speaker encoder, especially when the source has crowd/overlap. Per-speaker similarity drops.
- **What to do instead.** Cap at 10 s. When choosing clips in `extract_speaker_reference`, score by `(loudness × low-noise-energy × duration)` and prefer the *single* longest clean clip rather than a concatenation of fragments. Concatenation can change pitch contour.

### P1-6. Demucs vocals used as the cloning reference
- **What it is.** When `USE_DEMUCS=true`, `reference_audio = vocals_path` (Demucs output) is used as the prompt for CosyVoice.
- **Why it hurts.** Demucs introduces phase artifacts and metallic tails. Source-separated vocals are **good for diarization/ASR** but **worse for cloning** than the original mix when the original speaker is not buried in heavy music.
- **What to do instead.** Keep Demucs only for transcription + background extraction. Use the **original audio** (high-pass / loudness-normalised) for the speaker reference unless music level is loud (RMS heuristic).

### P1-7. Sample-rate save: hardcoded `24000` is right for v2/v3 but should track `model.sample_rate`
- **What it is.** `torchaudio.save(..., 24000)` regardless of model.
- **Why it hurts.** Today both v2.yaml and v3.yaml report `sample_rate: 24000`, so this happens to work — but if the build switches to the legacy 22050 model or a 16 kHz variant, audio plays back at the wrong pitch.
- **What to do instead.** `torchaudio.save(out_path, audio_data, model.sample_rate)`.

### P1-8. No real load_jit / fp16 / load_vllm / load_trt usage on GPU
- **What it is.** `_init_kw` always sets `load_jit=False, load_trt=False`. fp16 is left at default. `load_vllm` is never set even though CosyVoice2-0.5B fully supports vLLM (≈3× faster).
- **Why it hurts.** Cold inference time and per-segment latency are 2.5–3× higher than they need to be. This is most of the "voice cloning takes 30+ minutes" problem on long videos.
- **What to do instead.** On g5.xlarge / g4dn.xlarge, set `fp16=True` (CosyVoice supports it) and `load_jit=True` for v2. For v3, you can additionally set `load_trt=True` if a `flow.decoder.estimator.{fp16/fp32}.mygpu.plan` is baked into the image (it's not currently — recommendation: bake it once at base image build).

### P1-9. Gemini emotion is computed but transition between emotions is abrupt
- **What it is.** Each segment is synthesized in isolation; emotion changes hard at segment boundaries.
- **What to do instead.** When emotion changes mid-conversation, smooth the speed/loudness across the transition (50–100 ms crossfade in `assemble_dubbed_audio`), and keep emotion windows ≥ 2 segments to avoid jitter.

### P1-10. Per-segment audio is generated fully sequentially
- **What it is.** A simple `for seg in segments` loop calls `model.inference_*` one segment at a time. No batching, no asyncio, no parallel workers.
- **Why it hurts.** With ~80 segments for a 10-min video this is the dominant cost (>60% of wall time). The GPU is idle waiting for each LLM token.
- **What to do instead.** Two options, both upstream-supported:
  - (A) **Mini-batched LLM inference**: enable `load_vllm=True` for v2 and run 4–8 segments in parallel through vLLM's continuous batching. ~2.5× speedup on a single A10G.
  - (B) **Pipeline parallelism**: keep model in CUDA stream A; preprocess (frontend tokenize + reference embed cache) for the next 4 segments in stream B. With a `concurrent.futures.ThreadPoolExecutor(max_workers=2)` and per-thread CUDA streams it gives ~1.7× speedup with no model changes.
  - The simplest first move is (A) for cosyvoice2 and (B) for cosyvoice3.

### P1-11. No per-segment retry — first failure inserts silence
- **What it is.** `synthesize_all` falls back to `synthesize_silence_single` after one CosyVoice exception per segment.
- **Why it hurts.** Transient OOMs leave entire segments silent.
- **What to do instead.** Per-segment retry: 1× retry on CUDA OOM (after `torch.cuda.empty_cache()`), then one fallback to `inference_zero_shot` with default reference, then to `edge-tts`, then silence. Today silence kicks in too eagerly.

---

## 4. P1 — Translation pipeline

### P1-12. Single Gemini call for all segments
- **What it is.** `translate_segments` builds one big JSON of all segments and asks Gemini to translate everything in one shot.
- **Why it hurts.** Gemini Pro hard caps at ~65 K output tokens; for long videos we routinely fill 80–200 segments, easily 30–60 K output tokens — close enough to the cap to cause partial truncation, which the code does **not** detect (it raises only on missing IDs, not on truncated `translated_text`). Truncated segments with empty `tts_text` then fall back to `translated_text`, which may be empty, which generates anullsrc silence.
- **What to do instead.** Chunk by N segments (e.g. 25) with the same `prev_text/next_text` overlap windows, run them in parallel (`asyncio.gather` with up to 3 concurrent calls), then merge. Validate `translated_text != ''` per segment and retry the chunk if any are blank.

### P1-13. Gemini retry-rotation reset can loop indefinitely on transient failure
- **What it is.** Inside `translate_segments`: when `attempts >= 3` and a key remains, `attempts = 0` is reset. There's no global cap.
- **Why it hurts.** With 3 keys this is up to 3×3=9 attempts but the reset construct is brittle; a future fourth key would extend the loop.
- **What to do instead.** Track `total_attempts` separately and cap at 9. Use exponential backoff with jitter (10s, 30s, 60s caps). On 429s rotate immediately; on 5xx wait + retry same key first.

### P1-14. `TRANSLATION_MODEL` defaults to `gemini-3.1-pro-preview`
- **What it is.** Worker hardcodes Pro for translation. The Lambda fast path uses `gemini-2.5-flash`.
- **Why it hurts.** Pro is ~25× slower and more expensive per request than Flash. For 99% of translations Flash is more than enough and would not have the 65 K-token throughput choking we see.
- **What to do instead.** Default to `gemini-3-flash-preview` (or the latest 3.1-flash-preview when GA). Reserve Pro as a *retry-on-quality-fail* path (when translation fails QA gate — see P1-15).

### P1-15. No translation QA gate
- **What it is.** Whatever Gemini returns is fed into TTS as-is.
- **Why it hurts.** When Gemini occasionally outputs Hinglish (Roman-script Hindi) instead of Devanagari, CosyVoice (which Devanagari-tokenises) reads it letter-by-letter and produces gibberish.
- **What to do instead.** Add a per-segment script regex check matching `target_script_instruction()` (e.g. for Hindi: at least 80% of non-space characters in `tts_text` must match `[\u0900-\u097F]`). If it fails, retry that segment with Pro and explicit "use Devanagari only" reminder.

### P1-16. Acronym pronunciation rules are duplicated in two places and slightly different
- **What it is.** `TRANSLATION_SYSTEM_PROMPT` instructs Gemini to spell out acronyms in `tts_text`. `_PRONUNCIATION_REPLACEMENTS` regex-replaces them again client-side. They overlap (BJP, RSS, AAP, …) but `_PRONUNCIATION_REPLACEMENTS` only fires when target language is in `{hi, en, mr, ne, sa}`.
- **Why it hurts.** When Gemini already expands "BJP" → "बी जे पी" and the client also runs `r"\bBJP\b"` that no longer matches Hindi text — fine. But for Marathi/Nepali the spell-out is in the regex only, not in the prompt. And "PM" in Hindi context can be context-dependent (could be "प्रधानमंत्री" instead of letter-by-letter).
- **What to do instead.** Make Gemini the single source of truth for acronym handling. Drop the client regex except as an *emergency safety net* with a `if not already_in_native_script` guard.

### P1-17. `prev_text`/`next_text` snippets are fixed at 140 chars
- **What it is.** Truncated to 140 chars in `_context_snippet`.
- **Why it hurts.** Loses cross-sentence pronoun resolution context for long sentences.
- **What to do instead.** 250–300 chars is fine. The whole prompt is well below Gemini's 1 M context budget.

---

## 5. P1 — ASR / segmentation

### P1-18. `merge_segments_for_dubbing` thresholds chosen for English
- **What it is.** Hard caps at 14–16 s, target 2.5–8 s, gap 1.2–2.4 s.
- **Why it hurts.** Dubbing-language expansion is not modeled — a 5-s English segment becomes a 7+ s Hindi slot we then have to squash. Plus, we merge across `gap < 2.4 s`, so a 2-s pause gets stuffed into a single TTS sentence.
- **What to do instead.** Tighter thresholds: target 4–7 s, max 12 s, gap < 800 ms (not 2400 ms). Re-tune per language using the source/target token-rate ratio as input.

### P1-19. AssemblyAI single-speaker fallback drops utterance boundaries
- **What it is.** When `MULTI_SPEAKER=False`, code uses raw word stream and groups by 0.45 s pauses + 8 s window. AssemblyAI utterances (which carry speaker turns) are skipped.
- **Why it hurts.** Speaker changes within a segment are missed in single-speaker mode.
- **What to do instead.** Always run utterance-based segmentation; treat single-speaker just as "all utterances belong to SPEAKER_A".

### P1-20. ASR runs on Demucs vocals — overlap speech can disappear
- **Already covered in P1-6.** Worth noting: when the source has overlapping speakers (interview, panel), Demucs sometimes wipes one of the speakers' vocals. ASR then misses entire turns, and cloning skips them.

---

## 6. P1 — Mixing & loudness

### P1-21. Loudness normalization runs **only** in the Demucs+background mix path
- **What it is.** When background_audio is present, the mix uses `loudnorm=I=-16:TP=-1.5:LRA=11`. When voice-only (no Demucs), no loudnorm.
- **Why it hurts.** Voice-only output is noticeably quieter or louder than the user's other tabs, with random per-segment loudness because each CosyVoice utterance has its own peak.
- **What to do instead.** Run a final pass `loudnorm=I=-16:TP=-1.5:LRA=11` on every dubbed audio before the mux — voice-only or mixed.

### P1-22. Per-segment crossfades absent
- **What it is.** Segments are placed at `int(start * SR)` with no crossfade — direct sample-level addition.
- **Why it hurts.** Segment boundaries can click, especially after fades.
- **What to do instead.** 20–30 ms equal-power crossfade at every boundary.

### P1-23. Segment-tail `top_db=35` trim removes voiced fricatives
- **What it is.** `librosa.effects.trim(seg_audio, top_db=35)` in `extract_speaker_reference` is aggressive.
- **What to do instead.** Use `top_db=40` which preserves voiced consonants (ssh, fff) that are important for the speaker encoder.

---

## 7. P1 — Concurrency / parallelism (worker level)

### P1-24. Worker is fully synchronous
- **Already noted in P1-10**. No `asyncio`, no thread pool, no Ray/joblib. Stages run sequentially.
- **What to do instead.** Stage-level pipelining:
  ```
  Demucs ──┐
  ASR ─────┼─ run in parallel after audio extraction
  ─────────┘
  ```
  ASR and Demucs are independent (Demucs runs on GPU, AssemblyAI is HTTP — they CAN overlap fully). Saves ~30 s on every job.

### P1-25. DynamoDB updates fired for every segment
- **What it is.** During cloning, every segment sends a DDB `UpdateItem`. For 80 segments that's 80 writes, with `stepsJson` (a multi-KB JSON string) re-written each time.
- **Why it hurts.** ~80 × 3 KB = 240 KB of WCUs per job; on a busy queue this trips throttling and slows the worker (DDB writes are 30–80 ms each on Lambda VPC).
- **What to do instead.** Throttle: write at most every 2 seconds OR every N=5 segments, whichever comes first. Always write at the end of the stage.

---

## 8. P2 — API / runtime selection

### P2-1. Lambda fast path is silently invoked when user wanted dubbing
- **What it is.** `isLambdaFastCandidate` returns true when `translationMode === "subtitle-only"`. The frontend never sets that mode — but if the API caller does, dubbing is silently skipped and the original video is returned with subtitles only. UI shows a warning AFTER the fact.
- **What to do instead.** Make `translationMode` an explicit choice in the UI ("Full dubbing" vs "Subtitles only" vs "Burn-in subtitles"). Never default to subtitle-only without a user choice.

### P2-2. CPU Fargate route requires neither voiceClone nor lipSync
- **What it is.** `isCpuBatchCandidate` only fires when both are false. Then it runs `worker.py` with `VOICE_CLONE=false`, which runs full ASR/translate/edge-tts/mix on Fargate CPU.
- **Why it hurts.** Edge-tts is fine quality-wise. But this code path uses the same `worker.py`, which is GPU-shaped (Demucs CPU is 5×slower than GPU; pyannote skipped; CosyVoice deps still imported on every run). Unnecessary cold start.
- **What to do instead.** Either:
  - (a) split into a leaner CPU worker that only does ASR + translate + edge-tts + mux (no Demucs, no CosyVoice imports), or
  - (b) keep the unified worker but make all GPU-only imports lazy.

### P2-3. Batch timeout = 3000 s (50 min) is too tight for 30+ minute videos with lipsync
- **What it is.** Default 3000 s.
- **Why it hurts.** A 25-min video with multi-speaker + clone + lipsync routinely runs > 50 min. User sees a confusing "stopped after 50 min" error.
- **What to do instead.** Make timeout proportional to source video duration: `timeout = max(900, source_duration_s × 6)`.

### P2-4. `syncTerminalBatchState` re-checks SUCCEEDED jobs every poll
- **What it is.** Every `/status` poll re-runs `DescribeJobs` + `HeadObject`.
- **Why it hurts.** Polling at 2 s × N concurrent users multiplies AWS API calls.
- **What to do instead.** Cache terminal state lookups for at least 30 s; skip if `status` is already terminal.

### P2-5. `gemini-3-flash-preview` not available before late 2025; we now run `gemini-3.1-pro-preview`
- Current usage is correct since [Google has `gemini-3.1-pro-preview` GA-preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview). But **cost** is the issue (P1-14). Re-check pricing before defaulting to Pro.

---

## 9. P2 — UX / control

### P2-6. User cannot preview transcript before dubbing
- **What it is.** Today: Upload → click → wait 30 minutes → see result. If translation is bad, the only fix is re-run.
- **What to do instead.** Two-phase UX:
  1. Phase A (~3 min): ASR + translate; show transcript table with editable `translated_text` per row, original on the left, target on the right.
  2. User clicks "Generate dub" → Phase B (CosyVoice + mux) starts.
  3. Phase A result is cached so re-edits don't re-run ASR.

### P2-7. UI exposes only "Original / Female"
- **What it is.** No control over speed-tightness, loudness, lipsync quality (admin-only), output format.
- **What to do instead.** Add an Advanced section: target speaking pace, voice match strictness, mute/keep background music, output bitrate, srt-burn-in.

### P2-8. `voiceStyle === "original"` triggers `voiceClone=true` AND `multiSpeaker=true` always
- **What it is.** Frontend wires `multiSpeaker = isVoiceClone`. No way to disable diarization.
- **Why it hurts.** Single-speaker videos (vlogs) waste 1–2 minutes of pyannote/diarization time and risk over-segmentation when AssemblyAI utterances are noisy.
- **What to do instead.** Auto-detect from the first 10 s of audio: if only one speaker turn, skip diarization entirely.

### P2-9. Polling at 2 s is wasteful
- **What it is.** Frontend polls every 2 s with 12+ DDB attributes including `stepsJson`.
- **What to do instead.** Use SSE (already in `lib/sse.ts`) or WebSocket. If polling stays, back off to 5 s after the first 60 s.

### P2-10. Debug log truncated to 50 entries — long jobs lose history
- **What it is.** `setDebugLog(prev => [...prev.slice(-49), entry])`.
- **What to do instead.** 200 entries client-side; full log available via `Download log` button (server-side rendering of CloudWatch logs is overkill, but the per-job report JSON should already include the last 100 step messages).

---

## 10. P2 — Robustness / cost

### P2-11. `ALLOW_VOICE_CLONE_FALLBACK` defaults to true → silent quality drop
- **What it is.** Voice clone fails → silently falls back to edge-tts neural voice. UI shows a small badge but if the user doesn't notice, they ship a non-cloned dub.
- **What to do instead.** Default to **strict** mode (`false`), but expose a UI toggle: "Allow neural voice fallback if cloning fails (faster, less personal)". Default off for power users, on for casual.

### P2-12. `ALLOW_LIP_SYNC_FALLBACK` defaults to false → entire job fails on lipsync error
- **Inverse problem.** A 25-min job that finishes everything except lipsync gets thrown away.
- **What to do instead.** Default to **true** (fall back gracefully) and surface a clear "Lipsync failed, dubbed audio only" warning.

### P2-13. No idempotency on submit — duplicate uploads create duplicate jobs
- **What to do instead.** Hash file content client-side; reject duplicates with a "you already translated this" prompt that links to the existing job.

### P2-14. `mark_failed` writes `_LAST_PIPELINE_PROGRESS` (which is the last successful progress) — looks like a partial completion
- **Cosmetic but confusing.** Failure UI shows "FAILED 65%". Better to keep the % at the failure stage start and add a clear `failedStage` field.

### P2-15. No metric on translation length ratio or speed warp ratio
- **What it is.** No telemetry to detect when an output dub is doing 1.6× warp.
- **What to do instead.** Compute and emit per-segment metrics: `translation_length_ratio`, `cosyvoice_predicted_dur`, `applied_speed`, `applied_atempo`. Store in `translation_report.json` and aggregate in CloudWatch.

---

## 11. P3 — Hygiene / nits

### P3-1. `pip install demucs` lazy fallback, but demucs is in `requirements.txt` already
- **Dead code.** The `if importlib.util.find_spec("demucs") is None` lazy install in `run_demucs` will never fire. Remove it.

### P3-2. `pyannote` lazy install path still present even though most jobs skip diarization
- **Dead code or actually useful?** It's gated on `HF_TOKEN`; if absent, code returns early. Remove the `pip install` line and require pyannote in the GPU image only when `HF_TOKEN` is provisioned.

### P3-3. `_ensure_cosyvoice_yaml_compatibility` re-installs deps at runtime
- **What it is.** Reinstalls `einops, hydra-core, lightning, pyarrow, pyworld, rich, ruamel.yaml, x-transformers` if any are missing.
- **Why it's a nit.** All of these are already pinned in `requirements.txt` and baked at build time. The runtime install is dead code that adds 30 s on first cold start of CPU runs (where versions might drift). Either:
  - (a) add a smoke test in `worker.py:main` (not before each segment), or
  - (b) trust the build-time `pyflakes`/import smoke test in Dockerfile.base.

### P3-4. `_safe_speaking_rate` clamps to [0.9, 1.2] but Gemini is asked for [0.9, 1.2]
- Pointless guard. Either widen Gemini's range to [0.85, 1.25] (more dynamic prosody) or remove the clamp.

### P3-5. `END_PUNCTUATION` set lacks `；：` and Korean `？`/`！`
- Minor.

### P3-6. `PRONUNCIATION_LANG_CODES = {"hi","en","mr","ne","sa"}` excludes Bengali, Tamil, Telugu, Gujarati
- Acronym pronunciation rules don't fire for those languages. Inconsistent.

### P3-7. `PIPELINE_STEPS` defined in worker.py AND VideoTranslator.tsx with slightly different boundaries
- Should live in one place (`docs/translator-pipeline.md` referenced by both, or a shared `lib/translator-stages.ts`).

### P3-8. `requirements.txt` lists `demucs==4.0.1` twice
- Cosmetic.

---

## 12. Cost ceiling estimate (for reference)

| Item | Per 10-min job | Notes |
|---|---|---|
| g4dn.xlarge spot | ~$0.05 | Today |
| g5.xlarge spot   | ~$0.10 | Recommended for v3 + lipsync |
| AssemblyAI       | ~$0.10–0.20 | Per-min pricing |
| Gemini 3.1 Pro   | ~$0.40 | Translation w/ Pro |
| Gemini 3 Flash   | ~$0.04 | Recommended default |
| **Total today**  | **~$0.55–0.75** | |
| **Target after fixes** | **~$0.20–0.30** | Flash + faster GPU jobs |

---

## 13. Action plan (priority-ordered, when you say go)

### Phase 1 — Stop the chipmunk effect (4–6 h work)
1. **P0-1** Pass `speed=` to CosyVoice from `seg["speaking_rate"] × duration_target_ratio`.
2. **P0-2** Cap `atempo` residual to `0.95–1.10`.
3. **P0-3** Replace hard-cut-with-fade by silence-only tail trim + ≤300 ms gap overflow.
4. **P0-7** Track `merged_speech_duration` separately from slot.
5. **P1-7** Use `model.sample_rate` for save.
6. **P1-3** Remove manual `<|endofprompt|>` prefix injection.

Acceptance: test 5 hand-picked English-→-Hindi clips. Voice should never sound chipmunky; max measured atempo ≤ 1.10×; no truncated end-syllables.

### Phase 2 — Translation correctness (1 day)
7. **P0-4** Per-segment `target_seconds` + `max_chars` budget.
8. **P1-12** Chunk Gemini calls, run 3 in parallel.
9. **P1-15** Native-script QA gate + Pro retry.
10. **P1-14** Default to Flash, Pro only on QA fail.
11. **P1-13** Sane retry with global cap.

### Phase 3 — Speed & quality of cloning (1–2 days)
12. **P1-1** Always pass `prompt_speech_16k` (tensor) — drop the path-string heuristic.
13. **P1-2** Use `inference_instruct2` for non-neutral emotions on v2/v3.
14. **P1-5** Cap reference audio at 10 s, choose single best clip.
15. **P1-6** Use original mix (not Demucs vocals) as reference unless heavy music.
16. **P1-8** Enable `fp16=True` and `load_jit=True` on GPU.
17. **P1-10** vLLM batching for v2 (or thread-pool pipelining for v3).
18. **P1-11** Per-segment retry-with-fallback chain.

Acceptance: 80-segment job goes from ~25 min to ~10 min; speaker similarity score (CAMPP+) unchanged.

### Phase 4 — Mixing polish (4–6 h)
19. **P1-21** Final loudnorm even in voice-only path.
20. **P1-22** 20–30 ms equal-power crossfades.
21. **P1-24** Run Demucs + AssemblyAI in parallel.

### Phase 5 — Observability + UX (2–3 days)
22. **P2-15** Emit pacing metrics to translation_report.json.
23. **P2-6** Two-phase UX with editable transcript before dub.
24. **P2-7** Advanced UI controls (speaking pace, music keep/mute, srt burn-in).
25. **P2-8** Auto-skip diarization on single-speaker videos.
26. **P2-9** Switch to SSE for status.
27. **P2-1** Make translationMode an explicit UI choice.
28. **P2-3** Dynamic Batch timeout.

### Phase 6 — Hygiene
29. **P3-1, P3-2, P3-3** Remove dead lazy installs.
30. **P3-7** Single source of truth for pipeline stages.
31. **P3-8** Dedup requirements.txt.

---

## 14. Files this work will touch (when you approve)

| File | Phase | LOC est. |
|---|---|---|
| `artifacts/video-translator-service/worker.py` | 1, 2, 3, 4, 6 | ~600 changed / +200 |
| `artifacts/api-server/src/routes/translator.ts` | 5, 6 | ~200 changed |
| `artifacts/yt-downloader/src/pages/VideoTranslator.tsx` | 5 | ~400 changed |
| `artifacts/video-translator-service/Dockerfile.base` | 3 | TRT plan + load_jit caches |
| `artifacts/video-translator-service/requirements.txt` | 6 | dedup |

---

## 15. Risks / things to watch

- Phase 3 (CosyVoice load_jit/fp16) sometimes regresses on certain GPUs. Roll out behind an env flag `COSYVOICE_FP16=true` so we can flip per-environment.
- The two-phase UX (Phase 5) is the biggest UX change; it needs a backend `pause-after-translate` checkpoint. Could be deferred to a v2 of the tab if the quality fixes alone satisfy the user.
- vLLM (P1-10 option A) needs CosyVoice2-0.5B with vLLM weights (`vllm/` dir). Current Dockerfile.base does NOT bake those — would add ~500 MB to the image.

---

*End of audit.*
