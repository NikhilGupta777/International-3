import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, createReadStream,
} from "fs";
import { join, dirname, basename } from "path";
import { spawn, execFileSync } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger";
import ffmpegStatic from "ffmpeg-static";
import { getNotifyClientKey, notifyClientPush } from "../lib/push-notifications";
import {
  createS3PresignedUpload,
  readTextFromS3,
} from "../lib/s3-storage";
import {
  cancelYoutubeQueueJob,
  getYoutubeQueueJobStatus,
  isYoutubeQueueEnabledFor,
  isYoutubeQueuePrimaryEnabledFor,
  submitYoutubeQueuePrimaryJob,
} from "../lib/youtube-queue";

const router = Router();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/tmp/ytgrabber";

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

// Default ON as requested: subtitles run directly on API Lambda path.
const SUBTITLES_FORCE_LAMBDA = envBool(process.env.SUBTITLES_FORCE_LAMBDA, true);
const isSubtitlesQueuePrimaryEnabled = (): boolean =>
  !SUBTITLES_FORCE_LAMBDA && isYoutubeQueuePrimaryEnabledFor("subtitles");
const isSubtitlesQueueEnabled = (): boolean =>
  !SUBTITLES_FORCE_LAMBDA && isYoutubeQueueEnabledFor("subtitles");

// ── Python / yt-dlp environment (mirrors setup in youtube.ts) ────────────────
// Make yt-dlp visible to Python without overriding system PATH in environments
// where .pythonlibs does not exist (e.g. the Docker production container).
const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();

function buildPythonEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const pythonLibsBin = join(workspaceRoot, ".pythonlibs", "bin");
  const pythonLibsLib = join(workspaceRoot, ".pythonlibs", "lib");

  if (!existsSync(pythonLibsBin)) {
    return { ...process.env, PYTHONUNBUFFERED: "1" };
  }

  let sitePackages = join(pythonLibsLib, "python3.11", "site-packages");
  try {
    const entries = readdirSync(pythonLibsLib);
    const pyDir = entries.find((e) => /^python3\.\d+$/.test(e));
    if (pyDir) sitePackages = join(pythonLibsLib, pyDir, "site-packages");
  } catch {}

  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PATH: `${pythonLibsBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONPATH: sitePackages,
  };
}

const PYTHON_ENV = buildPythonEnv(_workspaceRoot);
const PYTHON_BIN =
  process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");

// ── yt-dlp config (mirrors youtube.ts / bhagwat.ts) ─────────────────────────
const YTDLP_PROXY        = process.env.YTDLP_PROXY ?? "";
const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";
const YTDLP_PO_TOKEN     = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const HAS_DYNAMIC_POT_PROVIDER = !!YTDLP_POT_PROVIDER_URL;
const HAS_STATIC_PO_TOKEN = !!(YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA);
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE || join(_workspaceRoot, ".yt-cookies.txt");
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";

// ── AssemblyAI — used for audio > 10 minutes ─────────────────────────────────
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
const ASSEMBLYAI_THRESHOLD_SECS = 600; // 10 minutes

// Base args applied to every yt-dlp call (matches youtube.ts for consistency).
const YTDLP_BASE_ARGS: string[] = [
  "--retries",            "5",
  "--fragment-retries",   "5",
  "--extractor-retries",  "5",
  "--socket-timeout",     "30",
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
  "--sleep-interval",  "2",
];

if (ffmpegStatic) YTDLP_BASE_ARGS.push("--ffmpeg-location", ffmpegStatic);
if (YTDLP_PROXY) YTDLP_BASE_ARGS.push("--proxy", YTDLP_PROXY);

if (HAS_DYNAMIC_POT_PROVIDER) {
  YTDLP_BASE_ARGS.push(
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`,
  );
}

function getDefaultSrtYoutubeExtractorArgs(): string[] {
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
  // Browser cookies are tied to web clients. Prefer web when cookies exist.
  const hasCookies = getSrtCookieArgs().length > 0;
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

function getSrtYoutubeFallbacks(): string[][] {
  if (HAS_DYNAMIC_POT_PROVIDER || HAS_STATIC_PO_TOKEN) {
    return [
      ["--extractor-args", "youtube:player_client=web,web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=mweb,ios"],
      ["--extractor-args", "youtube:player_client=ios"],
      ["--extractor-args", "youtube:player_client=android_vr"],
    ];
  }
  const hasCookies = getSrtCookieArgs().length > 0;
  if (hasCookies) {
    // Keep web-first fallback order when authenticated browser cookies are present.
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

let ensureYtdlpCookiesPromise: Promise<void> | null = null;

async function ensureYtdlpCookiesLoaded(): Promise<void> {
  if (!YTDLP_COOKIES_S3_KEY) return;

  // If the cookie file was cleaned up by OS (e.g. /tmp purge), reset the singleton
  // so we reload from S3 rather than silently using no cookies for the rest of the session.
  if (!existsSync(YTDLP_COOKIES_FILE) && ensureYtdlpCookiesPromise) {
    ensureYtdlpCookiesPromise = null;
    logger.warn({ file: YTDLP_COOKIES_FILE }, "Cookie file missing — resetting load promise to re-fetch from S3");
  }

  if (existsSync(YTDLP_COOKIES_FILE)) {
    if (getSrtCookieArgs().length > 0) return;
  }

  if (!ensureYtdlpCookiesPromise) {
    ensureYtdlpCookiesPromise = (async () => {
      try {
        const encoded = (await readTextFromS3(YTDLP_COOKIES_S3_KEY)).trim();
        if (!encoded) return;
        const cookieContent = decodeCookiesFromBase64(encoded);
        if (!cookieContent) {
          logger.warn({ key: YTDLP_COOKIES_S3_KEY }, "S3 cookie payload could not be converted to Netscape format");
          return;
        }
        const cookieDir = dirname(YTDLP_COOKIES_FILE);
        if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
        writeFileSync(YTDLP_COOKIES_FILE, cookieContent, "utf8");
        logger.info({ key: YTDLP_COOKIES_S3_KEY }, "Loaded yt-dlp cookies from S3 for subtitles");
      } catch (e) {
        // Reset promise so the next request can retry loading cookies
        ensureYtdlpCookiesPromise = null;
        logger.error({ err: e, key: YTDLP_COOKIES_S3_KEY }, "Failed to load yt-dlp cookies from S3");
      }
    })();
  }
  await ensureYtdlpCookiesPromise;
}

// Return cookie args only when the cookies file exists and is a valid Netscape file.
function getSrtCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE) return [];
  try {
    if (!existsSync(YTDLP_COOKIES_FILE)) return [];
    const stat = statSync(YTDLP_COOKIES_FILE);
    if (!stat.isFile() || stat.size < 24) return [];
    const header = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (
      !header.startsWith("# Netscape HTTP Cookie File") &&
      !header.startsWith(".youtube.com")
    ) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch { return []; }
}

// YouTube block detection — broad pattern to catch all YouTube error variants in 2025/2026.
function isSrtYtBlocked(msg: string): boolean {
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|sign.*in.*your age|age.*restrict|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|video.*unavailable.*country|precondition.*failed|http error 401|not made this video available|not available in your country|geo.*restrict|requested format is not available/i.test(msg);
}

// Fallback clients ordered by reliability on AWS/datacenter IPs.
// tv_embedded (YouTube TV embedded player) is the least bot-checked on server IPs.
const SRT_YTDLP_FALLBACKS: string[][] = getSrtYoutubeFallbacks();

/**
 * Run yt-dlp to download audio for a subtitles job.
 * Supports cancellation via job.cancelled and retries with fallback clients on YouTube bot-blocks.
 */
async function runYtDlpAudio(args: string[], job: { cancelled?: boolean }): Promise<void> {
  function spawnOnce(extraArgs: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(
        PYTHON_BIN,
        ["-m", "yt_dlp", ...YTDLP_BASE_ARGS, ...extraArgs, ...args],
        { env: PYTHON_ENV },
      );
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      const cancelPoll = setInterval(() => {
        if (job.cancelled) {
          clearInterval(cancelPoll);
          try { proc.kill("SIGTERM"); } catch {}
        }
      }, 500);
      proc.on("close", (code) => {
        clearInterval(cancelPoll);
        if (job.cancelled) resolve();
        else if (code === 0) resolve();
        else reject(new Error(stderr.slice(-400) || `yt-dlp exited ${code}`));
      });
      proc.on("error", (err) => { clearInterval(cancelPoll); reject(err); });
    });
  }

  await ensureYtdlpCookiesLoaded();

  const cookieArgs = getSrtCookieArgs();
  const defaultYoutubeArgs = getDefaultSrtYoutubeExtractorArgs();
  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);

  let lastErr: Error | null = null;
  const attempted = new Set<string>();

  for (const extra of attemptPlans) {
    if (job.cancelled) return;
    const key = extra.join("\x01");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      await spawnOnce(extra);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp failed");
      if (!isSrtYtBlocked(lastErr.message)) throw lastErr;
    }
  }

  for (const fallback of SRT_YTDLP_FALLBACKS) {
    if (job.cancelled) return;
    const plans = cookieArgs.length ? [[...cookieArgs, ...fallback], fallback] : [fallback];
    for (const extra of plans) {
      const key = extra.join("\x01");
      if (attempted.has(key)) continue;
      attempted.add(key);
      try {
        await spawnOnce(extra);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error("yt-dlp fallback failed");
      }
    }
  }

  throw lastErr ?? new Error("yt-dlp: all clients failed");
}

