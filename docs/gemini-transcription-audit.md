# Gemini Transcription Audit and Implementation Handoff

Date: 2026-06-14

## User Requirement

Replace AssemblyAI as the default transcriber in the translator pipeline.

Required behavior:

- Use Gemini for transcription when source audio/video duration is 17 minutes or less.
- Use AssemblyAI only when source audio/video duration is greater than 17 minutes.
- Gemini must return accurate speaker start/end timing, exact source-language speech text, and short translation-ready segments.
- Segment length should follow natural speaking rhythm:
  - usually 1-6 words for short utterances,
  - up to 12-15 words only when the speaker continues without a meaningful pause,
  - split when the speaker pauses, changes speaker, or completes a phrase.
- The desired behavior is HeyGen-style audio-aware segmentation: if the speaker talks continuously at a consistent pace with no real 1-2 second pause, keep the full thought in one longer segment; if the speaker says only a short phrase and then pauses, keep that phrase as its own short segment.
- The transcription output must remain compatible with the existing translation, dubbing, subtitles, transcript JSON, speaker cloning, and timing-fit stages.

This report is for the implementation agent. No source behavior has been changed by this audit.

## HeyGen-Style Segmentation Target

The user provided screenshots from HeyGen showing the desired segmentation behavior. This is the key quality bar for Gemini transcription.

Observed examples from the screenshots:

- `00:00:00.070 -> 00:00:18.429`: one long segment because the speaker continues steadily without a meaningful pause. Even though the segment contains a lot of text, it is correct because the audio is continuous and the thought is continuous.
- `00:00:18.589 -> 00:00:21.670`: short segment because the speaker says a short phrase and then breaks.
- `00:00:26.989 -> 00:00:28.829`: short segment because it is a compact spoken instruction.
- `00:00:31.269 -> 00:00:34.670`: short/medium segment because it contains one complete spoken idea.
- `00:00:43.100 -> 00:00:49.260`: medium segment because the speaker continues the sentence naturally.
- `00:00:51.640 -> 00:01:03.640`: longer segment because the speaker continues a connected explanation without a real 1-2 second pause.
- `00:01:05.939 -> 00:01:08.759`: short segment because the speaker starts a new small phrase after a break.
- `00:01:08.840 -> 00:01:19.520`: longer segment because the speaker continues a connected thought.

Implementation meaning:

- Do not force every segment to 6 words.
- Do not force every segment to a fixed maximum duration.
- Let Gemini listen to the actual audio and decide boundaries from speech rhythm.
- A long segment is good when there is continuous speech and no meaningful pause.
- A short segment is good when the speaker says a short phrase and pauses.
- A segment boundary should represent an audible speaking boundary, not just a text-length rule.
- The transcript should feel like a professional dubbing/transcription tool timeline: long continuous speech stays together; short paused speech becomes short clips.
- The existing `merge_segments_for_dubbing()` should become a safety net, not the primary tool for repairing bad ASR segmentation. Gemini should already return natural segments.

## External Gemini Capability Check

Google's current Gemini docs support this direction:

- Gemini audio understanding supports transcription, translation, timestamps, speaker diarization, emotion detection, and structured outputs.
  Source: https://ai.google.dev/gemini-api/docs/audio
- Google also documents the newer Interactions API audio workflow with timestamped transcription and speaker diarization. It is beta, so this repo should initially use the existing `generateContent` SDK path unless there is a deliberate migration.
  Source: https://ai.google.dev/gemini-api/docs/interactions/audio
- Gemini structured outputs can constrain responses to JSON schema, which is important here because downstream code expects a strict segment shape.
  Source: https://ai.google.dev/gemini-api/docs/structured-output

## Current Root Cause

The bad transcription quality is not only a translation problem. The translator pipeline currently builds all segment timing from AssemblyAI word/utterance output, then translation and TTS inherit those boundaries.

The repo has two separate AssemblyAI transcription paths:

1. Full translator worker path in Python:
   - `artifacts/video-translator-service/worker.py:570`
   - `transcribe(audio_path)` currently uploads audio to AssemblyAI and builds timed segments.
   - Main pipeline calls this at `worker.py:5718`, `worker.py:5747`, and `worker.py:5752`.

