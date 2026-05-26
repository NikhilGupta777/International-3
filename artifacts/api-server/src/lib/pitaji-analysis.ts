// Pita Ji analysis wrapper.
//
// Two paths:
//   * analyzeYoutubeDirect — Phase 2: pass the canonical YouTube watch URL
//     to Gemini Flash via `fileData` (same trick used by the existing
//     agent + youtube routes). Used when the video is at or below the
//     PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN minutes threshold.
//   * analyzeAudioChunkInline — Phase 3: read a chunked audio m4a file
//     from /tmp, pass it as base64 inlineData to Vertex Gemini Flash.
//     Each chunk's prompt is told its offset in the original video so the
//     model returns chunk-relative timestamps; the caller re-bases them.
//
// Model is pinned to `gemini-3.5-flash` to match the rest of the app
// (agent.ts AGENT_MODEL/ULTRA_MODEL/SEARCH_MODEL, subtitles.ts audio analyze,
// youtube.ts subtitle fix, video translator service). When
// GOOGLE_GENAI_USE_VERTEXAI=true (the production setting), the call is
// routed through Vertex AI automatically — no code change here.

import { readFileSync, statSync } from "fs";
import crypto from "crypto";
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

export const PITAJI_ANALYSIS_MODEL =
  (process.env.PITAJI_ANALYSIS_MODEL ?? "gemini-3.5-flash").trim() ||
  "gemini-3.5-flash";

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
 * Run the YouTube-direct analysis (Phase 2). Returns once the stream
 * completes or is aborted. Clip objects are delivered to `onClip` as they
 * form.
 */
export async function analyzeYoutubeDirect(args: AnalyzeYoutubeArgs): Promise<AnalyzeYoutubeResult> {
  const ai = createGeminiClient();
  const parser = new PitajiClipStreamParser<ModelClip>();

  const userPrompt = buildAnalysisUserPrompt({
    totalDurationSec: args.totalDurationSec,
    clipInstructions: args.clipInstructions,
  });

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
          { fileData: { fileUri: args.youtubeUrl, mimeType: "video/mp4" } } as unknown as never,
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
  parser.push("");

  return { totalClips, raw };
}

// ── Audio-chunk analysis (Phase 3) ───────────────────────────────────────────

export interface AnalyzeAudioChunkArgs {
  /** Path to the m4a chunk on local disk. */
  chunkPath: string;
  /** mimeType to send to the model (e.g. "audio/mp4"). */
  mimeType: string;
  /** This chunk's start offset within the full original video, in seconds. */
  chunkOffsetSec: number;
  /** This chunk's own duration in seconds. */
  chunkDurationSec: number;
  /** Total duration of the original full video, in seconds. */
  totalDurationSec: number;
  /** 1-based index of this chunk among all chunks. */
  chunkIndex: number;
  /** Total chunk count for this analysis run. */
  chunkTotal: number;
  /** Operator-supplied extra clip-selection guidance from settings. */
  clipInstructions?: string;
  /** Called for every clip the model emits — already re-based to absolute time. */
  onClip: (clip: PitajiClip) => void;
  /** Optional progress callback (raw chunk text, useful for debug). */
  onChunk?: (text: string) => void;
  /** Abort signal — when triggered, the underlying stream is closed. */
  signal?: AbortSignal;
}

export interface AnalyzeAudioChunkResult {
  /** Number of clips emitted from this chunk after re-basing. */
  emittedClips: number;
  /** Final raw text returned by the model. */
  raw: string;
  /** Inline-data size in bytes. */
  bytes: number;
}

/**
 * Analyze a single audio chunk via Vertex Gemini using inline base64. The
 * model returns chunk-relative timestamps; this function re-bases them by
 * `chunkOffsetSec` before calling `onClip`.
 *
 * Inline-data limit on Vertex is ~20 MB. Our pitaji-audio-pipeline.ts cuts
 * chunks at 24 kbps mono AAC, which stays well under the limit even for
 * an 80-minute chunk window (~14 MB).
 */
export async function analyzeAudioChunkInline(
  args: AnalyzeAudioChunkArgs,
): Promise<AnalyzeAudioChunkResult> {
  // Read + base64 the chunk. We use readFileSync because chunks live in /tmp
  // and are deleted right after analysis — streaming would add complexity
  // for no measurable benefit on files this size.
  const stat = statSync(args.chunkPath);
  const buf = readFileSync(args.chunkPath);
  const base64Data = buf.toString("base64");

  const ai = createGeminiClient();
  const parser = new PitajiClipStreamParser<ModelClip>();

  const userPrompt = buildAnalysisUserPrompt({
    totalDurationSec: args.totalDurationSec,
    chunkOffsetSec: args.chunkOffsetSec,
    chunkDurationSec: args.chunkDurationSec,
    clipInstructions: args.clipInstructions,
  });

  const stream = await ai.models.generateContentStream({
    model: PITAJI_ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: userPrompt },
          { inlineData: { mimeType: args.mimeType, data: base64Data } } as unknown as never,
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
  let emittedClips = 0;

  const handleChunk = (text: string): void => {
    if (!text) return;
    raw += text;
    args.onChunk?.(text);
    const result: PitajiStreamParseResult<ModelClip> = parser.push(text);
    for (const obj of result.emitted) {
      const local = normaliseClip(obj);
      if (!local) continue;
      // Re-base timestamps from chunk-relative to absolute.
      const start = Math.max(0, Math.round(local.startSec + args.chunkOffsetSec));
      const end = Math.max(start + 1, Math.round(local.endSec + args.chunkOffsetSec));
      // Clamp to total duration so a clip never overshoots the source.
      const clamped = Math.min(end, Math.round(args.totalDurationSec));
      const rebased: PitajiClip = { ...local, startSec: start, endSec: clamped };
      emittedClips += 1;
      args.onClip(rebased);
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
  parser.push("");

  return { emittedClips, raw, bytes: stat.size };
}

/**
 * Lightweight overlap dedupe: drops any incoming clip whose midpoint is
 * within `overlapSec` of a clip already in `existing` AND whose title
 * (or question for QnA) is similar (Jaccard ≥ 0.45 over word sets, or
 * one fully contained in the other when both are short).
 */
export function isLikelyDuplicateClip(
  incoming: PitajiClip,
  existing: PitajiClip[],
  overlapSec: number,
): boolean {
  const incMid = (incoming.startSec + incoming.endSec) / 2;
  const incKey = (
    incoming.kind === "qna" ? incoming.question ?? incoming.title : incoming.title
  ).toLowerCase();
  const incTokens = tokenize(incKey);
  if (incTokens.size === 0) return false;
  for (const c of existing) {
    if (c.kind !== incoming.kind) continue;
    const cMid = (c.startSec + c.endSec) / 2;
    if (Math.abs(cMid - incMid) > overlapSec * 1.5 + 30) continue;
    const cKey = (c.kind === "qna" ? c.question ?? c.title : c.title).toLowerCase();
    const cTokens = tokenize(cKey);
    if (cTokens.size === 0) continue;
    const inter = setIntersect(incTokens, cTokens);
    const union = incTokens.size + cTokens.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    if (jaccard >= 0.45) return true;
    if (incKey.length > 0 && cKey.length > 0) {
      if (incKey.includes(cKey) || cKey.includes(incKey)) return true;
    }
  }
  return false;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function setIntersect(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n += 1;
  return n;
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
