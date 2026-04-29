import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { setupSse } from "../lib/sse";
import { spawn, execFileSync } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  statSync,
  createReadStream,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { join, dirname, basename } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { GoogleGenAI } from "@google/genai";
import ffmpegStatic from "ffmpeg-static";
import {
  cleanupOldS3Objects,
  deleteS3Object,
  getS3StorageConfig,
  readTextFromS3,
  getS3SignedDownloadUrl,
  isS3StorageEnabled,
  uploadFileToS3,
} from "../lib/s3-storage";
import { logger } from "../lib/logger";
import {
  getNotifyClientKey,
  notifyClientPush,
} from "../lib/push-notifications";
import {
  cancelYoutubeQueueJob,
  getYoutubeQueueJobStatus,
  isYoutubeQueueEnabledFor,
  isYoutubeQueuePrimaryEnabledFor,
  submitYoutubeQueuePrimaryJob,
  submitYoutubeQueueShadowJob,
} from "../lib/youtube-queue";

const router: IRouter = Router();

// Use Replit's built-in GOOGLE_API_KEY as fallback when GEMINI_API_KEY is not set
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
}

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
const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  (process.platform === "win32"
    ? ""
    : ["/usr/local/bin/yt-dlp", "/opt/bin/yt-dlp", "/var/task/bin/yt-dlp"].find(
        (candidate) => existsSync(candidate),
      ) ?? "");
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE || join(_workspaceRoot, ".yt-cookies.txt");
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";

// Optional HTTP/SOCKS proxy for yt-dlp (critical for cloud/datacenter IPs blocked by YouTube).
// Set YTDLP_PROXY=socks5://user:pass@host:port  or  http://host:port
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const IS_QUEUE_WORKER_CONTEXT = !!(
  process.env.JOB_PAYLOAD || process.env.QUEUE_MODE
);
const RAW_YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";
const LOCAL_BGUTIL_PROVIDER_RE = /^https?:\/\/bgutil-provider(?::\d+)?\/?$/i;
const YTDLP_POT_PROVIDER_URL =
  IS_QUEUE_WORKER_CONTEXT &&
  LOCAL_BGUTIL_PROVIDER_RE.test(RAW_YTDLP_POT_PROVIDER_URL)
    ? ""
    : RAW_YTDLP_POT_PROVIDER_URL;
if (
  IS_QUEUE_WORKER_CONTEXT &&
  RAW_YTDLP_POT_PROVIDER_URL &&
  !YTDLP_POT_PROVIDER_URL
) {
  logger.warn(
    { potProviderUrl: RAW_YTDLP_POT_PROVIDER_URL },
    "Ignoring local bgutil provider URL inside queue worker context",
  );
}

// Optional po_token + visitor_data pair to bypass YouTube bot-detection on server IPs.
// Generate with: https://github.com/iv-org/youtube-trusted-session-generator
// Then set: YTDLP_PO_TOKEN=<token>  and  YTDLP_VISITOR_DATA=<data>
const YTDLP_PO_TOKEN = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const HAS_DYNAMIC_POT_PROVIDER = !!YTDLP_POT_PROVIDER_URL;
const HAS_STATIC_PO_TOKEN = !!(YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA);

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

function cookiesToNetscape(cookieList: ExportedBrowserCookie[]): string | null {
  const lines: string[] = [];
  for (const cookie of cookieList) {
    const domainRaw = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
    const nameRaw = typeof cookie.name === "string" ? cookie.name.trim() : "";
    const valueRaw = typeof cookie.value === "string" ? cookie.value : "";
    if (!domainRaw || !nameRaw) continue;
    const domainLower = domainRaw.toLowerCase();
    const keepCookie =
      domainLower.includes("youtube.com") ||
      domainLower.includes("youtu.be") ||
      domainLower.includes("google.com") ||
      domainLower.includes("googlevideo.com");
    if (!keepCookie) continue;

    const path = typeof cookie.path === "string" && cookie.path.trim() ? cookie.path.trim() : "/";
    const includeSubdomains =
      cookie.hostOnly === true || !domainRaw.startsWith(".") ? "FALSE" : "TRUE";
    const secure = cookie.secure === true ? "TRUE" : "FALSE";
    const isSession = cookie.session === true;
    const expiry =
      !isSession && typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)
        ? String(Math.floor(cookie.expirationDate))
        : "0";
    lines.push(
      `${domainRaw}\t${includeSubdomains}\t${path}\t${secure}\t${expiry}\t${nameRaw}\t${valueRaw}`,
    );
  }
  if (lines.length === 0) return null;
  return `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
}

function decodeCookiesFromBase64(base64Value: string): string | null {
  const decoded = Buffer.from(base64Value, "base64").toString("utf8");
  const trimmed = decoded.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith("# Netscape HTTP Cookie File") ||
    trimmed.startsWith(".youtube.com") ||
    trimmed.includes("\t")
  ) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }
  if (trimmed.startsWith("{")) {
    const parsedObj = JSON.parse(trimmed) as { cookies?: ExportedBrowserCookie[] };
    if (Array.isArray(parsedObj.cookies)) {
      return cookiesToNetscape(parsedObj.cookies);
    }
  }
  if (trimmed.startsWith("[")) {
    const parsedList = JSON.parse(trimmed) as ExportedBrowserCookie[];
    if (Array.isArray(parsedList)) {
      return cookiesToNetscape(parsedList);
    }
  }
  return null;
}

// YTDLP_COOKIES_BASE64: base64-encoded Netscape cookie file content.
// Export cookies from a YouTube-logged-in browser using a cookie exporter extension,
// then base64-encode the file: base64 -w 0 cookies.txt
// Set this env var on your server — no file upload required.
const YTDLP_COOKIES_BASE64 = process.env.YTDLP_COOKIES_BASE64 ?? "";
if (YTDLP_COOKIES_BASE64) {
  try {
    const cookieContent = decodeCookiesFromBase64(YTDLP_COOKIES_BASE64);
    if (cookieContent) {
      const cookieDir = dirname(YTDLP_COOKIES_FILE);
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      writeFileSync(YTDLP_COOKIES_FILE, cookieContent, "utf8");
      console.log("[yt-dlp] Loaded cookies from YTDLP_COOKIES_BASE64 env var");
    } else {
      console.warn("[yt-dlp] YTDLP_COOKIES_BASE64 set but cookie payload could not be converted to Netscape format — skipping");
    }
  } catch (e) {
    console.error("[yt-dlp] Failed to decode YTDLP_COOKIES_BASE64:", e);
  }
}

let ensureYtdlpCookiesPromise: Promise<void> | null = null;

async function ensureYtdlpCookiesLoaded(): Promise<void> {
  if (!YTDLP_COOKIES_S3_KEY) return;
  if (existsSync(YTDLP_COOKIES_FILE)) {
    const cookieArgs = getYtdlpCookieArgs();
    if (cookieArgs.length > 0) return;
  }

  if (!ensureYtdlpCookiesPromise) {
    ensureYtdlpCookiesPromise = (async () => {
      try {
        const encoded = (await readTextFromS3(YTDLP_COOKIES_S3_KEY)).trim();
        if (!encoded) return;
        const cookieContent = decodeCookiesFromBase64(encoded);
        if (!cookieContent) {
          logger.warn(
            { key: YTDLP_COOKIES_S3_KEY },
            "S3 cookie payload could not be converted to Netscape format",
          );
          return;
        }
        const cookieDir = dirname(YTDLP_COOKIES_FILE);
        if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
        writeFileSync(YTDLP_COOKIES_FILE, cookieContent, "utf8");
        logger.info(
          { key: YTDLP_COOKIES_S3_KEY },
          "Loaded yt-dlp cookies from S3",
        );
      } catch (err) {
        logger.warn({ err, key: YTDLP_COOKIES_S3_KEY }, "Failed to load yt-dlp cookies from S3");
      }
    })().finally(() => {
      ensureYtdlpCookiesPromise = null;
    });
  }

  await ensureYtdlpCookiesPromise;
}

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Clean up files older than 3 hours every 30 minutes (auto-delete fires at 2h, this is a safety net)
const MAX_FILE_AGE_MS = 3 * 60 * 60 * 1000;
function cleanupOldFiles() {
  try {
    const now = Date.now();
    const entries = readdirSync(DOWNLOAD_DIR);
    for (const entry of entries) {
      const filePath = join(DOWNLOAD_DIR, entry);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
          if (stat.isDirectory()) {
            rmSync(filePath, { recursive: true, force: true });
          } else {
            unlinkSync(filePath);
          }
        }
      } catch {}
    }
  } catch {}
}
setInterval(cleanupOldFiles, 30 * 60 * 1000);
cleanupOldFiles();
if (isS3StorageEnabled()) {
  void cleanupOldS3Objects({
    namespace: "youtube/downloads",
    maxAgeMs: MAX_FILE_AGE_MS,
  }).catch((err) => {
    logger.warn({ err }, "Failed initial S3 stale cleanup (youtube/downloads)");
  });
  void cleanupOldS3Objects({
    namespace: "youtube/clips",
    maxAgeMs: MAX_FILE_AGE_MS,
  }).catch((err) => {
    logger.warn({ err }, "Failed initial S3 stale cleanup (youtube/clips)");
  });
  setInterval(() => {
    void cleanupOldS3Objects({
      namespace: "youtube/downloads",
      maxAgeMs: MAX_FILE_AGE_MS,
    }).catch((err) => {
      logger.warn({ err }, "Failed S3 stale cleanup (youtube/downloads)");
    });
    void cleanupOldS3Objects({
      namespace: "youtube/clips",
      maxAgeMs: MAX_FILE_AGE_MS,
    }).catch((err) => {
      logger.warn({ err }, "Failed S3 stale cleanup (youtube/clips)");
    });
  }, 30 * 60 * 1000);
}

// Auto-delete a job's file 2 hours after it's ready
const AUTO_DELETE_MS = 2 * 60 * 60 * 1000;
function scheduleAutoDelete(
  jobId: string,
  jobRef: DownloadJob,
) {
  setTimeout(() => {
    void (async () => {
      if (jobRef.filePath) {
        try {
          unlinkSync(jobRef.filePath);
        } catch {}
        jobRef.filePath = null;
      }
      if (jobRef.s3Key) {
        await deleteS3Object(jobRef.s3Key);
        jobRef.s3Key = null;
      }
      jobRef.status = "expired";
      setTimeout(() => jobs.delete(jobId), 60_000);
    })();
  }, AUTO_DELETE_MS);
}

interface VideoFormatOut {
  formatId: string;
  ext: string;
  resolution: string;
  fps: number | null;
  filesize: number | null;
  vcodec: string | null;
  acodec: string | null;
  quality: string;
  label: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface DownloadJob {
  status:
    | "pending"
    | "downloading"
    | "merging"
    | "done"
    | "error"
    | "expired"
    | "cancelled";
  percent: number | null;
  speed: string | null;
  eta: string | null;
  filename: string | null;
  filesize: number | null;
  message: string | null;
  filePath: string | null;
  s3Key?: string | null;
  url: string;
  formatId: string;
  audioOnly: boolean;
  ext: string;
  clipStart?: number;
  clipEnd?: number;
  clipQuality?: string;
  cancelled?: boolean;
  activeProc?: ReturnType<typeof spawn> | null;
  notifyClientKey?: string | null;
}

const jobs = new Map<string, DownloadJob>();
const CANCELLED_BY_USER = "Cancelled by user";
const isDownloadQueueEnabled = (): boolean =>
  isYoutubeQueueEnabledFor("download") || isYoutubeQueueEnabledFor("clip-cut");

async function storeJobOutputInS3(
  jobId: string,
  jobRef: DownloadJob,
  finalPath: string,
  namespace: "youtube/downloads" | "youtube/clips",
): Promise<void> {
  const finalFilename = basename(finalPath) || `${jobId}.${jobRef.ext}`;
  const stats = statSync(finalPath);
  jobRef.filesize = stats.size;
  jobRef.filename = finalFilename;

  if (!isS3StorageEnabled()) {
    jobRef.filePath = finalPath;
    jobRef.s3Key = null;
    return;
  }

  jobRef.message = "Uploading to cloud storage...";
  jobRef.percent = Math.max(jobRef.percent ?? 0, 99);
  const uploaded = await uploadFileToS3({
    localPath: finalPath,
    jobId,
    namespace,
    filename: finalFilename,
  });
  jobRef.s3Key = uploaded.key;
  jobRef.filePath = null;
  try {
    unlinkSync(finalPath);
  } catch {}
}

function pushCompletionNotification(
  jobRef: DownloadJob,
  title: string,
  body: string,
  tag: string,
): void {
  void notifyClientPush(jobRef.notifyClientKey, {
    title,
    body,
    url: "/",
    tag,
    silent: false,
  });
}

function pushFailureNotification(
  jobRef: DownloadJob,
  title: string,
  body: string,
  tag: string,
): void {
  void notifyClientPush(jobRef.notifyClientKey, {
    title,
    body,
    url: "/",
    tag,
    silent: true,
  });
}

type QueuedClipJob = {
  jobId: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

const MAX_CONCURRENT_CLIP_JOBS = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_CLIP_JOBS ?? "3", 10) || 3,
);
let activeClipJobCount = 0;
const queuedClipJobs: QueuedClipJob[] = [];
const queuedClipJobIds = new Set<string>();

function updateQueuedClipJobMessages(): void {
  queuedClipJobs.forEach((entry, index) => {
    const job = jobs.get(entry.jobId);
    if (!job || job.cancelled) return;
    job.status = "pending";
    job.message =
      index === 0 && activeClipJobCount < MAX_CONCURRENT_CLIP_JOBS
        ? "Queued - starting soon..."
        : `Queued (#${index + 1})`;
  });
}

function drainQueuedClipJobs(): void {
  while (
    activeClipJobCount < MAX_CONCURRENT_CLIP_JOBS &&
    queuedClipJobs.length > 0
  ) {
    const next = queuedClipJobs.shift()!;
    queuedClipJobIds.delete(next.jobId);
    const job = jobs.get(next.jobId);
    if (!job || job.cancelled) {
      next.reject(new Error(CANCELLED_BY_USER));
      updateQueuedClipJobMessages();
      continue;
    }

    activeClipJobCount += 1;
    job.message = "Starting clip job...";

    Promise.resolve()
      .then(next.run)
      .then(() => next.resolve())
      .catch((err) =>
        next.reject(err instanceof Error ? err : new Error("Clip job failed")),
      )
      .finally(() => {
        activeClipJobCount = Math.max(0, activeClipJobCount - 1);
        updateQueuedClipJobMessages();
        drainQueuedClipJobs();
      });
  }
}

function enqueueClipJob(jobId: string, run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queuedClipJobs.push({
      jobId,
      run,
      resolve,
      reject: (err: Error) => reject(err),
    });
    queuedClipJobIds.add(jobId);
    updateQueuedClipJobMessages();
    drainQueuedClipJobs();
  });
}

function dequeueClipJob(jobId: string): boolean {
  const index = queuedClipJobs.findIndex((entry) => entry.jobId === jobId);
  if (index === -1) return false;
  const [entry] = queuedClipJobs.splice(index, 1);
  queuedClipJobIds.delete(jobId);
  entry.reject(new Error(CANCELLED_BY_USER));
  updateQueuedClipJobMessages();
  return true;
}

