import { Router, type Request, type Response, type NextFunction } from "express";
import { setupSse } from "../lib/sse";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "fs";
import { join, basename, dirname } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { GoogleGenAI, Modality } from "@google/genai";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import multer from "multer";
import { AssemblyAI } from "assemblyai";
import ffmpegStatic from "ffmpeg-static";
import {
  cancelYoutubeQueueJob,
  getYoutubeQueueJobStatus,
  isYoutubeQueueEnabledFor,
  isYoutubeQueuePrimaryEnabledFor,
  submitYoutubeQueuePrimaryJob,
} from "../lib/youtube-queue";
import {
  deleteS3Object,
  getS3SignedDownloadUrl,
  isS3StorageEnabled,
  readTextFromS3,
  uploadFileToS3,
} from "../lib/s3-storage";
import { logger } from "../lib/logger";
import { createGeminiClient, isGeminiConfigured, isVertexGeminiEnabled } from "../lib/gemini-client";

const router: Router = Router();
const BHAGWAT_AUTH_COOKIE_NAME = "bhagwat_auth";
const BHAGWAT_AUTH_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const BHAGWAT_QUEUE_POLL_MS = 2000;

function isBhagwatAuthenticated(req: Request): boolean {
  return req.signedCookies?.[BHAGWAT_AUTH_COOKIE_NAME] === "1";
}

const isBhagwatAnalyzeQueuePrimaryEnabled = (): boolean =>
  isYoutubeQueuePrimaryEnabledFor("bhagwat-analyze");
const isBhagwatAnalyzeQueueEnabled = (): boolean =>
  isYoutubeQueueEnabledFor("bhagwat-analyze");
const isBhagwatRenderQueuePrimaryEnabled = (): boolean =>
  isYoutubeQueuePrimaryEnabledFor("bhagwat-render");
const isBhagwatRenderQueueEnabled = (): boolean =>
  isYoutubeQueueEnabledFor("bhagwat-render");

// Make yt-dlp (installed via uv sync in Replit, or system pip3 in Docker)
// visible to Python without overriding the system PATH in environments where
// .pythonlibs does not exist (e.g. the Docker production container).
const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();

function buildPythonEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const pythonLibsBin = join(workspaceRoot, ".pythonlibs", "bin");
  const pythonLibsLib = join(workspaceRoot, ".pythonlibs", "lib");

  // Only inject Replit-specific paths when they actually exist on disk.
  if (!existsSync(pythonLibsBin)) {
    return { ...process.env };
  }

  let sitePackages = join(pythonLibsLib, "python3.11", "site-packages");
  try {
    const entries = readdirSync(pythonLibsLib);
    const pyDir = entries.find((e) => /^python3\.\d+$/.test(e));
    if (pyDir) sitePackages = join(pythonLibsLib, pyDir, "site-packages");
  } catch {}

  return {
    ...process.env,
    PATH: `${pythonLibsBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONPATH: sitePackages,
  };
}

const PYTHON_ENV = buildPythonEnv(_workspaceRoot);
const PYTHON_BIN =
  process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
// Standalone yt-dlp binary path. When set (Lambda Docker, dev override) we use
// the binary directly instead of `python3 -m yt_dlp` (which requires the
// yt_dlp module to be importable). Mirrors youtube.ts:89-95.
const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  (process.platform === "win32"
    ? ""
    : ["/usr/local/bin/yt-dlp", "/opt/bin/yt-dlp", "/var/task/bin/yt-dlp"].find(
        (candidate) => existsSync(candidate),
      ) ?? "");

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
const BHAGWAT_RENDERED_DIR = join(DOWNLOAD_DIR, "bhagwat_rendered");
const BHAGWAT_TMP_DIR = join(DOWNLOAD_DIR, "bhagwat_tmp");
const BHAGWAT_UPLOADS_DIR = join(DOWNLOAD_DIR, "bhagwat_uploads");

for (const d of [BHAGWAT_RENDERED_DIR, BHAGWAT_TMP_DIR, BHAGWAT_UPLOADS_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// Disk-based cleanup: delete files/dirs older than 2 hours regardless of
// in-memory state. This handles orphaned files left after server restarts.
const DISK_CLEANUP_AGE_MS = 2 * 60 * 60 * 1000;
function cleanupBhagwatDirs() {
  const cutoff = Date.now() - DISK_CLEANUP_AGE_MS;
  for (const dir of [BHAGWAT_RENDERED_DIR, BHAGWAT_UPLOADS_DIR]) {
    try {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        try {
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        } catch {}
      }
    } catch {}
  }
  // bhagwat_tmp can contain subdirectories — delete any that are old
  try {
    for (const entry of readdirSync(BHAGWAT_TMP_DIR)) {
      const p = join(BHAGWAT_TMP_DIR, entry);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) {
          if (st.isDirectory()) {
            for (const f of readdirSync(p)) {
              try {
                unlinkSync(join(p, f));
              } catch {}
            }
            try {
              rmdirSync(p);
            } catch {}
          } else {
            unlinkSync(p);
          }
        }
      } catch {}
    }
  } catch {}
}
// Run on startup to clear any orphans left by a previous crashed/restarted server
cleanupBhagwatDirs();
// Then run every 30 minutes
setInterval(cleanupBhagwatDirs, 30 * 60 * 1000);

// ── Multer — audio file uploads ───────────────────────────────────────────────
const audioUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, BHAGWAT_UPLOADS_DIR),
  filename: (_req, _file, cb) => {
    const ext =
      _file.originalname.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ".mp3";
    cb(null, `${randomUUID()}${ext}`);
  },
});
const audioUpload = multer({
  storage: audioUploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB (AssemblyAI max)
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(mp3|wav|m4a|mp4|ogg|webm|flac|aac|opus|wma|amr)$/i.test(
      file.originalname,
    );
    const okMime =
      file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/");
    okExt || okMime
      ? cb(null, true)
      : cb(new Error("Only audio/video files are supported"));
  },
});

// ── Uploaded audio store ──────────────────────────────────────────────────────
export interface UploadedAudio {
  path: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  s3Key?: string;
  durationSec: number; // filled after AssemblyAI transcription
  createdAt: number;
}
const uploadedAudios = new Map<string, UploadedAudio>();

export function createBhagwatUploadedAudioState(
  audioId: string,
  audio: UploadedAudio,
): UploadedAudio {
  uploadedAudios.set(audioId, audio);
  return audio;
}

export function getBhagwatUploadedAudioState(
  audioId: string,
): UploadedAudio | undefined {
  return uploadedAudios.get(audioId);
}

export function deleteBhagwatUploadedAudioState(audioId: string): void {
  uploadedAudios.delete(audioId);
}

export async function ensureBhagwatUploadedAudioS3Key(
  audioId: string,
  audio: UploadedAudio,
): Promise<string> {
  if (audio.s3Key) return audio.s3Key;
  if (!isS3StorageEnabled()) {
    throw new Error("S3 storage is not configured for Bhagwat uploaded audio");
  }
  const uploaded = await uploadFileToS3({
    localPath: audio.path,
    jobId: audioId,
    namespace: "bhagwat/uploads",
    filename: audio.originalName,
    contentType: audio.mimeType || "application/octet-stream",
  });
  audio.s3Key = uploaded.key;
  uploadedAudios.set(audioId, audio);
  return uploaded.key;
}

router.use("/bhagwat", (req: Request, res: Response, next: NextFunction) => {
  const normalizedPath = req.path.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/auth")) {
    next();
    return;
  }
  if (isBhagwatAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Bhagwat authentication required" });
});

function pickFirst(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ── Path-traversal & CLI-flag injection guards ────────────────────────────────
// All Bhagwat job/audio/upload IDs are server-generated UUIDs — clients must
// only echo them back. Reject anything that contains path separators, dots,
// nulls, or could otherwise escape our temp directories.
const SAFE_BHAGWAT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function isSafeBhagwatId(value: unknown): value is string {
  return typeof value === "string" && SAFE_BHAGWAT_ID_RE.test(value);
}
function pickSafeBhagwatId(value: string | string[] | undefined): string | null {
  const v = pickFirst(value);
  return isSafeBhagwatId(v) ? v : null;
}

// Prefix file-system arguments passed to ffmpeg/yt-dlp so a leading "-" in
// the path is never interpreted as a CLI flag (defence-in-depth — our temp
// filenames are UUIDs, but uploaded filenames could in theory be hostile).
function safeFsArg(p: string): string {
  if (!p) return p;
  if (p.startsWith("-")) return `./${p}`;
  return p;
}

// Sweep old uploads after 2 hours
setInterval(
  () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, audio] of uploadedAudios.entries()) {
      if (audio.createdAt < cutoff) {
        try {
          unlinkSync(audio.path);
        } catch {}
        uploadedAudios.delete(id);
      }
    }
  },
  30 * 60 * 1000,
);

// ── Timeline segment — AI decides everything per segment ──────────────────────
export interface TimelineSegment {
  startSec: number;
  endSec: number;
  isBhajan: boolean;
  imageChangeEvery: number; // seconds between image changes within this segment — AI decides
  description: string; // brief human-readable label shown in UI
  imagePrompt: string; // specific Gemini image-gen prompt for this exact story moment
}

// Use Replit's built-in GOOGLE_API_KEY as fallback when GEMINI_API_KEY is not set
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
}
// Remove GOOGLE_API_KEY so the @google/generative-ai library doesn't log
// "Both GOOGLE_API_KEY and GEMINI_API_KEY are set" warnings
delete process.env.GOOGLE_API_KEY;

// ── Gemini image generation ───────────────────────────────────────────────────
// Priority: Replit AI integration (gemini-2.5-flash-image) → own GEMINI_API_KEY (gemini-3.1-flash-image-preview)

const IMAGE_PROMPT_PREFIX = `Create a UHD, cinematic, high-quality PHOTOREALISTIC image suitable for video content with a spiritual and reverential tone.
The image should visually represent: `;

const IMAGE_PROMPT_SUFFIX = `

CRITICAL STYLE REQUIREMENTS (override any conflicting instructions):
- MUST be photorealistic - no abstract, digital, animated, or illustrated styles
- Use realistic lighting, natural depth of field, strong composition, and emotionally appropriate atmosphere
- Style: Professional, cinematic realism, documentary-grade, clean and context-aware
- Must look authentic, timeless, and suitable for high-quality B-roll usage
- Consistent with other images in the same video project
No subtitles, logos, watermarks, UI elements`;

const FALLBACK_PALETTES = [
  { bg: "#1b1230", panel: "#6d28d9", line: "#f59e0b" },
  { bg: "#101827", panel: "#0f766e", line: "#f97316" },
  { bg: "#21130f", panel: "#b45309", line: "#facc15" },
  { bg: "#0f172a", panel: "#2563eb", line: "#ec4899" },
  { bg: "#1f1b0d", panel: "#65a30d", line: "#f97316" },
] as const;

function hashText(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function buildFallbackSceneTitle(segment: TimelineSegment): string {
  const base =
    segment.description?.trim() ||
    segment.imagePrompt?.trim() ||
    (segment.isBhajan ? "Devotional Bhajan" : "Bhagwat Katha");
  const cleaned = base
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
  return cleaned.slice(0, 56) || (segment.isBhajan ? "Devotional Bhajan" : "Bhagwat Scene");
}

function wrapText(text: string, maxChars = 36, maxLines = 3): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || current.length === 0) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  let joined = lines.join("\n");
  if (joined.length < text.length) joined += "…";
  return joined;
}

function inferFallbackSubtitle(segment: TimelineSegment): string {
  const mood = segment.isBhajan ? "Bhajan visual" : "Katha visual";
  const promptHint = segment.imagePrompt
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return wrapText(promptHint || mood, 44, 3);
}

function sanitizeTextForDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

async function createFallbackSceneCard(
  segment: TimelineSegment,
  outputPath: string,
  variantSeed: string,
): Promise<void> {
  const palette = FALLBACK_PALETTES[hashText(variantSeed) % FALLBACK_PALETTES.length];
  const title = sanitizeTextForDrawtext(buildFallbackSceneTitle(segment));
  const subtitle = sanitizeTextForDrawtext(inferFallbackSubtitle(segment));
  const badge = sanitizeTextForDrawtext(segment.isBhajan ? "BHAJAN" : "KATHA");
  const titleFont = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const bodyFont = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

  await new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-f",
      "lavfi",
      "-i",
      `color=c=${palette.bg}:s=1920x1080`,
      "-frames:v",
      "1",
      "-vf",
      [
        `drawbox=x=0:y=0:w=iw:h=ih:color=${palette.bg}:t=fill`,
        `drawbox=x=70:y=70:w=iw-140:h=ih-140:color=${palette.panel}@0.14:t=fill`,
        `drawbox=x=70:y=70:w=iw-140:h=6:color=${palette.line}@0.92:t=fill`,
        `drawbox=x=70:y=ih-210:w=iw-140:h=140:color=black@0.28:t=fill`,
        `drawbox=x=120:y=130:w=260:h=70:color=black@0.22:t=fill`,
        `drawtext=fontfile=${titleFont}:text='${badge}':fontcolor=white@0.88:fontsize=34:x=150:y=150`,
        `drawtext=fontfile=${titleFont}:text='${title}':fontcolor=white:fontsize=82:x=(w-text_w)/2:y=360:borderw=2:bordercolor=black@0.28:line_spacing=10`,
        `drawtext=fontfile=${bodyFont}:text='${subtitle}':fontcolor=white@0.84:fontsize=34:x=(w-text_w)/2:y=620:borderw=1:bordercolor=black@0.18:line_spacing=12`,
      ].join(","),
      "-y",
      outputPath,
    ]);
    let stderr = "";
    ff.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    ff.on("close", (code) => {
      if (code === 0 && existsSync(outputPath)) resolve();
      else reject(new Error(`Fallback visual generation failed (${code}): ${stderr.slice(-260)}`));
    });
    ff.on("error", reject);
  });
}

function shouldDisableRemoteImageGeneration(errMsg: string): boolean {
  return /resource_exhausted|quota exceeded|limit:\s*0|not available|rate.?limit|preview-image|no image data/i.test(
    errMsg,
  );
}

function extractImageBytes(response: any): Buffer {
  const candidate = response.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no candidate");
  const imagePart = candidate.content?.parts?.find(
    (part: any) => part.inlineData?.data,
  );
  if (!imagePart?.inlineData?.data)
    throw new Error("Gemini returned no image data");
  return Buffer.from(imagePart.inlineData.data, "base64");
}

const IMAGE_GEN_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS ?? 20_000);

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return (await Promise.race([promise, timeoutPromise])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateImageViaReplit(prompt: string, model = "gemini-2.5-flash-image"): Promise<Buffer> {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Replit AI integration not configured");

  const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });
  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: IMAGE_PROMPT_PREFIX + prompt + IMAGE_PROMPT_SUFFIX }] }],
    config: { responseModalities: [Modality.IMAGE] },
  });
  return extractImageBytes(response);
}

async function generateImageViaOwnKey(prompt: string): Promise<Buffer> {
  const keys = getPersonalGeminiApiKeys();
  if (keys.length === 0)
    throw new Error("GEMINI_API_KEY is not configured");

  let lastErr: unknown;
  for (let i = 0; i < keys.length; i++) {
    try {
      const client = isVertexGeminiEnabled() ? createGeminiClient() : new GoogleGenAI({ apiKey: keys[i] });
      const response = await client.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [{ role: "user", parts: [{ text: IMAGE_PROMPT_PREFIX + prompt + IMAGE_PROMPT_SUFFIX }] }],
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
          imageConfig: { aspectRatio: "16:9", imageSize: "2K" } as any,
        },
      });
      return extractImageBytes(response);
    } catch (err) {
      lastErr = err;
      console.warn(
        `[bhagwat/img] own Gemini image key ${i + 1} failed, trying next key:`,
        err instanceof Error ? err.message : String(err ?? ""),
      );
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Gemini image generation failed");
}

function isAnyAIConfigured(): boolean {
  return (
    !!(process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY) ||
    isGeminiConfigured() ||
    getPersonalGeminiApiKeys().length > 0
  );
}

async function generateImage(prompt: string, outputPath: string): Promise<void> {
  const replitReady =
    !!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL &&
    !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  // 1. Try Replit integration: fast flash model
  if (replitReady) {
    try {
      const bytes = await withTimeout(
        generateImageViaReplit(prompt, "gemini-2.5-flash-image"),
        IMAGE_GEN_TIMEOUT_MS,
        "Replit flash image generation",
      );
      writeFileSync(outputPath, bytes);
      return;
    } catch (err) {
      console.warn(
        "[bhagwat/img] Replit flash image gen failed, falling back to own key:",
        (err as Error).message,
      );
    }
  }

  // 2. Final fallback: own GEMINI_API_KEY
  const bytes = await withTimeout(
    generateImageViaOwnKey(prompt),
    IMAGE_GEN_TIMEOUT_MS,
    "Gemini image generation",
  );
  writeFileSync(outputPath, bytes);
}

// ── Gemini text generation ─────────────────────────────────────────────────────
// Replit integration: gemini-2.5-flash -> own key flash fallback
const OWN_KEY_TEXT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;
const BHAGWAT_REVIEW_TIMEOUT_MS = Number(
  process.env.BHAGWAT_REVIEW_TIMEOUT_MS ?? 90_000,
);

function getPersonalGeminiApiKeys(): string[] {
  if (isVertexGeminiEnabled()) return ["__vertex__"];
  const keys: string[] = [];
  const first = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (first?.trim()) keys.push(first.trim());
  for (let index = 2; index <= 10; index += 1) {
    const envName = `GEMINI_API_KEY_${index}` as keyof NodeJS.ProcessEnv;
    const value = process.env[envName];
    if (value?.trim()) keys.push(value.trim());
  }
  return Array.from(new Set(keys));
}

function shouldRetryWithLighterGeminiModel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /resource_exhausted|quota|429|503|unavailable|overloaded|high demand|rate.?limit|api[_ ]?key|expired|invalid/i.test(msg);
}

async function ownKeyGeminiContent(
  systemInstruction: string,
  userContent: string,
  label: string,
): Promise<string> {
  const replitBase = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const replitKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const keys = getPersonalGeminiApiKeys();
  if (keys.length === 0 && !(replitBase && replitKey))
    throw new Error("GEMINI_API_KEY is not configured - add it in Secrets");
  if (keys.length === 0 && replitBase && replitKey) {
    const client = new GoogleGenAI({ apiKey: replitKey, httpOptions: { apiVersion: "", baseUrl: replitBase } });
    const result = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      ...(systemInstruction && { config: { systemInstruction } }),
    });
    return (result as any).text ?? "";
  }

  let lastErr: unknown;
  for (let i = 0; i < OWN_KEY_TEXT_MODELS.length; i++) {
    const modelName = OWN_KEY_TEXT_MODELS[i];
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      try {
        const client = isVertexGeminiEnabled() ? createGeminiClient() : new GoogleGenAI({ apiKey: keys[keyIndex] });
        const result = await client.models.generateContent({
          model: modelName,
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          ...(systemInstruction && { config: { systemInstruction } }),
        });
        return (result as any).text ?? "";
      } catch (err) {
        lastErr = err;
        const canRetry =
          keyIndex < keys.length - 1 ||
          (i < OWN_KEY_TEXT_MODELS.length - 1 &&
            shouldRetryWithLighterGeminiModel(err));
        console.warn(
          canRetry
            ? "[bhagwat/text] " + label + " key " + (keyIndex + 1) + " (" + modelName + ") failed, trying next Gemini key/model:"
            : "[bhagwat/text] " + label + " key " + (keyIndex + 1) + " (" + modelName + ") failed:",
          err instanceof Error ? err.message : String(err ?? ""),
        );
        if (!canRetry) throw err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(label + " failed");
}

async function ownKeyGeminiStream(
  systemInstruction: string,
  userContent: string,
  onChunk: (text: string) => void,
  label: string,
): Promise<string> {
  const replitBase = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const replitKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const keys = getPersonalGeminiApiKeys();
  if (keys.length === 0 && !(replitBase && replitKey))
    throw new Error("GEMINI_API_KEY is not configured - add it in Secrets");
  if (keys.length === 0 && replitBase && replitKey) {
    const client = new GoogleGenAI({ apiKey: replitKey, httpOptions: { apiVersion: "", baseUrl: replitBase } });
    const stream = client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      ...(systemInstruction && { config: { systemInstruction } }),
    });
    let fullText = "";
    for await (const chunk of await stream) {
      const text: string = (chunk as any).text ?? "";
      if (text) { fullText += text; onChunk(text); }
    }
    return fullText;
  }

  let lastErr: unknown;
  for (let i = 0; i < OWN_KEY_TEXT_MODELS.length; i++) {
    const modelName = OWN_KEY_TEXT_MODELS[i];
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      let fullText = "";
      try {
        const client = isVertexGeminiEnabled() ? createGeminiClient() : new GoogleGenAI({ apiKey: keys[keyIndex] });
        const stream = client.models.generateContentStream({
          model: modelName,
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          ...(systemInstruction && { config: { systemInstruction } }),
        });
        for await (const chunk of await stream) {
          const text: string = (chunk as any).text ?? "";
          if (text) {
            fullText += text;
            onChunk(text);
          }
        }
        return fullText;
      } catch (err) {
        lastErr = err;
        const canRetry =
          fullText.length === 0 &&
          (keyIndex < keys.length - 1 ||
            (i < OWN_KEY_TEXT_MODELS.length - 1 &&
              shouldRetryWithLighterGeminiModel(err)));
        console.warn(
          canRetry
            ? "[bhagwat/text] " + label + " stream key " + (keyIndex + 1) + " (" + modelName + ") failed before output, trying next Gemini key/model:"
            : "[bhagwat/text] " + label + " stream key " + (keyIndex + 1) + " (" + modelName + ") failed:",
          err instanceof Error ? err.message : String(err ?? ""),
        );
        if (!canRetry) throw err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(label + " failed");
}

async function geminiProContent(
  systemInstruction: string,
  userContent: string,
): Promise<string> {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  if (baseUrl && apiKey) {
    try {
      const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });
      const result = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        ...(systemInstruction && { config: { systemInstruction } }),
      });
      return (result as any).text ?? "";
    } catch (err) {
      console.warn("[bhagwat/text] Replit gemini-2.5-flash failed, falling back to own key:", (err as Error).message);
    }
  }

  return ownKeyGeminiContent(systemInstruction, userContent, "Own-key Bhagwat text generation");
}

async function geminiProStream(
  systemInstruction: string,
  userContent: string,
  onChunk: (text: string) => void,
): Promise<string> {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  let fullText = "";

  if (baseUrl && apiKey) {
    try {
      const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });
      const stream = client.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        ...(systemInstruction && { config: { systemInstruction } }),
      });
      for await (const chunk of await stream) {
        const text: string = (chunk as any).text ?? "";
        if (text) { fullText += text; onChunk(text); }
      }
      return fullText;
    } catch (err) {
      console.warn("[bhagwat/text] Replit gemini-2.5-flash stream failed, falling back to own key:", (err as Error).message);
      fullText = "";
    }
  }

  return ownKeyGeminiStream(
    systemInstruction,
    userContent,
    onChunk,
    "Own-key Bhagwat text generation",
  );
}

// Generate images for all segments — 1 per segment
async function generateAllSegmentImages(
  segments: TimelineSegment[],
  imgDir: string,
  onProgress: (done: number, total: number, msg: string) => void,
): Promise<string[][]> {
  // Build task list: each task is one image generation
  interface Task {
    segIdx: number;
    imgIdx: number;
    prompt: string;
    path: string;
  }
  const tasks: Task[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDur = seg.endSec - seg.startSec;
    // Honour imageChangeEvery: generate one image per interval, capped at 6
    // so a long gap-filler segment doesn't spawn dozens of identical images.
    const count = Math.min(
      6,
      Math.max(1, Math.round(segDur / Math.max(1, seg.imageChangeEvery))),
    );
    for (let j = 0; j < count; j++) {
      tasks.push({
        segIdx: i,
        imgIdx: j,
        prompt: seg.imagePrompt,
        path: join(imgDir, `seg_${i}_${j}.png`),
      });
    }
  }

  // Result: imagePaths[segIdx] = array of file paths
  const imagePaths: string[][] = segments.map(() => []);
  let done = 0;
  const total = tasks.length;
  let remoteImageGenerationDisabled = false;

  // Process with concurrency = 4
  const CONCURRENCY = 4;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        if (remoteImageGenerationDisabled) {
          await createFallbackSceneCard(
            segments[task.segIdx],
            task.path,
            `${task.segIdx}:${task.imgIdx}:${task.prompt}`,
          );
          imagePaths[task.segIdx].push(task.path);
          done++;
          onProgress(done, total, `${segments[task.segIdx].description} (fallback visual)`);
          return;
        }
        try {
          await generateImage(task.prompt, task.path);
          imagePaths[task.segIdx].push(task.path);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(
            `[bhagwat/render] Image gen failed (seg ${task.segIdx}/${task.imgIdx}):`,
            errMsg,
          );
          // If the primary attempt timed out, skip fallback to avoid multi-minute hangs.
          if (/timed out/i.test(errMsg)) {
            await createFallbackSceneCard(
              segments[task.segIdx],
              task.path,
              `${task.segIdx}:${task.imgIdx}:${task.prompt}:timeout`,
            );
            imagePaths[task.segIdx].push(task.path);
            done++;
            onProgress(done, total, `${segments[task.segIdx].description} (fallback visual)`);
            return;
          }
          if (shouldDisableRemoteImageGeneration(errMsg)) {
            remoteImageGenerationDisabled = true;
          }
          // Retry with a simpler fallback prompt
          const fallback = `${task.prompt}. MUST be photorealistic — no abstract, digital, animated, or illustrated styles`;
          try {
            await generateImage(fallback, task.path);
            imagePaths[task.segIdx].push(task.path);
          } catch (err2) {
            const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
            console.error(
              `[bhagwat/render] Fallback image gen also failed (seg ${task.segIdx}/${task.imgIdx}):`,
              errMsg2,
            );
            if (shouldDisableRemoteImageGeneration(errMsg2)) {
              remoteImageGenerationDisabled = true;
            }
            await createFallbackSceneCard(
              segments[task.segIdx],
              task.path,
              `${task.segIdx}:${task.imgIdx}:${task.prompt}:fallback`,
            );
            imagePaths[task.segIdx].push(task.path);
          }
        }
        done++;
        onProgress(done, total, segments[task.segIdx].description);
      }),
    );
  }

  // Fill any empty pools with a neighbor's images so concat never has gaps
  for (let i = 0; i < imagePaths.length; i++) {
    if (imagePaths[i].length === 0) {
      // Find nearest segment with images
      for (let d = 1; d < imagePaths.length; d++) {
        if (i - d >= 0 && imagePaths[i - d].length > 0) {
          imagePaths[i] = imagePaths[i - d];
          break;
        }
        if (i + d < imagePaths.length && imagePaths[i + d].length > 0) {
          imagePaths[i] = imagePaths[i + d];
          break;
        }
      }
    }
  }

  return imagePaths;
}

// ── yt-dlp configuration (mirrors youtube.ts, kept in sync) ──────────────────
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";
const YTDLP_PO_TOKEN = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const HAS_DYNAMIC_POT_PROVIDER = !!YTDLP_POT_PROVIDER_URL;
const HAS_STATIC_PO_TOKEN = !!(YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA);
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ?? join(_workspaceRoot, ".yt-cookies.txt");
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";

// Convert exported browser-extension cookies (JSON list/object) into Netscape
// cookie format that yt-dlp accepts. Mirrors youtube.ts's helper.
type ExportedBrowserCookie = {
  domain?: unknown;
  hostOnly?: unknown;
  path?: unknown;
  secure?: unknown;
  session?: unknown;
  expirationDate?: unknown;
  name?: unknown;
  value?: unknown;
};
function bhagwatCookiesToNetscape(cookieList: ExportedBrowserCookie[]): string | null {
  const lines: string[] = [];
  for (const c of cookieList) {
    const domainRaw = typeof c.domain === "string" ? c.domain.trim() : "";
    const nameRaw = typeof c.name === "string" ? c.name.trim() : "";
    const valueRaw = typeof c.value === "string" ? c.value : "";
    if (!domainRaw || !nameRaw) continue;
    const dl = domainRaw.toLowerCase();
    const keep =
      dl.includes("youtube.com") ||
      dl.includes("youtu.be") ||
      dl.includes("google.com") ||
      dl.includes("googlevideo.com");
    if (!keep) continue;
    const path = typeof c.path === "string" && c.path.trim() ? c.path.trim() : "/";
    const includeSubdomains =
      c.hostOnly === true || !domainRaw.startsWith(".") ? "FALSE" : "TRUE";
    const secure = c.secure === true ? "TRUE" : "FALSE";
    const isSession = c.session === true;
    const expiry =
      !isSession && typeof c.expirationDate === "number" && Number.isFinite(c.expirationDate)
        ? String(Math.floor(c.expirationDate))
        : "0";
    lines.push(
      `${domainRaw}\t${includeSubdomains}\t${path}\t${secure}\t${expiry}\t${nameRaw}\t${valueRaw}`,
    );
  }
  if (lines.length === 0) return null;
  return `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
}

