import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join, extname } from "path";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { createWriteStream, statSync } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import ffmpegStatic from "ffmpeg-static";
import { Type } from "@google/genai";
import { getWorkspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { setupSse, sseFlush } from "../lib/sse";
import { createGeminiClient, isGeminiConfigured, buildThinkingConfig, getGeminiApiKeyForAttempt, getPersonalGeminiApiKeysList, getPersonalKeysForCaller, generateContentWithRotation } from "../lib/gemini-client";
import { submitEditorRenderJob, getJobStatusFromDdb, putEditorJobQueued, updateEditorJobStatus, isEditorDdbConfigured } from "../lib/youtube-queue";
import { INTERNAL_AGENT_SECRET } from "../lib/internal-agent";
import { normalizeInputUrl, isYouTubeUrl } from "./youtube";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { recordKeyFailure } from "../utils/key-circuit-breaker";


const VIDEO_EDITOR_QUEUE_ENABLED =
  (process.env.VIDEO_EDITOR_BATCH_ENABLED || "").toLowerCase() === "true";

// Model used by the watch_youtube_video tool to actually watch+listen to a
// YouTube video (vision+audio). Mirrors agent.ts's primary AGENT_MODEL.
const EDITOR_WATCH_MODEL = (process.env.EDITOR_WATCH_MODEL || "gemini-2.5-flash").trim();

function isGeminiKeyRetryableError(err: any): boolean {
  const message = String(err?.message ?? err ?? "");
  const status = Number(err?.status ?? err?.code ?? 0);
  return (
    status === 429 ||
    status === 401 ||
    status === 403 ||
    status === 500 ||
    status === 503 ||
    /resource.?exhausted|quota.*exceeded|rate.?limit|429|401|403|api.?key|auth|permission|503|unavailable|overloaded|high demand|timeout|deadline|fetch failed|ECONNRESET|internal|500/i.test(message)
  );
}

// ── Render routing ────────────────────────────────────────────────────────────
// Fast path: self-invoke a worker Lambda (near-instant start, 15-min budget) for
// renders whose expected output is short. Heavy path: AWS Batch/Fargate for long
// renders (no 15-min cap) when the expected output exceeds the threshold.
const EDITOR_WORKER_FUNCTION_NAME = (
  process.env.VIDEO_EDITOR_WORKER_FUNCTION_NAME || process.env.AWS_LAMBDA_FUNCTION_NAME || ""
).trim();
const EDITOR_RENDER_FARGATE_THRESHOLD_SEC = Math.max(
  60,
  Number.parseInt(process.env.VIDEO_EDITOR_FARGATE_THRESHOLD_SEC ?? "600", 10) || 600,
);
const editorLambdaClient = EDITOR_WORKER_FUNCTION_NAME
  ? new LambdaClient({ region: process.env.AWS_REGION || process.env.YOUTUBE_QUEUE_REGION || "us-east-1" })
  : null;

type AspectRatio = "original" | "9:16" | "16:9" | "1:1";
type CropMode = "smart" | "fit-blur" | "contain";
type LogoPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";
type TextPosition = "bottom-center" | "bottom-right" | "top-left";
type RenderStatus = "pending" | "running" | "done" | "error" | "cancelled";

type EditorAssets = {
  logo?: string | null;
  intro?: string | null;
  outro?: string | null;
};

type LogoKey = "none" | "auto-white" | "auto-black";
type ColorPreset = "none" | "vivid" | "muted" | "bw" | "warm" | "cool";

type EditRecipe = {
  aspectRatio: AspectRatio;
  cropMode: CropMode;
  trim: { start: number; end: number | null };
  speed: number; // 0.25 - 4.0
  colorPreset: ColorPreset;
  overlays: Array<
    | { type: "logo"; asset: string; position: LogoPosition; widthPercent: number; key?: LogoKey }
    | { type: "text"; text: string; position: TextPosition; style: "bold-clean" | "headline" }
  >;
  intro: { enabled: boolean; asset: string | null };
  outro: { enabled: boolean; asset: string | null };
  transitions: { fade: boolean };
  export: {
    format: "mp4";
    resolution: "1080p";
    videoCodec: "h264";
    audioCodec: "aac";
  };
};

// ─── Timeline v2 types ────────────────────────────────────────────────────────
type TransitionType = "none" | "fade" | "crossfade" | "blur" | "dip-to-black" | "wipe";

type TransitionDef = {
  type: TransitionType;
  duration: number; // seconds, 0.1-2.0
};

type TimelineClip = {
  id: string;
  asset: string;       // workspace path to the source video
  srcIn: number;       // source start time (seconds)
  srcOut: number;      // source end time (seconds), 0 = full duration
  tlStart: number;     // position on timeline (seconds)
  speed: number;       // 0.25-4.0, default 1
  transitionIn?: TransitionDef;
  transitionOut?: TransitionDef;
  colorPreset?: ColorPreset;
  reverse?: boolean;
};

type TimedOverlay = {
  id: string;
  type: "logo" | "text" | "image";
  content: string;     // text string or asset path
  tlStart: number;
  tlEnd: number;       // 0 = full duration
  position: string;    // "top-right", "bottom-center", etc.
  xPct?: number;       // optional free position: overlay CENTER x as 0..1 of frame
  yPct?: number;       // optional free position: overlay CENTER y as 0..1 of frame
  style: Record<string, any>;
};

type AudioClip = {
  id: string;
  asset: string;
  tlStart: number;
  tlEnd: number;       // 0 = full duration
  volumeDb: number;    // -30 to 6
  fadeIn: number;       // seconds
  fadeOut: number;      // seconds
  duckSpeech: boolean;
};

type Timeline = {
  tracks: {
    video: TimelineClip[];
    overlays: TimedOverlay[];
    audio: AudioClip[];
  };
  export: {
    aspectRatio: AspectRatio;
    resolution: string;
    cropMode: CropMode;
    colorPreset: ColorPreset;
  };
};

type ProposalDiffItem = {
  action: "add" | "remove" | "modify" | "reorder";
  target: string;          // "clip", "overlay", "transition", "audio", "export"
  description: string;     // human-readable
};

type Proposal = {
  proposalId: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  summary: string;
  diff: ProposalDiffItem[];
  timeline: Timeline;
  createdAt: number;
};

// Extended project type supporting both legacy and timeline v2
type EditorProjectV2 = EditorProject & {
  timeline?: Timeline | null;
  proposals?: Proposal[];
  version?: number; // 1 = legacy EditRecipe, 2 = Timeline
};

type EditorProject = {
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceVideo: string | null;
  assets: EditorAssets;
  prompt: string;
  recipe: EditRecipe;
  renders: Array<{
    jobId: string;
    kind: "preview" | "final";
    status: RenderStatus;
    progress: number;
    message: string;
    outputPath: string | null;
    createdAt: number;
    completedAt: number | null;
  }>;
};

type EditorJob = {
  jobId: string;
  projectId: string;
  kind: "preview" | "final";
  status: RenderStatus;
  progress: number;
  message: string;
  outputPath: string | null;
  error?: string | null;
  createdAt: number;
  completedAt: number | null;
};

const router = Router();
const jobs = new Map<string, EditorJob>();
const activeRenderProcesses = new Map<string, ReturnType<typeof spawn>>();
const FFMPEG_BIN = process.env.FFMPEG_BIN || ffmpegStatic || "ffmpeg";
const STALE_PENDING_RENDER_MS = 2 * 60_000;
const IS_LAMBDA = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const RUN_RENDER_INLINE = IS_LAMBDA && !VIDEO_EDITOR_QUEUE_ENABLED;

// Garbage-collect completed jobs from the in-memory map so a long-running
// process doesn't accumulate every render that ever ran. We keep finished
// jobs around for an hour so callers can still poll status briefly.
const JOB_RETENTION_MS = 60 * 60 * 1000;
const JOB_MAX_ENTRIES = 5000;
function gcJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const isTerminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
    if (isTerminal && job.completedAt && now - job.completedAt > JOB_RETENTION_MS) {
      jobs.delete(id);
    }
  }
  // Hard cap: drop oldest terminal entries if we still have too many.
  if (jobs.size > JOB_MAX_ENTRIES) {
    const terminal = [...jobs.entries()]
      .filter(([, j]) => j.status === "done" || j.status === "error" || j.status === "cancelled")
      .sort(([, a], [, b]) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    for (const [id] of terminal) {
      if (jobs.size <= JOB_MAX_ENTRIES) break;
      jobs.delete(id);
    }
  }
}
const jobGcInterval = setInterval(gcJobs, 10 * 60 * 1000);
// Don't keep the event loop alive solely for GC.
if (typeof jobGcInterval.unref === "function") jobGcInterval.unref();

function projectPath(projectId: string): string {
  if (!/^[a-f0-9-]{20,80}$/i.test(projectId)) throw new Error("invalid project id");
  return `editor/projects/${projectId}.json`;
}

function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value;
}

function bad(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function fail(res: Response, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid|required|not found|missing/i.test(msg)) return res.status(400).json({ error: msg });
  logger.error({ err }, "[video-editor] unexpected failure");
  return res.status(500).json({ error: "video editor operation failed" });
}

function cleanWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+/, "");
  return trimmed ? trimmed : null;
}

function extractDateText(prompt: string): string | null {
  const quoted = prompt.match(/["'“”]([^"'“”]{3,80})["'“”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const date = prompt.match(/\b\d{1,2}\s+[A-Z]{3,9},?\s+\d{4}\b/i);
  return date ? date[0].replace(",", "").toUpperCase() : null;
}

function extractTrim(prompt: string): { start: number; end: number | null } {
  const p = prompt.toLowerCase();
  let start = 0;
  let end: number | null = null;
  const skip = p.match(/\b(?:trim|skip|cut)\s+(?:the\s+)?first\s+(\d{1,3})\s*(s|sec|seconds?|m|min|minutes?)\b/);
  if (skip) {
    const n = parseInt(skip[1], 10);
    start = /^m/.test(skip[2]) ? n * 60 : n;
  }
  const first = p.match(/\b(?:first|keep\s+(?:only\s+)?(?:the\s+)?first)\s+(\d{1,3})\s*(s|sec|seconds?|m|min|minutes?)\b/);
  if (first) {
    const n = parseInt(first[1], 10);
    end = (start || 0) + (/^m/.test(first[2]) ? n * 60 : n);
  }
  return { start, end };
}

function extractLogoKey(prompt: string): LogoKey {
  const p = prompt.toLowerCase();
  if (!/\b(remove|strip|kill|key|cut)\b.*\b(bg|background)\b/.test(p) && !/\btransparent\s+logo\b/.test(p)) return "none";
  if (/\bblack\b/.test(p)) return "auto-black";
  return "auto-white";
}

function generateRecipe(prompt: string, sourceVideo: string | null, assets: EditorAssets): EditRecipe {
  const p = prompt.toLowerCase();
  const aspectRatio: AspectRatio =
    /\b(shorts?|reels?|tiktok|vertical|9[:x]16|portrait)\b/.test(p)
      ? "9:16"
      : /\b(square|1[:x]1)\b/.test(p)
        ? "1:1"
        : /\b(landscape|youtube|16[:x]9)\b/.test(p)
          ? "16:9"
          : "original";
  const cropMode: CropMode =
    /\bblur|background blur|fit\b/.test(p)
      ? "fit-blur"
      : /\bcontain|bars|no crop\b/.test(p)
        ? "contain"
        : "smart";

  const overlays: EditRecipe["overlays"] = [];
  if (assets.logo) {
    const position: LogoPosition =
      /\btop left|upper left\b/.test(p)
        ? "top-left"
        : /\bbottom right|lower right\b/.test(p)
          ? "bottom-right"
          : /\bbottom left|lower left\b/.test(p)
            ? "bottom-left"
            : "top-right";
    overlays.push({ type: "logo", asset: assets.logo, position, widthPercent: 8, key: extractLogoKey(prompt) });
  }

  const text = extractDateText(prompt);
  if (text) overlays.push({ type: "text", text, position: "bottom-center", style: "bold-clean" });

  const wantsIntro = Boolean(assets.intro) && /\bintro|opening|start\b/.test(p);
  const wantsOutro = Boolean(assets.outro) && /\boutro|ending|end card|end\b/.test(p);
  const wantsFade = !/\bno\s+fade|hard\s+cut\b/.test(p);

  let speed = 1;
  const speedMatch = p.match(/\b(0?\.\d+|[1-4])\s*x\s*speed\b|\bspeed\s*([0-9.]+)x?\b/);
  if (speedMatch) {
    const raw = speedMatch[1] || speedMatch[2];
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n >= 0.25 && n <= 4) speed = n;
  } else if (/\b(slow\s*motion|slowmo|half\s*speed)\b/.test(p)) speed = 0.5;
  else if (/\b(time\s*lapse|fast\s*forward|double\s*speed)\b/.test(p)) speed = 2;

  let colorPreset: ColorPreset = "none";
  if (/\bblack\s*and\s*white|b\s*&\s*w|monochrome|grayscale\b/.test(p)) colorPreset = "bw";
  else if (/\bvivid|punchy|saturated\b/.test(p)) colorPreset = "vivid";
  else if (/\bmuted|desaturated|cinematic\b/.test(p)) colorPreset = "muted";
  else if (/\bwarm|sunset|gold\b/.test(p)) colorPreset = "warm";
  else if (/\bcool|cold|blue\s*tone\b/.test(p)) colorPreset = "cool";

  return {
    aspectRatio,
    cropMode,
    trim: extractTrim(prompt),
    speed,
    colorPreset,
    overlays,
    intro: { enabled: wantsIntro, asset: wantsIntro ? assets.intro ?? null : null },
    outro: { enabled: wantsOutro, asset: wantsOutro ? assets.outro ?? null : null },
    transitions: { fade: wantsFade },
    export: { format: "mp4", resolution: "1080p", videoCodec: "h264", audioCodec: "aac" },
  };
}

function migrateRecipe(recipe: any): EditRecipe {
  // Back-fill optional fields for older project records and clamp known enum
  // values so a corrupted record can't crash the renderer.
  const aspectRatios: AspectRatio[] = ["original", "9:16", "16:9", "1:1"];
  const cropModes: CropMode[] = ["smart", "fit-blur", "contain"];
  const colorPresets: ColorPreset[] = ["none", "vivid", "muted", "bw", "warm", "cool"];
  return {
    aspectRatio: aspectRatios.includes(recipe?.aspectRatio) ? recipe.aspectRatio : "original",
    cropMode: cropModes.includes(recipe?.cropMode) ? recipe.cropMode : "smart",
    trim: recipe?.trim && typeof recipe.trim === "object"
      ? {
          start: Number.isFinite(recipe.trim.start) ? Math.max(0, recipe.trim.start) : 0,
          end: recipe.trim.end == null ? null : Number.isFinite(recipe.trim.end) ? Math.max(0, recipe.trim.end) : null,
        }
      : { start: 0, end: null },
    speed: typeof recipe?.speed === "number" && Number.isFinite(recipe.speed)
      ? Math.max(0.25, Math.min(4, recipe.speed))
      : 1,
    colorPreset: colorPresets.includes(recipe?.colorPreset) ? recipe.colorPreset : "none",
    overlays: Array.isArray(recipe?.overlays) ? recipe.overlays : [],
    intro: recipe?.intro && typeof recipe.intro === "object"
      ? { enabled: Boolean(recipe.intro.enabled), asset: recipe.intro.asset ?? null }
      : { enabled: false, asset: null },
    outro: recipe?.outro && typeof recipe.outro === "object"
      ? { enabled: Boolean(recipe.outro.enabled), asset: recipe.outro.asset ?? null }
      : { enabled: false, asset: null },
    transitions: recipe?.transitions && typeof recipe.transitions === "object"
      ? { fade: recipe.transitions.fade !== false }
      : { fade: true },
    export: recipe?.export && typeof recipe.export === "object"
      ? recipe.export
      : { format: "mp4", resolution: "1080p", videoCodec: "h264", audioCodec: "aac" },
  };
}

// ─── Timeline helpers ─────────────────────────────────────────────────────────
function defaultTimeline(): Timeline {
  return {
    tracks: { video: [], overlays: [], audio: [] },
    export: { aspectRatio: "original", resolution: "1080p", cropMode: "smart", colorPreset: "none" },
  };
}

function recipeToTimeline(recipe: EditRecipe, sourceVideo: string | null): Timeline {
  const tl = defaultTimeline();
  tl.export = {
    aspectRatio: recipe.aspectRatio,
    resolution: recipe.export?.resolution || "1080p",
    cropMode: recipe.cropMode,
    colorPreset: recipe.colorPreset,
  };
  if (sourceVideo) {
    tl.tracks.video.push({
      id: randomUUID(),
      asset: sourceVideo,
      srcIn: recipe.trim.start || 0,
      srcOut: recipe.trim.end || 0,
      tlStart: 0,
      speed: recipe.speed || 1,
      colorPreset: recipe.colorPreset !== "none" ? recipe.colorPreset : undefined,
    });
  }
  for (const ov of recipe.overlays) {
    tl.tracks.overlays.push({
      id: randomUUID(),
      type: ov.type as "logo" | "text",
      content: ov.type === "logo" ? (ov as any).asset : (ov as any).text,
      tlStart: 0,
      tlEnd: 0,
      position: (ov as any).position || "top-right",
      style: ov.type === "logo"
        ? { widthPercent: (ov as any).widthPercent || 8, key: (ov as any).key || "none" }
        : { style: (ov as any).style || "bold-clean" },
    });
  }
  return tl;
}

function computeTimelineDuration(tl: Timeline): number {
  let maxEnd = 0;
  for (const clip of tl.tracks.video) {
    const clipDur = (clip.srcOut > 0 ? clip.srcOut - clip.srcIn : 0) / (clip.speed || 1);
    const end = clip.tlStart + clipDur;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

async function probeWorkspaceVideoDuration(ws: ReturnType<typeof getWorkspace>, asset: string): Promise<number> {
  const dir = join(tmpdir(), `editor-duration-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const localPath = join(dir, `asset${extname(asset) || ".mp4"}`);
    await downloadWorkspaceFile(ws, asset, localPath);
    const meta = await probeMetadata(localPath);
    return meta.duration;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveOpenEndedClipDurations(ws: ReturnType<typeof getWorkspace>, tl: Timeline): Promise<void> {
  const cache = new Map<string, number>();
  for (const clip of tl.tracks.video) {
    if (clip.srcOut > clip.srcIn) continue;
    let duration = cache.get(clip.asset);
    if (duration == null) {
      duration = await probeWorkspaceVideoDuration(ws, clip.asset).catch(() => 0);
      cache.set(clip.asset, duration);
    }
    if (duration > clip.srcIn) clip.srcOut = duration;
  }
}

async function readProject(req: Request, projectId: string): Promise<EditorProject> {
  const ws = getWorkspace(req);
  const data = await ws.s3.readText(projectPath(projectId));
  return JSON.parse(data.content) as EditorProject;
}

async function writeProject(req: Request, project: EditorProject): Promise<EditorProject> {
  const ws = getWorkspace(req);
  return writeProjectToWorkspace(ws, project);
}

async function writeProjectToWorkspace(ws: ReturnType<typeof getWorkspace>, project: EditorProject): Promise<EditorProject> {
  const next = { ...project, updatedAt: Date.now() };
  await ws.s3.writeText(projectPath(project.projectId), JSON.stringify(next, null, 2), {
    contentType: "application/json",
  });
  return next;
}

async function readProjectFromWorkspace(ws: ReturnType<typeof getWorkspace>, projectId: string): Promise<EditorProject> {
  const data = await ws.s3.readText(projectPath(projectId));
  const raw = JSON.parse(data.content) as EditorProject;
  return { ...raw, recipe: migrateRecipe(raw.recipe) };
}

function targetSize(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case "9:16": return { width: 1080, height: 1920 };
    case "1:1": return { width: 1080, height: 1080 };
    case "16:9": return { width: 1920, height: 1080 };
    case "original": return { width: 1920, height: 1080 };
  }
}

function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// ─── Multimodal helpers (vision + transcript) ─────────────────────────────────
const EDITOR_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function imageMimeForExt(path: string): string | null {
  return EDITOR_IMAGE_MIME[extname(path || "").toLowerCase()] ?? null;
}

/**
 * Download a workspace image and return it as a downscaled JPEG base64 inline
 * part for Gemini vision. Images are read DIRECTLY by Gemini in both API-key
 * and Vertex modes — they never need GCS (unlike video/audio). Downscaling to
 * 1024px keeps token cost low and avoids shipping multi-MB originals. Falls
 * back to the original bytes if ffmpeg can't process the format.
 */
async function loadWorkspaceImageInline(
  ws: ReturnType<typeof getWorkspace>,
  path: string,
): Promise<{ mimeType: string; data: string } | null> {
  const srcMime = imageMimeForExt(path);
  if (!srcMime) return null;
  const dir = join(tmpdir(), `editor-img-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const local = join(dir, `img${extname(path) || ".png"}`);
    await downloadWorkspaceFile(ws, path, local);
    const scaled = join(dir, "scaled.jpg");
    try {
      await runFfmpegRaw(["-y", "-i", local, "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "5", scaled]);
      const bytes = await readFile(scaled);
      if (bytes.length > 0) return { mimeType: "image/jpeg", data: bytes.toString("base64") };
    } catch { /* fall back to original bytes below */ }
    const raw = await readFile(local);
    if (raw.length > 8_000_000) return null; // don't blow up the request with a huge original
    return { mimeType: srcMime, data: raw.toString("base64") };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Keep only SRT cues overlapping [startSec, endSec] so the agent can be handed
 * a time-bounded slice of a transcript instead of the whole file.
 */
function filterSrtByRange(srt: string, startSec: number, endSec: number): string {
  const toSec = (ts: string): number => {
    const m = ts.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  const kept: string[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const tl = block.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!tl) continue;
    if (toSec(tl[2]) >= startSec && toSec(tl[1]) <= endSec) kept.push(block.trim());
  }
  return kept.join("\n\n");
}

function overlayPositionAny(position: string, margin: number): string {
  switch (position) {
    case "top-left": return `${margin}:${margin}`;
    case "top-center": return `(W-w)/2:${margin}`;
    case "bottom-right": return `W-w-${margin}:H-h-${margin}`;
    case "bottom-left": return `${margin}:H-h-${margin}`;
    case "bottom-center": return `(W-w)/2:H-h-${margin}`;
    case "top-right":
    default:
      return `W-w-${margin}:${margin}`;
  }
}

function timelineEnable(clipStart: number, clipEnd: number): string {
  if (!(clipEnd > clipStart)) return "";
  return `:enable='between(t,${Math.max(0, clipStart).toFixed(3)},${clipEnd.toFixed(3)})'`;
}
function colorPresetFilter(preset: ColorPreset): string | null {
  switch (preset) {
    case "vivid": return "eq=saturation=1.35:contrast=1.08";
    case "muted": return "eq=saturation=0.65:contrast=0.95";
    case "bw": return "hue=s=0";
    case "warm": return "colorbalance=rs=0.10:gs=0.03:bs=-0.06,eq=saturation=1.1";
    case "cool": return "colorbalance=rs=-0.08:gs=0:bs=0.10,eq=saturation=1.05";
    case "none":
    default: return null;
  }
}

function assertRenderNotCancelled(job?: EditorJob): void {
  if (job?.status === "cancelled") throw new Error("render cancelled");
}

function cancelRenderJob(job: EditorJob): void {
  job.status = "cancelled";
  job.progress = 0;
  job.message = "Cancelled";
  job.error = null;
  job.completedAt = Date.now();
  const proc = activeRenderProcesses.get(job.jobId);
  if (proc && !proc.killed) proc.kill("SIGTERM");
}

type FfmpegProgressOpts = {
  /** Total expected output duration in seconds. Required for percent calc. */
  expectedDurationSec: number;
  /** Called with the latest output time in seconds (0..expectedDurationSec). */
  onProgress: (secsDone: number, totalSecs: number) => void;
};

function runFfmpegRaw(args: string[], job?: EditorJob, progressOpts?: FfmpegProgressOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    try { assertRenderNotCancelled(job); } catch (err) { reject(err); return; }
    // When progress is requested we route FFmpeg's machine-readable progress
    // stream to stdout (`-progress pipe:1`) and silence its noisy stderr
    // stats (`-nostats`). We still keep the regular stderr captured for
    // error reporting on non-zero exits.
    const enableProgress = Boolean(
      progressOpts && progressOpts.expectedDurationSec > 0 && typeof progressOpts.onProgress === "function",
    );
    const finalArgs = enableProgress
      ? ["-progress", "pipe:1", "-nostats", ...args]
      : args;
    const proc = spawn(FFMPEG_BIN, finalArgs);
    if (job) activeRenderProcesses.set(job.jobId, proc);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    if (enableProgress && proc.stdout) {
      let buf = "";
      proc.stdout.on("data", (chunk) => {
        buf += String(chunk);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          // FFmpeg emits key=value lines ending with `progress=continue|end`.
          // We only need out_time_us for time-based progress. Other useful
          // signals (frame=, fps=, bitrate=) are ignored to keep the parser
          // cheap.
          if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
            const raw = line.split("=")[1] || "";
            // FFmpeg historically named this key `out_time_ms` but
            // confusingly emitted microseconds. Newer builds use
            // `out_time_us`. Treat both as microseconds.
            const usec = parseInt(raw, 10);
            if (Number.isFinite(usec) && usec >= 0) {
              const secs = Math.min(usec / 1e6, progressOpts!.expectedDurationSec);
              try { progressOpts!.onProgress(secs, progressOpts!.expectedDurationSec); }
              catch { /* never let a UI callback crash the encode */ }
            }
          }
        }
      });
    }
    proc.on("error", (err) => {
      if (job) activeRenderProcesses.delete(job.jobId);
      if (job?.status === "cancelled") return reject(new Error("render cancelled"));
      return reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (job) activeRenderProcesses.delete(job.jobId);
      if (job?.status === "cancelled") return reject(new Error("render cancelled"));
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1200) || `FFmpeg exited with code ${code}`));
    });
  });
}