function pickFirst(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type RateWindow = { count: number; resetAt: number };
const rateWindows = new Map<string, RateWindow>();
const RATE_LIMIT_WINDOW_MS = 3 * 60 * 1000;
const RATE_LIMITS: Record<string, number> = {
  "POST /youtube/clip-cut": 3,
  "POST /youtube/download-clip": 3,
  "POST /youtube/download": 3,
  "POST /youtube/clips": 3,
  "POST /youtube/cancel/:jobId": 180, // 60/min
};
const RATE_LIMIT_BYPASS_IPS = new Set(
  (process.env.RATE_LIMIT_BYPASS_IPS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
);

function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function getClientIp(req: Request): string {
  const cfConnectingIp = req.headers["cf-connecting-ip"];
  const xRealIp = req.headers["x-real-ip"];
  const forwarded = req.headers["x-forwarded-for"];
  const firstCf = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
  const firstReal = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
  const firstForwarded = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(",")[0];
  const ip =
    firstCf?.trim() ||
    firstReal?.trim() ||
    firstForwarded?.trim() ||
    req.ip ||
    req.socket.remoteAddress ||
    "unknown";
  return normalizeIp(ip);
}

function createIpRateLimiter(routeKey: keyof typeof RATE_LIMITS) {
  const max = RATE_LIMITS[routeKey];
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    if (RATE_LIMIT_BYPASS_IPS.has(ip)) {
      next();
      return;
    }

    const now = Date.now();
    const key = `${routeKey}|${ip}`;
    const current = rateWindows.get(key);
    if (!current || now >= current.resetAt) {
      rateWindows.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      next();
      return;
    }

    if (current.count >= max) {
      const minutesLeft = Math.max(
        1,
        Math.ceil((current.resetAt - now) / (60 * 1000)),
      );
      res
        .status(429)
        .json({
          error: `Rate limit exceeded. Try again in ${minutesLeft} minutes.`,
        });
      return;
    }

    current.count += 1;
    rateWindows.set(key, current);
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, window] of rateWindows.entries()) {
    if (now >= window.resetAt) {
      rateWindows.delete(key);
    }
  }
}, 60 * 1000);

const clipCutRateLimiter = createIpRateLimiter("POST /youtube/clip-cut");
const legacyDownloadClipRateLimiter = createIpRateLimiter(
  "POST /youtube/download-clip",
);
const downloadRateLimiter = createIpRateLimiter("POST /youtube/download");
const clipsRateLimiter = createIpRateLimiter("POST /youtube/clips");
const cancelRateLimiter = createIpRateLimiter("POST /youtube/cancel/:jobId");
const LAMBDA_CLIP_MAX_DURATION_SECONDS = Number(
  process.env.LAMBDA_CLIP_MAX_DURATION_SECONDS ?? 8 * 60,
);
const DEFAULT_VIDEO_FORMAT_SELECTOR =
  "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/" +
  "bestvideo[ext=mp4]+bestaudio[ext=m4a]/" +
  "bestvideo[vcodec!=none]+bestaudio[acodec!=none]/" +
  "best[ext=mp4][vcodec!=none][acodec!=none]/" +
  "best[vcodec!=none][acodec!=none]";

function shouldRunClipInLambda(startTime: number, endTime: number): boolean {
  const duration = endTime - startTime;
  return (
    Number.isFinite(LAMBDA_CLIP_MAX_DURATION_SECONDS) &&
    LAMBDA_CLIP_MAX_DURATION_SECONDS > 0 &&
    duration <= LAMBDA_CLIP_MAX_DURATION_SECONDS
  );
}

function normalizeVideoDownloadFormat(formatId: string | undefined): string {
  const requested = formatId?.trim();
  if (!requested) return DEFAULT_VIDEO_FORMAT_SELECTOR;
  if (requested === "bestvideo+bestaudio/best") return DEFAULT_VIDEO_FORMAT_SELECTOR;
  if (requested === "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best") {
    return DEFAULT_VIDEO_FORMAT_SELECTOR;
  }
  return requested;
}

function hasAllowedOutputExtension(filePath: string, allowedExts: string[]): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return !!ext && allowedExts.includes(ext);
}

// Base args applied to every yt-dlp call.
// Keep extractor client selection on yt-dlp defaults for best compatibility.
const BASE_YTDLP_ARGS: string[] = [
  // Retry on network errors and rate-limits
  "--retries", "5",
  "--fragment-retries", "5",
  "--extractor-retries", "5",
  // Prevent infinite hangs on slow/broken connections
  "--socket-timeout", "30",
  // Enable JavaScript challenge solving via Node.js (yt-dlp 2026.03.17+ requires EJS
  // to decode YouTube signatures; default only enables Deno which is not installed here).
  // bun is added as a lower-priority fallback since it is also installed in this env.
  "--js-runtimes", "node",
  "--js-runtimes", "bun",
  // Allow yt-dlp to fetch the latest EJS challenge solver script from GitHub.
  // The script is cached on first download; subsequent runs use the cache.
  "--remote-components", "ejs:github",
  // Browser-like headers to avoid bot detection
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  // Full Chrome-like user agent
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// Resolve ffmpeg: prefer the system binary (NixOS/Replit has a full ffmpeg on PATH
// that is more stable than the bundled ffmpeg-static which can segfault on NixOS).
function findFfmpeg(): string | null {
  try {
    const p = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    if (p) { console.log(`[ffmpeg] Using system ffmpeg: ${p}`); return p; }
  } catch {}
  if (ffmpegStatic) { console.log(`[ffmpeg] Using ffmpeg-static: ${ffmpegStatic}`); return ffmpegStatic; }
  return null;
}
const FFMPEG_PATH = findFfmpeg();
const BUNDLED_FFPROBE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
);
const FFPROBE_STATIC_PATH =
  existsSync(BUNDLED_FFPROBE_PATH)
    ? BUNDLED_FFPROBE_PATH
    : null;

function ensureYtdlpFfmpegLocation(): string | null {
  if (!FFMPEG_PATH) return null;

  try {
    const systemProbe = execFileSync("which", ["ffprobe"], { encoding: "utf8" }).trim();
    if (systemProbe) return dirname(FFMPEG_PATH);
  } catch {}

  if (!FFPROBE_STATIC_PATH) return FFMPEG_PATH;

  const binDir = join(tmpdir(), "ytgrabber-ffmpeg-bin");
  mkdirSync(binDir, { recursive: true });
  const ffmpegTarget = join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobeTarget = join(binDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

  if (!existsSync(ffmpegTarget)) copyFileSync(FFMPEG_PATH, ffmpegTarget);
  if (!existsSync(ffprobeTarget)) copyFileSync(FFPROBE_STATIC_PATH, ffprobeTarget);
  try {
    chmodSync(ffmpegTarget, 0o755);
    chmodSync(ffprobeTarget, 0o755);
  } catch {}
  return binDir;
}

if (FFMPEG_PATH) {
  const ffmpegLocation = ensureYtdlpFfmpegLocation();
  if (ffmpegLocation) BASE_YTDLP_ARGS.push("--ffmpeg-location", ffmpegLocation);
}

// Inject proxy if configured (essential for AWS/cloud IPs blocked by YouTube)
if (YTDLP_PROXY) {
  BASE_YTDLP_ARGS.push("--proxy", YTDLP_PROXY);
}

if (HAS_DYNAMIC_POT_PROVIDER) {
  BASE_YTDLP_ARGS.push(
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`,
  );
}

function getDefaultYouTubeExtractorArgs(): string[] {
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
  // Browser cookies are tied to the web client session.
  // Use web as primary when cookies are present — this authenticates properly and bypasses bot checks.
  const hasCookies = existsSync(YTDLP_COOKIES_FILE);
  if (hasCookies) {
    return [
      "--extractor-args",
      "youtube:player_client=web,web_embedded,tv_embedded",
    ];
  }
  return [
    "--extractor-args",
    "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless",
  ];
}

function getYouTubeFallbacks(): string[][] {
  if (HAS_DYNAMIC_POT_PROVIDER || HAS_STATIC_PO_TOKEN) {
    return [
      ["--extractor-args", "youtube:player_client=web,web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=mweb,ios"],
      ["--extractor-args", "youtube:player_client=ios"],
      ["--extractor-args", "youtube:player_client=android_vr"],
    ];
  }
  const hasCookies = existsSync(YTDLP_COOKIES_FILE);
  if (hasCookies) {
    // Web-first fallback order when cookies are available (browser cookies authenticate with the web client).
    return [
      ["--extractor-args", "youtube:player_client=web"],
      ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=tv_embedded,android_vr"],
      ["--extractor-args", "youtube:player_client=tv_embedded"],
      ["--extractor-args", "youtube:player_client=android_vr"],
      ["--extractor-args", "youtube:player_client=mweb"],
      ["--extractor-args", "youtube:player_client=ios"],
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

function getYtdlpCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE) return [];
  if (!existsSync(YTDLP_COOKIES_FILE)) return [];
  try {
    const stat = statSync(YTDLP_COOKIES_FILE);
    if (!stat.isFile() || stat.size < 24) return [];
    const header = readFileSync(YTDLP_COOKIES_FILE, "utf8")
      .slice(0, 256)
      .trimStart();
    // yt-dlp expects Netscape cookie format; ignore placeholder/invalid files.
    if (
      !header.startsWith("# Netscape HTTP Cookie File") &&
      !header.startsWith(".youtube.com")
    ) {
      return [];
    }
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch {
    return [];
  }
}

function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function isYouTubeBlockedError(message: string): boolean {
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|sign.*in.*your age|age.*restrict|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|video.*unavailable|this video is unavailable|precondition.*failed|http error 401|requested format is not available|format.*not available|not made this video available|not available in your country|geo.*restrict/i.test(
    message,
  );
}

function getUserFriendlyYtError(message: string): string {
  if (/not made this video available|not available in your country|geo.*restrict|available in.*india|available in.*[a-z]+\./i.test(message)) {
    const countryMatch = message.match(/available in ([^.\n]+)/i);
    const country = countryMatch ? countryMatch[1].trim() : "certain countries";
    return `This video is geo-restricted (only available in ${country}) and cannot be accessed from our servers. Try a different video.`;
  }
  if (/sign in to confirm|confirm.*not a bot|bot.*detect/i.test(message)) {
    return "YouTube is blocking server access to this video. Try again later or try a different video.";
  }
  if (/age.*restrict|sign.*in.*your age/i.test(message)) {
    return "This video is age-restricted and requires sign-in to access.";
  }
  if (/private video|video is private/i.test(message)) {
    return "This video is private and cannot be accessed.";
  }
  if (/video.*unavailable|this video is unavailable/i.test(message)) {
    return "This video is unavailable or has been removed.";
  }
  if (/http error 429|too many requests|rate.?limit/i.test(message)) {
    return "YouTube is rate-limiting our server. Please wait a moment and try again.";
  }
  if (/requested format is not available|format.*not available/i.test(message)) {
    return "Could not find a compatible video format. Please try again.";
  }
  return "Failed to fetch video information";
}

function runYtDlpOnce(extraArgs: string[], args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = YTDLP_BIN || PYTHON_BIN;
    const commandArgs = YTDLP_BIN
      ? [...BASE_YTDLP_ARGS, ...extraArgs, ...args]
      : ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...extraArgs, ...args];
    const proc = spawn(command, commandArgs, {
      env: PYTHON_ENV,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`),
        );
    });
    proc.on("error", (err) =>
      reject(new Error(`Failed to start yt-dlp: ${err.message}`)),
    );
  });
}

async function runYtDlp(args: string[]): Promise<string> {
  await ensureYtdlpCookiesLoaded();
  const maybeUrl = [...args].reverse().find((v) => /^https?:\/\//i.test(v));
  const cookieArgs = getYtdlpCookieArgs();
  const isYt = !!(maybeUrl && isYouTubeUrl(maybeUrl));
  const defaultYoutubeArgs = isYt ? getDefaultYouTubeExtractorArgs() : [];

  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);
  if (!isYt) {
    attemptPlans.length = 0;
    if (cookieArgs.length) attemptPlans.push(cookieArgs);
    attemptPlans.push([]);
  }

  // Fallback player clients ordered by reliability on AWS/GCP datacenter IPs.
  // tv_embedded (YouTube TV embedded player) is least bot-checked on server IPs.
  // android_vr, mweb, ios are secondary options. web requires po_token on server IPs.
  const youtubeFallbacks: string[][] = getYouTubeFallbacks();

  let lastErr: Error | null = null;
  const attempted = new Set<string>();

  for (const extra of attemptPlans) {
    const key = extra.join("\u0001");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      return await runYtDlpOnce(extra, args);
    } catch (err) {
      lastErr =
        err instanceof Error ? err : new Error("yt-dlp failed unexpectedly");
      // If this is not a YouTube block scenario, fail fast.
      if (
        !maybeUrl ||
        !isYouTubeUrl(maybeUrl) ||
        !isYouTubeBlockedError(lastErr.message)
      ) {
        throw lastErr;
      }
    }
  }

  // Only try extractor fallback strategies if we are in a YouTube block scenario.
  if (isYt && lastErr) {
    for (const fallback of youtubeFallbacks) {
      const plans = cookieArgs.length
        ? [[...cookieArgs, ...fallback], fallback]
        : [fallback];
      for (const extra of plans) {
        const key = extra.join("\u0001");
        if (attempted.has(key)) continue;
        attempted.add(key);
        try {
          return await runYtDlpOnce(extra, args);
        } catch (err) {
          lastErr =
            err instanceof Error ? err : new Error("yt-dlp fallback failed");
        }
      }
    }
  }

  throw lastErr ?? new Error("yt-dlp failed");
}

function scoreYtFormat(fmt: any): number {
  const hasVideo = fmt?.vcodec && fmt.vcodec !== "none" ? 1 : 0;
  const hasAudio = fmt?.acodec && fmt.acodec !== "none" ? 1 : 0;
  const height = Number(fmt?.height ?? 0);
  const width = Number(fmt?.width ?? 0);
  const fps = Number(fmt?.fps ?? 0);
  const filesize = Number(
    fmt?.filesize ?? fmt?.filesize_approx ?? 0,
  );
  return (
    height * 1_000_000 +
    width * 1_000 +
    fps * 10 +
    hasVideo * 5 +
    hasAudio * 5 +
    Math.min(filesize, 9_999_999)
  );
}

function mergeSubtitleMaps(
  baseMap: Record<string, any> | undefined,
  incomingMap: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!baseMap && !incomingMap) return undefined;
  return {
    ...(baseMap ?? {}),
    ...(incomingMap ?? {}),
  };
}

function mergeMetadataCandidates(candidates: any[]): any {
  if (candidates.length === 0) {
    throw new Error("No metadata candidates to merge");
  }

  const richest = [...candidates].sort((a, b) => {
    const aCount = Array.isArray(a?.formats) ? a.formats.length : 0;
    const bCount = Array.isArray(b?.formats) ? b.formats.length : 0;
    return bCount - aCount;
  })[0];

  const formatMap = new Map<string, any>();
  for (const candidate of candidates) {
    for (const fmt of candidate?.formats ?? []) {
      const key = String(fmt?.format_id ?? "");
      if (!key) continue;
      const prev = formatMap.get(key);
      if (!prev || scoreYtFormat(fmt) > scoreYtFormat(prev)) {
        formatMap.set(key, fmt);
      }
    }
  }

  return {
    ...richest,
    id: richest?.id ?? candidates[0]?.id,
    title:
      candidates.find((c) => c?.title)?.title ??
      richest?.title ??
      candidates[0]?.title,
    duration:
      candidates.find((c) => c?.duration != null)?.duration ??
      richest?.duration ??
      candidates[0]?.duration,
    thumbnail:
      candidates.find((c) => c?.thumbnail)?.thumbnail ??
      richest?.thumbnail ??
      candidates[0]?.thumbnail,
    thumbnails:
      candidates.find((c) => Array.isArray(c?.thumbnails) && c.thumbnails.length)
        ?.thumbnails ??
      richest?.thumbnails ??
      candidates[0]?.thumbnails,
    uploader:
      candidates.find((c) => c?.uploader)?.uploader ??
      richest?.uploader ??
      candidates[0]?.uploader,
    channel:
      candidates.find((c) => c?.channel)?.channel ??
      richest?.channel ??
      candidates[0]?.channel,
    view_count:
      candidates.find((c) => c?.view_count != null)?.view_count ??
      richest?.view_count ??
      candidates[0]?.view_count,
    upload_date:
      candidates.find((c) => c?.upload_date)?.upload_date ??
      richest?.upload_date ??
      candidates[0]?.upload_date,
    description:
      candidates.find((c) => c?.description)?.description ??
      richest?.description ??
      candidates[0]?.description,
    subtitles: candidates.reduce(
      (acc, candidate) => mergeSubtitleMaps(acc, candidate?.subtitles),
      undefined as Record<string, any> | undefined,
    ),
    automatic_captions: candidates.reduce(
      (acc, candidate) =>
        mergeSubtitleMaps(acc, candidate?.automatic_captions),
      undefined as Record<string, any> | undefined,
    ),
    formats: [...formatMap.values()],
  };
}