function decodeBhagwatCookiesFromBase64(base64Value: string): string | null {
  try {
    const decoded = Buffer.from(base64Value, "base64").toString("utf8").trim();
    if (!decoded) return null;
    if (
      decoded.startsWith("# Netscape HTTP Cookie File") ||
      decoded.startsWith(".youtube.com") ||
      (decoded.includes("\t") && !decoded.startsWith("{") && !decoded.startsWith("["))
    ) {
      return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
    }
    if (decoded.startsWith("{")) {
      const parsedObj = JSON.parse(decoded) as { cookies?: ExportedBrowserCookie[] };
      if (Array.isArray(parsedObj.cookies)) return bhagwatCookiesToNetscape(parsedObj.cookies);
    }
    if (decoded.startsWith("[")) {
      const parsedList = JSON.parse(decoded) as ExportedBrowserCookie[];
      if (Array.isArray(parsedList)) return bhagwatCookiesToNetscape(parsedList);
    }
  } catch (err) {
    logger.warn({ err }, "[bhagwat] Failed to decode cookie payload");
  }
  return null;
}

// Eagerly write any base64-env cookie blob to disk on startup (parity with youtube.ts).
const YTDLP_COOKIES_BASE64 = process.env.YTDLP_COOKIES_BASE64 ?? "";
if (YTDLP_COOKIES_BASE64) {
  const cookieContent = decodeBhagwatCookiesFromBase64(YTDLP_COOKIES_BASE64);
  if (cookieContent) {
    try {
      const cookieDir = dirname(YTDLP_COOKIES_FILE);
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      writeFileSync(YTDLP_COOKIES_FILE, cookieContent, "utf8");
      logger.info("[bhagwat] Loaded cookies from YTDLP_COOKIES_BASE64 env var");
    } catch (err) {
      logger.warn({ err }, "[bhagwat] Failed to write cookie file from env var");
    }
  } else {
    logger.warn("[bhagwat] YTDLP_COOKIES_BASE64 set but cookie payload could not be converted to Netscape format — skipping");
  }
}

// Lazy S3 cookie loader — fetches s3://<bucket>/<YTDLP_COOKIES_S3_KEY> the
// first time a yt-dlp call needs cookies. Cached in-process; one inflight
// promise prevents thundering herd on Lambda cold start. Mirrors youtube.ts.
let ensureBhagwatCookiesPromise: Promise<void> | null = null;
async function ensureBhagwatYtdlpCookiesLoaded(): Promise<void> {
  if (!YTDLP_COOKIES_S3_KEY) return;
  // If we already have a valid file on disk, skip the S3 round-trip.
  if (existsSync(YTDLP_COOKIES_FILE)) {
    try {
      const stat = statSync(YTDLP_COOKIES_FILE);
      const header = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
      if (
        stat.isFile() &&
        stat.size >= 24 &&
        (header.startsWith("# Netscape HTTP Cookie File") || header.startsWith(".youtube.com"))
      ) {
        return;
      }
    } catch {}
  }
  if (!ensureBhagwatCookiesPromise) {
    ensureBhagwatCookiesPromise = (async () => {
      try {
        const encoded = (await readTextFromS3(YTDLP_COOKIES_S3_KEY)).trim();
        if (!encoded) return;
        const cookieContent = decodeBhagwatCookiesFromBase64(encoded);
        if (!cookieContent) {
          logger.warn(
            { key: YTDLP_COOKIES_S3_KEY },
            "[bhagwat] S3 cookie payload could not be converted to Netscape format",
          );
          return;
        }
        const cookieDir = dirname(YTDLP_COOKIES_FILE);
        if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
        writeFileSync(YTDLP_COOKIES_FILE, cookieContent, "utf8");
        logger.info({ key: YTDLP_COOKIES_S3_KEY }, "[bhagwat] Loaded yt-dlp cookies from S3");
      } catch (err) {
        logger.warn({ err, key: YTDLP_COOKIES_S3_KEY }, "[bhagwat] Failed to load yt-dlp cookies from S3");
      }
    })().finally(() => {
      // Allow re-attempt on next call if it failed.
      ensureBhagwatCookiesPromise = null;
    });
  }
  await ensureBhagwatCookiesPromise;
}

function getBhagwatCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE) return [];
  try {
    if (!existsSync(YTDLP_COOKIES_FILE)) return [];
    const stat = statSync(YTDLP_COOKIES_FILE);
    if (!stat.isFile() || stat.size < 24) return [];
    const header = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (!header.startsWith("# Netscape HTTP Cookie File") && !header.startsWith(".youtube.com")) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch { return []; }
}

// Base args applied to every yt-dlp call in bhagwat routes.
const YTDLP_BASE_ARGS: string[] = [
  "--retries", "5",
  "--fragment-retries", "5",
  "--extractor-retries", "5",
  "--socket-timeout", "30",
  "--js-runtimes", "node",
  "--js-runtimes", "bun",
  "--remote-components", "ejs:github",
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "--sleep-requests", "1",
  "--sleep-interval", "2",
];

if (ffmpegStatic) YTDLP_BASE_ARGS.push("--ffmpeg-location", ffmpegStatic);
if (YTDLP_PROXY) YTDLP_BASE_ARGS.push("--proxy", YTDLP_PROXY);

if (HAS_DYNAMIC_POT_PROVIDER) {
  YTDLP_BASE_ARGS.push(
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`,
  );
}

function getDefaultBhagwatYoutubeExtractorArgs(): string[] {
  if (HAS_DYNAMIC_POT_PROVIDER) {
    return [
      "--extractor-args",
      "youtube:player_client=web,web_embedded,mweb",
    ];
  }
  if (HAS_STATIC_PO_TOKEN) {
    return [
      "--extractor-args",
      `youtube:player_client=web,web_embedded,mweb;po_token=web.gvs+${YTDLP_PO_TOKEN};visitor_data=${YTDLP_VISITOR_DATA}`,
    ];
  }
  return [
    "--extractor-args",
    "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless",
  ];
}

function getBhagwatYoutubeFallbacks(): string[][] {
  if (HAS_DYNAMIC_POT_PROVIDER || HAS_STATIC_PO_TOKEN) {
    return [
      ["--extractor-args", "youtube:player_client=web,web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=mweb,ios"],
      ["--extractor-args", "youtube:player_client=ios"],
      ["--extractor-args", "youtube:player_client=android_vr"],
    ];
  }
  return [
    ["--extractor-args", "youtube:player_client=tv_embedded,android_vr"],
    ["--extractor-args", "youtube:player_client=tv_embedded"],
    ["--extractor-args", "youtube:player_client=android_vr"],
    ["--extractor-args", "youtube:player_client=mweb"],
    ["--extractor-args", "youtube:player_client=ios"],
  ];
}

// Subtitle args (lighter — no fragment retries needed).
const YTDLP_SUBS_ARGS: string[] = [
  "--retries", "5",
  "--extractor-retries", "5",
  "--socket-timeout", "30",
  "--js-runtimes", "node",
  "--js-runtimes", "bun",
  "--remote-components", "ejs:github",
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

if (YTDLP_PROXY) YTDLP_SUBS_ARGS.push("--proxy", YTDLP_PROXY);
if (HAS_DYNAMIC_POT_PROVIDER) {
  YTDLP_SUBS_ARGS.push(
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`,
  );
}

// YouTube block detection — broad pattern to catch all YouTube error variants in 2025/2026.
function isBhagwatYtBlocked(msg: string): boolean {
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|sign.*in.*your age|age.*restrict|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|video.*unavailable.*country|precondition.*failed|http error 401|not made this video available|not available in your country|geo.*restrict|requested format is not available/i.test(msg);
}

// Fallback player clients ordered by reliability on AWS/datacenter IPs.
// tv_embedded (YouTube TV embedded player) is the least bot-checked on server IPs.
const YTDLP_CLOUD_FALLBACKS: string[][] = getBhagwatYoutubeFallbacks();

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
function runYtDlpOnce(baseArgs: string[], extraArgs: string[], callArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const command = YTDLP_BIN || PYTHON_BIN;
    const commandArgs = YTDLP_BIN
      ? [...baseArgs, ...extraArgs, ...callArgs]
      : ["-m", "yt_dlp", ...baseArgs, ...extraArgs, ...callArgs];
    const proc = spawn(command, commandArgs, { env: PYTHON_ENV });
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-1000) || `yt-dlp exited ${code}`)),
    );
  });
}

async function runYtDlp(args: string[]): Promise<string> {
  const maybeUrl = [...args].reverse().find((v) => /^https?:\/\//i.test(v));
  // Load cookies from S3 lazily on first use (Lambda cold start).
  await ensureBhagwatYtdlpCookiesLoaded();
  const cookieArgs = getBhagwatCookieArgs();
  const defaultYoutubeArgs = maybeUrl ? getDefaultBhagwatYoutubeExtractorArgs() : [];
  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);

  let lastErr: Error | null = null;
  const attempted = new Set<string>();

  for (const extra of attemptPlans) {
    const key = extra.join("\x01");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try { return await runYtDlpOnce(YTDLP_BASE_ARGS, extra, args); }
    catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp failed");
      if (!maybeUrl || !isBhagwatYtBlocked(lastErr.message)) throw lastErr;
    }
  }

  if (maybeUrl && lastErr) {
    for (const fallback of YTDLP_CLOUD_FALLBACKS) {
      const plans = cookieArgs.length ? [[...cookieArgs, ...fallback], fallback] : [fallback];
      for (const extra of plans) {
        const key = extra.join("\x01");
        if (attempted.has(key)) continue;
        attempted.add(key);
        try { return await runYtDlpOnce(YTDLP_BASE_ARGS, extra, args); }
        catch (err) { lastErr = err instanceof Error ? err : new Error("yt-dlp fallback failed"); }
      }
    }
  }

  throw lastErr ?? new Error("yt-dlp failed");
}

async function runYtDlpForSubs(args: string[]): Promise<string> {
  await ensureBhagwatYtdlpCookiesLoaded();
  const cookieArgs = getBhagwatCookieArgs();
  const defaultYoutubeArgs = getDefaultBhagwatYoutubeExtractorArgs();
  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);

  let lastErr: Error | null = null;
  const attempted = new Set<string>();

  for (const extra of attemptPlans) {
    const key = extra.join("\x01");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try { return await runYtDlpOnce(YTDLP_SUBS_ARGS, extra, args); }
    catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp subs failed");
      if (!isBhagwatYtBlocked(lastErr.message)) throw lastErr;
    }
  }

  for (const fallback of YTDLP_CLOUD_FALLBACKS.slice(0, 3)) {
    const plans = cookieArgs.length ? [[...cookieArgs, ...fallback], fallback] : [fallback];
    for (const extra of plans) {
      const key = extra.join("\x01");
      if (attempted.has(key)) continue;
      attempted.add(key);
      try { return await runYtDlpOnce(YTDLP_SUBS_ARGS, extra, args); }
      catch (err) { lastErr = err instanceof Error ? err : new Error("yt-dlp subs fallback failed"); }
    }
  }

  throw lastErr ?? new Error("yt-dlp subs failed");
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    get(url, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── VTT / transcript helpers ──────────────────────────────────────────────────
interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}
function vttTimeToSec(t: string): number {
  const p = t.split(":");
  return p.length === 3
    ? parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2])
    : parseFloat(p[0]) * 60 + parseFloat(p[1]);
}
function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [startStr] = tl.split("-->").map((s) => s.trim().split(" ")[0]);
    const endStr = tl.split("-->")[1].trim().split(" ")[0];
    const text = lines
      .filter((l) => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (text)
      cues.push({
        startSec: vttTimeToSec(startStr),
        endSec: vttTimeToSec(endStr),
        text,
      });
  }
  return cues;
}
function cuesToText(cues: VttCue[]): string {
  return cues
    .map((c) => {
      const mm = Math.floor(c.startSec / 60),
        ss = Math.floor(c.startSec % 60);
      return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
    })
    .join("\n");
}
function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const lines = transcript.split("\n").filter(Boolean);
  const targetCount = Math.floor(maxChars / 85);
  if (lines.length <= targetCount) return transcript.slice(0, maxChars);
  const step = lines.length / targetCount;
  const out: string[] = [];
  for (let i = 0; i < targetCount; i++) {
    const l = lines[Math.floor(i * step)];
    if (l) out.push(l);
  }
  return `[Transcript sampled from ${lines.length} total lines]\n${out.join("\n")}`;
}

/**
 * Converts raw SRT text to compact one-line-per-cue format matching cuesToText().
 *
 * Raw SRT (4 lines per block):
 *   1
 *   00:00:12,000 --> 00:00:14,200
 *   Welcome to today's
 *
 * Compact output (1 line per cue):
 *   [00:12] Welcome to today's
 *
 * For a 3-hour audio the raw SRT is ~640k chars; compact is ~160k —
 * always under the 400k Gemini limit so sampleTranscript never activates.
 */
function srtToCompact(srt: string): string {
  const blocks = srt.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const block of blocks) {
    const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
    const tsLine = rows.find((r) => r.includes("-->"));
    if (!tsLine) continue;
    const m = tsLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d+)/);
    if (!m) continue;
    const totalSec =
      parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    const tsIdx = rows.indexOf(tsLine);
    const text = rows
      .slice(tsIdx + 1)
      .join(" ")
      .trim();
    if (!text) continue;
    lines.push(
      `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${text}`,
    );
  }
  return lines.join("\n");
}
function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function pickBestSubtitleUrl(
  subs: Record<string, any[]>,
  autoCaps: Record<string, any[]>,
  videoLang?: string,
): string | null {
  const priority = videoLang ? [videoLang, "hi", "en"] : ["hi", "en"];
  for (const pool of [subs, autoCaps]) {
    for (const lang of priority) {
      const list = Object.entries(pool).find(
        ([k]) => k === lang || k.startsWith(lang + "-"),
      )?.[1];
      if (list?.length) {
        const vtt = list.find((f: any) => f.ext === "vtt") ?? list[0];
        if (vtt?.url) return vtt.url;
      }
    }
  }
  return null;
}

// ── Analysis job store ────────────────────────────────────────────────────────
export interface AnalysisJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: {
    timeline: TimelineSegment[];
    videoDuration: number;
    videoTitle: string;
    transcriptText?: string;
  };
  error?: string;
  createdAt: number;
  cancelled?: boolean;
  abort?: () => void;
}
const analysisJobs = new Map<string, AnalysisJob>();

// ── Analysis restart-resilience markers ──────────────────────────────────────
// When `runBhagwatAnalysis` starts in-process (non-queue mode), drop a small
// JSON marker on disk. If the server restarts mid-analysis we sweep these on
// boot and hydrate them as `error: interrupted by restart` so the SSE polling
// frontend gets a clear message instead of an indefinite "Job not found" loop.
const BHAGWAT_ANALYSIS_META_DIR = join(BHAGWAT_TMP_DIR, "_analysis_meta");
try { mkdirSync(BHAGWAT_ANALYSIS_META_DIR, { recursive: true }); } catch {}
const analysisMetaPath = (jobId: string) => join(BHAGWAT_ANALYSIS_META_DIR, `${jobId}.json`);

function persistAnalysisMetaStart(jobId: string) {
  try {
    writeFileSync(
      analysisMetaPath(jobId),
      JSON.stringify({ jobId, status: "running", startedAt: Date.now() }),
    );
  } catch {}
}
function clearAnalysisMeta(jobId: string) {
  try { unlinkSync(analysisMetaPath(jobId)); } catch {}
}
function hydrateInterruptedAnalysis(jobId: string): AnalysisJob | undefined {
  const metaPath = analysisMetaPath(jobId);
  if (!existsSync(metaPath)) return undefined;
  let startedAt = Date.now();
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { startedAt?: number };
    if (typeof parsed.startedAt === "number") startedAt = parsed.startedAt;
  } catch {}
  const interruptedJob: AnalysisJob = {
    emitter: new EventEmitter(),
    status: "error",
    error: "Analysis was interrupted by a server restart — please start a new analysis.",
    createdAt: startedAt,
  };
  analysisJobs.set(jobId, interruptedJob);
  // Clean up the marker so the UI can immediately re-attempt without
  // re-hitting the same interrupted-state error.
  clearAnalysisMeta(jobId);
  return interruptedJob;
}
// Boot-time sweep: any leftover marker from a previous process means that
// analysis never finished. Move them all into the in-memory map as errored
// jobs so the next SSE poll resolves quickly with a clear message.
try {
  for (const entry of readdirSync(BHAGWAT_ANALYSIS_META_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const jobId = entry.replace(/\.json$/i, "");
    if (!isSafeBhagwatId(jobId)) {
      try { unlinkSync(join(BHAGWAT_ANALYSIS_META_DIR, entry)); } catch {}
      continue;
    }
    hydrateInterruptedAnalysis(jobId);
  }
} catch {}

export function createBhagwatAnalysisJobState(
  jobId: string,
  job: AnalysisJob,
): AnalysisJob {
  analysisJobs.set(jobId, job);
  return job;
}

export function getBhagwatAnalysisJobState(
  jobId: string,
): AnalysisJob | undefined {
  return analysisJobs.get(jobId);
}

export function deleteBhagwatAnalysisJobState(jobId: string): void {
  analysisJobs.delete(jobId);
}

// Clean up completed/failed analysis jobs older than 1 hour (memory leak fix)
setInterval(
  () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of analysisJobs.entries()) {
      if (job.createdAt < cutoff) analysisJobs.delete(id);
    }
  },
  30 * 60 * 1000,
);

// ── Password Auth ─────────────────────────────────────────────────────────────
// The password is stored server-side in BHAGWAT_PASSWORD env var so it is
// never exposed in client-side JavaScript.
router.post("/bhagwat/auth", (req: Request, res: Response) => {
  const bodyPassword = (req.body as { password?: string })?.password;
  const queryPassword = (() => {
    const raw = (req.query as Record<string, unknown> | undefined)?.password;
    return typeof raw === "string" ? raw : "";
  })();
  const rawPassword = (() => {
    const raw = (req as Request & { rawBody?: unknown }).rawBody;
    if (typeof raw !== "string" || !raw) return "";
    try {
      const parsed = JSON.parse(raw) as { password?: unknown };
      return typeof parsed.password === "string" ? parsed.password : "";
    } catch {
      return "";
    }
  })();
  const eventPassword = (() => {
    const event = (req as Request & {
      apiGateway?: { event?: { body?: string; isBase64Encoded?: boolean } };
    }).apiGateway?.event;
    if (!event?.body) return "";
    const text = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { password?: unknown };
      return typeof parsed.password === "string" ? parsed.password : "";
    } catch {
      return "";
    }
  })();
  const password = bodyPassword || rawPassword || eventPassword || queryPassword;
  const expected = process.env.BHAGWAT_PASSWORD;
  if (!expected) {
    res.status(503).json({ ok: false, message: "BHAGWAT_PASSWORD is not configured" });
    return;
  }
  if (!password || password !== expected) {
    res.status(401).json({ ok: false, message: "Incorrect password" });
    return;
  }
  res.cookie(BHAGWAT_AUTH_COOKIE_NAME, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    signed: true,
    maxAge: BHAGWAT_AUTH_MAX_AGE_MS,
    path: "/",
  });
  res.json({ ok: true });
});

router.post("/bhagwat/analyze", async (req: Request, res: Response) => {
  const { url, mode, clipStartSec, clipEndSec } = req.body as {
    url: string;
    mode?: "smart" | "full";
    clipStartSec?: number;
    clipEndSec?: number;
  };
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const jobId = randomUUID();

  if (isBhagwatAnalyzeQueuePrimaryEnabled()) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "bhagwat-analyze",
        sourceUrl: url,
        meta: {
          mode: mode ?? "full",
          ...(typeof clipStartSec === "number" ? { clipStartSec } : {}),
          ...(typeof clipEndSec === "number" ? { clipEndSec } : {}),
          sourceKind: "youtube",
        },
      });
      res.json({ jobId, status: "queued", message: "Bhagwat analysis queued" });
      return;
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to queue Bhagwat analysis");
      res.status(502).json({ error: "Failed to queue Bhagwat analysis job" });
      return;
    }
  }

  const job: AnalysisJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  analysisJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatAnalysis(
    jobId,
    job,
    url,
    mode ?? "full",
    clipStartSec,
    clipEndSec,
  ).catch((err) => {
    req.log.error({ err, jobId }, "[bhagwat/analyze] Background analysis failed");
  });
});