/**
 * Convenience wrapper that maps a single FFmpeg pass's wall-clock progress
 * onto a sub-range of the overall job progress bar. `fromPct..toPct` is the
 * slice of the job's 0..100 budget reserved for this stage.
 */
function ffmpegStageProgress(
  job: EditorJob,
  expectedDurationSec: number,
  fromPct: number,
  toPct: number,
): FfmpegProgressOpts {
  const span = Math.max(0, toPct - fromPct);
  return {
    expectedDurationSec,
    onProgress: (secsDone) => {
      if (expectedDurationSec <= 0) return;
      const stagePct = Math.min(1, secsDone / expectedDurationSec);
      const next = Math.round(fromPct + span * stagePct);
      // Never go backwards — earlier coarse stage updates may have already
      // advanced past `fromPct` when concurrent stages report progress.
      if (next > job.progress) job.progress = Math.min(toPct, next);
    },
  };
}

async function probeMetadata(input: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
  const ffprobeBin = (process.env.FFPROBE_BIN || "ffprobe").trim();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeBin, [
      "-v", "error", "-print_format", "json",
      "-show_format", "-show_streams", input,
    ]);
    let out = "";
    proc.stdout.on("data", (c) => { out += String(c); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ duration: 0, width: 0, height: 0, hasAudio: false });
      try {
        const parsed = JSON.parse(out);
        const video = (parsed.streams || []).find((s: any) => s.codec_type === "video");
        const audio = (parsed.streams || []).find((s: any) => s.codec_type === "audio");
        const duration = parseFloat(parsed.format?.duration ?? video?.duration ?? "0");
        resolve({
          duration: Number.isFinite(duration) ? duration : 0,
          width: video?.width ?? 0,
          height: video?.height ?? 0,
          hasAudio: Boolean(audio),
        });
      } catch {
        resolve({ duration: 0, width: 0, height: 0, hasAudio: false });
      }
    });
  });
}