// ── In-memory job store ──────────────────────────────────────────────────────
type JobStatus = "pending" | "audio" | "uploading" | "generating" | "correcting" | "translating" | "verifying" | "done" | "error" | "cancelled";
export interface SrtJob {
  status: JobStatus;
  message: string;
  srt?: string;
  originalSrt?: string;
  error?: string;
  filename: string;
  originalFilename?: string;
  createdAt: number;
  completedAt?: number;  // set when job reaches a terminal state (done/error/cancelled)
  translateTo?: string;
  cancelled?: boolean;
  durationSecs?: number;
  progressPct?: number;
  notifyClientKey?: string | null;
  errorNotified?: boolean;
}
const jobs = new Map<string, SrtJob>();
const CANCELLED_BY_USER = "Cancelled by user";

function notifySubtitleReady(jobId: string, job: SrtJob): void {
  void notifyClientPush(job.notifyClientKey, {
    title: "Subtitles ready",
    body: job.filename || "Your subtitle file is ready.",
    url: "/",
    tag: `subtitles:${jobId}`,
    silent: false,
  });
}

type QueuedSubtitleJob = {
  jobId: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

const MAX_CONCURRENT_SUBTITLE_JOBS = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_SUBTITLE_JOBS ?? "3", 10) || 3,
);
let activeSubtitleJobCount = 0;
const queuedSubtitleJobs: QueuedSubtitleJob[] = [];
const queuedSubtitleJobIds = new Set<string>();

function updateQueuedSubtitleJobMessages(): void {
  queuedSubtitleJobs.forEach((entry, index) => {
    const job = jobs.get(entry.jobId);
    if (!job || job.cancelled) return;
    job.status = "pending";
    job.progressPct = 0;
    job.message =
      index === 0 && activeSubtitleJobCount < MAX_CONCURRENT_SUBTITLE_JOBS
        ? "Queued - starting soon..."
        : `Queued (#${index + 1})`;
  });
}

function drainQueuedSubtitleJobs(): void {
  while (
    activeSubtitleJobCount < MAX_CONCURRENT_SUBTITLE_JOBS &&
    queuedSubtitleJobs.length > 0
  ) {
    const next = queuedSubtitleJobs.shift()!;
    queuedSubtitleJobIds.delete(next.jobId);
    const job = jobs.get(next.jobId);
    if (!job || job.cancelled) {
      next.reject(new Error(CANCELLED_BY_USER));
      updateQueuedSubtitleJobMessages();
      continue;
    }

    activeSubtitleJobCount += 1;
    job.status = "pending";
    job.progressPct = 0;
    job.message = "Starting subtitle job...";

    Promise.resolve()
      .then(next.run)
      .then(() => next.resolve())
      .catch((err) =>
        next.reject(err instanceof Error ? err : new Error("Subtitle job failed")),
      )
      .finally(() => {
        activeSubtitleJobCount = Math.max(0, activeSubtitleJobCount - 1);
        updateQueuedSubtitleJobMessages();
        drainQueuedSubtitleJobs();
      });
  }
}

function enqueueSubtitleJob(jobId: string, run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queuedSubtitleJobs.push({
      jobId,
      run,
      resolve,
      reject: (err: Error) => reject(err),
    });
    queuedSubtitleJobIds.add(jobId);
    updateQueuedSubtitleJobMessages();
    drainQueuedSubtitleJobs();
  });
}

function dequeueSubtitleJob(jobId: string): boolean {
  const index = queuedSubtitleJobs.findIndex((entry) => entry.jobId === jobId);
  if (index === -1) return false;
  const [entry] = queuedSubtitleJobs.splice(index, 1);
  queuedSubtitleJobIds.delete(jobId);
  entry.reject(new Error(CANCELLED_BY_USER));
  updateQueuedSubtitleJobMessages();
  return true;
}

type RateWindow = { count: number; resetAt: number };
const rateWindows = new Map<string, RateWindow>();
const RATE_LIMIT_WINDOW_MS = 3 * 60 * 1000;
const RATE_LIMITS = {
  "POST /subtitles/generate": 3,
  "POST /subtitles/upload": 3,
  "POST /subtitles/cancel/:jobId": 180, // 60/min
} as const;
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
        .json({ error: `Rate limit exceeded. Try again in ${minutesLeft} minutes.` });
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

const subtitlesGenerateRateLimiter = createIpRateLimiter(
  "POST /subtitles/generate",
);
const subtitlesUploadRateLimiter = createIpRateLimiter(
  "POST /subtitles/upload",
);
const subtitlesCancelRateLimiter = createIpRateLimiter(
  "POST /subtitles/cancel/:jobId",
);

// ── Job cleanup rules ─────────────────────────────────────────────────────────
// • Completed jobs (done/error/cancelled): kept for 2 hours after they FINISH,
//   giving users a generous window to return and retrieve their results.
// • Stuck / still-running jobs: cleaned up after 60 minutes from creation
//   (generous enough to cover the longest subtitle job).
const COMPLETED_JOB_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours after completion
const RUNNING_JOB_TTL_MS   = 60 * 60 * 1000;         // 1 hour from creation

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const isTerminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
    if (isTerminal && job.completedAt) {
      // Keep completed jobs for 2 hours after they finished
      if (now - job.completedAt > COMPLETED_JOB_TTL_MS) jobs.delete(id);
    } else {
      // Clean up jobs that have been running for more than 1 hour (stuck or very slow)
      if (now - job.createdAt > RUNNING_JOB_TTL_MS) jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── WAV cache for URL retries ────────────────────────────────────────────────
// Caches preprocessed 16kHz WAV files by YouTube URL so retries skip the
// download and re-preprocessing steps entirely.
interface CachedWav { wavPath: string; mimeType: string; durationSecs: number; createdAt: number; }
const urlWavCache = new Map<string, CachedWav>();
const WAV_CACHE_DIR = join(DOWNLOAD_DIR, "wav-cache");

setInterval(() => {
  const cutoff = Date.now() - 90 * 60 * 1000; // 90-min TTL
  for (const [url, entry] of urlWavCache) {
    if (entry.createdAt < cutoff) {
      try { rmSync(entry.wavPath); } catch {}
      urlWavCache.delete(url);
    }
  }
}, 20 * 60 * 1000);

// Disk storage for uploaded files
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(DOWNLOAD_DIR, "srt-uploads");
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop() ?? "bin";
    cb(null, `${randomUUID()}.${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

function resolveSystemBinary(bin: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const output = execFileSync(finder, [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return null;
    const first = output.split(/\r?\n/).find(Boolean)?.trim();
    return first || null;
  } catch {
    return null;
  }
}

function resolveFfprobeFromFfmpegPath(ffmpegPath: string | null): string | null {
  if (!ffmpegPath) return null;
  const dir = dirname(ffmpegPath);
  const ffmpegName = basename(ffmpegPath).toLowerCase();
  const probeName = ffmpegName.endsWith(".exe") ? "ffprobe.exe" : "ffprobe";
  const probePath = join(dir, probeName);
  return existsSync(probePath) ? probePath : null;
}

const SYSTEM_FFMPEG = resolveSystemBinary("ffmpeg");
const SYSTEM_FFPROBE = resolveSystemBinary("ffprobe");
const FFMPEG_BIN = SYSTEM_FFMPEG ?? ffmpegStatic ?? "ffmpeg";
const FFPROBE_BIN =
  SYSTEM_FFPROBE ??
  resolveFfprobeFromFfmpegPath(
    ffmpegStatic ? String(ffmpegStatic) : null,
  );

function pickFirst(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com")) {
      const watchId = u.searchParams.get("v");
      if (watchId) return watchId;
      const parts = u.pathname.split("/").filter(Boolean);
      if (
        parts[0] === "shorts" ||
        parts[0] === "embed" ||
        parts[0] === "live"
      ) {
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
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    const host = u.hostname.toLowerCase();
    const isYouTube =
      host.includes("youtube.com") || host.includes("youtu.be");
    if (!isYouTube) return candidate;
    const videoId = extractVideoId(candidate);
    if (!videoId) return candidate;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return trimmed;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function audioMimeType(ext: string): string {
  const map: Record<string, string> = {
    m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm",
    ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg",
    flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
    mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime",
  };
  return map[ext.toLowerCase()] ?? "audio/mpeg";
}

function isAiConfigured(): boolean {
  return !!(
    (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY) ||
    getAllPersonalGeminiKeys().length > 0
  );
}

// 5-minute per-key timeout — keeps key rotation fast; generous enough for large audio
const GEMINI_TIMEOUT_MS = 5 * 60 * 1000;

function getGenAI(): GoogleGenAI | null {
  const directKey = getAllPersonalGeminiKeys()[0] ?? null;
  if (directKey) {
    return new GoogleGenAI({ apiKey: directKey, httpOptions: { timeout: GEMINI_TIMEOUT_MS } });
  }
  return null;
}

// Returns all configured personal API keys in order:
// GEMINI_API_KEY (or GOOGLE_API_KEY fallback), GEMINI_API_KEY_2..GEMINI_API_KEY_10.
function getAllPersonalGeminiKeys(): string[] {
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

// Returns all configured personal API key clients in order.
function getAllPersonalGenAIClients(): GoogleGenAI[] {
  return getAllPersonalGeminiKeys()
    .map((apiKey) => new GoogleGenAI({ apiKey, httpOptions: { timeout: GEMINI_TIMEOUT_MS } }));
}

function isGeminiRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /resource_exhausted|quota|429|rate.?limit|unavailable|503|deadline|timeout|internal|500|overloaded|try again later/i.test(msg);
}

function getReplitGenAI(): GoogleGenAI | null {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (baseUrl && apiKey) {
    return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl, timeout: GEMINI_TIMEOUT_MS } });
  }
  return null;
}

// Passes 1 & 2 (audio-dependent): use personal keys only with key rotation.
// gemini-3-flash-preview is primary (fast transcription).
// gemini-2.5-pro is the quality fallback.
// Rotates to the next key on 429 rate limit. Throws if all keys are exhausted.
const KEY_ROTATION_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
];

async function generateWithKeyRotation(
  requestFactory: (model: string) => any,
  label: string,
): Promise<string> {
  const clients = getAllPersonalGenAIClients();
  if (clients.length === 0) {
    throw new Error("No Gemini API key configured — add GEMINI_API_KEY");
  }

  let lastErr: unknown;

  // Outer loop: model. Inner loop: key.
  // All 4 keys are tried for each model before falling to the next model.
  for (const model of KEY_ROTATION_MODELS) {
    for (let i = 0; i < clients.length; i++) {
      const keyLabel = `key ${i + 1}`;
      try {
        const result = await clients[i].models.generateContent(requestFactory(model));
        logger.info({ model, keyLabel, label }, `${label} completed via personal ${keyLabel}`);
        return result.text?.trim() ?? "";
      } catch (err) {
        lastErr = err;
        const isQuota = isGeminiRetryableError(err);
        if (isQuota) {
          logger.warn({ model, keyLabel, label }, `${label} ${keyLabel} rate limited on ${model} — trying next`);
        } else {
          // Keep rotating across keys/models even on non-quota failures.
          logger.warn({ err, model, keyLabel, label }, `${label} ${keyLabel} failed (non-quota error) — trying next`);
        }
      }
    }
    logger.warn({ model, label }, `${label} all keys failed on ${model} — trying next model`);
  }

  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed on all keys and all models`);
}