router.get("/bhagwat/analyze-status/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  // If the in-memory job is gone, first check whether a "running" marker
  // from a previous process exists on disk (analysis interrupted by restart).
  // Hydrating it here lets the SSE reconnection path resolve quickly with a
  // clean error instead of looping on "Job not found".
  const job = getBhagwatAnalysisJobState(jobId) ?? hydrateInterruptedAnalysis(jobId);
  if (!job) {
    if (!isBhagwatAnalyzeQueueEnabled()) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    setupSse(res);
    const send = (event: string, data: object) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const pollQueue = async (): Promise<boolean> => {
      const queueStatus = await getYoutubeQueueJobStatus(jobId);
      if (!queueStatus) {
        send("jobError", { message: "Job not found" });
        res.end();
        return true;
      }

      if (queueStatus.status === "done") {
        if (!queueStatus.resultJson) {
          send("jobError", { message: "Analysis finished without result payload" });
          res.end();
          return true;
        }
        try {
          const resultData = JSON.parse(queueStatus.resultJson) as {
            timeline: TimelineSegment[];
            videoDuration: number;
            videoTitle: string;
            transcriptText?: string;
          };
          send("done", resultData);
          res.end();
          return true;
        } catch (err) {
          req.log.error({ err, jobId }, "Failed to parse queued Bhagwat analysis result");
          send("jobError", { message: "Invalid queued analysis payload" });
          res.end();
          return true;
        }
      }

      if (["error", "cancelled", "expired"].includes(queueStatus.status)) {
        send("jobError", { message: queueStatus.message ?? "Analysis failed" });
        res.end();
        return true;
      }

      send("step", {
        step: "ai",
        status: "running",
        message: queueStatus.message ?? "Queued for processing...",
        queue: {
          updatedAt: queueStatus.updatedAt,
          batchJobId: queueStatus.batchJobId,
        },
      });
      return false;
    };

    void pollQueue()
      .then((finished) => {
        if (finished || closed) return;
        const timer = setInterval(() => {
          if (closed) {
            clearInterval(timer);
            return;
          }
          void pollQueue()
            .then((done) => {
              if (done) clearInterval(timer);
            })
            .catch((err) => {
              req.log.error({ err, jobId }, "Failed queued Bhagwat analysis poll");
              send("jobError", { message: "Failed to fetch queued analysis status" });
              clearInterval(timer);
              res.end();
            });
        }, BHAGWAT_QUEUE_POLL_MS);
      })
      .catch((err) => {
        req.log.error({ err, jobId }, "Failed queued Bhagwat analysis lookup");
        send("jobError", { message: "Failed to fetch queued analysis status" });
        res.end();
      });
    return;
  }
  setupSse(res);
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status === "done") {
    send("done", job.result!);
    res.end();
    return;
  }
  if (job.status === "error") {
    send("jobError", { message: job.error });
    res.end();
    return;
  }
  const onStep = (d: object) => send("step", d);
  const onDone = (d: object) => { send("done", d); res.end(); };
  const onErr  = (d: object) => { send("jobError", d); res.end(); };
  job.emitter.on("step", onStep);
  job.emitter.on("done", onDone);
  job.emitter.on("jobError", onErr);
  req.on("close", () => {
    job.emitter.off("step", onStep);
    job.emitter.off("done", onDone);
    job.emitter.off("jobError", onErr);
  });
});

router.post("/bhagwat/cancel-analyze/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ ok: false });
    return;
  }
  const job = getBhagwatAnalysisJobState(jobId);
  if (!job) {
    if (!isBhagwatAnalyzeQueueEnabled()) {
      res.status(404).json({ ok: false });
      return;
    }
    void cancelYoutubeQueueJob(jobId)
      .then((cancelled) => {
        if (!cancelled.ok) {
          res.status(404).json({ ok: false });
          return;
        }
        res.json({
          ok: true,
          status: cancelled.status,
          alreadyFinished: cancelled.alreadyFinished ?? false,
          queue: { batchJobId: cancelled.batchJobId },
        });
      })
      .catch((err) => {
        req.log.error({ err, jobId }, "Failed to cancel queued Bhagwat analysis");
        res.status(500).json({ ok: false, error: "Failed to cancel job" });
      });
    return;
  }
  job.cancelled = true;
  job.abort?.();
  res.json({ ok: true });
});

// ── Plan review ───────────────────────────────────────────────────────────────
interface ReviewJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  createdAt: number;
}
const reviewJobs = new Map<string, ReviewJob>();

function extractBhagwatReviewSuggestions(fullText: string): {
  improvements: any[];
  newSegments: any[];
} {
  const blockMatch = fullText.match(
    /\*{0,2}\s*SUGGESTIONS_JSON\s*\*{0,2}\s*([\s\S]*?)\s*\*{0,2}\s*END_SUGGESTIONS\s*\*{0,2}/i,
  );
  if (!blockMatch) {
    return { improvements: [], newSegments: [] };
  }

  let jsonText = blockMatch[1].trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const firstBrace = jsonText.indexOf("{");
  const lastBrace = jsonText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(jsonText);
    const improvements = Array.isArray(parsed.improvements)
      ? parsed.improvements
      : [];
    const newSegments = Array.isArray(parsed.newSegments)
      ? parsed.newSegments.filter(
          (s: any) =>
            typeof s.startSec === "number" &&
            typeof s.endSec === "number" &&
            s.endSec > s.startSec + 1,
        )
      : [];
    return { improvements, newSegments };
  } catch {
    return { improvements: [], newSegments: [] };
  }
}

setInterval(
  () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of reviewJobs.entries()) {
      if (job.createdAt < cutoff) reviewJobs.delete(id);
    }
  },
  30 * 60 * 1000,
);

router.post("/bhagwat/review-plan", (req: Request, res: Response) => {
  const { timeline, videoTitle, videoDuration, transcriptText } = req.body as {
    timeline: TimelineSegment[];
    videoTitle: string;
    videoDuration: number;
    transcriptText?: string;
  };
  if (!Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "timeline is required" });
    return;
  }
  const jobId = randomUUID();
  const job: ReviewJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  reviewJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatReview(
    jobId,
    job,
    timeline,
    videoTitle ?? "",
    videoDuration ?? 0,
    transcriptText ?? "",
  ).catch((err) => {
    req.log.error({ err, jobId }, "[bhagwat] background review failed");
  });
});

router.get("/bhagwat/review-status/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = reviewJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  setupSse(res);
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onChunk  = (d: object) => send("chunk", d);
  const onSugg   = (d: object) => { send("suggestions", d); res.end(); };
  const onRevErr = (d: object) => { send("jobError", d); res.end(); };
  job.emitter.on("chunk", onChunk);
  job.emitter.on("suggestions", onSugg);
  job.emitter.on("jobError", onRevErr);
  req.on("close", () => {
    job.emitter.off("chunk", onChunk);
    job.emitter.off("suggestions", onSugg);
    job.emitter.off("jobError", onRevErr);
  });
});

async function runBhagwatReview(
  _jobId: string,
  job: ReviewJob,
  timeline: TimelineSegment[],
  videoTitle: string,
  videoDuration: number,
  transcriptText: string,
) {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  job.status = "running";
  try {
    const segmentList = timeline
      .map(
        (seg, i) =>
          `[${i}] ${formatTime(seg.startSec)}–${formatTime(seg.endSec)} | ${seg.isBhajan ? "Bhajan" : "Katha"}\nDescription: ${seg.description}\nCurrent prompt: ${seg.imagePrompt}`,
      )
      .join("\n\n");

    const transcriptBlock = transcriptText.trim()
      ? `\n\nFULL TRANSCRIPT (with timestamps):\n${sampleTranscript(transcriptText, 200000)}`
      : "";

    const prompt = `You are an expert devotional video editor performing a deep review of an AI-generated image timeline for a Bhagwat Katha video. Your job is both to improve what's there AND discover what was missed.

Video: "${videoTitle}" (${formatTime(videoDuration)})${transcriptBlock}

CURRENT IMAGE PLAN (${timeline.length} segments):
${segmentList}

Perform two tasks:

TASK 1 — IMPROVE EXISTING PROMPTS:
For each segment, THINK: Is this prompt vivid and specific to what the speaker is narrating at this exact moment? Could it be more detailed, more accurate to the story, or better suited for AI image generation? Think out loud about each one, then IF NEEDED then suggest improvements for any that are weak or generic.

TASK 2 — FIND COVERAGE GAPS:
Look at the transcript timestamps against the current plan coverage. Identify significant moments in the narration that have NO image planned, such as:
- Key story beats or character introductions not covered
- Dramatic moments, reveals, or emotional peaks without visuals
- Important shlokas, bhajans, or divine descriptions that deserve an image
- Any section of the transcript where the current plan leaves a notable gap

For each gap, suggest a new segment with precise timing, description, and a vivid image prompt.

After your analysis, end your response with EXACTLY this JSON block (no extra text after END_SUGGESTIONS):

SUGGESTIONS_JSON
{
  "improvements": [
    {"segIdx": 0, "reason": "brief reason", "improvedPrompt": "full improved prompt here"}
  ],
  "newSegments": [
    {"startSec": 15, "endSec": 28, "description": "brief description of the moment", "imagePrompt": "full image generation prompt", "isBhajan": false}
  ]
}
END_SUGGESTIONS

Both arrays can be empty if there's nothing to improve or add. Only suggest new segments for genuinely uncovered moments, not for sections already covered by the plan.`;

    const fullText = await withTimeout(
      geminiProStream("", prompt, (text) => emit("chunk", { text })),
      BHAGWAT_REVIEW_TIMEOUT_MS,
      "Bhagwat review generation",
    );

    const { improvements, newSegments } =
      extractBhagwatReviewSuggestions(fullText);

    emit("suggestions", { suggestions: improvements, newSegments });
    job.status = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Review failed";
    console.error("[bhagwat/review] Error:", message);
    emit("jobError", { message });
    job.status = "error";
  }
}

// ── Render job store ──────────────────────────────────────────────────────────
export interface RenderJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error" | "expired";
  outputPath?: string;
  filename?: string;
  title?: string;
  error?: string;
  progressPercent?: number;
  progressMessage?: string;
  createdAt: number;
  deleteScheduled?: boolean;
  cancelled?: boolean;
  abort?: () => void;
}
const renderJobs = new Map<string, RenderJob>();

export function createBhagwatRenderJobState(
  jobId: string,
  job: RenderJob,
): RenderJob {
  renderJobs.set(jobId, job);
  return job;
}

export function getBhagwatRenderJobState(jobId: string): RenderJob | undefined {
  return renderJobs.get(jobId);
}

export function deleteBhagwatRenderJobState(jobId: string): void {
  renderJobs.delete(jobId);
}

interface PersistedRenderMeta {
  jobId: string;
  filename: string;
  title?: string;
  completedAt: number;
  status?: "running" | "done";
  startedAt?: number;
}

const renderMetaPath = (jobId: string) => join(BHAGWAT_RENDERED_DIR, `${jobId}.json`);
const renderVideoPath = (jobId: string) => join(BHAGWAT_RENDERED_DIR, `${jobId}.mp4`);

function readPersistedRenderMeta(jobId: string): PersistedRenderMeta | null {
  const metaPath = renderMetaPath(jobId);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    if (parsed && typeof parsed.filename === "string") {
      return {
        jobId,
        filename: parsed.filename,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
        completedAt: typeof parsed.completedAt === "number" ? parsed.completedAt : Date.now(),
        status: parsed.status === "running" || parsed.status === "done" ? parsed.status : undefined,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : undefined,
      };
    }
  } catch {}
  return null;
}

function persistRenderMeta(jobId: string, job: RenderJob) {
  const meta: PersistedRenderMeta = {
    jobId,
    filename: job.filename ?? "bhagwat_video.mp4",
    title: job.title,
    completedAt: Date.now(),
    status: "done",
  };
  try {
    writeFileSync(renderMetaPath(jobId), JSON.stringify(meta));
  } catch {}
}

// Write a "running" meta marker the moment a render starts so that if the
// server restarts mid-render, we can detect the interrupted job on hydration
// and surface a clear message (instead of a generic 404 / connection error).
export function persistRenderMetaStart(jobId: string, job: RenderJob) {
  const meta: PersistedRenderMeta = {
    jobId,
    filename: job.filename ?? "bhagwat_video.mp4",
    title: job.title,
    completedAt: 0,
    status: "running",
    startedAt: Date.now(),
  };
  try {
    writeFileSync(renderMetaPath(jobId), JSON.stringify(meta));
  } catch {}
}

function ensureRenderJob(jobId: string): RenderJob | undefined {
  const existing = renderJobs.get(jobId);
  if (existing) return existing;

  const outputPath = renderVideoPath(jobId);
  const meta = readPersistedRenderMeta(jobId);

  if (existsSync(outputPath)) {
    const hydrated: RenderJob = {
      emitter: new EventEmitter(),
      status: "done",
      outputPath,
      filename: meta?.filename ?? "bhagwat_video.mp4",
      title: meta?.title,
      progressPercent: 100,
      progressMessage: "Video ready for download!",
      createdAt: meta?.completedAt ?? Date.now(),
    };
    renderJobs.set(jobId, hydrated);
    return hydrated;
  }

  if (meta) {
    // Meta exists but no output file. Two cases:
    //   1. status === "running"  → server restarted mid-render. Mark as error so
    //      the frontend stops reconnecting and shows a clear message.
    //   2. status === "done" / undefined → file was completed and then deleted
    //      (cleanup ran). Mark as expired.
    const interrupted = meta.status === "running";
    const hydrated: RenderJob = {
      emitter: new EventEmitter(),
      status: interrupted ? "error" : "expired",
      filename: meta.filename,
      title: meta.title,
      error: interrupted
        ? "Render was interrupted by a server restart — please start a new render."
        : undefined,
      progressPercent: 100,
      progressMessage: interrupted
        ? "Render interrupted (server restarted)"
        : "Rendered file expired",
      createdAt: meta.startedAt ?? meta.completedAt ?? Date.now(),
    };
    renderJobs.set(jobId, hydrated);
    return hydrated;
  }

  return undefined;
}

function readRenderHistory(limit = 20) {
  const entries: Array<{ id: string; title: string; filename: string; downloadUrl: string; timestamp: number }> = [];
  try {
    for (const entry of readdirSync(BHAGWAT_RENDERED_DIR)) {
      if (!entry.endsWith(".json")) continue;
      const jobId = entry.replace(/\.json$/i, "");
      const meta = readPersistedRenderMeta(jobId);
      if (!meta) continue;
      // Only show successfully completed renders. Skip "running" markers and
      // anything where the underlying file no longer exists on disk.
      if (meta.status === "running") continue;
      if (!existsSync(renderVideoPath(jobId))) continue;
      entries.push({
        id: jobId,
        title: meta.title ?? meta.filename,
        filename: meta.filename,
        downloadUrl: `/api/bhagwat/download/${jobId}`,
        timestamp: meta.completedAt,
      });
    }
  } catch {}
  return entries
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

router.post("/bhagwat/render", async (req: Request, res: Response) => {
  const { url, timeline, videoDuration, clipStartSec, clipEndSec, mode, videoTitle } =
    req.body as {
      url: string;
      timeline: TimelineSegment[];
      videoDuration?: number;
      clipStartSec?: number;
      clipEndSec?: number;
      mode?: "full" | "smart";
      videoTitle?: string;
    };
  if (!url || !Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "url and timeline are required" });
    return;
  }
  const jobId = randomUUID();
  if (isBhagwatRenderQueuePrimaryEnabled()) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "bhagwat-render",
        sourceUrl: url,
        meta: {
          timeline,
          videoDuration: videoDuration ?? 0,
          ...(typeof clipStartSec === "number" ? { clipStartSec } : {}),
          ...(typeof clipEndSec === "number" ? { clipEndSec } : {}),
          mode: mode ?? "full",
          videoTitle,
          sourceKind: "youtube",
        },
      });
      res.json({ jobId, status: "queued", message: "Bhagwat render queued" });
      return;
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to queue Bhagwat render");
      res.status(502).json({ error: "Failed to queue Bhagwat render job" });
      return;
    }
  }
  const MAX_CONCURRENT_RENDERS = 3;
  const activeRenders = [...renderJobs.values()].filter(
    j => j.status === "pending" || j.status === "running",
  ).length;
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    res.status(429).json({ error: `Server is busy with ${activeRenders} active render(s). Please wait a moment and try again.` });
    return;
  }
  const job: RenderJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
    title: videoTitle,
  };
  renderJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatRender(
    jobId,
    job,
    url,
    timeline,
    videoDuration ?? 0,
    clipStartSec,
    clipEndSec,
    undefined,
    mode ?? "full",
  ).catch((err) => {
    req.log.error({ err, jobId }, "[bhagwat/render] Background render failed");
  });
});