async function runYtDlpMetadata(url: string): Promise<any> {
  const cached = getCachedMeta(url);
  if (cached) return JSON.parse(cached);
  const raw = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
  setCachedMeta(url, raw);
  return JSON.parse(raw);
}

// Fetch a URL and return its body as a string
function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    let data = "";
    const req = get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Subtitle fetch timed out"));
    });
  });
}

// Pick the best subtitle URL from yt-dlp dump-json subtitle maps
function pickBestSubtitleUrl(
  subtitles: Record<string, any[]>,
  automaticCaptions: Record<string, any[]>,
  videoLanguage?: string,
  preferredLanguage?: string,
): string | null {
  const findVttUrl = (tracks: any[]): string | null => {
    if (!Array.isArray(tracks)) return null;
    // Prefer explicit VTT ext, then URL containing fmt=vtt
    const vtt =
      tracks.find((t: any) => t.ext === "vtt") ??
      tracks.find(
        (t: any) => typeof t.url === "string" && t.url.includes("fmt=vtt"),
      );
    return vtt?.url ?? null;
  };

  // Language priority: detected video language first, then Hindi variants, then English, then anything
  const preferredLangs = [
    ...(preferredLanguage ? [preferredLanguage, `${preferredLanguage}-orig`] : []),
    ...(videoLanguage ? [videoLanguage] : []),
    "hi",
    "hi-IN",
    "hi-Latn",
    "hi-orig",
    "en",
    "en-US",
    "en-GB",
    "en-orig",
  ];

  // 1) Manual subtitles (highest quality)
  for (const lang of preferredLangs) {
    if (subtitles[lang]?.length) {
      const u = findVttUrl(subtitles[lang]);
      if (u) return u;
    }
  }
  // Any manual subtitle language
  for (const tracks of Object.values(subtitles)) {
    if (tracks?.length) {
      const u = findVttUrl(tracks);
      if (u) return u;
    }
  }

  // 2) Auto-generated captions
  for (const lang of preferredLangs) {
    if (automaticCaptions[lang]?.length) {
      const u = findVttUrl(automaticCaptions[lang]);
      if (u) return u;
    }
  }
  // Any auto-caption language
  for (const tracks of Object.values(automaticCaptions)) {
    if (tracks?.length) {
      const u = findVttUrl(tracks);
      if (u) return u;
    }
  }
  return null;
}

// Subtitle-safe yt-dlp args with default client selection and anti-bot
// headers/retry settings.
const SUBS_YTDLP_ARGS = [
  "--retries", "3",
  "--extractor-retries", "3",
  "--socket-timeout", "30",
  // JavaScript challenge solving — required since yt-dlp 2026.03.17
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

// Run yt-dlp for subtitle-only fetches (uses mweb/android — tv_embedded breaks subs)
function runYtDlpForSubs(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    void ensureYtdlpCookiesLoaded().then(() => {
      const cookieArgs = getYtdlpCookieArgs();
      const command = YTDLP_BIN || PYTHON_BIN;
      const commandArgs = YTDLP_BIN
        ? [...SUBS_YTDLP_ARGS, ...cookieArgs, ...args]
        : ["-m", "yt_dlp", ...SUBS_YTDLP_ARGS, ...cookieArgs, ...args];
      const proc = spawn(command, commandArgs, {
        env: PYTHON_ENV,
      });
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(stderr.slice(-800) || `yt-dlp subs exited ${code}`));
    });
    proc.on("error", (err) =>
      reject(new Error(`Failed to start yt-dlp: ${err.message}`)),
    );
    }).catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com")) {
      const watchId = u.searchParams.get("v");
      if (watchId) return watchId;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") {
        return parts[1] ?? null;
      }
    } else if (host.includes("youtu.be")) {
      const first = u.pathname.split("/").filter(Boolean)[0];
      return first ?? null;
    }
  } catch {}
  return null;
}

function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const candidate =
    /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const u = new URL(candidate);
    if (!isYouTubeUrl(candidate)) return candidate;
    const videoId = extractVideoId(candidate);
    if (!videoId) return candidate;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return trimmed;
  }
}

function estimateFilesize(fmt: any, duration: number | null): number | null {
  if (fmt.filesize) return fmt.filesize;
  if (fmt.filesize_approx) return fmt.filesize_approx;
  // Estimate from total bitrate × duration: tbr is in kbps
  if (fmt.tbr && duration) return Math.round(((fmt.tbr * 1000) / 8) * duration);
  return null;
}

function buildFormats(
  ytFormats: any[],
  duration?: number | null,
): VideoFormatOut[] {
  const qualityOrder: Record<number, number> = {
    2160: 10,
    1440: 9,
    1080: 8,
    720: 7,
    480: 6,
    360: 5,
    240: 4,
    144: 3,
  };

  const videoAudioFormats: VideoFormatOut[] = [];
  const mergeFormats: VideoFormatOut[] = [];
  let audioFormat: VideoFormatOut | null = null;

  // Single set tracks ALL heights that have been assigned a format card
  const seenHeights = new Set<number>();

  // Find best audio itag for merging
  const bestAudioFmt =
    ytFormats
      .filter(
        (f) => f.acodec !== "none" && f.vcodec === "none" && f.ext === "m4a",
      )
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0] ??
    ytFormats.find((f) => f.acodec !== "none" && f.vcodec === "none");

  // Codec preference: prefer H.264 (AVC) > VP9 > AV1 > other
  // This ensures that when multiple formats exist at the same height,
  // we pick the most compatible one (H.264 plays on virtually every device).
  function codecPriority(vcodec: string | null): number {
    if (!vcodec || vcodec === "none") return 99;
    if (vcodec.startsWith("avc1") || vcodec.startsWith("avc")) return 0;
    if (vcodec.startsWith("vp9") || vcodec.startsWith("vp09")) return 1;
    if (vcodec.startsWith("av01") || vcodec.startsWith("av1")) return 2;
    return 3;
  }

  const sortedFormats = [...ytFormats].sort((a, b) => {
    const heightDiff = (b.height ?? 0) - (a.height ?? 0);
    if (heightDiff !== 0) return heightDiff;
    return codecPriority(a.vcodec) - codecPriority(b.vcodec);
  });

  for (const fmt of sortedFormats) {
    const hasVideo = fmt.vcodec !== "none" && !!fmt.vcodec;
    const hasAudio = fmt.acodec !== "none" && !!fmt.acodec;
    const height: number | null = fmt.height ?? null;

    if (hasVideo && hasAudio) {
      // Combined format (e.g., itag 18, 22) — deduplicate by height
      if (height && seenHeights.has(height)) continue;
      if (height) seenHeights.add(height);

      const qual = height ? `${height}p` : (fmt.format_note ?? "unknown");
      videoAudioFormats.push({
        formatId: fmt.format_id,
        ext: fmt.ext ?? "mp4",
        resolution: height ? `${fmt.width ?? "?"}x${height}` : qual,
        fps: fmt.fps ?? null,
        filesize: estimateFilesize(fmt, duration ?? null),
        vcodec: fmt.vcodec ?? null,
        acodec: fmt.acodec ?? null,
        quality: qual,
        label: `${qual} (video+audio)`,
        hasVideo: true,
        hasAudio: true,
      });
    } else if (hasVideo && !hasAudio) {
      // Video-only: offer as merge with best audio — skip if height already covered
      if (!height) continue;
      if (seenHeights.has(height)) continue;
      seenHeights.add(height);

      const qual = `${height}p`;
      const audioItag = bestAudioFmt?.format_id;
      const mergeId = audioItag
        ? `${fmt.format_id}+${audioItag}`
        : `${fmt.format_id}+bestaudio`;
      mergeFormats.push({
        formatId: mergeId,
        ext: "mp4",
        resolution: `${fmt.width ?? "?"}x${height}`,
        fps: fmt.fps ?? null,
        filesize: estimateFilesize(fmt, duration ?? null),
        vcodec: fmt.vcodec ?? null,
        acodec: "aac",
        quality: qual,
        label: `${qual} (merged, best quality)`,
        hasVideo: true,
        hasAudio: true,
      });
    }
  }

  // Best audio-only (MP3)
  if (bestAudioFmt) {
    const bitrateKbps = bestAudioFmt.abr
      ? `${Math.round(bestAudioFmt.abr)}kbps`
      : "best";
    audioFormat = {
      formatId: `audio:${bestAudioFmt.format_id}`,
      ext: "mp3",
      resolution: "audio only",
      fps: null,
      filesize: estimateFilesize(bestAudioFmt, duration ?? null),
      vcodec: null,
      acodec: "mp3",
      quality: bitrateKbps,
      label: `Audio Only (MP3 ${bitrateKbps})`,
      hasVideo: false,
      hasAudio: true,
    };
  }

  const sortFn = (a: VideoFormatOut, b: VideoFormatOut) => {
    const aH = parseInt(a.quality) || 0;
    const bH = parseInt(b.quality) || 0;
    return (qualityOrder[bH] ?? bH) - (qualityOrder[aH] ?? aH);
  };

  return [
    ...videoAudioFormats.sort(sortFn),
    ...mergeFormats.sort(sortFn),
    ...(audioFormat ? [audioFormat] : []),
  ];
}

// ─── Diagnostics endpoint ─────────────────────────────────────────────────
// GET /api/youtube/diagnostics — shows yt-dlp config and what bypass methods
// are active. Use this to debug bot-detection issues without SSH access.
router.get("/youtube/diagnostics", async (_req: Request, res: Response) => {
  const hasCookies = getYtdlpCookieArgs().length > 0;
  const hasCookiesBase64 = !!YTDLP_COOKIES_BASE64;
  const hasProxy = !!YTDLP_PROXY;
  const hasPoToken = HAS_STATIC_PO_TOKEN;
  const hasPotProvider = HAS_DYNAMIC_POT_PROVIDER;

  let ytdlpVersion = "unknown";
  try {
    ytdlpVersion = await new Promise<string>((resolve) => {
      const verCommand = YTDLP_BIN || PYTHON_BIN;
      const verArgs = YTDLP_BIN ? ["--version"] : ["-m", "yt_dlp", "--version"];
      const proc = spawn(verCommand, verArgs, { env: PYTHON_ENV });
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", () => resolve(out.trim() || "unknown"));
      proc.on("error", () => resolve("unknown"));
    });
  } catch {}

  const activeClient = hasPotProvider
    ? "web+web_embedded (dynamic pot provider mode)"
    : hasPoToken
    ? "web+web_embedded (static po_token mode)"
    : "tv_embedded,android_vr,mweb (server-IP mode)";
  const storage = getS3StorageConfig();

  res.json({
    ytdlpVersion,
    activeClient,
    bypassMethods: {
      cookies: hasCookies,
      cookiesFromEnvVar: hasCookiesBase64,
      proxy: hasProxy,
      poToken: hasPoToken,
      potProvider: hasPotProvider,
    },
    proxy: hasProxy ? YTDLP_PROXY.replace(/:([^@:]+)@/, ":***@") : null,
    potProviderUrl: hasPotProvider ? YTDLP_POT_PROVIDER_URL : null,
    recommendations: [
      ...(!hasCookies ? ["Set YTDLP_COOKIES_BASE64 with base64-encoded YouTube cookies (most reliable fix for AWS IPs)"] : []),
      ...(!hasPotProvider && !hasPoToken ? ["Set YTDLP_POT_PROVIDER_URL and install bgutil-ytdlp-pot-provider for dynamic YouTube PO tokens"] : []),
      ...(!hasPotProvider && !hasPoToken ? ["Or set YTDLP_PO_TOKEN + YTDLP_VISITOR_DATA from youtube-trusted-session-generator"] : []),
      ...(!hasProxy ? ["Or set YTDLP_PROXY to route through a residential/non-datacenter IP"] : []),
      ...(!storage.enabled
        ? ["Set S3_BUCKET to store completed downloads in S3 and serve via signed URLs"]
        : []),
    ],
    cookieFilePath: YTDLP_COOKIES_FILE,
    cookieFileExists: existsSync(YTDLP_COOKIES_FILE),
    storage,
  });
});

router.get("/youtube/client-access", (_req: Request, res: Response) => {
  res.json({
    downloadInputEnabled: true,
    telegram: {
      url: "https://t.me/c/2852263933/3",
      message: "For High Quality Fast Video Download, join this Telegram Group",
    },
  });
});

router.post("/youtube/info", async (req: Request, res: Response) => {
  const { url } = req.body as { url: string };
  const normalizedUrl = normalizeInputUrl(url ?? "");

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  if (
    !extractVideoId(normalizedUrl) &&
    !normalizedUrl.includes("youtube.com") &&
    !normalizedUrl.includes("youtu.be")
  ) {
    res.status(400).json({
      error:
        "Invalid YouTube URL. Use a link like https://www.youtube.com/watch?v=...",
    });
    return;
  }

  try {
    const data = await runYtDlpMetadata(normalizedUrl);

    const formats = buildFormats(data.formats ?? [], data.duration ?? null);

    const thumbnail =
      data.thumbnail ??
      (Array.isArray(data.thumbnails)
        ? data.thumbnails[data.thumbnails.length - 1]?.url
        : null) ??
      null;

    res.json({
      id: data.id,
      title: data.title ?? "Unknown Title",
      duration: data.duration ?? null,
      thumbnail,
      uploader: data.uploader ?? data.channel ?? null,
      viewCount: data.view_count ?? null,
      uploadDate: data.upload_date ?? null,
      description: (data.description ?? "").slice(0, 500) || null,
      formats,
    });

    // Pre-warm stream URL cache in background so play is instant when user clicks
    const bestCombined = formats.find(
      (f) => f.hasVideo && f.hasAudio && !f.formatId.includes("+"),
    );
    if (bestCombined) {
      const prewarmFormat = bestCombined.formatId;
      const cacheKey = `${normalizedUrl}::${prewarmFormat}`;
      if (!getCachedStreamUrl(cacheKey)) {
        runYtDlp([
          "--get-url",
          "--no-playlist",
          "--no-warnings",
          "-f",
          prewarmFormat,
          normalizedUrl,
        ])
          .then((rawUrls) => {
            const cdnUrl = rawUrls.trim().split("\n")[0].trim();
            if (cdnUrl && cdnUrl.startsWith("http"))
              setCachedStreamUrl(cacheKey, cdnUrl);
          })
          .catch(() => {}); // silently ignore pre-warm failures
      }
    }
  } catch (err) {
    req.log.error({ err }, "Failed to get video info");
    const message = err instanceof Error ? err.message : "Unknown error";
    res
      .status(500)
      .json({ error: getUserFriendlyYtError(message), details: message });
  }
});

router.post("/youtube/download", downloadRateLimiter, async (req: Request, res: Response) => {
  const { url, formatId, audioOnly } = req.body as {
    url: string;
    formatId?: string;
    audioOnly?: boolean;
  };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  const requestedFormatId = normalizeVideoDownloadFormat(formatId);

  const jobId = randomUUID();
  const normalizedUrl = normalizeInputUrl(url);
  const notifyClientKey = getNotifyClientKey(req);

  if (isYoutubeQueuePrimaryEnabledFor("download")) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "download",
        sourceUrl: normalizedUrl,
        meta: {
          formatId: requestedFormatId,
          audioOnly: audioOnly ?? false,
          notifyClientKey: notifyClientKey ?? null,
        },
      });
      res.json({ jobId, status: "queued", message: "Download queued" });
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to submit primary queue download job");
      res.status(502).json({ error: "Failed to queue download job" });
    }
    return;
  }

  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: null,
    filesize: null,
    message: "Starting download...",
    filePath: null,
    url: normalizedUrl,
    formatId: requestedFormatId,
    audioOnly: audioOnly ?? false,
    ext: "mp4",
    notifyClientKey,
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Download started" });

  void submitYoutubeQueueShadowJob({
    jobId,
    jobType: "download",
    sourceUrl: normalizedUrl,
    meta: {
      formatId: requestedFormatId,
      audioOnly: audioOnly ?? false,
    },
  }).catch((err) => {
    req.log.warn({ err, jobId }, "Failed to submit shadow queue download job");
  });

  processDownload(jobId, job).catch((err) => {
    req.log.error({ err, jobId }, "Download job failed");
    const j = jobs.get(jobId);
    if (j) {
      const message = err instanceof Error ? err.message : "Download failed";
      if (message === CANCELLED_BY_USER || j.cancelled) {
        j.status = "cancelled";
        j.message = CANCELLED_BY_USER;
      } else {
        j.status = "error";
        j.message = message;
        pushFailureNotification(
          j,
          "Download failed",
          message.slice(0, 200),
          `download-error:${jobId}`,
        );
      }
    }
  });
});