// Passes 3 & 4 (text-only): try Replit integration first, fall back to personal key rotation.
async function generateWithReplitFirst(
  replitModel: string,
  requestFactory: (model: string) => any,
  label: string,
): Promise<string> {
  const replitClient = getReplitGenAI();

  if (replitClient) {
    try {
      const result = await replitClient.models.generateContent(requestFactory(replitModel));
      logger.info({ model: replitModel, label }, `${label} completed via Replit integration`);
      return result.text?.trim() ?? "";
    } catch (err) {
      logger.warn(
        { err, model: replitModel, label },
        `${label} Replit failed — falling back to personal key rotation`,
      );
    }
  }

  return generateWithKeyRotation(requestFactory, label);
}

function buildSrtPrompt(language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio may be in any language — transcribe it in the original language spoken, do NOT translate."
      : `The audio is in ${language}. Transcribe it in ${language} exactly as spoken — do NOT translate.`;

  return `You are a professional subtitle creator. Listen to the ENTIRE audio from start to finish and produce a complete, accurate SRT subtitle file.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. You MUST transcribe ALL speech from 00:00:00 all the way to ${durationSrt}. Do NOT stop early. Even if there are quiet sections or pauses, continue listening — more speech follows.

CRITICAL TIMESTAMP FORMAT:
- Every timestamp MUST use HH:MM:SS,mmm format with ALL THREE parts separated by colons
- CORRECT: 00:01:23,456  (hours:minutes:seconds,milliseconds)
- WRONG:   01:23,456     (missing hours — NEVER use this format)
- WRONG:   1:23,456      (missing hours — NEVER use this format)
- The hours part is ALWAYS required, even when it is 00
- Use COMMA for milliseconds separator (not dot)
- All timestamps MUST be within 00:00:00,000 to ${durationSrt},000

STRICT SRT FORMAT RULES:
1. Each entry has exactly 3 parts, followed by a blank line:
   (a) A sequential number (1, 2, 3 ...)
   (b) A timestamp line: HH:MM:SS,mmm --> HH:MM:SS,mmm
   (c) The spoken text — MAXIMUM 6 WORDS per entry (1 line only)
2. WORD LIMIT IS MANDATORY: Each subtitle entry must contain NO MORE THAN 6 words. This is the most important rule.
   - If 10 words are spoken in a stretch, split them into 2 entries of ~5 words each with proportional timestamps.
   - If 15 words are spoken, split into 3 entries of 5 words each.
   - Never pack more than 6 words into one entry under any circumstances.
3. Each subtitle entry should cover 1-4 seconds of audio (shorter entries = better readability)
4. Transcribe EVERY word spoken — do not skip, skip sections, or summarize anything
5. If there is a quiet section or pause, keep listening — do not stop — transcribe what comes after
6. For unclear words, make your best guess based on context and language
7. Do NOT translate — keep the original spoken language
8. Do NOT write non-speech annotations like [music], [background noise], [silence], [applause], [inaudible] etc. — only transcribe actual spoken words
9. Return ONLY the SRT content — no explanations, no markdown fences, no extra text

Example of CORRECT format — notice each entry has at most 6 words:
1
00:00:01,000 --> 00:00:02,500
Welcome to today's session.

2
00:00:02,500 --> 00:00:04,200
We will discuss several topics.

3
00:00:04,200 --> 00:00:05,800
Starting with the basics first.

4
00:01:04,600 --> 00:01:06,200
Speech that starts at one

5
00:01:06,200 --> 00:01:08,000
minute four seconds exactly here.

Now transcribe the ENTIRE audio from beginning to end:`;
}

function buildCorrectionPrompt(rawSrt: string, language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio and subtitles are in their original language — do NOT translate anything."
      : `The audio and subtitles are in ${language} — do NOT translate anything.`;

  return `You are an expert subtitle proofreader and corrector. I will give you an audio recording and a draft SRT subtitle file that was auto-generated from it.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. All timestamps MUST be within 00:00:00,000 to ${durationSrt},000. If you see any timestamp beyond ${durationSrt}, it is a hallucination — fix it.

CRITICAL TIMESTAMP FORMAT:
- Every timestamp MUST use HH:MM:SS,mmm format with ALL THREE parts (hours:minutes:seconds,milliseconds)
- CORRECT: 00:01:23,456  — WRONG: 01:23,456 (missing hours) — WRONG: 1:23,456 (missing hours)
- The hours part is ALWAYS required, even when it is 00

IMPORTANT: The draft SRT may be INCOMPLETE — it may only cover part of the audio. Listen to the ENTIRE audio from start to ${durationSrt} and ADD any speech that is missing from the draft. Do not stop at the last entry of the draft if there is more speech in the audio.

Your task: Listen to the ENTIRE audio, fix ALL errors in the SRT, and add any missing speech.

Common errors to fix:
- Wrong words (mishearings, similar-sounding words mixed up)
- Missing words or phrases that are clearly spoken but not in the SRT
- Hallucinated words (text in the SRT that is NOT actually spoken in the audio)
- Wrong word forms (e.g., wrong verb endings, missing particles/suffixes)
- Timestamp mismatches (subtitle appearing too early or too late)
- Timestamps using wrong format (MM:SS,mmm instead of HH:MM:SS,mmm — fix these)
- Timestamps that go BEYOND the audio duration
- MISSING ENTRIES: speech that occurs after the last SRT entry — add them
- Duplicate entries: two entries with nearly identical text for the same moment — keep only one
- OVERFULL ENTRIES: any entry with more than 6 words MUST be split into shorter entries with proportional timestamps

WORD LIMIT RULE (MANDATORY):
- Each subtitle entry must contain NO MORE THAN 6 words
- If an existing entry has 10 words, split it into 2 entries of ~5 words with proportional timestamps
- If an existing entry has 12 words, split it into 2–3 entries of 4–6 words each
- This applies to every single entry — check them all

IMPORTANT RULES:
- Keep the exact same SRT format (number, timestamp, text, blank line)
- Re-number entries sequentially from 1 after adding/splitting entries
- Do NOT add translation or explanations
- Return ONLY the corrected and completed SRT content — no explanations, no markdown fences

Here is the draft SRT to correct and complete:
---
${rawSrt}
---

Now listen to the full audio from 00:00:00 to ${durationSrt} and return the fully corrected and completed SRT:`;
}

function buildTranslationPrompt(correctedSrt: string, fromLanguage: string, toLanguage: string): string {
  const fromNote = fromLanguage === "auto" ? "its original language" : fromLanguage;
  return `You are a simultaneous interpreter — not a translator. A translator converts words; an interpreter understands what a human being is saying and renders that meaning naturally in another language. That is your job here.

I will give you an SRT subtitle file of spoken speech in ${fromNote}. Your task is to render it in ${toLanguage} the way a skilled live interpreter would.

━━━ STEP 1: READ THE ENTIRE SRT FIRST ━━━
Before you write a single translated word, silently read the ENTIRE SRT from the first entry to the last. Understand:
- What is the speaker talking about overall?
- What is their argument or message?
- What is their emotional tone — calm, passionate, angry, explanatory?
- Which words are particles/fillers and which carry real meaning?

Only after you have that full picture should you begin translating.

━━━ STEP 2: TRANSLATE MEANING, NOT WORDS ━━━
Subtitles are split into tiny 3–6 word chunks. A single entry might just say "ना", "तो", "right?", or "And fight". You now know the full speech, so translate what the speaker MEANS in that moment — not the isolated words on that line.

CONCRETE EXAMPLES of bad vs good translation:

Example A — particle "ना":
Source entries: "क्यों एकत्रीकरण होंगे / सब भारत के साथ मिलकर / ना / लड़ाई करेंगे"
BAD:  "ना" → "No"   ← literal, meaningless in isolation
GOOD: "ना" → "instead of"  ← because in context the speaker is contrasting unity vs fighting

Example B — connector "इसीलिए":
Source: "इसीलिए एकत्रीकरण होंगे"
BAD:  "So togetherness will happen"  ← robotic, literal
GOOD: "That's exactly why unity matters"  ← captures the speaker's point and energy

Example C — Hinglish code-switch "And fight":
Source: "ना / लड़ाई करेंगे / And fight"
BAD:  "No / Will fight / And fight"  ← three literal entries, redundant and choppy
GOOD: treat the whole utterance as one idea and render it naturally: "...or fight against it" / "and go to war" — whatever fits the flow

Example D — emphasis particle "ही":
Source: "यही कारण है"
BAD:  "This is the reason itself"
GOOD: "This is the very reason" or "That's the whole point"

━━━ STRUCTURAL RULES — never break these ━━━
1. Keep EVERY timestamp EXACTLY as-is — never change any HH:MM:SS,mmm value
2. Keep EVERY entry number EXACTLY as-is
3. Keep the exact SRT structure: number → timestamp → translated text → blank line
4. Translate ONLY the subtitle text — nothing else
5. DO NOT add or remove entries — output entry count must equal input entry count exactly
6. Each subtitle: 1–2 lines, max ~42 characters per line — split naturally at phrase boundaries
7. Return ONLY the translated SRT — no explanations, no markdown fences, no extra text

━━━ QUALITY RULES ━━━
- Sound like a human interpreter speaking live, not a dictionary or machine
- Mirror the speaker's energy: if they are urgent and punchy, your ${toLanguage} should feel urgent and punchy
- Particles and fillers (ना, तो, बस, ही, भी, हाँ, okay, right, so, and, but) — translate their FUNCTION in the sentence, never their dictionary meaning in isolation
- Mixed Hindi-English (Hinglish) is common — merge code-switched fragments into a single natural ${toLanguage} thought
- Keep names, places, organisations, and proper nouns unchanged (or standard ${toLanguage} spelling)

Here is the SRT to translate:
---
${correctedSrt}
---

Remember: read it all first, understand the speaker, then translate.
Now return the fully translated SRT in ${toLanguage}:`;
}