router.get("/bhagwat/render-status/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = ensureRenderJob(jobId);
  if (!job) {
    if (!isBhagwatRenderQueueEnabled()) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    setupSse(res);
    const send = (event: string, data: object) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const pollQueue = async (): Promise<boolean> => {
      const queueStatus = await getYoutubeQueueJobStatus(jobId);
      if (!queueStatus) {
        send("jobError", { message: "Job not found" });
        res.end();
        return true;
      }
      if (queueStatus.status === "done") {
        let filename = queueStatus.filename ?? "bhagwat_video.mp4";
        if (queueStatus.resultJson) {
          try {
            const parsed = JSON.parse(queueStatus.resultJson) as { filename?: string };
            if (parsed.filename) filename = parsed.filename;
          } catch {}
        }
        send("done", {
          downloadUrl: `/api/bhagwat/download/${jobId}`,
          filename,
        });
        res.end();
        return true;
      }
      if (["error", "cancelled", "expired"].includes(queueStatus.status)) {
        send("jobError", { message: queueStatus.message ?? "Render failed" });
        res.end();
        return true;
      }
      send("progress", {
        percent: queueStatus.progressPct ?? 0,
        message: queueStatus.message ?? "Queued for render...",
      });
      return false;
    };

    void pollQueue()
      .then((finished) => {
        if (finished || closed) return;
        const timer = setInterval(() => {
          if (closed) {
            clearInterval(timer);
            return;
          }
          void pollQueue()
            .then((done) => {
              if (done) clearInterval(timer);
            })
            .catch((err) => {
              req.log.error({ err, jobId }, "Failed queued Bhagwat render poll");
              send("jobError", { message: "Failed to fetch queued render status" });
              clearInterval(timer);
              res.end();
            });
        }, BHAGWAT_QUEUE_POLL_MS);
      })
      .catch((err) => {
        req.log.error({ err, jobId }, "Failed queued Bhagwat render lookup");
        send("jobError", { message: "Failed to fetch queued render status" });
        res.end();
      });
    return;
  }
  setupSse(res);
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status === "done") {
    send("done", {
      downloadUrl: `/api/bhagwat/download/${jobId}`,
      filename: job.filename,
    });
    res.end();
    return;
  }
  if (job.status === "error") {
    send("jobError", { message: job.error });
    res.end();
    return;
  }
  const onProg    = (d: object) => send("progress", d);
  const onRenDone = (d: object) => { send("done", d); res.end(); };
  const onRenErr  = (d: object) => { send("jobError", d); res.end(); };
  job.emitter.on("progress", onProg);
  job.emitter.on("done", onRenDone);
  job.emitter.on("jobError", onRenErr);
  req.on("close", () => {
    job.emitter.off("progress", onProg);
    job.emitter.off("done", onRenDone);
    job.emitter.off("jobError", onRenErr);
  });
});

router.get("/bhagwat/render-state/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = ensureRenderJob(jobId);
  if (!job) {
    if (!isBhagwatRenderQueueEnabled()) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    void getYoutubeQueueJobStatus(jobId)
      .then((queueStatus) => {
        if (!queueStatus) {
          res.status(404).json({ error: "Job not found" });
          return;
        }
        if (queueStatus.status === "done") {
          let filename = queueStatus.filename ?? "bhagwat_video.mp4";
          if (queueStatus.resultJson) {
            try {
              const parsed = JSON.parse(queueStatus.resultJson) as { filename?: string };
              if (parsed.filename) filename = parsed.filename;
            } catch {}
          }
          res.json({
            status: "done",
            percent: 100,
            message: queueStatus.message ?? "Video ready for download!",
            downloadUrl: `/api/bhagwat/download/${jobId}`,
            filename,
          });
          return;
        }
        if (queueStatus.status === "error") {
          res.json({
            status: "error",
            percent: queueStatus.progressPct ?? 0,
            message: queueStatus.message ?? "Render failed",
          });
          return;
        }
        if (queueStatus.status === "expired") {
          res.json({
            status: "expired",
            percent: 100,
            message: queueStatus.message ?? "Rendered file expired",
          });
          return;
        }
        if (queueStatus.status === "cancelled") {
          res.json({
            status: "error",
            percent: queueStatus.progressPct ?? 0,
            message: queueStatus.message ?? "Render cancelled",
          });
          return;
        }
        res.json({
          status: queueStatus.status,
          percent: queueStatus.progressPct ?? 0,
          message: queueStatus.message ?? "Queued for render...",
        });
      })
      .catch((err) => {
        req.log.error({ err, jobId }, "Failed queued Bhagwat render-state lookup");
        res.status(500).json({ error: "Failed to fetch render status" });
      });
    return;
  }
  if (job.status === "done") {
    res.json({
      status: "done",
      percent: job.progressPercent ?? 100,
      message: job.progressMessage ?? "Video ready for download!",
      downloadUrl: `/api/bhagwat/download/${jobId}`,
      filename: job.filename,
    });
    return;
  }
  if (job.status === "error") {
    res.json({
      status: "error",
      percent: job.progressPercent ?? 0,
      message: job.error ?? "Render failed",
    });
    return;
  }
  if (job.status === "expired") {
    res.json({
      status: "expired",
      percent: job.progressPercent ?? 100,
      message: "Rendered file expired",
    });
    return;
  }
  res.json({
    status: job.status,
    percent: job.progressPercent ?? 0,
    message: job.progressMessage ?? "",
  });
});

router.get("/bhagwat/render-history", (_req: Request, res: Response) => {
  res.json({ entries: readRenderHistory() });
});

router.delete("/bhagwat/render-history", (_req: Request, res: Response) => {
  try {
    for (const entry of readdirSync(BHAGWAT_RENDERED_DIR)) {
      if (entry.endsWith(".json")) {
        const jobId = entry.replace(/\.json$/i, "");
        try { unlinkSync(renderMetaPath(jobId)); } catch {}
        try { unlinkSync(renderVideoPath(jobId)); } catch {}
        renderJobs.delete(jobId);
      }
    }
  } catch {}
  res.json({ ok: true });
});

router.post("/bhagwat/cancel-render/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ ok: false });
    return;
  }
  const job = ensureRenderJob(jobId);
  if (!job) {
    if (!isBhagwatRenderQueueEnabled()) {
      res.status(404).json({ ok: false });
      return;
    }
    void cancelYoutubeQueueJob(jobId)
      .then((cancelled) => {
        if (!cancelled.ok) {
          res.status(404).json({ ok: false });
          return;
        }
        res.json({
          ok: true,
          status: cancelled.status,
          alreadyFinished: cancelled.alreadyFinished ?? false,
          queue: { batchJobId: cancelled.batchJobId },
        });
      })
      .catch((err) => {
        req.log.error({ err, jobId }, "Failed to cancel queued Bhagwat render");
        res.status(500).json({ ok: false, error: "Failed to cancel job" });
      });
    return;
  }
  job.cancelled = true;
  job.abort?.();
  res.json({ ok: true });
});

const RENDER_DELETE_MS = 60 * 60 * 1000; // 60 minutes after first download (was 10)

router.get("/bhagwat/download/:jobId", (req: Request, res: Response) => {
  const jobId = pickSafeBhagwatId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = renderJobs.get(jobId);
  if (!job?.outputPath || !existsSync(job.outputPath)) {
    if (!isBhagwatRenderQueueEnabled()) {
      res.status(404).json({ error: "File not ready or already deleted" });
      return;
    }
    void getYoutubeQueueJobStatus(jobId)
      .then(async (queueStatus) => {
        if (!queueStatus) {
          res.status(404).json({ error: "File not ready or already deleted" });
          return;
        }
        if (queueStatus.status === "expired") {
          res.status(410).json({ error: "Rendered file expired" });
          return;
        }
        if (queueStatus.status !== "done" || !queueStatus.s3Key) {
          res.status(404).json({ error: "File not ready or already deleted" });
          return;
        }
        const signedUrl = await getS3SignedDownloadUrl({
          key: queueStatus.s3Key,
          filename: queueStatus.filename ?? "bhagwat_video.mp4",
        });
        res.redirect(302, signedUrl);
      })
      .catch((err) => {
        req.log.error({ err, jobId }, "Failed queued Bhagwat download lookup");
        res.status(500).json({ error: "Failed to resolve download URL" });
      });
    return;
  }
  res.download(job.outputPath, job.filename ?? "bhagwat_video.mp4");

  // Schedule file + job deletion 10 minutes after a real GET download is triggered.
  // HEAD requests (used by the history panel to check liveness) must NOT start the timer.
  if (req.method !== "HEAD" && !job.deleteScheduled) {
    job.deleteScheduled = true;
    setTimeout(() => {
      try {
        unlinkSync(job.outputPath!);
      } catch {}
      job.outputPath = undefined;
      job.status = "expired";
      try {
        unlinkSync(renderMetaPath(jobId));
      } catch {}
      setTimeout(() => renderJobs.delete(jobId), 60_000);
    }, RENDER_DELETE_MS);
  }
});

// Sweep render jobs older than 2 hours from memory (safety net)
setInterval(
  () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, job] of renderJobs.entries()) {
      if (job.createdAt < cutoff) {
        if (job.outputPath) {
          try {
            unlinkSync(job.outputPath);
          } catch {}
        }
        renderJobs.delete(id);
      }
    }
  },
  30 * 60 * 1000,
);

// ── runBhagwatAnalysis ────────────────────────────────────────────────────────
export async function runBhagwatAnalysis(
  jobId: string,
  job: AnalysisJob,
  url: string,
  mode: "smart" | "full",
  clipStartSec?: number,
  clipEndSec?: number,
): Promise<void> {
  const clipMode = clipStartSec !== undefined && clipEndSec !== undefined;
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  const step = (
    s: string,
    status: "running" | "done" | "warn",
    message: string,
  ) => emit("step", { step: s, status, message });

  job.status = "running";
  // Drop a "running" marker so a server restart mid-analysis can be detected
  // on next boot (see hydrateInterruptedAnalysis sweep).
  persistAnalysisMetaStart(jobId);
  const tmpId = randomUUID();
  const subDir = join(BHAGWAT_TMP_DIR, `subs_${tmpId}`);

  try {
    if (!isAnyAIConfigured())
      throw new Error("No AI provider configured — add GEMINI_API_KEY in Secrets or enable the Gemini integration");

    // ── Step 1: Metadata ──────────────────────────────────────────────────────
    step("metadata", "running", "Fetching video info…");
    let videoDuration = 0,
      videoTitle = "",
      videoDescription = "",
      transcript = "";
    let metaSubtitleUrl: string | null = null;

    try {
      const metaJson = await runYtDlp([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ]);
      const meta = JSON.parse(metaJson);
      videoDuration = meta.duration ?? 0;
      // In clip mode, restrict duration to the clip range
      if (clipMode) videoDuration = clipEndSec! - clipStartSec!;
      videoTitle = meta.title ?? "";
      videoDescription = (meta.description ?? "").slice(0, 800);
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      metaSubtitleUrl = pickBestSubtitleUrl(
        subs,
        autoCaps,
        meta.language ?? meta.original_language,
      );
      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        const chapters = clipMode
          ? meta.chapters.filter(
              (c: any) =>
                c.start_time < clipEndSec! &&
                (c.end_time ?? c.start_time + 60) > clipStartSec!,
            )
          : meta.chapters;
        transcript = chapters
          .map((c: any) => {
            const start = clipMode
              ? Math.max(0, c.start_time - clipStartSec!)
              : c.start_time;
            const end = clipMode
              ? Math.max(0, (c.end_time ?? c.start_time + 60) - clipStartSec!)
              : (c.end_time ?? c.start_time + 60);
            return `[${formatTime(start)}–${formatTime(end)}] ${c.title}`;
          })
          .join("\n");
      }
      step(
        "metadata",
        "done",
        `"${videoTitle.slice(0, 55)}${videoTitle.length > 55 ? "…" : ""}" · ${formatTime(videoDuration)}`,
      );
    } catch (metaErr) {
      const metaMsg =
        metaErr instanceof Error ? metaErr.message : String(metaErr);
      console.error("[bhagwat/analyze] yt-dlp metadata failed:", metaMsg);
      step(
        "metadata",
        "warn",
        `Could not load metadata: ${metaMsg.slice(0, 120)}`,
      );
    }

    // If yt-dlp gave us nothing useful, fail early with a clear error instead of
    // passing empty context to Gemini and silently producing 0 clips.
    if (!videoTitle && videoDuration === 0 && !transcript) {
      throw new Error(
        "Could not fetch video metadata from YouTube. This is usually caused by bot-detection on cloud IPs. " +
          "Please try again in a few minutes, or check that the URL is a valid public YouTube video.",
      );
    }

    // ── Step 2: Transcript ────────────────────────────────────────────────────
    if (!transcript) {
      step("transcript", "running", "Downloading transcript…");
      let vttContent: string | null = null;
      if (metaSubtitleUrl) {
        try {
          const raw = await fetchUrl(metaSubtitleUrl);
          if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
        } catch {}
      }
      if (!vttContent) {
        try {
          mkdirSync(subDir, { recursive: true });
          const subBase = join(subDir, "sub");
          await runYtDlpForSubs([
            "--write-subs",
            "--write-auto-subs",
            "--sub-lang",
            "hi.*,en.*",
            "--sub-format",
            "vtt",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            "-o",
            subBase,
            url,
          ]).catch(() => {});
          if (!readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
            await runYtDlpForSubs([
              "--write-subs",
              "--write-auto-subs",
              "--sub-format",
              "vtt",
              "--skip-download",
              "--no-warnings",
              "--no-playlist",
              "-o",
              subBase,
              url,
            ]).catch(() => {});
          }
          const files = readdirSync(subDir);
          const vttFile = files
            .map((f) => join(subDir, f))
            .find((f) => f.endsWith(".vtt"));
          if (vttFile) vttContent = readFileSync(vttFile, "utf8");
          for (const f of files)
            try {
              unlinkSync(join(subDir, f));
            } catch {}
          try {
            rmdirSync(subDir);
          } catch {}
        } catch {}
      }
      if (vttContent) {
        const cues = parseVtt(vttContent);
        const deduped: VttCue[] = [];
        for (const cue of cues) {
          if (!deduped.length || deduped[deduped.length - 1].text !== cue.text)
            deduped.push(cue);
        }
        // In clip mode: filter to the requested time range and reindex to relative 0-based time
        const finalCues = clipMode
          ? deduped
              .filter(
                (c) => c.startSec < clipEndSec! && c.endSec > clipStartSec!,
              )
              .map((c) => ({
                ...c,
                startSec: Math.max(0, c.startSec - clipStartSec!),
                endSec: Math.max(0, c.endSec - clipStartSec!),
              }))
          : deduped;
        transcript = cuesToText(finalCues);
        step(
          "transcript",
          "done",
          `${finalCues.length} transcript lines loaded`,
        );
      } else {
        step(
          "transcript",
          "warn",
          "No transcript — AI will work from title & description",
        );
      }
    } else {
      step(
        "transcript",
        "done",
        `${transcript.split("\n").length} chapter markers loaded`,
      );
    }

    // ── Step 3: AI timeline ───────────────────────────────────────────────────
    step(
      "ai",
      "running",
      "AI editor is reading the katha and planning image placements…",
    );

    const transcriptBlock =
      transcript.length > 50
        ? `\nTranscript (Hindi/English):\n${sampleTranscript(transcript, 400000)}`
        : "\n[No transcript — use video title and description to infer content]";

    const systemInstruction = `You are a professional devotional video editor with deep knowledge of Shreemad Bhagwat Mahapuran, Bhagwat Katha, Ramayan, Mahabharat, and all Hindu devotional stories and bhajans. You are fully fluent in Hindi and English.

Your task: Watch this video (via transcript) exactly like an expert editor sitting at a timeline, and decide the best image to place at every moment of the story. You must think like an editor: "what image best represents what the speaker is saying RIGHT NOW and from what time to which?"

WHAT YOU ARE EDITING:
- Shreemad Bhagwat Mahapuran Katha / krishna leela / any Hindu devotional katha
- The speaker narrates Bhagwat Katha, leelas, recites shlokas, and sometimes sings bhajans
- Your job: plan a sequence of images that visually brings the narration to life.

HOW TO THINK ABOUT EACH SEGMENT:
1. STORY NARRATION (katha/leela): Break into SHORT, specific story beats of duration about 7–15 seconds each or if it varies then adjust accordingly dont rely on limitations provided. CRITICAL RULE: you are the best visual editor and capable to adjust segments durations best way but not too long that a segment covered up 2 by mistake so strictly work attentively. If the speaker narrates a section for 30 seconds, that can be 2-5 SEPARATE segments (best precise duration according to what speaker saying) with n DIFFERENT image prompts, each showing a distinct moment of the story progressing. More segments (according to what speaker saying and what would fit best) = more visual variety = better video. Each segment gets ONE unique image prompt. Be specific — eg: not "Lord Krishna" but "Lord Krishna as a young boy stealing butter from the pot, mother Yashoda watching, cozy village home in Vrindavan, 16th century devotional painting style". Set imageChangeEvery to match the segment duration (8–12).

2. BHAJAN / KIRTAN (when speaker sings a devotional song or plays music): Detect this by repeated devotional phrases, "Ram Hare Krishn Hare", "Madhab Madhab", "Jai Shri Ram", "Govind Bolo", song lyrics, musical patterns. For bhajans: use calm meditative devotional imagery — NOT the story scenes, but peaceful deity imagery (eg Radha krishna, Sita Ram or which fits the best to the bhajan,. etc.). Change images every 25–40 seconds (bhajans have a slow, meditative rhythm). Mark isBhajan: true.

3. SHLOKA RECITATION: Sanskrit verses being recited. Use sacred imagery — open scripture, deity, whatever fits best according to the narration. 

4. OPENING / CLOSING / TRANSITIONS: Use auspicious imagery. Change every 10–30 seconds or adjust accordingly.

THE STORY MUST FLOW: 
For example: If narrating Dhruv Bhakt's story, your segments should visually tell the WHOLE story in sequence (- Dhruv rejected by stepmother → forest with young boy walking → Narada Muni meeting Dhruv → Dhruv meditating → Lord Vishnu's divine appearance → Dhruv's elevation to Dhruv Loka etc) but according to how the narrator is narrating according to the narration pacing and all aspects:
Each scene gets its OWN carefully crafted image prompt.

IMAGE PROMPT RULES:
- Write in English, even if the transcript is Hindi
- Be specific and vivid: scene, characters, their appearance, setting, lighting, mood
- Include style: "traditional devotional Indian painting", "realistic", etc.
- Do NOT include: watermarks, logos, borders, modern photography
- if and only if generating image with lord (maha vishnu, lord krishna, etc) then use more detailed description of the lord and the scene.
- Bhajan prompts: peaceful, divine, deity-focused, bhajan specific.

${
  mode === "full"
    ? `FULL COVERAGE MODE: Every second of the video must be covered. No gaps allowed. Start at exactly 0 and end at exactly ${videoDuration}s. All segments must be contiguous with no spaces between them.`
    : `SMART PLACEMENT MODE:
STEP 1 — READ THE FULL TRANSCRIPT FIRST: Before selecting ANY segments, you MUST read the ENTIRE transcript from the very first timestamp to the very last. Do NOT skip the opening section. The first 30–60 seconds of the video are especially important and often contain the most powerful opening moments (introductory katha, mangalacharan, opening shloka, invocation) that deserve images. Read every line.

STEP 2 — SELECT THE BEST MOMENTS throughout the ENTIRE video duration (beginning, middle, AND end). Pick moments where a compelling image genuinely adds value: climactic story revelations, bhajans, key leela moments, bhavishya malika references, emotional peaks, shloka recitations, katha introductions, and auspicious transitions. Skip only repetitive narration where images add little value.

Leave significant gaps between selected segments — silence between images is fine and expected. Gaps of 15–30 seconds to several minutes are correct and intentional. Each selected segment must be a specific, clearly defined story beat with a vivid image opportunity. You must select moments from the FULL video duration — do not only pick from the middle or end.`
}

RESPOND with ONLY a valid JSON array, no markdown fences:
[
  {
    "startSec": 0,
    "endSec": 120,
    "isBhajan": false,
    "imageChangeEvery": 12,
    "description": "Opening — speaker introduces the katha",
    "imagePrompt": "Peaceful riverside setting at dawn, devotees sitting in a circle reading Shreemad Bhagwat Mahapuran, soft morning light, incense smoke drifting in the air, calm spiritual atmosphere, warm colors, serene and divine mood"
  }
]`;

    const clipNote = clipMode
      ? `\nNOTE: This is a CLIP extracted from ${formatTime(clipStartSec!)} to ${formatTime(clipEndSec!)} of the original video. All timestamps in your response must be RELATIVE to the clip start (i.e., the clip starts at 0s, not at ${clipStartSec}s).`
      : "";

    const userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)${clipNote}
