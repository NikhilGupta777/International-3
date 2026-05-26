// Pita Ji long-video audio pipeline (Phase 3).
//
// For videos longer than the 40-minute YouTube-direct threshold, we cannot
// rely on Gemini watching the full video — we download just the audio,
// split it into 2 or 3 overlapping chunks (depending on total duration),
// and feed each chunk to Vertex Gemini 2.5 Flash via `inlineData`.
//
// All steps run inside the API Lambda:
//
//   1. yt-dlp -x --audio-format m4a → /tmp/<jobId>/full.m4a
//   2. ffmpeg per chunk: -ss <offset> -t <length> -ac 1 -ar 16000 -b:a 24k -c:a aac
//      → /tmp/<jobId>/chunk-N.m4a   (mono, 24 kbps — well under the 20 MB
//      Vertex inline-data cap, even for an 80-minute slice)
//   3. base64 → Vertex Gemini 2.5 Flash via inlineData (the route caller
//      drives this part — see analyzeAudioChunkInline in pitaji-analysis.ts)
//
// We re-use the same cookie + yt-dlp env conventions as routes/timestamps.ts
// (YTDLP_BIN, YTDLP_COOKIES_FILE, YTDLP_PROXY) but keep this module
// completely self-contained so it never breaks the existing routes if any
// of them change.

import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import ffmpegStatic from "ffmpeg-static";
// ffprobe-static ships JS without declarations — declare the minimal shape.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - no types
import ffprobeStaticUntyped from "ffprobe-static";
const ffprobeStatic = ffprobeStaticUntyped as { path?: string };
import { logger } from "./logger";
import { readTextFromS3 } from "./s3-storage";

// ── Constants — match timestamps.ts / subtitles.ts conventions ───────────────

const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();

function buildPythonEnv(root: string): NodeJS.ProcessEnv {
  const bin = join(root, ".pythonlibs", "bin");
  const lib = join(root, ".pythonlibs", "lib");
  if (!existsSync(bin)) return { ...process.env };
  let site = join(lib, "python3.11", "site-packages");
  try {
    const py = readdirSync(lib).find((e) => /^python3\.\d+$/.test(e));
    if (py) site = join(lib, py, "site-packages");
  } catch {
    /* ignore */
  }
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONPATH: site,
  };
}

const PYTHON_ENV = buildPythonEnv(_workspaceRoot);
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  (process.platform === "win32"
    ? ""
    : ["/usr/local/bin/yt-dlp", "/opt/bin/yt-dlp", "/var/task/bin/yt-dlp"].find(existsSync) ?? "");
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE || join(_workspaceRoot, ".yt-cookies.txt");
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";

const PITAJI_TMP_ROOT = process.env.PITAJI_TMP_ROOT ?? "/tmp/pitaji";

// Audio split config.
export const PITAJI_AUDIO_OVERLAP_SEC = Math.max(
  0,
  Math.min(120, Number.parseInt(process.env.PITAJI_AUDIO_OVERLAP_SEC ?? "30", 10) || 30),
);
export const PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN = Math.max(
  1,
  Number.parseInt(process.env.PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN ?? "40", 10) || 40,
);
export const PITAJI_AUDIO_CHUNK_3_THRESHOLD_MIN = Math.max(
  PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN + 1,
  Number.parseInt(process.env.PITAJI_AUDIO_CHUNK_3_THRESHOLD_MIN ?? "120", 10) || 120,
);

const PITAJI_YTDLP_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PITAJI_YTDLP_TIMEOUT_MS ?? "600000", 10) || 600_000,
);