/** Convert a time in seconds to yt-dlp section timestamp (HH:MM:SS.mmm) */
function secsToTimestamp(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
}

/** Build ordered yt-dlp format candidates for clip cutting. */
function qualityToFormatCandidates(quality: string): string[] {
  const normalized = quality.trim().toLowerCase().replace(/p$/, "");
  const parsedHeight = Number.parseInt(normalized, 10);
  const maxHeight =
    normalized === "best" || !normalized || !Number.isFinite(parsedHeight) || parsedHeight <= 0
      ? null
      : parsedHeight;

  if (maxHeight) {
    const minProgressiveHeight = Math.min(360, maxHeight);
    return [
      `bestvideo[vcodec^=avc1][height<=${maxHeight}]+bestaudio[ext=m4a]`,
      `bestvideo[vcodec^=avc1][height<=${maxHeight}]+bestaudio`,
      `bestvideo[height<=${maxHeight}]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${maxHeight}]+bestaudio`,
      `best[ext=mp4][vcodec!=none][acodec!=none][height<=${maxHeight}][height>=${minProgressiveHeight}]`,
      `best[vcodec!=none][acodec!=none][height<=${maxHeight}][height>=${minProgressiveHeight}]`,
      `best[ext=mp4][vcodec!=none][acodec!=none][height<=${maxHeight}]`,
      `best[vcodec!=none][acodec!=none][height<=${maxHeight}]`,
    ];
  }

  return [
    "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]",
    "bestvideo[vcodec^=avc1]+bestaudio",
    "bestvideo+bestaudio",
    "best[ext=mp4][vcodec!=none][acodec!=none][height>=360]",
    "best[vcodec!=none][acodec!=none][height>=360]",
    "best[ext=mp4][vcodec!=none][acodec!=none]",
    "best[vcodec!=none][acodec!=none]",
  ];
}

const MAX_CLIP_FORMAT_CANDIDATES = 6;
const MAX_CLIP_CLIENT_FALLBACKS = 5;
const MAX_CLIP_DOWNLOAD_ATTEMPTS = 8;

async function processClipCut(jobId: string, job: DownloadJob): Promise<void> {
  const jobRef = jobs.get(jobId)!;
  if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);
  const { clipStart = 0, clipEnd, clipQuality = "best" } = jobRef;

  const section = `*${secsToTimestamp(clipStart)}-${secsToTimestamp(clipEnd ?? clipStart + 60)}`;
  const formatCandidates = qualityToFormatCandidates(clipQuality).slice(
    0,
    MAX_CLIP_FORMAT_CANDIDATES,
  );
  const outputPath = join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  jobRef.ext = "mp4";
  jobRef.status = "downloading";
  jobRef.message = "Cutting clip...";

  await ensureYtdlpCookiesLoaded();
  const cookieArgs = getYtdlpCookieArgs();
  const isYt = isYouTubeUrl(job.url);
  const defaultYoutubeArgs = isYt ? getDefaultYouTubeExtractorArgs() : [];
  const downloadFallbacks: string[][] = getYouTubeFallbacks();

  let lastErr: Error | null = null;
  let attemptsUsed = 0;
  for (const formatSelector of formatCandidates) {
    if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);
    if (attemptsUsed >= MAX_CLIP_DOWNLOAD_ATTEMPTS) break;

    const cmdArgs: string[] = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--progress",
      "-f", formatSelector,
      "--merge-output-format", "mp4",
      "--download-sections", section,
      "--force-keyframes-at-cuts",
      "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
      "-o", outputPath,
      job.url,
    ];

    const attemptPlans: string[][] = [];
    if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
    attemptPlans.push(defaultYoutubeArgs);

    const attempted = new Set<string>();
    lastErr = null;

    for (const extra of attemptPlans) {
      if (attemptsUsed >= MAX_CLIP_DOWNLOAD_ATTEMPTS) break;
      const key = extra.join("\u0001");
      if (attempted.has(key)) continue;
      attempted.add(key);
      attemptsUsed += 1;
      try {
        await spawnDownloadOnce(extra, cmdArgs, jobRef);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error("yt-dlp clip cut failed");
        if (!isYt || !isYouTubeBlockedError(lastErr.message)) break;
      }
    }

    const shouldTryClientFallback =
      !!lastErr && isYt && isYouTubeBlockedError(lastErr.message);
    if (shouldTryClientFallback && attemptsUsed < MAX_CLIP_DOWNLOAD_ATTEMPTS) {
      jobRef.message = "Retrying with alternate client...";
      for (const fallback of downloadFallbacks.slice(0, MAX_CLIP_CLIENT_FALLBACKS)) {
        if (attemptsUsed >= MAX_CLIP_DOWNLOAD_ATTEMPTS) break;
        const plans = cookieArgs.length ? [[...cookieArgs, ...fallback], fallback] : [fallback];
        for (const extra of plans) {
          if (attemptsUsed >= MAX_CLIP_DOWNLOAD_ATTEMPTS) break;
          const key = extra.join("\u0001");
          if (attempted.has(key)) continue;
          attempted.add(key);
          attemptsUsed += 1;
          try {
            await spawnDownloadOnce(extra, cmdArgs, jobRef);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error("yt-dlp clip cut fallback failed");
          }
        }
        if (!lastErr) break;
      }
    }

    if (!lastErr) break;
  }

  if (lastErr && attemptsUsed >= MAX_CLIP_DOWNLOAD_ATTEMPTS) {
    throw new Error(
      `Clip cut failed after ${attemptsUsed} attempts: ${lastErr.message}`,
    );
  }
  if (lastErr) throw lastErr;
  if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);

  const possibleExts = ["mp4"];
  let finalPath: string | null = null;
  for (const e of possibleExts) {
    const p = join(DOWNLOAD_DIR, `${jobId}.${e}`);
    if (existsSync(p)) { finalPath = p; jobRef.ext = e; break; }
  }
  if (
    !finalPath &&
    jobRef.filePath &&
    existsSync(jobRef.filePath) &&
    hasAllowedOutputExtension(jobRef.filePath, possibleExts)
  ) {
    finalPath = jobRef.filePath;
  }
  if (!finalPath) throw new Error("Clip file not found on disk");
  if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);

  await storeJobOutputInS3(jobId, jobRef, finalPath, "youtube/clips");
  jobRef.status = "done";
  jobRef.percent = 100;
  jobRef.speed = null;
  jobRef.eta = null;
  jobRef.message = null;
  pushCompletionNotification(
    jobRef,
    "Clip ready",
    jobRef.filename ?? "Your clip has finished processing.",
    `clip:${jobId}`,
  );
  scheduleAutoDelete(jobId, jobRef);
}

router.post("/youtube/clip-cut", clipCutRateLimiter, async (req: Request, res: Response) => {
  const { url, startTime, endTime, quality } = req.body as {
    url: string;
    startTime: number;
    endTime: number;
    quality?: string;
  };

  if (!url) { res.status(400).json({ error: "url is required" }); return; }
  if (typeof startTime !== "number" || typeof endTime !== "number") {
    res.status(400).json({ error: "startTime and endTime (in seconds) are required" });
    return;
  }
  if (endTime <= startTime) {
    res.status(400).json({ error: "endTime must be greater than startTime" });
    return;
  }
  if (endTime - startTime > 3600) {
    res.status(400).json({ error: "Clip cannot exceed 60 minutes" });
    return;
  }

  const jobId = randomUUID();
  const normalizedUrl = normalizeInputUrl(url);
  const notifyClientKey = getNotifyClientKey(req);

  if (isYoutubeQueuePrimaryEnabledFor("clip-cut") && !shouldRunClipInLambda(startTime, endTime)) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "clip-cut",
        sourceUrl: normalizedUrl,
        meta: {
          startTime,
          endTime,
          quality: quality ?? "best",
          notifyClientKey: notifyClientKey ?? null,
        },
      });
      res.json({ jobId, status: "queued", message: "Clip cut queued" });
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to submit primary queue clip-cut job");
      res.status(502).json({ error: "Failed to queue clip cut job" });
    }
    return;
  }

  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: null,
    filesize: null,
    message: "Starting clip cut...",
    filePath: null,
    url: normalizedUrl,
    formatId: "clip",
    audioOnly: false,
    ext: "mp4",
    clipStart: startTime,
    clipEnd: endTime,
    clipQuality: quality ?? "best",
    notifyClientKey,
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Clip cut started" });

  void submitYoutubeQueueShadowJob({
    jobId,
    jobType: "clip-cut",
    sourceUrl: normalizedUrl,
    meta: {
      startTime,
      endTime,
      quality: quality ?? "best",
    },
  }).catch((err) => {
    req.log.warn({ err, jobId }, "Failed to submit shadow queue clip-cut job");
  });

  enqueueClipJob(jobId, () => processClipCut(jobId, job)).catch((err) => {
    req.log.error({ err, jobId }, "Clip cut job failed");
    const j = jobs.get(jobId);
    if (j) {
      const message = err instanceof Error ? err.message : "Clip cut failed";
      if (message === CANCELLED_BY_USER || j.cancelled) {
        j.status = "cancelled";
        j.message = CANCELLED_BY_USER;
      } else {
        j.status = "error";
        j.message = message;
        pushFailureNotification(
          j,
          "Clip cut failed",
          message.slice(0, 200),
          `clip-error:${jobId}`,
        );
      }
    }
  });
});