function buildTranslationVerifyPrompt(originalSrt: string, translatedSrt: string, fromLanguage: string, toLanguage: string): string {
  const fromNote = fromLanguage === "auto" ? "the original language" : fromLanguage;
  return `You are an expert bilingual subtitle proofreader and translation editor. I will give you two SRT files: the ORIGINAL (in ${fromNote}) and a TRANSLATED version (in ${toLanguage}). Fix every translation error you find.

━━━ YOUR PRIMARY JOB: FIX LITERAL TRANSLATIONS ━━━
The most common error to look for: the translator did word-for-word mapping instead of understanding meaning.

Because subtitles are in tiny 3–6 word chunks, isolated particles or connectors often get translated literally when they shouldn't. Examples of bad vs good:

BAD (literal):  entry says "ना" → translated as "No"
GOOD (contextual): "ना" in context means "isn't it?" or "if not" — fix based on surrounding entries

BAD (literal):  entry says "तो" → translated as "So"
GOOD (contextual): translate based on how it functions in the sentence flow

BAD: entry says "And fight" → translated as "And fight" (just copied)
GOOD: understand what the speaker means across that whole utterance and give the natural ${toLanguage} meaning

For EVERY short entry (1–4 words), check: does this translation read naturally in ${toLanguage} given what the surrounding entries say? If not, fix it to express the speaker's actual meaning.

━━━ OTHER ERRORS TO FIX ━━━
- Mistranslations (wrong meaning conveyed)
- Unnatural or robotic ${toLanguage} phrasing — rewrite to sound like a human
- Missing meaning (original says something absent from the translation)
- Added meaning (translation says something not in the original)
- Names/proper nouns incorrectly changed
- Lines longer than ~42 characters — split at natural phrase boundaries

━━━ STRUCTURAL RULES — DO NOT CHANGE THESE ━━━
- Keep ALL timestamps EXACTLY as they appear — do NOT change any HH:MM:SS,mmm value
- Keep ALL entry numbers EXACTLY as they appear
- Output entry count MUST equal input entry count exactly
- Fix ONLY the translation text — do not touch numbers or timestamps
- Return ONLY the corrected translated SRT — no explanations, no markdown fences

ORIGINAL SRT (${fromNote}):
---
${originalSrt}
---

TRANSLATED SRT (${toLanguage}) — verify and fix:
---
${translatedSrt}
---

Return the fully corrected ${toLanguage} SRT:`;
}