const PITAJI_FFMPEG_BIN = (() => {
  const fromEnv = (process.env.FFMPEG_BIN ?? "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (ffmpegStatic && typeof ffmpegStatic === "string" && existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  // Fall back to PATH lookup at exec time.
  return "ffmpeg";
})();

const PITAJI_FFPROBE_BIN = (() => {
  const fromEnv = (process.env.FFPROBE_BIN ?? "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (ffprobeStatic?.path && existsSync(ffprobeStatic.path)) return ffprobeStatic.path;
  return "ffprobe";
})();

// ── Cookie hydration (kept independent so it never collides with the other
//    routes' singletons; same S3 key, same on-disk path) ──────────────────────

let _cookiesLoaded = false;
let _cookiesLoading: Promise<void> | null = null;

type BrowserCookie = {
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  session?: unknown;
  expirationDate?: unknown;
  name?: unknown;
  value?: unknown;
  hostOnly?: unknown;
};

function cookiesToNetscape(list: BrowserCookie[]): string | null {
  const lines: string[] = [];
  for (const c of list) {
    const domain = typeof c.domain === "string" ? c.domain.trim() : "";
    const name = typeof c.name === "string" ? c.name.trim() : "";
    const value = typeof c.value === "string" ? c.value : "";
    if (!domain || !name) continue;
    const dl = domain.toLowerCase();
    if (!dl.includes("youtube") && !dl.includes("google") && !dl.includes("yt")) continue;
    const include = c.hostOnly === false ? "TRUE" : "FALSE";
    const secure = c.secure === true ? "TRUE" : "FALSE";
    const exp = typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : 0;
    lines.push(`${domain}\t${include}\t${typeof c.path === "string" ? c.path : "/"}\t${secure}\t${exp}\t${name}\t${value}`);
  }
  return lines.length ? `# Netscape HTTP Cookie File\n\n${lines.join("\n")}\n` : null;
}

function decodeCookiesPayload(raw: string): string | null {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) return null;
  let decoded = trimmedRaw;
  try {
    decoded = Buffer.from(trimmedRaw, "base64").toString("utf8").trim();
  } catch {
    decoded = trimmedRaw;
  }
  if (!decoded) return null;
  if (
    decoded.startsWith("# Netscape HTTP Cookie File") ||
    decoded.startsWith(".youtube.com") ||
    decoded.includes("\t")
  ) {
    return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
  }
  try {
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded) as { cookies?: BrowserCookie[] };
      if (Array.isArray(parsed.cookies)) return cookiesToNetscape(parsed.cookies);
    }
    if (decoded.startsWith("[")) {
      const parsed = JSON.parse(decoded) as BrowserCookie[];
      if (Array.isArray(parsed)) return cookiesToNetscape(parsed);
    }
  } catch {
    return null;
  }
  return null;
}

async function ensureCookiesLoaded(): Promise<void> {
  if (_cookiesLoaded) return;
  if (_cookiesLoading) return _cookiesLoading;
  _cookiesLoading = (async () => {
    try {
      if (!YTDLP_COOKIES_S3_KEY) return;
      if (existsSync(YTDLP_COOKIES_FILE)) return;
      const netscape = decodeCookiesPayload(await readTextFromS3(YTDLP_COOKIES_S3_KEY));
      if (!netscape) return;
      const cookieDir = dirname(YTDLP_COOKIES_FILE);
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      writeFileSync(YTDLP_COOKIES_FILE, netscape, "utf8");
      logger.info("[pitaji-audio] Cookies loaded from S3");
    } catch (err) {
      logger.warn({ err }, "[pitaji-audio] Cookie load failed — continuing without cookies");
    } finally {
      _cookiesLoaded = true;
    }
  })();
  return _cookiesLoading;
}

function getCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE || !existsSync(YTDLP_COOKIES_FILE)) return [];
  try {
    const st = statSync(YTDLP_COOKIES_FILE);
    if (!st.isFile() || st.size < 24) return [];
    const hdr = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (!hdr.startsWith("# Netscape HTTP Cookie File") && !hdr.startsWith(".youtube.com")) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch {
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AudioChunk {
  /** Absolute path to the chunk file inside /tmp. */
  path: string;
  /** Chunk start offset in the original full-length audio, in seconds. */
  offsetSec: number;
  /** Length of this chunk in seconds (overlap included). */
  durationSec: number;
  /** Index in the chunks array, 1-based, useful for progress reporting. */
  index: number;
  /** Total number of chunks for this job. */
  total: number;
  /** mimeType to send to Vertex when uploading inline. */
  mimeType: string;
}

/**
 * Decide how many chunks to split into based on the user's configured
 * thresholds (default: 1 chunk if < 40 min, 2 if 40–120, 3 if > 120).
 */
export function pickChunkCount(durationSec: number): number {
  const minutes = durationSec / 60;
  if (minutes <= PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN) return 1;
  if (minutes <= PITAJI_AUDIO_CHUNK_3_THRESHOLD_MIN) return 2;
  return 3;
}

/**
 * Compute even (with overlap) chunk windows over a total duration. The first
 * chunk always starts at 0; the last chunk always ends at `totalDurationSec`.
 *
 * For N chunks with overlap O:
 *   step = (totalDurationSec + (N-1)*O) / N
 *   chunk i: start = max(0, i*step - i*O)   end = min(total, start + step)
 *
 * In practice we ensure adjacent chunks overlap by exactly O seconds so a
 * Q&A spanning the cut is captured by both sides; the analysis prompt is
 * told the chunk's offset so it can return chunk-relative timestamps and
 * the caller re-bases them.
 */
export function planChunkWindows(
  totalDurationSec: number,
  chunkCount: number,
  overlapSec = PITAJI_AUDIO_OVERLAP_SEC,
): Array<{ offsetSec: number; durationSec: number }> {
  if (chunkCount <= 1) {
    return [{ offsetSec: 0, durationSec: Math.max(1, Math.floor(totalDurationSec)) }];
  }
  const N = chunkCount;
  const O = Math.max(0, Math.min(overlapSec, Math.floor(totalDurationSec / (N + 1))));
  const baseLen = Math.floor((totalDurationSec + (N - 1) * O) / N);

  const windows: Array<{ offsetSec: number; durationSec: number }> = [];
  for (let i = 0; i < N; i += 1) {
    const start = Math.max(0, i * (baseLen - O));
    const end = i === N - 1
      ? Math.floor(totalDurationSec)
      : Math.min(Math.floor(totalDurationSec), start + baseLen);
    windows.push({ offsetSec: start, durationSec: Math.max(1, end - start) });
  }
  return windows;
}

/**
 * Make sure /tmp/pitaji/<jobId>/ exists for storing intermediate files.
 */
export function ensureJobTmpDir(jobId: string): string {
  const dir = join(PITAJI_TMP_ROOT, jobId.replace(/[^A-Za-z0-9_-]/g, "_"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Best-effort cleanup. Always called in a finally block.
 */
export function cleanupJobTmpDir(jobId: string): void {
  const dir = join(PITAJI_TMP_ROOT, jobId.replace(/[^A-Za-z0-9_-]/g, "_"));
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, dir }, "[pitaji-audio] Cleanup failed");
  }
}

/**
 * Run yt-dlp to extract the audio of a YouTube video to `outPath` as m4a.
 *
 * We deliberately do NOT include the full bot-detection retry chain here
 * (kept in the route files) — Pita Ji operators have cookies configured,
 * which is the most reliable path. If yt-dlp fails the analyze flow surfaces
 * the error to the user.
 */
export async function downloadAudioToTmp(params: {
  youtubeUrl: string;
  outPath: string;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}): Promise<void> {
  const { youtubeUrl, outPath, signal, onProgress } = params;
  await ensureCookiesLoaded();

  const cookieArgs = getCookieArgs();
  const baseArgs = [
    "--retries", "3",
    "--extractor-retries", "3",
    "--socket-timeout", "30",
    "--no-warnings",
    "--no-playlist",
    "-x",
    "--audio-format", "m4a",
    "-o", outPath,
    ...(YTDLP_PROXY ? ["--proxy", YTDLP_PROXY] : []),
    ...cookieArgs,
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "--add-headers",
    [
      "Accept-Language:en-US,en;q=0.9",
      "Referer:https://www.youtube.com/",
      "Origin:https://www.youtube.com",
    ].join(";"),
    youtubeUrl,
  ];

  const command = YTDLP_BIN || PYTHON_BIN;
  const cmdArgs = YTDLP_BIN ? baseArgs : ["-m", "yt_dlp", ...baseArgs];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, cmdArgs, { env: PYTHON_ENV });
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let aborted = false;

    timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    }, PITAJI_YTDLP_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (onProgress) {
        for (const line of s.split(/\r?\n/)) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      }
    });
    proc.stdout?.on("data", (d: Buffer) => {
      if (onProgress) {
        for (const line of d.toString().split(/\r?\n/)) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      }
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new Error("Audio download cancelled"));
        return;
      }
      if (timedOut) {
        reject(new Error(`Audio download timed out after ${Math.round(PITAJI_YTDLP_TIMEOUT_MS / 1000)} seconds`));
        return;
      }
      if (code === 0 && existsSync(outPath)) {
        resolve();
      } else {
        reject(new Error(stderr.slice(-600) || `yt-dlp exited ${code}`));
      }
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/**
 * Run ffprobe to read the duration in seconds of a media file.
 */