2. Lambda fast subtitle-only path in TypeScript:
   - `artifacts/api-server/src/routes/translator.ts:954`
   - `transcribeFastAudio(audioPath, sourceLang)` uses AssemblyAI upload + polling.
   - `artifacts/api-server/src/routes/translator.ts:1048`
   - `transcribeFastMediaUrl(mediaUrl, sourceLang)` uses AssemblyAI directly from an S3 signed media URL.
   - `processLambdaFastTranslation()` calls `transcribeFastMediaUrl()` at `translator.ts:1176`.

If only `worker.py` is changed, subtitle-only fast translations will still use AssemblyAI and continue producing the same bad segmentation. Both paths need the same Gemini-first policy.

## Existing Contracts That Must Not Break

### Python worker segment schema

`worker.py:579` documents the expected return from `transcribe()`:

```json
{
  "id": 1,
  "start": 0.0,
  "end": 2.4,
  "text": "source language transcript",
  "words": [
    { "word": "source", "start": 0.0, "end": 0.4 }
  ],
  "speaker": "SPEAKER_A"
}
```

Downstream code depends on:

- `start` and `end` in seconds.
- `text` as the exact source transcript.
- `words` as word-like timing items for speech duration calculations.
- `speaker` when `MULTI_SPEAKER=true`, or preferably always as `SPEAKER_A` by default.

Important downstream consumers:

- `diarize(audio_path, segments, ...)` at `worker.py:784` can override or add speaker labels.
- `_segment_speech_duration()` at `worker.py:1248` prefers `words[0].start` and `words[-1].end`.
- `merge_segments_for_dubbing()` at `worker.py:1262` merges micro-segments and respects speaker labels.
- `annotate_dub_windows()` at `worker.py:1197` computes pause-aware timing windows.
- `translate_segments()` at `worker.py:2410` sends timed segments to Gemini translation.
- `synthesize_segments_cosyvoice()` at `worker.py:2986` sizes speech to the segment windows.
- `generate_srt()` at `worker.py:4828` writes subtitle timings.
- `generate_transcript_json()` at `worker.py:5597` writes final transcript output.

### TypeScript fast path segment schema

`translator.ts` uses:

```ts
type FastSegment = {
  startMs: number;
  endMs: number;
  text: string;
  translatedText?: string;
};
```

Current segment construction:

- `wordsToSegments()` at `translator.ts:857` converts AssemblyAI words into `FastSegment[]`.
- `segmentsToSrt()` at `translator.ts:886` expects milliseconds.
- `translateSegmentsFast()` at `translator.ts:1118` translates those segments using Gemini.
- `processLambdaFastTranslation()` canonicalizes final transcript JSON at `translator.ts:1196`.

Gemini fast transcription must return or be adapted into the same `FastSegment[]` shape.

## Required Architecture Change

Add a provider router, not a one-off replacement.

Policy:

```text
if source_duration_seconds > 17 * 60:
    use AssemblyAI transcription
else:
    use Gemini transcription
```

The cutoff should be configurable:

- Python env: `GEMINI_TRANSCRIBE_MAX_SECONDS`, default `1020`.
- TypeScript env: `GEMINI_TRANSCRIBE_MAX_SECONDS`, default `1020`.
- Model env: `GEMINI_TRANSCRIBE_MODEL`, default same family as existing Gemini config, likely `gemini-3.5-flash` unless testing proves a better transcription model is needed.

Important: this 17 minute rule is a transcription-provider rule, not the same as `TRANSLATOR_LAMBDA_FAST_MAX_SECONDS`.

Current Lambda fast default:

- `translator.ts:83` sets `TRANSLATOR_LAMBDA_FAST_MAX_SECONDS` default to `600` seconds.
- That controls whether subtitle-only Lambda stays in Lambda or hands off to Batch.
- The new Gemini vs AssemblyAI cutoff should still be 17 minutes, but Lambda may still hand off to Batch for runtime reasons. If Lambda keeps its 10 minute cap, the Batch worker must also implement Gemini-first transcription so 10-17 minute jobs still use Gemini after fallback.

Non-negotiable implementation detail:

- The provider router must know duration before choosing Gemini or AssemblyAI.
- Python worker already has `video_duration` in the main pipeline, so pass that into `transcribe(...)`.
- Lambda fast currently learns duration from AssemblyAI's `audio_duration`; that will not work after replacing AssemblyAI. Use `probeS3VideoDuration(s3Key)` before transcription in `processLambdaFastTranslation()`, or download/probe once inside that function before calling the provider router.
- If duration probing fails in Lambda and the media is subtitle-only, prefer Gemini first, but keep a hard timeout and clear metadata `durationProbe: "failed"`. Do not call AssemblyAI just because duration is unknown, unless the emergency fallback env allows it.

## Files and Exact Edits Needed

### 1. `artifacts/video-translator-service/worker.py`

Current AssemblyAI-only area:

- `worker.py:570` stage comment says transcription is AssemblyAI.
- `worker.py:573` has `ASSEMBLYAI_LANG_MAP`.
- `worker.py:579` defines `transcribe(audio_path)`.
- `worker.py:586` imports AssemblyAI inside `transcribe()`.
- `worker.py:593` logs `[AssemblyAI] Uploading and transcribing`.
- `worker.py:595-607` builds AssemblyAI config.
- `worker.py:616-777` adapts AssemblyAI words/utterances into the internal segment schema.

Required changes:

1. Rename current `transcribe()` to `transcribe_assemblyai(audio_path)`.
2. Keep the existing AssemblyAI implementation mostly intact as fallback for duration > 17 minutes and Gemini failure policy if explicitly allowed.
3. Add `transcribe_gemini(audio_path, audio_duration_seconds)`:
   - Uses existing `_get_gemini_client()` at `worker.py:2041`.
   - Uploads/attaches audio using the `google-genai` File API in API-key mode.
   - Uses inline audio bytes in Vertex mode if File API upload is not available for the configured Vertex path, matching the API server's existing subtitle route pattern.
   - Uses structured JSON output if supported by the current SDK path.
   - Parses, validates, clamps, sorts, and normalizes segments.
4. Add provider wrapper:

```python
def transcribe(audio_path: Path, audio_duration_seconds: Optional[float] = None) -> list[dict]:
    duration = audio_duration_seconds or probe duration from audio_path
    if duration > GEMINI_TRANSCRIBE_MAX_SECONDS:
        return transcribe_assemblyai(audio_path)
    return transcribe_gemini(audio_path, duration)
```

5. Update all main pipeline calls:
   - `worker.py:5718`
   - `worker.py:5747`
   - `worker.py:5752`

Current calls:

```python
segments = transcribe(transcription_audio)
```

Update to:

```python
segments = transcribe(transcription_audio, video_duration)
```

6. Update progress text:
   - Current text says `Transcribing speech (AssemblyAI)...`.
   - Change to provider-aware text, for example `Transcribing speech (Gemini)...` or `Transcribing speech (AssemblyAI fallback)...`.

7. Update comments around `worker.py:5688-5703`.
   - They currently assume Demucs and AssemblyAI run concurrently.
   - Gemini transcription still can run concurrently with Demucs when `DEMUCS_BEFORE_ASR=false`, but comments must say ASR provider, not AssemblyAI.

8. Update `_segment_speech_duration()` docstring at `worker.py:1248`.
   - It currently says it prefers AssemblyAI word-level timestamps.
   - It should say it prefers ASR word-level timestamps from Gemini or AssemblyAI.

9. Update any user-facing/log text that says AssemblyAI is always the transcriber.

10. Add transcription metadata to `generate_transcript_json()` at `worker.py:5597`.
    Recommended fields:

```json
{
  "transcriptionProvider": "gemini",
  "transcriptionModel": "gemini-3.5-flash",
  "transcriptionCutoffSeconds": 1020,
  "sourceDurationSeconds": 123.45
}
```

11. Add new worker env config near the existing Gemini/AssemblyAI envs:

```python
GEMINI_TRANSCRIBE_MAX_SECONDS = float(os.environ.get("GEMINI_TRANSCRIBE_MAX_SECONDS", "1020"))
GEMINI_TRANSCRIBE_MODEL = os.environ.get("GEMINI_TRANSCRIBE_MODEL", os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"))
ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK = os.environ.get("ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK", "false").lower() in ("1", "true", "yes")
```

12. In `buildBatchEnvironment()` in `translator.ts`, pass these env vars into Batch:

```ts
{ name: "GEMINI_TRANSCRIBE_MAX_SECONDS", value: process.env.GEMINI_TRANSCRIBE_MAX_SECONDS ?? "1020" },
{ name: "GEMINI_TRANSCRIBE_MODEL", value: process.env.GEMINI_TRANSCRIBE_MODEL ?? process.env.GEMINI_MODEL ?? "" },
{ name: "ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK", value: process.env.ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK ?? "false" },
```

### 2. `artifacts/api-server/src/routes/translator.ts`

Current AssemblyAI-only fast subtitle path:

- `translator.ts:60` reads `ASSEMBLYAI_KEY`.
- `translator.ts:83` defines Lambda fast max seconds, separate from the required 17 minute cutoff.
- `translator.ts:857` has `wordsToSegments()`.
- `translator.ts:948` has `toAssemblyLanguageCode()`.
- `translator.ts:954` has `transcribeFastAudio()`.
- `translator.ts:1048` has `transcribeFastMediaUrl()`.
- `translator.ts:1176` calls `transcribeFastMediaUrl()`.

Required changes:

1. Keep `transcribeFastMediaUrlAssemblyAI()` as fallback and long-audio path.
2. Add `transcribeFastMediaUrlGemini(mediaUrl, sourceLang, durationSeconds?)`.
3. Add provider wrapper:

```ts
async function transcribeFastMediaUrl(
  mediaUrl: string,
  sourceLang: string,
  knownDurationSeconds?: number,
): Promise<{ segments: FastSegment[]; durationSeconds: number; provider: "gemini" | "assemblyai" }> {
  const duration = knownDurationSeconds ?? await probe duration or use Gemini result duration;
  if (duration > GEMINI_TRANSCRIBE_MAX_SECONDS) {
    return transcribeFastMediaUrlAssemblyAI(mediaUrl, sourceLang);
  }
  return transcribeFastMediaUrlGemini(mediaUrl, sourceLang, duration);
}
```

4. Fix duration flow before provider choice.
   Current `transcribeFastMediaUrl()` gets `durationSeconds` only from AssemblyAI after transcription. That becomes impossible when Gemini is the default.
   Update `processLambdaFastTranslation()` to probe duration before transcription:

```ts
const knownDurationSeconds = await probeS3VideoDuration(s3Key);
const { segments, durationSeconds, provider } = await transcribeFastMediaUrl(
  mediaUrl,
  options.sourceLang,
  knownDurationSeconds,
);
```

5. `processLambdaFastTranslation()` at `translator.ts:1176` should log/store the provider:

```ts
const { segments, durationSeconds, provider } = await transcribeFastMediaUrl(mediaUrl, options.sourceLang);
```

6. Update status message:

```ts
await updateTranslatorJob(jobId, "TRANSCRIBING", 18, "Transcribing speech with Gemini...");
```

If provider switches to AssemblyAI because duration is over 17 minutes, update status/metadata accordingly.

7. Add metadata to transcript JSON:

```json
{
  "transcriptionProvider": "gemini",
  "transcriptionCutoffSeconds": 1020
}
```

8. Add a Gemini language helper.
   - Do not use `toAssemblyLanguageCode()` for Gemini naming.
   - Gemini prompt can accept source language as display name or code; pass both if available.

9. Add TypeScript env constants near `TRANSLATOR_TEXT_MODEL`:

```ts
const GEMINI_TRANSCRIBE_MAX_SECONDS = Math.max(
  60,
  Number(process.env.GEMINI_TRANSCRIBE_MAX_SECONDS ?? "1020") || 1020,
);
const GEMINI_TRANSCRIBE_MODEL =
  process.env.GEMINI_TRANSCRIBE_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash";
const ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK =
  /^(1|true|yes|on)$/i.test(process.env.ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK ?? "false");
```

### 3. `artifacts/api-server/src/lib/gemini-client.ts`

This already has the right client plumbing:

- `createGeminiClient()` at `gemini-client.ts:154`.
- Vertex and API key support already exist.
- Use this. Do not add a second Gemini client implementation in `translator.ts`.

Potential change:

- Export a helper for selecting `GEMINI_TRANSCRIBE_MODEL`, or keep model selection local in `translator.ts`.

### 4. Dependencies

No new major dependency is needed.

Already present:

- Python worker has `google-genai==1.73.0` in:
  - `artifacts/video-translator-service/requirements.txt`
  - `artifacts/video-translator-service/requirements.cpu.txt`