// ── Normalize SRT timestamps ─────────────────────────────────────────────────
// Fixes two classes of Gemini timestamp mistakes:
//   1. Missing hours: "01:23,456" → "00:01:23,456"  (MM:SS,mmm → HH:MM:SS,mmm)
//   2. Single-digit parts: "00:1:2,700" → "00:01:02,700"
//   3. Seconds/minutes >= 60: carry-over into the next unit
function normalizeTs(ts: string): string {
  const [timePart, ms = "000"] = ts.split(",");
  const parts = timePart.split(":");
  let hRaw: string, mRaw: string, sRaw: string;
  if (parts.length === 3) {
    [hRaw, mRaw, sRaw] = parts;
  } else if (parts.length === 2) {
    hRaw = "00";
    [mRaw, sRaw] = parts;
  } else {
    hRaw = "00"; mRaw = "00"; sRaw = parts[0];
  }
  // Carry-over: seconds >= 60 → minutes, minutes >= 60 → hours
  let hh = parseInt(hRaw, 10) || 0;
  let mm = parseInt(mRaw, 10) || 0;
  let ss = parseInt(sRaw, 10) || 0;
  const msNum = parseInt(ms, 10) || 0;
  mm += Math.floor(ss / 60); ss = ss % 60;
  hh += Math.floor(mm / 60); mm = mm % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(msNum).padStart(3, "0")}`;
}

function normalizeSrtTimestamps(srt: string): string {
  // Replace every timestamp line: "START --> END"
  return srt.replace(
    /^([\d:,]+)\s*-->\s*([\d:,]+)$/gm,
    (_m, start, end) => `${normalizeTs(start.trim())} --> ${normalizeTs(end.trim())}`,
  );
}

// ── Parse SRT timestamp to milliseconds ──────────────────────────────────────
function tsToMs(ts: string): number {
  const m = ts.match(/(\d+):(\d+):(\d+),(\d+)/);
  if (!m) return -1;
  return (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000 + parseInt(m[4]);
}

// ── Strip hallucinated / garbage entries ──────────────────────────────────────
function cleanupHallucinatedEntries(srt: string): string {
  const entries = srt.trim().split(/\n\n+/);
  const valid: string[] = [];
  let prevText = "";
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;
    // Must start with a number
    if (!/^\d+$/.test(lines[0].trim())) continue;

    const tsLine = lines[1].trim();
    const text = lines.slice(2).join(" ").trim();
    const words = text.split(/\s+/).filter(Boolean);
    const unique = new Set(words);

    // 1. Word-repetition hallucination (>80% same word)
    if (words.length > 10 && unique.size <= 2) continue;

    // 2. Empty or whitespace-only text
    if (!text) continue;

    // 3. Punctuation-only entries (e.g. "...", "—", ".", "-")
    if (/^[\s.…\-—–·,!?।]+$/.test(text)) continue;

    // 4. Consecutive identical text (duplicate entries)
    if (text === prevText) continue;

    // 5. Impossibly short duration (< 200ms) — almost always an artifact
    const tsParts = tsLine.match(/^(.+?)\s*-->\s*(.+)$/);
    if (tsParts) {
      const startMs = tsToMs(tsParts[1].trim());
      const endMs = tsToMs(tsParts[2].trim());
      if (startMs >= 0 && endMs >= 0 && endMs - startMs < 200) continue;
    }

    prevText = text;
    valid.push(entry.trim());
  }
  // Re-number the valid entries sequentially
  return valid
    .map((entry, i) => {
      const lines = entry.split("\n");
      lines[0] = String(i + 1);
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}


// ── Restore timestamps from original SRT into translated SRT ─────────────────
// Gemini sometimes reformats timestamps during translation. Since timestamps
// must NEVER change during translation, we overwrite every timestamp in the
// translated SRT with the corresponding timestamp from the original, matched
// by entry number. If entry counts differ, we log a warning and do a best-effort.
function restoreTimestamps(originalSrt: string, translatedSrt: string): string {
  const parseEntries = (srt: string) => {
    return srt.trim().split(/\n\n+/).map((block) => {
      const lines = block.trim().split("\n");
      if (lines.length < 3) return null;
      const num = parseInt(lines[0].trim(), 10);
      if (isNaN(num)) return null;
      return { num, timestamp: lines[1].trim(), text: lines.slice(2).join("\n") };
    }).filter((e): e is { num: number; timestamp: string; text: string } => e !== null);
  };

  const origEntries = parseEntries(originalSrt);
  const transEntries = parseEntries(translatedSrt);

  if (origEntries.length !== transEntries.length) {
    logger.warn(
      { origCount: origEntries.length, transCount: transEntries.length },
      "Entry count mismatch between original and translated SRT — timestamps may be misaligned"
    );
  }

  const timestampMap = new Map<number, string>();
  for (const e of origEntries) timestampMap.set(e.num, e.timestamp);

  const restored = transEntries.map((e) => {
    const ts = timestampMap.get(e.num) ?? e.timestamp;
    return `${e.num}\n${ts}\n${e.text}`;
  });

  return restored.join("\n\n") + "\n";
}

// ── Filter entries beyond audio duration ─────────────────────────────────────
function filterOutOfBoundsEntries(srt: string, durationSecs: number): string {
  if (durationSecs <= 0) return srt;
  const entries = srt.trim().split(/\n\n+/);
  const valid: string[] = [];
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;
    const tsMatch = lines[1].match(/^(\d{2}):(\d{2}):(\d{2}),\d{3}\s*-->/);
    if (!tsMatch) { valid.push(entry.trim()); continue; }
    const entrySecs = parseInt(tsMatch[1], 10) * 3600 + parseInt(tsMatch[2], 10) * 60 + parseInt(tsMatch[3], 10);
    if (entrySecs <= durationSecs + 5) valid.push(entry.trim()); // 5s tolerance
  }
  return valid.map((entry, i) => {
    const lines = entry.split("\n");
    lines[0] = String(i + 1);
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

// ── Strict timestamp format filter ───────────────────────────────────────────
// Drops any entry whose timestamp line doesn't exactly match HH:MM:SS,mmm --> HH:MM:SS,mmm
// or where start >= end. Runs AFTER normalizeSrtTimestamps so common format errors are
// already corrected; this removes anything still malformed.
function strictFilterMalformedTimestamps(srt: string): string {
  const TS_RE = /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}$/;
  const entries = srt.trim().split(/\n\n+/);
  const valid: string[] = [];
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;
    if (!/^\d+$/.test(lines[0].trim())) continue;
    const tsLine = lines[1].trim();
    if (!TS_RE.test(tsLine)) continue;
    const parts = tsLine.match(/^(.+?)\s*-->\s*(.+)$/);
    if (parts) {
      const startMs = tsToMs(parts[1].trim());
      const endMs = tsToMs(parts[2].trim());
      if (startMs < 0 || endMs < 0 || startMs >= endMs) continue;
    }
    valid.push(entry.trim());
  }
  return valid.map((entry, i) => {
    const lines = entry.split("\n");
    lines[0] = String(i + 1);
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

// ── Basic SRT validity check ──────────────────────────────────────────────────
// Checks first AND last entry so truncated output (maxOutputTokens hit) is caught.
function validateSrt(srt: string): boolean {
  const entries = srt.trim().split(/\n\n+/).filter(Boolean);
  if (entries.length === 0) return false;

  // Check first entry structure
  const firstLines = entries[0].trim().split("\n");
  if (firstLines.length < 3) return false;
  if (!/^\d+$/.test(firstLines[0].trim())) return false;
  if (!/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(firstLines[1])) return false;

  // Check last entry is also complete — guards against Gemini token-limit truncation
  if (entries.length > 1) {
    const lastLines = entries[entries.length - 1].trim().split("\n");
    if (lastLines.length < 3) {
      logger.warn("Last SRT entry appears truncated — likely hit token limit");
      return false;
    }
  }

  return true;
}

// ── Strip markdown code fences from AI output ────────────────────────────────
function stripFences(text: string): string {
  let s = text.trim();
  // Normalize Windows line endings so all downstream splits work correctly
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Remove opening fence with optional language tag (e.g. ```srt or ```text)
  s = s.replace(/^```(?:[a-z]*)[ \t]*\n/i, "");
  // Remove closing fence
  s = s.replace(/\n```[ \t]*$/i, "");
  return s.trim();
}

// ── Preprocess audio with ffmpeg (16kHz mono WAV) ────────────────────────────
// outputPath: optional explicit destination (used for cached WAVs outside audioDir)
function preprocessAudio(inputPath: string, outputPath?: string): Promise<{ path: string; cleanup: () => void }> {
  const outPath = outputPath ?? (inputPath + "_16k.wav");
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, [
      "-y", "-i", inputPath,
      "-ac", "1",           // mono
      "-ar", "16000",       // 16 kHz
      "-c:a", "pcm_s16le",  // 16-bit PCM
      outPath,
    ]);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ path: outPath, cleanup: () => { try { rmSync(outPath); } catch {} } });
      } else {
        // Fallback: use original if ffmpeg fails
        resolve({ path: inputPath, cleanup: () => {} });
      }
    });
    proc.on("error", () => resolve({ path: inputPath, cleanup: () => {} }));
  });
}

// ── Get audio duration via ffprobe ───────────────────────────────────────────
function getAudioDuration(audioPath: string): Promise<number> {
  if (!FFPROBE_BIN) return Promise.resolve(0);
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE_BIN, [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const secs = parseFloat(out.trim());
      resolve(isNaN(secs) ? 0 : secs);
    });
    proc.on("error", () => resolve(0));
  });
}

/** Convert seconds → HH:MM:SS for use in prompts */
function secondsToSrtTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}


// ── AssemblyAI helpers ────────────────────────────────────────────────────────

function toAssemblyAiLangCode(language: string): string | undefined {
  if (language === "auto") return undefined;
  const map: Record<string, string> = {
    "English": "en", "Hindi": "hi", "Spanish": "es", "French": "fr",
    "German": "de", "Portuguese": "pt", "Italian": "it", "Japanese": "ja",
    "Korean": "ko", "Chinese": "zh", "Arabic": "ar", "Russian": "ru",
    "Dutch": "nl", "Turkish": "tr", "Polish": "pl", "Swedish": "sv",
    "Ukrainian": "uk", "Bengali": "bn", "Gujarati": "gu", "Marathi": "mr",
    "Tamil": "ta", "Telugu": "te", "Punjabi": "pa",
  };
  const found = Object.entries(map).find(([k]) => k.toLowerCase() === language.toLowerCase());
  return found ? found[1] : undefined;
}

async function assemblyAiUpload(audioPath: string): Promise<string> {
  const { request } = await import("https");
  return new Promise((resolve, reject) => {
    const size = statSync(audioPath).size;
    const opts = {
      hostname: "api.assemblyai.com", path: "/v2/upload", method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/octet-stream",
        "content-length": size,
      },
    };
    const req = request(opts, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { upload_url?: string; error?: string };
          if (j.upload_url) resolve(j.upload_url);
          else reject(new Error(j.error ?? `AssemblyAI upload error (HTTP ${res.statusCode})`));
        } catch { reject(new Error("AssemblyAI upload: bad JSON response")); }
      });
    });
    req.on("error", reject);
    createReadStream(audioPath).pipe(req);
  });
}

async function assemblyAiCreateTranscript(uploadUrl: string, language: string): Promise<string> {
  const { request } = await import("https");
  const langCode = toAssemblyAiLangCode(language);
  const payload = JSON.stringify({
    audio_url: uploadUrl,
    language_detection: !langCode,
    ...(langCode ? { language_code: langCode } : {}),
    punctuate: true,
    format_text: true,
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.assemblyai.com", path: "/v2/transcript", method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    };
    const req = request(opts, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { id?: string; error?: string };
          if (j.id) resolve(j.id);
          else reject(new Error(j.error ?? `AssemblyAI transcript create error (HTTP ${res.statusCode})`));
        } catch { reject(new Error("AssemblyAI transcript: bad JSON response")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

type AssemblyAiWord = { start: number; end: number; text: string; confidence: number };

async function assemblyAiPollTranscript(
  transcriptId: string,
  job: { cancelled?: boolean },
): Promise<AssemblyAiWord[]> {
  const { request } = await import("https");
  const MAX_POLLS = 360; // 30 min at 5s intervals
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (job.cancelled) throw new Error("Cancelled");
    const result = await new Promise<any>((resolve, reject) => {
      const opts = {
        hostname: "api.assemblyai.com",
        path: `/v2/transcript/${transcriptId}`,
        method: "GET",
        headers: { authorization: ASSEMBLYAI_API_KEY },
      };
      const req = request(opts, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("AssemblyAI poll: bad JSON")); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (result.status === "completed") {
      if (!Array.isArray(result.words) || result.words.length === 0)
        throw new Error("AssemblyAI returned an empty transcript — no speech detected");
      return result.words as AssemblyAiWord[];
    }
    if (result.status === "error")
      throw new Error(result.error ?? "AssemblyAI transcription failed");
  }
  throw new Error("AssemblyAI transcription timed out after 30 minutes");
}

function assemblyAiWordsToSrt(words: AssemblyAiWord[]): string {
  if (words.length === 0) return "";
  const MAX_WORDS = 6;
  const MAX_MS = 5000;
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let i = 0;
  while (i < words.length) {
    const start = words[i].start;
    const group: string[] = [];
    let end = words[i].end;
    while (i < words.length && group.length < MAX_WORDS && (words[i].start - start) < MAX_MS) {
      group.push(words[i].text);
      end = words[i].end;
      i++;
    }
    cues.push({ start, end, text: group.join(" ") });
  }
  const fmt = (ms: number) => {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const mm = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(mm).padStart(3, "0")}`;
  };
  return cues.map((c, idx) => `${idx + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`).join("\n\n") + "\n";
}

async function transcribeWithAssemblyAI(
  audioPath: string,
  language: string,
  job: SrtJob,
): Promise<string> {
  logger.info({ audioPath, language }, "AssemblyAI: uploading audio");
  const uploadUrl = await assemblyAiUpload(audioPath);
  if (job.cancelled) throw new Error("Cancelled");
  logger.info("AssemblyAI: creating transcript job");
  const transcriptId = await assemblyAiCreateTranscript(uploadUrl, language);
  logger.info({ transcriptId }, "AssemblyAI: polling for completion");
  const words = await assemblyAiPollTranscript(transcriptId, job);
  logger.info({ transcriptId, wordCount: words.length }, "AssemblyAI: transcription complete");
  return assemblyAiWordsToSrt(words);
}

// Text-only correction prompt — used in AssemblyAI path (no audio file available).
function buildTextOnlyCorrectionPrompt(rawSrt: string, language: string, durationSrt: string): string {
  const langNote = language === "auto"
    ? "The subtitles are in their original language — do NOT translate anything."
    : `The subtitles are in ${language} — do NOT translate anything.`;
  return `You are an expert subtitle proofreader. I will give you a draft SRT generated by speech recognition. Fix all errors you can identify from the text alone.

${langNote}

AUDIO DURATION: ${durationSrt}. All timestamps must be within 00:00:00,000 → ${durationSrt},000.

TIMESTAMP FORMAT: Always HH:MM:SS,mmm (e.g. 00:01:23,456). Missing hours prefix is a bug — fix it.

RULES:
- Fix obvious garbled words / mishearings based on linguistic context
- Fix timestamps that exceed the audio duration
- Split any entry with MORE THAN 6 words into shorter entries with proportional timestamps
- Remove duplicate consecutive entries with nearly identical text
- Re-number entries sequentially from 1
- Return ONLY the corrected SRT — no explanations, no markdown fences

DRAFT SRT:
---
${rawSrt}
---

Return the fully corrected SRT:`;
}

