import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join, extname } from "path";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { statSync } from "fs";
import ffmpegStatic from "ffmpeg-static";
import { Type } from "@google/genai";
import { getWorkspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { setupSse, sseFlush } from "../lib/sse";
import { createGeminiClient, isGeminiConfigured } from "../lib/gemini-client";
import { submitEditorRenderJob, getJobStatusFromDdb } from "../lib/youtube-queue";

const VIDEO_EDITOR_QUEUE_ENABLED = (process.env.VIDEO_EDITOR_QUEUE_ENABLED || "").toLowerCase() === "true";

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
const FFMPEG_BIN = process.env.FFMPEG_BIN || ffmpegStatic || "ffmpeg";

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
  // Back-fill optional fields for older project records.
  return {
    aspectRatio: recipe?.aspectRatio || "original",
    cropMode: recipe?.cropMode || "smart",
    trim: recipe?.trim || { start: 0, end: null },
    speed: typeof recipe?.speed === "number" ? recipe.speed : 1,
    colorPreset: recipe?.colorPreset || "none",
    overlays: Array.isArray(recipe?.overlays) ? recipe.overlays : [],
    intro: recipe?.intro || { enabled: false, asset: null },
    outro: recipe?.outro || { enabled: false, asset: null },
    transitions: recipe?.transitions || { fade: true },
    export: recipe?.export || { format: "mp4", resolution: "1080p", videoCodec: "h264", audioCodec: "aac" },
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

function baseVideoFilter(recipe: EditRecipe, width: number, height: number): string {
  if (recipe.cropMode === "contain") {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`;
}

function overlayPosition(position: LogoPosition, margin: number): string {
  switch (position) {
    case "top-left": return `${margin}:${margin}`;
    case "bottom-right": return `W-w-${margin}:H-h-${margin}`;
    case "bottom-left": return `${margin}:H-h-${margin}`;
    case "top-right": return `W-w-${margin}:${margin}`;
  }
}

function buildFfmpegArgs(params: {
  sourcePath: string;
  logoPath?: string | null;
  outputPath: string;
  recipe: EditRecipe;
  preview: boolean;
}): string[] {
  const { width, height } = targetSize(params.recipe.aspectRatio);
  const args = ["-y"];
  const duration = params.preview ? 8 : null;
  if (params.recipe.trim.start > 0) args.push("-ss", String(params.recipe.trim.start));
  if (duration) args.push("-t", String(duration));
  else if (params.recipe.trim.end != null && params.recipe.trim.end > params.recipe.trim.start) {
    args.push("-t", String(params.recipe.trim.end - params.recipe.trim.start));
  }
  args.push("-i", params.sourcePath);

  const logoOverlay = params.recipe.overlays.find((item) => item.type === "logo" && params.logoPath) as
    | Extract<EditRecipe["overlays"][number], { type: "logo" }>
    | undefined;
  if (logoOverlay && params.logoPath) args.push("-i", params.logoPath);

  const filters: string[] = [];
  if (params.recipe.cropMode === "fit-blur") {
    filters.push(`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},boxblur=24:2[bg]`);
    filters.push(`[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg]`);
    filters.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]`);
  } else {
    filters.push(`[0:v]${baseVideoFilter(params.recipe, width, height)}[v0]`);
  }
  let current = "v0";
  let step = 1;

  if (logoOverlay) {
    const logoWidth = Math.max(48, Math.round(width * (logoOverlay.widthPercent / 100)));
    const margin = Math.round(width * 0.045);
    // Tighter keying with a soft alpha edge so fringe doesn't ring on dark scenes.
    const keyFilter =
      logoOverlay.key === "auto-white"
        ? "format=rgba,colorkey=0xffffff:0.30:0.20,"
        : logoOverlay.key === "auto-black"
          ? "format=rgba,colorkey=0x000000:0.30:0.20,"
          : "";
    filters.push(`[1:v]${keyFilter}scale=${logoWidth}:-1:flags=lanczos[logo]`);
    filters.push(`[${current}][logo]overlay=${overlayPosition(logoOverlay.position, margin)}:format=auto[v${step}]`);
    current = `v${step}`;
    step += 1;
  }

  for (const overlay of params.recipe.overlays) {
    if (overlay.type !== "text") continue;
    const fontSize = Math.max(34, Math.round(width * 0.055));
    const y = overlay.position === "top-left" ? Math.round(height * 0.08) : Math.round(height * 0.88);
    const x = overlay.position === "bottom-right" ? `w-text_w-${Math.round(width * 0.06)}` : "(w-text_w)/2";
    filters.push(
      `[${current}]drawtext=text='${escapeDrawText(overlay.text)}':fontcolor=white:fontsize=${fontSize}:borderw=3:bordercolor=black@0.65:x=${x}:y=${y}[v${step}]`,
    );
    current = `v${step}`;
    step += 1;
  }

  const colorFilter = colorPresetFilter(params.recipe.colorPreset);
  if (colorFilter) {
    filters.push(`[${current}]${colorFilter}[v${step}]`);
    current = `v${step}`;
    step += 1;
  }

  const speed = Math.min(4, Math.max(0.25, params.recipe.speed || 1));
  let audioMap: string[] = ["-map", "0:a?"];
  if (Math.abs(speed - 1) > 0.001) {
    filters.push(`[${current}]setpts=${(1 / speed).toFixed(4)}*PTS[v${step}]`);
    current = `v${step}`;
    step += 1;
    // atempo accepts 0.5–2 per filter; chain for extreme speeds.
    const atempoChain: string[] = [];
    let remaining = speed;
    while (remaining > 2.0001) { atempoChain.push("atempo=2.0"); remaining /= 2; }
    while (remaining < 0.5 - 0.0001) { atempoChain.push("atempo=0.5"); remaining /= 0.5; }
    atempoChain.push(`atempo=${remaining.toFixed(4)}`);
    filters.push(`[0:a]${atempoChain.join(",")}[a0]`);
    audioMap = ["-map", "[a0]"];
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${current}]`,
    ...audioMap,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", params.preview ? "28" : "22",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    "-shortest",
    params.outputPath,
  );
  return args;
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

function runFfmpegRaw(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    proc.on("error", (err) => reject(new Error(`Failed to start FFmpeg: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1200) || `FFmpeg exited with code ${code}`));
    });
  });
}