// Run one download attempt with given extra args (cookies / client override).
// Streams progress into jobRef; resolves on exit code 0, rejects with stderr on failure.
function spawnDownloadOnce(
  extraArgs: string[],
  cmdArgs: string[],
  jobRef: DownloadJob,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (jobRef.cancelled) {
      reject(new Error(CANCELLED_BY_USER));
      return;
    }

    // Reset progress state for retry attempts
    jobRef.percent = 0;
    jobRef.filename = null;
    jobRef.filePath = null;

    const command = YTDLP_BIN || PYTHON_BIN;
    const commandArgs = YTDLP_BIN
      ? [...BASE_YTDLP_ARGS, ...extraArgs, ...cmdArgs]
      : ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...extraArgs, ...cmdArgs];
    logger.info(
      { command, args: commandArgs, ffmpegPath: FFMPEG_PATH, path: PYTHON_ENV.PATH },
      "Starting yt-dlp download command",
    );
    const proc = spawn(command, commandArgs, { env: PYTHON_ENV });
    jobRef.activeProc = proc;
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse progress lines: [download]  xx.x% of ~xx.xxMiB at xx.xxMiB/s ETA xx:xx
        const progressMatch = trimmed.match(
          /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)([\w]+)\s+at\s+([\d.]+)([\w/]+)\s+ETA\s+(\S+)/,
        );
        if (progressMatch) {
          const percent = parseFloat(progressMatch[1]);
          const sizeNum = parseFloat(progressMatch[2]);
          const sizeUnit = progressMatch[3];
          const speedNum = parseFloat(progressMatch[4]);
          const speedUnit = progressMatch[5];
          const eta = progressMatch[6];

          jobRef.percent = Math.round(percent);
          jobRef.speed = `${speedNum}${speedUnit}`;
          jobRef.eta = eta === "Unknown" ? null : eta;

          const mult: Record<string, number> = {
            B: 1,
            KiB: 1024,
            MiB: 1024 * 1024,
            GiB: 1024 * 1024 * 1024,
            KB: 1000,
            MB: 1000000,
            GB: 1000000000,
          };
          if (sizeUnit in mult) {
            jobRef.filesize = Math.round(sizeNum * mult[sizeUnit]);
          }
          continue;
        }

        // Destination file (may appear multiple times: first for raw, then for converted)
        const destMatch = trimmed.match(
          /\[(?:download|ExtractAudio|Merger)\] Destination:\s+(.+)/,
        );
        if (destMatch) {
          const destPath = destMatch[1].trim();
          const fname = destPath.split("/").pop() ?? destPath;
          // Always update filePath (last Destination wins — e.g. mp3 after m4a)
          jobRef.filename = fname;
          jobRef.filePath = destPath;
        }

        // Merging
        if (
          trimmed.includes("Merging formats") ||
          trimmed.includes("[Merger]")
        ) {
          jobRef.status = "merging";
          jobRef.message = "Merging video and audio...";
          jobRef.percent = Math.max(jobRef.percent ?? 0, 90);
        }

        // Already downloaded
        if (trimmed.includes("has already been downloaded")) {
          const alreadyMatch = trimmed.match(
            /\[download\] (.+) has already been downloaded/,
          );
          if (alreadyMatch) {
            jobRef.filename = alreadyMatch[1].split("/").pop() ?? "";
            jobRef.filePath = alreadyMatch[1].trim();
          }
        }
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", (code: number | null) => {
      jobRef.activeProc = null;
      if (jobRef.cancelled) {
        reject(new Error(CANCELLED_BY_USER));
      } else if (code === 0) resolve();
      else {
        logger.warn(
          { code, command, args: commandArgs, stderr: stderr.slice(-2000), ffmpegPath: FFMPEG_PATH },
          "yt-dlp download command failed",
        );
        reject(
          new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`),
        );
      }
    });

    proc.on("error", (err: Error) => {
      jobRef.activeProc = null;
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

async function processDownload(jobId: string, job: DownloadJob): Promise<void> {
  const jobRef = jobs.get(jobId)!;
  if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);

  const isAudioOnly = job.audioOnly || job.formatId.startsWith("audio:");

  const rawFormatId = isAudioOnly
    ? job.formatId.replace("audio:", "")
    : job.formatId;

  const ext = isAudioOnly ? "mp3" : "mp4";
  const outputPath = join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  jobRef.ext = ext;
  jobRef.status = "downloading";
  jobRef.message = isAudioOnly ? "Downloading audio..." : "Downloading...";

  const cmdArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
  ];

  if (isAudioOnly) {
    cmdArgs.push("-f", rawFormatId);
    cmdArgs.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    cmdArgs.push("-f", rawFormatId);
    cmdArgs.push("--merge-output-format", "mp4");
    // ffmpeg reconnect flags — required for YouTube SABR/adaptive streaming (2025+).
    // Without these, mid-download connection resets cause corrupt or incomplete files.
    cmdArgs.push("--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5");
  }

  cmdArgs.push("-o", outputPath, job.url);

  // Build the same cookie + fallback strategy as runYtDlp so that cookies are
  // sent and bot-detected attempts are retried with different player clients.
  await ensureYtdlpCookiesLoaded();
  const cookieArgs = getYtdlpCookieArgs();
  const isYt = isYouTubeUrl(job.url);

  const defaultYoutubeArgs = isYt ? getDefaultYouTubeExtractorArgs() : [];
  // Attempt order: (1) default mode [+cookies], (2) each client fallback [+cookies]
  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);

  const downloadFallbacks: string[][] = getYouTubeFallbacks();

  const attempted = new Set<string>();
  let lastErr: Error | null = null;

  // First pass: base args (with and without cookies)
  for (const extra of attemptPlans) {
    const key = extra.join("\u0001");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      await spawnDownloadOnce(extra, cmdArgs, jobRef);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp download failed");
      // Only keep trying client fallbacks for YouTube bot-blocks
      if (!isYt || !isYouTubeBlockedError(lastErr.message)) throw lastErr;
    }
  }

  // Second pass: client fallbacks (only reached on YouTube bot-detection)
  if (lastErr && isYt) {
    jobRef.status = "downloading";
    jobRef.message = isAudioOnly ? "Retrying download..." : "Retrying with alternate client...";
    for (const fallback of downloadFallbacks) {
      const plans = cookieArgs.length
        ? [[...cookieArgs, ...fallback], fallback]
        : [fallback];
      for (const extra of plans) {
        const key = extra.join("\u0001");
        if (attempted.has(key)) continue;
        attempted.add(key);
        try {
          await spawnDownloadOnce(extra, cmdArgs, jobRef);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error("yt-dlp fallback download failed");
        }
      }
      if (!lastErr) break;
    }
  }

  if (lastErr) throw lastErr;
  if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);

  // Find the output file (yt-dlp may change extension)
  const possibleExts = isAudioOnly ? ["mp3", "m4a"] : ["mp4"];
  let finalPath: string | null = null;

  for (const e of possibleExts) {
    const p = join(DOWNLOAD_DIR, `${jobId}.${e}`);
    if (existsSync(p)) {
      finalPath = p;
      jobRef.ext = e;
      break;
    }
  }

  // If not found by ext, try to use the path set from stdout
  if (
    !finalPath &&
    jobRef.filePath &&
    existsSync(jobRef.filePath) &&
    hasAllowedOutputExtension(jobRef.filePath, possibleExts)
  ) {
    finalPath = jobRef.filePath;
  }

  if (!finalPath) {
    throw new Error(
      isAudioOnly
        ? "Downloaded audio file not found on disk"
        : "Downloaded video file not found on disk. The selected format resolved to audio-only, so no video file was returned.",
    );
  }
  if (jobRef.cancelled) throw new Error(CANCELLED_BY_USER);

  await storeJobOutputInS3(jobId, jobRef, finalPath, "youtube/downloads");
  jobRef.status = "done";
  jobRef.percent = 100;
  jobRef.speed = null;
  jobRef.eta = null;
  jobRef.message = null;
  pushCompletionNotification(
    jobRef,
    "Download complete",
    jobRef.filename ?? "Your video download is ready.",
    `download:${jobId}`,
  );
  scheduleAutoDelete(jobId, jobRef);
}

function buildProgressPayload(jobId: string, job: DownloadJob) {
  return {
    jobId,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    filename: job.filename,
    filesize: job.filesize,
    message: job.message,
  };
}

function disableProgressCache(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

router.get("/youtube/progress/:jobId", (req: Request, res: Response) => {
  disableProgressCache(res);
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (job) {
    res.json(buildProgressPayload(jobId, job));
    return;
  }
  if (!isDownloadQueueEnabled()) {
    res.json({
      jobId,
      status: "not_found",
      percent: null,
      speed: null,
      eta: null,
      filename: null,
      filesize: null,
      message: "Job not found",
    });
    return;
  }
  void getYoutubeQueueJobStatus(jobId)
    .then((queueStatus) => {
      if (!queueStatus) {
        res.json({
          jobId,
          status: "not_found",
          percent: null,
          speed: null,
          eta: null,
          filename: null,
          filesize: null,
          message: "Job not found",
        });
        return;
      }
      res.json({
        jobId,
        status: queueStatus.status,
        percent: null,
        speed: null,
        eta: null,
        filename: queueStatus.filename,
        filesize: queueStatus.filesize,
        message: queueStatus.message,
        queue: {
          updatedAt: queueStatus.updatedAt,
          batchJobId: queueStatus.batchJobId,
          s3Key: queueStatus.s3Key,
        },
      });
    })
    .catch((err) => {
      req.log.error({ err, jobId }, "Failed queue progress lookup");
      res.status(500).json({ error: "Failed to fetch progress" });
    });
});

router.get("/youtube/progress/stream/:jobId", (req: Request, res: Response) => {
  disableProgressCache(res);
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    if (!isDownloadQueueEnabled()) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    setupSse(res);

    const send = (payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const pollQueue = async (): Promise<boolean> => {
      const queueStatus = await getYoutubeQueueJobStatus(jobId);
      if (!queueStatus) {
        send({ status: "error", message: "Job not found" });
        res.end();
        return true;
      }
      send({
        jobId,
        status: queueStatus.status,
        percent: null,
        speed: null,
        eta: null,
        filename: queueStatus.filename,
        filesize: queueStatus.filesize,
        message: queueStatus.message,
        queue: {
          updatedAt: queueStatus.updatedAt,
          batchJobId: queueStatus.batchJobId,
          s3Key: queueStatus.s3Key,
        },
      });
      if (["done", "error", "expired", "cancelled"].includes(queueStatus.status)) {
        res.end();
        return true;
      }
      return false;
    };

    void pollQueue().catch((err) => {
      req.log.error({ err, jobId }, "Failed queue progress stream lookup");
      send({ status: "error", message: "Failed to fetch job status" });
      res.end();
    });

    const timer = setInterval(() => {
      void pollQueue().then((finished) => {
        if (finished) clearInterval(timer);
      }).catch((err) => {
        req.log.error({ err, jobId }, "Failed queue progress stream poll");
        send({ status: "error", message: "Failed to fetch job status" });
        clearInterval(timer);
        res.end();
      });
    }, 1000);

    req.on("close", () => {
      clearInterval(timer);
    });
    return;
  }

  setupSse(res);

  const send = (payload: object) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const sendSnapshot = () => {
    const current = jobs.get(jobId);
    if (!current) {
      send({ status: "error", message: "Job not found" });
      res.end();
      return true;
    }
    send(buildProgressPayload(jobId, current));
    if (["done", "error", "expired", "cancelled"].includes(current.status)) {
      res.end();
      return true;
    }
    return false;
  };

  if (sendSnapshot()) return;

  const timer = setInterval(() => {
    if (sendSnapshot()) clearInterval(timer);
  }, 1000);

  req.on("close", () => {
    clearInterval(timer);
  });
});

router.post("/youtube/cancel/:jobId", cancelRateLimiter, async (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }

  const job = jobs.get(jobId);
  if (!job) {
    if (!isDownloadQueueEnabled()) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    try {
      const cancelled = await cancelYoutubeQueueJob(jobId);
      if (!cancelled.ok) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json({
        ok: true,
        status: cancelled.status,
        alreadyFinished: cancelled.alreadyFinished ?? false,
        queue: { batchJobId: cancelled.batchJobId },
      });
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to cancel queue job");
      res.status(500).json({ error: "Failed to cancel job" });
    }
    return;
  }

  if (["done", "error", "expired", "cancelled"].includes(job.status)) {
    res.json({ ok: true, alreadyFinished: true, status: job.status });
    return;
  }

  job.cancelled = true;
  job.status = "cancelled";
  job.message = CANCELLED_BY_USER;
  if (queuedClipJobIds.has(jobId)) {
    dequeueClipJob(jobId);
  }

  if (job.activeProc) {
    try {
      job.activeProc.kill("SIGTERM");
      setTimeout(() => {
        if (job.activeProc) {
          try {
            job.activeProc.kill("SIGKILL");
          } catch {}
        }
      }, 2000);
    } catch {}
  }

  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  res.json({ ok: true, status: "cancelled" });
});

// ─── Video Stream Proxy ───────────────────────────────────────────────────
// Gets the direct CDN URL for a format via yt-dlp --get-url and proxies it
// with full Range request support so the browser <video> tag can seek.

// Cache resolved CDN stream URLs to avoid re-running yt-dlp on every request
// YouTube signed URLs typically expire after 6 hours; we cache for 25 minutes to be safe.
const STREAM_CACHE_TTL_MS = 25 * 60 * 1000;
const streamUrlCache = new Map<string, { cdnUrl: string; expiresAt: number }>();

function getCachedStreamUrl(key: string): string | null {
  const entry = streamUrlCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    streamUrlCache.delete(key);
    return null;
  }
  return entry.cdnUrl;
}

function setCachedStreamUrl(key: string, cdnUrl: string): void {
  streamUrlCache.set(key, {
    cdnUrl,
    expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
  });
}

// ── Video metadata cache ──────────────────────────────────────────────────────
// Caches raw yt-dlp --dump-json output for 5 minutes per video ID.
// Eliminates redundant yt-dlp calls when /info and /clips hit the same URL.
const META_CACHE_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map<string, { raw: string; expiresAt: number }>();

function metaCacheKey(url: string): string {
  const id = extractVideoId(url);
  return id ?? url;
}

function getCachedMeta(url: string): string | null {
  const key = metaCacheKey(url);
  const entry = metaCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    metaCache.delete(key);
    return null;
  }
  return entry.raw;
}

function setCachedMeta(url: string, raw: string): void {
  metaCache.set(metaCacheKey(url), {
    raw,
    expiresAt: Date.now() + META_CACHE_TTL_MS,
  });
}

router.get("/youtube/stream", async (req: Request, res: Response) => {
  const { url, formatId } = req.query as { url?: string; formatId?: string };

  if (!url) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  // Merged formats (e.g. "137+140") need ffmpeg — fall back to best combined
  const safeFormatId =
    formatId && !formatId.includes("+") && !formatId.startsWith("audio:")
      ? formatId
      : "best[ext=mp4]/best[height<=720][ext=mp4]/best";

  const normalizedUrl = normalizeInputUrl(url);
  const cacheKey = `${normalizedUrl}::${safeFormatId}`;

  try {
    // Check cache first — avoids 10-15s yt-dlp resolve on every request
    let streamUrl = getCachedStreamUrl(cacheKey);

    if (!streamUrl) {
      // --get-url returns one URL per line (one for combined, two for separate)
      const rawUrls = await runYtDlp([
        "--get-url",
        "--no-playlist",
        "--no-warnings",
        "-f",
        safeFormatId,
        normalizedUrl,
      ]);
      streamUrl = rawUrls.trim().split("\n")[0].trim();
      if (streamUrl && streamUrl.startsWith("http")) {
        setCachedStreamUrl(cacheKey, streamUrl);
      }
    }

    if (!streamUrl || !streamUrl.startsWith("http")) {
      res.status(502).json({ error: "Could not resolve stream URL" });
      return;
    }

    // Proxy the request to the CDN with Range forwarding.
    // YouTube CDN validates Referer and Origin — omitting them causes 403.
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": "https://www.youtube.com/",
      "Origin": "https://www.youtube.com",
    };
    const rangeHeader = req.headers["range"];
    if (rangeHeader) headers["Range"] = rangeHeader;

    const get = streamUrl.startsWith("https") ? httpsGet : httpGet;
    const proxyReq = get(streamUrl, { headers }, (proxyRes) => {
      const status = proxyRes.statusCode ?? 200;
      const proxyHeaders: Record<string, string | string[]> = {
        "Content-Type":
          (proxyRes.headers["content-type"] as string) || "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      if (proxyRes.headers["content-length"])
        proxyHeaders["Content-Length"] = proxyRes.headers[
          "content-length"
        ] as string;
      if (proxyRes.headers["content-range"])
        proxyHeaders["Content-Range"] = proxyRes.headers[
          "content-range"
        ] as string;

      res.writeHead(status, proxyHeaders);
      proxyRes.pipe(res);
      proxyRes.on("error", () => res.end());
    });

    proxyReq.on("error", (err) => {
      req.log.error({ err }, "Stream proxy error");
      if (!res.headersSent) res.status(502).json({ error: "Stream failed" });
    });

    proxyReq.setTimeout(10000, () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: "Stream timeout" });
    });

    req.on("close", () => proxyReq.destroy());
  } catch (err) {
    req.log.error({ err }, "Failed to get stream URL");
    const message = err instanceof Error ? err.message : "Unknown error";
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Failed to get stream URL", details: message });
  }
});

router.get("/youtube/file/:jobId", async (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    if (!isDownloadQueueEnabled()) {
      res.status(404).json({ error: "Job not found", expired: true });
      return;
    }

    const queueStatus = await getYoutubeQueueJobStatus(jobId);
    if (!queueStatus) {
      res.status(404).json({ error: "Job not found", expired: true });
      return;
    }

    if (queueStatus.status === "expired") {
      res.status(410).json({
        error: "File has expired. Please download the video again.",
        expired: true,
      });
      return;
    }

    if (queueStatus.status !== "done" || !queueStatus.s3Key) {
      res.status(404).json({ error: "File not found or download not complete" });
      return;
    }

    try {
      const signedUrl = await getS3SignedDownloadUrl({
        key: queueStatus.s3Key,
        filename: queueStatus.filename ?? "video.mp4",
      });
      res.redirect(302, signedUrl);
      return;
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to generate signed S3 URL for queue file");
      res.status(500).json({
        error: "File is ready but cloud download URL could not be created.",
      });
      return;
    }
  }

  if (job.status === "expired") {
    res.status(410).json({
      error: "File has expired. Please download the video again.",
      expired: true,
    });
    return;
  }
  if (job.status !== "done" || !job.filePath) {
    if (job.status !== "done" || !job.s3Key) {
      res.status(404).json({ error: "File not found or download not complete" });
      return;
    }
  }

  const filename = job.filename ?? `video.${job.ext}`;

  if (job.s3Key) {
    try {
      const signedUrl = await getS3SignedDownloadUrl({
        key: job.s3Key,
        filename,
      });
      res.redirect(302, signedUrl);
      return;
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to generate signed S3 download URL");
      if (!job.filePath) {
        res.status(500).json({
          error: "File is ready but cloud download URL could not be created.",
        });
        return;
      }
    }
  }

  if (!job.filePath || !existsSync(job.filePath)) {
    res.status(410).json({
      error: "File has expired. Please download the video again.",
      expired: true,
    });
    return;
  }

  const stats = statSync(job.filePath);

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", stats.size);

  // Keep the file available after first download so users can click Save again.
  // Cleanup is handled by scheduleAutoDelete().
  createReadStream(job.filePath).pipe(res);
});

// ─── Subtitle Download ────────────────────────────────────────────────────

/** Parse a VTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) into milliseconds */
function vttTimeToMs(t: string): number {
  const parts = t.trim().split(":");
  if (parts.length === 2) parts.unshift("00"); // MM:SS.mmm
  const [h, m, s] = parts;
  const [sec, ms = "0"] = s.split(".");
  return (
    parseInt(h, 10) * 3600000 +
    parseInt(m, 10) * 60000 +
    parseInt(sec, 10) * 1000 +
    parseInt(ms.padEnd(3, "0"), 10)
  );
}

/** Format milliseconds as HH:MM:SS,mmm (SRT format) */
function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(3, "0")}`;
}

function vttToSrt(vtt: string): string {
  // Remove WEBVTT header and any NOTE/STYLE/Kind/Language metadata lines
  const cleaned = vtt
    .replace(/^WEBVTT[^\n]*/m, "")
    .replace(/^(NOTE|STYLE|Kind|Language)[^\n]*(\n(?!\n)[^\n]*)*/gm, "")
    .trim();

  const MIN_DURATION_MS = 50; // skip YouTube's 10ms "reset" blocks

  let index = 1;
  const blocks: string[] = [];
  let prevTextLine = "";

  for (const block of cleaned.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;

    // Parse timestamps — take only the first token before any VTT cue settings
    const timeLine = lines[timeIdx];
    const arrowIdx = timeLine.indexOf("-->");
    const startRaw = timeLine.slice(0, arrowIdx).trim().split(/\s/)[0];
    const endRaw   = timeLine.slice(arrowIdx + 3).trim().split(/\s/)[0];

    // Skip very short "reset" blocks (YouTube word-timing artifact)
    const startMs = vttTimeToMs(startRaw);
    const endMs   = vttTimeToMs(endRaw);
    if (endMs - startMs < MIN_DURATION_MS) continue;

    // Strip all inline timing/formatting tags (<00:00:00.000>, <c>, </c>, etc.)
    const textLines = lines
      .slice(timeIdx + 1)
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);

    if (textLines.length === 0) continue;

    // YouTube word-level VTT duplicates the previous line at the top of the next block.
    // Detect and drop it: if the first line is identical to the last emitted line, skip it.
    let newLines = textLines;
    if (textLines.length > 1 && textLines[0] === prevTextLine) {
      newLines = textLines.slice(1);
    }
    if (newLines.length === 0) continue;

    // If we still have multi-line carry-over, take only the last non-duplicate line as new content
    // (handles cases where multiple carry-over lines accumulate)
    const lastNew = newLines[newLines.length - 1];
    prevTextLine = lastNew;

    blocks.push(
      `${index}\n${msToSrtTime(startMs)} --> ${msToSrtTime(endMs)}\n${newLines.join("\n")}`,
    );
    index++;
  }

  return blocks.join("\n\n");
}

