// Pita Ji analysis wrapper.
//
// For Phase 2 we only handle the YouTube-direct path (≤ ~40 min): pass the
// canonical YouTube watch URL straight to Gemini 2.5 Flash via `fileData` —
// the same trick the existing agent and youtube routes use. Gemini watches
// the video itself (frames + audio) and returns structured clips.
//
// Phase 3 will add a parallel `runAudioChunkAnalysis` for long videos that
// were split by the queue worker into S3-hosted m4a chunks.
//
// The model is pinned to `gemini-2.5-flash` to match the rest of the app
// (subtitles, agent search, copilot search). Override via the env var
// `PITAJI_ANALYSIS_MODEL` if needed.

import { createGeminiClient } from "./gemini-client";
import {
  PITAJI_ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
} from "./pitaji-prompts";
import {
  PitajiClipStreamParser,
  type PitajiStreamParseResult,
} from "./pitaji-stream-parser";
import type { PitajiClip, PitajiClipKind } from "./pitaji-store";
import crypto from "crypto";

export const PITAJI_ANALYSIS_MODEL =
  (process.env.PITAJI_ANALYSIS_MODEL ?? "gemini-2.5-flash").trim() ||
  "gemini-2.5-flash";

const PITAJI_MAX_OUTPUT_TOKENS = Math.max(
  4096,
  Math.min(
    65_536,
    Number.parseInt(process.env.PITAJI_MAX_OUTPUT_TOKENS ?? "32768", 10) || 32_768,
  ),
);

/**
 * Shape returned by the model. `id`, `dispatchedAt` and any other server-only
 * fields are added downstream.
 */
type ModelClip = Partial<PitajiClip> & {
  kind?: PitajiClipKind | string;
  startSec?: number | string;
  endSec?: number | string;
};

export interface AnalyzeYoutubeArgs {
  /** Already-normalized https://www.youtube.com/watch?v=... URL. */
  youtubeUrl: string;
  /** Optional total duration in seconds, used in the prompt for context. */
  totalDurationSec?: number;
  /** Operator-supplied extra clip-selection guidance from settings. */
  clipInstructions?: string;
  /** Called for every clip the model emits, in order. */
  onClip: (clip: PitajiClip) => void;
  /** Optional progress callback (raw chunk text, useful for debug). */
  onChunk?: (text: string) => void;
  /** Abort signal — when triggered, the underlying stream is closed. */
  signal?: AbortSignal;
}

export interface AnalyzeYoutubeResult {
  totalClips: number;
  raw: string;
}

/**
 * Run the full YouTube-direct analysis. Returns once the stream completes
 * (or is aborted). Clip objects are delivered to `onClip` as they form.
 */
export async function analyzeYoutubeDirect(args: AnalyzeYoutubeArgs): Promise<AnalyzeYoutubeResult> {
  const ai = createGeminiClient();
  const parser = new PitajiClipStreamParser<ModelClip>();

  const userPrompt = buildAnalysisUserPrompt({
    totalDurationSec: args.totalDurationSec,
    clipInstructions: args.clipInstructions,
  });

  // The @google/genai SDK exposes a streaming generator via
  // `ai.models.generateContentStream(...)`. The exact iterator shape (chunk
  // → candidates[].content.parts[].text) matches what subtitles + agent
  // already consume in non-streaming form.
  const stream = await ai.models.generateContentStream({
    model: PITAJI_ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: userPrompt },
          // YouTube URL fed as fileData — Gemini fetches and watches the
          // actual video. Same idiom used at:
          //   routes/agent.ts:2104   (analyze_youtube_video tool)
          //   routes/youtube.ts:3722 (legacy clip helper)
          { fileData: { fileUri: args.youtubeUrl } } as unknown as never,
        ],
      },
    ],
    config: {
      systemInstruction: PITAJI_ANALYSIS_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: PITAJI_MAX_OUTPUT_TOKENS,
    },
  });

  let raw = "";
  let totalClips = 0;

  const handleChunk = (text: string): void => {
    if (!text) return;
    raw += text;
    args.onChunk?.(text);

    const result: PitajiStreamParseResult<ModelClip> = parser.push(text);
    for (const obj of result.emitted) {
      const clip = normaliseClip(obj);
      if (!clip) continue;
      totalClips += 1;
      args.onClip(clip);
    }
  };

  const it = stream as AsyncIterable<unknown>;
  for await (const chunk of it) {
    if (args.signal?.aborted) break;
    const candidates = (chunk as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
    const parts = candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        handleChunk(part.text);
      }
    }
  }

  // If the model returned its full reply in a single non-streamed shot, the
  // parser may still be holding the whole thing. One last push to flush.
  // (Empty push is a no-op — safe.)
  parser.push("");

  return { totalClips, raw };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normaliseClip(obj: ModelClip | undefined): PitajiClip | null {
  if (!obj || typeof obj !== "object") return null;
  const start = asNumber(obj.startSec, -1);
  const end = asNumber(obj.endSec, -1);
  if (start < 0 || end <= start) return null;

  const kindRaw = String(obj.kind ?? "topic").toLowerCase();
  const kind: PitajiClipKind = kindRaw === "qna" ? "qna" : "topic";

  const clip: PitajiClip = {
    id: `clip_${crypto.randomBytes(6).toString("hex")}`,
    kind,
    title: asString(obj.title, kind === "qna" ? "Untitled question" : "Untitled topic"),
    summary: asString(obj.summary, ""),
    startSec: start,
    endSec: end,
    speakerHint: asString(obj.speakerHint, "primary"),
    suggestedTitle: asString(obj.suggestedTitle, ""),
    description: asString(obj.description, ""),
    hashtags: asStringArray(obj.hashtags).slice(0, 8),
    pinnedComment: asString(obj.pinnedComment, ""),
  };
  if (kind === "qna") {
    clip.question = asString(obj.question, "");
    clip.answer = asString(obj.answer, "");
  }
  return clip;
}