async function normalizeClip(input: string, output: string, width: number, height: number, fade: boolean, fadeIn: boolean, fadeOut: boolean): Promise<void> {
  // Probe duration for fade-out positioning.
  const dur = await probeDuration(input).catch(() => 0);
  const filters: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    `setsar=1`,
  ];
  if (fade && fadeIn) filters.push(`fade=t=in:st=0:d=0.4`);
  if (fade && fadeOut && dur > 0.5) filters.push(`fade=t=out:st=${Math.max(0, dur - 0.4).toFixed(2)}:d=0.4`);
  const audioFilters: string[] = [];
  if (fade && fadeIn) audioFilters.push(`afade=t=in:st=0:d=0.4`);
  if (fade && fadeOut && dur > 0.5) audioFilters.push(`afade=t=out:st=${Math.max(0, dur - 0.4).toFixed(2)}:d=0.4`);
  const args = [
    "-y", "-i", input,
    "-vf", filters.join(","),
    ...(audioFilters.length ? ["-af", audioFilters.join(",")] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output,
  ];
  await runFfmpegRaw(args);
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

async function concatClips(inputs: string[], output: string): Promise<void> {
  const args: string[] = ["-y"];
  for (const p of inputs) args.push("-i", p);
  const segs = inputs.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("");
  args.push(
    "-filter_complex", `${segs}concat=n=${inputs.length}:v=1:a=1[v][a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  );
  await runFfmpegRaw(args);
}

/**
 * Joins clips with a real video+audio crossfade (xfade + acrossfade) at the
 * boundaries. Falls back to plain concat if a duration probe fails.
 */
async function crossfadeClips(inputs: string[], output: string, fadeDur = 0.5): Promise<void> {
  if (inputs.length < 2) { await concatClips(inputs, output); return; }
  const durations: number[] = [];
  for (const p of inputs) {
    const d = await probeDuration(p).catch(() => 0);
    if (!Number.isFinite(d) || d <= fadeDur * 2) { await concatClips(inputs, output); return; }
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
    cumOffset += durations[i - 1] - fadeDur;
    const vOut = `xv${i}`;
    const aOut = `xa${i}`;
    vFilters.push(`[${vLabel}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}]`);
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
  await runFfmpegRaw(args);
}

async function downloadWorkspaceFile(ws: ReturnType<typeof getWorkspace>, path: string, dest: string): Promise<void> {
  const { url } = await ws.s3.presignGet(path, { disposition: "inline" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${path}: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
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

function runFfmpeg(args: string[], job: EditorJob): Promise<void> {
  return new Promise((resolve, reject) => {
    job.status = "running";
    job.progress = Math.max(job.progress, 25);
    job.message = "Rendering video...";
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
      if (job.status === "running") job.progress = Math.min(88, job.progress + 2);
    });
    proc.on("error", (err) => reject(new Error(`Failed to start FFmpeg: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1200) || `FFmpeg exited with code ${code}`));
    });
  });
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