router.get("/youtube/subtitles", async (req: Request, res: Response) => {
  const { url, format, lang } = req.query as { url?: string; format?: string; lang?: string };

  if (!url) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  const outputFormat = format === "vtt" ? "vtt" : "srt";
  const normalizedUrl = normalizeInputUrl(url);
  const subDir = join(DOWNLOAD_DIR, `subs-${randomUUID()}`);

  try {
    mkdirSync(subDir, { recursive: true });
    const subBase = join(subDir, "sub");

    let vttContent: string | null = null;

    // Approach 1: dump-json to get subtitle URL directly (faster, no extra yt-dlp download)
    try {
      const metaJson = await runYtDlp([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        normalizedUrl,
      ]);
      const meta = JSON.parse(metaJson);
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      const directUrl = pickBestSubtitleUrl(subs, autoCaps, meta.language, lang);
      if (directUrl) {
        const raw = await fetchUrl(directUrl);
        if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
      }
    } catch (_e) {}

    // Approach 2: yt-dlp write-subs
    if (!vttContent) {
      await runYtDlpForSubs([
        "--write-subs",
        "--write-auto-subs",
        "--sub-lang", lang ? `${lang},${lang}.*,hi.*,en.*` : "hi.*,en.*",
        "--sub-format", "vtt",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "-o", subBase,
        normalizedUrl,
      ]).catch(() => {});

      if (!existsSync(subDir) || !readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
        await runYtDlpForSubs([
          "--write-subs",
          "--write-auto-subs",
          "--sub-format", "vtt",
          "--skip-download",
          "--no-warnings",
          "--no-playlist",
          "-o", subBase,
          url,
        ]).catch(() => {});
      }

      if (existsSync(subDir)) {
        const files = readdirSync(subDir);
        const vttFile = files.map((f) => join(subDir, f)).find((f) => f.endsWith(".vtt"));
        if (vttFile) vttContent = readFileSync(vttFile, "utf8");
      }
    }

    if (!vttContent) {
      res.status(404).json({ error: "No subtitles found for this video" });
      return;
    }

    const content = outputFormat === "vtt" ? vttContent : vttToSrt(vttContent);
    const filename = `subtitles.${outputFormat}`;
    const contentType = outputFormat === "vtt" ? "text/vtt" : "application/x-subrip";

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
    res.send(content);
  } catch (err: any) {
    req.log.error({ err }, "Failed to fetch subtitles");
    if (!res.headersSent)
      res.status(500).json({ error: err.message || "Failed to fetch subtitles" });
  } finally {
    try {
      if (existsSync(subDir)) {
        for (const f of readdirSync(subDir)) {
          try { unlinkSync(join(subDir, f)); } catch {}
        }
        rmdirSync(subDir);
      }
    } catch {}
  }
});

// ─── AI Subtitle Correction ───────────────────────────────────────────────

function audioMimeType(ext: string): string {
  const map: Record<string, string> = {
    m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm",
    ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg",
    flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  };
  return map[ext.toLowerCase()] ?? "audio/mpeg";
}

function getPersonalGeminiApiKeys(): string[] {
  const keys: string[] = [];
  const first = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (first) keys.push(first);
  for (let index = 2; index <= 10; index += 1) {
    const envName = `GEMINI_API_KEY_${index}` as keyof NodeJS.ProcessEnv;
    const value = process.env[envName];
    if (value && value.trim().length > 0) keys.push(value.trim());
  }
  return Array.from(new Set(keys));
}

function isQuotaLikeGeminiError(message: string): boolean {
  return /resource_exhausted|quota|429|rate.?limit|503|unavailable|overloaded|high demand|try again later/i.test(message);
}

const YOUTUBE_KEY_ROTATION_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
];

async function generateWithPersonalKeyRotation(
  label: string,
  systemInstruction: string,
  userContent: string,
  models: string[] = YOUTUBE_KEY_ROTATION_MODELS,
): Promise<string> {
  const keys = getPersonalGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error(
      "No Gemini key configured — add GEMINI_API_KEY (or GEMINI_API_KEY_2/_3/_4)",
    );
  }

  let lastErr: Error | null = null;
  for (const model of models) {
    for (let i = 0; i < keys.length; i++) {
      const keyLabel = `key ${i + 1}`;
      try {
        const client = new GoogleGenAI({ apiKey: keys[i] });
        const result = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          ...(systemInstruction && { config: { systemInstruction } }),
        });
        return (result as any).text ?? "";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? "");
        lastErr = err instanceof Error ? err : new Error(message);
        console.warn(
          `[${label}] ${keyLabel} failed on ${model}${isQuotaLikeGeminiError(message) ? " (quota/rate limit)" : ""}: ${message}`,
        );
      }
    }
  }
  throw lastErr ?? new Error(`${label} failed on all keys/models`);
}

router.post("/youtube/subtitles/fix", async (req: Request, res: Response) => {
  const { url, format = "srt" } = req.body as { url: string; format?: string };

  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY or enable Replit Gemini integration" });
    return;
  }

  const outputFormat = format === "vtt" ? "vtt" : "srt";
  const normalizedUrl = normalizeInputUrl(url);
  const sessionId = randomUUID();
  const audioDir = join(DOWNLOAD_DIR, `audio-fix-${sessionId}`);
  const subDir = join(DOWNLOAD_DIR, `subs-fix-${sessionId}`);
  let geminiFileName: string | null = null;
  const primaryKey = getPersonalGeminiApiKeys()[0] ?? null;
  const genAI = primaryKey ? new GoogleGenAI({ apiKey: primaryKey }) : null;

  try {
    // ── Step 1: Fetch raw subtitle VTT ──
    mkdirSync(subDir, { recursive: true });
    const subBase = join(subDir, "sub");
    let vttContent: string | null = null;

    try {
      const metaJson = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", normalizedUrl]);
      const meta = JSON.parse(metaJson);
      const directUrl = pickBestSubtitleUrl(meta.subtitles ?? {}, meta.automatic_captions ?? {}, meta.language);
      if (directUrl) {
        const raw = await fetchUrl(directUrl);
        if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
      }
    } catch {}

    if (!vttContent) {
      await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-lang", "hi.*,en.*", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, normalizedUrl]).catch(() => {});
      if (!existsSync(subDir) || !readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
        await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, normalizedUrl]).catch(() => {});
      }
      if (existsSync(subDir)) {
        const files = readdirSync(subDir);
        const vttFile = files.map((f) => join(subDir, f)).find((f) => f.endsWith(".vtt"));
        if (vttFile) vttContent = readFileSync(vttFile, "utf8");
      }
    }

    if (!vttContent) {
      res.status(404).json({ error: "No subtitles found for this video" });
      return;
    }

    // Always feed the AI in the target format so it mirrors the correct syntax
    const inputTranscript = outputFormat === "srt" ? vttToSrt(vttContent) : vttContent;
    const formatLabel = outputFormat === "srt" ? "SRT (timestamps use comma: HH:MM:SS,mmm --> HH:MM:SS,mmm)" : "WebVTT";

    const systemInstruction = `You are an expert video transcript editor specializing in Hindi, Sanskrit, and Indian devotional content including Bhagwat Katha, Ramkatha, spiritual discourses, and bhajans.`;

    const promptText = `I am providing a rough auto-generated transcript. Please carefully correct all errors.

Instructions:
1. Fix spelling, grammar, and word-boundary errors throughout.
2. Pay special attention to Hindi, Sanskrit, and spiritual terminology (deity names, scripture titles, place names, mantras) that may be phonetically misheard by auto-captioning.
3. Correct numeric errors — time durations, counts, and dates are frequently wrong in auto-generated captions (e.g. "6 months" vs "1 month").
4. Fix Hinglish (mixed Hindi-English) sentences while preserving the speaker's natural style.
5. CRITICAL FORMAT RULES for ${formatLabel}:
   - Keep every sequence number exactly as given (1, 2, 3, …). Do NOT drop them.
   - Keep timestamps exactly as given — do NOT change dots to commas or commas to dots.
   - Do not alter any timestamps or structure. Only fix the spoken text inside each entry.
6. Do not add, remove, merge, or split any subtitle entries.
7. Return ONLY the corrected subtitle file content — no explanation, no commentary, no markdown fences.

Here is the raw transcript:
${inputTranscript}`;

    let corrected = "";

    // ── Step 2a: Audio-aware correction using Gemini File API (best quality) ──
    if (genAI) {
      let audioUsed = false;
      try {
        mkdirSync(audioDir, { recursive: true });
        const audioPattern = join(audioDir, "audio.%(ext)s");

        await new Promise<void>((resolve, reject) => {
          const audioCommand = YTDLP_BIN || PYTHON_BIN;
          const audioBaseArgs = [
            "-f", "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio",
            "--no-playlist", "--no-warnings",
            "-o", audioPattern, normalizedUrl,
          ];
          const audioArgs = YTDLP_BIN
            ? audioBaseArgs
            : ["-m", "yt_dlp", ...audioBaseArgs];
          const proc = spawn(audioCommand, audioArgs, { env: PYTHON_ENV });
          let stderr = "";
          proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
          proc.on("close", (code) => { code === 0 ? resolve() : reject(new Error(stderr.slice(-500))); });
          proc.on("error", reject);
        });

        const audioFiles = existsSync(audioDir) ? readdirSync(audioDir) : [];
        const audioFile = audioFiles.map((f) => join(audioDir, f)).find((f) => /\.(m4a|mp4|webm|ogg|opus|mp3|flac|wav|aac)$/i.test(f));

        if (audioFile) {
          const ext = audioFile.split(".").pop()!.toLowerCase();
          const mimeType = audioMimeType(ext);
          const audioBuffer = readFileSync(audioFile);
          const audioBlob = new Blob([audioBuffer], { type: mimeType });

          const uploadResult = await genAI.files.upload({
            file: audioBlob,
            config: { mimeType, displayName: "video-audio" },
          });
          geminiFileName = uploadResult.name!;

          // Poll until ACTIVE (up to 60s)
          let fileInfo: any = uploadResult;
          let attempts = 0;
          while (fileInfo.state === "PROCESSING" && attempts < 30) {
            await new Promise((r) => setTimeout(r, 2000));
            fileInfo = await genAI.files.get({ name: geminiFileName });
            attempts++;
          }

          if (fileInfo.state === "ACTIVE") {
            // Audio file upload requires own key — use gemini-2.5-pro for best quality
            const result = await genAI.models.generateContent({
              model: "gemini-2.5-pro",
              contents: [{
                role: "user",
                parts: [
                  { fileData: { fileUri: fileInfo.uri, mimeType: fileInfo.mimeType } },
                  { text: promptText },
                ],
              }],
              config: { systemInstruction },
            });
            corrected = (result as any).text ?? "";
            audioUsed = true;
          }
        }
      } catch (audioErr) {
        req.log.warn({ audioErr }, "Audio-aware correction failed, falling back to text-only");
      }

      if (!audioUsed) {
        // Try Replit integration first, then rotate across personal keys/models.
        const replitBase = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
        const replitKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
        let done = false;
        if (replitBase && replitKey) {
          try {
            const rc = new GoogleGenAI({ apiKey: replitKey, httpOptions: { apiVersion: "", baseUrl: replitBase } });
            const rr = await rc.models.generateContent({
              model: "gemini-2.5-pro",
              contents: [{ role: "user", parts: [{ text: promptText }] }],
              config: { systemInstruction },
            });
            corrected = (rr as any).text ?? "";
            done = true;
          } catch (e) {
            console.warn("[subtitle/fix] Replit gemini-2.5-pro failed, falling back to own key:", (e as Error).message);
          }
        }
        if (!done) {
          corrected = await generateWithPersonalKeyRotation(
            "subtitle/fix",
            systemInstruction,
            promptText,
            [
              "gemini-3-flash-preview",
              "gemini-2.5-pro",
            ],
          );
        }
      }
    } else {
      // ── Step 2b: Text-only via Replit Gemini integration ──
      corrected = await clipsGeminiContent(systemInstruction, promptText);
    }

    // Strip any markdown fences the model may have added
    corrected = corrected.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();

    // Post-process SRT: fix timestamps (ensure commas, not dots) and re-number if needed
    if (outputFormat === "srt") {
      // Fix any dot-separated milliseconds back to comma (HH:MM:SS.mmm -> HH:MM:SS,mmm)
      corrected = corrected.replace(
        /^(\d{2}:\d{2}:\d{2})\.(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2})\.(\d{3})/gm,
        "$1,$2 --> $3,$4",
      );
      // Re-number entries if the AI dropped sequence numbers
      const blocks = corrected.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
      let allHaveNumbers = true;
      for (const block of blocks) {
        const firstLine = block.split("\n")[0].trim();
        if (!/^\d+$/.test(firstLine)) { allHaveNumbers = false; break; }
      }
      if (!allHaveNumbers) {
        let idx = 1;
        corrected = blocks
          .filter((b) => b.includes("-->"))
          .map((block) => {
            const lines = block.split("\n");
            // Remove any leading bare number line
            const start = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
            return `${idx++}\n${lines.slice(start).join("\n")}`;
          })
          .join("\n\n");
      }
    }

    const filename = `subtitles-corrected.${outputFormat}`;
    const contentType = outputFormat === "vtt" ? "text/vtt" : "application/x-subrip";
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
    res.send(corrected);

  } catch (err: any) {
    req.log.error({ err }, "Failed to AI-fix subtitles");
    if (!res.headersSent)
      res.status(500).json({ error: err.message || "Failed to fix subtitles with AI" });
  } finally {
    if (geminiFileName && genAI) {
      try { await (genAI.files as any).delete({ name: geminiFileName }); } catch {}
    }
    for (const dir of [audioDir, subDir]) {
      try {
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) { try { unlinkSync(join(dir, f)); } catch {} }
          rmdirSync(dir);
        }
      } catch {}
    }
  }
});

// ─── Best Clips Feature (streaming with SSE) ──────────────────────────────

// Replit integration: gemini-2.5-pro  →  own key fallback: gemini-2.5-flash
function isAiConfigured(): boolean {
  return (
    !!(process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY) ||
    getPersonalGeminiApiKeys().length > 0
  );
}

async function clipsGeminiContent(
  systemInstruction: string,
  userContent: string,
): Promise<string> {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  if (baseUrl && apiKey) {
    try {
      const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });
      const result = await client.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        ...(systemInstruction && { config: { systemInstruction } }),
      });
      return (result as any).text ?? "";
    } catch (err) {
      console.warn("[clips/text] Replit gemini-2.5-pro failed, falling back to own key:", (err as Error).message);
    }
  }

  return generateWithPersonalKeyRotation("clips/text", systemInstruction, userContent, [
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
  ]);
}

interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}

function vttTimeToSec(t: string): number {
  const parts = t.split(":");
  if (parts.length === 3)
    return (
      parseFloat(parts[0]) * 3600 +
      parseFloat(parts[1]) * 60 +
      parseFloat(parts[2])
    );
  return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
}

function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine
      .split("-->")
      .map((s) => s.trim().split(" ")[0]);
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
      const mm = Math.floor(c.startSec / 60);
      const ss = Math.floor(c.startSec % 60);
      return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
    })
    .join("\n");
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Smart transcript sampling: for very long transcripts, evenly sample lines
 * from across the ENTIRE timeline instead of hard-cutting at a char limit.
 * This guarantees the AI sees content from start, middle, and end of the video.
 */
function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;

  const lines = transcript.split("\n").filter(Boolean);
  // How many lines fit within our budget (avg ~85 chars/line including timestamp)?
  const targetLineCount = Math.floor(maxChars / 85);

  if (lines.length <= targetLineCount) return transcript.slice(0, maxChars);

  // Evenly stride across the full line array — preserves temporal spread
  const step = lines.length / targetLineCount;
  const sampled: string[] = [];
  for (let i = 0; i < targetLineCount; i++) {
    const idx = Math.floor(i * step);
    if (lines[idx]) sampled.push(lines[idx]);
  }

  const result = sampled.join("\n");
  // Prefix note so the AI knows some lines were sampled
  return `[Note: transcript sampled evenly from all ${lines.length} lines for full-video coverage]\n${result}`;
}