async function probeDuration(input: string): Promise<number> {
  const ffprobeBin = (process.env.FFPROBE_BIN || "ffprobe").trim();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input]);
    let out = "";
    proc.stdout.on("data", (chunk) => { out += String(chunk); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

async function concatClips(inputs: string[], output: string, job?: EditorJob, progressOpts?: FfmpegProgressOpts): Promise<void> {
  const args: string[] = ["-y"];
  for (const p of inputs) args.push("-i", p);
  const filters: string[] = [];
  const segs: string[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const meta = await probeMetadata(inputs[i]).catch(() => ({ duration: 0, width: 0, height: 0, hasAudio: false }));
    if (meta.hasAudio) {
      segs.push(`[${i}:v:0][${i}:a:0]`);
    } else {
      const duration = Math.max(0.1, meta.duration || await probeDuration(inputs[i]).catch(() => 0) || 0.1);
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}[a${i}]`);
      segs.push(`[${i}:v:0][a${i}]`);
    }
  }
  filters.push(`${segs.join("")}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  );
  await runFfmpegRaw(args, job, progressOpts);
}

/**
 * Joins clips with a real video+audio crossfade (xfade + acrossfade) at the
 * boundaries. Falls back to plain concat if a duration probe fails.
 */
function xfadeTransitionName(type?: TransitionType): string {
  switch (type) {
    case "blur": return "hblur";
    case "dip-to-black": return "fadeblack";
    case "wipe": return "wipeleft";
    case "crossfade":
    case "fade":
    default:
      return "fade";
  }
}

async function crossfadeClips(inputs: string[], output: string, transitions: TransitionDef[] = [], job?: EditorJob, progressOpts?: FfmpegProgressOpts): Promise<void> {
  if (inputs.length < 2) { await concatClips(inputs, output, job, progressOpts); return; }
  const fadeDurations = Array.from({ length: inputs.length - 1 }, (_, i) =>
    Math.max(0.1, Math.min(2, transitions[i]?.duration ?? 0.5)),
  );
  const durations: number[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const p = inputs[i];
    const meta = await probeMetadata(p).catch(() => ({ duration: 0, width: 0, height: 0, hasAudio: false }));
    if (!meta.hasAudio) { await concatClips(inputs, output, job, progressOpts); return; }
    const d = meta.duration || await probeDuration(p).catch(() => 0);
    const required = Math.max(fadeDurations[i - 1] ?? 0, fadeDurations[i] ?? 0) * 2;
    if (!Number.isFinite(d) || d <= required) { await concatClips(inputs, output, job, progressOpts); return; }
    durations.push(d);
  }
  const args: string[] = ["-y"];
  for (const p of inputs) args.push("-i", p);
  const vFilters: string[] = [];
  const aFilters: string[] = [];
  let vLabel = "0:v";
  let aLabel = "0:a";
  let cumOffset = 0;
  for (let i = 1; i < inputs.length; i += 1) {
    const transition = transitions[i - 1];
    const fadeDur = fadeDurations[i - 1] ?? 0.5;
    cumOffset += durations[i - 1] - fadeDur;
    const vOut = `xv${i}`;
    const aOut = `xa${i}`;
    vFilters.push(`[${vLabel}][${i}:v]xfade=transition=${xfadeTransitionName(transition?.type)}:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}]`);
    aFilters.push(`[${aLabel}][${i}:a]acrossfade=d=${fadeDur}:c1=tri:c2=tri[${aOut}]`);
    vLabel = vOut;
    aLabel = aOut;
  }
  args.push(
    "-filter_complex", [...vFilters, ...aFilters].join(";"),
    "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  );
  await runFfmpegRaw(args, job, progressOpts);
}

async function downloadWorkspaceFile(ws: ReturnType<typeof getWorkspace>, path: string, dest: string): Promise<void> {
  const { url } = await ws.s3.presignGet(path, { disposition: "inline" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${path}: ${res.status}`);
  await streamResponseToFile(res, dest);
}

/**
 * Streams a fetch Response body straight to disk. Replaces the previous
 * `Buffer.from(await res.arrayBuffer())` pattern that buffered entire video
 * downloads (potentially gigabytes) in memory.
 */
async function streamResponseToFile(res: Response | globalThis.Response, dest: string): Promise<void> {
  const body = (res as any).body;
  if (!body) {
    // Some test/mock responses don't expose a stream — fall back to buffer.
    const buf = Buffer.from(await (res as any).arrayBuffer());
    await writeFile(dest, buf);
    return;
  }
  const nodeStream = typeof Readable.fromWeb === "function" && typeof body.getReader === "function"
    ? Readable.fromWeb(body as any)
    : (body as any);
  await pipeline(nodeStream, createWriteStream(dest));
}

async function uploadWorkspaceFile(ws: ReturnType<typeof getWorkspace>, source: string, destPath: string): Promise<void> {
  const bytes = await readFile(source);
  const presign = await ws.s3.presignPut(destPath, { size: bytes.length, contentType: "video/mp4" });
  const res = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Could not upload render: ${res.status}`);
}

async function persistJobToProject(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<void> {
  const latest = await readProjectFromWorkspace(ws, projectId);
  await writeProjectToWorkspace(ws, {
    ...latest,
    renders: latest.renders.map((entry) => entry.jobId === job.jobId ? {
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      message: job.message,
      outputPath: job.outputPath,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    } : entry),
  });
}

function mapDdbStatusToRenderStatus(status: string | undefined): RenderStatus {
  const ddbToRender: Record<string, RenderStatus> = {
    pending: "pending",
    queued: "pending",
    runnable: "pending",
    starting: "running",
    running: "running",
    processing: "running",
    done: "done",
    completed: "done",
    success: "done",
    error: "error",
    failed: "error",
    cancelled: "cancelled",
    canceled: "cancelled",
  };
  return ddbToRender[(status || "").toLowerCase()] ?? "running";
}

function mapDdbRenderJob(jobId: string, ddbStatus: any, fallback?: Partial<EditorJob>): EditorJob {
  const status = mapDdbStatusToRenderStatus(ddbStatus?.status);
  const isTerminal = status === "done" || status === "error" || status === "cancelled";
  return {
    jobId,
    projectId: fallback?.projectId ?? "",
    kind: fallback?.kind ?? "final",
    status,
    progress: ddbStatus?.progressPct ?? (status === "done" ? 100 : status === "pending" ? 1 : 50),
    message: ddbStatus?.message || fallback?.message || status,
    outputPath: ddbStatus?.s3Key ?? fallback?.outputPath ?? null,
    error: status === "error" ? (ddbStatus?.message || fallback?.error || "Render failed") : null,
    createdAt: fallback?.createdAt ?? 0,
    completedAt: isTerminal ? Date.now() : fallback?.completedAt ?? null,
  };
}

async function markRenderDispatchError(
  ws: ReturnType<typeof getWorkspace>,
  projectId: string,
  job: EditorJob,
  message: string,
): Promise<void> {
  job.status = "error";
  job.progress = 0;
  job.message = message;
  job.error = message;
  job.completedAt = Date.now();
  await persistJobToProject(ws, projectId, job).catch((err) => {
    logger.warn({ err, jobId: job.jobId }, "[video-editor] failed to persist render dispatch error");
  });
}

async function trySubmitEditorBatch(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<boolean> {
  try {
    const batchId = await submitEditorRenderJob({
      jobId: job.jobId,
      workspaceId: ws.identity.workspaceId,
      projectId,
      kind: job.kind,
    });
    if (batchId) { jobs.delete(job.jobId); return true; }
    return false;
  } catch (err) {
    logger.error({ err, jobId: job.jobId }, "[video-editor] batch submit failed");
    return false;
  }
}

async function tryInvokeEditorWorker(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<boolean> {
  if (!editorLambdaClient || !EDITOR_WORKER_FUNCTION_NAME || !isEditorDdbConfigured()) return false;
  try {
    await putEditorJobQueued(job.jobId, projectId, job.kind);
    await editorLambdaClient.send(new InvokeCommand({
      FunctionName: EDITOR_WORKER_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({
        source: "videomaking.editor",
        jobId: job.jobId,
        workspaceId: ws.identity.workspaceId,
        projectId,
        kind: job.kind,
      })),
    }));
    // Status now lives in DynamoDB — drop the in-memory entry so polling
    // falls through to the worker's DDB progress writes.
    jobs.delete(job.jobId);
    return true;
  } catch (err) {
    logger.error({ err, jobId: job.jobId }, "[video-editor] worker Lambda invoke failed");
    return false;
  }
}

async function dispatchRenderJob(
  ws: ReturnType<typeof getWorkspace>,
  projectId: string,
  job: EditorJob,
): Promise<void> {
  // Estimate the output length to choose Lambda (fast, ≤ threshold) vs
  // Fargate/Batch (heavy, > threshold, no 15-min cap).
  let expectedSec = 0;
  try {
    const p = await readProjectFromWorkspace(ws, projectId) as EditorProjectV2;
    if (p.timeline) expectedSec = computeTimelineDuration(p.timeline);
  } catch { /* best-effort */ }
  const isLong = expectedSec > EDITOR_RENDER_FARGATE_THRESHOLD_SEC;

  // 1) Long renders → Fargate/Batch first (no 15-min Lambda cap).
  if (isLong && VIDEO_EDITOR_QUEUE_ENABLED) {
    if (await trySubmitEditorBatch(ws, projectId, job)) return;
  }
  // 2) Default fast path → self-invoke worker Lambda (near-instant start).
  if (await tryInvokeEditorWorker(ws, projectId, job)) return;
  // 3) Batch fallback (short render w/o worker, or worker invoke failed).
  if (VIDEO_EDITOR_QUEUE_ENABLED) {
    if (await trySubmitEditorBatch(ws, projectId, job)) return;
  }
  // 4) Inline — local/dev only. In Lambda a fire-and-forget final render
  //    would be frozen after the response, so error clearly instead.
  if (IS_LAMBDA && job.kind === "final") {
    await markRenderDispatchError(
      ws,
      projectId,
      job,
      "AI Studio final renders need the worker Lambda (VIDEO_EDITOR_WORKER_FUNCTION_NAME) or the Batch queue in production.",
    );
    return;
  }
  if (RUN_RENDER_INLINE) await processRenderJob(ws, projectId, job);
  else void processRenderJob(ws, projectId, job);
}

export type EditorRenderProgress = (state: { status: RenderStatus; progress: number; message: string; outputPath?: string | null; error?: string | null }) => void | Promise<void>;

export async function runEditorRenderStandalone(params: {
  workspaceId: string;
  projectId: string;
  jobId: string;
  kind: "preview" | "final";
  onProgress?: EditorRenderProgress;
}): Promise<{ outputPath: string }> {
  const { getWorkspaceById } = await import("../lib/workspace");
  const ws = getWorkspaceById(params.workspaceId);
  const ephemeralJob: EditorJob = {
    jobId: params.jobId,
    projectId: params.projectId,
    kind: params.kind,
    status: "running",
    progress: 5,
    message: "Starting...",
    outputPath: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  if (params.onProgress) {
    // Lightweight progress observer — periodic snapshot of the mutated job.
    const interval = setInterval(() => {
      void params.onProgress?.({ status: ephemeralJob.status, progress: ephemeralJob.progress, message: ephemeralJob.message, outputPath: ephemeralJob.outputPath, error: ephemeralJob.error ?? null });
    }, 2000);
    try {
      await processRenderJob(ws, params.projectId, ephemeralJob);
    } finally {
      clearInterval(interval);
    }
  } else {
    await processRenderJob(ws, params.projectId, ephemeralJob);
  }
  if (ephemeralJob.status === "error") throw new Error(ephemeralJob.error || "render failed");
  await params.onProgress?.({ status: ephemeralJob.status, progress: ephemeralJob.progress, message: ephemeralJob.message, outputPath: ephemeralJob.outputPath, error: null });
  return { outputPath: ephemeralJob.outputPath || "" };
}

/**
 * Worker-Lambda entry for editor renders (async self-invoke). Runs the render
 * and reports progress through the DynamoDB jobs table so the frontend polls
 * GET /jobs/:id identically whether the render ran here or on Batch.
 */
export async function runEditorRenderWorker(params: {
  workspaceId: string;
  projectId: string;
  jobId: string;
  kind: "preview" | "final";
}): Promise<void> {
  await updateEditorJobStatus(params.jobId, { status: "running", message: "Rendering...", progressPct: 5 }).catch(() => {});
  try {
    const { outputPath } = await runEditorRenderStandalone({
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      jobId: params.jobId,
      kind: params.kind,
      onProgress: async (state) => {
        await updateEditorJobStatus(params.jobId, {
          // "done" from the renderer means the file is written; keep the DDB
          // record "running" until the upload completes below.
          status: state.status === "done" ? "running" : state.status,
          message: state.message,
          progressPct: state.progress,
          ...(state.outputPath ? { s3Key: state.outputPath } : {}),
        }).catch(() => {});
      },
    });
    await updateEditorJobStatus(params.jobId, { status: "done", message: "Render complete", progressPct: 100, s3Key: outputPath }).catch(() => {});
  } catch (err) {
    await updateEditorJobStatus(params.jobId, { status: "error", message: err instanceof Error ? err.message : "render failed", progressPct: 0 }).catch(() => {});
    throw err;
  }
}

async function processRenderJob(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<void> {
  const dir = join(tmpdir(), `video-editor-${job.jobId}`);
  await mkdir(dir, { recursive: true });
  try {
    const project = await readProjectFromWorkspace(ws, projectId) as EditorProjectV2;
    const tl = project.timeline ?? undefined;
    const hasV2Clips = tl && tl.tracks.video.length > 0;

    if (!hasV2Clips) throw new Error("No timeline clips to render. Use the agent to add clips first.");

    const outputPath = join(dir, `${job.kind}.mp4`);
    const workspaceOutput = `editor/renders/${projectId}/${job.kind}-${job.jobId}.mp4`;
    const aspectRatio = tl?.export?.aspectRatio || project.recipe.aspectRatio || "original";
    const cropModeVal = tl?.export?.cropMode || project.recipe.cropMode || "smart";
    const colorPresetVal = tl?.export?.colorPreset || project.recipe.colorPreset || "none";
    const { width, height } = targetSize(aspectRatio);

    if (hasV2Clips) {
      // ═══ V2 Multi-clip timeline render ═══
      await resolveOpenEndedClipDurations(ws, tl!);
      const clips = tl!.tracks.video;
      const overlays = tl!.tracks.overlays;
      const audioTracks = tl!.tracks.audio;

      job.message = "Downloading clips...";
      job.progress = 5;

      const normalizedPaths: string[] = [];
      const normalizedDurations: number[] = [];
      const assetCache = new Map<string, string>();
      // For preview kind, distribute the 8s budget across the first clips
      // so multi-clip previews actually show transitions, not just clip 0.
      const PREVIEW_BUDGET_SEC = 8;
      let previewBudgetRemaining = PREVIEW_BUDGET_SEC;
      // Reserve 5..45 of the progress bar for clip processing — split it
      // evenly across clips so the bar advances smoothly inside each pass
      // instead of jumping in 40/N steps once per clip.
      const CLIP_PROGRESS_FROM = 5;
      const CLIP_PROGRESS_TO = 45;
      const perClipSpan = clips.length > 0 ? (CLIP_PROGRESS_TO - CLIP_PROGRESS_FROM) / clips.length : 0;
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        job.message = `Processing clip ${i + 1}/${clips.length}...`;
        const clipFromPct = CLIP_PROGRESS_FROM + Math.round(i * perClipSpan);
        const clipToPct = CLIP_PROGRESS_FROM + Math.round((i + 1) * perClipSpan);
        job.progress = Math.max(job.progress, clipFromPct);

        let assetPath = assetCache.get(clip.asset);
        if (!assetPath) {
          assetPath = join(dir, `asset-${i}${extname(clip.asset) || ".mp4"}`);
          await downloadWorkspaceFile(ws, clip.asset, assetPath);
          assetCache.set(clip.asset, assetPath);
        }

        const clipPath = join(dir, `clip-${i}.mp4`);
        const trimArgs: string[] = ["-y"];
        if (clip.srcIn > 0) trimArgs.push("-ss", String(clip.srcIn));
        const speed = Math.max(0.25, Math.min(4, clip.speed || 1));
        const srcDur = clip.srcOut > 0 ? clip.srcOut - clip.srcIn : 0;
        const fullClipDur = srcDur > 0 ? srcDur / speed : Infinity;
        let usedDur = fullClipDur;
        if (job.kind === "preview") {
          const slice = Math.min(previewBudgetRemaining, fullClipDur, 4);
          if (slice <= 0) break;
          usedDur = slice;
          trimArgs.push("-t", String(slice * speed));
        } else if (srcDur > 0) {
          trimArgs.push("-t", String(srcDur));
        }

        const scaleFilter = cropModeVal === "contain"
          ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
          : cropModeVal === "fit-blur"
            ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
            : `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`;

        const vFilters: string[] = [scaleFilter];
        if (Math.abs(speed - 1) > 0.001) vFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
        const clipColor = clip.colorPreset || colorPresetVal;
        const cf = colorPresetFilter(clipColor as ColorPreset);
        if (cf) vFilters.push(cf);

        const aFilters: string[] = [];
        if (Math.abs(speed - 1) > 0.001) {
          let remaining = speed;
          const chain: string[] = [];
          while (remaining > 2.0001) { chain.push("atempo=2.0"); remaining /= 2; }
          while (remaining < 0.5 - 0.0001) { chain.push("atempo=0.5"); remaining /= 0.5; }
          chain.push(`atempo=${remaining.toFixed(4)}`);
          aFilters.push(...chain);
        }

        trimArgs.push("-i", assetPath, "-vf", vFilters.join(","));
        if (aFilters.length) trimArgs.push("-af", aFilters.join(","));
        trimArgs.push(
          "-c:v", "libx264", "-preset", "veryfast", "-crf", job.kind === "preview" ? "28" : "22",
          "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart", clipPath,
        );
        const expectedClipOutSec = Number.isFinite(usedDur) && usedDur > 0 ? usedDur : 0;
        await runFfmpegRaw(
          trimArgs,
          job,
          expectedClipOutSec > 0 ? ffmpegStageProgress(job, expectedClipOutSec, clipFromPct, clipToPct) : undefined,
        );
        assertRenderNotCancelled(job);
        normalizedPaths.push(clipPath);
        normalizedDurations.push(expectedClipOutSec);
        if (job.kind === "preview") {
          previewBudgetRemaining -= usedDur;
          if (previewBudgetRemaining <= 0.05) break;
        }
      }

      job.message = `Joining ${normalizedPaths.length} clip(s)...`;
      job.progress = Math.max(job.progress, CLIP_PROGRESS_TO);
      const joinedPath = join(dir, "joined.mp4");
      // Sum of expected output durations gives us a good estimate for the
      // join+overlay+mix passes; xfade subtracts a little but a rough
      // estimate is much better than a frozen progress bar.
      const joinedExpectedSec = normalizedDurations.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      if (normalizedPaths.length === 1) {
        await (await import("fs/promises")).rename(normalizedPaths[0], joinedPath);
      } else {
        const hasXfade = clips.some((c, i) => i > 0 && (c.transitionIn?.type && c.transitionIn.type !== "none") || (clips[i - 1]?.transitionOut?.type && clips[i - 1].transitionOut!.type !== "none"));
        const joinProgress = joinedExpectedSec > 0 ? ffmpegStageProgress(job, joinedExpectedSec, CLIP_PROGRESS_TO, 65) : undefined;
        if (hasXfade) {
          const transitions = clips.slice(1).map((clip, i) => {
            const prev = clips[i];
            return clip.transitionIn?.type && clip.transitionIn.type !== "none"
              ? clip.transitionIn
              : prev.transitionOut?.type && prev.transitionOut.type !== "none"
                ? prev.transitionOut
                : { type: "fade" as const, duration: 0.5 };
          });
          await crossfadeClips(normalizedPaths, joinedPath, transitions, job, joinProgress);
        } else {
          await concatClips(normalizedPaths, joinedPath, job, joinProgress);
        }
      }
      assertRenderNotCancelled(job);

      let currentPath = joinedPath;
      if (overlays.length > 0) {
        job.message = "Applying overlays...";
        job.progress = Math.max(job.progress, 65);
        const overlayedPath = join(dir, "overlayed.mp4");
        const oArgs: string[] = ["-y", "-i", currentPath];
        const oFilters: string[] = [];
        let inputIdx = 1;
        let current = "0:v";
        let step = 0;

        for (const ov of overlays) {
          const hasCoords = typeof ov.xPct === "number" && typeof ov.yPct === "number";
          const px = Math.max(0, Math.min(1, ov.xPct ?? 0));
          const py = Math.max(0, Math.min(1, ov.yPct ?? 0));
          if (ov.type === "logo" || ov.type === "image") {
            const imageLocal = join(dir, `${ov.type}-${ov.id}${extname(ov.content) || ".png"}`);
            await downloadWorkspaceFile(ws, ov.content, imageLocal);
            oArgs.push("-i", imageLocal);
            const widthPercent = ov.style?.widthPercent || (ov.type === "logo" ? 8 : 28);
            const imageWidth = Math.max(48, Math.round(width * (widthPercent / 100)));
            const margin = Math.round(width * 0.045);
            const keyFilter = ov.style?.key === "auto-white" ? "format=rgba,colorkey=0xffffff:0.30:0.20," : ov.style?.key === "auto-black" ? "format=rgba,colorkey=0x000000:0.30:0.20," : "";
            const enable = timelineEnable(ov.tlStart || 0, ov.tlEnd || 0);
            // Free coordinates (overlay CENTER at px,py) take precedence over
            // the named anchor when present — clamped so the center stays
            // on-frame. Otherwise fall back to the 6 named anchors.
            const pos = hasCoords
              ? `(W*${px.toFixed(4)}-w/2):(H*${py.toFixed(4)}-h/2)`
              : overlayPositionAny(ov.position || "top-right", margin);
            oFilters.push(`[${inputIdx}:v]${keyFilter}scale=${imageWidth}:-1:flags=lanczos[image${step}]`);
            oFilters.push(`[${current}][image${step}]overlay=${pos}:format=auto${enable}[v${step}]`);
            current = `v${step}`;
            step++;
            inputIdx++;
          } else if (ov.type === "text") {
            const fontSize = Math.max(34, Math.round(width * 0.055));
            let x: string;
            let y: string;
            if (hasCoords) {
              x = `(w*${px.toFixed(4)}-text_w/2)`;
              y = `(h*${py.toFixed(4)}-text_h/2)`;
            } else {
              y = String(ov.position === "top-left" ? Math.round(height * 0.08) : Math.round(height * 0.88));
              x = ov.position === "bottom-right" ? `w-text_w-${Math.round(width * 0.06)}` : "(w-text_w)/2";
            }
            const enable = timelineEnable(ov.tlStart || 0, ov.tlEnd || 0);
            oFilters.push(`[${current}]drawtext=text='${escapeDrawText(ov.content)}':fontcolor=white:fontsize=${fontSize}:borderw=3:bordercolor=black@0.65:x=${x}:y=${y}${enable}[v${step}]`);
            current = `v${step}`;
            step++;
          }
        }
        if (oFilters.length > 0) {
          oArgs.push("-filter_complex", oFilters.join(";"), "-map", `[${current}]`, "-map", "0:a?");
          oArgs.push("-c:v", "libx264", "-preset", "veryfast", "-crf", job.kind === "preview" ? "28" : "22");
          oArgs.push("-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", overlayedPath);
          const overlayProgress = joinedExpectedSec > 0
            ? ffmpegStageProgress(job, joinedExpectedSec, 65, 78)
            : undefined;
          await runFfmpegRaw(oArgs, job, overlayProgress);
          assertRenderNotCancelled(job);
          currentPath = overlayedPath;
        }
      }

      if (audioTracks.length > 0 && job.kind === "final") {
        job.message = "Mixing audio...";
        job.progress = Math.max(job.progress, 78);
        const mixedPath = join(dir, "mixed.mp4");
        const mArgs: string[] = ["-y", "-i", currentPath];
        const mFilters: string[] = [];
        const baseMeta = await probeMetadata(currentPath).catch(() => ({ duration: 0, width: 0, height: 0, hasAudio: false }));
        const baseAudio = baseMeta.hasAudio ? "[0:a]" : "[basea]";
        if (!baseMeta.hasAudio) {
          const duration = Math.max(0.1, baseMeta.duration || await probeDuration(currentPath).catch(() => 0) || 0.1);
          mFilters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}[basea]`);
        }
        let aIdx = 1;
        for (const at of audioTracks) {
          const audioLocal = join(dir, `audio-${at.id}${extname(at.asset) || ".mp3"}`);
          await downloadWorkspaceFile(ws, at.asset, audioLocal);
          mArgs.push("-i", audioLocal);
          const vol = Math.pow(10, (at.volumeDb || -10) / 20);
          const filters = [`volume=${vol.toFixed(3)}`];
          if (at.tlEnd > at.tlStart) filters.push(`atrim=duration=${Math.max(0.1, at.tlEnd - at.tlStart).toFixed(3)}`);
          if (at.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${Math.max(0.01, at.fadeIn).toFixed(3)}`);
          if (at.fadeOut > 0 && at.tlEnd > at.tlStart) filters.push(`afade=t=out:st=${Math.max(0, at.tlEnd - at.tlStart - at.fadeOut).toFixed(3)}:d=${Math.max(0.01, at.fadeOut).toFixed(3)}`);
          filters.push(`adelay=${Math.round((at.tlStart || 0) * 1000)}|${Math.round((at.tlStart || 0) * 1000)}`);
          mFilters.push(`[${aIdx}:a]${filters.join(",")}[bg${aIdx}]`);
          aIdx++;
        }
        mFilters.push(`${baseAudio}${audioTracks.map((_, i) => `[bg${i + 1}]`).join("")}amix=inputs=${audioTracks.length + 1}:duration=first:dropout_transition=2[aout]`);
        mArgs.push("-filter_complex", mFilters.join(";"), "-map", "0:v", "-map", "[aout]");
        mArgs.push("-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", mixedPath);
        const audioMixProgress = joinedExpectedSec > 0
          ? ffmpegStageProgress(job, joinedExpectedSec, 78, 88)
          : undefined;
        await runFfmpegRaw(mArgs, job, audioMixProgress);
        assertRenderNotCancelled(job);
        currentPath = mixedPath;
      }

      if (currentPath !== outputPath) {
        await (await import("fs/promises")).rename(currentPath, outputPath);
      }
    } else {
      throw new Error("No timeline clips to render. Use the agent to add clips first.");
    }

    assertRenderNotCancelled(job);
    if (!statSync(outputPath).size) throw new Error("Render produced an empty file");
    job.message = "Saving render to workspace...";
    job.progress = 92;
    await uploadWorkspaceFile(ws, outputPath, workspaceOutput);
    job.outputPath = workspaceOutput;
    job.progress = 99;
    job.message = "Finalizing render...";
    const completedJob: EditorJob = {
      ...job,
      status: "done",
      progress: 100,
      message: "Render saved to workspace.",
      completedAt: Date.now(),
    };
    await persistJobToProject(ws, projectId, completedJob);
    Object.assign(job, completedJob);
  } catch (err) {
    if (job.status === "cancelled") {
      job.progress = 0;
      job.message = "Cancelled";
      job.error = null;
    } else {
      job.status = "error";
      job.progress = 0;
      job.message = err instanceof Error ? err.message : "Render failed";
      job.error = job.message;
    }
    job.completedAt = Date.now();
    await persistJobToProject(ws, projectId, job).catch((writeErr) => {
      logger.warn({ err: writeErr, jobId: job.jobId }, "[video-editor] failed to persist render error");
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

router.post("/projects", async (req: Request, res: Response) => {
  try {
    const sourceVideo = cleanWorkspacePath(req.body?.sourceVideo);
    const assets: EditorAssets = {
      logo: cleanWorkspacePath(req.body?.assets?.logo),
      intro: cleanWorkspacePath(req.body?.assets?.intro),
      outro: cleanWorkspacePath(req.body?.assets?.outro),
    };
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const title = typeof req.body?.title === "string" && req.body.title.trim()
      ? req.body.title.trim().slice(0, 80)
      : "AI Video Studio Project";
    const now = Date.now();
    const project: EditorProject = {
      projectId: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      sourceVideo,
      assets,
      prompt,
      recipe: generateRecipe(prompt, sourceVideo, assets),
      renders: [],
    };
    await writeProject(req, project);
    return res.json({ project });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/projects/:projectId", async (req: Request, res: Response) => {
  try {
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    return res.json({ project });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/notfound|not found|nosuchkey/i.test(msg)) return bad(res, 404, "project not found");
    return fail(res, err);
  }
});


router.post("/projects/:projectId/preview", async (req: Request, res: Response) => {
  return startRender(req, res, "preview");
});

router.post("/projects/:projectId/render", async (req: Request, res: Response) => {
  return startRender(req, res, "final");
});

async function startRender(req: Request, res: Response, kind: "preview" | "final") {
  try {
    const ws = getWorkspace(req);
    let project = await readProjectFromWorkspace(ws, routeParam(req.params.projectId, "projectId")) as EditorProjectV2;
    const hasTimelineClips = Boolean(project.timeline?.tracks.video.length);
    if (!project.sourceVideo && !hasTimelineClips) return bad(res, 400, "source video or timeline clips required");
    // Idempotency: if a render of the same kind is already pending or
    // running for this project, return the existing job instead of starting
    // a second ffmpeg pass that races on the same workspace key.
    const existing = project.renders.find(
      (r) => r.kind === kind && (r.status === "pending" || r.status === "running"),
    );
    if (existing) {
      const liveJob = jobs.get(existing.jobId);
      if (liveJob) return res.json({ job: liveJob, project });
      const fallback: EditorJob = {
        jobId: existing.jobId,
        projectId: project.projectId,
        kind: existing.kind,
        status: existing.status,
        progress: existing.progress,
        message: existing.message,
        outputPath: existing.outputPath,
        error: null,
        createdAt: existing.createdAt,
        completedAt: existing.completedAt,
      };
      if (VIDEO_EDITOR_QUEUE_ENABLED) {
        const ddbStatus = await getJobStatusFromDdb(existing.jobId).catch(() => null);
        if (ddbStatus) return res.json({ job: mapDdbRenderJob(existing.jobId, ddbStatus, fallback), project });
      }
      if (Date.now() - existing.createdAt < STALE_PENDING_RENDER_MS) {
        return res.json({ job: fallback, project });
      }
      project = {
        ...project,
        renders: project.renders.map((entry) => entry.jobId === existing.jobId ? {
          ...entry,
          status: "error" as const,
          progress: 0,
          message: "Previous render worker stopped before reporting progress. Starting a fresh render.",
          completedAt: Date.now(),
        } : entry),
      };
    }
    const job: EditorJob = {
      jobId: randomUUID(),
      projectId: project.projectId,
      kind,
      status: "pending",
      progress: 1,
      message: "Queued render...",
      outputPath: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    jobs.set(job.jobId, job);
    const next = await writeProjectToWorkspace(ws, {
      ...project,
      renders: [
        {
          jobId: job.jobId,
          kind,
          status: job.status,
          progress: job.progress,
          message: job.message,
          outputPath: job.outputPath,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        },
        ...project.renders,
      ].slice(0, 20),
    });
    await dispatchRenderJob(ws, project.projectId, job);
    const responseProject = await readProjectFromWorkspace(ws, project.projectId).catch(() => next);
    return res.json({ job, project: responseProject });
  } catch (err) {
    return fail(res, err);
  }
}

router.get("/jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = routeParam(req.params.jobId, "jobId");
  const job = jobs.get(jobId);
  if (job) return res.json({ job });
  // Fall back to DynamoDB (Batch-submitted jobs).
  try {
    const ddbStatus = await getJobStatusFromDdb(jobId);
    if (!ddbStatus) return bad(res, 404, "job not found");
    return res.json({ job: mapDdbRenderJob(jobId, ddbStatus) });
  } catch (err) {
    logger.warn({ err, jobId }, "[video-editor] ddb job lookup failed");
    return bad(res, 404, "job not found");
  }
});

router.post("/jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const job = jobs.get(routeParam(req.params.jobId, "jobId"));
  if (!job) return bad(res, 404, "job not found");
  if (job.status === "pending" || job.status === "running") {
    cancelRenderJob(job);
    await persistJobToProject(getWorkspace(req), job.projectId, job).catch((err) => {
      logger.warn({ err, jobId: job.jobId }, "[video-editor] failed to persist render cancellation");
    });
  }
  return res.json({ job });
});

// ─── Manual recipe overrides ──────────────────────────────────────────────────
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

router.patch("/projects/:projectId/timeline", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const projectId = routeParam(req.params.projectId, "projectId");
    const project = await readProjectFromWorkspace(ws, projectId);
    
    // Accept either { timeline: {...} } or the timeline directly.
    const timeline = req.body && typeof req.body.timeline === "object" ? req.body.timeline : req.body;
    
    const next = await writeProjectToWorkspace(ws, { ...project, timeline } as any);
    return res.json({ project: next });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/projects", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const listing = await ws.s3.list("editor/projects/", { limit: 200 }).catch(() => ({ files: [] as Array<{ path: string }> }));
    const ids: string[] = (listing.files || [])
      .map((f) => String(f.path || ""))
      .map((k) => k.match(/editor\/projects\/([a-f0-9-]{20,80})\.json$/i)?.[1])
      .filter((id: string | null | undefined): id is string => Boolean(id));
    const projects = await Promise.all(ids.slice(0, 40).map(async (id) => {
      try {
        const p = await readProjectFromWorkspace(ws, id);
        return { projectId: p.projectId, title: p.title, updatedAt: p.updatedAt, sourceVideo: p.sourceVideo };
      } catch { return null; }
    }));
    return res.json({
      projects: projects.filter((p): p is NonNullable<typeof p> => p !== null)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    });
  } catch (err) {
    return fail(res, err);
  }
});

router.delete("/projects/:projectId", async (req: Request, res: Response) => {
  try {
    const pid = routeParam(req.params.projectId, "projectId");
    const ws = getWorkspace(req);
    // Use distinct names from the module-level `projectPath` helper so
    // there's no readability or refactor pitfall.
    const projectKey = `editor/projects/${pid}.json`;
    // The chat file actually lives at `editor/projects/<pid>.chat.json`
    // (see `chatPath` further down). The legacy `editor/chats/<pid>.json`
    // path was never used. Delete both for safety.
    const chatKeyV1 = `editor/projects/${pid}.chat.json`;
    const chatKeyLegacy = `editor/chats/${pid}.json`;
    const uploadsPrefix = `editor/uploads/${pid}/`;
    const rendersPrefix = `editor/renders/${pid}/`;
    await ws.s3.delete(projectKey).catch(() => {});
    await ws.s3.delete(chatKeyV1).catch(() => {});
    await ws.s3.delete(chatKeyLegacy).catch(() => {});
    // Wipe both upload and render trees so deleting a project actually frees
    // storage instead of just orphaning every previously-rendered MP4.
    for (const prefix of [uploadsPrefix, rendersPrefix]) {
      const listing = await ws.s3
        .list(prefix, { limit: 500 })
        .catch(() => ({ files: [] as Array<{ path: string }> }));
      const files = (listing.files || []).map((f) => String(f.path || "")).filter(Boolean);
      await Promise.all(files.map((f) => ws.s3.delete(f).catch(() => {})));
    }
    // Drop any in-memory job entries for this project so a stale render isn't
    // surfaced after the user creates a new project with the same id (rare,
    // but possible when a legacy project file is restored from a backup).
    for (const [jobId, job] of jobs.entries()) {
      if (job.projectId === pid) jobs.delete(jobId);
    }
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/projects/:projectId/probe", async (req: Request, res: Response) => {
  try {
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    if (!project.sourceVideo) return bad(res, 400, "source video required");
    const ws = getWorkspace(req);
    const dir = join(tmpdir(), `editor-probe-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const local = join(dir, `source${extname(project.sourceVideo) || ".mp4"}`);
    try {
      await downloadWorkspaceFile(ws, project.sourceVideo, local);
      const meta = await probeMetadata(local);
      // Auto-fill trim.end if not set yet.
      if (meta.duration > 0 && (project.recipe.trim.end == null || project.recipe.trim.end <= 0)) {
        const next = await writeProject(req, {
          ...project,
          recipe: { ...project.recipe, trim: { ...project.recipe.trim, end: Math.round(meta.duration) } },
        });
        return res.json({ project: next, probe: meta });
      }
      return res.json({ project, probe: meta });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return fail(res, err);
  }
});

// ─── Chat persistence ─────────────────────────────────────────────────────────
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool?: { name: string; args?: any; result?: any };
  createdAt: number;
};

function chatPath(projectId: string): string {
  if (!/^[a-f0-9-]{20,80}$/i.test(projectId)) throw new Error("invalid project id");
  return `editor/projects/${projectId}.chat.json`;
}

async function readChat(req: Request, projectId: string): Promise<ChatMessage[]> {
  const ws = getWorkspace(req);
  try {
    const data = await ws.s3.readText(chatPath(projectId));
    const parsed = JSON.parse(data.content);
    return Array.isArray(parsed) ? parsed.slice(-80) : [];
  } catch {
    return [];
  }
}

async function writeChat(ws: ReturnType<typeof getWorkspace>, projectId: string, messages: ChatMessage[]): Promise<void> {
  await ws.s3.writeText(chatPath(projectId), JSON.stringify(messages.slice(-80), null, 2), {
    contentType: "application/json",
  });
}

router.get("/projects/:projectId/chat", async (req: Request, res: Response) => {
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const messages = await readChat(req, projectId);
    return res.json({ messages });
  } catch (err) {
    return fail(res, err);
  }
});

// ─── Agent tool dispatcher ────────────────────────────────────────────────────
type ToolExec = (args: any) => Promise<{ message: string; project?: EditorProject; job?: EditorJob }>;

// V1 dispatcher removed — all agent logic uses buildToolDispatcherV2.

async function enqueueRender(ws: ReturnType<typeof getWorkspace>, project: EditorProject, kind: "preview" | "final"): Promise<EditorJob> {
  const job: EditorJob = {
    jobId: randomUUID(),
    projectId: project.projectId,
    kind,
    status: "pending",
    progress: 1,
    message: "Queued render...",
    outputPath: null,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  jobs.set(job.jobId, job);
  await (async () => {
    const latest = await readProjectFromWorkspace(ws, project.projectId).catch(() => project);
    await writeProjectToWorkspace(ws, {
      ...latest,
      renders: [
        { jobId: job.jobId, kind, status: job.status, progress: job.progress, message: job.message, outputPath: null, createdAt: job.createdAt, completedAt: null },
        ...latest.renders,
      ].slice(0, 20),
    });
    await dispatchRenderJob(ws, project.projectId, job);
  })();
  return job;
}

// V1 tool declarations + system prompt removed — all logic uses V2 below.

// ─── Agent V2: Timeline-based composable tools ────────────────────────────────
const AGENT_TOOL_DECLARATIONS_V2 = [
  { name: "read_project", description: "Read the current project state, timeline, assets, and renders.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "read_timeline", description: "Read the current timeline state.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "read_assets", description: "List all uploaded assets with metadata.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "add_clip", description: "Add a video clip segment to the timeline.", parameters: { type: Type.OBJECT, properties: {
    asset: { type: Type.STRING, description: "Workspace path to the video file" },
    srcIn: { type: Type.NUMBER, description: "Source start time in seconds (default 0)" },
    srcOut: { type: Type.NUMBER, description: "Source end time in seconds (0 = full duration)" },
    tlStart: { type: Type.NUMBER, description: "Position on timeline in seconds. If omitted, appends after last clip." },
    speed: { type: Type.NUMBER, description: "Playback speed 0.25-4.0 (default 1)" },
  }, required: ["asset"] } },
  { name: "remove_clip", description: "Remove a clip from the timeline by ID.", parameters: { type: Type.OBJECT, properties: {
    clipId: { type: Type.STRING, description: "The clip ID to remove" },
  }, required: ["clipId"] } },
  { name: "trim_clip", description: "Adjust a clip's source in/out points.", parameters: { type: Type.OBJECT, properties: {
    clipId: { type: Type.STRING, description: "The clip ID to trim" },
    srcIn: { type: Type.NUMBER, description: "New source start time" },
    srcOut: { type: Type.NUMBER, description: "New source end time" },
  }, required: ["clipId"] } },
  { name: "set_clip_speed", description: "Set playback speed for a clip.", parameters: { type: Type.OBJECT, properties: {
    clipId: { type: Type.STRING, description: "The clip ID" },
    speed: { type: Type.NUMBER, description: "0.25-4.0" },
  }, required: ["clipId", "speed"] } },
  { name: "set_transition", description: "Set transition at a clip boundary.", parameters: { type: Type.OBJECT, properties: {
    clipId: { type: Type.STRING, description: "The clip ID" },
    boundary: { type: Type.STRING, description: "'in' for start of clip or 'out' for end of clip" },
    transitionType: { type: Type.STRING, description: "none | fade | crossfade | blur | dip-to-black | wipe" },
    duration: { type: Type.NUMBER, description: "Transition duration in seconds (0.1-2.0, default 0.4)" },
  }, required: ["clipId", "boundary", "transitionType"] } },
  { name: "add_overlay", description: "Add a timed overlay (logo, text, or image) to the timeline. Position it either with a named anchor (position) OR with exact coordinates x,y (0..1, the overlay's CENTER as a fraction of the frame). Use coordinates to place a logo/text ANYWHERE — e.g. after analyze_video tells you where a safe empty area is.", parameters: { type: Type.OBJECT, properties: {
    overlayType: { type: Type.STRING, description: "logo | text | image" },
    content: { type: Type.STRING, description: "Text string or asset path" },
    tlStart: { type: Type.NUMBER, description: "Start time on timeline (default 0)" },
    tlEnd: { type: Type.NUMBER, description: "End time on timeline (0 = full duration)" },
    position: { type: Type.STRING, description: "Named anchor: top-right | top-left | bottom-right | bottom-left | bottom-center | top-center. Ignored if x/y given." },
    x: { type: Type.NUMBER, description: "Optional exact CENTER x as 0..1 (0=left edge, 1=right edge). Overrides position." },
    y: { type: Type.NUMBER, description: "Optional exact CENTER y as 0..1 (0=top, 1=bottom). Overrides position." },
    style: { type: Type.STRING, description: "JSON string of style options. For logo: {widthPercent, key}. For text: {style: bold-clean|headline}" },
  }, required: ["overlayType", "content"] } },
  { name: "remove_overlay", description: "Remove an overlay by ID.", parameters: { type: Type.OBJECT, properties: {
    overlayId: { type: Type.STRING, description: "The overlay ID to remove" },
  }, required: ["overlayId"] } },
  { name: "add_audio", description: "Add a background audio clip.", parameters: { type: Type.OBJECT, properties: {
    asset: { type: Type.STRING, description: "Workspace path to audio file" },
    tlStart: { type: Type.NUMBER, description: "Start time on timeline (default 0)" },
    tlEnd: { type: Type.NUMBER, description: "End time (0 = full duration)" },
    volumeDb: { type: Type.NUMBER, description: "Volume in dB (-30 to 6, default -10)" },
    fadeIn: { type: Type.NUMBER, description: "Fade in seconds (default 0)" },
    fadeOut: { type: Type.NUMBER, description: "Fade out seconds (default 0)" },
    duckSpeech: { type: Type.BOOLEAN, description: "Auto-duck when speech detected (default true)" },
  }, required: ["asset"] } },
  { name: "set_export", description: "Set output format settings.", parameters: { type: Type.OBJECT, properties: {
    aspectRatio: { type: Type.STRING, description: "original | 9:16 | 16:9 | 1:1" },
    cropMode: { type: Type.STRING, description: "smart | fit-blur | contain" },
    colorPreset: { type: Type.STRING, description: "none | vivid | muted | bw | warm | cool" },
  } } },
  { name: "propose", description: "CRITICAL: Present the current edit plan to the user for approval. Call this AFTER setting up the timeline. The user must approve before rendering.", parameters: { type: Type.OBJECT, properties: {
    summary: { type: Type.STRING, description: "Human-readable summary of the edit" },
    diffItems: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { action: { type: Type.STRING }, target: { type: Type.STRING }, description: { type: Type.STRING } } }, description: "List of changes for the user to review" },
  }, required: ["summary", "diffItems"] } },
  { name: "start_render", description: "Start rendering the approved timeline. Only call after user approves a proposal.", parameters: { type: Type.OBJECT, properties: {
    kind: { type: Type.STRING, description: "preview (fast, low quality) or final (full quality)" },
  } } },
  { name: "get_render_status", description: "Check the status of the current render.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "detect_logo_background", description: "Use vision AI to detect logo background color for keying.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "clear_timeline", description: "Clear ALL clips, overlays, and audio from the pending timeline. Use before rebuilding from scratch to avoid duplicates.", parameters: { type: Type.OBJECT, properties: {} } },
  // YouTube integration
  { name: "fetch_video_info", description: "Fetch metadata (title, duration, channel, views, thumbnail) for a YouTube URL. Use this first to check the video before downloading.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube video URL" },
  }, required: ["url"] } },
  { name: "download_youtube", description: "Download a YouTube video and add it as the project source. Takes 30-120 seconds depending on length.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube video URL" },
    quality: { type: Type.STRING, description: "1080p | 720p | 480p | 360p | audio_only (default: 720p)" },
  }, required: ["url"] } },
  { name: "clip_cut_youtube", description: "Download and cut a specific segment from a YouTube video. Faster than downloading full video.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube video URL" },
    startTime: { type: Type.STRING, description: "Start timestamp like '1:30' or '0:45' or seconds like '90'" },
    endTime: { type: Type.STRING, description: "End timestamp like '2:15' or seconds like '135'" },
    quality: { type: Type.STRING, description: "1080p | 720p | 480p (default: 720p)" },
  }, required: ["url", "startTime", "endTime"] } },
  { name: "probe_video", description: "Get duration, resolution, and audio info for a video asset. Use this to know exact duration before trimming.", parameters: { type: Type.OBJECT, properties: {
    asset: { type: Type.STRING, description: "Workspace path to the video file" },
  }, required: ["asset"] } },
  { name: "split_clip", description: "Split a clip into two at a given time offset (relative to the clip's source). Creates two clips from one.", parameters: { type: Type.OBJECT, properties: {
    clipId: { type: Type.STRING, description: "The clip ID to split" },
    splitAt: { type: Type.NUMBER, description: "Time in source seconds where to split" },
  }, required: ["clipId", "splitAt"] } },
  { name: "reorder_clips", description: "Reorder clips on the timeline by providing clip IDs in the desired order.", parameters: { type: Type.OBJECT, properties: {
    clipIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Clip IDs in desired playback order" },
  }, required: ["clipIds"] } },
  { name: "cancel_render", description: "Cancel the active or queued render.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "generate_subtitles", description: "Generate SRT subtitles from a YouTube video URL. Polls until complete. Returns the SRT content.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube video URL" },
    language: { type: Type.STRING, description: "Source language code, e.g. 'hi'. Default: auto-detect." },
    translateTo: { type: Type.STRING, description: "Target translation language code, e.g. 'en'. Optional." },
  }, required: ["url"] } },
  { name: "find_best_clips", description: "Find the most valuable segments from a YouTube video using AI analysis. Returns clip timestamps and descriptions.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube video URL" },
    durationMode: { type: Type.STRING, description: "Preferred clip length: 'auto', '1m', '3m', '8m'. Default: auto." },
    instructions: { type: Type.STRING, description: "Optional topic focus, e.g. 'focus on spiritual stories'" },
  }, required: ["url"] } },
  { name: "generate_timestamps", description: "Generate YouTube chapter timestamps from a video using AI.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube video URL" },
  }, required: ["url"] } },
  { name: "analyze_video", description: "SEE the actual content of an uploaded/local video by sampling frames (NOT for YouTube — watch those directly or use get_transcript). Fast: extracts a few frames and looks at them. Use to understand what's visually in a clip — scene, subjects, on-screen text/logo burned in, quality, where action happens. Provide a focused question.", parameters: { type: Type.OBJECT, properties: {
    asset: { type: Type.STRING, description: "Workspace path to the video. Omit to use the project source video." },
    clipId: { type: Type.STRING, description: "Optional timeline clip ID — analyzes that clip's source within its trim range." },
    question: { type: Type.STRING, description: "What to look for, e.g. 'is there a watermark? what's in the first 5s?'" },
    startTime: { type: Type.NUMBER, description: "Optional window start in seconds." },
    endTime: { type: Type.NUMBER, description: "Optional window end in seconds." },
    timestamps: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "Optional explicit seconds to grab frames at. Overrides startTime/endTime/frameCount." },
    frameCount: { type: Type.NUMBER, description: "How many frames to sample across the window (1-8, default 3)." },
  } } },
  { name: "get_transcript", description: "Get what is SAID in a video as text. For a YouTube URL this fetches existing captions instantly (optionally a time range). For an uploaded/local video or audio asset it transcribes the media (slower). Use only when the user asks about spoken content / wants subtitles-level understanding.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube URL (uses captions, instant)." },
    asset: { type: Type.STRING, description: "Workspace path to a local video/audio to transcribe. Omit url+asset to use the project source." },
    startTime: { type: Type.NUMBER, description: "Optional range start in seconds (filters the transcript)." },
    endTime: { type: Type.NUMBER, description: "Optional range end in seconds." },
    language: { type: Type.STRING, description: "Source language code, e.g. 'hi'. Default auto." },
    translateTo: { type: Type.STRING, description: "Optional target language code for translation (local transcription only)." },
  } } },
  { name: "watch_youtube_video", description: "WATCH & LISTEN to a YouTube video with Gemini vision+audio — the model actually sees the frames and hears the audio. EXPENSIVE and slow: use ONLY when the user explicitly needs visual/audio understanding that captions can't give (e.g. 'what's shown on screen', 'describe the visuals', 'what happens at 2:00'). For plain 'what is said' / summary, prefer get_transcript. NOT for local uploads — use analyze_video for those.", parameters: { type: Type.OBJECT, properties: {
    url: { type: Type.STRING, description: "YouTube URL. Omit to use the project source video if it's a YouTube link." },
    question: { type: Type.STRING, description: "Specific, detailed question about the video's visuals/audio/content." },
    startTime: { type: Type.NUMBER, description: "Optional window start in seconds (watch only this part)." },
    endTime: { type: Type.NUMBER, description: "Optional window end in seconds." },
  }, required: ["question"] } },
];

const AGENT_SYSTEM_PROMPT_V2 = `You are the AI Video Agent — a professional video editor that works through conversation. Users upload videos, logos, music, and other assets, then describe what they want in natural language. You analyze their request, build an edit plan using timeline operations, and present it for approval before rendering.

YOUR WORKFLOW:
1. ALWAYS call read_timeline first to check the current state. If clips already exist, do NOT add duplicates — work with what's there or call clear_timeline to start fresh.
2. Use timeline tools to build the edit: add_clip, trim_clip, set_transition, add_overlay, add_audio, set_export.
3. ALWAYS call propose() to show the plan BEFORE rendering. Never render without user approval.
4. After user approves, call start_render to execute.
5. If user wants changes, modify the timeline and propose() again.

FILE HANDLING:
- When users upload files, the paths appear in the message as [Uploaded video: filename → workspace_path] or [Uploaded image: filename → workspace_path].
- Use these EXACT workspace paths in add_clip(asset: ...) and add_overlay(content: ...).
- The project's sourceVideo and assets.logo fields are also auto-set from uploads.

WHAT YOU CAN SEE AND HEAR (vision + audio):
- You CAN see uploaded images directly — the logo, overlay images, and intro/outro stills are attached to your context as actual images. Look at them. If asked "what is the logo / can you read it", describe what you actually see (text, colors, shape) — do NOT say you can only see the filename.
- To UNDERSTAND a YouTube video (what it's about, what's said, topics, finding a moment), call get_transcript — it returns the full captions instantly (optionally a startTime/endTime range). This is your DEFAULT way to understand YouTube content. YouTube videos are NOT auto-given to you to watch.
- To actually WATCH & LISTEN to a YouTube video (the visuals, on-screen text, what is shown at a moment, audio cues) call watch_youtube_video. It is expensive and slow — use it ONLY when the transcript genuinely can't answer (e.g. the user asks what's visually on screen). Always prefer get_transcript first.
- For UPLOADED / local videos and timeline clips you do NOT watch the whole video. Use analyze_video to sample frames (fast) and see what's visually in them, and get_transcript to transcribe the speech (only when the user asks about spoken content).
- Be efficient: don't analyze_video / get_transcript / watch_youtube_video unless the task needs it. A simple "add my logo top-right" needs none of them.

YOUTUBE CAPABILITIES:
- If a user pastes a YouTube URL, use fetch_video_info first to get metadata.
- Use download_youtube to download the full video as source material.
- Use clip_cut_youtube to extract just a segment (faster than full download).
- After download completes, the video is stored in workspace and can be used with add_clip.
- For requests like "edit this YouTube video" → fetch_video_info → download_youtube → add_clip → propose.
- For requests like "cut 1:30-2:15 from this video" → clip_cut_youtube → add_clip → propose.

BEHAVIOR RULES:
- Be warm, clear, and conversational. You're a creative collaborator, not a robot.
- Chain multiple tools in ONE turn. Example: read_timeline + clear_timeline + add_clip + add_overlay + set_export + propose.
- Make smart defaults: logo defaults to top-right 8%, text to bottom-center bold-clean, transitions to crossfade 0.4s.
- When the request is vague ("make it nice"), make good creative choices and explain why in the proposal.
- When the request is specific ("cut 2:30-3:15"), follow exactly.
- ALWAYS explain your creative choices in the proposal summary.
- For "shorts"/"reels"/"vertical" → set_export 9:16, smart crop.
- For dates/text overlays, detect date formats in the user's message and use them.
- If a logo is uploaded, call detect_logo_background to pick the right key.
- Overlays can go ANYWHERE: pass exact x,y (0..1, the overlay's center) to add_overlay instead of a named corner. To place a logo/text in a specific empty area, call analyze_video first to see the frame, then add_overlay with those coordinates.
- If the user says "render"/"do it"/"go"/"approved" and there's an approved plan, start_render final.
- Refuse non-video tasks in one short sentence.

CRITICAL DUPLICATE PREVENTION:
- ALWAYS read_timeline before adding clips. If clips already exist from uploads, do NOT add them again.
- If you need to rebuild, call clear_timeline FIRST, then add clips fresh.

TIMELINE RULES:
- Clips are placed on the timeline at tlStart. If tlStart is omitted, append after the last clip.
- srcIn/srcOut define which part of the source video to use. srcOut=0 means use full duration.
- Overlays have tlStart/tlEnd — they appear only during that window. tlEnd=0 means full duration.
- Transitions are per-clip: transitionIn at start, transitionOut at end.
- For joining clips, add them sequentially and set crossfade transitions at boundaries.

ADVANCED TOOLS:
- probe_video: Get exact duration/resolution of a video asset. Always probe before trimming to know boundaries.
- split_clip: Split one clip into two at a specific timestamp. Great for removing a middle section.
- reorder_clips: Rearrange clip order by providing IDs in desired sequence. Automatically recomputes timeline positions.
- cancel_render: Stop an in-progress render.
- generate_subtitles: Generate SRT subtitles from a YouTube URL (with optional translation). Use when user wants subtitles/captions.
- find_best_clips: AI analysis to find the best moments/highlights from a YouTube video.
- generate_timestamps: Generate YouTube chapter timestamps from a video.
- analyze_video: See inside an uploaded/local video by sampling frames (scene, on-screen text, watermark, where action is). Not for YouTube.
- get_transcript: Get spoken content as text — instant captions for YouTube, transcription for local media. Default way to understand a YouTube video.
- watch_youtube_video: Actually watch+listen to a YouTube video with vision+audio. Expensive/slow — only when the transcript isn't enough (visual questions).

MULTI-CLIP EDITING:
- You can add multiple clips from different sources. They render in timeline order with optional crossfades.
- Each clip can have independent speed, color preset, and trim settings.
- For "join these clips" requests: add each clip → set crossfade transitions at boundaries → propose.
- For "remove middle section": probe_video → split_clip at start of bad section → split again at end → remove the middle clip.

IMPORTANT: The propose() tool presents the plan to the user as a visual card. Make the summary clear and the diff items descriptive.`;

function buildToolDispatcherV2(
  req: Request,
  getProject: () => EditorProjectV2,
  setProject: (p: EditorProjectV2) => void,
  pendingTimeline: Timeline,
  sendSse: (event: any) => void,
): Record<string, ToolExec> {
  return {
    read_project: async () => {
      const p = getProject();
      return { message: `Project "${p.title}": source=${p.sourceVideo || "(none)"}, logo=${p.assets.logo || "(none)"}, ${p.renders.length} renders.` };
    },
    read_timeline: async () => {
      const tl = pendingTimeline;
      return { message: `Timeline: ${tl.tracks.video.length} clips, ${tl.tracks.overlays.length} overlays, ${tl.tracks.audio.length} audio. Export: ${tl.export.aspectRatio} ${tl.export.cropMode}.` };
    },
    read_assets: async () => {
      const p = getProject();
      return { message: `Assets: source=${p.sourceVideo || "(none)"}, logo=${p.assets.logo || "(none)"}, intro=${p.assets.intro || "(none)"}, outro=${p.assets.outro || "(none)"}.` };
    },
    add_clip: async (args) => {
      if (typeof args?.asset !== "string" || !args.asset.trim()) throw new Error("asset path required.");
      const ws = getWorkspace(req);
      await resolveOpenEndedClipDurations(ws, pendingTimeline);
      const srcIn = clampNumber(args.srcIn, 0, 86400, 0);
      let srcOut = clampNumber(args.srcOut, 0, 86400, 0);
      if (!(srcOut > srcIn)) {
        const duration = await probeWorkspaceVideoDuration(ws, args.asset).catch(() => 0);
        if (duration > srcIn) srcOut = duration;
      }
      const clip: TimelineClip = {
        id: randomUUID(),
        asset: args.asset.trim(),
        srcIn,
        srcOut,
        tlStart: clampNumber(args.tlStart, 0, 86400, computeTimelineDuration(pendingTimeline)),
        speed: clampNumber(args.speed, 0.25, 4, 1),
      };
      pendingTimeline.tracks.video.push(clip);
      return { message: `Added clip from ${clip.asset} (${clip.srcIn}s-${clip.srcOut || "end"}s) at timeline ${clip.tlStart}s.` };
    },
    remove_clip: async (args) => {
      const idx = pendingTimeline.tracks.video.findIndex(c => c.id === args.clipId);
      if (idx < 0) throw new Error("Clip not found.");
      pendingTimeline.tracks.video.splice(idx, 1);
      return { message: "Clip removed." };
    },
    trim_clip: async (args) => {
      const clip = pendingTimeline.tracks.video.find(c => c.id === args.clipId);
      if (!clip) throw new Error("Clip not found.");
      if (args.srcIn != null) clip.srcIn = clampNumber(args.srcIn, 0, 86400, clip.srcIn);
      if (args.srcOut != null) clip.srcOut = clampNumber(args.srcOut, 0, 86400, clip.srcOut);
      if (clip.srcOut > 0 && clip.srcOut <= clip.srcIn) throw new Error("Clip end must be after start.");
      return { message: `Clip trimmed to ${clip.srcIn}s-${clip.srcOut || "end"}s.` };
    },
    set_clip_speed: async (args) => {
      const clip = pendingTimeline.tracks.video.find(c => c.id === args.clipId);
      if (!clip) throw new Error("Clip not found.");
      clip.speed = clampNumber(args.speed, 0.25, 4, 1);
      return { message: `Clip speed set to ${clip.speed}x.` };
    },
    set_transition: async (args) => {
      const clip = pendingTimeline.tracks.video.find(c => c.id === args.clipId);
      if (!clip) throw new Error("Clip not found.");
      const def: TransitionDef = {
        type: (["none", "fade", "crossfade", "blur", "dip-to-black", "wipe"].includes(args.transitionType) ? args.transitionType : "crossfade") as TransitionType,
        duration: Math.max(0.1, Math.min(2, args.duration ?? 0.4)),
      };
      if (args.boundary === "in") clip.transitionIn = def;
      else clip.transitionOut = def;
      return { message: `${args.boundary === "in" ? "In" : "Out"} transition set to ${def.type} (${def.duration}s).` };
    },
    add_overlay: async (args) => {
      const overlayType = ["logo", "text", "image"].includes(args?.overlayType) ? args.overlayType as TimedOverlay["type"] : null;
      if (!overlayType) throw new Error("overlayType must be logo, text, or image.");
      if (typeof args.content !== "string" || !args.content.trim()) throw new Error("overlay content required.");
      let style: Record<string, any> = {};
      if (typeof args.style === "string") {
        try { style = JSON.parse(args.style); } catch { style = {}; }
      }
      if ((overlayType === "logo" || overlayType === "image") && style.widthPercent != null) {
        style.widthPercent = clampNumber(style.widthPercent, 3, 50, overlayType === "logo" ? 8 : 28);
      }
      if (overlayType === "logo" && !style.widthPercent) style.widthPercent = 8;
      if (overlayType === "logo" && !["none", "auto-white", "auto-black"].includes(style.key)) style.key = "none";
      if (overlayType === "text" && !["bold-clean", "headline"].includes(style.style)) style.style = "bold-clean";
      const overlay: TimedOverlay = {
        id: randomUUID(),
        type: overlayType,
        content: args.content.trim(),
        tlStart: clampNumber(args.tlStart, 0, 86400, 0),
        tlEnd: clampNumber(args.tlEnd, 0, 86400, 0),
        position: args.position || (overlayType === "logo" ? "top-right" : "bottom-center"),
        style,
      };
      // Exact coordinates (center, 0..1) override the named anchor.
      const hasX = args.x != null && Number.isFinite(Number(args.x));
      const hasY = args.y != null && Number.isFinite(Number(args.y));
      if (hasX && hasY) {
        overlay.xPct = clampNumber(args.x, 0, 1, 0.5);
        overlay.yPct = clampNumber(args.y, 0, 1, 0.5);
      }
      if (overlay.tlEnd > 0 && overlay.tlEnd <= overlay.tlStart) throw new Error("Overlay end must be after start.");
      pendingTimeline.tracks.overlays.push(overlay);
      const where = overlay.xPct != null ? `x=${overlay.xPct.toFixed(2)}, y=${overlay.yPct!.toFixed(2)}` : overlay.position;
      return { message: `Added ${overlay.type} overlay "${overlay.content.slice(0, 40)}" at ${where}.` };
    },
    remove_overlay: async (args) => {
      const idx = pendingTimeline.tracks.overlays.findIndex(o => o.id === args.overlayId);
      if (idx < 0) throw new Error("Overlay not found.");
      pendingTimeline.tracks.overlays.splice(idx, 1);
      return { message: "Overlay removed." };
    },
    add_audio: async (args) => {
      if (typeof args?.asset !== "string" || !args.asset.trim()) throw new Error("audio asset path required.");
      const audio: AudioClip = {
        id: randomUUID(),
        asset: args.asset.trim(),
        tlStart: clampNumber(args.tlStart, 0, 86400, 0),
        tlEnd: clampNumber(args.tlEnd, 0, 86400, 0),
        volumeDb: clampNumber(args.volumeDb, -30, 6, -10),
        fadeIn: clampNumber(args.fadeIn, 0, 30, 0),
        fadeOut: clampNumber(args.fadeOut, 0, 30, 0),
        duckSpeech: args.duckSpeech !== false,
      };
      if (audio.tlEnd > 0 && audio.tlEnd <= audio.tlStart) throw new Error("Audio end must be after start.");
      pendingTimeline.tracks.audio.push(audio);
      return { message: `Added audio ${audio.asset} at ${audio.tlStart}s, vol=${audio.volumeDb}dB.` };
    },
    set_export: async (args) => {
      if (args.aspectRatio && ["original", "9:16", "16:9", "1:1"].includes(args.aspectRatio)) {
        pendingTimeline.export.aspectRatio = args.aspectRatio;
      }
      if (args.cropMode && ["smart", "fit-blur", "contain"].includes(args.cropMode)) {
        pendingTimeline.export.cropMode = args.cropMode;
      }
      if (args.colorPreset && ["none", "vivid", "muted", "bw", "warm", "cool"].includes(args.colorPreset)) {
        pendingTimeline.export.colorPreset = args.colorPreset;
      }
      return { message: `Export: ${pendingTimeline.export.aspectRatio}, ${pendingTimeline.export.cropMode}, color=${pendingTimeline.export.colorPreset}.` };
    },
    propose: async (args) => {
      const ws = getWorkspace(req);
      await resolveOpenEndedClipDurations(ws, pendingTimeline);
      const proposal: Proposal = {
        proposalId: randomUUID(),
        status: "pending",
        summary: args.summary || "Edit plan ready for review.",
        diff: Array.isArray(args.diffItems) ? args.diffItems.map((d: any) => ({
          action: d.action || "add",
          target: d.target || "clip",
          description: d.description || "",
        })) : [],
        timeline: JSON.parse(JSON.stringify(pendingTimeline)),
        createdAt: Date.now(),
      };
      // Save proposal to project
      const cur = getProject();
      const proposals = [...((cur as any).proposals || []).filter((p: Proposal) => p.status !== "pending"), proposal];
      const next = await writeProjectToWorkspace(ws, { ...cur, proposals, version: 2 } as any);
      setProject(next as EditorProjectV2);
      // Emit proposal SSE event
      sendSse({
        type: "proposal",
        proposalId: proposal.proposalId,
        summary: proposal.summary,
        diff: proposal.diff,
        timeline: proposal.timeline,
        duration: computeTimelineDuration(proposal.timeline),
      });
      return { message: `Proposal ready: ${proposal.summary}` };
    },
    clear_timeline: async () => {
      pendingTimeline.tracks.video = [];
      pendingTimeline.tracks.overlays = [];
      pendingTimeline.tracks.audio = [];
      return { message: "Timeline cleared. All clips, overlays, and audio removed." };
    },
    start_render: async (args) => {
      const ws = getWorkspace(req);
      let project = getProject();
      if (!project.sourceVideo && pendingTimeline.tracks.video.length === 0) {
        throw new Error("No video clips to render.");
      }
      const kind = args?.kind === "preview" ? "preview" : "final";
      // Idempotency guard: if an active job of the same kind already exists,
      // return it instead of kicking off a parallel ffmpeg run that races on
      // the same workspace output path.
      const existing = project.renders.find(
        (r) => r.kind === kind && (r.status === "pending" || r.status === "running"),
      );
      if (existing) {
        const liveJob = jobs.get(existing.jobId);
        if (liveJob) {
          return {
            message: `${kind} render already in progress (${liveJob.progress}%) — waiting on the existing job.`,
            project,
            job: liveJob,
          };
        }
        const fallback: EditorJob = {
          jobId: existing.jobId,
          projectId: project.projectId,
          kind: existing.kind,
          status: existing.status,
          progress: existing.progress,
          message: existing.message,
          outputPath: existing.outputPath,
          error: null,
          createdAt: existing.createdAt,
          completedAt: existing.completedAt,
        };
        if (VIDEO_EDITOR_QUEUE_ENABLED) {
          const ddbStatus = await getJobStatusFromDdb(existing.jobId).catch(() => null);
          if (ddbStatus) {
            const job = mapDdbRenderJob(existing.jobId, ddbStatus, fallback);
            return {
              message: `${kind} render already in progress (${job.progress}%) — waiting on the existing job.`,
              project,
              job,
            };
          }
        }
        if (Date.now() - existing.createdAt >= STALE_PENDING_RENDER_MS) {
          project = {
            ...project,
            renders: project.renders.map((entry) => entry.jobId === existing.jobId ? {
              ...entry,
              status: "error" as const,
              progress: 0,
              message: "Previous render worker stopped before reporting progress. Starting a fresh render.",
              completedAt: Date.now(),
            } : entry),
          };
          setProject(project);
        } else {
          return {
            message: `${kind} render already in progress (${existing.progress}%) — waiting on the existing job.`,
            project,
            job: fallback,
          };
        }
      }
      await resolveOpenEndedClipDurations(ws, pendingTimeline);
      // Save timeline to project so processRenderJob can use it directly
      project.timeline = JSON.parse(JSON.stringify(pendingTimeline));
      project.version = 2;
      project = await writeProjectToWorkspace(ws, project) as EditorProjectV2;
      setProject(project);
      const job = await enqueueRender(ws, project, kind);
      const next = await readProjectFromWorkspace(ws, project.projectId);
      setProject(next as EditorProjectV2);
      return { message: `${kind} render started.`, project: next, job };
    },
    get_render_status: async () => {
      const project = getProject();
      const latest = project.renders[0];
      if (!latest) return { message: "No renders yet." };
      const live = jobs.get(latest.jobId);
      if (live) return { message: `${latest.kind}: ${live.status} · ${live.progress}% — ${live.message}` };
      if (VIDEO_EDITOR_QUEUE_ENABLED) {
        const ddbStatus = await getJobStatusFromDdb(latest.jobId).catch(() => null);
        if (ddbStatus) {
          const job = mapDdbRenderJob(latest.jobId, ddbStatus, {
            projectId: project.projectId,
            kind: latest.kind,
            message: latest.message,
            outputPath: latest.outputPath,
            createdAt: latest.createdAt,
            completedAt: latest.completedAt,
          });
          return { message: `${latest.kind}: ${job.status} · ${job.progress}% — ${job.message}` };
        }
      }
      if ((latest.status === "pending" || latest.status === "running") && Date.now() - latest.createdAt >= STALE_PENDING_RENDER_MS) {
        return { message: `${latest.kind}: error · 0% — Previous render worker stopped before reporting progress. Please start a fresh render.` };
      }
      return { message: `${latest.kind}: ${latest.status} · ${latest.progress}% — ${latest.message}` };
    },
    detect_logo_background: async () => {
      const cur = getProject();
      if (!cur.assets.logo) throw new Error("No logo uploaded yet.");
      if (!isGeminiConfigured()) return { message: "Vision model not configured." };
      const ws = getWorkspace(req);
      const tmp = join(tmpdir(), `editor-logo-${randomUUID()}`);
      await mkdir(tmp, { recursive: true });
      try {
        const ext = (extname(cur.assets.logo) || ".png").toLowerCase();
        const localPath = join(tmp, `logo${ext}`);
        await downloadWorkspaceFile(ws, cur.assets.logo, localPath);
        const bytes = await readFile(localPath);
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
        const activeModel = (process.env.EDITOR_AGENT_MODEL || "gemini-3.5-flash").trim();
        const resp: any = await generateContentWithRotation({
          model: activeModel,
          fallbackModels: ["gemini-2.5-flash", "gemini-3.5-flash"],
          contents: [{ role: "user", parts: [
            { text: 'Look at this logo. Reply with ONLY one word: "transparent", "white", "black", or "none". No punctuation.' },
            { inlineData: { mimeType: mime, data: bytes.toString("base64") } },
          ]}],
          config: { maxOutputTokens: 16, thinkingConfig: buildThinkingConfig(activeModel, "LOW") },
        }, { caller: "video-editor" });
        const text: string = String(resp?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === "string")?.text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
        const decision = text === "white" ? "auto-white" : text === "black" ? "auto-black" : "none";
        for (const ov of pendingTimeline.tracks.overlays) {
          if (ov.type === "logo") ov.style.key = decision;
        }
        return { message: `Logo background: ${text || "unclear"} → key=${decision}.` };
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    },

    // ── YouTube integration tools ─────────────────────────────────────────
    fetch_video_info: async (args) => {
      if (!args?.url) throw new Error("URL required.");
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST", headers, body: JSON.stringify({ url: args.url }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Info fetch failed: ${r.status}`); }
      const data = await r.json() as any;
      sendSse({ type: "tool_progress", name: "fetch_video_info", message: `Fetched: ${data.title || "video"}` });
      return {
        message: `Title: ${data.title || "Unknown"}\nDuration: ${data.duration || "?"}\nChannel: ${data.uploader || "?"}\nViews: ${data.view_count != null ? Number(data.view_count).toLocaleString() : "?"}`,
        data,
      };
    },

    download_youtube: async (args) => {
      if (!args?.url) throw new Error("URL required.");
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      const quality = args.quality || "720p";
      const formatSelectors: Record<string, string> = {
        "1080p": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]",
        "720p": "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
        "480p": "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]",
        "360p": "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]",
        "audio_only": "audio:bestaudio",
      };
      sendSse({ type: "tool_progress", name: "download_youtube", message: `Starting download (${quality})...` });
      const r = await fetch(`${apiBase}/youtube/download`, {
        method: "POST", headers,
        body: JSON.stringify({ url: args.url, formatId: formatSelectors[quality] || formatSelectors["720p"] }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Download failed: ${r.status}`); }
      const { jobId } = await r.json() as any;
      // Poll until done
      const result = await pollVideoEditorJob(apiBase, jobId, headers, sendSse, "download_youtube");
      // Store in workspace and set as source
      const downloadUrl = `${apiBase}/youtube/file/${jobId}`;
      const ws = getWorkspace(req);
      const filename = result.filename || "youtube-download.mp4";
      const wsPath = `editor/uploads/${getProject().projectId}/source/${filename}`;
      // Download from internal API to temp, then upload to workspace
      const tmp = join(tmpdir(), `yt-dl-${randomUUID()}`);
      await mkdir(tmp, { recursive: true });
      try {
        const localFile = join(tmp, filename);
        const dlResp = await fetch(downloadUrl, { headers });
        if (!dlResp.ok) throw new Error("Failed to fetch downloaded file");
        // Stream to disk — full-length 1080p YouTube downloads can easily
        // exceed a gigabyte and OOM the API server when buffered.
        await streamResponseToFile(dlResp, localFile);
        await uploadWorkspaceFile(ws, localFile, wsPath);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
      // Set as source video
      const cur = getProject();
      cur.sourceVideo = wsPath;
      const next = await writeProjectToWorkspace(ws, cur);
      setProject(next as EditorProjectV2);
      return { message: `Downloaded "${result.filename || "video"}" → ${wsPath}. Set as source video.` };
    },

    clip_cut_youtube: async (args) => {
      if (!args?.url || !args?.startTime || !args?.endTime) throw new Error("URL, startTime, endTime required.");
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      const startSecs = parseEditorTimestamp(String(args.startTime));
      const endSecs = parseEditorTimestamp(String(args.endTime));
      const quality = args.quality || "720p";
      sendSse({ type: "tool_progress", name: "clip_cut_youtube", message: `Cutting ${args.startTime} → ${args.endTime}...` });
      const r = await fetch(`${apiBase}/youtube/clip-cut`, {
        method: "POST", headers,
        body: JSON.stringify({ url: args.url, startTime: startSecs, endTime: endSecs, quality }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Clip cut failed: ${r.status}`); }
      const { jobId } = await r.json() as any;
      // Poll until done
      const result = await pollVideoEditorJob(apiBase, jobId, headers, sendSse, "clip_cut_youtube");
      // Store in workspace
      const downloadUrl = `${apiBase}/youtube/file/${jobId}`;
      const ws = getWorkspace(req);
      const filename = result.filename || `clip-${startSecs}-${endSecs}.mp4`;
      const wsPath = `editor/uploads/${getProject().projectId}/source/${filename}`;
      const tmp = join(tmpdir(), `yt-clip-${randomUUID()}`);
      await mkdir(tmp, { recursive: true });
      try {
        const localFile = join(tmp, filename);
        const dlResp = await fetch(downloadUrl, { headers });
        if (!dlResp.ok) throw new Error("Failed to fetch clip file");
        await streamResponseToFile(dlResp, localFile);
        await uploadWorkspaceFile(ws, localFile, wsPath);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
      // Set as source video
      const cur = getProject();
      cur.sourceVideo = wsPath;
      const next = await writeProjectToWorkspace(ws, cur);
      setProject(next as EditorProjectV2);
      return { message: `Clip cut (${args.startTime}→${args.endTime}) → ${wsPath}. Set as source video.` };
    },

    probe_video: async (args) => {
      if (!args?.asset) throw new Error("asset path required.");
      const ws = getWorkspace(req);
      const tmp = join(tmpdir(), `editor-probe-${randomUUID()}`);
      await mkdir(tmp, { recursive: true });
      try {
        const localPath = join(tmp, `probe${extname(args.asset) || ".mp4"}`);
        await downloadWorkspaceFile(ws, args.asset, localPath);
        const meta = await probeMetadata(localPath);
        return { message: `Duration: ${meta.duration.toFixed(2)}s | Resolution: ${meta.width}×${meta.height} | Audio: ${meta.hasAudio ? "yes" : "no"}` };
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    },

    split_clip: async (args) => {
      const idx = pendingTimeline.tracks.video.findIndex(c => c.id === args.clipId);
      if (idx < 0) throw new Error("Clip not found.");
      const clip = pendingTimeline.tracks.video[idx];
      const splitAt = clampNumber(args.splitAt, 0, 86400, -1);
      if (splitAt <= clip.srcIn || (clip.srcOut > 0 && splitAt >= clip.srcOut)) {
        throw new Error(`splitAt ${splitAt}s is outside clip range ${clip.srcIn}s-${clip.srcOut || "end"}s.`);
      }
      const speed = clip.speed || 1;
      const aDuration = (splitAt - clip.srcIn) / speed;
      const clipA: TimelineClip = { ...clip, id: randomUUID(), srcOut: splitAt, transitionOut: undefined };
      const clipB: TimelineClip = {
        ...clip,
        id: randomUUID(),
        srcIn: splitAt,
        tlStart: clip.tlStart + aDuration,
        transitionIn: undefined,
      };
      pendingTimeline.tracks.video.splice(idx, 1, clipA, clipB);
      // The original clip occupied [tlStart, tlStart + origDuration). Splitting
      // keeps the same total duration so subsequent clips stay where they
      // were — no shift needed. (Previously this comment was missing and the
      // split could orphan transition definitions on the boundary.)
      return { message: `Split into two clips: A (${clipA.srcIn}s-${clipA.srcOut}s) and B (${clipB.srcIn}s-${clipB.srcOut || "end"}s).` };
    },

    reorder_clips: async (args) => {
      if (!Array.isArray(args?.clipIds) || args.clipIds.length === 0) throw new Error("clipIds array required.");
      // Resolve open-ended (srcOut=0) clips to their actual duration first,
      // otherwise the cursor recalculation below uses a 30s placeholder and
      // produces wildly wrong tlStart values for full-length clips.
      const ws = getWorkspace(req);
      await resolveOpenEndedClipDurations(ws, pendingTimeline);
      const reordered: TimelineClip[] = [];
      const requestedIds = Array.from(new Set(args.clipIds.map((id: unknown) => String(id))));
      for (const id of requestedIds) {
        const clip = pendingTimeline.tracks.video.find(c => c.id === id);
        if (!clip) throw new Error(`Clip ${id} not found.`);
        reordered.push(clip);
      }
      // Keep any clips not mentioned at the end
      for (const clip of pendingTimeline.tracks.video) {
        if (!requestedIds.includes(clip.id)) reordered.push(clip);
      }
      // Recompute tlStart sequentially
      let cursor = 0;
      for (const clip of reordered) {
        clip.tlStart = cursor;
        const dur = ((clip.srcOut || 0) > clip.srcIn ? clip.srcOut - clip.srcIn : 30) / (clip.speed || 1);
        cursor += dur;
      }
      pendingTimeline.tracks.video = reordered;
      return { message: `Reordered ${reordered.length} clips.` };
    },

    cancel_render: async () => {
      const project = getProject();
      const latest = project.renders[0];
      if (!latest) throw new Error("No active render to cancel.");
      const live = jobs.get(latest.jobId);
      if (live && (live.status === "pending" || live.status === "running")) {
        cancelRenderJob(live);
        await persistJobToProject(getWorkspace(req), live.projectId, live).catch((err) => {
          logger.warn({ err, jobId: live.jobId }, "[video-editor] failed to persist agent render cancellation");
        });
      }
      return { message: `Cancelled ${latest.kind} render.` };
    },

    generate_subtitles: async (args) => {
      if (!args?.url) throw new Error("URL required.");
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      sendSse({ type: "tool_progress", name: "generate_subtitles", message: "Starting subtitle generation..." });
      const r = await fetch(`${apiBase}/subtitles/generate`, {
        method: "POST", headers,
        body: JSON.stringify({ url: args.url, language: args.language ?? "auto", translateTo: args.translateTo ?? null, source: "url" }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Subtitle job failed: ${r.status}`); }
      const { id: jobId } = await r.json() as any;
      // Poll subtitle status
      const maxWait = 10 * 60 * 1000;
      const start = Date.now();
      let lastMsg = "";
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 4000));
        const sr = await fetch(`${apiBase}/subtitles/status/${jobId}`, { headers }).catch(() => null);
        if (!sr || !sr.ok) continue;
        const sd = await sr.json() as any;
        const msg = sd.message || sd.stage || "";
        if (msg && msg !== lastMsg) { sendSse({ type: "tool_progress", name: "generate_subtitles", message: msg, percent: sd.progress }); lastMsg = msg; }
        if (sd.status === "done" || sd.status === "completed") {
          return { message: `Subtitles generated: ${sd.srtFilename || "subtitles.srt"}. View in Subtitles tab.` };
        }
        if (sd.status === "error" || sd.status === "failed") throw new Error(sd.error || "Subtitle generation failed.");
      }
      throw new Error("Subtitle generation timed out.");
    },

    find_best_clips: async (args) => {
      if (!args?.url) throw new Error("URL required.");
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      sendSse({ type: "tool_progress", name: "find_best_clips", message: "Starting best clips analysis..." });
      const r = await fetch(`${apiBase}/youtube/clips`, {
        method: "POST", headers,
        body: JSON.stringify({ url: args.url, durationMode: args.durationMode ?? "auto", instructions: args.instructions ?? "" }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Best clips failed: ${r.status}`); }
      const { jobId } = await r.json() as any;
      const result = await pollVideoEditorJob(apiBase, jobId, headers, sendSse, "find_best_clips");
      return { message: `Best clips analysis complete. Found highlights from the video. View in Best Clips tab.` };
    },

    generate_timestamps: async (args) => {
      if (!args?.url) throw new Error("URL required.");
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      sendSse({ type: "tool_progress", name: "generate_timestamps", message: "Generating timestamps..." });
      const r = await fetch(`${apiBase}/youtube/timestamps`, {
        method: "POST", headers,
        body: JSON.stringify({ url: args.url }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Timestamps failed: ${r.status}`); }
      const { jobId } = await r.json() as any;
      // Poll timestamps status
      const maxWait = 10 * 60 * 1000;
      const start = Date.now();
      let lastMsg = "";
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 4000));
        const sr = await fetch(`${apiBase}/youtube/timestamps/status/${jobId}`, { headers }).catch(() => null);
        if (!sr || !sr.ok) continue;
        const sd = await sr.json() as any;
        const msg = sd.message || sd.stage || "";
        if (msg && msg !== lastMsg) { sendSse({ type: "tool_progress", name: "generate_timestamps", message: msg }); lastMsg = msg; }
        if (sd.status === "done" || sd.status === "completed") {
          let tsText = "";
          if (sd.timestamps) {
            if (typeof sd.timestamps === "string") tsText = sd.timestamps;
            else if (Array.isArray(sd.timestamps)) tsText = sd.timestamps.map((t: any) => `${t.time ?? t.timestamp ?? ""} ${t.title ?? t.label ?? ""}`).join("\n");
          }
          return { message: tsText || "Timestamps generated. View in Timestamps tab." };
        }
        if (sd.status === "error" || sd.status === "failed") throw new Error(sd.error || "Timestamp generation failed.");
      }
      throw new Error("Timestamp generation timed out.");
    },

    analyze_video: async (args) => {
      const ws = getWorkspace(req);
      let asset: string | null = typeof args?.asset === "string" && args.asset.trim() ? args.asset.trim() : null;
      let winStart = 0;
      let winEnd = 0;
      if (args?.clipId) {
        const clip = pendingTimeline.tracks.video.find(c => c.id === args.clipId);
        if (!clip) throw new Error("Clip not found.");
        asset = clip.asset;
        winStart = clip.srcIn || 0;
        winEnd = clip.srcOut > clip.srcIn ? clip.srcOut : 0;
      }
      if (!asset) asset = getProject().sourceVideo;
      if (!asset) throw new Error("No video to analyze — pass asset/clipId or set a source video.");
      if (isYouTubeUrl(asset)) throw new Error("That's a YouTube URL — I can watch it directly or use get_transcript. analyze_video is for uploaded/clip assets.");
      if (!isGeminiConfigured()) return { message: "Vision model not configured." };
      sendSse({ type: "tool_progress", name: "analyze_video", message: "Extracting frames..." });
      const dir = join(tmpdir(), `editor-analyze-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      try {
        const local = join(dir, `src${extname(asset) || ".mp4"}`);
        await downloadWorkspaceFile(ws, asset, local);
        const meta = await probeMetadata(local);
        const dur = meta.duration || 0;
        let lo = winStart > 0 ? winStart : 0;
        let hi = winEnd > lo ? winEnd : (dur || 0);
        if (args?.startTime != null && Number.isFinite(Number(args.startTime))) lo = Math.max(0, Number(args.startTime));
        if (args?.endTime != null && Number(args.endTime) > lo) hi = Number(args.endTime);
        if (!(hi > lo)) hi = dur > lo ? dur : lo + 1;
        let points: number[] = [];
        if (Array.isArray(args?.timestamps) && args.timestamps.length) {
          points = args.timestamps
            .map((t: any) => Number(t))
            .filter((t: number) => Number.isFinite(t))
            .map((t: number) => Math.max(lo, Math.min(hi, t)));
        }
        if (!points.length) {
          const n = Math.max(1, Math.min(8, Math.round(Number(args?.frameCount) || 3)));
          if (n === 1) points = [lo + (hi - lo) / 2];
          else for (let i = 0; i < n; i++) points.push(lo + (hi - lo) * (i / (n - 1)));
        }
        // Input-seek (`-ss` before `-i`) + single frame = very fast; run in parallel.
        const frames = await Promise.all(points.map(async (t, i) => {
          const out = join(dir, `f${i}.jpg`);
          await runFfmpegRaw(["-y", "-ss", String(Math.max(0, t)), "-i", local, "-frames:v", "1", "-q:v", "5", "-vf", "scale='min(1024,iw)':-2", out]).catch(() => {});
          try { const b = await readFile(out); return b.length ? { t, data: b.toString("base64") } : null; } catch { return null; }
        }));
        const got = frames.filter((f): f is { t: number; data: string } => Boolean(f));
        if (!got.length) throw new Error("Could not extract frames from the video.");
        const question = typeof args?.question === "string" && args.question.trim()
          ? args.question.trim()
          : "Describe what's happening: scene, subjects, any on-screen text or logos, and visual quality.";
        const activeModel = (process.env.EDITOR_AGENT_MODEL || "gemini-3.5-flash").trim();
        const parts: any[] = [{
          text: `${got.length} frame(s) sampled from a video at ${got.map(g => g.t.toFixed(1) + "s").join(", ")} (window ${lo.toFixed(1)}s–${hi.toFixed(1)}s). ${question}\nAnswer concisely for a video editor. Do not identify real people.`,
        }];
        for (const g of got) parts.push({ inlineData: { mimeType: "image/jpeg", data: g.data } });
        const resp: any = await generateContentWithRotation({
          model: activeModel,
          fallbackModels: ["gemini-2.5-flash", "gemini-3.5-flash"],
          contents: [{ role: "user", parts }],
          config: { maxOutputTokens: 1024, thinkingConfig: buildThinkingConfig(activeModel, "LOW") },
        }, { caller: "video-editor" });
        const text = String(resp?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "").trim();
        return { message: `Looked at frames @ ${got.map(g => g.t.toFixed(1) + "s").join(", ")}:\n${text || "(no description returned)"}` };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    get_transcript: async (args) => {
      const apiBase = getVideoEditorApiBase(req);
      const headers = buildVideoEditorInternalHeaders(req);
      const project = getProject();
      let url: string | null = typeof args?.url === "string" && args.url.trim() ? args.url.trim() : null;
      let asset: string | null = typeof args?.asset === "string" && args.asset.trim() ? args.asset.trim() : null;
      if (!url && !asset && project.sourceVideo) {
        if (isYouTubeUrl(project.sourceVideo)) url = project.sourceVideo;
        else asset = project.sourceVideo;
      }
      const startSecs = args?.startTime != null ? parseEditorTimestamp(String(args.startTime)) : null;
      const endSecs = args?.endTime != null ? parseEditorTimestamp(String(args.endTime)) : null;
      const sliceRange = (srt: string): string =>
        (startSecs != null || endSecs != null) ? filterSrtByRange(srt, startSecs ?? 0, endSecs ?? Number.MAX_SAFE_INTEGER) : srt;

      if (url && isYouTubeUrl(url)) {
        sendSse({ type: "tool_progress", name: "get_transcript", message: "Fetching YouTube captions..." });
        const lang = args?.language ?? "en";
        const r = await fetch(`${apiBase}/youtube/subtitles?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}&format=srt`, { headers });
        const text = await r.text();
        if (!r.ok) { let m = text; try { m = (JSON.parse(text) as any).error || m; } catch {} throw new Error(m || `Captions failed: ${r.status}`); }
        const srt = sliceRange(text).slice(0, 24000);
        return { message: `Transcript (YouTube captions${startSecs != null ? `, ${startSecs}s–${endSecs ?? "end"}s` : ""}):\n${srt || "(no captions in range)"}` };
      }

      if (!asset) throw new Error("Provide a YouTube url or a local video/audio asset to transcribe.");
      if (isYouTubeUrl(asset)) throw new Error("Pass a YouTube link via 'url', not 'asset'.");
      // Production path: extract a compact mono 16kHz MP3 first instead of
      // shipping the whole video to AssemblyAI. A 10-min talk → ~1MB upload
      // (vs hundreds of MB), so transcription starts far faster and cheaper.
      sendSse({ type: "tool_progress", name: "get_transcript", message: "Extracting audio..." });
      const ws = getWorkspace(req);
      const dir = join(tmpdir(), `editor-tx-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      let transcribeUrl: string;
      try {
        const srcLocal = join(dir, `src${extname(asset) || ".mp4"}`);
        await downloadWorkspaceFile(ws, asset, srcLocal);
        let uploadPath: string;
        let uploadBytes: Buffer;
        let uploadMime: string;
        try {
          const audioLocal = join(dir, "audio.mp3");
          await runFfmpegRaw(["-y", "-i", srcLocal, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioLocal]);
          uploadBytes = await readFile(audioLocal);
          if (!uploadBytes.length) throw new Error("empty audio");
          uploadPath = `editor/uploads/${getProject().projectId}/transcribe/${randomUUID()}.mp3`;
          uploadMime = "audio/mpeg";
        } catch {
          // No audio track / exotic container — fall back to the original file.
          uploadBytes = await readFile(srcLocal);
          uploadPath = `editor/uploads/${getProject().projectId}/transcribe/${randomUUID()}${extname(asset) || ".mp4"}`;
          uploadMime = imageMimeForExt(asset) ?? "video/mp4";
        }
        const presignPut = await ws.s3.presignPut(uploadPath, { size: uploadBytes.length, contentType: uploadMime });
        const putRes = await fetch(presignPut.uploadUrl, { method: "PUT", headers: { "Content-Type": uploadMime }, body: uploadBytes });
        if (!putRes.ok) throw new Error(`audio upload failed: ${putRes.status}`);
        transcribeUrl = (await ws.s3.presignGet(uploadPath, { disposition: "inline" })).url;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      sendSse({ type: "tool_progress", name: "get_transcript", message: "Transcribing..." });
      const r = await fetch(`${apiBase}/subtitles/generate-from-url`, {
        method: "POST", headers,
        body: JSON.stringify({ fileUrl: transcribeUrl, language: args?.language ?? "auto", translateTo: args?.translateTo ?? null }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})) as any; throw new Error(e.error ?? `Transcription failed: ${r.status}`); }
      const { id: jobId } = await r.json() as any;
      const maxWait = 10 * 60 * 1000;
      const start = Date.now();
      let lastMsg = "";
      while (Date.now() - start < maxWait) {
        await new Promise(res => setTimeout(res, 4000));
        const sr = await fetch(`${apiBase}/subtitles/status/${jobId}`, { headers }).catch(() => null);
        if (!sr || !sr.ok) continue;
        const sd = await sr.json() as any;
        const msg = sd.message || sd.stage || "";
        if (msg && msg !== lastMsg) { sendSse({ type: "tool_progress", name: "get_transcript", message: msg, percent: sd.progressPct }); lastMsg = msg; }
        if (sd.status === "done" || sd.status === "completed") {
          const srt = String(sd.srt || sd.originalSrt || "");
          if (!srt) return { message: "Transcription finished but returned no text." };
          return { message: `Transcript${startSecs != null ? ` (${startSecs}s–${endSecs ?? "end"}s)` : ""}:\n${sliceRange(srt).slice(0, 24000)}` };
        }
        if (sd.status === "error" || sd.status === "failed") throw new Error(sd.error || "Transcription failed.");
      }
      throw new Error("Transcription timed out.");
    },

    watch_youtube_video: async (args) => {
      let url: string | null = typeof args?.url === "string" && args.url.trim() ? args.url.trim() : null;
      const src = getProject().sourceVideo;
      if (!url && src && isYouTubeUrl(src)) url = src;
      if (!url) throw new Error("Provide a YouTube url (or set a YouTube source video). For uploaded/local videos use analyze_video instead.");
      if (!isYouTubeUrl(url)) throw new Error("watch_youtube_video is YouTube-only. For uploaded/local videos use analyze_video.");
      if (!isGeminiConfigured()) return { message: "Vision model not configured." };
      let fileUri: string;
      try { fileUri = normalizeInputUrl(url); } catch { fileUri = url; }
      const question = typeof args?.question === "string" && args.question.trim()
        ? args.question.trim()
        : "Describe what happens in this video — visuals, audio, on-screen text, and key moments with timestamps.";
      const startSecs = args?.startTime != null && Number.isFinite(Number(args.startTime)) ? Math.max(0, Number(args.startTime)) : null;
      const endSecs = args?.endTime != null && Number(args.endTime) > (startSecs ?? 0) ? Number(args.endTime) : null;
      sendSse({ type: "tool_progress", name: "watch_youtube_video", message: "Watching the video (vision + audio)..." });
      const videoPart: any = { fileData: { fileUri, mimeType: "video/mp4" } };
      if (startSecs != null || endSecs != null) {
        videoPart.videoMetadata = {};
        if (startSecs != null) videoPart.videoMetadata.startOffset = `${Math.round(startSecs)}s`;
        if (endSecs != null) videoPart.videoMetadata.endOffset = `${Math.round(endSecs)}s`;
      }
      const resp: any = await generateContentWithRotation({
        model: EDITOR_WATCH_MODEL,
        fallbackModels: ["gemini-2.5-flash", "gemini-3.5-flash"],
        contents: [{ role: "user", parts: [
          { text: `${question}\nAnswer concisely for a video editor. Include timestamps where useful. Do not identify real people.` },
          videoPart,
        ] }],
        config: {
          maxOutputTokens: 8192,
          thinkingConfig: buildThinkingConfig(EDITOR_WATCH_MODEL, "MEDIUM"),
        },
      }, { caller: "video-editor" });
      const text = String(resp?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "").trim();
      if (!text) throw new Error("The model returned no analysis — the video may be private, age-restricted, or unavailable.");
      return { message: `Watched the video${startSecs != null ? ` (${startSecs}s–${endSecs ?? "end"}s)` : ""}:\n${text}` };
    },
  };
}

// ── Helper: get API base for internal calls ────────────────────────────────
function getVideoEditorApiBase(req: Request): string {
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE + "/api";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080";
  return `${proto}://${host}/api`;
}

function buildVideoEditorInternalHeaders(req: Request): Record<string, string> {
  const secret = INTERNAL_AGENT_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: (req.headers.cookie as string) ?? "",
    "x-internal-agent": secret,
  };
  if (req.headers["x-forwarded-for"]) headers["x-forwarded-for"] = String(req.headers["x-forwarded-for"]);
  return headers;
}

function parseEditorTimestamp(ts: string): number {
  ts = ts.trim();
  // Already a number
  if (/^\d+(\.\d+)?$/.test(ts)) return parseFloat(ts);
  // MM:SS or H:MM:SS
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  return parseFloat(ts) || 0;
}

async function pollVideoEditorJob(
  apiBase: string, jobId: string, headers: Record<string, string>,
  sendSse: (event: any) => void, toolName: string,
): Promise<{ status: string; filename?: string }> {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min timeout
  while (Date.now() < deadline) {
    const r = await fetch(`${apiBase}/youtube/progress/${jobId}`, {
      headers: { ...headers, "Cache-Control": "no-cache" },
    });
    if (!r.ok) throw new Error(`Progress check failed: ${r.status}`);
    const data = await r.json() as any;
    sendSse({ type: "tool_progress", name: toolName, message: data.message || data.status, percent: data.percent });
    if (data.status === "done") return { status: "done", filename: data.filename };
    if (["error", "cancelled", "expired", "not_found"].includes(data.status))
      throw new Error(`Job ${data.status}: ${data.message ?? ""}`);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Download timed out after 10 minutes");
}

function sse(res: Response, event: any) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  sseFlush(res);
}

function snapshotRecipeSummary(project: EditorProject): string {
  const r = project.recipe;
  const ov = r.overlays.map((o) => o.type === "logo" ? `logo@${o.position}` : `text:"${o.text}"@${o.position}`).join(", ") || "no overlays";
  return `aspect=${r.aspectRatio}, crop=${r.cropMode}, trim=${r.trim.start}->${r.trim.end ?? "end"}, intro=${r.intro.enabled}, outro=${r.outro.enabled}, transitions=${r.transitions?.fade === false ? "cut" : "fade"}, overlays=[${ov}]`;
}

router.post("/projects/:projectId/chat", async (req: Request, res: Response): Promise<void> => {
  // Use a non-throwing scope so we can persist defensively in error paths
  // without losing the user message or any tool progress on a Gemini failure
  // or mid-stream client disconnect.
  let projectIdSafe: string | null = null;
  let wsSafe: ReturnType<typeof getWorkspace> | null = null;
  // Coalesce concurrent persistChat() calls so we don't issue two S3 writes
  // in parallel for the same chat — the second one would clobber the first.
  let writingChat: Promise<void> | null = null;
  let pendingChatRewrite = false;
  // History is captured outside the try so the catch handler can still
  // persist whatever we accumulated before the failure.
  let history: ChatMessage[] = [];
  let assistantMessageRef: ChatMessage | null = null;
  let finalTextSoFar = "";
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const persistChat = async (): Promise<void> => {
    if (!wsSafe || !projectIdSafe) return;
    if (writingChat) {
      // A write is already in flight; queue exactly one rewrite and let the
      // current write coalesce updates that came in while it was executing.
      pendingChatRewrite = true;
      return;
    }
    const ws = wsSafe;
    const pid = projectIdSafe;
    writingChat = (async () => {
      try {
        await writeChat(ws, pid, history);
      } catch (err) {
        logger.warn({ err, pid }, "[video-editor] chat persist failed");
      }
    })().finally(async () => {
      writingChat = null;
      if (pendingChatRewrite) {
        pendingChatRewrite = false;
        await persistChat();
      }
    });
  };

  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    projectIdSafe = projectId;
    const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
    // Clamp absurdly long messages — protects against accidental paste of a
    // multi-MB blob and keeps Gemini context cost predictable.
    const userText = rawMessage.trim().slice(0, 16000);
    if (!userText) { bad(res, 400, "message required"); return; }

    const ws = getWorkspace(req);
    wsSafe = ws;
    let project = await readProjectFromWorkspace(ws, projectId);

    // ── Auto-link uploaded files from chat message markers ──
    const videoMatch = userText.match(/\[Uploaded video:.*?→\s*([^\]]+)\]/);
    const imageMatch = userText.match(/\[Uploaded image:.*?→\s*([^\]]+)\]/);
    if (videoMatch && !project.sourceVideo) {
      project.sourceVideo = videoMatch[1].trim();
      project = await writeProjectToWorkspace(ws, project);
    }
    if (imageMatch && !project.assets.logo) {
      project.assets.logo = imageMatch[1].trim();
      project = await writeProjectToWorkspace(ws, project);
    }

    setupSse(res);
    // Guard the SSE writer so a client disconnect mid-stream doesn't throw
    // ERR_STREAM_WRITE_AFTER_END for every subsequent send (heartbeat, tool
    // events, etc.). The flag is also flipped from `res.on("close")` below.
    const send = (event: any) => {
      if (closed) return;
      try { sse(res, event); }
      catch (writeErr) {
        closed = true;
        logger.debug({ err: writeErr }, "[video-editor] sse write after close, suppressing further frames");
      }
    };
    heartbeat = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 8000);
    res.on("close", () => {
      closed = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    });

    send({ type: "run_start", runId: randomUUID() });
    send({ type: "project", project });

    history = await readChat(req, projectId);
    const userMessage: ChatMessage = { id: randomUUID(), role: "user", content: userText, createdAt: Date.now() };
    history.push(userMessage);
    send({ type: "user_message", message: userMessage });
    // CRITICAL: persist the user message immediately so a Gemini failure or
    // the client refreshing mid-stream still leaves the question visible in
    // the chat log on reload.
    await persistChat();

    const assistantMessage: ChatMessage = { id: randomUUID(), role: "assistant", content: "", createdAt: Date.now() };
    assistantMessageRef = assistantMessage;

    // Initialize pending timeline from project state (v2) or convert from legacy recipe
    const projectV2 = project as EditorProjectV2;
    const pendingTimeline: Timeline = projectV2.timeline
      ? JSON.parse(JSON.stringify(projectV2.timeline))
      : recipeToTimeline(project.recipe, project.sourceVideo);

    const getProject = () => project as EditorProjectV2;
    const setProject = (p: EditorProjectV2) => { project = p; send({ type: "project", project: p }); };
    const tools = buildToolDispatcherV2(req, getProject, setProject, pendingTimeline, send);

    if (!isGeminiConfigured()) {
      // Offline fallback: regex generator + auto preview render if user said render
      const recipe = generateRecipe(userText, project.sourceVideo, project.assets);
      project = await writeProjectToWorkspace(ws, { ...project, prompt: userText, recipe });
      setProject(project);
      assistantMessage.content = `AI key not configured — used the fast offline parser. Recipe: ${snapshotRecipeSummary(project)}.`;
      send({ type: "text", content: assistantMessage.content });
      send({ type: "done" });
      history.push(assistantMessage);
      await persistChat();
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      res.end();
      return;
    }

    const model = (process.env.EDITOR_AGENT_MODEL || "gemma-4-31b-it").trim();
    const thinkingBudget = process.env.EDITOR_AGENT_THINKING_BUDGET || "MEDIUM";

    const projectContext = `Current project:\n- sourceVideo: ${project.sourceVideo ?? "(none)"}\n- assets.logo: ${project.assets.logo ?? "(none)"}\n- assets.intro: ${project.assets.intro ?? "(none)"}\n- assets.outro: ${project.assets.outro ?? "(none)"}\n- recipe: ${snapshotRecipeSummary(project)}`;

    // ── Multimodal context: the agent must SEE its inputs ─────────────────
    // Images (logo, intro/outro stills, overlay images) are sent inline as
    // base64 — Gemini reads images DIRECTLY in both API-key and Vertex modes,
    // no GCS needed. This is what fixes "I can't read the logo".
    // Video/audio is NOT attached for full model-watching by default (slow +
    // costly). For understanding a YouTube video the agent calls get_transcript
    // (full captions = full context); to actually watch/listen to it it calls
    // watch_youtube_video on demand. For local clips it uses analyze_video
    // (frame sampling) + get_transcript.
    const projectContextParts: any[] = [{ text: projectContext }];

    // Attach uploaded/timeline IMAGES inline so the agent can actually see them
    // (logo, overlay images, intro/outro stills, image source). Deduped + capped.
    try {
      const imageCandidates: Array<{ label: string; path: string }> = [];
      if (project.assets.logo) imageCandidates.push({ label: "logo", path: project.assets.logo });
      if (project.assets.intro && imageMimeForExt(project.assets.intro)) imageCandidates.push({ label: "intro image", path: project.assets.intro });
      if (project.assets.outro && imageMimeForExt(project.assets.outro)) imageCandidates.push({ label: "outro image", path: project.assets.outro });
      if (project.sourceVideo && imageMimeForExt(project.sourceVideo)) imageCandidates.push({ label: "source image", path: project.sourceVideo });
      for (const ov of pendingTimeline.tracks.overlays) {
        if ((ov.type === "logo" || ov.type === "image") && imageMimeForExt(ov.content)) {
          imageCandidates.push({ label: `${ov.type} overlay`, path: ov.content });
        }
      }
      const seenImg = new Set<string>();
      for (const cand of imageCandidates) {
        if (seenImg.has(cand.path)) continue;
        seenImg.add(cand.path);
        if (seenImg.size > 6) break;
        const inline = await loadWorkspaceImageInline(ws, cand.path).catch(() => null);
        if (inline) {
          projectContextParts.push({ text: `[Visible ${cand.label} → ${cand.path}]` });
          projectContextParts.push({ inlineData: inline });
        }
      }
    } catch (imgErr) {
      logger.warn({ err: imgErr }, "[video-editor] failed to attach inline image assets");
    }

    const contents: any[] = history.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || (m.tool ? `(tool ${m.tool.name})` : "") }],
    }));
    contents.unshift({ role: "user", parts: projectContextParts });


    let iterations = 0;
    const maxIterations = 8;
    // Track whether the agent mutated the timeline this run and whether it
    // made the result durable via propose() / start_render(). If it mutated
    // but didn't persist, we auto-snapshot at the end so a refresh restores
    // the work as a pending proposal the user can apply or discard. Without
    // this, calling `add_clip` without `propose` silently loses the change
    // because pendingTimeline only lives in this request's scope.
    const TIMELINE_MUTATING_TOOLS = new Set([
      "add_clip", "remove_clip", "trim_clip", "set_clip_speed",
      "set_transition", "add_overlay", "remove_overlay", "add_audio",
      "set_export", "clear_timeline", "split_clip", "reorder_clips",
      "detect_logo_background",
    ]);
    let timelineMutated = false;
    let timelinePersistedThisRun = false;

    while (iterations < maxIterations && !closed) {
      iterations += 1;
      send({ type: "thinking", iteration: iterations, total: maxIterations });
      let stream: any;
      const streamFallbackModels = Array.from(new Set([model, "gemini-2.5-flash", "gemini-3.5-flash"]));
      const keysList = getPersonalKeysForCaller("video-editor");
      const keyCount = Math.max(1, Math.min(keysList.length || 1, 13));
      const maxStreamAttempts = Math.max(2, keyCount * streamFallbackModels.length);
      let streamSuccess = false;
      let lastStreamErr: any = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let controller: AbortController | null = null;
      for (let attempt = 0; attempt < maxStreamAttempts; attempt++) {
        if (timeoutId) clearTimeout(timeoutId);
        controller = new AbortController();
        const currentController = controller;
        timeoutId = setTimeout(() => {
          console.warn(`[video-editor] Stream attempt ${attempt + 1}/${maxStreamAttempts} timed out after 20s. Aborting...`);
          currentController.abort();
        }, 20000);
        try {
          const currentModel = streamFallbackModels[Math.min(
            streamFallbackModels.length - 1,
            Math.floor(attempt / keyCount),
          )];
          const currentApiKey = getGeminiApiKeyForAttempt("video-editor", attempt);
          let currentAi = createGeminiClient({ caller: "video-editor", apiKey: currentApiKey });
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 150 + Math.random() * 100));
          }
          const configObj: any = {
            abortSignal: controller.signal,
            systemInstruction: AGENT_SYSTEM_PROMPT_V2,
            tools: [{ functionDeclarations: AGENT_TOOL_DECLARATIONS_V2 as any }],
            toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
            maxOutputTokens: 4096,
            thinkingConfig: buildThinkingConfig(currentModel, currentModel === "gemma-4-31b-it" ? "HIGH" : thinkingBudget),
          };
          if (currentModel === "gemma-4-31b-it") {
            configObj.temperature = 1.0;
            configObj.topP = 0.95;
            configObj.topK = 64;
          }
          stream = await currentAi.models.generateContentStream({
            model: currentModel,
            contents,
            config: configObj,
          });
          streamSuccess = true;
          break;
        } catch (streamErr: any) {
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          lastStreamErr = streamErr;
          const failedApiKey = getGeminiApiKeyForAttempt("video-editor", attempt);
          if (failedApiKey) recordKeyFailure(failedApiKey, streamErr).catch(() => {});
          console.warn(`[video-editor] generateContentStream attempt ${attempt + 1} failed: ${streamErr.message || streamErr}`);
          if (!isGeminiKeyRetryableError(streamErr)) {
            break;
          }
        }
      }
      if (!streamSuccess) {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        throw lastStreamErr ?? new Error("Gemini stream call failed on all keys and fallback models.");
      }

      const aggregatedParts: any[] = [];
      const fnCalls: any[] = [];
      let text = "";
      let firstChunkReceived = false;
      try {
        for await (const chunk of stream) {
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          }
          // Bail out fast if the client disconnected — the agent can still
          // continue to mutate state but we stop pushing more network IO.
          if (closed) break;
          const cParts: any[] = chunk?.candidates?.[0]?.content?.parts || [];
          for (const part of cParts) {
            aggregatedParts.push(part);
            if (part.functionCall) fnCalls.push(part.functionCall);
            if (typeof part.text === "string" && part.text) {
              if (part.thought === true) {
                send({ type: "thought", content: part.text });
              } else {
                text += part.text;
                send({ type: "text", content: part.text });
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "[video-editor] stream chunk failed");
      } finally {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      }

      contents.push({ role: "model", parts: aggregatedParts });

      // Accumulate streamed text across iterations so the persisted
      // assistant message matches what the user actually saw, and snapshot
      // it onto the assistantMessage so a refresh shows partial replies.
      if (text) {
        finalTextSoFar = (finalTextSoFar ? `${finalTextSoFar}\n` : "") + text;
        assistantMessage.content = finalTextSoFar;
      }

      if (fnCalls.length === 0) break;

      const responseParts: any[] = [];
      for (const call of fnCalls) {
        const name = String(call.name || "");
        const args = call.args || {};
        const toolCallId = randomUUID();
        send({ type: "tool_start", name, args, toolCallId });
        const exec = tools[name];
        if (!exec) {
          send({ type: "tool_done", name, ok: false, error: "Unknown tool", toolCallId });
          responseParts.push({ functionResponse: { name, response: { error: "unknown tool" } } });
          continue;
        }
        try {
          const result = await exec(args);
          if (TIMELINE_MUTATING_TOOLS.has(name)) {
            timelineMutated = true;
            // Any mutation that runs AFTER a propose/start_render means the
            // snapshot we just persisted no longer matches pendingTimeline.
            // Re-arm so the end-of-turn auto-snapshot fires and captures the
            // post-propose tweaks — otherwise `set_transition` after
            // `propose()` in the same turn would be lost on refresh.
            timelinePersistedThisRun = false;
          }
          // propose() saves the timeline as a pending proposal record;
          // start_render() commits pendingTimeline straight to project.timeline.
          // Both make the run durable, so we don't need to auto-snapshot.
          if (name === "propose" || name === "start_render") timelinePersistedThisRun = true;
          send({ type: "tool_done", name, ok: true, message: result.message, project: result.project, job: result.job, toolCallId });
          history.push({ id: randomUUID(), role: "tool", content: result.message, tool: { name, args, result: { message: result.message, jobId: result.job?.jobId } }, createdAt: Date.now() });
          responseParts.push({ functionResponse: { name, response: { ok: true, message: result.message, recipe: project.recipe } } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({ type: "tool_done", name, ok: false, error: msg, toolCallId });
          history.push({ id: randomUUID(), role: "tool", content: `${name} failed: ${msg}`, tool: { name, args, result: { error: msg } }, createdAt: Date.now() });
          responseParts.push({ functionResponse: { name, response: { ok: false, error: msg } } });
        }
      }
      // Snapshot history after each iteration's tools so a long download or
      // render in tool #2 of an 8-step plan isn't lost on disconnect.
      await persistChat();
      contents.push({ role: "user", parts: responseParts });
    }

    if (!finalTextSoFar) finalTextSoFar = `Updated. Recipe: ${snapshotRecipeSummary(project)}.`;
    assistantMessage.content = finalTextSoFar;
    history.push(assistantMessage);
    // Auto-snapshot pending timeline as a proposal if the agent mutated the
    // timeline but never called propose() / start_render(). This is the
    // refresh-recovery safety net: without it, every "add a 5s fade-in" or
    // "trim the second clip" silently disappears when the user reloads,
    // because pendingTimeline only exists inside this request scope.
    if (timelineMutated && !timelinePersistedThisRun && !closed) {
      try {
        const cur = getProject();
        await resolveOpenEndedClipDurations(ws, pendingTimeline);
        const snapshotProposal: Proposal = {
          proposalId: randomUUID(),
          status: "pending",
          summary: "Auto-saved edit plan — apply to keep these changes, or refine in chat.",
          diff: [],
          timeline: JSON.parse(JSON.stringify(pendingTimeline)),
          createdAt: Date.now(),
        };
        const proposals = [
          ...((cur as any).proposals || []).filter((p: Proposal) => p.status !== "pending"),
          snapshotProposal,
        ];
        const next = await writeProjectToWorkspace(ws, { ...cur, proposals, version: 2 } as any);
        setProject(next as EditorProjectV2);
        send({
          type: "proposal",
          proposalId: snapshotProposal.proposalId,
          summary: snapshotProposal.summary,
          diff: snapshotProposal.diff,
          timeline: snapshotProposal.timeline,
          duration: computeTimelineDuration(snapshotProposal.timeline),
        });
      } catch (snapshotErr) {
        logger.warn({ err: snapshotErr }, "[video-editor] auto-snapshot proposal failed");
      }
    }
    await persistChat();
    send({ type: "assistant_message", message: assistantMessage });
    send({ type: "done" });
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    res.end();
  } catch (err) {
    logger.error({ err }, "[video-editor] chat failed");
    // Even on a hard failure, salvage whatever was captured so the user
    // doesn't reload to a blank chat. We append a short error line to the
    // assistant message so reviewers see what went wrong.
    const errMsg = err instanceof Error ? err.message : "chat failed";
    if (assistantMessageRef && projectIdSafe && wsSafe) {
      const finalContent = finalTextSoFar
        ? `${finalTextSoFar}\n\n⚠️ ${errMsg}`
        : `⚠️ ${errMsg}`;
      assistantMessageRef.content = finalContent;
      // Only push if it isn't already in history (we push at the end on the
      // happy path; this branch fires before that).
      if (!history.includes(assistantMessageRef)) history.push(assistantMessageRef);
      await persistChat().catch(() => {});
    }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try {
      sse(res, { type: "error", message: errMsg });
      sse(res, { type: "done" });
      res.end();
    } catch {
      // already closed
    }
  }
});

// ─── Server-side thumbnail for any render output ──────────────────────────────
// Bounded LRU. Without a cap, a long-running server eventually pins ~200 MiB
// of thumbnails per workspace.
const THUMB_CACHE_MAX_ENTRIES = 256;
const thumbCache = new Map<string, { buffer: Buffer; mtime: number }>();
const THUMB_CACHE_TTL_MS = 30 * 60 * 1000;

function thumbCacheGet(key: string): Buffer | null {
  const hit = thumbCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.mtime > THUMB_CACHE_TTL_MS) {
    thumbCache.delete(key);
    return null;
  }
  // LRU touch.
  thumbCache.delete(key);
  thumbCache.set(key, hit);
  return hit.buffer;
}

function thumbCacheSet(key: string, buffer: Buffer): void {
  thumbCache.set(key, { buffer, mtime: Date.now() });
  while (thumbCache.size > THUMB_CACHE_MAX_ENTRIES) {
    const oldest = thumbCache.keys().next().value;
    if (!oldest) break;
    thumbCache.delete(oldest);
  }
}

router.get("/projects/:projectId/renders/:jobId/thumb", async (req: Request, res: Response) => {
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const jobId = routeParam(req.params.jobId, "jobId");
    const ws = getWorkspace(req);
    const project = await readProjectFromWorkspace(ws, projectId);
    const render = project.renders.find((r) => r.jobId === jobId);
    if (!render || !render.outputPath || render.status !== "done") {
      return bad(res, 404, "render not ready");
    }
    const cacheKey = `${projectId}:${jobId}`;
    const cachedBuf = thumbCacheGet(cacheKey);
    if (cachedBuf) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=1800");
      return res.end(cachedBuf);
    }
    const dir = join(tmpdir(), `editor-thumb-${jobId}`);
    await mkdir(dir, { recursive: true });
    const srcPath = join(dir, "out.mp4");
    const thumbPath = join(dir, "thumb.jpg");
    try {
      await downloadWorkspaceFile(ws, render.outputPath, srcPath);
      const duration = await probeDuration(srcPath).catch(() => 0);
      const at = duration > 1 ? Math.min(duration / 6, 5) : 0;
      await runFfmpegRaw([
        "-y", "-ss", String(at), "-i", srcPath,
        "-frames:v", "1", "-q:v", "4", "-vf", "scale=320:-2:flags=lanczos",
        thumbPath,
      ]);
      const buffer = await readFile(thumbPath);
      thumbCacheSet(cacheKey, buffer);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=1800");
      return res.end(buffer);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return fail(res, err);
  }
});

// ─── Source-asset frame thumbnail (for the visual editor preview) ─────────────
// Returns a single JPEG frame from a workspace VIDEO asset at time `t` (sec),
// or the image itself for image assets. Used by the review editor to show clip
// posters + the preview composite WITHOUT rendering. Same LRU cache as renders.
router.get("/projects/:projectId/asset-frame", async (req: Request, res: Response) => {
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    const path = rawPath.trim().replace(/^\/+/, "");
    // Only allow workspace editor paths — never arbitrary URLs or traversal.
    if (!path || path.includes("..") || !/^editor\/[A-Za-z0-9/_.()\- ]+$/.test(path)) {
      return bad(res, 400, "invalid asset path");
    }
    const ws = getWorkspace(req);

    // Image asset → just hand back a presigned URL (302), no re-encode.
    if (imageMimeForExt(path)) {
      const { url } = await ws.s3.presignGet(path, { disposition: "inline" });
      res.setHeader("Cache-Control", "private, max-age=600");
      return res.redirect(302, url);
    }

    const t = Math.max(0, Number(req.query.t) || 0);
    const cacheKey = `frame:${projectId}:${path}:${t.toFixed(2)}`;
    const cachedBuf = thumbCacheGet(cacheKey);
    if (cachedBuf) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=1800");
      return res.end(cachedBuf);
    }
    const dir = join(tmpdir(), `editor-frame-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const srcPath = join(dir, `src${extname(path) || ".mp4"}`);
    const framePath = join(dir, "frame.jpg");
    try {
      await downloadWorkspaceFile(ws, path, srcPath);
      // Input-seek (fast) + single frame, downscaled poster.
      await runFfmpegRaw([
        "-y", "-ss", String(t), "-i", srcPath,
        "-frames:v", "1", "-q:v", "4", "-vf", "scale=480:-2:flags=lanczos",
        framePath,
      ]);
      const buffer = await readFile(framePath);
      thumbCacheSet(cacheKey, buffer);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=1800");
      return res.end(buffer);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return fail(res, err);
  }
});

// ─── Source-asset metadata (duration/resolution) for the editor ───────────────
const assetMetaCache = new Map<string, { value: { duration: number; width: number; height: number; hasAudio: boolean }; at: number }>();
const ASSET_META_TTL_MS = 30 * 60 * 1000;
router.get("/projects/:projectId/asset-meta", async (req: Request, res: Response) => {
  try {
    routeParam(req.params.projectId, "projectId");
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    const path = rawPath.trim().replace(/^\/+/, "");
    if (!path || path.includes("..") || !/^editor\/[A-Za-z0-9/_.()\- ]+$/.test(path)) {
      return bad(res, 400, "invalid asset path");
    }
    const cached = assetMetaCache.get(path);
    if (cached && Date.now() - cached.at < ASSET_META_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=900");
      return res.json(cached.value);
    }
    const ws = getWorkspace(req);
    const dir = join(tmpdir(), `editor-meta-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const local = join(dir, `src${extname(path) || ".mp4"}`);
    try {
      await downloadWorkspaceFile(ws, path, local);
      const meta = await probeMetadata(local);
      assetMetaCache.set(path, { value: meta, at: Date.now() });
      if (assetMetaCache.size > 512) {
        const oldest = assetMetaCache.keys().next().value;
        if (oldest) assetMetaCache.delete(oldest);
      }
      res.setHeader("Cache-Control", "public, max-age=900");
      return res.json(meta);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return fail(res, err);
  }
});

// ─── Presigned stream URL for an asset (editor playback fallback) ─────────────
// The editor plays local files directly (blob URL); when it doesn't have the
// local file (reload / other device / YouTube-downloaded clip) it streams the
// uploaded copy via this presigned GET, which <video> can range-request.
router.get("/projects/:projectId/asset-url", async (req: Request, res: Response) => {
  try {
    routeParam(req.params.projectId, "projectId");
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    const path = rawPath.trim().replace(/^\/+/, "");
    if (!path || path.includes("..") || !/^editor\/[A-Za-z0-9/_.()\- ]+$/.test(path)) {
      return bad(res, 400, "invalid asset path");
    }
    const ws = getWorkspace(req);
    const { url } = await ws.s3.presignGet(path, { disposition: "inline" });
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.json({ url });
  } catch (err) {
    return fail(res, err);
  }
});

// ─── Proposal endpoints ───────────────────────────────────────────────────────
router.post("/projects/:projectId/proposals/:proposalId/apply", async (req: Request, res: Response) => {
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const proposalId = routeParam(req.params.proposalId, "proposalId");
    const ws = getWorkspace(req);
    const project = await readProjectFromWorkspace(ws, projectId) as EditorProjectV2;
    const proposal = (project.proposals || []).find(p => p.proposalId === proposalId);
    if (!proposal) return bad(res, 404, "proposal not found");
    if (proposal.status !== "pending") return bad(res, 400, `proposal already ${proposal.status}`);

    proposal.status = "applied";
    const next = await writeProjectToWorkspace(ws, {
      ...project,
      timeline: proposal.timeline,
      version: 2,
      proposals: project.proposals,
    } as any);
    return res.json({ project: next, proposal });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/projects/:projectId/proposals/:proposalId/reject", async (req: Request, res: Response) => {
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const proposalId = routeParam(req.params.proposalId, "proposalId");
    const ws = getWorkspace(req);
    const project = await readProjectFromWorkspace(ws, projectId) as EditorProjectV2;
    const proposal = (project.proposals || []).find(p => p.proposalId === proposalId);
    if (!proposal) return bad(res, 404, "proposal not found");

    proposal.status = "rejected";
    const next = await writeProjectToWorkspace(ws, { ...project, proposals: project.proposals } as any);
    return res.json({ project: next, proposal });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/projects/:projectId/proposals", async (req: Request, res: Response) => {
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const project = await readProject(req, projectId) as EditorProjectV2;
    return res.json({ proposals: project.proposals || [] });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