async function processRenderJob(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<void> {
  const dir = join(tmpdir(), `video-editor-${job.jobId}`);
  await mkdir(dir, { recursive: true });
  try {
    const project = await readProjectFromWorkspace(ws, projectId);
    if (!project.sourceVideo) throw new Error("source video required");
    const sourcePath = join(dir, `source${extname(project.sourceVideo) || ".mp4"}`);
    const logoOverlay = project.recipe.overlays.find((item) => item.type === "logo") as
      | Extract<EditRecipe["overlays"][number], { type: "logo" }>
      | undefined;
    const logoPath = logoOverlay?.asset ? join(dir, `logo${extname(logoOverlay.asset) || ".png"}`) : null;
    const mainPath = join(dir, `main.mp4`);
    const outputPath = join(dir, `${job.kind}.mp4`);
    const workspaceOutput = `editor/renders/${projectId}/${job.kind}-${job.jobId}.mp4`;
    const intro = project.recipe.intro.enabled && project.recipe.intro.asset ? project.recipe.intro.asset : null;
    const outro = project.recipe.outro.enabled && project.recipe.outro.asset ? project.recipe.outro.asset : null;
    const introPath = intro && job.kind === "final" ? join(dir, `intro${extname(intro) || ".mp4"}`) : null;
    const outroPath = outro && job.kind === "final" ? join(dir, `outro${extname(outro) || ".mp4"}`) : null;
    const introNorm = introPath ? join(dir, "intro-norm.mp4") : null;
    const outroNorm = outroPath ? join(dir, "outro-norm.mp4") : null;

    job.message = "Downloading source assets...";
    job.progress = 10;
    await downloadWorkspaceFile(ws, project.sourceVideo, sourcePath);
    if (logoOverlay?.asset && logoPath) await downloadWorkspaceFile(ws, logoOverlay.asset, logoPath);
    if (intro && introPath) await downloadWorkspaceFile(ws, intro, introPath);
    if (outro && outroPath) await downloadWorkspaceFile(ws, outro, outroPath);

    await runFfmpeg(buildFfmpegArgs({
      sourcePath,
      logoPath,
      outputPath: mainPath,
      recipe: project.recipe,
      preview: job.kind === "preview",
    }), job);
    if (!statSync(mainPath).size) throw new Error("Render produced an empty file");

    const { width, height } = targetSize(project.recipe.aspectRatio);
    const fade = project.recipe.transitions?.fade ?? true;
    if (introPath && introNorm) {
      job.message = "Normalizing intro...";
      // When crossfading, skip the inner fade-out so the xfade isn't doubled.
      await normalizeClip(introPath, introNorm, width, height, fade, true, !fade);
    }
    if (outroPath && outroNorm) {
      job.message = "Normalizing outro...";
      // When crossfading, skip the inner fade-in so the xfade isn't doubled.
      await normalizeClip(outroPath, outroNorm, width, height, fade, !fade, true);
    }
    const chain = [introNorm, mainPath, outroNorm].filter((p): p is string => Boolean(p));
    if (chain.length > 1) {
      job.message = fade ? "Crossfading intro/outro..." : "Joining intro/outro...";
      job.progress = Math.max(job.progress, 90);
      if (fade) await crossfadeClips(chain, outputPath, 0.5);
      else await concatClips(chain, outputPath);
    } else {
      await rm(outputPath, { force: true }).catch(() => {});
      await (await import("fs/promises")).rename(mainPath, outputPath);
    }

    if (!statSync(outputPath).size) throw new Error("Render produced an empty file");
    job.message = "Saving render to workspace...";
    job.progress = 92;
    await uploadWorkspaceFile(ws, outputPath, workspaceOutput);
    job.status = "done";
    job.progress = 100;
    job.message = "Render saved to workspace.";
    job.outputPath = workspaceOutput;
    job.completedAt = Date.now();
    await persistJobToProject(ws, projectId, job);
  } catch (err) {
    job.status = "error";
    job.progress = 0;
    job.message = err instanceof Error ? err.message : "Render failed";
    job.error = job.message;
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

router.post("/projects/:projectId/agent", async (req: Request, res: Response) => {
  try {
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : project.prompt;
    const sourceVideo = cleanWorkspacePath(req.body?.sourceVideo) ?? project.sourceVideo;
    const assets: EditorAssets = {
      logo: cleanWorkspacePath(req.body?.assets?.logo) ?? project.assets.logo ?? null,
      intro: cleanWorkspacePath(req.body?.assets?.intro) ?? project.assets.intro ?? null,
      outro: cleanWorkspacePath(req.body?.assets?.outro) ?? project.assets.outro ?? null,
    };
    const next = await writeProject(req, {
      ...project,
      prompt,
      sourceVideo,
      assets,
      recipe: generateRecipe(prompt, sourceVideo, assets),
    });
    return res.json({
      project: next,
      message: "Created a renderable edit recipe for the current v1 finishing tools.",
    });
  } catch (err) {
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
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    if (!project.sourceVideo) return bad(res, 400, "source video required");
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
    const next = await writeProject(req, {
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
    void processRenderJob(ws, project.projectId, job);
    return res.json({ job, project: next });
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
    const mapped: EditorJob = {
      jobId,
      projectId: "",
      kind: "final",
      status: (["pending", "running", "done", "error", "cancelled"].includes(ddbStatus.status) ? ddbStatus.status : "running") as RenderStatus,
      progress: ddbStatus.progressPct ?? (ddbStatus.status === "done" ? 100 : ddbStatus.status === "queued" ? 1 : 50),
      message: ddbStatus.message,
      outputPath: ddbStatus.s3Key,
      createdAt: 0,
      completedAt: ddbStatus.status === "done" || ddbStatus.status === "error" ? Date.now() : null,
    };
    return res.json({ job: mapped });
  } catch (err) {
    logger.warn({ err, jobId }, "[video-editor] ddb job lookup failed");
    return bad(res, 404, "job not found");
  }
});

router.post("/jobs/:jobId/cancel", (req: Request, res: Response) => {
  const job = jobs.get(routeParam(req.params.jobId, "jobId"));
  if (!job) return bad(res, 404, "job not found");
  if (job.status === "pending" || job.status === "running") {
    job.status = "cancelled";
    job.message = "Cancelled";
    job.completedAt = Date.now();
  }
  return res.json({ job });
});

// ─── Manual recipe overrides ──────────────────────────────────────────────────
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeRecipePatch(current: EditRecipe, patch: any): EditRecipe {
  if (!patch || typeof patch !== "object") return current;
  const next: EditRecipe = JSON.parse(JSON.stringify(current));
  if (patch.aspectRatio && ["original", "9:16", "16:9", "1:1"].includes(patch.aspectRatio)) {
    next.aspectRatio = patch.aspectRatio;
  }
  if (patch.cropMode && ["smart", "fit-blur", "contain"].includes(patch.cropMode)) {
    next.cropMode = patch.cropMode;
  }
  if (patch.trim && typeof patch.trim === "object") {
    next.trim = {
      start: clampNumber(patch.trim.start, 0, 86400, next.trim.start || 0),
      end: patch.trim.end == null ? null : clampNumber(patch.trim.end, 0, 86400, next.trim.end ?? 0),
    };
  }
  if (patch.speed != null) next.speed = clampNumber(patch.speed, 0.25, 4, 1);
  if (typeof patch.colorPreset === "string" && ["none", "vivid", "muted", "bw", "warm", "cool"].includes(patch.colorPreset)) {
    next.colorPreset = patch.colorPreset;
  }
  if (patch.intro && typeof patch.intro === "object") {
    next.intro = { enabled: Boolean(patch.intro.enabled), asset: patch.intro.asset ?? next.intro.asset };
  }
  if (patch.outro && typeof patch.outro === "object") {
    next.outro = { enabled: Boolean(patch.outro.enabled), asset: patch.outro.asset ?? next.outro.asset };
  }
  if (patch.transitions && typeof patch.transitions === "object") {
    next.transitions = { fade: Boolean(patch.transitions.fade) };
  }
  if (Array.isArray(patch.overlays)) {
    const cleaned: EditRecipe["overlays"] = [];
    for (const item of patch.overlays) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "logo" && typeof item.asset === "string") {
        cleaned.push({
          type: "logo",
          asset: item.asset,
          position: ["top-right", "top-left", "bottom-right", "bottom-left"].includes(item.position) ? item.position : "top-right",
          widthPercent: clampNumber(item.widthPercent, 3, 25, 8),
          key: ["none", "auto-white", "auto-black"].includes(item.key) ? item.key : "none",
        });
      } else if (item.type === "text" && typeof item.text === "string") {
        cleaned.push({
          type: "text",
          text: String(item.text).slice(0, 200),
          position: ["bottom-center", "bottom-right", "top-left"].includes(item.position) ? item.position : "bottom-center",
          style: item.style === "headline" ? "headline" : "bold-clean",
        });
      }
    }
    next.overlays = cleaned;
  }
  return next;
}

router.patch("/projects/:projectId/recipe", async (req: Request, res: Response) => {
  try {
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    // Accept either { recipe: {...} } or the patch directly.
    const patch = req.body && typeof req.body.recipe === "object" ? req.body.recipe : req.body;
    const recipe = normalizeRecipePatch(project.recipe, patch);
    const next = await writeProject(req, { ...project, recipe });
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

function buildToolDispatcher(req: Request, getProject: () => EditorProject, setProject: (p: EditorProject) => void): Record<string, ToolExec> {
  return {
    read_project: async () => ({ message: "Loaded project state.", project: getProject() }),
    set_aspect_ratio: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { aspectRatio: args?.aspectRatio }) });
      setProject(next);
      return { message: `Aspect ratio set to ${next.recipe.aspectRatio}.`, project: next };
    },
    set_crop_mode: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { cropMode: args?.cropMode }) });
      setProject(next);
      return { message: `Crop mode set to ${next.recipe.cropMode}.`, project: next };
    },
    set_trim: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { trim: { start: args?.start ?? 0, end: args?.end ?? null } }) });
      setProject(next);
      return { message: `Trim set ${next.recipe.trim.start}s → ${next.recipe.trim.end ?? "end"}.`, project: next };
    },
    add_logo_overlay: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const asset = typeof args?.asset === "string" && args.asset ? args.asset : cur.assets.logo;
      if (!asset) throw new Error("No logo asset uploaded yet.");
      const overlays: EditRecipe["overlays"] = cur.recipe.overlays.filter((o) => o.type !== "logo");
      overlays.push({
        type: "logo",
        asset,
        position: args?.position || "top-right",
        widthPercent: typeof args?.widthPercent === "number" ? args.widthPercent : 8,
        key: args?.key || "none",
      });
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { overlays }) });
      setProject(next);
      return { message: `Logo placed ${next.recipe.overlays.find((o) => o.type === "logo") ? (next.recipe.overlays.find((o) => o.type === "logo") as any).position : "top-right"}.`, project: next };
    },
    add_text_overlay: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const text = String(args?.text || "").slice(0, 200);
      if (!text) throw new Error("Text is required.");
      const overlays = [...cur.recipe.overlays, {
        type: "text" as const,
        text,
        position: args?.position || "bottom-center",
        style: args?.style === "headline" ? "headline" as const : "bold-clean" as const,
      }];
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { overlays }) });
      setProject(next);
      return { message: `Added text "${text}".`, project: next };
    },
    remove_overlays: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const kind = args?.type;
      const overlays = kind ? cur.recipe.overlays.filter((o) => o.type !== kind) : [];
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { overlays }) });
      setProject(next);
      return { message: kind ? `Removed all ${kind} overlays.` : "Cleared overlays.", project: next };
    },
    enable_intro: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const enabled = args?.enabled !== false;
      if (enabled && !cur.assets.intro) throw new Error("No intro asset uploaded.");
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { intro: { enabled, asset: cur.assets.intro || null } }) });
      setProject(next);
      return { message: enabled ? "Intro enabled." : "Intro disabled.", project: next };
    },
    enable_outro: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const enabled = args?.enabled !== false;
      if (enabled && !cur.assets.outro) throw new Error("No outro asset uploaded.");
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { outro: { enabled, asset: cur.assets.outro || null } }) });
      setProject(next);
      return { message: enabled ? "Outro enabled." : "Outro disabled.", project: next };
    },
    set_transitions: async (args) => {
      const ws = getWorkspace(req);
      const cur = getProject();
      const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { transitions: { fade: args?.fade !== false } }) });
      setProject(next);
      return { message: `Transitions: ${next.recipe.transitions?.fade === false ? "hard cut" : "fade"}.`, project: next };
    },
    start_preview_render: async () => {
      const ws = getWorkspace(req);
      const project = getProject();
      if (!project.sourceVideo) throw new Error("Upload a source video first.");
      const job = enqueueRender(ws, project, "preview");
      const next = await readProjectFromWorkspace(ws, project.projectId);
      setProject(next);
      return { message: "Preview render started.", project: next, job };
    },
    start_final_render: async () => {
      const ws = getWorkspace(req);
      const project = getProject();
      if (!project.sourceVideo) throw new Error("Upload a source video first.");
      const job = enqueueRender(ws, project, "final");
      const next = await readProjectFromWorkspace(ws, project.projectId);
      setProject(next);
      return { message: "Final render started.", project: next, job };
    },
    get_render_status: async () => {
      const project = getProject();
      const latest = project.renders[0];
      if (!latest) return { message: "No renders yet." };
      const live = jobs.get(latest.jobId);
      const status = live?.status ?? latest.status;
      const progress = live?.progress ?? latest.progress;
      const msg = live?.message ?? latest.message;
      return { message: `${latest.kind}: ${status} · ${progress}% — ${msg}` };
    },
    cancel_render: async () => {
      const project = getProject();
      const latest = project.renders[0];
      if (!latest) throw new Error("No active render to cancel.");
      const live = jobs.get(latest.jobId);
      if (live && (live.status === "pending" || live.status === "running")) {
        live.status = "cancelled";
        live.message = "Cancelled";
        live.completedAt = Date.now();
      }
      return { message: `Cancelled ${latest.kind} render.` };
    },
    detect_logo_background: async () => {
      const cur = getProject();
      if (!cur.assets.logo) throw new Error("No logo uploaded yet.");
      if (!isGeminiConfigured()) {
        // No vision model — best we can do is leave key as none.
        return { message: "Vision model not configured; left logo background as-is." };
      }
      const ws = getWorkspace(req);
      const tmp = join(tmpdir(), `editor-logo-${randomUUID()}`);
      await mkdir(tmp, { recursive: true });
      try {
        const ext = (extname(cur.assets.logo) || ".png").toLowerCase();
        const localPath = join(tmp, `logo${ext}`);
        await downloadWorkspaceFile(ws, cur.assets.logo, localPath);
        const bytes = await readFile(localPath);
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
        const ai = createGeminiClient();
        const resp: any = await ai.models.generateContent({
          model: (process.env.EDITOR_AGENT_MODEL || "gemini-3.1-pro-preview").trim(),
          contents: [{
            role: "user",
            parts: [
              { text: 'Look at this logo. Reply with ONLY one word from this list: "transparent" (logo already has alpha and needs no key), "white" (solid white background should be removed), "black" (solid black background should be removed), "none" (background is colored/photographic — keying would damage the logo). No punctuation, no explanation.' },
              { inlineData: { mimeType: mime, data: bytes.toString("base64") } },
            ],
          }],
          config: { maxOutputTokens: 16, thinkingConfig: { thinkingLevel: "LOW" as any } },
        });
        const text: string = String(
          resp?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === "string")?.text || "",
        ).trim().toLowerCase().replace(/[^a-z]/g, "");
        const decision: LogoKey = text === "white" ? "auto-white" : text === "black" ? "auto-black" : "none";
        const overlays: EditRecipe["overlays"] = cur.recipe.overlays.map((o) => o.type === "logo" ? { ...o, key: decision } : o);
        if (!overlays.find((o) => o.type === "logo") && cur.assets.logo) {
          overlays.push({ type: "logo", asset: cur.assets.logo, position: "top-right", widthPercent: 8, key: decision });
        }
        const next = await writeProjectToWorkspace(ws, { ...cur, recipe: normalizeRecipePatch(cur.recipe, { overlays }) });
        setProject(next);
        return { message: `Logo background: ${text || "unclear"} → key=${decision}.`, project: next };
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function enqueueRender(ws: ReturnType<typeof getWorkspace>, project: EditorProject, kind: "preview" | "final"): EditorJob {
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
  void (async () => {
    const latest = await readProjectFromWorkspace(ws, project.projectId).catch(() => project);
    await writeProjectToWorkspace(ws, {
      ...latest,
      renders: [
        { jobId: job.jobId, kind, status: job.status, progress: job.progress, message: job.message, outputPath: null, createdAt: job.createdAt, completedAt: null },
        ...latest.renders,
      ].slice(0, 20),
    });
    if (VIDEO_EDITOR_QUEUE_ENABLED) {
      try {
        const batchId = await submitEditorRenderJob({
          jobId: job.jobId,
          workspaceId: ws.identity.workspaceId,
          projectId: project.projectId,
          kind: job.kind,
        });
        if (batchId) {
          // Hand status off to DynamoDB — remove the in-memory entry so
          // GET /jobs/:jobId falls through to the DDB-backed worker progress.
          jobs.delete(job.jobId);
        } else {
          job.message = "Queued (Batch not available — falling back)";
          void processRenderJob(ws, project.projectId, job);
        }
      } catch (err) {
        logger.error({ err, jobId: job.jobId }, "[video-editor] batch submit failed; falling back to in-process");
        void processRenderJob(ws, project.projectId, job);
      }
    } else {
      void processRenderJob(ws, project.projectId, job);
    }
  })();
  return job;
}

const AGENT_TOOL_DECLARATIONS = [
  { name: "read_project", description: "Read the current project, recipe, assets, and last renders.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "set_aspect_ratio", description: "Set output aspect ratio.", parameters: { type: Type.OBJECT, properties: { aspectRatio: { type: Type.STRING, description: "original | 9:16 | 16:9 | 1:1" } }, required: ["aspectRatio"] } },
  { name: "set_crop_mode", description: "Set how the source video is fit to the target aspect.", parameters: { type: Type.OBJECT, properties: { cropMode: { type: Type.STRING, description: "smart | fit-blur | contain" } }, required: ["cropMode"] } },
  { name: "set_trim", description: "Trim seconds from start and/or end.", parameters: { type: Type.OBJECT, properties: { start: { type: Type.NUMBER }, end: { type: Type.NUMBER } } } },
  { name: "add_logo_overlay", description: "Place the uploaded logo on the output.", parameters: { type: Type.OBJECT, properties: { position: { type: Type.STRING, description: "top-right | top-left | bottom-right | bottom-left" }, widthPercent: { type: Type.NUMBER, description: "3-25" }, key: { type: Type.STRING, description: "none | auto-white | auto-black for simple background removal" } } } },
  { name: "add_text_overlay", description: "Add a text/date overlay to the output.", parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING }, position: { type: Type.STRING, description: "bottom-center | bottom-right | top-left" }, style: { type: Type.STRING, description: "bold-clean | headline" } }, required: ["text"] } },
  { name: "remove_overlays", description: "Remove overlays by type, or all if no type given.", parameters: { type: Type.OBJECT, properties: { type: { type: Type.STRING, description: "logo | text" } } } },
  { name: "enable_intro", description: "Use the uploaded intro asset.", parameters: { type: Type.OBJECT, properties: { enabled: { type: Type.BOOLEAN } } } },
  { name: "enable_outro", description: "Use the uploaded outro asset.", parameters: { type: Type.OBJECT, properties: { enabled: { type: Type.BOOLEAN } } } },
  { name: "set_transitions", description: "Enable or disable fade transitions for intro/outro.", parameters: { type: Type.OBJECT, properties: { fade: { type: Type.BOOLEAN } } } },
  { name: "start_preview_render", description: "Start a short low-res preview render so the user can check the recipe quickly.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "start_final_render", description: "Start the full final render.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "get_render_status", description: "Read the status, progress, and message of the most recent render.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "cancel_render", description: "Cancel the active or queued render.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "detect_logo_background", description: "Use a vision model to look at the uploaded logo and decide whether to key out a white/black background or leave it as-is. Updates the logo overlay's `key` field. Call this when the user asks to remove the logo's background and you're unsure which color to key.", parameters: { type: Type.OBJECT, properties: {} } },
];