- API server has `@google/genai` in:
  - `artifacts/api-server/package.json`

Keep AssemblyAI dependencies for the >17 minute fallback unless product decides to remove the fallback entirely later.

## Local Gemini Reference Implementations

Use these existing repo patterns instead of inventing new SDK plumbing:

- `artifacts/api-server/src/routes/subtitles.ts:2693`
  - Vertex path sends short preprocessed audio using `inlineData`.
  - Good reference for Vertex mode where Developer File API upload is not used.
- `artifacts/api-server/src/routes/subtitles.ts:2755`
  - API-key path uses `client.files.upload({ file: processedPath, config: { mimeType, displayName } })`, polls `client.files.get(...)` until `ACTIVE`, then sends `{ fileData: { fileUri, mimeType } }`.
  - This is the best local reference for `transcribeFastMediaUrlGemini()` if it downloads/extracts a local audio file first.
- `artifacts/api-server/src/routes/youtube.ts:3900`
  - Uploads extracted audio to Gemini File API and passes file data into `generateContent`.
- `artifacts/api-server/src/lib/pitaji-analysis.ts:95`
  - Sends a URL directly as `fileData.fileUri`.
  - This may work for signed S3 URLs, but for translator reliability prefer local extract/upload when possible because signed URLs can expire and MIME inference can be brittle.

Recommendation:

- Python Batch worker: use local `transcription_audio` file and upload/inline it.
- Lambda fast path: either use signed S3 video URL as `fileData` if verified, or download/extract mono audio to `/tmp` and use the same File API/inline pattern as `subtitles.ts`. The second option is more predictable.

## Gemini Transcription Output Schema

Gemini should return exactly:

```json
{
  "languageCode": "hi",
  "languageName": "Hindi",
  "durationSeconds": 123.45,
  "segments": [
    {
      "id": 1,
      "speaker": "SPEAKER_A",
      "start": 0.0,
      "end": 2.4,
      "text": "exact source-language words",
      "words": [
        { "word": "exact", "start": 0.0, "end": 0.4 },
        { "word": "source-language", "start": 0.4, "end": 1.2 }
      ]
    }
  ]
}
```

Validation rules:

- `segments` must be non-empty.
- `start` and `end` are seconds, not milliseconds.
- `start >= 0`.
- `end > start`.
- Sort by `start`.
- Clamp segment end to media duration if known.
- Reject or repair overlaps:
  - tiny overlap under 120 ms: clamp previous `end` to next `start`;
  - large overlap: keep both only if different speakers and overlap is real crosstalk, otherwise log warning and clamp.
- `text` must not be translated.
- `text` must not contain labels like `Speaker A:`.
- `speaker` must be normalized to `SPEAKER_A`, `SPEAKER_B`, etc.
- If no speaker is known, set `SPEAKER_A`.
- `words` can be approximate if Gemini cannot give every word timestamp, but must stay inside the parent segment.
- If `words` is missing or invalid, synthesize approximate word timings from segment duration so `_segment_speech_duration()` keeps working.

## Required Segment Normalizer

Implement the normalizer as a separate helper in both runtimes, not inline inside the API call.

Python:

```python
def normalize_gemini_transcript_payload(payload: dict, duration_seconds: Optional[float]) -> list[dict]:
    ...
```

TypeScript:

```ts
function normalizeGeminiTranscriptPayload(
  payload: unknown,
  durationSeconds?: number,
): FastSegment[] {
  ...
}
```

Normalizer behavior:

1. Accept either `{ segments: [...] }` or a raw segment array, but always output the local schema.
2. Drop segments with empty `text`.
3. Convert numeric strings to numbers for timestamps.
4. Convert milliseconds to seconds only if values are obviously milliseconds in Python output, for example `end > durationSeconds * 2` and `end > 1000`. Prefer prompting for seconds and logging this repair.
5. Sort by `start`.
6. Clamp `start` to `>= 0`.
7. Clamp `end` to `<= durationSeconds` when duration is known.
8. Enforce `end > start`; drop any segment that cannot be repaired.
9. Normalize speaker:
   - `"A"` -> `"SPEAKER_A"`
   - `"Speaker A"` -> `"SPEAKER_A"`
   - missing -> `"SPEAKER_A"`