/**
 * Robust JSON array extractor: handles markdown fences, surrounding text,
 * and nested objects. Returns null if nothing parseable is found.
 */
function extractJsonArray(raw: string): any[] | null {
  // 1. Strip markdown fences (``` or ```json)
  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  // 2. Direct parse attempt
  try {
    const r = JSON.parse(cleaned);
    if (Array.isArray(r)) return r;
    if (r && typeof r === "object") return [r];
  } catch {}

  // 3. Try to extract the first [...] block from arbitrary surrounding text
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const r = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(r)) return r;
    } catch {}
  }

  // 4. Try extracting each {...} object individually and collect
  const objects: any[] = [];
  const objRe = /\{[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = objRe.exec(cleaned)) !== null) {
    try {
      const o = JSON.parse(match[0]);
      if (o && typeof o === "object") objects.push(o);
    } catch {}
  }
  if (objects.length > 0) return objects;

  return null;
}

export interface BestClip {
  durationLabel: string;
  durationSec: number;
  startSec: number;
  endSec: number;
  startFormatted: string;
  endFormatted: string;
  title: string;
  description: string;
  reason: string;
}

export interface ClipJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: { clips: BestClip[]; hasTranscript: boolean; videoDuration: number };
  error?: string;
  createdAt: number;
  notifyClientKey?: string | null;
}

const clipJobs = new Map<string, ClipJob>();

// Clean up clip jobs older than 30 minutes
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of clipJobs.entries()) {
      if (job.createdAt < cutoff) clipJobs.delete(id);
    }
  },
  10 * 60 * 1000,
);

// POST: start a clip analysis job, return jobId immediately
router.post("/youtube/clips", clipsRateLimiter, async (req: Request, res: Response) => {
  const { url, durations, auto, instructions } = req.body as {
    url: string;
    durations?: number[];
    auto?: boolean;
    instructions?: string;
  };
  const normalizedDurations = Array.isArray(durations)
    ? durations
        .map((duration) => Number(duration))
        .filter((duration) => Number.isFinite(duration))
    : [];
  const normalizedInstructions =
    typeof instructions === "string" ? instructions : undefined;
  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  const normalizedUrl = normalizeInputUrl(url);
  if (!isAiConfigured()) {
    res.status(503).json({
      error: "AI not configured",
      details: "Add GEMINI_API_KEY to Secrets or enable Replit Gemini integration",
    });
    return;
  }

  const jobId = randomUUID();
  const notifyClientKey = getNotifyClientKey(req);

  if (isYoutubeQueuePrimaryEnabledFor("best-clips")) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "best-clips",
        sourceUrl: normalizedUrl,
        meta: {
          durations: normalizedDurations,
          auto: auto ?? false,
          instructions: normalizedInstructions ?? null,
          notifyClientKey: notifyClientKey ?? null,
        },
      });
      res.json({ jobId, status: "queued", message: "Best-clips analysis queued" });
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to submit primary queue best-clips job");
      res.status(502).json({ error: "Failed to queue best-clips job" });
    }
    return;
  }

  const job: ClipJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
    notifyClientKey,
  };
  job.emitter.setMaxListeners(5);
  clipJobs.set(jobId, job);
  res.json({ jobId });

  // Run analysis in background
  runClipAnalysis(
    jobId,
    job,
    normalizedUrl,
    normalizedDurations,
    req.log,
    auto ?? false,
    normalizedInstructions,
  ).catch(() => {});
});

// GET: SSE stream for a clip job
router.get("/youtube/clips/stream/:jobId", (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = clipJobs.get(jobId);
  if (!job) {
    if (!isYoutubeQueueEnabledFor("best-clips")) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    setupSse(res);
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const pollQueue = async (): Promise<boolean> => {
      const queueStatus = await getYoutubeQueueJobStatus(jobId);
        if (!queueStatus) {
          send({ type: "error", message: "Job not found" });
          res.end();
          return true;
        }
        const isTerminal =
          queueStatus.status === "done" ||
          queueStatus.status === "error" ||
          queueStatus.status === "cancelled" ||
          queueStatus.status === "expired";
        if (isTerminal) {
          let resultData: { clips: BestClip[]; hasTranscript: boolean; videoDuration: number } | null = null;
          if (queueStatus.status === "done" && queueStatus.resultJson) {
            try {
              resultData = JSON.parse(queueStatus.resultJson) as {
                clips: BestClip[];
                hasTranscript: boolean;
                videoDuration: number;
              };
            } catch (err) {
              req.log.error({ err, jobId }, "Failed to parse queued best-clips result");
            }
          }
          send({
            type: queueStatus.status === "done" && resultData ? "done" : "error",
            message: queueStatus.message ?? queueStatus.status,
            queue: {
              updatedAt: queueStatus.updatedAt,
              batchJobId: queueStatus.batchJobId,
            },
            clips: resultData?.clips ?? [],
            hasTranscript: resultData?.hasTranscript ?? false,
            videoDuration: resultData?.videoDuration ?? 0,
          });
          res.end();
          return true;
        }
        send({
          type: "step",
          step: "queue",
          status: "running",
          message: queueStatus.message ?? "Queued for processing...",
          queue: {
            updatedAt: queueStatus.updatedAt,
            batchJobId: queueStatus.batchJobId,
          },
        });
      return false;
    };

    void pollQueue().catch((err) => {
      req.log.error({ err, jobId }, "Failed queue clips stream lookup");
      send({ type: "error", message: "Failed to fetch job status" });
      res.end();
    });

    const timer = setInterval(() => {
      void pollQueue().then((finished) => {
        if (finished) clearInterval(timer);
      }).catch((err) => {
        req.log.error({ err, jobId }, "Failed queue clips stream poll");
        send({ type: "error", message: "Failed to fetch job status" });
        clearInterval(timer);
        res.end();
      });
    }, 2500);

    req.on("close", () => {
      clearInterval(timer);
    });
    return;
  }

  setupSse(res);

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // If already finished, send result immediately
  if (job.status === "done" && job.result) {
    send({ type: "done", ...job.result });
    res.end();
    return;
  }
  if (job.status === "error") {
    send({ type: "error", message: job.error });
    res.end();
    return;
  }

  const onStep = (d: any) => send({ type: "step", ...d });
  const onDone = (d: any) => {
    send({ type: "done", ...d });
    res.end();
  };
  const onError = (d: any) => {
    send({ type: "error", ...d });
    res.end();
  };

  job.emitter.on("step", onStep);
  job.emitter.on("done", onDone);
  job.emitter.on("error", onError);

  req.on("close", () => {
    job.emitter.off("step", onStep);
    job.emitter.off("done", onDone);
    job.emitter.off("error", onError);
  });
});

router.get("/youtube/clips/status/:jobId", async (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }

  const localJob = clipJobs.get(jobId);
  if (localJob) {
    if (localJob.status === "done" && localJob.result) {
      res.json({
        status: "done",
        message: "Analysis complete",
        clips: localJob.result.clips ?? [],
        hasTranscript: localJob.result.hasTranscript ?? false,
        videoDuration: localJob.result.videoDuration ?? 0,
      });
      return;
    }
    if (localJob.status === "error") {
      res.json({
        status: "error",
        message: localJob.error ?? "Analysis failed",
      });
      return;
    }
    res.json({
      status: "running",
      message: "Analysis in progress",
    });
    return;
  }

  if (!isYoutubeQueueEnabledFor("best-clips")) {
    res.json({ status: "not_found", message: "Job not found" });
    return;
  }

  try {
    const queueStatus = await getYoutubeQueueJobStatus(jobId);
    if (!queueStatus) {
      res.json({ status: "not_found", message: "Job not found" });
      return;
    }
    let resultData: { clips: BestClip[]; hasTranscript: boolean; videoDuration: number } | null = null;
    if (queueStatus.status === "done" && queueStatus.resultJson) {
      try {
        resultData = JSON.parse(queueStatus.resultJson) as {
          clips: BestClip[];
          hasTranscript: boolean;
          videoDuration: number;
        };
      } catch (err) {
        req.log.error({ err, jobId }, "Failed to parse queued best-clips result in status route");
      }
    }
    res.json({
      status: queueStatus.status,
      message: queueStatus.message ?? queueStatus.status,
      queue: {
        updatedAt: queueStatus.updatedAt,
        batchJobId: queueStatus.batchJobId,
      },
      clips: resultData?.clips ?? [],
      hasTranscript: resultData?.hasTranscript ?? false,
      videoDuration: resultData?.videoDuration ?? 0,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "Failed to fetch best-clips status");
    res.status(500).json({ error: "Failed to fetch best-clips status" });
  }
});

export async function runClipAnalysis(
  jobId: string,
  job: ClipJob,
  url: string,
  durations: number[],
  log: any,
  autoMode: boolean = false,
  customInstructions?: string,
): Promise<void> {
  const emit = (event: string, data: object) => {
    if (event === "error" && job.emitter.listenerCount("error") === 0) {
      return false;
    }
    return job.emitter.emit(event, data);
  };
  const step = (
    step: string,
    status: "running" | "done" | "warn",
    message: string,
    data?: object,
  ) => emit("step", { step, status, message, ...data });

  job.status = "running";

  const clipDurations = durations.length > 0 ? durations : [60, 180];
  const tmpId = randomUUID();
  const subDir = join(DOWNLOAD_DIR, `subs_${tmpId}`);

  const durationLabels: Record<number, string> = {
    60: "1 minute",
    180: "3 minutes",
    480: "8-10 minutes (AI picks exact length)",
    9999: "≥ 5 minutes (AI picks exact length)",
  };

  try {
    let transcript = "";
    let videoDuration = 0;
    let videoTitle = "";
    let videoDescription = "";
    let metaSubtitleUrl: string | null = null;

    // ── Step 1: Video metadata ─────────────────────────────────────────────
    step("metadata", "running", "Fetching video info...");
    try {
      const meta = await runYtDlpMetadata(url);
      videoDuration = meta.duration ?? 0;
      videoTitle = meta.title ?? "";
      videoDescription = (meta.description ?? "").slice(0, 1000);

      // Extract subtitle URL from metadata so Step 2 can use it without another yt-dlp call
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      const videoLang: string | undefined =
        meta.language ?? meta.original_language ?? undefined;
      metaSubtitleUrl = pickBestSubtitleUrl(subs, autoCaps, videoLang);

      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        transcript = meta.chapters
          .map(
            (c: any) =>
              `[${formatTime(c.start_time)}–${formatTime(c.end_time ?? c.start_time + 60)}] Chapter: ${c.title}`,
          )
          .join("\n");
      }

      step(
        "metadata",
        "done",
        `"${videoTitle.slice(0, 60)}${videoTitle.length > 60 ? "…" : ""}"` +
          (videoDuration ? ` · ${formatTime(videoDuration)}` : ""),
        { videoTitle, videoDuration },
      );
    } catch (e) {
      const ytErr = e instanceof Error ? e.message : String(e);
      log.warn({ ytErr: ytErr.slice(0, 500), url }, "yt-dlp metadata fetch failed");
      // If yt-dlp is blocked by YouTube (bot detection / sign-in required), abort
      // immediately rather than proceeding to Gemini with no data — that would
      // silently return 0 clips, which is confusing.
      const isBlocked =
        /sign.in|bot|blocked|403|not available|This video is not available|This video has been|not made this video available|not available in your country|geo.*restrict/i.test(ytErr);
      const isGeo = /not made this video available|not available in your country|geo.*restrict|available in.*india|available in.*[a-z]+\./i.test(ytErr);
      const errMsg = isGeo
        ? (() => { const m = ytErr.match(/available in ([^.\n]+)/i); const c = m ? m[1].trim() : "certain countries"; return `This video is geo-restricted (only available in ${c}) and cannot be accessed from our servers.`; })()
        : isBlocked
          ? "YouTube is blocking server access to this video. Try a video from a different channel, or try again later."
          : "Could not load video info. Check the URL and try again.";
      job.status = "error";
      job.error = errMsg;
      emit("error", { message: errMsg });
      return;
    }

    // ── Step 2: Transcript ────────────────────────────────────────────────
    if (!transcript) {
      step("transcript", "running", "Downloading transcript...");
      let vttContent: string | null = null;

      // Approach 1: Direct URL fetch from metadata subtitle map (fastest, no extra yt-dlp)
      if (metaSubtitleUrl && !vttContent) {
        try {
          const raw = await fetchUrl(metaSubtitleUrl);
          if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
        } catch (_e) {}
      }

      // Approach 2: yt-dlp subtitle download WITHOUT js-runtime args (they break sub fetching)
      if (!vttContent) {
        try {
          mkdirSync(subDir, { recursive: true });
          const subBase = join(subDir, "sub");

          // Try 1: language-specific (en + hi + any auto)
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

          // Try 2: any language auto-subs if first attempt got nothing
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

          if (existsSync(subDir)) {
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
          }
        } catch (_e) {
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

      if (vttContent) {
        const cues = parseVtt(vttContent);
        const deduped: VttCue[] = [];
        for (const cue of cues) {
          if (!deduped.length || deduped[deduped.length - 1].text !== cue.text)
            deduped.push(cue);
        }
        transcript = cuesToText(deduped);
        step(
          "transcript",
          "done",
          `Transcript ready — ${deduped.length} lines`,
          { hasTranscript: true },
        );
      } else {
        step(
          "transcript",
          "warn",
          "No transcript found — AI will use title & description",
          { hasTranscript: false },
        );
      }
    } else {
      step(
        "transcript",
        "done",
        `${transcript.split("\n").length} chapter markers found`,
        { hasTranscript: true },
      );
    }

    // Fix #3: fail fast if no AI provider is available
    if (!isAiConfigured()) {
      job.status = "error";
      job.error = "No AI provider configured — add GEMINI_API_KEY or enable Replit integration";
      emit("error", { message: job.error });
      return;
    }

    const hasTranscript = transcript.length > 50;
    const filtered = clipDurations.filter((d) => {
      if (d === 9999) return !videoDuration || videoDuration > 300;
      return !videoDuration || d < videoDuration;
    });
    // Fix #4: fall back to full list if every duration was filtered out
    const validDurations = filtered.length > 0 ? filtered : clipDurations;

    // ── Step 3: AI analysis ───────────────────────────────────────────────
    step(
      "ai",
      "running",
      autoMode
        ? `AI is deciding the best clip durations and scanning the entire video...`
        : `AI is scanning every segment of the video for all ${validDurations.map((d) => durationLabels[d] ?? `${Math.round(d / 60)}min`).join(", ")} clips...`,
    );

    // Use smart sampling so very long transcripts still cover the full video
    const MAX_TRANSCRIPT_CHARS = 500000;
    const transcriptForAI = hasTranscript
      ? sampleTranscript(transcript, MAX_TRANSCRIPT_CHARS)
      : "";

    const transcriptBlock = transcriptForAI
      ? `\nTranscript (may be Hindi, English, or mixed — sampled evenly from full video):\n${transcriptForAI}`
      : "\n[No transcript available — use video title, description, and typical content structure to infer segments. Distribute clips evenly across the full runtime.]";

    // Proportional coverage guidance (shared by both modes)
    const videoHours = videoDuration ? videoDuration / 3600 : 0;
    const videoDurationLabel =
      videoHours >= 1
        ? `${Math.round(videoHours * 10) / 10}-hour`
        : `${Math.round(videoDuration / 60)}-minute`;
    // Fix #1: when a topic filter is active, the coverage mandate must NOT demand
    // a minimum clip count — that would force the AI to add off-topic clips.
    const coverageGuidance =
      videoDuration > 0
        ? customInstructions
          ? `\nCOVERAGE: Scan the ENTIRE ${videoDurationLabel} video (0s → ${formatTime(videoDuration)}) — do NOT stop early. Return EVERY matching segment you find throughout the full runtime, from start to end.`
          : `\nCOVERAGE MANDATE (${formatTime(videoDuration)} video):
- Scan the ENTIRE runtime from 0s to ${formatTime(videoDuration)} — do NOT stop early or cluster clips at the beginning
- Do NOT skip any section of the video cover all topics worth watching never force a clip from a dull or repetitive section
- Return EVERY segment you find throughout the full runtime, from start to end`
        : "";

    let systemPrompt: string;
    let userContent: string;

    // ── Shared cut-point rules (used in both modes) ───────────────────────
    const cutPointRules = `
HOW TO PICK startSec AND endSec — THIS IS THE MOST IMPORTANT PART:
- Use the transcript to read what the speaker says right up to your chosen endSec.
- startSec: the moment the segment's topic/idea/story actually begins — after any intro filler or transition.
- endSec: the LAST word of the speaker's complete thought, conclusion, punchline, or story beat — wherever the segment feels genuinely FINISHED.
- NEVER cut while someone is mid-sentence, mid-explanation, mid-story, or mid-argument.
- NEVER place endSec at a round number (e.g. exactly 60s, 180s, 300s) unless it genuinely coincides with a natural speech pause. Duration targets are guides, NOT cut points.
- If the natural ending of a segment is 40%, 60%, or even 100% longer than the target — that is CORRECT. Content quality beats duration precision. Always.
- Prefer ending on: a sentence-final pause, a punchline, a strong conclusion, a topic shift, applause, laughter, or a natural silence.
- For Hindi/mixed-language content: understand the language fully and find the natural linguistic boundary in whichever language is being spoken.`;

    if (autoMode) {
      // ── AUTO MODE: AI freely picks durations for every clip ───────────────
      systemPrompt = `You are a world-class video editor and content analyst. You are fluent in English and Hindi.

Your task: Watch the ENTIRE video and extract EVERY segment worth clipping. You have COMPLETE creative freedom — pick any startSec and endSec that makes the clip feel perfectly complete from beginning to end. There are no duration presets. Each clip's length emerges entirely from where the content naturally starts and ends naturally.
${coverageGuidance}
${cutPointRules}

Additional rules:
1. No duration presets, no clip count cap — return every worthwhile segment${customInstructions ? `\n2. TOPIC PRIORITY: The user wants clips focused on: "${customInstructions.slice(0, 300)}". Strongly prioritize segments that match this topic. If a segment closely matches, include it. If the video has little matching content, return the closest matching segments you can find rather than returning empty.` : ""}
${customInstructions ? "3." : "2."} Clips must NOT overlap each other
${customInstructions ? "4." : "3."} ${customInstructions ? "Scan the full video from start to end — prioritize clips matching the topic, but return something even if the match is approximate." : "Spread clips across the FULL runtime — start, every middle section, and end"}
${customInstructions ? "5." : "4."} targetDuration = Math.round(endSec - startSec) — just reflect the actual clip length you chose
${customInstructions ? "6." : "5."} startSec ≥ 0, endSec ≤ ${videoDuration || 99999}, endSec > startSec — plain integers
${customInstructions ? "7." : "6."} Write ALL output fields (title, description, reason) in English

CRITICAL: Respond with ONLY a valid JSON array — no markdown, no code fences, no extra text:
[{"targetDuration": <endSec minus startSec rounded to nearest second>, "startSec": <integer>, "endSec": <integer>, "title": "<English title>", "description": "<2-3 sentences English>", "reason": "<one sentence: what makes this a natural, complete standalone clip>"}]`;

      const instructionBlock = customInstructions
        ? `\n⚠️ TOPIC PRIORITY — READ THIS FIRST:\nThe user wants clips focused on: "${customInstructions}"\nStrongly prioritize segments matching this topic. If the video clearly discusses this topic somewhere, return those segments. If the match is approximate or the topic is discussed briefly, still return the best matching clip rather than nothing. Only return [] if the video has absolutely no connection to the topic at all.\n`
        : "";

      userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}${instructionBlock}
${transcriptBlock}

Find EVERY clip that matches the mandatory filter above (or every worthwhile clip if no filter is given). For each one: read the transcript carefully, find where the idea begins, read forward until you reach the natural conclusion of that idea — that is your endSec. No duration constraints, no clip count limit. Cover the full ${videoDuration ? formatTime(videoDuration) : "video"}.`;
    } else {
      // ── MANUAL MODE: fixed duration categories chosen by user ─────────────
      const durationDescList = validDurations
        .map((d) => {
          if (d === 9999) {
            return `- CATEGORY ">5 min" (targetDuration=9999): find clips longer than 5 minutes. You decide each clip's exact length — 6 min, 10 min, 20 min, whatever the content demands. No upper cap.`;
          }
          const label = durationLabels[d] ?? `${Math.round(d / 60)} minutes`;
          return `- CATEGORY "${label}" (targetDuration=${d}s): find clips roughly around ${label} long. The target is a loose guide — the actual clip must end at a natural speech/scene boundary even if that makes it noticeably shorter or longer (even if 1-2 mins more needed to clip perfectly when needed) than ${label}.`;
        })
        .join("\n");

      systemPrompt = `You are a world-class video editor and content analyst. You are fluent in English and Hindi.

Your task: Scan the ENTIRE video timeline from 0s to ${videoDuration || 99999}s and identify EVERY genuinely engaging segment for each requested duration category. There is NO upper limit on clip count — return every segment you find.
${coverageGuidance}
${cutPointRules}

Additional rules:
1. Find ALL non-overlapping segments per category — zero artificial cap${customInstructions ? `\n2. MANDATORY TOPIC FILTER: The user has strictly requested only: "${customInstructions}". You MUST ONLY return clips that directly and clearly match this. Skip any segment that does not match. Return [] if nothing matches.` : ""}
${customInstructions ? "3." : "2."} Segments of the same targetDuration must NOT overlap (across different targetDurations, overlap is fine)
${customInstructions ? "4." : "3."} ${customInstructions ? "Scan the full video from start to end — but ONLY return clips matching the topic filter. Never add off-topic clips to fill coverage." : "Spread clips across the ENTIRE runtime — don't cluster at the beginning"}
${customInstructions ? "5." : "4."} startSec ≥ 0, endSec ≤ ${videoDuration || 99999}, endSec > startSec — plain integers
${customInstructions ? "6." : "5."} Understand the transcript in whatever language it is (Hindi, English, mixed)
${customInstructions ? "7." : "6."} Write ALL output fields (title, description, reason) in English

CRITICAL: Respond with ONLY a valid JSON array — no markdown, no code fences, no explanation:
[{"targetDuration": <integer category value from the list>, "startSec": <integer>, "endSec": <integer>, "title": "<English title>", "description": "<2-3 sentences English>", "reason": "<one sentence English>"}]`;

      const manualInstructionBlock = customInstructions
        ? `\n⚠️ MANDATORY TOPIC FILTER — READ THIS FIRST:\nThe user has given you a strict filter: "${customInstructions}"\nYou MUST ONLY return clips that directly and clearly match this filter. Skip EVERY segment that does not match, even if it is otherwise interesting or high-quality. If no segments match the filter for a duration category, omit that category entirely.\n`
        : "";

      userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}${manualInstructionBlock}