${videoDescription ? `Description: ${videoDescription}` : ""}
${transcriptBlock}

${
  mode === "full"
    ? `Plan the COMPLETE image timeline for this clip covering every second. Write specific image prompts for each story beat. For bhajans, write calm devotional imagery with longer durations. Cover every second from 0 to ${videoDuration}s with no gaps.`
    : `IMPORTANT: First, read the ENTIRE transcript above from the first line to the last. Then select the BEST image moments spread across the FULL video duration — including the OPENING section (first 30–60 seconds), the middle, and the closing. Do not skip the opening. Write vivid, specific image prompts for each selected moment. Leave gaps between segments where images are not needed you decide. For bhajans, write calm devotional imagery.`
}`;

    const raw = (await geminiProContent(systemInstruction, userContent)).trim();

    let timeline: TimelineSegment[] = [];
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/im, "")
        .replace(/\s*```\s*$/im, "")
        .trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr
          .filter(
            (s: any) =>
              s &&
              typeof s.startSec === "number" &&
              typeof s.endSec === "number" &&
              s.endSec > s.startSec &&
              s.imagePrompt,
          )
          .map(
            (s: any): TimelineSegment => ({
              startSec: Math.max(0, s.startSec),
              endSec: Math.min(videoDuration || 999999, s.endSec),
              isBhajan: s.isBhajan === true,
              imageChangeEvery:
                s.isBhajan === true
                  ? Math.max(
                      20,
                      Math.min(40, Math.round(s.imageChangeEvery ?? 30)),
                    )
                  : Math.max(
                      8,
                      Math.min(12, Math.round(s.imageChangeEvery ?? 10)),
                    ),
              description: (s.description ?? "").slice(0, 150),
              imagePrompt: (s.imagePrompt ?? "").slice(0, 600),
            }),
          )
          // Second pass: drop any segment where clamping made endSec ≤ startSec
          .filter((s) => s.endSec > s.startSec + 1);
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0)
      throw new Error("AI returned an empty timeline — please try again");

    // Sort and ensure no overlapping segments (critical for audio sync)
    timeline.sort((a, b) => a.startSec - b.startSec);
    if (timeline.length > 0) {
      const resolved: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = resolved[resolved.length - 1];
        const seg = timeline[i].startSec < prev.endSec
          ? { ...timeline[i], startSec: prev.endSec }
          : timeline[i];
        if (seg.endSec > seg.startSec + 1) resolved.push(seg);
      }
      timeline = resolved;
    }

    if (mode === "full" && videoDuration > 0) {
      if (timeline[0].startSec > 0) {
        timeline.unshift({
          startSec: 0,
          endSec: timeline[0].startSec,
          isBhajan: false,
          imageChangeEvery: 10,
          description: "Opening",
          imagePrompt:
            "Auspicious opening scene — ancient temple entrance, golden morning light, flowers and oil lamps, devotional atmosphere, traditional Indian painting style",
        });
      }
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        const seg = timeline[i];
        if (seg.startSec > prev.endSec) {
          // Fill the gap
          filled.push({
            startSec: prev.endSec,
            endSec: seg.startSec,
            isBhajan: false,
            imageChangeEvery: 10,
            description: "Continuation",
            imagePrompt: prev.imagePrompt,
          });
        }
        filled.push(seg);
      }
      // Extend final segment to cover the full video (guard against startSec edge case)
      const last = filled[filled.length - 1];
      if (last.startSec < videoDuration) {
        last.endSec = videoDuration;
      } else {
        filled.pop(); // last segment starts beyond video end — discard
      }
      timeline = filled;
    }

    step(
      "ai",
      "done",
      `${timeline.length} segments planned · ${timeline.filter((s) => s.isBhajan).length} bhajan sections`,
    );

    const resultData = {
      timeline,
      videoDuration,
      videoTitle,
      transcriptText: transcript,
    };
    job.status = "done";
    job.result = resultData;
    clearAnalysisMeta(jobId);
    emit("done", resultData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[bhagwat/analyze] Error:", message);
    job.status = "error";
    job.error = message;
    // Drop the running marker so a real failure isn't later misreported as an
    // "interrupted by restart" job after the next reboot.
    clearAnalysisMeta(jobId);
    emit("jobError", { message });
    try {
      if (existsSync(subDir)) {
        for (const f of readdirSync(subDir))
          try {
            unlinkSync(join(subDir, f));
          } catch {}
        rmdirSync(subDir);
      }
    } catch {}
  }
}