10. Remove speaker prefixes from text:
    - `Speaker A: hello` -> `hello`
    - `SPEAKER_A: hello` -> `hello`
11. Repair overlaps:
    - if same speaker and overlap <= 0.12s, set previous `end = next.start`;
    - if same speaker and overlap is larger, log warning and clamp previous segment unless that would make it invalid;
    - if different speakers overlap, keep only when overlap appears to be real crosstalk; otherwise clamp.
12. Validate `words`:
    - each word must have non-empty `word`, finite `start`, finite `end`;
    - each word must fit inside parent `[start, end]`;
    - sort words by `start`;
    - if invalid/missing, synthesize approximate word timings by splitting `text` on whitespace across the segment duration.
13. Reassign sequential ids after all repairs:
    - Python worker currently uses mixed ids, but downstream only needs stable ids. Use `1..n` for new Gemini output.
    - TypeScript fast path does not carry `id` in `FastSegment`, so ids are assigned later in transcript JSON.

Why this matters:

- `merge_segments_for_dubbing()` assumes sane chronological segments.
- `_segment_speech_duration()` assumes `words` are usable.
- Subtitle generation assumes non-overlapping timings.
- Voice placement assumes start/end windows are monotonic.

## Full Gemini Transcription Prompt

Use this as the exact first production prompt. Keep it in source as a constant so it can be tested and versioned.

```text
You are the transcription engine for a video translation and dubbing pipeline.

Transcribe the provided audio exactly in the original spoken language. Do not translate. Do not summarize. Do not clean up meaning. Preserve the speaker's actual words, filler words, repetitions, false starts, devotional words, names, numbers, and code-switching exactly as spoken.

The transcript will be translated and dubbed after this step, so timing and segmentation are critical.

Top priority: create HeyGen-quality, audio-aware segments.

You must listen to the real audio rhythm, not just count words. Segment boundaries must follow when the speaker actually starts speaking, continues speaking, pauses, changes speaker, or finishes a connected thought.

If the speaker continues talking at a consistent pace with no meaningful pause, keep the connected thought together even if the segment becomes longer and contains more text. A longer segment is correct when the audio has continuous speech and no real break.

If the speaker says a short phrase and then pauses for about 1-2 seconds, or clearly stops before the next phrase, make that phrase its own short segment. A short segment is correct when the speaker actually spoke briefly and then took a break.

Do not chop continuous speech into tiny fixed-size fragments. Do not merge across real pauses. Do not use a rigid word count as the main rule. The main rule is the audible speaking pattern.

Think like a professional dubbing timeline editor:
- continuous speech without a real pause = one connected segment;
- short phrase followed by a real pause = one short segment;
- speaker change = new segment;
- new thought after a pause = new segment;
- natural breath or comma-length hesitation can stay inside the same segment if the speaker clearly continues the same thought;
- meaningful 1-2 second pause should usually create a boundary.

Examples of desired behavior:
- A speaker talks continuously from 00:00:00.070 to 00:00:18.429 about one connected news claim. Keep it as one long segment because there is no meaningful pause.
- A speaker says "The current situation between Iran and America today" from 00:00:18.589 to 00:00:21.670 and then pauses. Keep it as one short segment.
- A speaker says "This is very significant, so listen carefully" from 00:00:26.989 to 00:00:28.829 and then pauses. Keep it as one short segment.
- A speaker continues a connected explanation from 00:00:51.640 to 00:01:03.640. Keep it as one longer segment because the speech continues naturally.

Return only valid JSON matching this shape:
{
  "languageCode": "string",
  "languageName": "string",
  "durationSeconds": number,
  "segments": [
    {
      "id": number,
      "speaker": "SPEAKER_A",
      "start": number,
      "end": number,
      "text": "string",
      "words": [
        { "word": "string", "start": number, "end": number }
      ]
    }
  ]
}

Rules:
1. Output only JSON. No markdown, no explanation, no comments.
2. All timestamps must be in seconds from the start of the audio.
3. Segment start must be when the speaker begins that utterance. Segment end must be when the speaker finishes that utterance.
4. Split segments at natural speech breaks: meaningful pauses, phrase endings, sentence endings, speaker changes, or clear changes in thought.
5. Do not split just because the text is long. If the speaker keeps talking without a meaningful pause, keep the connected speech together.
6. Do not merge just because two segments are near each other. If the speaker clearly pauses around 1-2 seconds, stops, or begins a new thought, create a boundary.
7. Prefer 1-6 words for naturally short utterances. Allow 7-15 words when the speaker continues without a meaningful pause. Allow more than 15 words only when the audio is genuinely continuous and splitting would break a connected thought.
8. Avoid long paragraph segments when there are real pauses available. Use the speaker's pauses as the main segmentation signal.
9. Do not split in the middle of a word, name, number, mantra, quote, or tightly connected phrase.
10. If the speaker pauses, end the current segment at the last spoken word before the pause and start the next segment when speech resumes.
11. Preserve the exact original-language text. Do not translate to the target language. Do not romanize unless the speaker actually uses romanized words.
12. Preserve code-switching exactly. If the speaker mixes Hindi and English, keep each word in the language/script actually spoken.
13. Preserve repeated words, stutters, fillers, and incomplete phrases when they are audible.
14. Assign stable speaker labels as SPEAKER_A, SPEAKER_B, SPEAKER_C, etc. Use the same label for the same voice throughout.
15. If there is only one speaker, use SPEAKER_A for every segment.
16. Do not include "Speaker A:" or any speaker label inside the text field.
17. Provide word-level timestamps in the words array whenever possible. Each word timestamp must be inside its parent segment.
18. If exact word timing is uncertain, estimate word timings proportionally inside the segment, but keep segment start/end accurate to the audible speech.
19. Avoid overlapping segments unless two speakers truly talk at the same time. For normal speech, each segment should end before the next segment starts.
20. Mark music, silence, applause, or non-speech only by omitting it. Do not create segments for non-speech unless there are spoken words.
21. For chants, prayers, shlokas, singing, or devotional speech, transcribe the actual words as spoken and keep natural phrase boundaries.
22. Numbers must be transcribed as spoken, not normalized unless the speaker clearly says the normalized form.
23. The final JSON must be parseable without repair.

Source language hint: {SOURCE_LANG_OR_AUTO}
Known duration seconds: {DURATION_SECONDS_OR_UNKNOWN}
Target translation language after transcription: {TARGET_LANG}. This is only context for segmentation. Do not translate into this language.
Multi-speaker requested: {MULTI_SPEAKER_TRUE_FALSE}
```