${transcriptBlock}

Find EVERY clip matching the mandatory filter (or every worthwhile clip if no filter) for these categories:
${durationDescList}

For each clip: read the transcript to find where the idea begins (startSec) and where the speaker's complete thought finishes (endSec). The transcript is your source of truth for cut points — not the duration target. Scan the WHOLE video. No clip count limit.`;
    }

    const raw = (await clipsGeminiContent(systemPrompt, userContent)).trim();

    // Robust parsing — handles markdown fences, surrounding text, type coercion
    const parsed = extractJsonArray(raw);
    if (!parsed) {
      log.error(
        { raw: raw.slice(0, 500) },
        "Failed to parse Gemini response as JSON",
      );
      job.status = "error";
      job.error = "Failed to parse AI response — please try again";
      emit("error", { message: job.error });
      return;
    }

    const clips: BestClip[] = parsed
      .filter((c: any) => {
        if (!c || typeof c !== "object") return false;
        // Coerce strings to numbers — AI sometimes quotes numbers
        const startSec = parseFloat(c.startSec);
        const endSec = parseFloat(c.endSec);
        const hasSecs = !isNaN(startSec) && !isNaN(endSec) && endSec > startSec;
        const targetRaw = c.targetDuration ?? c.durationSec ?? c.duration;
        const hasTarget = targetRaw != null && !isNaN(parseFloat(targetRaw));
        return hasSecs && hasTarget;
      })
      .map((c: any): BestClip => {
        const targetDur: number = Math.round(
          parseFloat(c.targetDuration ?? c.durationSec ?? c.duration),
        );
        // Cap startSec so it can never exceed videoDuration (avoids endSec < startSec after capping)
        const maxStart = videoDuration ? Math.max(0, videoDuration - 2) : 99997;
        const startSec = Math.max(
          0,
          Math.min(maxStart, Math.round(parseFloat(c.startSec))),
        );
        const endSec = Math.min(
          videoDuration || 99999,
          Math.max(
            startSec + 1,
            Math.round(parseFloat(c.endSec) ?? startSec + targetDur),
          ),
        );
        const actualMins = Math.round((endSec - startSec) / 60);
        const actualDur = endSec - startSec;

        // In auto mode the AI returns the clip's real duration as targetDur.
        // Bucket it into one of the UI preset buckets so grouping is clean.
        let bucketedDur: number;
        if (autoMode) {
          if (targetDur === 9999 || actualDur > 300) bucketedDur = 9999;
          else if (actualDur > 120) bucketedDur = 180;
          else bucketedDur = 60;
        } else {
          bucketedDur = targetDur;
        }

        const durationLabel =
          bucketedDur === 9999
            ? `> 5 min (${actualMins}m)`
            : (durationLabels[bucketedDur] ??
              `~${Math.round(bucketedDur / 60)} min`);
        return {
          durationLabel,
          durationSec: bucketedDur,
          startSec,
          endSec,
          startFormatted: formatTime(startSec),
          endFormatted: formatTime(endSec),
          title:
            c.title ??
            `Best ${durationLabels[targetDur] ?? targetDur + "s"} clip`,
          description: c.description ?? "",
          reason: c.reason ?? "",
        };
      })
      // Safety: drop any clip where capping produced endSec <= startSec, or clip is under 30s (hallucination guard)
      .filter((clip) => clip.endSec > clip.startSec && (clip.endSec - clip.startSec) >= 30)
      .sort((a, b) =>
        a.durationSec !== b.durationSec
          ? a.durationSec - b.durationSec
          : a.startSec - b.startSec,
      );

    step(
      "ai",
      "done",
      `Found ${clips.length} clips across ${validDurations.length} duration${validDurations.length !== 1 ? "s" : ""}`,
      { clipCount: clips.length },
    );

    log.info({ totalClips: clips.length }, "Clips analysis complete");

    const resultData = { clips, hasTranscript, videoDuration };
    job.status = "done";
    job.result = resultData;
    void notifyClientPush(job.notifyClientKey, {
      title: "Best clips ready",
      body: `${clips.length} clips are ready to download.`,
      url: "/",
      tag: `bestclips:${jobId}`,
      silent: false,
    });
    emit("done", resultData);
  } catch (err) {
    log.error({ err }, "Clip analysis failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    job.status = "error";
    job.error = message;
    void notifyClientPush(job.notifyClientKey, {
      title: "Best clips failed",
      body: message.slice(0, 200),
      url: "/",
      tag: `bestclips-error:${jobId}`,
      silent: true,
    });
    emit("error", { message });
    // Cleanup subtitle dir if it exists
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

// ─── Clip Download (specific time range) ─────────────────────────────────────

router.post("/youtube/download-clip", legacyDownloadClipRateLimiter, async (req: Request, res: Response) => {
  const { url, startSec, endSec, title, quality } = req.body as {
    url: string;
    startSec: number;
    endSec: number;
    title?: string;
    quality?: string;
  };

  if (!url || startSec == null || endSec == null) {
    res.status(400).json({ error: "url, startSec, and endSec are required" });
    return;
  }
  if (typeof startSec !== "number" || typeof endSec !== "number") {
    res.status(400).json({ error: "startSec and endSec (in seconds) must be numbers" });
    return;
  }
  if (endSec <= startSec) {
    res.status(400).json({ error: "endSec must be greater than startSec" });
    return;
  }
  if (endSec - startSec > 3600) {
    res.status(400).json({ error: "Clip cannot exceed 60 minutes" });
    return;
  }
  const normalizedUrl = normalizeInputUrl(url);

  const safeTitle = (title ?? "clip")
    .replace(/[^\w\s\-_.()]/g, "_")
    .slice(0, 60);
  const jobId = randomUUID();
  const notifyClientKey = getNotifyClientKey(req);

  if (isYoutubeQueuePrimaryEnabledFor("clip-cut") && !shouldRunClipInLambda(startSec, endSec)) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "clip-cut",
        sourceUrl: normalizedUrl,
        meta: {
          startSec,
          endSec,
          quality: quality ?? "best",
          source: "legacy-download-clip",
          notifyClientKey: notifyClientKey ?? null,
        },
      });
      res.json({ jobId, status: "queued", message: "Clip download queued" });
    } catch (err) {
      req.log.error({ err, jobId }, "Failed to submit primary queue legacy clip job");
      res.status(502).json({ error: "Failed to queue clip download job" });
    }
    return;
  }

  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: `${safeTitle}.mp4`,
    filesize: null,
    message: "Queued - starting soon...",
    filePath: null,
    url: normalizedUrl,
    formatId: "clip",
    audioOnly: false,
    ext: "mp4",
    clipStart: startSec,
    clipEnd: endSec,
    clipQuality: quality ?? "best",
    notifyClientKey,
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Clip download started" });

  void submitYoutubeQueueShadowJob({
    jobId,
    jobType: "clip-cut",
    sourceUrl: normalizedUrl,
    meta: {
      startSec,
      endSec,
      quality: quality ?? "best",
      source: "legacy-download-clip",
    },
  }).catch((err) => {
    req.log.warn({ err, jobId }, "Failed to submit shadow queue legacy clip job");
  });

  enqueueClipJob(jobId, () => processClipCut(jobId, job)).catch((err) => {
    req.log.error({ err, jobId }, "Clip download failed");
    const j = jobs.get(jobId);
    if (!j) return;
    const message = err instanceof Error ? err.message : "Clip download failed";
    if (message === CANCELLED_BY_USER || j.cancelled) {
      j.status = "cancelled";
      j.message = CANCELLED_BY_USER;
    } else {
      j.status = "error";
      j.message = message;
      pushFailureNotification(
        j,
        "Clip download failed",
        message.slice(0, 200),
        `clip-error:${jobId}`,
      );
    }
  });
});

export default router;

export function getYoutubeOpsSnapshot() {
  let activeDownloads = 0;
  let activeClipJobs = 0;
  let pendingJobs = 0;

  for (const job of jobs.values()) {
    if (job.status === "pending") pendingJobs += 1;
    if (job.formatId === "clip") {
      if (["pending", "downloading", "merging"].includes(job.status)) {
        activeClipJobs += 1;
      }
    } else if (["pending", "downloading", "merging"].includes(job.status)) {
      activeDownloads += 1;
    }
  }

  return {
    limits: {
      maxConcurrentClipJobs: MAX_CONCURRENT_CLIP_JOBS,
      maxClipAttempts: MAX_CLIP_DOWNLOAD_ATTEMPTS,
    },
    queue: {
      queuedClipJobs: queuedClipJobs.length,
      activeClipJobSlotsUsed: activeClipJobCount,
      pendingJobs,
      activeClipJobs,
      activeDownloads,
      totalTrackedJobs: jobs.size,
    },
  };
}

export function createClipJobState(jobId: string, initial: Partial<ClipJob>): ClipJob {
  const job: ClipJob = {
    emitter: initial.emitter ?? new EventEmitter(),
    status: initial.status ?? "pending",
    result: initial.result,
    error: initial.error,
    createdAt: initial.createdAt ?? Date.now(),
    notifyClientKey: initial.notifyClientKey ?? null,
  };
  job.emitter.setMaxListeners(5);
  clipJobs.set(jobId, job);
  return job;
}

export function getClipJobState(jobId: string): ClipJob | undefined {
  return clipJobs.get(jobId);
}

export function deleteClipJobState(jobId: string): void {
  clipJobs.delete(jobId);
}
