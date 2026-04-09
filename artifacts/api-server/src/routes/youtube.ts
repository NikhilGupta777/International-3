import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  createReadStream,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmdirSync,
} from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleGenAI } from "@google/genai";

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
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ?? join(_workspaceRoot, ".yt-cookies.txt");

// Optional HTTP/SOCKS proxy for yt-dlp (critical for cloud/datacenter IPs blocked by YouTube).
// Set YTDLP_PROXY=socks5://user:pass@host:port  or  http://host:port
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";

// Optional po_token + visitor_data pair to bypass YouTube bot-detection on server IPs.
// Generate with: https://github.com/iv-org/youtube-trusted-session-generator
// Then set: YTDLP_PO_TOKEN=<token>  and  YTDLP_VISITOR_DATA=<data>
const YTDLP_PO_TOKEN = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const HAS_DYNAMIC_POT_PROVIDER = !!YTDLP_POT_PROVIDER_URL;
const HAS_STATIC_PO_TOKEN = !!(YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA);

// YTDLP_COOKIES_BASE64: base64-encoded Netscape cookie file content.
// Export cookies from a YouTube-logged-in browser using a cookie exporter extension,
// then base64-encode the file: base64 -w 0 cookies.txt
// Set this env var on your server — no file upload required.
const YTDLP_COOKIES_BASE64 = process.env.YTDLP_COOKIES_BASE64 ?? "";
if (YTDLP_COOKIES_BASE64) {
  try {
    const cookieContent = Buffer.from(YTDLP_COOKIES_BASE64, "base64").toString("utf8");
    if (
      cookieContent.startsWith("# Netscape HTTP Cookie File") ||
      cookieContent.startsWith(".youtube.com") ||
      cookieContent.includes("\t")
    ) {
      const cookieDir = dirname(YTDLP_COOKIES_FILE);
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      writeFileSync(YTDLP_COOKIES_FILE, cookieContent, "utf8");
      console.log("[yt-dlp] Loaded cookies from YTDLP_COOKIES_BASE64 env var");
    } else {
      console.warn("[yt-dlp] YTDLP_COOKIES_BASE64 set but decoded content does not look like a Netscape cookie file — skipping");
    }
  } catch (e) {
    console.error("[yt-dlp] Failed to decode YTDLP_COOKIES_BASE64:", e);
  }
}

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Clean up files older than 1 hour every 30 minutes
const MAX_FILE_AGE_MS = 60 * 60 * 1000;
function cleanupOldFiles() {
  try {
    const now = Date.now();
    const files = readdirSync(DOWNLOAD_DIR);
    for (const file of files) {
      const filePath = join(DOWNLOAD_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}
setInterval(cleanupOldFiles, 30 * 60 * 1000);
cleanupOldFiles();

// Auto-delete a job's file 5 minutes after it's ready
const AUTO_DELETE_MS = 5 * 60 * 1000;
function scheduleAutoDelete(
  jobId: string,
  jobRef: { filePath: string | null; status: string },
) {
  setTimeout(() => {
    if (jobRef.filePath) {
      try {
        unlinkSync(jobRef.filePath);
      } catch {}
      jobRef.filePath = null;
    }
    jobRef.status = "expired";
    setTimeout(() => jobs.delete(jobId), 60_000);
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
  status: "pending" | "downloading" | "merging" | "done" | "error" | "expired";
  percent: number | null;
  speed: string | null;
  eta: string | null;
  filename: string | null;
  filesize: number | null;
  message: string | null;
  filePath: string | null;
  url: string;
  formatId: string;
  audioOnly: boolean;
  ext: string;
}

const jobs = new Map<string, DownloadJob>();

function pickFirst(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
  // Sleep between requests to avoid rate-limit bans
  "--sleep-requests", "1",
  "--sleep-interval", "2",
];

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
  const fallbacks: string[][] = [
    ["--extractor-args", "youtube:player_client=tv_embedded,android_vr"],
    ["--extractor-args", "youtube:player_client=tv_embedded"],
    ["--extractor-args", "youtube:player_client=android_vr"],
    ["--extractor-args", "youtube:player_client=mweb"],
    ["--extractor-args", "youtube:player_client=ios"],
  ];
  // web client gets the most complete format list; works with cookies even on server IPs
  if (hasCookies) {
    fallbacks.push(["--extractor-args", "youtube:player_client=web,web_embedded"]);
    fallbacks.push(["--extractor-args", "youtube:player_client=web"]);
  }
  return fallbacks;
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
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|sign.*in.*your age|age.*restrict|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|video.*unavailable.*country|precondition.*failed|http error 401|requested format is not available|format.*not available/i.test(
    message,
  );
}

function runYtDlpOnce(extraArgs: string[], args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_BIN,
      ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...extraArgs, ...args],
      {
        env: PYTHON_ENV,
      },
    );
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
  const raw = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
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
  const cookieArgs = getYtdlpCookieArgs();
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_BIN,
      ["-m", "yt_dlp", ...SUBS_YTDLP_ARGS, ...cookieArgs, ...args],
      {
        env: PYTHON_ENV,
      },
    );
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
  });
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v");
    } else if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1);
    }
  } catch {}
  return null;
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
      const proc = spawn(PYTHON_BIN, ["-m", "yt_dlp", "--version"], { env: PYTHON_ENV });
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
    ],
    cookieFilePath: YTDLP_COOKIES_FILE,
    cookieFileExists: existsSync(YTDLP_COOKIES_FILE),
  });
});