export async function probeAudioDurationSec(filePath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(PITAJI_FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nokey=1:noprint_wrappers=1",
      filePath,
    ]);
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.slice(-400) || `ffprobe exited ${code}`));
        return;
      }
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
    proc.on("error", reject);
  });
}

/**
 * Cut a single chunk from `inPath` into `outPath` using ffmpeg, re-encoding
 * to mono 24 kbps AAC so each chunk stays well under Vertex's 20 MB inline-
 * data limit even at ~80-minute window lengths.
 */
async function ffmpegCutChunk(params: {
  inPath: string;
  outPath: string;
  startSec: number;
  durationSec: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { inPath, outPath, startSec, durationSec, signal } = params;
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-ss", String(Math.max(0, Math.floor(startSec))),
      "-t", String(Math.max(1, Math.floor(durationSec))),
      "-i", inPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "24k",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outPath,
    ];
    const proc = spawn(PITAJI_FFMPEG_BIN, args);
    let stderr = "";
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new Error("Audio split cancelled"));
        return;
      }
      if (code === 0 && existsSync(outPath)) resolve();
      else reject(new Error(stderr.slice(-400) || `ffmpeg exited ${code}`));
    });
    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/**
 * Plan + cut audio into N chunks. Returns the chunk descriptors in order.
 * Each chunk is a self-contained m4a file at ~24 kbps mono.
 */
export async function splitAudioIntoChunks(params: {
  inPath: string;
  outDir: string;
  totalDurationSec: number;
  chunkCount: number;
  overlapSec?: number;
  signal?: AbortSignal;
  onChunkReady?: (chunk: AudioChunk) => void;
}): Promise<AudioChunk[]> {
  const overlap = params.overlapSec ?? PITAJI_AUDIO_OVERLAP_SEC;
  const windows = planChunkWindows(params.totalDurationSec, params.chunkCount, overlap);
  const out: AudioChunk[] = [];
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    const outPath = join(params.outDir, `chunk-${i + 1}.m4a`);
    await ffmpegCutChunk({
      inPath: params.inPath,
      outPath,
      startSec: w.offsetSec,
      durationSec: w.durationSec,
      signal: params.signal,
    });
    const chunk: AudioChunk = {
      path: outPath,
      offsetSec: w.offsetSec,
      durationSec: w.durationSec,
      index: i + 1,
      total: windows.length,
      mimeType: "audio/mp4",
    };
    out.push(chunk);
    params.onChunkReady?.(chunk);
  }
  return out;
}

/**
 * Best-effort delete of a single file inside the job's tmp dir.
 */
export function tryUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}