// ── runBhagwatRender ──────────────────────────────────────────────────────────
export async function runBhagwatRender(
  jobId: string,
  job: RenderJob,
  url: string,
  timeline: TimelineSegment[],
  videoDuration: number = 0,
  clipStartSec?: number,
  clipEndSec?: number,
  localAudioPath?: string,
  mode: "full" | "smart" = "full",
): Promise<void> {
  const emit = (event: string, data: any) => {
    if (event === "progress" && data && typeof data === "object") {
      if (typeof data.percent === "number") job.progressPercent = data.percent;
      if (typeof data.message === "string") job.progressMessage = data.message;
    }
    if (event === "jobError" && data && typeof data === "object") {
      if (typeof data.message === "string") job.progressMessage = data.message;
    }
    job.emitter.emit(event, data);
  };
  job.status = "running";
  // Persist a "running" marker so a server restart mid-render is detectable.
  persistRenderMetaStart(jobId, job);

  const tmpId = randomUUID();
  const audioPath = join(BHAGWAT_TMP_DIR, `${tmpId}_audio`);
  const imgDir = join(BHAGWAT_TMP_DIR, `${tmpId}_imgs`);
  const outputPath = join(BHAGWAT_RENDERED_DIR, `${jobId}.mp4`);

  mkdirSync(imgDir, { recursive: true });

  try {
    if (!isAnyAIConfigured())
      throw new Error("No AI provider configured — add GEMINI_API_KEY in Secrets or enable the Gemini integration");

    // ── 1+2. Download media AND generate images in parallel ───────────────────
    // Smart mode with a YouTube URL → download the full video (audio + video)
    // so we can overlay AI images on top of the real footage.
    // All other cases → audio-only download (cheaper, faster).
    const isVideoOverlayMode = mode === "smart" && !localAudioPath && !!url;

    emit("progress", {
      percent: 3,
      message: isVideoOverlayMode
        ? `Downloading video & generating ${timeline.length} images in parallel…`
        : `Downloading audio & generating ${timeline.length} images in parallel…`,
    });

    const audioDownloadPromise: Promise<string> = localAudioPath
      ? Promise.resolve(localAudioPath)
      : (async (): Promise<string> => {
          let ytdlpError = "";
          try {
            await runYtDlp([
              "-f",
              // Video overlay mode: download best combined format (video + audio).
              // Standard mode: audio only (smaller, faster).
              isVideoOverlayMode
                ? "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best"
                : "bestaudio/best",
              "--no-playlist",
              "--no-warnings",
              "--no-check-certificates",
              "-o",
              `${audioPath}.%(ext)s`,
              url,
            ]);
          } catch (err) {
            ytdlpError = err instanceof Error ? err.message : String(err);
            console.error(
              "[bhagwat/render] yt-dlp download error:",
              ytdlpError,
            );
          }
          // Try common extensions directly first (deterministic, no race)
          const AUDIO_EXTS = [".m4a", ".mp3", ".webm", ".ogg", ".opus", ".aac", ".mp4", ".flac", ".wav"];
          let resolved: string | null = null;
          for (const ext of AUDIO_EXTS) {
            const candidate = `${audioPath}${ext}`;
            if (existsSync(candidate)) { resolved = candidate; break; }
          }
          // Fallback: scan directory for any file with the expected prefix
          if (!resolved) {
            const prefix = basename(audioPath);
            const found = readdirSync(BHAGWAT_TMP_DIR).find((f) => f.startsWith(prefix));
            if (found) resolved = join(BHAGWAT_TMP_DIR, found);
          }
          if (!resolved || !existsSync(resolved)) {
            throw new Error(
              ytdlpError
                ? `${isVideoOverlayMode ? "Video" : "Audio"} download failed: ${ytdlpError.slice(0, 300)}`
                : `Failed to download ${isVideoOverlayMode ? "video" : "audio"} from YouTube — please check the URL and try again`,
            );
          }
          return resolved;
        })();

    let [audioFile, imagePaths] = await Promise.all([
      audioDownloadPromise,
      generateAllSegmentImages(timeline, imgDir, (done, total, desc) => {
        const pct = 8 + Math.round((done / total) * 52); // 8% → 60%
        emit("progress", {
          percent: pct,
          message: `Generating image ${done}/${total}: "${desc.slice(0, 50)}"…`,
        });
      }),
    ]);

    if (job.cancelled) throw new Error("Cancelled by user");

    // Trim audio to clip range when editing a specific clip.
    // Always re-encode to aac (-c:a aac) instead of -c:a copy, because YouTube
    // audio is often webm/opus and copying opus into an .aac container causes
    // FFmpeg to fail or produce corrupt audio.
    // Skip for video overlay mode — clip trimming is handled via -ss/-t in FFmpeg.
    if (
      !isVideoOverlayMode &&
      clipStartSec !== undefined &&
      clipEndSec !== undefined
    ) {
      const trimmedPath = join(BHAGWAT_TMP_DIR, `${tmpId}_audio_trimmed.aac`);
      await new Promise<void>((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-ss",
          String(clipStartSec),
          "-t",
          String(clipEndSec - clipStartSec),
          "-i",
          safeFsArg(audioFile),
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-y",
          trimmedPath,
        ]);
        let stderr = "";
        ff.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        ff.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(`Audio trim failed (${code}): ${stderr.slice(-300)}`),
              ),
        );
      });
      try {
        unlinkSync(audioFile);
      } catch {}
      audioFile = trimmedPath;
    }

    let totalGenerated = imagePaths
      .flat()
      .filter((p) => p && existsSync(p)).length;
    if (totalGenerated === 0) {
      emit("progress", {
        percent: 60,
        message: "AI image generation unavailable. Using fallback visuals…",
      });
      const fallbackPath = join(imgDir, "fallback.png");
      await new Promise<void>((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-f",
          "lavfi",
          "-i",
          "color=c=0x111111:s=1920x1080",
          "-frames:v",
          "1",
          "-y",
          fallbackPath,
        ]);
        let stderr = "";
        ff.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        ff.on("close", (code) => {
          if (code === 0 && existsSync(fallbackPath)) resolve();
          else
            reject(
              new Error(
                `Image generation failed and fallback frame creation failed (${code}): ${stderr.slice(-260)}`,
              ),
            );
        });
        ff.on("error", (err) => reject(err));
      });

      imagePaths = timeline.map(() => [fallbackPath]);
      totalGenerated = timeline.length;
    }

    emit("progress", {
      percent: 62,
      message: `${totalGenerated} images generated. Building video sequence…`,
    });

    // ── 3. Build clip list (image path + duration per display slot) ───────────
    interface Clip {
      imgPath: string;
      dur: number;
      startSec: number;
      endSec: number;
    }
    let clips: Clip[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const segDur = seg.endSec - seg.startSec;
      if (segDur <= 0) continue;
      const pool = imagePaths[i].filter((p) => p && existsSync(p));
      if (pool.length === 0) continue;

      if (pool.length === 1) {
        // Single image covers the whole segment
        clips.push({
          imgPath: pool[0],
          dur: segDur,
          startSec: seg.startSec,
          endSec: seg.endSec,
        });
      } else {
        // Multiple images — split segment into equal sub-clips (implements imageChangeEvery)
        const subDur = segDur / pool.length;
        for (let j = 0; j < pool.length; j++) {
          clips.push({
            imgPath: pool[j],
            dur: subDur,
            startSec: seg.startSec + j * subDur,
            endSec: seg.startSec + (j + 1) * subDur,
          });
        }
      }
    }

    // ── Gap filling (slideshow modes only) ────────────────────────────────────
    // In image-slideshow mode (full coverage or smart with uploaded audio),
    // fill gaps so the image track covers the full audio duration — otherwise
    // FFmpeg's -shortest flag cuts the audio when images run out.
    // In video overlay mode the original video covers all gaps, so skip this.
    if (!isVideoOverlayMode && videoDuration > 0 && clips.length > 0) {
      // For smart (uploaded audio) mode: fill gaps with a black frame.
      let blackImgPath: string | null = null;
      if (mode === "smart") {
        blackImgPath = join(imgDir, "black_gap.png");
        await new Promise<void>((resolve) => {
          const ff = spawn("ffmpeg", [
            "-f",
            "lavfi",
            "-i",
            "color=black:size=1920x1080:duration=1",
            "-vframes",
            "1",
            "-y",
            blackImgPath!,
          ]);
          ff.on("close", (code) => {
            if (code !== 0) blackImgPath = null;
            resolve();
          });
        });
      }

      clips.sort((a, b) => a.startSec - b.startSec);
      const filled: Clip[] = [];
      let cursor = 0;

      for (const clip of clips) {
        if (clip.startSec > cursor + 0.5) {
          const gapDur = clip.startSec - cursor;
          console.warn(
            `[bhagwat/render] Gap of ${gapDur.toFixed(2)}s detected between ${cursor.toFixed(2)}s and ${clip.startSec.toFixed(2)}s — filling with ${mode === "smart" && blackImgPath ? "black frame" : "previous image"}`
          );
          const gapImg =
            mode === "smart" && blackImgPath
              ? blackImgPath
              : filled.length > 0
                ? filled[filled.length - 1].imgPath
                : clip.imgPath;
          filled.push({
            imgPath: gapImg,
            dur: gapDur,
            startSec: cursor,
            endSec: clip.startSec,
          });
        }
        filled.push(clip);
        cursor = clip.endSec;
      }

      if (cursor < videoDuration - 0.5 && filled.length > 0) {
        const tailImg =
          mode === "smart" && blackImgPath
            ? blackImgPath
            : filled[filled.length - 1].imgPath;
        filled.push({
          imgPath: tailImg,
          dur: videoDuration - cursor,
          startSec: cursor,
          endSec: videoDuration,
        });
      }

      clips = filled;
    }

    if (clips.length === 0)
      throw new Error("Could not build image sequence from generated images");

    emit("progress", { percent: 65, message: "Rendering video with FFmpeg…" });

    // ── 4. FFmpeg render ───────────────────────────────────────────────────────
    const totalDuration = isVideoOverlayMode
      ? videoDuration || clips.reduce((s, c) => s + c.dur, 0)
      : clips.reduce((s, c) => s + c.dur, 0);
    job.filename = `bhagwat_${tmpId.slice(0, 6)}.mp4`;

    const SCALE =
      "scale=1920:1080:force_original_aspect_ratio=decrease," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=25";

    const ffArgs: string[] = [];

    if (isVideoOverlayMode) {
      // ── Video overlay mode: batched rendering to prevent OOM on long videos ──
      // Instead of loading all N images simultaneously into one FFmpeg call
      // (which crashes with 100+ images on 15-min videos), we split the video
      // into 2-minute segments. Each segment only loads its own ~15 images,
      // then all segment outputs are joined with stream copy (no re-encode).
      // Memory stays flat regardless of total clip count.

      const BATCH_SECS = 120; // 2-minute segments ≈ 15 clips max per FFmpeg call
      const sourceOffset = clipStartSec ?? 0;
      const outputDur =
        clipStartSec !== undefined && clipEndSec !== undefined
          ? clipEndSec - clipStartSec
          : totalDuration || videoDuration;

      const batchTmpPaths: string[] = [];
      let batchStart = 0;
      let batchNum = 0;
      const totalBatches = Math.ceil(outputDur / BATCH_SECS);

      // spawnBatch: runs one FFmpeg batch and emits granular within-batch progress.
      // pctStart/pctEnd bracket the portion of the overall 65-90% range this batch owns.
      // setAbort receives a kill function so the job can be cancelled mid-batch.
      const spawnBatch = (
        bArgs: string[],
        pctStart: number,
        pctEnd: number,
        batchLabel: string,
        segDur: number,
        setAbort?: (kill: (() => void) | undefined) => void,
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const ff = spawn("ffmpeg", bArgs);
          setAbort?.(() => ff.kill("SIGKILL"));
          let stderrBuf = "";
          let tailLines = "";
          const wd = setTimeout(() => {
            ff.kill("SIGKILL");
            reject(new Error("FFmpeg batch timed out after 15 minutes"));
          }, 15 * 60 * 1000);
          ff.stderr.on("data", (d: Buffer) => {
            const chunk = d.toString();
            tailLines = (tailLines + chunk).slice(-800); // keep last 800 chars for error reporting
            stderrBuf += chunk;
            // Parse FFmpeg's time= progress lines and convert to sub-batch percent
            const matches = stderrBuf.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
            if (matches) {
              const last = matches[matches.length - 1];
              const [, h, m, s] = last.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/)!;
              const cur = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
              const frac = segDur > 0 ? Math.min(1, cur / segDur) : 0;
              const pct = Math.round(pctStart + frac * (pctEnd - pctStart));
              emit("progress", {
                percent: pct,
                message: `Rendering ${batchLabel} (${formatTime(cur)}/${formatTime(segDur)})…`,
              });
              stderrBuf = ""; // reset so next parse only sees new chunks
            }
          });
          ff.on("close", (code) => {
            clearTimeout(wd);
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg batch failed (${code}): ${tailLines}`));
          });
        });

      while (batchStart < outputDur - 0.05) {
        const batchEnd = Math.min(batchStart + BATCH_SECS, outputDur);
        const batchDur = batchEnd - batchStart;
        const batchTmpPath = join(imgDir, `ovbatch_${batchNum}.mp4`);
        batchTmpPaths.push(batchTmpPath);

        // Clips that overlap this batch window (timestamps are relative to output start)
        const batchClips = clips.filter(
          (c) => c.endSec > batchStart && c.startSec < batchEnd,
        );

        // Each batch owns an equal slice of the 65–90% progress range
        const batchPctStart = 65 + Math.round((batchNum / totalBatches) * 25);
        const batchPctEnd   = 65 + Math.round(((batchNum + 1) / totalBatches) * 25);
        const batchLabel    = `segment ${batchNum + 1}/${totalBatches} (${formatTime(batchStart)}–${formatTime(batchEnd)})`;

        emit("progress", {
          percent: batchPctStart,
          message: `Rendering ${batchLabel}…`,
        });

        const bArgs: string[] = [
          "-ss", (sourceOffset + batchStart).toFixed(3),
          "-t", batchDur.toFixed(3),
          "-i", safeFsArg(audioFile),
        ];

        if (batchClips.length === 0) {
          // No overlays in this window — transcode the raw video segment but MUST enforce 1080p scale
          // so it concats safely with other 1080p batches.
          bArgs.push(
            "-vf", SCALE,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "192k",
            "-y", batchTmpPath,
          );
        } else {
          // Load each clip as a looped image scoped to this batch duration only
          const loopDur = batchDur + 2;
          for (const clip of batchClips) {
            bArgs.push("-loop", "1", "-t", loopDur.toFixed(3), "-i", clip.imgPath);
          }

          // Build filter: scale base video, scale each overlay, chain them
          const fParts: string[] = [];
          fParts.push(`[0:v]${SCALE}[base]`);
          for (let i = 0; i < batchClips.length; i++) {
            fParts.push(`[${i + 1}:v]${SCALE}[ov${i}]`);
          }
          let prevLabel = "base";
          for (let i = 0; i < batchClips.length; i++) {
            const clip = batchClips[i];
            // Timestamps relative to this batch's start so FFmpeg t=0 lines up
            const relStart = Math.max(0, clip.startSec - batchStart);
            const relEnd = Math.min(batchDur, clip.endSec - batchStart);
            const outLabel = i === batchClips.length - 1 ? "vout" : `chain${i}`;
            fParts.push(
              `[${prevLabel}][ov${i}]overlay=enable='between(t,${relStart.toFixed(3)},${relEnd.toFixed(3)})'[${outLabel}]`,
            );
            prevLabel = outLabel;
          }

          bArgs.push(
            "-filter_complex", fParts.join(";"),
            "-map", "[vout]",
            "-map", "0:a",
            "-t", batchDur.toFixed(3),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "192k",
            "-y", batchTmpPath,
          );
        }

        if (job.cancelled) throw new Error("Cancelled by user");
        await spawnBatch(
          bArgs, batchPctStart, batchPctEnd, batchLabel, batchDur,
          (kill) => { job.abort = kill; },
        );
        job.abort = undefined;
        batchNum++;
        batchStart = batchEnd;
      }

      // Join all batch segments with stream copy — no re-encode, near-instant
      emit("progress", { percent: 91, message: "Joining segments into final video…" });
      const batchConcatPath = join(imgDir, "batch_concat.txt");
      writeFileSync(
        batchConcatPath,
        batchTmpPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
      );
      await spawnBatch([
        "-f", "concat", "-safe", "0",
        "-i", batchConcatPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", outputPath,
      ], 91, 98, "final join", 1);

      // Clean up batch temp files
      for (const p of batchTmpPaths) {
        try { unlinkSync(p); } catch {}
      }
    } else if (clips.length === 1) {
      // ── Slideshow: single image — fade-in from black, fade-out to black ───────
      const dur = clips[0].dur;
      const FIRST_FADEIN = Math.min(3.0, dur * 0.4);
      const LAST_FADEOUT = Math.min(3.0, dur * 0.4);
      ffArgs.push(
        "-loop",
        "1",
        "-t",
        dur.toFixed(3),
        "-i",
        safeFsArg(clips[0].imgPath),
      );
      ffArgs.push("-i", safeFsArg(audioFile));
      ffArgs.push(
        "-vf",
        `${SCALE},fade=t=in:st=0:d=${FIRST_FADEIN.toFixed(3)}:enable='lte(t,${FIRST_FADEIN.toFixed(3)})',fade=t=out:st=${(dur - LAST_FADEOUT).toFixed(3)}:d=${LAST_FADEOUT.toFixed(3)}:enable='gte(t,${(dur - LAST_FADEOUT).toFixed(3)})'`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-y",
        outputPath,
      );
    } else {
      // ── Slideshow: multiple images ────────────────────────────────────────────
      // Uses the concat demuxer (reads one image at a time — constant memory
      // regardless of clip count). Fades are applied as chained FFmpeg `fade`
      // filter expressions using absolute timestamps.
      //
      // Each fade filter has an `enable` expression that confines it to its own
      // time window. Without `enable`, fade=t=out permanently holds brightness
      // at 0 after its end time — making every subsequent clip black. With
      // `enable`, the filter passes frames through unchanged outside its window.
      //
      // Fade timings:
      //   • up to 3 s fade-in from black at the very start
      //   • up to 1.2 s fade-to-black / fade-from-black at each clip boundary
      //   • up to 3 s fade-out to black at the very end

      const FIRST_FADEIN = Math.min(3.0, clips[0].dur * 0.4);
      const LAST_FADEOUT = Math.min(3.0, clips[clips.length - 1].dur * 0.4);
      // Between-clip fade: cap at 80% of the shortest clip so fades never overlap
      const FADE_DUR = Math.min(1.2, Math.min(...clips.map((c) => c.dur)) * 0.8);

      // Compute absolute start time of each clip in the concatenated stream
      const clipStarts: number[] = [];
      let cumT = 0;
      for (const clip of clips) {
        clipStarts.push(cumT);
        cumT += clip.dur;
      }
      const totalConcatDur = cumT;

      // Build chained fade filter string — each fade is time-gated with enable
      const fadeFilters: string[] = [];
      // Fade in from black at the start (active only during the fade window)
      fadeFilters.push(
        `fade=t=in:st=0:d=${FIRST_FADEIN.toFixed(3)}:enable='lte(t,${FIRST_FADEIN.toFixed(3)})'`,
      );
      // For each clip boundary: fade out then fade in (creates black flash between clips)
      for (let i = 0; i < clips.length - 1; i++) {
        const boundaryT = clipStarts[i] + clips[i].dur;
        const foSt = boundaryT - FADE_DUR;
        const fiEnd = boundaryT + FADE_DUR;
        fadeFilters.push(
          `fade=t=out:st=${foSt.toFixed(3)}:d=${FADE_DUR.toFixed(3)}:enable='between(t,${foSt.toFixed(3)},${boundaryT.toFixed(3)})'`,
        );
        fadeFilters.push(
          `fade=t=in:st=${boundaryT.toFixed(3)}:d=${FADE_DUR.toFixed(3)}:enable='between(t,${boundaryT.toFixed(3)},${fiEnd.toFixed(3)})'`,
        );
      }
      // Fade out to black at the very end (active only during the fade window)
      const lastFoSt = totalConcatDur - LAST_FADEOUT;
      fadeFilters.push(
        `fade=t=out:st=${lastFoSt.toFixed(3)}:d=${LAST_FADEOUT.toFixed(3)}:enable='gte(t,${lastFoSt.toFixed(3)})'`,
      );

      const vf = `${SCALE},${fadeFilters.join(",")}`;

      // Concat demuxer format (last file must be repeated without a duration)
      const concatLines: string[] = [];
      for (const clip of clips) {
        concatLines.push(`file '${clip.imgPath.replace(/'/g, "'\\''")}'`);
        concatLines.push(`duration ${clip.dur.toFixed(3)}`);
      }
      concatLines.push(
        `file '${clips[clips.length - 1].imgPath.replace(/'/g, "'\\''")}'`,
      );

      const concatListPath = join(imgDir, "concat.txt");
      writeFileSync(concatListPath, concatLines.join("\n"));

      ffArgs.push(
        "-f", "concat",
        "-safe", "0",
        "-i", safeFsArg(concatListPath),
        "-i", safeFsArg(audioFile),
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-y",
        outputPath,
      );
    }

    if (!isVideoOverlayMode) {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn("ffmpeg", ffArgs);
        job.abort = () => ff.kill("SIGKILL");
        let stderr = "";
        let resolved = false;

        // Watchdog: kill FFmpeg if it hangs for more than 30 minutes
        const watchdog = setTimeout(
          () => {
            if (!resolved) {
              ff.kill("SIGKILL");
              reject(new Error("FFmpeg timed out after 30 minutes"));
            }
          },
          30 * 60 * 1000,
        );

        ff.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
          const match = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
          if (match) {
            const last = match[match.length - 1];
            const [, h, m, s] = last.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/)!;
            const cur = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
            const pct =
              totalDuration > 0
                ? Math.min(98, 65 + Math.round((cur / totalDuration) * 33))
                : 80;
            emit("progress", {
              percent: pct,
              message: `Rendering… ${formatTime(cur)} / ${formatTime(totalDuration)}`,
            });
          }
        });
        ff.on("close", (code) => {
          resolved = true;
          clearTimeout(watchdog);
          job.abort = undefined;
          if (code === 0) {
            resolve();
          } else {
            const tail = stderr.slice(-600);
            const msg =
              code === null
                ? `FFmpeg was killed by the system (likely out of memory). Stderr: ${tail}`
                : `FFmpeg exited with code ${code}: ${tail}`;
            console.error("[bhagwat/render] FFmpeg failure details:\n", stderr.slice(-1200));
            reject(new Error(msg));
          }
        });
      });
    }

    // ── 5. Cleanup ────────────────────────────────────────────────────────────
    // Don't delete user-uploaded audio; only clean up yt-dlp downloads / trimmed files we created
    if (audioFile !== localAudioPath) {
      try {
        unlinkSync(audioFile);
      } catch {}
    }
    try {
      for (const f of readdirSync(imgDir))
        try {
          unlinkSync(join(imgDir, f));
        } catch {}
      rmdirSync(imgDir);
    } catch {}

    job.status = "done";
    job.outputPath = outputPath;
    persistRenderMeta(jobId, job);
    emit("progress", { percent: 100, message: "Video ready for download!" });
    emit("done", {
      downloadUrl: `/api/bhagwat/download/${jobId}`,
      filename: job.filename,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[bhagwat/render] Error:", message);
    job.status = "error";
    job.error = message;
    // Remove the "running" meta marker so this failure isn't later mistaken
    // for an "interrupted by restart" job after a real server restart.
    try { unlinkSync(renderMetaPath(jobId)); } catch {}
    emit("jobError", { message });
    try {
      for (const f of readdirSync(imgDir))
        try {
          unlinkSync(join(imgDir, f));
        } catch {}
      rmdirSync(imgDir);
    } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIO UPLOAD FEATURE
// ══════════════════════════════════════════════════════════════════════════════

// ── AssemblyAI transcription ──────────────────────────────────────────────────
interface AssemblyResult {
  transcript: string;     // SRT export — 25 chars/line, perfectly timed
  durationSec: number;
  languageCode: string;
  subtitleCount: number;  // number of SRT cue blocks
}

async function transcribeWithAssemblyAI(
  audioPath: string,
  onProgress: (msg: string) => void,
): Promise<AssemblyResult> {
  if (!process.env.ASSEMBLYAI_API_KEY)
    throw new Error("ASSEMBLYAI_API_KEY is not configured — add it in Secrets");

  const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

  // High-Precision Universal-2 configuration
  const config = {
    speech_model: "best" as const, // Universal-2 — highest accuracy
    // word_boost: ["Your", "Custom", "Words"], // Add domain-specific terms here for precision
    // boost_param: "high" as const,            // Uncomment to strongly boost the above words
    punctuate: true,
    format_text: true,
    speaker_labels: false, // disabled — not needed for image timeline
    auto_chapters: false,  // disabled — using SRT export instead
  };

  onProgress("Uploading audio to AssemblyAI…");
  const transcript = await client.transcripts.transcribe({
    audio: audioPath,
    ...config,
  });

  if (transcript.status === "error") {
    throw new Error(
      `AssemblyAI transcription failed: ${transcript.error ?? "unknown error"}`,
    );
  }

  onProgress("Exporting high-precision subtitles (25 chars/line)…");
  const durationSec = transcript.audio_duration ?? 0;

  // Official SRT subtitle export — 25 chars per caption = ~5 words per line, YouTube-style
  // Uses the AssemblyAI SDK's subtitle export (equivalent to exportSubtitlesSrt with chars_per_caption: 25)
  const srt = await client.transcripts.subtitles(transcript.id, "srt", 25);

  // Count subtitle cue blocks (each block starts with a digit line)
  const subtitleCount = (srt.match(/^\d+\s*$/gm) ?? []).length;

  return {
    transcript: srt,
    durationSec,
    languageCode: transcript.language_code ?? "en",
    subtitleCount,
  };
}

// ── runBhagwatAnalysisFromFile ────────────────────────────────────────────────
export async function runBhagwatAnalysisFromFile(
  jobId: string,
  job: AnalysisJob,
  audioId: string,
  mode: "smart" | "full",
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  const step = (
    s: string,
    status: "running" | "done" | "warn",
    message: string,
  ) => emit("step", { step: s, status, message });
  job.status = "running";

  try {
    if (!isAnyAIConfigured())
      throw new Error("No AI provider configured — add GEMINI_API_KEY in Secrets or enable the Gemini integration");

    const audio = uploadedAudios.get(audioId);
    if (!audio)
      throw new Error("Uploaded audio file not found — please upload again");

    // ── Step 1: File metadata ─────────────────────────────────────────────────
    step("metadata", "running", "Reading audio file…");
    let videoDuration = 0;
    const videoTitle = audio.originalName.replace(/\.[^.]+$/, "");

    try {
      const ffOut = await new Promise<string>((resolve, reject) => {
        const ff = spawn("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          safeFsArg(audio.path),
        ]);
        let out = "";
        ff.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });
        ff.on("error", reject);
        ff.on("close", (code) =>
          code === 0
            ? resolve(out.trim())
            : reject(new Error("ffprobe failed")),
        );
      });
      videoDuration = parseFloat(ffOut) || 0;
    } catch {}

    const fileSizeMB = Math.round(audio.sizeBytes / 1024 / 1024);
    step(
      "metadata",
      "done",
      `"${videoTitle}" · ${formatTime(videoDuration)} · ${fileSizeMB} MB`,
    );

    // ── Step 2: AssemblyAI transcription ──────────────────────────────────────
    step("transcript", "running", "Uploading to AssemblyAI for transcription…");
    let transcript = "";

    try {
      const result = await transcribeWithAssemblyAI(audio.path, (msg) => {
        step("transcript", "running", msg);
      });

      // Update duration from AssemblyAI (more accurate)
      if (result.durationSec > 0) videoDuration = result.durationSec;
      audio.durationSec = videoDuration;
      transcript = result.transcript;

      if (result.subtitleCount > 0) {
        step(
          "transcript",
          "done",
          `${result.subtitleCount} subtitle cues · Universal-2 · ${result.languageCode} · ${formatTime(videoDuration)}`,
        );
      } else {
        step(
          "transcript",
          "warn",
          "Transcript generated but no subtitle cues — AI will work from audio title",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bhagwat/analyze-audio] AssemblyAI error:", msg);
      step("transcript", "warn", `Transcription failed: ${msg.slice(0, 120)}`);
    }

    if (videoDuration === 0 && !transcript) {
      throw new Error(
        "Could not read audio file. Please ensure it is a valid audio format.",
      );
    }

    // ── Step 3: Gemini AI timeline ─────────────────────────────────────────────
    step(
      "ai",
      "running",
      "AI editor is reading the content and planning image placements…",
    );

    const compactTranscript = srtToCompact(transcript);
    const transcriptBlock =
      compactTranscript.length > 50
        ? `\nTranscript:\n${sampleTranscript(compactTranscript, 1000000)}`
        : "\n[No transcript — use audio title to infer content]";

    const systemInstruction = `You are a professional devotional video editor with deep knowledge of Shreemad Bhagwat Mahapuran, Bhagwat Katha, Ramayan, Mahabharat, and all Hindu devotional stories and bhajans. You are fully fluent in Hindi and English.

Your task: Listen to this audio (via transcript) exactly like an expert editor sitting at a timeline, and decide the best image to place at every moment. You must think like an editor: "what image best represents what the speaker is saying RIGHT NOW and from what time to which?"

HOW TO THINK ABOUT EACH SEGMENT:
1. STORY NARRATION (katha/leela): Break into SHORT, specific story beats of duration about 7–15 seconds each or if it varies then adjust accordingly dont rely on limitations provided. CRITICAL RULE: you are the best visual editor and capable to adjust segments durations best way but not too long that a segment covered up 2 by mistake so strictly work attentively. More segments = more visual variety = better video. Each segment gets ONE unique image prompt. Be specific — not "Lord Krishna" but "Lord Krishna as a young boy stealing butter from the pot, mother Yashoda watching, cozy village home in Vrindavan, traditional devotional painting style". Set imageChangeEvery to match the best segment duration.

2. BHAJAN / KIRTAN: Detect by repeated devotional phrases, song lyrics, musical patterns. For bhajans: calm meditative devotional imagery — peaceful deity imagery. Change images every 25–40 seconds. Mark isBhajan: true.

3. SHLOKA RECITATION: Sacred imagery — open scripture, deity. 

4. OPENING / CLOSING / TRANSITIONS: Auspicious imagery. 

IMAGE PROMPT RULES:
- Write in English even if transcript is Hindi
- Be specific and vivid: scene, characters, setting, lighting, mood
- Include style: "traditional devotional Indian painting", "realistic", etc.
- Do NOT include: watermarks, logos, borders, modern photography
- For deities: detailed description of appearance and scene

${
  mode === "full"
    ? `FULL COVERAGE MODE: Every second of the audio must be covered. No gaps. Start at 0 and end at exactly ${videoDuration}s.`
    : `SMART PLACEMENT MODE: Select only the most visually impactful segments of the audio. Leave significant gaps. Pick bhajans, climactic story moments, key leela moments, shloka recitations. Gaps of 30 seconds to several minutes are correct and intentional.`
}

RESPOND with ONLY a valid JSON array, no markdown fences:
[
  {
    "startSec": 0,
    "endSec": 120,
    "isBhajan": false,
    "imageChangeEvery": 12,
    "description": "Opening narration",
    "imagePrompt": "Peaceful riverside setting at dawn, devotees reading Shreemad Bhagwat, soft morning light, incense smoke, warm devotional atmosphere"
  }
]`;

    const userContent = `Audio: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${transcriptBlock}

${
  mode === "full"
    ? `Plan the COMPLETE image timeline covering every second from 0 to ${videoDuration}s with no gaps.`
    : `Select only the BEST moments for image placement ON THE VIDEO ALL BEST KEY AREAS. Leave some gaps between segments and you can think and edit best way as you want as a senior video editor.`
}`;

    const raw = (await geminiProContent(systemInstruction, userContent)).trim();

    let timeline: TimelineSegment[] = [];
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/im, "")
        .replace(/\s*```\s*$/im, "")
        .trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr
          .filter(
            (s: any) =>
              s &&
              typeof s.startSec === "number" &&
              typeof s.endSec === "number" &&
              s.endSec > s.startSec &&
              s.imagePrompt,
          )
          .map(
            (s: any): TimelineSegment => ({
              startSec: Math.max(0, s.startSec),
              endSec: Math.min(videoDuration || 999999, s.endSec),
              isBhajan: s.isBhajan === true,
              imageChangeEvery:
                s.isBhajan === true
                  ? Math.max(
                      20,
                      Math.min(40, Math.round(s.imageChangeEvery ?? 30)),
                    )
                  : Math.max(
                      8,
                      Math.min(12, Math.round(s.imageChangeEvery ?? 10)),
                    ),
              description: (s.description ?? "").slice(0, 150),
              imagePrompt: (s.imagePrompt ?? "").slice(0, 600),
            }),
          )
          .filter((s: TimelineSegment) => s.endSec > s.startSec + 1);
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0)
      throw new Error("AI returned an empty timeline — please try again");

    timeline.sort((a, b) => a.startSec - b.startSec);
    if (mode === "full" && videoDuration > 0) {
      if (timeline[0].startSec > 0) {
        timeline.unshift({
          startSec: 0,
          endSec: timeline[0].startSec,
          isBhajan: false,
          imageChangeEvery: 10,
          description: "Opening",
          imagePrompt:
            "Auspicious opening scene — ancient temple entrance, golden morning light, flowers and oil lamps, devotional atmosphere, traditional Indian painting style",
        });
      }
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        const seg =
          timeline[i].startSec < prev.endSec
            ? { ...timeline[i], startSec: prev.endSec }
            : timeline[i];
        if (seg.endSec <= seg.startSec + 1) continue;
        if (seg.startSec > prev.endSec)
          filled.push({
            startSec: prev.endSec,
            endSec: seg.startSec,
            isBhajan: false,
            imageChangeEvery: 10,
            description: "Continuation",
            imagePrompt: prev.imagePrompt,
          });
        filled.push(seg);
      }
      const last = filled[filled.length - 1];
      if (last.startSec < videoDuration) {
        last.endSec = videoDuration;
      } else {
        filled.pop();
      }
      timeline = filled;
    }

    step(
      "ai",
      "done",
      `${timeline.length} segments planned · ${timeline.filter((s) => s.isBhajan).length} bhajan sections`,
    );

    const resultData = {
      timeline,
      videoDuration,
      videoTitle,
      transcriptText: transcript,
    };
    job.status = "done";
    job.result = resultData;
    emit("done", resultData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[bhagwat/analyze-audio] Error:", message);
    job.status = "error";
    job.error = message;
    emit("jobError", { message });
  }
}

// ── Audio upload route ─────────────────────────────────────────────────────────
router.post("/bhagwat/upload-audio", (req: Request, res: Response) => {
  audioUpload.single("audio")(req as any, res as any, (err: any) => {
    if (err) {
      res.status(400).json({ error: err.message ?? "Upload failed" });
      return;
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }
    const audioId = randomUUID();
    uploadedAudios.set(audioId, {
      path: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      durationSec: 0,
      createdAt: Date.now(),
    });
    res.json({
      audioId,
      filename: file.originalname,
      sizeBytes: file.size,
      mimeType: file.mimetype,
    });
  });
});

// Delete uploaded audio
router.delete("/bhagwat/audio/:audioId", (req: Request, res: Response) => {
  const audioId = pickSafeBhagwatId(req.params.audioId);
  if (!audioId) {
    res.status(400).json({ error: "audioId is required" });
    return;
  }
  const audio = uploadedAudios.get(audioId);
  if (!audio) {
    res.status(404).json({ error: "Audio not found" });
    return;
  }
  try {
    unlinkSync(audio.path);
  } catch {}
  if (audio.s3Key) {
    void deleteS3Object(audio.s3Key);
  }
  uploadedAudios.delete(audioId);
  res.json({ ok: true });
});

// ── Analyze uploaded audio (uses same analysisJobs + SSE endpoint as YouTube) ─
router.post("/bhagwat/analyze-audio", (req: Request, res: Response) => {
  const { audioId, mode } = req.body as {
    audioId: string;
    mode?: "smart" | "full";
  };
  if (!audioId) {
    res.status(400).json({ error: "audioId is required" });
    return;
  }
  const audio = getBhagwatUploadedAudioState(audioId);
  if (!audio) {
    res
      .status(404)
      .json({ error: "Audio file not found — please upload again" });
    return;
  }
  const jobId = randomUUID();

  if (isBhagwatAnalyzeQueuePrimaryEnabled()) {
    void ensureBhagwatUploadedAudioS3Key(audioId, audio)
      .then(async (uploadS3Key) => {
        await submitYoutubeQueuePrimaryJob({
          jobId,
          jobType: "bhagwat-analyze",
          sourceUrl: `upload://bhagwat/${audioId}`,
          meta: {
            mode: mode ?? "full",
            sourceKind: "upload",
            audioId,
            uploadS3Key,
            originalFilename: audio.originalName,
            mimeType: audio.mimeType,
            sizeBytes: audio.sizeBytes,
          },
        });
        res.json({ jobId, status: "queued", message: "Bhagwat audio analysis queued" });
      })
      .catch((err) => {
        req.log.error({ err, audioId, jobId }, "Failed to queue Bhagwat audio analysis");
        res.status(502).json({
          error:
            err instanceof Error
              ? err.message
              : "Failed to queue Bhagwat audio analysis",
        });
      });
    return;
  }

  const job: AnalysisJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  createBhagwatAnalysisJobState(jobId, job);
  res.json({ jobId });
  runBhagwatAnalysisFromFile(jobId, job, audioId, mode ?? "full").catch(
    () => {},
  );
});