const AGENT_SYSTEM_PROMPT = `You are the AI Video Studio finishing agent. You ONLY finish videos by editing a structured recipe and running renders. You have these tools: read_project, set_aspect_ratio, set_crop_mode, set_trim, add_logo_overlay, add_text_overlay, remove_overlays, enable_intro, enable_outro, set_transitions, start_preview_render, start_final_render, get_render_status, cancel_render, detect_logo_background.

Defaults for vague instructions:
- "shorts" / "reels" / "tiktok" / "vertical" → set_aspect_ratio 9:16, set_crop_mode smart.
- "square" → 1:1. "youtube" / "landscape" → 16:9.
- Logo asks default to top-right at 8% width. If the user says "remove logo background" without naming a color, call detect_logo_background first so a vision model picks the right key. If they explicitly say "remove white background" / "transparent logo", use key="auto-white"; "black background" → "auto-black".
- Dates / short text default to bottom-center, style="bold-clean".
- If the user mentions intro/outro and assets exist, enable them with fade transitions.

Behavior:
- Chain multiple tools in ONE turn when the user describes a multi-step finish. Example: "make vertical, add logo top-right, add 22 FEB 2026 at bottom, render preview" → set_aspect_ratio + add_logo_overlay + add_text_overlay + start_preview_render.
- After tool calls, end with ONE short sentence summarizing what changed. No markdown headings, no bullet lists.
- Never invent assets. If logo/intro/outro is missing, say so plainly and offer to proceed without it.
- For unsupported asks (object removal, manual timeline editing, frame-perfect keyframe animation, complex motion graphics, color grading wheels): explain the closest supported recipe in one sentence and offer to apply it.
- "render", "make it", "ship it", "do it" → start_final_render. "preview", "quick look", "check" → start_preview_render.
- If the user asks "what's happening" / "status" / "where are we" during a render, call get_render_status.
- Refuse general chat, web search, code, or non-finishing requests in one short sentence and redirect.`;

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
  { name: "add_overlay", description: "Add a timed overlay (logo, text, or image) to the timeline.", parameters: { type: Type.OBJECT, properties: {
    overlayType: { type: Type.STRING, description: "logo | text | image" },
    content: { type: Type.STRING, description: "Text string or asset path" },
    tlStart: { type: Type.NUMBER, description: "Start time on timeline (default 0)" },
    tlEnd: { type: Type.NUMBER, description: "End time on timeline (0 = full duration)" },
    position: { type: Type.STRING, description: "top-right | top-left | bottom-right | bottom-left | bottom-center | top-center" },
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
      const clip: TimelineClip = {
        id: randomUUID(),
        asset: args.asset,
        srcIn: args.srcIn ?? 0,
        srcOut: args.srcOut ?? 0,
        tlStart: args.tlStart ?? computeTimelineDuration(pendingTimeline),
        speed: Math.max(0.25, Math.min(4, args.speed ?? 1)),
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
      if (args.srcIn != null) clip.srcIn = args.srcIn;
      if (args.srcOut != null) clip.srcOut = args.srcOut;
      return { message: `Clip trimmed to ${clip.srcIn}s-${clip.srcOut || "end"}s.` };
    },
    set_clip_speed: async (args) => {
      const clip = pendingTimeline.tracks.video.find(c => c.id === args.clipId);
      if (!clip) throw new Error("Clip not found.");
      clip.speed = Math.max(0.25, Math.min(4, args.speed));
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
      let style: Record<string, any> = {};
      if (typeof args.style === "string") {
        try { style = JSON.parse(args.style); } catch { style = {}; }
      }
      if (args.overlayType === "logo" && !style.widthPercent) style.widthPercent = 8;
      if (args.overlayType === "logo" && !style.key) style.key = "none";
      if (args.overlayType === "text" && !style.style) style.style = "bold-clean";
      const overlay: TimedOverlay = {
        id: randomUUID(),
        type: args.overlayType || "text",
        content: args.content,
        tlStart: args.tlStart ?? 0,
        tlEnd: args.tlEnd ?? 0,
        position: args.position || (args.overlayType === "logo" ? "top-right" : "bottom-center"),
        style,
      };
      pendingTimeline.tracks.overlays.push(overlay);
      return { message: `Added ${overlay.type} overlay "${overlay.content.slice(0, 40)}" at ${overlay.position}.` };
    },
    remove_overlay: async (args) => {
      const idx = pendingTimeline.tracks.overlays.findIndex(o => o.id === args.overlayId);
      if (idx < 0) throw new Error("Overlay not found.");
      pendingTimeline.tracks.overlays.splice(idx, 1);
      return { message: "Overlay removed." };
    },
    add_audio: async (args) => {
      const audio: AudioClip = {
        id: randomUUID(),
        asset: args.asset,
        tlStart: args.tlStart ?? 0,
        tlEnd: args.tlEnd ?? 0,
        volumeDb: Math.max(-30, Math.min(6, args.volumeDb ?? -10)),
        fadeIn: args.fadeIn ?? 0,
        fadeOut: args.fadeOut ?? 0,
        duckSpeech: args.duckSpeech !== false,
      };
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
      const ws = getWorkspace(req);
      const cur = getProject();
      const proposals = [...((cur as any).proposals || []).filter((p: Proposal) => p.status !== "pending"), proposal];
      const next = await writeProjectToWorkspace(ws, { ...cur, proposals, timeline: pendingTimeline, version: 2 } as any);
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
      // ── Bridge V2 Timeline → V1 project fields for render engine ──
      if (pendingTimeline.tracks.video.length > 0 && !project.sourceVideo) {
        // Set sourceVideo from the first clip
        project.sourceVideo = pendingTimeline.tracks.video[0].asset;
        // Apply trim from first clip
        project.recipe.trim = {
          start: pendingTimeline.tracks.video[0].srcIn || null,
          end: pendingTimeline.tracks.video[0].srcOut || null,
        };
        // Apply speed
        project.recipe.speed = pendingTimeline.tracks.video[0].speed || 1;
      }
      // Bridge export settings
      if (pendingTimeline.export) {
        project.recipe.aspectRatio = pendingTimeline.export.aspectRatio as any;
        project.recipe.cropMode = pendingTimeline.export.cropMode as any;
        project.recipe.colorPreset = pendingTimeline.export.colorPreset as any;
      }
      // Bridge overlays
      const bridgedOverlays: any[] = [];
      for (const ov of pendingTimeline.tracks.overlays) {
        if (ov.type === "logo") {
          bridgedOverlays.push({
            type: "logo",
            asset: ov.content,
            position: (ov.position || "top-right") as any,
            widthPercent: ov.style?.widthPercent ?? 8,
            key: ov.style?.key ?? "none",
          });
          // Also set project.assets.logo
          if (!project.assets.logo) project.assets.logo = ov.content;
        } else if (ov.type === "text") {
          bridgedOverlays.push({
            type: "text",
            text: ov.content,
            position: (ov.position || "bottom-center") as any,
            style: ov.style?.style || "bold-clean",
          });
        }
      }
      if (bridgedOverlays.length > 0) {
        project.recipe.overlays = bridgedOverlays;
      }
      // Save bridged project
      project = await writeProjectToWorkspace(ws, project);
      setProject(project as EditorProjectV2);
      const kind = args?.kind === "preview" ? "preview" : "final";
      const job = enqueueRender(ws, project, kind);
      const next = await readProjectFromWorkspace(ws, project.projectId);
      setProject(next as EditorProjectV2);
      return { message: `${kind} render started.`, project: next, job };
    },
    get_render_status: async () => {
      const project = getProject();
      const latest = project.renders[0];
      if (!latest) return { message: "No renders yet." };
      const live = jobs.get(latest.jobId);
      return { message: `${latest.kind}: ${live?.status ?? latest.status} · ${live?.progress ?? latest.progress}% — ${live?.message ?? latest.message}` };
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
        const ai = createGeminiClient();
        const resp: any = await ai.models.generateContent({
          model: (process.env.EDITOR_AGENT_MODEL || "gemini-3.1-pro-preview").trim(),
          contents: [{ role: "user", parts: [
            { text: 'Look at this logo. Reply with ONLY one word: "transparent", "white", "black", or "none". No punctuation.' },
            { inlineData: { mimeType: mime, data: bytes.toString("base64") } },
          ]}],
          config: { maxOutputTokens: 16, thinkingConfig: { thinkingLevel: "LOW" as any } },
        });
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
  };
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
  try {
    const projectId = routeParam(req.params.projectId, "projectId");
    const userText = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!userText) { bad(res, 400, "message required"); return; }

    const ws = getWorkspace(req);
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
    const send = (event: any) => sse(res, event);
    const heartbeat = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 8000);
    let closed = false;
    res.on("close", () => { closed = true; clearInterval(heartbeat); });

    send({ type: "run_start", runId: randomUUID() });
    send({ type: "project", project });

    const history = await readChat(req, projectId);
    const userMessage: ChatMessage = { id: randomUUID(), role: "user", content: userText, createdAt: Date.now() };
    history.push(userMessage);
    send({ type: "user_message", message: userMessage });

    const assistantMessage: ChatMessage = { id: randomUUID(), role: "assistant", content: "", createdAt: Date.now() };

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
      await writeChat(ws, projectId, history);
      clearInterval(heartbeat);
      res.end();
      return;
    }

    const ai = createGeminiClient();
    const model = (process.env.EDITOR_AGENT_MODEL || "gemini-3.1-pro-preview").trim();
    const thinkingBudget = process.env.EDITOR_AGENT_THINKING_BUDGET || "MEDIUM";

    const projectContext = `Current project:\n- sourceVideo: ${project.sourceVideo ?? "(none)"}\n- assets.logo: ${project.assets.logo ?? "(none)"}\n- assets.intro: ${project.assets.intro ?? "(none)"}\n- assets.outro: ${project.assets.outro ?? "(none)"}\n- recipe: ${snapshotRecipeSummary(project)}`;

    const contents: any[] = history.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || (m.tool ? `(tool ${m.tool.name})` : "") }],
    }));
    contents.unshift({ role: "user", parts: [{ text: projectContext }] });

    let iterations = 0;
    const maxIterations = 6;
    let finalText = "";

    while (iterations < maxIterations && !closed) {
      iterations += 1;
      send({ type: "thinking", iteration: iterations, total: maxIterations });
      const stream: any = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: AGENT_SYSTEM_PROMPT_V2,
          tools: [{ functionDeclarations: AGENT_TOOL_DECLARATIONS_V2 as any }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: thinkingBudget as any },
        },
      });

      const aggregatedParts: any[] = [];
      const fnCalls: any[] = [];
      let text = "";
      try {
        for await (const chunk of stream) {
          const cParts: any[] = chunk?.candidates?.[0]?.content?.parts || [];
          for (const part of cParts) {
            aggregatedParts.push(part);
            if (part.functionCall) fnCalls.push(part.functionCall);
            if (typeof part.text === "string" && part.text) {
              text += part.text;
              send({ type: "text", content: part.text });
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "[video-editor] stream chunk failed");
      }

      contents.push({ role: "model", parts: aggregatedParts });

      // Accumulate streamed text across iterations so the persisted
      // assistant message matches what the user actually saw.
      if (text) finalText = (finalText ? `${finalText}\n` : "") + text;

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
      contents.push({ role: "user", parts: responseParts });
    }

    if (!finalText) finalText = `Updated. Recipe: ${snapshotRecipeSummary(project)}.`;
    assistantMessage.content = finalText;
    history.push(assistantMessage);
    await writeChat(ws, projectId, history);
    send({ type: "assistant_message", message: assistantMessage });
    send({ type: "done" });
    clearInterval(heartbeat);
    res.end();
  } catch (err) {
    logger.error({ err }, "[video-editor] chat failed");
    try {
      sse(res, { type: "error", message: err instanceof Error ? err.message : "chat failed" });
      sse(res, { type: "done" });
      res.end();
    } catch {
      // already closed
    }
  }
});

// ─── Server-side thumbnail for any render output ──────────────────────────────
const thumbCache = new Map<string, { buffer: Buffer; mtime: number }>();
const THUMB_CACHE_TTL_MS = 30 * 60 * 1000;

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
    const cached = thumbCache.get(cacheKey);
    if (cached && Date.now() - cached.mtime < THUMB_CACHE_TTL_MS) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=1800");
      return res.end(cached.buffer);
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
      thumbCache.set(cacheKey, { buffer, mtime: Date.now() });
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