## Suggested Gemini API Configuration

Python worker:

```python
response = client.models.generate_content(
    model=os.environ.get("GEMINI_TRANSCRIBE_MODEL", "gemini-3.5-flash"),
    contents=[
        uploaded_audio_file_or_part,
        {"text": GEMINI_TRANSCRIPTION_PROMPT.format(...)}
    ],
    config={
        "response_mime_type": "application/json",
        "temperature": 0,
        "max_output_tokens": 65536
    },
)
```

TypeScript API:

```ts
const resp = await ai.models.generateContent({
  model: process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash",
  contents: [
    {
      role: "user",
      parts: [
        { fileData: { fileUri, mimeType } },
        { text: prompt },
      ],
    },
  ],
  config: {
    responseMimeType: "application/json",
    temperature: 0,
    maxOutputTokens: 65536,
  },
} as any);
```

Adapt the exact file upload syntax to the installed `google-genai` SDK version. The important requirements are:

- use existing Gemini client config,
- request JSON output,
- parse only JSON,
- validate before downstream use,
- fall back to AssemblyAI only when duration is over 17 minutes or when an explicit env flag allows emergency fallback.

## Fallback Policy

Recommended:

- `duration > 1020`: use AssemblyAI.
- Gemini parse/validation failure:
  - retry Gemini once with a stricter repair prompt and the original audio;
  - if still invalid and `ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK=true`, use AssemblyAI;
  - otherwise fail loudly with logs showing the provider, model, parse error, and first 1000 chars of Gemini response.

Do not silently fall back to AssemblyAI for normal <=17 minute jobs unless the env flag is enabled. Silent fallback would hide the exact problem the user is trying to fix.

## Tests Needed

### Python worker tests

Add tests under `artifacts/video-translator-service/`.

Minimum cases:

1. Provider routing:
   - duration `1019.9` uses Gemini.
   - duration `1020` uses Gemini.
   - duration `1020.1` uses AssemblyAI.
   - missing duration uses Gemini first and records duration probe failure metadata, unless the explicit fallback env is enabled.