router.post("/youtube/info", async (req: Request, res: Response) => {
  const { url } = req.body as { url: string };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  if (
    !extractVideoId(url) &&
    !url.includes("youtube.com") &&
    !url.includes("youtu.be")
  ) {
    res.status(400).json({
      error:
        "Invalid YouTube URL. Use a link like https://www.youtube.com/watch?v=...",
    });
    return;
  }

  try {
    const data = await runYtDlpMetadata(url);

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
      const cacheKey = `${url}::${prewarmFormat}`;
      if (!getCachedStreamUrl(cacheKey)) {
        runYtDlp([
          "--get-url",
          "--no-playlist",
          "--no-warnings",
          "-f",
          prewarmFormat,
          url,
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
      .json({ error: "Failed to fetch video information", details: message });
  }
});

router.post("/youtube/download", async (req: Request, res: Response) => {
  const { url, formatId, audioOnly } = req.body as {
    url: string;
    formatId: string;
    audioOnly?: boolean;
  };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  if (!formatId) {
    res.status(400).json({ error: "formatId is required" });
    return;
  }

  const jobId = randomUUID();
  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: null,
    filesize: null,
    message: "Starting download...",
    filePath: null,
    url,
    formatId,
    audioOnly: audioOnly ?? false,
    ext: "mp4",
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Download started" });

  processDownload(jobId, job).catch((err) => {
    req.log.error({ err, jobId }, "Download job failed");
    const j = jobs.get(jobId);
    if (j) {
      j.status = "error";
      j.message = err instanceof Error ? err.message : "Download failed";
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
    // Reset progress state for retry attempts
    jobRef.percent = 0;
    jobRef.filename = null;
    jobRef.filePath = null;

    const proc = spawn(
      PYTHON_BIN,
      ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...extraArgs, ...cmdArgs],
      { env: PYTHON_ENV },
    );
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
      if (code === 0) resolve();
      else
        reject(
          new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`),
        );
    });

    proc.on("error", (err: Error) =>
      reject(new Error(`Failed to start yt-dlp: ${err.message}`)),
    );
  });
}

async function processDownload(jobId: string, job: DownloadJob): Promise<void> {
  const jobRef = jobs.get(jobId)!;

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

  // Find the output file (yt-dlp may change extension)
  const possibleExts = isAudioOnly ? ["mp3"] : ["mp4", "mkv", "webm"];
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
  if (!finalPath && jobRef.filePath && existsSync(jobRef.filePath)) {
    finalPath = jobRef.filePath;
  }

  if (!finalPath) {
    throw new Error("Downloaded file not found on disk");
  }

  const stats = statSync(finalPath);
  jobRef.filesize = stats.size;
  jobRef.filePath = finalPath;
  jobRef.filename = finalPath.split("/").pop() ?? jobRef.filename ?? `video.${jobRef.ext}`;
  jobRef.status = "done";
  jobRef.percent = 100;
  jobRef.speed = null;
  jobRef.eta = null;
  jobRef.message = null;
  scheduleAutoDelete(jobId, jobRef);
}

router.get("/youtube/progress/:jobId", (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({
    jobId,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    filename: job.filename,
    filesize: job.filesize,
    message: job.message,
  });
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

  const cacheKey = `${url}::${safeFormatId}`;

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
        url,
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

router.get("/youtube/file/:jobId", (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found", expired: true });
    return;
  }
  if (job.status === "expired") {
    res.status(410).json({
      error: "File has expired. Please download the video again.",
      expired: true,
    });
    return;
  }
  if (job.status !== "done" || !job.filePath) {
    res.status(404).json({ error: "File not found or download not complete" });
    return;
  }

  if (!existsSync(job.filePath)) {
    res.status(410).json({
      error: "File has expired. Please download the video again.",
      expired: true,
    });
    return;
  }

  const stats = statSync(job.filePath);
  const filename = job.filename ?? `video.${job.ext}`;

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", stats.size);

  const readStream = createReadStream(job.filePath);
  readStream.pipe(res);

  readStream.on("close", () => {
    try {
      unlinkSync(job.filePath!);
    } catch {}
    jobs.delete(jobId);
  });
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
  const { url, format } = req.query as { url?: string; format?: string };

  if (!url) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  const outputFormat = format === "vtt" ? "vtt" : "srt";
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
        url,
      ]);
      const meta = JSON.parse(metaJson);
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      const directUrl = pickBestSubtitleUrl(subs, autoCaps, meta.language);
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
        "--sub-lang", "hi.*,en.*",
        "--sub-format", "vtt",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "-o", subBase,
        url,
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
  const sessionId = randomUUID();
  const audioDir = join(DOWNLOAD_DIR, `audio-fix-${sessionId}`);
  const subDir = join(DOWNLOAD_DIR, `subs-fix-${sessionId}`);
  let geminiFileName: string | null = null;
  const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

  try {
    // ── Step 1: Fetch raw subtitle VTT ──
    mkdirSync(subDir, { recursive: true });
    const subBase = join(subDir, "sub");
    let vttContent: string | null = null;

    try {
      const metaJson = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
      const meta = JSON.parse(metaJson);
      const directUrl = pickBestSubtitleUrl(meta.subtitles ?? {}, meta.automatic_captions ?? {}, meta.language);
      if (directUrl) {
        const raw = await fetchUrl(directUrl);
        if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
      }
    } catch {}

    if (!vttContent) {
      await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-lang", "hi.*,en.*", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, url]).catch(() => {});
      if (!existsSync(subDir) || !readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
        await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, url]).catch(() => {});
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
          const proc = spawn(PYTHON_BIN, [
            "-m", "yt_dlp",
            "-f", "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio",
            "--no-playlist", "--no-warnings",
            "-o", audioPattern, url,
          ], { env: PYTHON_ENV });
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
        // Try Replit integration first (gemini-3.1-pro-preview), then own key (gemini-2.5-pro)
        const replitBase = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
        const replitKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
        let done = false;
        if (replitBase && replitKey) {
          try {
            const rc = new GoogleGenAI({ apiKey: replitKey, httpOptions: { apiVersion: "", baseUrl: replitBase } });
            const rr = await rc.models.generateContent({
              model: "gemini-3.1-pro-preview",
              contents: [{ role: "user", parts: [{ text: promptText }] }],
              config: { systemInstruction },
            });
            corrected = (rr as any).text ?? "";
            done = true;
          } catch (e) {
            console.warn("[subtitle/fix] Replit gemini-3.1-pro-preview failed, falling back to own key:", (e as Error).message);
          }
        }
        if (!done) {
          const result = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            config: { systemInstruction },
          });
          corrected = (result as any).text ?? "";
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
    !!process.env.GEMINI_API_KEY
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

  if (!process.env.GEMINI_API_KEY) throw new Error("No AI provider configured — add GEMINI_API_KEY or enable Replit integration");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    ...(systemInstruction && { systemInstruction }),
  });
  const result = await model.generateContent(userContent);
  return result.response.text();
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

interface ClipJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: { clips: BestClip[]; hasTranscript: boolean; videoDuration: number };
  error?: string;
  createdAt: number;
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
router.post("/youtube/clips", async (req: Request, res: Response) => {
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
  if (!isAiConfigured()) {
    res.status(503).json({
      error: "AI not configured",
      details: "Add GEMINI_API_KEY to Secrets or enable Replit Gemini integration",
    });
    return;
  }

  const jobId = randomUUID();
  const job: ClipJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  job.emitter.setMaxListeners(5);
  clipJobs.set(jobId, job);
  res.json({ jobId });

  // Run analysis in background
  runClipAnalysis(
    jobId,
    job,
    url,
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
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

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

async function runClipAnalysis(
  jobId: string,
  job: ClipJob,
  url: string,
  durations: number[],
  log: any,
  autoMode: boolean = false,
  customInstructions?: string,
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
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
      const metaJson = await runYtDlp([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ]);
      const meta = JSON.parse(metaJson);
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
        /sign.in|bot|blocked|403|not available|This video is not available|This video has been/i.test(ytErr);
      const errMsg = isBlocked
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
    emit("done", resultData);
  } catch (err) {
    log.error({ err }, "Clip analysis failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    job.status = "error";
    job.error = message;
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

router.post("/youtube/download-clip", async (req: Request, res: Response) => {
  const { url, startSec, endSec, title } = req.body as {
    url: string;
    startSec: number;
    endSec: number;
    title?: string;
  };

  if (!url || startSec == null || endSec == null) {
    res.status(400).json({ error: "url, startSec, and endSec are required" });
    return;
  }

  const jobId = randomUUID();
  const safeTitle = (title ?? "clip")
    .replace(/[^\w\s\-_.()]/g, "_")
    .slice(0, 60);
  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: `${safeTitle}.mp4`,
    filesize: null,
    message: "Starting clip download...",
    filePath: null,
    url,
    formatId: "bestvideo+bestaudio/best",
    audioOnly: false,
    ext: "mp4",
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Clip download started" });

  const start = formatTime(Math.round(startSec));
  const end = formatTime(Math.round(endSec));
  const outputPath = join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  const jobRef = jobs.get(jobId)!;
  jobRef.status = "downloading";

  const cookieArgs = getYtdlpCookieArgs();
  const baseClipArgs = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
    "--download-sections",
    `*${start}-${end}`,
    "-o",
    outputPath,
    url,
  ];

  const heavyClipFormats = [
    "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]",
    "bestvideo[vcodec^=avc1][height<=1080]+bestaudio",
    "bestvideo[height<=1080]+bestaudio",
    "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]",
    "bestvideo[vcodec^=avc1]+bestaudio",
    "bestvideo+bestaudio",
  ];
  const fastClipFormats = [
    "best[ext=mp4][height<=1080]",
    "best[height<=1080]",
    "best[ext=mp4][height<=720]",
    "best[height<=720]",
  ];

  const runClipAttempt = (formatSelector: string, heavy: boolean): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const args = [
        ...baseClipArgs.slice(0, 4),
        "-f",
        formatSelector,
        ...(heavy ? ["--merge-output-format", "mp4", "--force-keyframes-at-cuts"] : []),
        ...baseClipArgs.slice(4),
      ];

      const proc = spawn(PYTHON_BIN, ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...cookieArgs, ...args], {
        env: PYTHON_ENV,
      });
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          const t = line.trim();
          const progressMatch = t.match(/\[download\]\s+([\d.]+)%/);
          if (progressMatch) {
            jobRef.percent = Math.round(parseFloat(progressMatch[1]));
          }
          const destMatch = t.match(
            /\[(?:download|Merger)\] Destination:\s+(.+)/,
          );
          if (destMatch) {
            jobRef.filePath = destMatch[1].trim();
            jobRef.filename =
              destMatch[1].trim().split("/").pop() ?? `${safeTitle}.mp4`;
          }
          if (t.includes("[Merger]")) {
            jobRef.status = "merging";
            jobRef.message = "Merging clip...";
          }
        }
      });
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on("close", (code: number | null) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(stderr.slice(-400) || `yt-dlp exited with code ${code}`),
          );
      });
      proc.on("error", (err: Error) => reject(err));
    });

  const clipAttempt = async (): Promise<void> => {
    let lastErr: Error | null = null;

    for (const formatSelector of heavyClipFormats) {
      try {
        jobRef.message = "Downloading HD clip...";
        await runClipAttempt(formatSelector, true);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error("HD clip download failed");
      }
    }

    for (const formatSelector of fastClipFormats) {
      try {
        jobRef.message = "Falling back to standard clip quality...";
        await runClipAttempt(formatSelector, false);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error("Standard clip download failed");
      }
    }

    throw lastErr ?? new Error("Clip download failed");
  };

  clipAttempt()
    .then(() => {
      const ext = ["mp4", "mkv", "webm"].find((e) =>
        existsSync(join(DOWNLOAD_DIR, `${jobId}.${e}`)),
      );
      const finalPath = ext
        ? join(DOWNLOAD_DIR, `${jobId}.${ext}`)
        : (jobRef.filePath ?? null);
      if (!finalPath || !existsSync(finalPath)) {
        jobRef.status = "error";
        jobRef.message = "Clip file not found after download";
        return;
      }
      jobRef.filePath = finalPath;
      jobRef.filename = `${safeTitle}.mp4`;
      jobRef.filesize = statSync(finalPath).size;
      jobRef.status = "done";
      jobRef.percent = 100;
      jobRef.speed = null;
      jobRef.eta = null;
      jobRef.message = null;
      scheduleAutoDelete(jobId, jobRef);
    })
    .catch((err) => {
      req.log.error({ err, jobId }, "Clip download failed");
      jobRef.status = "error";
      jobRef.message = err instanceof Error ? err.message : "Download failed";
    });
});

export default router;