// ── Core processing function ─────────────────────────────────────────────────
async function processAudio(
  jobId: string,
  audioPath: string,
  language: string,
  filename: string,
  translateTo?: string,
  cleanup?: () => void,
  precomputedWav?: { path: string; mimeType: string; durationSecs: number },
) {
  const job = jobs.get(jobId);
  if (!job) return;

  const clients = getAllPersonalGenAIClients();
  if (clients.length === 0) {
    job.status = "error";
    job.completedAt = Date.now();
    job.error = "No Gemini API key configured for audio processing — add GEMINI_API_KEY to your secrets. The Replit AI integration does not support audio file uploads.";
    return;
  }

  let preprocessCleanup: (() => void) | null = null;

  try {
    let processedPath: string;
    let mimeType: string;
    let durationSecs: number;

    if (precomputedWav) {
      // Retry path: use cached preprocessed WAV — skip download and re-preprocessing
      processedPath = precomputedWav.path;
      mimeType = precomputedWav.mimeType;
      durationSecs = precomputedWav.durationSecs;
    } else {
      // First-time path: preprocess audio to 16kHz mono WAV
      const preprocessed = await preprocessAudio(audioPath);
      preprocessCleanup = preprocessed.cleanup;
      processedPath = preprocessed.path;
      const ext = processedPath.split(".").pop()!.toLowerCase();
      mimeType = audioMimeType(ext);
      durationSecs = await getAudioDuration(processedPath);
    }


    // Measure exact audio duration so we can tell Gemini to stay within bounds
    const durationSrt = durationSecs > 0 ? secondsToSrtTime(durationSecs) : "99:59:59";
    job.durationSecs = durationSecs;
    logger.info({ durationSecs, durationSrt }, "Audio duration measured");

    if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }

    let correctedFinalSrt: string | null = null;

    const useAssemblyAI = !!ASSEMBLYAI_API_KEY && durationSecs >= ASSEMBLYAI_THRESHOLD_SECS;

    if (useAssemblyAI) {
      // ── AssemblyAI path (audio > 10 min) ─────────────────────────────────────
      // Pass 1: AssemblyAI transcription (word-level timestamps, highly accurate)
      job.status = "audio";
      job.progressPct = 20;
      job.message = "Uploading to AssemblyAI for transcription…";
      logger.info({ durationSecs }, "Routing to AssemblyAI (long audio)");

      const rawSrt = await transcribeWithAssemblyAI(processedPath, language, job);
      if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }

      const cleanedRaw = stripFences(rawSrt);

      // Pass 2: Text-only Gemini correction.
      // Skip for very long audio (>30 min) — the SRT would be too large for Gemini's
      // token limit and would be truncated. AssemblyAI word-level output is accurate enough.
      const CORRECTION_MAX_SECS = 1800; // 30 minutes
      let correctedText = "";
      if (durationSecs < CORRECTION_MAX_SECS) {
        job.status = "correcting";
        job.progressPct = 70;
        job.message = "AI is refining subtitles…";
        try {
          correctedText = await generateWithKeyRotation(
            (model) => ({
              model,
              contents: [{ role: "user", parts: [{ text: buildTextOnlyCorrectionPrompt(cleanedRaw, language, durationSrt) }] }],
              config: { temperature: 0.1, maxOutputTokens: 65536 },
            }),
            "SRT text correction (AssemblyAI path)",
          );
        } catch (err) {
          logger.warn({ err }, "Text-only correction failed — using raw AssemblyAI output");
        }
      } else {
        logger.info({ durationSecs }, "Skipping Gemini correction for very long audio — using raw AssemblyAI output directly");
      }

      const rawFinal = correctedText && correctedText.length > 10 ? stripFences(correctedText) : cleanedRaw;
      const normalized = normalizeSrtTimestamps(rawFinal);
      const deduped = cleanupHallucinatedEntries(normalized);
      const strictFiltered = strictFilterMalformedTimestamps(deduped);
      correctedFinalSrt = filterOutOfBoundsEntries(strictFiltered, durationSecs);

    } else {
      // ── Gemini path (audio ≤ 10 min) ─────────────────────────────────────────
      // Read into memory only here — short audio only (AssemblyAI streams directly).
      const audioBuffer = readFileSync(processedPath);
      const audioBlob = new Blob([audioBuffer], { type: mimeType });
      // A fileUri is tied to the API key/project that uploaded it — a different key
      // gets 403 on the same URI. So each key attempt uploads its own copy, runs both
      // passes, then deletes the file. On quota (429) we move to the next key.
      let lastKeyErr: unknown;

      for (let ki = 0; ki < clients.length; ki++) {
        const client = clients[ki];
        const keyLabel = `key ${ki + 1}`;
        let geminiFileName: string | null = null;

        try {
          // Upload with this key's client
          job.status = "uploading";
          job.progressPct = 20;
          job.message = ki === 0 ? "Uploading audio to AI..." : `Uploading audio to AI (${keyLabel})...`;

          const uploadResult = await client.files.upload({
            file: audioBlob,
            config: { mimeType, displayName: filename },
          });
          geminiFileName = uploadResult.name!;

          // Poll until ACTIVE (up to 3 min)
          let fileInfo: any = uploadResult;
          let attempts = 0;
          while (fileInfo.state === "PROCESSING" && attempts < 90) {
            await new Promise((r) => setTimeout(r, 2000));
            if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
            fileInfo = await client.files.get({ name: geminiFileName });
            attempts++;
          }
          if (fileInfo.state !== "ACTIVE") throw new Error("Audio processing timed out — please try again");

          const fileUri: string = fileInfo.uri;

          // Pass 1: Transcription
          if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
          job.status = "generating";
          job.progressPct = 40;
          job.message = "AI is transcribing audio...";

          let rawSrt = "";
          let lastPass1Err: unknown;
          for (const model of KEY_ROTATION_MODELS) {
            try {
              const result = await client.models.generateContent({
                model,
                contents: [{ role: "user", parts: [{ fileData: { mimeType, fileUri } }, { text: buildSrtPrompt(language, durationSrt) }] }],
                config: { temperature: 0.1, maxOutputTokens: 65536 },
              });
              rawSrt = result.text?.trim() ?? "";
              logger.info({ model, keyLabel }, "Initial subtitle transcription completed");
              break;
            } catch (err) {
              lastPass1Err = err;
              if (!isGeminiRetryableError(err)) throw err;
              logger.warn({ model, keyLabel }, `Transcription rate limited on ${model} — trying next model`);
            }
          }
          if (!rawSrt) throw lastPass1Err instanceof Error ? lastPass1Err : new Error("All models rate limited on transcription");

          const cleanedRaw = stripFences(rawSrt);

          // Pass 2: Correction (audio-aware — same fileUri)
          if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
          job.status = "correcting";
          job.progressPct = 60;
          job.message = "AI is auto-correcting errors...";

          let correctedSrt = "";
          for (const model of KEY_ROTATION_MODELS) {
            try {
              const result = await client.models.generateContent({
                model,
                contents: [{ role: "user", parts: [{ fileData: { mimeType, fileUri } }, { text: buildCorrectionPrompt(cleanedRaw, language, durationSrt) }] }],
                config: { temperature: 0.1, maxOutputTokens: 65536 },
              });
              correctedSrt = result.text?.trim() ?? "";
              logger.info({ model, keyLabel }, "Subtitle correction completed");
              break;
            } catch (err) {
              if (!isGeminiRetryableError(err)) {
                logger.warn({ err, model, keyLabel }, "Correction failed (non-quota) — using Pass 1 output");
                break;
              }
              logger.warn({ model, keyLabel }, `Correction rate limited on ${model} — trying next model`);
            }
          }

          const rawFinal = (correctedSrt && correctedSrt.length > 10) ? stripFences(correctedSrt) : cleanedRaw;
          const normalized = normalizeSrtTimestamps(rawFinal);
          const deduped = cleanupHallucinatedEntries(normalized);
          const strictFiltered = strictFilterMalformedTimestamps(deduped);
          correctedFinalSrt = filterOutOfBoundsEntries(strictFiltered, durationSecs);

          break; // Both passes succeeded — exit key loop

        } catch (err) {
          lastKeyErr = err;
          const isQuota = isGeminiRetryableError(err);
          if (isQuota && ki < clients.length - 1) {
            logger.warn({ keyLabel }, `${keyLabel} quota exhausted — trying next key`);
          } else if (!isQuota && ki < clients.length - 1) {
            logger.warn({ err, keyLabel }, `${keyLabel} failed (non-quota) — trying next key`);
          } else if (!isQuota) {
            throw err;
          }
        } finally {
          if (geminiFileName) {
            try { await client.files.delete({ name: geminiFileName }); } catch {}
          }
        }
      }

      if (!correctedFinalSrt) {
        job.status = "error";
        job.error = lastKeyErr instanceof Error ? lastKeyErr.message : "All API keys exhausted — try again later";
        return;
      }
    }


    // Validate the SRT before proceeding
    if (!validateSrt(correctedFinalSrt)) {
      job.status = "error";
      job.error = "AI returned an invalid subtitle file — please try again";
      return;
    }

    // Step 4 (optional): Translate the corrected SRT
    if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
    if (translateTo && translateTo !== "none") {
      job.originalSrt = correctedFinalSrt;
      job.originalFilename = filename.replace(/\.srt$/i, "-original.srt");
      job.status = "translating";
      job.progressPct = 80;
      job.message = `Translating subtitles to ${translateTo}...`;

      const translatedRaw = await generateWithReplitFirst(
        "gemini-2.5-pro",
        (model) => ({
          model,
          contents: [
            {
              role: "user",
              parts: [{ text: buildTranslationPrompt(correctedFinalSrt, language, translateTo) }],
            },
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 65536,
          },
        }),
        "Subtitle translation pass",
      );
      const translatedClean = translatedRaw.length > 10
        ? stripFences(translatedRaw)
        : correctedFinalSrt;
      // Always restore original timestamps — Gemini sometimes garbles them during translation
      const translatedSrt = restoreTimestamps(correctedFinalSrt, translatedClean);

      // Step 5: Verify the translation (text-only, no audio needed)
      if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
      job.status = "verifying";
      job.progressPct = 95;
      job.message = `Verifying ${translateTo} translation...`;

      const verifiedRaw = await generateWithReplitFirst(
        "gemini-2.5-pro",
        (model) => ({
          model,
          contents: [
            {
              role: "user",
              parts: [{ text: buildTranslationVerifyPrompt(correctedFinalSrt, translatedSrt, language, translateTo) }],
            },
          ],
          config: {
            temperature: 0.1,
            maxOutputTokens: 65536,
          },
        }),
        "Subtitle verification pass",
      );
      const verifiedClean = verifiedRaw.length > 10
        ? stripFences(verifiedRaw)
        : translatedSrt;
      // Restore timestamps again after verification pass (same Gemini behaviour)
      const verifiedSrt = restoreTimestamps(correctedFinalSrt, verifiedClean);

      const finalSrt = strictFilterMalformedTimestamps(cleanupHallucinatedEntries(normalizeSrtTimestamps(verifiedSrt)));
      if (!validateSrt(finalSrt)) {
        job.status = "error";
        job.error = "AI returned an invalid translated subtitle file — please try again";
        return;
      }
      job.status = "done";
      job.progressPct = 100;
      job.message = "Subtitles ready!";
      job.srt = finalSrt;
      notifySubtitleReady(jobId, job);
    } else {
      job.status = "done";
      job.progressPct = 100;
      job.message = "Subtitles ready!";
      job.srt = correctedFinalSrt;
      notifySubtitleReady(jobId, job);
    }
  } catch (err: any) {
    logger.error({ err }, "SRT generation error");
    if (job.status !== "cancelled") {
      job.status = "error";
      job.error = err.message || "Failed to generate subtitles";
    }
  } finally {
    if (job.status === "error" && !job.errorNotified) {
      job.errorNotified = true;
      void notifyClientPush(job.notifyClientKey, {
        title: "Subtitles failed",
        body: (job.error || "Subtitle generation failed").slice(0, 200),
        url: "/",
        tag: `subtitles-error:${jobId}`,
        silent: true,
      });
    }

    // Stamp completedAt on any terminal state so the cleanup interval uses
    // the 2-hour-after-completion TTL instead of the 30-min-from-creation one.
    const isTerminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
    if (isTerminal && !job.completedAt) job.completedAt = Date.now();

    if (preprocessCleanup) {
      try { preprocessCleanup(); } catch {}
    }
    if (cleanup) {
      try { cleanup(); } catch {}
    }
  }
}

