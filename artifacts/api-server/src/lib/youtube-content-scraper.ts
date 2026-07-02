import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildScrapedChannelProfile,
  CONTENT_PROFILE_MAX_VIDEOS,
  type ScrapedChannelProfile,
  type ScrapedVideoInput,
} from "./youtube-content-profile";

const WORKSPACE_ROOT = process.env.REPL_HOME ?? process.cwd();
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  (process.platform === "win32"
    ? ""
    : ["/usr/local/bin/yt-dlp", "/opt/bin/yt-dlp", "/var/task/bin/yt-dlp"].find((candidate) => existsSync(candidate)) ?? "");
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || join(WORKSPACE_ROOT, ".yt-cookies.txt");
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";
const YTDLP_PO_TOKEN = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const SCRAPE_TIMEOUT_MS = Math.max(30_000, Number(process.env.CONTENT_MANAGER_SCRAPE_TIMEOUT_MS ?? 240_000) || 240_000);

type Progress = (message: string) => void;

export function normalizeYouTubeChannelInput(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Channel URL or handle is required.");
  if (raw.startsWith("@")) return `https://www.youtube.com/${raw}/videos`;
  if (/^UC[A-Za-z0-9_-]{10,}$/.test(raw)) return `https://www.youtube.com/channel/${raw}/videos`;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (!/(^|\.)youtube\.com$/i.test(url.hostname.replace(/^www\./i, "")) && !/youtu\.be$/i.test(url.hostname)) {
    throw new Error("Only YouTube channel URLs or handles are supported.");
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (/\/videos$/i.test(cleanPath)) return `${url.origin}${cleanPath}`;
  if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/i.test(cleanPath)) {
    return `${url.origin}${cleanPath}/videos`;
  }
  return `${url.origin}${cleanPath || ""}`;
}

export function mapYtDlpEntriesToScrapedVideos(entries: unknown[]): ScrapedVideoInput[] {
  return entries
    .filter((entry): entry is Record<string, any> => Boolean(entry && typeof entry === "object"))
    .slice(0, CONTENT_PROFILE_MAX_VIDEOS)
    .map((entry) => ({
      id: clean(entry.id) || inferVideoId(entry.url ?? entry.webpage_url),
      url: normalizeVideoUrl(entry.webpage_url ?? entry.url, entry.id),
      title: clean(entry.title),
      description: clean(entry.description),
      tags: normalizeTags(entry.tags ?? entry.keywords),
      publishedAt: normalizeUploadDate(entry.upload_date ?? entry.release_date ?? entry.timestamp_string ?? entry.modified_date),
      durationSec: numberOrNull(entry.duration),
      viewCount: numberOrNull(entry.view_count),
      likeCount: numberOrNull(entry.like_count),
      commentCount: numberOrNull(entry.comment_count),
      thumbnailUrl: clean(entry.thumbnail) || firstThumbnail(entry.thumbnails),
    }))
    .filter((entry) => entry.title);
}

export async function scrapeYouTubeChannelProfile(params: {
  channelInput: string;
  progress?: Progress;
}): Promise<ScrapedChannelProfile> {
  const url = normalizeYouTubeChannelInput(params.channelInput);
  params.progress?.("Resolving channel and recent uploads...");
  const json = await runYtDlpJson(url, params.progress);
  const entries = Array.isArray(json.entries) ? json.entries : [];
  const videos = mapYtDlpEntriesToScrapedVideos(entries);
  if (videos.length === 0) {
    throw new Error("No recent public videos could be scraped from this channel.");
  }
  params.progress?.(`Saving ${videos.length} recent videos...`);
  return buildScrapedChannelProfile({
    channelName: clean(json.channel) || clean(json.uploader) || clean(json.title) || "YouTube channel",
    channelInput: params.channelInput,
    channelId: clean(json.channel_id) || clean(json.uploader_id) || undefined,
    channelUrl: clean(json.channel_url) || url,
    handle: extractHandle(json.channel_url) || extractHandle(url),
    videos,
  });
}

async function runYtDlpJson(url: string, progress?: Progress): Promise<Record<string, any>> {
  const baseArgs = [
    "--dump-single-json",
    "--skip-download",
    "--ignore-errors",
    "--no-warnings",
    "--extractor-retries",
    "3",
    "--playlist-end",
    String(CONTENT_PROFILE_MAX_VIDEOS),
    "--socket-timeout",
    "30",
  ];
  const cookieArgs = getCookieArgs();
  const extraArgs = [
    ...(YTDLP_PROXY ? ["--proxy", YTDLP_PROXY] : []),
    ...(YTDLP_POT_PROVIDER_URL
      ? ["--extractor-args", `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`]
      : []),
    ...(YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA
      ? ["--extractor-args", `youtube:player_client=web,web_embedded,mweb;po_token=web.gvs+${YTDLP_PO_TOKEN};visitor_data=${YTDLP_VISITOR_DATA}`]
      : []),
  ];
  const command = YTDLP_BIN || PYTHON_BIN;
  const args = YTDLP_BIN
    ? [...baseArgs, ...cookieArgs, ...extraArgs, url]
    : ["-m", "yt_dlp", ...baseArgs, ...cookieArgs, ...extraArgs, url];
  progress?.("Fetching public video metadata...");

  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, { env: buildPythonEnv(), cwd: tmpdir() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Channel scrape timed out after ${Math.round(SCRAPE_TIMEOUT_MS / 1000)} seconds.`));
    }, SCRAPE_TIMEOUT_MS);
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      const lastLine = text.trim().split(/\r?\n/).filter(Boolean).pop();
      if (lastLine) progress?.(lastLine.slice(0, 160));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.slice(-1000) || `yt-dlp exited with code ${code}`));
    });
  });

  return parseYtDlpJson(raw);
}

function parseYtDlpJson(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") entries.push(parsed);
      } catch {
        // Ignore non-JSON progress lines.
      }
    }
    return { entries };
  }
}

function getCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE || !existsSync(YTDLP_COOKIES_FILE)) return [];
  try {
    const stat = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (!stat.startsWith("# Netscape HTTP Cookie File") && !stat.includes("\t")) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch {
    return [];
  }
}

function buildPythonEnv(): NodeJS.ProcessEnv {
  const pythonLibsBin = join(WORKSPACE_ROOT, ".pythonlibs", "bin");
  const pythonLibsLib = join(WORKSPACE_ROOT, ".pythonlibs", "lib");
  if (!existsSync(pythonLibsBin)) return { ...process.env };
  return {
    ...process.env,
    PATH: `${pythonLibsBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    PYTHONPATH: pythonLibsLib,
  };
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(clean).filter(Boolean))].slice(0, 40);
  if (typeof value === "string") return value.split(",").map(clean).filter(Boolean).slice(0, 40);
  return [];
}

function normalizeUploadDate(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
  return raw;
}

function normalizeVideoUrl(value: unknown, id: unknown): string {
  const raw = clean(value);
  if (/^https?:\/\//i.test(raw)) return raw;
  const videoId = clean(id) || inferVideoId(raw);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : raw;
}

function firstThumbnail(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value.find((item) => item && typeof item === "object" && typeof item.url === "string");
  return first ? clean((first as { url: string }).url) || null : null;
}

function inferVideoId(value: unknown): string {
  const raw = clean(value);
  const match = /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/.exec(raw);
  return match?.[1] ?? "";
}

function extractHandle(value: unknown): string | undefined {
  const match = /youtube\.com\/(@[^/?#]+)/i.exec(clean(value));
  return match?.[1];
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