// ── Render with uploaded audio (reuses same renderJobs + SSE endpoint) ─────────
router.post("/bhagwat/render-audio", async (req: Request, res: Response) => {
  const { audioId, timeline, videoDuration, clipStartSec, clipEndSec, mode } =
    req.body as {
      audioId: string;
      timeline: TimelineSegment[];
      videoDuration?: number;
      clipStartSec?: number;
      clipEndSec?: number;
      mode?: "full" | "smart";
    };
  if (!audioId || !Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "audioId and timeline are required" });
    return;
  }
  const audio = getBhagwatUploadedAudioState(audioId);
  if (!audio) {
    res
      .status(404)
      .json({ error: "Audio file not found — please upload again" });
    return;
  }
  const jobId = randomUUID();

  if (isBhagwatRenderQueuePrimaryEnabled()) {
    try {
      const uploadS3Key = await ensureBhagwatUploadedAudioS3Key(audioId, audio);
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "bhagwat-render",
        sourceUrl: `upload://bhagwat/${audioId}`,
        meta: {
          timeline,
          videoDuration: videoDuration ?? 0,
          ...(typeof clipStartSec === "number" ? { clipStartSec } : {}),
          ...(typeof clipEndSec === "number" ? { clipEndSec } : {}),
          mode: mode ?? "full",
          sourceKind: "upload",
          audioId,
          uploadS3Key,
          originalFilename: audio.originalName,
          mimeType: audio.mimeType,
          sizeBytes: audio.sizeBytes,
        },
      });
      res.json({ jobId, status: "queued", message: "Bhagwat audio render queued" });
      return;
    } catch (err) {
      req.log.error({ err, audioId, jobId }, "Failed to queue Bhagwat audio render");
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : "Failed to queue Bhagwat audio render",
      });
      return;
    }
  }

  const MAX_CONCURRENT_RENDERS = 3;
  const activeRenders = [...renderJobs.values()].filter(
    j => j.status === "pending" || j.status === "running",
  ).length;
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    res.status(429).json({ error: `Server is busy with ${activeRenders} active render(s). Please wait a moment and try again.` });
    return;
  }

  const job: RenderJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
    title: audio.originalName.replace(/\.[^.]+$/, ""),
  };
  createBhagwatRenderJobState(jobId, job);
  res.json({ jobId });
  runBhagwatRender(
    jobId,
    job,
    "",
    timeline,
    videoDuration ?? 0,
    clipStartSec,
    clipEndSec,
    audio.path,
    mode ?? "full",
  ).catch((err) => {
    req.log.error({ err, jobId }, "[bhagwat] background render-audio failed");
  });
});

export default router;