// ── Route: Generate from YouTube URL ────────────────────────────────────────
router.post("/subtitles/generate", subtitlesGenerateRateLimiter, async (req: Request, res: Response) => {
  const { url, language = "auto", translateTo } = req.body as { url: string; language?: string; translateTo?: string };

  if (!url?.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY" });
    return;
  }

  const jobId = randomUUID();
  const normalizedUrl = normalizeInputUrl(url);
  const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;
  const notifyClientKey = getNotifyClientKey(req);

  if (isSubtitlesQueuePrimaryEnabled()) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "subtitles",
        sourceUrl: normalizedUrl,
        meta: {
          language,
          translateTo: translateLang ?? null,
          notifyClientKey: notifyClientKey ?? null,
          inputMode: "url",
        },
      });
      res.json({ jobId, status: "queued", message: "Subtitle generation queued" });
    } catch (err) {
      logger.error({ err, jobId }, "Failed to queue subtitles URL job");
      res.status(502).json({ error: "Failed to queue subtitle job" });
    }
    return;
  }

  jobs.set(jobId, {
    status: "pending",
    message: "Queued - starting soon...",
    filename: "subtitles.srt",
    createdAt: Date.now(),
    translateTo: translateLang,
    progressPct: 0,
    notifyClientKey,
  });

  res.json({ jobId });

  // Process in background
  enqueueSubtitleJob(jobId, async () => {
    const job = jobs.get(jobId)!;

    // ── Check WAV cache (retry path: skip download + preprocessing) ──────────
    const cached = urlWavCache.get(normalizedUrl);
    if (cached && existsSync(cached.wavPath)) {
      logger.info({ normalizedUrl }, "WAV cache hit — skipping download and preprocessing");
      job.status = "uploading";
      job.progressPct = 20;
      job.message = "Using cached audio — skipping re-download...";
      await processAudio(
        jobId,
        normalizedUrl,
        language,
        job.filename,
        translateLang,
        () => {},
        {
          path: cached.wavPath,
          mimeType: cached.mimeType,
          durationSecs: cached.durationSecs,
        },
      );
      return;
    }

    // ── Cache miss: download from YouTube ────────────────────────────────────
    const audioDir = join(DOWNLOAD_DIR, `srt-yt-${jobId}`);
    try {
      mkdirSync(audioDir, { recursive: true });
      const audioPattern = join(audioDir, "%(title)s.%(ext)s");
      await runYtDlpAudio([
        "-f", "bestaudio/best",
        "--no-playlist", "--no-warnings",
        "-o", audioPattern, normalizedUrl,
      ], job);

      if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }

      const audioFiles = existsSync(audioDir) ? readdirSync(audioDir) : [];
      const audioFile = audioFiles
        .map((f) => join(audioDir, f))
        .find((f) => /\.(m4a|mp4|webm|ogg|opus|mp3|flac|wav|aac)$/i.test(f));

      if (!audioFile) {
        job.status = "error";
        job.error = "Could not download audio — check the URL and try again";
        return;
      }

      // Use the video title for the SRT filename
      const rawFilename = audioFile.split("/").pop() ?? "";
      const videoTitle = rawFilename.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "-").trim() || "subtitles";
      job.filename = `${videoTitle}.srt`;

      // Preprocess here so we can cache the WAV separately from the audioDir
      job.progressPct = 15;
      mkdirSync(WAV_CACHE_DIR, { recursive: true });
      const wavOutputPath = join(WAV_CACHE_DIR, `${jobId}_16k.wav`);
      const preprocessed = await preprocessAudio(audioFile, wavOutputPath);

      if (job.cancelled) {
        preprocessed.cleanup();
        job.status = "cancelled"; job.message = "Cancelled";
        try { rmSync(audioDir, { recursive: true }); } catch {}
        return;
      }

      const ext = preprocessed.path.split(".").pop()!.toLowerCase();
      const mimeType = audioMimeType(ext);
      const durationSecs = await getAudioDuration(preprocessed.path);

      // Cache WAV for retry — lives in wav-cache dir, cleaned up by TTL interval
      urlWavCache.set(normalizedUrl, {
        wavPath: preprocessed.path,
        mimeType,
        durationSecs,
        createdAt: Date.now(),
      });

      // Original audio dir is no longer needed — WAV is cached separately
      try { rmSync(audioDir, { recursive: true }); } catch {}

      await processAudio(
        jobId,
        audioFile,
        language,
        job.filename,
        translateLang,
        () => {}, // audioDir already cleaned up above
        { path: preprocessed.path, mimeType, durationSecs },
      );
    } catch (err: any) {
      logger.error({ err }, "SRT YouTube download error");
      if (job.status !== "cancelled") {
        job.status = "error";
        job.completedAt = Date.now();
        job.error = err.message || "Failed to download audio";
      }
      try { rmSync(audioDir, { recursive: true }); } catch {}
    }
  }).catch((err) => {
    const job = jobs.get(jobId);
    if (!job) return;
    const message = err instanceof Error ? err.message : "Subtitle generation failed";
    if (message === CANCELLED_BY_USER || job.cancelled) {
      job.status = "cancelled";
      job.completedAt = Date.now();
      job.message = CANCELLED_BY_USER;
      return;
    }
    job.status = "error";
    job.completedAt = Date.now();
    job.error = message;
  });
});

// ── Route: Generate from uploaded file ──────────────────────────────────────
router.post("/subtitles/upload/init", subtitlesUploadRateLimiter, async (req: Request, res: Response) => {
  const { filename, contentType, size } = req.body as {
    filename?: string;
    contentType?: string;
    size?: number | string;
  };

  if (!filename || typeof filename !== "string") {
    res.status(400).json({ error: "filename is required" });
    return;
  }
  if (!contentType || typeof contentType !== "string") {
    res.status(400).json({ error: "contentType is required" });
    return;
  }

  const numericSize =
    typeof size === "number" ? size : typeof size === "string" ? Number(size) : Number.NaN;
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    res.status(400).json({ error: "size is required" });
    return;
  }
  if (numericSize > 500 * 1024 * 1024) {
    res.status(413).json({ error: "File is too large - maximum upload size is 500 MB" });
    return;
  }

  try {
    const upload = await createS3PresignedUpload({
      jobId: randomUUID(),
      namespace: "subtitles/uploads",
      filename,
      contentType,
    });
    res.json({
      uploadUrl: upload.uploadUrl,
      uploadKey: upload.key,
      filename: upload.filename,
    });
  } catch (err) {
    logger.error({ err }, "Failed to initialize subtitles upload");
    res.status(500).json({ error: "Failed to initialize upload" });
  }
});