2. Gemini normalization:
   - converts `speaker: "A"` to `SPEAKER_A`.
   - fills missing speaker with `SPEAKER_A`.
   - sorts out-of-order segments.
   - clamps tiny overlaps.
   - synthesizes word timings if missing.
   - removes `Speaker A:` prefixes from `text`.
   - drops or repairs invalid `end <= start` segments.

3. Contract compatibility:
   - output can pass `_segment_speech_duration()`.
   - output can pass `merge_segments_for_dubbing()`.
   - no segment has empty `text`, invalid `start/end`, or missing `words`.
   - `generate_transcript_json()` includes `transcriptionProvider`, `transcriptionModel`, and `transcriptionCutoffSeconds`.

4. Prompt guard:
   - prompt contains "Do not translate".
   - prompt contains 1-6 and 7-15 word segmentation rules.
   - prompt contains "HeyGen-quality".
   - prompt contains "Do not split just because the text is long".
   - prompt contains "meaningful 1-2 second pause".
   - prompt asks for JSON only.

### TypeScript API tests

Add or extend tests for `translator.ts` helpers if test setup exists.

Minimum cases:

1. `transcribeFastMediaUrl()` routes <=17 minutes to Gemini.
2. `transcribeFastMediaUrl()` routes >17 minutes to AssemblyAI.
3. Gemini JSON maps to `FastSegment[]` with `startMs/endMs`.
4. Final transcript JSON includes `transcriptionProvider`.
5. `processLambdaFastTranslation()` probes duration before choosing a provider.
6. Batch environment includes `GEMINI_TRANSCRIBE_MAX_SECONDS`, `GEMINI_TRANSCRIBE_MODEL`, and `ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK`.

## Manual Verification Plan

Use one short real sample and one longer sample:

1. Short sample under 17 minutes:
   - Run full dubbing mode.
   - Confirm logs say Gemini transcription.
   - Inspect generated `transcript.json`.
   - Check segment boundaries match speaker starts/stops.
   - Confirm original text is not translated in `originalText`.

2. Subtitle-only sample under 17 minutes:
   - Run Lambda fast path.
   - Confirm logs/metadata say Gemini transcription.
   - Confirm SRT timings are short and natural.

3. Long sample over 17 minutes:
   - Confirm logs say AssemblyAI due to duration cutoff.
   - Confirm no Gemini transcription attempt is made.

4. Heavy music sample with `DEMUCS_BEFORE_ASR=true`:
   - Confirm Gemini receives the Demucs vocals audio when sequential mode is enabled.
   - Confirm the provider rule still uses duration cutoff.

## Implementation Order

1. Add Gemini transcription prompt constant and JSON schema/normalizer in `worker.py`.
2. Rename existing Python AssemblyAI function to `transcribe_assemblyai()`.
3. Add Python `normalize_gemini_transcript_payload()`.
4. Add Python `transcribe_gemini()` and provider wrapper.
5. Update Python pipeline calls to pass `video_duration`.
6. Add transcription provider metadata to Python `transcript.json`.
7. Pass Gemini transcription env vars from `buildBatchEnvironment()`.
8. Add TypeScript Gemini transcription prompt/helper in `translator.ts`.
9. Rename existing TypeScript AssemblyAI helpers and route through provider wrapper.
10. Update Lambda fast path to probe duration before provider selection.
11. Add provider metadata to Lambda fast transcript JSON and DDB progress metadata.
12. Add tests for routing, prompt content, duration probing, env propagation, and segment normalization.
13. Run a real short sample and inspect `transcript.json` manually.

## Key Risk

Gemini may produce strong segment-level timestamps but weaker true word-level timestamps than AssemblyAI. The pipeline mostly needs accurate segment start/end for dubbing sync. Keep word timings for compatibility by validating them when present and synthesizing approximate word timings when absent. Segment timing quality matters more than perfect word timing for this product request.

## Final Decision

Implement Gemini as the default transcription provider for all translator jobs at or below 17 minutes. Keep AssemblyAI only as the long-audio provider above 17 minutes and as an explicit emergency fallback. Change both the Python full translator worker and the TypeScript Lambda fast subtitle path, otherwise the product will still have AssemblyAI transcription in one mode.