router.post("/subtitles/upload/start", subtitlesUploadRateLimiter, async (req: Request, res: Response) => {
  const { uploadKey, originalFilename, language = "auto", translateTo } = req.body as {
    uploadKey?: string;
    originalFilename?: string;
    language?: string;
    translateTo?: string;
  };

  if (!uploadKey || typeof uploadKey !== "string") {
    res.status(400).json({ error: "uploadKey is required" });
    return;
  }
  if (!originalFilename || typeof originalFilename !== "string") {
    res.status(400).json({ error: "originalFilename is required" });
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({ error: "AI not configured - add GEMINI_API_KEY" });
    return;
  }

  const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;
  const jobId = randomUUID();
  const notifyClientKey = getNotifyClientKey(req);

  if (isSubtitlesQueuePrimaryEnabled()) {
    try {
      await submitYoutubeQueuePrimaryJob({
        jobId,
        jobType: "subtitles",
        sourceUrl: `s3://${uploadKey}`,
        meta: {
          inputMode: "upload",
          uploadS3Key: uploadKey,
          originalFilename,
          language,
          translateTo: translateLang ?? null,
          notifyClientKey: notifyClientKey ?? null,
        },
      });
      res.json({ jobId, status: "queued", message: "Subtitle generation queued" });
    } catch (err) {
      logger.error({ err, jobId }, "Failed to queue subtitles upload job");
      res.status(502).json({ error: "Failed to queue subtitle upload job" });
    }
    return;
  }

  res.status(409).json({
    error: "S3-first subtitle upload requires queue-primary subtitles mode (or disable SUBTITLES_FORCE_LAMBDA)",
  });
});

router.post(
  "/subtitles/upload",
  subtitlesUploadRateLimiter,
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!isAiConfigured()) {
      try { rmSync(req.file.path); } catch {}
      res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY" });
      return;
    }

    const language: string = (req.body as any).language ?? "auto";
    const translateTo: string | undefined = (req.body as any).translateTo;
    const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;
    const baseName = req.file.originalname.replace(/\.[^.]+$/, "");
    const srtFilename = `${baseName}.srt`;
    const jobId = randomUUID();
    const notifyClientKey = getNotifyClientKey(req);

    jobs.set(jobId, {
      status: "pending",
      message: "Queued - starting soon...",
      filename: srtFilename,
      createdAt: Date.now(),
      translateTo: translateLang,
      progressPct: 0,
      notifyClientKey,
    });

    res.json({ jobId });

    // Process in background — delete the temp file after use
    enqueueSubtitleJob(jobId, async () => {
      await processAudio(jobId, req.file!.path, language, srtFilename, translateLang, () => {
        try { rmSync(req.file!.path); } catch {}
      });
    }).catch((err) => {
      try { rmSync(req.file!.path); } catch {}
      const job = jobs.get(jobId);
      if (!job) return;
      const message = err instanceof Error ? err.message : "Subtitle generation failed";
      if (message === CANCELLED_BY_USER || job.cancelled) {
        job.status = "cancelled";
        job.completedAt = Date.now();
        job.message = CANCELLED_BY_USER;
        return;
      }
      job.status = "error";
      job.completedAt = Date.now();
      job.error = message;
    });
  },
);

// ── Multer error handler (must have 4 params to be treated as error middleware) ─
router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "File is too large — maximum upload size is 500 MB" });
    return;
  }
  next(err);
});

// ── Route: Cancel a running job ───────────────────────────────────────────────
router.post("/subtitles/cancel/:jobId", subtitlesCancelRateLimiter, (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    if (!isSubtitlesQueueEnabled()) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    void cancelYoutubeQueueJob(jobId)
      .then((cancelled) => {
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
      })
      .catch((err) => {
        logger.error({ err, jobId }, "Failed to cancel queued subtitle job");
        res.status(500).json({ error: "Failed to cancel job" });
      });
    return;
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    res.json({ ok: true, alreadyFinished: true });
    return;
  }
  job.cancelled = true;
  job.status = "cancelled";
  job.completedAt = Date.now();
  job.message = CANCELLED_BY_USER;
  if (queuedSubtitleJobIds.has(jobId)) {
    dequeueSubtitleJob(jobId);
  }
  res.json({ ok: true });
});

// ── Route: Poll job status ────────────────────────────────────────────────────
router.get("/subtitles/status/:jobId", (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    if (!isSubtitlesQueueEnabled()) {
      res.json({ status: "not_found", message: "Job not found" });
      return;
    }
    void getYoutubeQueueJobStatus(jobId)
      .then(async (queueStatus) => {
        if (!queueStatus) {
          res.json({ status: "not_found", message: "Job not found" });
          return;
        }

        if (queueStatus.status === "done") {
          const srt = queueStatus.s3Key ? await readTextFromS3(queueStatus.s3Key) : null;
          const originalSrt = queueStatus.originalS3Key
            ? await readTextFromS3(queueStatus.originalS3Key)
            : null;
          res.json({
            status: queueStatus.status,
            message: queueStatus.message,
            filename: queueStatus.filename,
            srt,
            originalSrt,
            originalFilename: queueStatus.originalFilename ?? null,
            durationSecs: queueStatus.durationSecs ?? null,
            progressPct: 100,
            queue: {
              updatedAt: queueStatus.updatedAt,
              batchJobId: queueStatus.batchJobId,
            },
          });
          return;
        }

        if (queueStatus.status === "error") {
          res.json({
            status: "error",
            error: queueStatus.message ?? "Subtitle generation failed",
            durationSecs: queueStatus.durationSecs ?? null,
            progressPct: queueStatus.progressPct ?? 0,
            queue: {
              updatedAt: queueStatus.updatedAt,
              batchJobId: queueStatus.batchJobId,
            },
          });
          return;
        }

        res.json({
          status: queueStatus.status,
          message: queueStatus.message,
          durationSecs: queueStatus.durationSecs ?? null,
          progressPct: queueStatus.progressPct ?? 0,
          queue: {
            updatedAt: queueStatus.updatedAt,
            batchJobId: queueStatus.batchJobId,
          },
        });
      })
      .catch((err) => {
        logger.error({ err, jobId }, "Failed queued subtitle status lookup");
        res.status(500).json({ error: "Failed to fetch job status" });
      });
    return;
  }

  if (job.status === "done") {
    res.json({
      status: job.status,
      message: job.message,
      filename: job.filename,
      srt: job.srt,
      originalSrt: job.originalSrt ?? null,
      originalFilename: job.originalFilename ?? null,
      durationSecs: job.durationSecs ?? null,
      progressPct: 100,
    });
  } else if (job.status === "error") {
    res.json({ status: job.status, error: job.error, durationSecs: job.durationSecs ?? null, progressPct: job.progressPct ?? 0 });
  } else {
    res.json({
      status: job.status,
      message: job.message,
      durationSecs: job.durationSecs ?? null,
      progressPct: job.progressPct ?? 0,
    });
  }
});

export default router;

export function getSubtitlesOpsSnapshot() {
  let activeJobs = 0;
  let pendingJobs = 0;
  let doneJobs = 0;
  let errorJobs = 0;

  for (const job of jobs.values()) {
    if (job.status === "pending") pendingJobs += 1;
    if (job.status === "done") doneJobs += 1;
    if (job.status === "error") errorJobs += 1;
    if (
      job.status === "pending" ||
      job.status === "audio" ||
      job.status === "uploading" ||
      job.status === "generating" ||
      job.status === "correcting" ||
      job.status === "translating" ||
      job.status === "verifying"
    ) {
      activeJobs += 1;
    }
  }

  return {
    limits: {
      maxConcurrentSubtitleJobs: MAX_CONCURRENT_SUBTITLE_JOBS,
    },
    queue: {
      queuedSubtitleJobs: queuedSubtitleJobs.length,
      activeSubtitleJobSlotsUsed: activeSubtitleJobCount,
      activeJobs,
      pendingJobs,
      doneJobs,
      errorJobs,
      totalTrackedJobs: jobs.size,
    },
  };
}

export async function processSubtitleAudio(
  jobId: string,
  audioPath: string,
  language: string,
  filename: string,
  translateTo?: string,
  cleanup?: () => void,
  precomputedWav?: { path: string; mimeType: string; durationSecs: number },
) {
  return processAudio(jobId, audioPath, language, filename, translateTo, cleanup, precomputedWav);
}

export async function downloadSubtitleSourceAudio(
  args: string[],
  job: { cancelled?: boolean },
): Promise<void> {
  return runYtDlpAudio(args, job);
}

export function createSubtitleJobState(
  jobId: string,
  initial: Partial<SrtJob>,
): SrtJob {
  const job: SrtJob = {
    status: initial.status ?? "pending",
    message: initial.message ?? "",
    filename: initial.filename ?? "subtitles.srt",
    createdAt: initial.createdAt ?? Date.now(),
    originalFilename: initial.originalFilename,
    translateTo: initial.translateTo,
    cancelled: initial.cancelled,
    durationSecs: initial.durationSecs,
    progressPct: initial.progressPct,
    notifyClientKey: initial.notifyClientKey ?? null,
    srt: initial.srt,
    originalSrt: initial.originalSrt,
    error: initial.error,
    completedAt: initial.completedAt,
    errorNotified: initial.errorNotified,
  };
  jobs.set(jobId, job);
  return job;
}

export function getSubtitleJobState(jobId: string): SrtJob | undefined {
  return jobs.get(jobId);
}

export function deleteSubtitleJobState(jobId: string): void {
  jobs.delete(jobId);
}

