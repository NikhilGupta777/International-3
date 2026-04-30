import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  createReadStream,
  rmSync,
} from "fs";
import {
  DynamoDBClient,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pino from "pino";

type WorkerPayload = {
  jobId: string;
  jobType:
    | "download"
    | "clip-cut"
    | "subtitles"
    | "best-clips"
    | "bhagwat-analyze"
    | "bhagwat-render";
  sourceUrl: string;
  requestedAt: number;
  meta?: Record<string, unknown>;
};

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const JOB_TABLE = process.env.JOB_TABLE ?? "";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_PO_TOKEN = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";
let ytdlpCookiesBase64 = process.env.YTDLP_COOKIES_BASE64 ?? "";
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || join(tmpdir(), ".yt-cookies-worker.txt");
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const S3_OBJECT_PREFIX = (process.env.S3_OBJECT_PREFIX ?? "ytgrabber-green").replace(/^\/+|\/+$/g, "");
const DEFAULT_VIDEO_FORMAT_SELECTOR =
  "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/" +
  "bestvideo[ext=mp4]+bestaudio[ext=m4a]/" +
  "bestvideo[vcodec!=none]+bestaudio[acodec!=none]/" +
  "best[ext=mp4][vcodec!=none][acodec!=none]/" +
  "best[vcodec!=none][acodec!=none]";

const ddb = JOB_TABLE ? new DynamoDBClient({ region: REGION }) : null;
const s3 = S3_BUCKET ? new S3Client({ region: REGION }) : null;

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

function parsePayload(): WorkerPayload {
  const raw = process.env.JOB_PAYLOAD;
  if (!raw) throw new Error("Missing JOB_PAYLOAD");
  const parsed = JSON.parse(raw) as Partial<WorkerPayload>;
  if (!parsed.jobId || !parsed.jobType || !parsed.sourceUrl || !parsed.requestedAt) {
    throw new Error("Invalid JOB_PAYLOAD");
  }
  return parsed as WorkerPayload;
}

function getMetaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getMetaNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const value = meta?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function getMetaBool(meta: Record<string, unknown> | undefined, key: string, fallback = false): boolean {
  const value = meta?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return fallback;
}

type BhagwatTimelineSegment = {
  startSec: number;
  endSec: number;
  isBhajan: boolean;
  imageChangeEvery: number;
  description: string;
  imagePrompt: string;
};

function parseBhagwatTimeline(meta: Record<string, unknown> | undefined): BhagwatTimelineSegment[] {
  const raw = meta?.timeline;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const startSec = Number(item.startSec);
      const endSec = Number(item.endSec);
      const imageChangeEvery = Number(item.imageChangeEvery ?? 10);
      return {
        startSec: Number.isFinite(startSec) ? Math.max(0, startSec) : 0,
        endSec: Number.isFinite(endSec) ? Math.max(0, endSec) : 0,
        isBhajan: item.isBhajan === true,
        imageChangeEvery: Number.isFinite(imageChangeEvery)
          ? Math.max(1, Math.round(imageChangeEvery))
          : 10,
        description: typeof item.description === "string" ? item.description.slice(0, 200) : "",
        imagePrompt: typeof item.imagePrompt === "string" ? item.imagePrompt.slice(0, 1000) : "",
      };
    })
    .filter((item) => item.endSec > item.startSec + 0.5 && item.imagePrompt.trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec);
}

function toAttr(value: string | number | boolean): AttributeValue {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  return { BOOL: value };
}

async function updateJobState(
  jobId: string,
  status: string,
  message: string,
  extra?: Record<string, string | number | boolean>,
): Promise<void> {
  if (!ddb || !JOB_TABLE) return;

  const names: Record<string, string> = {
    "#s": "status",
    "#m": "message",
    "#u": "updatedAt",
  };
  const values: Record<string, AttributeValue> = {
    ":s": { S: status },
    ":m": { S: message },
    ":u": { N: String(Date.now()) },
  };
  const sets: string[] = ["#s = :s", "#m = :m", "#u = :u"];

  if (extra) {
    let index = 0;
    for (const [key, raw] of Object.entries(extra)) {
      if (raw === undefined || raw === null) continue;
      index += 1;
      const n = `#e${index}`;
      const v = `:e${index}`;
      names[n] = key;
      values[v] = toAttr(raw);
      sets.push(`${n} = ${v}`);
    }
  }

  await ddb.send(
    new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: jobId } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

function ensureCookieFileIfNeeded(): string | null {
  if (existsSync(YTDLP_COOKIES_FILE)) return YTDLP_COOKIES_FILE;
  if (!ytdlpCookiesBase64) return null;
  try {
    const content = decodeCookiesFromBase64(ytdlpCookiesBase64);
    if (!content) return null;
    writeFileSync(YTDLP_COOKIES_FILE, content, "utf8");
    return YTDLP_COOKIES_FILE;
  } catch {
    return null;
  }
}

async function loadCookiesFromS3IfConfigured(): Promise<void> {
  if (ytdlpCookiesBase64 || !YTDLP_COOKIES_S3_KEY) return;
  if (!s3 || !S3_BUCKET) {
    logger.warn({ hasS3: !!s3, hasBucket: !!S3_BUCKET }, "YTDLP_COOKIES_S3_KEY set but S3 is not configured");
    return;
  }
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: YTDLP_COOKIES_S3_KEY,
    }),
  );
  const buffer = await bodyToBuffer(result.Body);
  ytdlpCookiesBase64 = buffer.toString("utf8").trim();
  if (ytdlpCookiesBase64) {
    process.env.YTDLP_COOKIES_BASE64 = ytdlpCookiesBase64;
    logger.info({ key: YTDLP_COOKIES_S3_KEY }, "Loaded yt-dlp cookies from S3");
  }
}

function buildYtDlpBaseArgs(): string[] {
  const args: string[] = [
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--extractor-retries",
    "5",
    "--socket-timeout",
    "30",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
    "--add-headers",
    [
      "Accept-Language:en-US,en;q=0.9",
      "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer:https://www.youtube.com/",
      "Origin:https://www.youtube.com",
    ].join(";"),
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ];

  if (YTDLP_PROXY) args.push("--proxy", YTDLP_PROXY);

  const cookiePath = ensureCookieFileIfNeeded();
  if (cookiePath) args.push("--cookies", cookiePath);

  if (YTDLP_POT_PROVIDER_URL) {
    args.push(
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`,
    );
  }

  if (YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA) {
    args.push(
      "--extractor-args",
      `youtube:player_client=web,web_embedded,mweb;po_token=web.gvs+${YTDLP_PO_TOKEN};visitor_data=${YTDLP_VISITOR_DATA}`,
    );
  } else if (cookiePath) {
    args.push("--extractor-args", "youtube:player_client=web,web_embedded,tv_embedded");
  } else {
    args.push("--extractor-args", "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless");
  }
  return args;
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
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|sign.*in.*your age|age.*restrict|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|video.*unavailable.*country|precondition.*failed|http error 401|requested format is not available|format.*not available|not made this video available|not available in your country|geo.*restrict/i.test(
    message,
  );
}

function getCookieArgs(): string[] {
  const cookiePath = ensureCookieFileIfNeeded();
  if (!cookiePath) return [];
  return ["--cookies", cookiePath];
}

function getDefaultYouTubeExtractorArgs(): string[] {
  if (YTDLP_POT_PROVIDER_URL) {
    return ["--extractor-args", "youtube:player_client=web,web_embedded,mweb"];
  }
  if (YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA) {
    return [
      "--extractor-args",
      `youtube:player_client=web,web_embedded,mweb;po_token=web.gvs+${YTDLP_PO_TOKEN};visitor_data=${YTDLP_VISITOR_DATA}`,
    ];
  }
  const cookieArgs = getCookieArgs();
  if (cookieArgs.length > 0) {
    return ["--extractor-args", "youtube:player_client=web,web_embedded,tv_embedded"];
  }
  return ["--extractor-args", "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless"];
}

function getYouTubeFallbacks(): string[][] {
  if (YTDLP_POT_PROVIDER_URL || (YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA)) {
    return [
      ["--extractor-args", "youtube:player_client=web,web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=mweb,ios"],
      ["--extractor-args", "youtube:player_client=ios"],
      ["--extractor-args", "youtube:player_client=android_vr"],
    ];
  }
  if (getCookieArgs().length > 0) {
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

function runYtDlp(jobId: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    logger.info({ jobId, args }, "Running yt-dlp command");
    const proc = spawn(PYTHON_BIN, ["-m", "yt_dlp", ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      logger.error(
        { jobId, code, stderrTail: stderr.slice(-1200) },
        "yt-dlp exited with non-zero status",
      );
      reject(new Error(`yt-dlp failed for ${jobId}: ${stderr.slice(-700) || `exit ${String(code)}`}`));
    });
  });
}

function isFormatUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Requested format is not available/i.test(msg);
}

function stripFormatArg(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-f") {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function stripArgWithValue(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function qualityToFormatSelector(quality: string): string {
  const normalized = quality.trim().toLowerCase().replace(/p$/, "");
  const parsedHeight = Number.parseInt(normalized, 10);
  const maxHeight =
    normalized === "best" || !Number.isFinite(parsedHeight) || parsedHeight <= 0 ? null : parsedHeight;

  if (!maxHeight) {
    return DEFAULT_VIDEO_FORMAT_SELECTOR;
  }
  return `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}][vcodec!=none]+bestaudio[acodec!=none]/best[height<=${maxHeight}][ext=mp4][vcodec!=none][acodec!=none]`;
}

function normalizeVideoDownloadFormat(formatId: string | null): string | null {
  const requested = formatId?.trim();
  if (!requested) return null;
  if (requested === "bestvideo+bestaudio/best") return DEFAULT_VIDEO_FORMAT_SELECTOR;
  if (requested === "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best") {
    return DEFAULT_VIDEO_FORMAT_SELECTOR;
  }
  return requested;
}

function qualityToFormatCandidates(quality: string): string[] {
  const normalized = quality.trim().toLowerCase();
  const numeric = normalized === "best" ? Number.NaN : Number.parseInt(normalized.replace("p", ""), 10);
  const maxHeight = Number.isFinite(numeric) ? Math.max(144, numeric) : null;

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
const MAX_CLIP_CLIENT_FALLBACKS = 3;
const MAX_CLIP_DOWNLOAD_ATTEMPTS = 8;

function findOutputFile(jobId: string, preferredExts: string[], allowOtherExt = false): string {
  const temp = tmpdir();
  for (const ext of preferredExts) {
    const path = join(temp, `${jobId}.${ext}`);
    if (existsSync(path)) return path;
  }
  if (!allowOtherExt) {
    throw new Error(`Output file not found after yt-dlp run (${preferredExts.join(", ")})`);
  }
  const startsWith = `${jobId}.`;
  const match = readdirSync(temp).find((name) => name.startsWith(startsWith));
  if (!match) throw new Error("Output file not found after yt-dlp run");
  return join(temp, match);
}

async function uploadIfConfigured(
  localPath: string,
  jobId: string,
  namespace: "youtube/downloads" | "youtube/clips" | "bhagwat/final",
): Promise<{ s3Key: string | null; filename: string; filesize: number }> {
  const filename = basename(localPath);
  const filesize = statSync(localPath).size;
  if (!s3 || !S3_BUCKET) {
    return { s3Key: null, filename, filesize };
  }

  const key = `${S3_OBJECT_PREFIX}/${namespace}/${jobId}/${randomUUID()}-${filename}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: "application/octet-stream",
    }),
  );
  return { s3Key: key, filename, filesize };
}

function cleanupFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof (body as any).transformToByteArray === "function") {
    return Buffer.from(await (body as any).transformToByteArray());
  }
  if (typeof (body as any).transformToString === "function") {
    return Buffer.from(await (body as any).transformToString(), "utf8");
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    (body as NodeJS.ReadableStream)
      .on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

async function uploadTextIfConfigured(
  body: string,
  jobId: string,
  namespace: string,
  filename: string,
  contentType: string,
): Promise<string | null> {
  if (!s3 || !S3_BUCKET) return null;
  const key = `${S3_OBJECT_PREFIX}/${namespace}/${jobId}/${randomUUID()}-${filename}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

async function downloadS3ObjectToLocal(key: string, localPath: string): Promise<void> {
  if (!s3 || !S3_BUCKET) {
    throw new Error("S3 is not configured for subtitle uploads");
  }
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
  );
  const buffer = await bodyToBuffer(result.Body);
  writeFileSync(localPath, buffer);
}

async function handleDownload(payload: WorkerPayload): Promise<void> {
  const formatId = normalizeVideoDownloadFormat(getMetaString(payload.meta, "formatId"));
  const audioOnly = getMetaBool(payload.meta, "audioOnly", false);
  const outputTemplate = join(tmpdir(), `${payload.jobId}.%(ext)s`);
  const cmdArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
  ];
  if (formatId) cmdArgs.push("-f", formatId);

  if (audioOnly) {
    if (!formatId) cmdArgs.push("-f", "bestaudio/best");
    cmdArgs.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    if (!formatId) cmdArgs.push("-f", DEFAULT_VIDEO_FORMAT_SELECTOR);
    if (formatId) {
      cmdArgs.push("--merge-output-format", "mp4");
    }
    cmdArgs.push("--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5");
  }
  cmdArgs.push("-o", outputTemplate, payload.sourceUrl);

  await updateJobState(payload.jobId, "running", "Downloading...");

  const isYt = isYouTubeUrl(payload.sourceUrl);
  const cookieArgs = getCookieArgs();
  const defaultYoutubeArgs = isYt ? getDefaultYouTubeExtractorArgs() : [];
  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);
  const downloadFallbacks: string[][] = getYouTubeFallbacks();
  const attempted = new Set<string>();
  let lastErr: Error | null = null;

  for (const extra of attemptPlans) {
    const key = extra.join("\u0001");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      await runYtDlp(payload.jobId, [...buildYtDlpBaseArgs(), ...extra, ...cmdArgs]);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp download failed");
      if (formatId && isFormatUnavailableError(lastErr)) {
        await updateJobState(payload.jobId, "running", "Retrying with fallback format");
        const retryCmd = stripFormatArg(cmdArgs);
        retryCmd.unshift("-f", audioOnly ? "bestaudio/best" : DEFAULT_VIDEO_FORMAT_SELECTOR);
        await runYtDlp(payload.jobId, [...buildYtDlpBaseArgs(), ...extra, ...retryCmd]);
        lastErr = null;
        break;
      }
      if (!isYt || !isYouTubeBlockedError(lastErr.message)) throw lastErr;
    }
  }

  if (lastErr && isYt) {
    await updateJobState(payload.jobId, "running", audioOnly ? "Retrying download..." : "Retrying with alternate client...");
    for (const fallback of downloadFallbacks) {
      const plans = cookieArgs.length ? [[...cookieArgs, ...fallback], fallback] : [fallback];
      for (const extra of plans) {
        const key = extra.join("\u0001");
        if (attempted.has(key)) continue;
        attempted.add(key);
        try {
          await runYtDlp(payload.jobId, [...buildYtDlpBaseArgs(), ...extra, ...cmdArgs]);
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
  const outputPath = findOutputFile(
    payload.jobId,
    audioOnly ? ["mp3", "m4a"] : ["mp4"],
    audioOnly,
  );
  const uploaded = await uploadIfConfigured(outputPath, payload.jobId, "youtube/downloads");

  await updateJobState(payload.jobId, "done", "Download complete", {
    filename: uploaded.filename,
    filesize: uploaded.filesize,
    ...(uploaded.s3Key ? { s3Key: uploaded.s3Key } : {}),
  });
  cleanupFile(outputPath);
}

async function handleClipCut(payload: WorkerPayload): Promise<void> {
  const startTime = getMetaNumber(payload.meta, "startTime") ?? getMetaNumber(payload.meta, "startSec") ?? 0;
  const endTime = getMetaNumber(payload.meta, "endTime") ?? getMetaNumber(payload.meta, "endSec") ?? startTime + 60;
  if (endTime <= startTime) throw new Error("Invalid clip range");

  const quality = getMetaString(payload.meta, "quality") ?? "best";
  const section = `*${startTime}-${endTime}`;
  const outputTemplate = join(tmpdir(), `${payload.jobId}.%(ext)s`);
  const formatCandidates = qualityToFormatCandidates(quality).slice(0, MAX_CLIP_FORMAT_CANDIDATES);
  const baseClipArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
    "--download-sections",
    section,
    "--force-keyframes-at-cuts",
    "--downloader-args",
    "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
    "-o",
    outputTemplate,
    payload.sourceUrl,
  ];

  await updateJobState(payload.jobId, "running", "Cutting clip...");
  const isYt = isYouTubeUrl(payload.sourceUrl);
  const cookieArgs = getCookieArgs();
  const defaultYoutubeArgs = isYt ? getDefaultYouTubeExtractorArgs() : [];
  const downloadFallbacks = getYouTubeFallbacks();

  let lastErr: Error | null = null;
  let attemptsUsed = 0;
  for (const formatSelector of formatCandidates) {
    if (attemptsUsed >= MAX_CLIP_DOWNLOAD_ATTEMPTS) break;
    const cmdArgs = [
      "-f",
      formatSelector,
      "--merge-output-format",
      "mp4",
      ...baseClipArgs,
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
        await runYtDlp(payload.jobId, [...buildYtDlpBaseArgs(), ...extra, ...cmdArgs]);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error("yt-dlp clip cut failed");
        if (!isYt || !isYouTubeBlockedError(lastErr.message)) break;
      }
    }

    if (lastErr && isYt && isYouTubeBlockedError(lastErr.message) && attemptsUsed < MAX_CLIP_DOWNLOAD_ATTEMPTS) {
      await updateJobState(payload.jobId, "running", "Retrying with alternate client...");
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
            await runYtDlp(payload.jobId, [...buildYtDlpBaseArgs(), ...extra, ...cmdArgs]);
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
    throw new Error(`Clip cut failed after ${attemptsUsed} attempts: ${lastErr.message}`);
  }
  if (lastErr) throw lastErr;
  const outputPath = findOutputFile(payload.jobId, ["mp4"]);
  const uploaded = await uploadIfConfigured(outputPath, payload.jobId, "youtube/clips");

  await updateJobState(payload.jobId, "done", "Clip ready", {
    progressPct: 100,
    filename: uploaded.filename,
    filesize: uploaded.filesize,
    ...(uploaded.s3Key ? { s3Key: uploaded.s3Key } : {}),
  });
  cleanupFile(outputPath);
}

async function handleBestClips(payload: WorkerPayload): Promise<void> {
  const {
    createClipJobState,
    deleteClipJobState,
    runClipAnalysis,
  } = await import("../../api-server/src/routes/youtube");
  const durations = Array.isArray(payload.meta?.durations)
    ? payload.meta?.durations
        .map((value) => (typeof value === "number" ? value : Number(value)))
        .filter((value): value is number => Number.isFinite(value))
    : [];
  const auto = getMetaBool(payload.meta, "auto", false);
  const instructions = getMetaString(payload.meta, "instructions") ?? undefined;
  const notifyClientKey = getMetaString(payload.meta, "notifyClientKey");

  const job = createClipJobState(payload.jobId, {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
    notifyClientKey,
  });

  const stepUpdates: Promise<void>[] = [];
  const onStep = (data: any) => {
    const message =
      typeof data?.message === "string" && data.message.trim().length > 0
        ? data.message
        : "Analyzing best clips...";
    stepUpdates.push(updateJobState(payload.jobId, "running", message));
  };

  job.emitter.on("step", onStep);

  try {
    await updateJobState(payload.jobId, "running", "Starting best-clips analysis...");
    await runClipAnalysis(
      payload.jobId,
      job,
      payload.sourceUrl,
      durations ?? [],
      logger,
      auto,
      instructions,
    );

    if (job.status !== "done" || !job.result) {
      throw new Error(job.error ?? "Best clips analysis did not produce a result");
    }

    await Promise.allSettled(stepUpdates);
    await updateJobState(payload.jobId, "done", `${job.result.clips.length} clips found`, {
      resultJson: JSON.stringify(job.result),
      progressPct: 100,
    });
  } finally {
    job.emitter.off("step", onStep);
    deleteClipJobState(payload.jobId);
  }
}

async function handleSubtitles(payload: WorkerPayload): Promise<void> {
  const {
    createSubtitleJobState,
    deleteSubtitleJobState,
    downloadSubtitleSourceAudio,
    getSubtitleJobState,
    processSubtitleAudio,
  } = await import("../../api-server/src/routes/subtitles");
  const language = getMetaString(payload.meta, "language") ?? "auto";
  const translateTo = getMetaString(payload.meta, "translateTo") ?? undefined;
  const notifyClientKey = getMetaString(payload.meta, "notifyClientKey");
  const originalFilename = getMetaString(payload.meta, "originalFilename");
  const uploadS3Key = getMetaString(payload.meta, "uploadS3Key");

  const job = createSubtitleJobState(payload.jobId, {
    status: "pending",
    message: "Queued - starting soon...",
    filename: originalFilename ? `${originalFilename.replace(/\.[^.]+$/, "")}.srt` : "subtitles.srt",
    createdAt: Date.now(),
    translateTo,
    progressPct: 0,
    notifyClientKey,
  });

  const syncTimer = setInterval(() => {
    const state = getSubtitleJobState(payload.jobId);
    if (!state) return;
    const status = state.status === "done" ? "done" : state.status === "error" ? "error" : state.status === "cancelled" ? "cancelled" : "running";
    const message = state.error ?? state.message ?? status;
    void updateJobState(payload.jobId, status, message, {
      ...(typeof state.progressPct === "number" ? { progressPct: state.progressPct } : {}),
      ...(typeof state.durationSecs === "number" ? { durationSecs: state.durationSecs } : {}),
      ...(state.originalFilename ? { originalFilename: state.originalFilename } : {}),
    });
  }, 1500);

  const cleanupPaths: string[] = [];

  try {
    if (uploadS3Key) {
      const localName = originalFilename || `${payload.jobId}.bin`;
      const localPath = join(tmpdir(), `${payload.jobId}-${basename(localName)}`);
      await updateJobState(payload.jobId, "uploading", "Fetching uploaded media...", { progressPct: 10 });
      await downloadS3ObjectToLocal(uploadS3Key, localPath);
      cleanupPaths.push(localPath);
      await processSubtitleAudio(payload.jobId, localPath, language, job.filename, translateTo, () => {
        cleanupFile(localPath);
      });
    } else {
      const audioDir = join(tmpdir(), `srt-yt-${payload.jobId}`);
      cleanupPaths.push(audioDir);
      mkdirSync(audioDir, { recursive: true });
      const audioPattern = join(audioDir, "%(title)s.%(ext)s");
      await updateJobState(payload.jobId, "audio", "Downloading audio from YouTube...", { progressPct: 5 });
      await downloadSubtitleSourceAudio(
        [
          "-f", "bestaudio/best",
          "--no-playlist", "--no-warnings",
          "-o", audioPattern, payload.sourceUrl,
        ],
        job,
      );

      if (job.cancelled) {
        await updateJobState(payload.jobId, "cancelled", "Cancelled by user", { progressPct: job.progressPct ?? 0 });
        return;
      }

      const audioFiles = existsSync(audioDir) ? readdirSync(audioDir) : [];
      const audioFile = audioFiles
        .map((name) => join(audioDir, name))
        .find((name) => /\.(m4a|mp4|webm|ogg|opus|mp3|flac|wav|aac)$/i.test(name));

      if (!audioFile) {
        throw new Error("Could not download audio for subtitles");
      }

      const rawFilename = basename(audioFile);
      const videoTitle =
        rawFilename.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "-").trim() || "subtitles";
      job.filename = `${videoTitle}.srt`;

      await processSubtitleAudio(payload.jobId, audioFile, language, job.filename, translateTo, () => {
        try {
          rmSync(audioDir, { recursive: true, force: true });
        } catch {}
      });
    }

    if (job.status === "cancelled") {
      await updateJobState(payload.jobId, "cancelled", job.message || "Cancelled by user", {
        ...(typeof job.progressPct === "number" ? { progressPct: job.progressPct } : {}),
      });
      return;
    }

    if (job.status !== "done" || !job.srt) {
      throw new Error(job.error ?? "Subtitle generation failed");
    }

    const translatedKey = await uploadTextIfConfigured(
      job.srt,
      payload.jobId,
      "subtitles/final",
      job.filename,
      "application/x-subrip",
    );
    const originalKey =
      job.originalSrt && job.originalFilename
        ? await uploadTextIfConfigured(
            job.originalSrt,
            payload.jobId,
            "subtitles/original",
            job.originalFilename,
            "application/x-subrip",
          )
        : null;

    await updateJobState(payload.jobId, "done", job.message || "Subtitles ready!", {
      filename: job.filename,
      ...(translatedKey ? { s3Key: translatedKey } : {}),
      ...(originalKey ? { originalS3Key: originalKey } : {}),
      ...(job.originalFilename ? { originalFilename: job.originalFilename } : {}),
      ...(typeof job.durationSecs === "number" ? { durationSecs: job.durationSecs } : {}),
      progressPct: 100,
    });
  } finally {
    clearInterval(syncTimer);
    deleteSubtitleJobState(payload.jobId);
    for (const path of cleanupPaths) {
      try {
        if (existsSync(path)) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

async function handleBhagwatAnalyze(payload: WorkerPayload): Promise<void> {
  const {
    createBhagwatAnalysisJobState,
    createBhagwatUploadedAudioState,
    deleteBhagwatAnalysisJobState,
    deleteBhagwatUploadedAudioState,
    runBhagwatAnalysis,
    runBhagwatAnalysisFromFile,
  } = await import("../../api-server/src/routes/bhagwat");

  const modeRaw = getMetaString(payload.meta, "mode");
  const mode: "smart" | "full" = modeRaw === "smart" ? "smart" : "full";
  const clipStartSec = getMetaNumber(payload.meta, "clipStartSec");
  const clipEndSec = getMetaNumber(payload.meta, "clipEndSec");
  const sourceKind = getMetaString(payload.meta, "sourceKind") === "upload" ? "upload" : "youtube";
  const originalFilename = getMetaString(payload.meta, "originalFilename") ?? `${payload.jobId}.bin`;
  const mimeType = getMetaString(payload.meta, "mimeType") ?? "application/octet-stream";
  const sizeBytes = getMetaNumber(payload.meta, "sizeBytes") ?? 0;

  const job = createBhagwatAnalysisJobState(payload.jobId, {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  });

  const progressByStep: Record<string, number> = {
    metadata: 20,
    transcript: 55,
    ai: 85,
  };
  let stagedAudioId: string | null = null;
  let stagedAudioPath: string | null = null;
  const stepUpdates: Promise<void>[] = [];

  const onStep = (data: unknown) => {
    const stepData = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const step = typeof stepData.step === "string" ? stepData.step : "";
    const status = typeof stepData.status === "string" ? stepData.status : "running";
    const message =
      typeof stepData.message === "string" && stepData.message.trim().length > 0
        ? stepData.message
        : "Bhagwat analysis running...";
    const progressPct = progressByStep[step] ?? 10;
    stepUpdates.push(
      updateJobState(payload.jobId, "running", message, {
        progressPct,
      }),
    );
  };

  job.emitter.on("step", onStep);

  try {
    await updateJobState(payload.jobId, "running", "Starting Bhagwat analysis...", {
      progressPct: 3,
    });

    if (sourceKind === "upload") {
      const uploadS3Key = getMetaString(payload.meta, "uploadS3Key");
      if (!uploadS3Key) {
        throw new Error("Missing uploadS3Key for Bhagwat uploaded-audio analysis");
      }
      stagedAudioPath = join(tmpdir(), `${payload.jobId}-${basename(originalFilename)}`);
      await updateJobState(payload.jobId, "uploading", "Fetching uploaded audio...", {
        progressPct: 8,
      });
      await downloadS3ObjectToLocal(uploadS3Key, stagedAudioPath);
      stagedAudioId = getMetaString(payload.meta, "audioId") ?? payload.jobId;
      createBhagwatUploadedAudioState(stagedAudioId, {
        path: stagedAudioPath,
        originalName: originalFilename,
        mimeType,
        sizeBytes,
        durationSec: 0,
        createdAt: Date.now(),
        s3Key: uploadS3Key,
      });
      await runBhagwatAnalysisFromFile(payload.jobId, job, stagedAudioId, mode);
    } else {
      await runBhagwatAnalysis(
        payload.jobId,
        job,
        payload.sourceUrl,
        mode,
        clipStartSec === null ? undefined : clipStartSec,
        clipEndSec === null ? undefined : clipEndSec,
      );
    }

    if (job.status !== "done" || !job.result) {
      throw new Error(job.error ?? "Bhagwat analysis did not produce a result");
    }

    await Promise.allSettled(stepUpdates);
    await updateJobState(payload.jobId, "done", "Bhagwat analysis complete", {
      progressPct: 100,
      resultJson: JSON.stringify(job.result),
    });
  } finally {
    job.emitter.off("step", onStep);
    deleteBhagwatAnalysisJobState(payload.jobId);
    if (stagedAudioId) {
      deleteBhagwatUploadedAudioState(stagedAudioId);
    }
    if (stagedAudioPath) {
      cleanupFile(stagedAudioPath);
    }
  }
}

async function handleBhagwatRender(payload: WorkerPayload): Promise<void> {
  const {
    createBhagwatRenderJobState,
    deleteBhagwatRenderJobState,
    runBhagwatRender,
  } = await import("../../api-server/src/routes/bhagwat");

  const timeline = parseBhagwatTimeline(payload.meta);
  if (timeline.length === 0) {
    throw new Error("Bhagwat render timeline is empty or invalid");
  }

  const modeRaw = getMetaString(payload.meta, "mode");
  const mode: "smart" | "full" = modeRaw === "smart" ? "smart" : "full";
  const sourceKind = getMetaString(payload.meta, "sourceKind") === "upload" ? "upload" : "youtube";
  const clipStartSec = getMetaNumber(payload.meta, "clipStartSec");
  const clipEndSec = getMetaNumber(payload.meta, "clipEndSec");
  const videoDuration = getMetaNumber(payload.meta, "videoDuration") ?? 0;
  const originalFilename = getMetaString(payload.meta, "originalFilename") ?? "uploaded-audio";

  let stagedAudioPath: string | null = null;
  if (sourceKind === "upload") {
    const uploadS3Key = getMetaString(payload.meta, "uploadS3Key");
    if (!uploadS3Key) {
      throw new Error("Missing uploadS3Key for Bhagwat uploaded-audio render");
    }
    stagedAudioPath = join(tmpdir(), `${payload.jobId}-${basename(originalFilename)}`);
    await updateJobState(payload.jobId, "uploading", "Fetching uploaded audio...", {
      progressPct: 6,
    });
    await downloadS3ObjectToLocal(uploadS3Key, stagedAudioPath);
  }

  const job = createBhagwatRenderJobState(payload.jobId, {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
    title: originalFilename.replace(/\.[^.]+$/, ""),
  });

  const progressUpdates: Promise<void>[] = [];
  const onProgress = (data: unknown) => {
    const progressData = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const percent = typeof progressData.percent === "number" ? progressData.percent : 0;
    const message =
      typeof progressData.message === "string" && progressData.message.trim().length > 0
        ? progressData.message
        : "Bhagwat render running...";
    progressUpdates.push(
      updateJobState(payload.jobId, "running", message, {
        progressPct: Math.max(0, Math.min(99, Math.round(percent))),
      }),
    );
  };

  job.emitter.on("progress", onProgress);

  try {
    await updateJobState(payload.jobId, "running", "Starting Bhagwat render...", {
      progressPct: 3,
    });

    await runBhagwatRender(
      payload.jobId,
      job,
      sourceKind === "upload" ? "" : payload.sourceUrl,
      timeline,
      videoDuration,
      clipStartSec === null ? undefined : clipStartSec,
      clipEndSec === null ? undefined : clipEndSec,
      stagedAudioPath ?? undefined,
      mode,
    );

    if (job.status !== "done" || !job.outputPath || !existsSync(job.outputPath)) {
      throw new Error(job.error ?? "Bhagwat render did not produce an output file");
    }

    if (!s3 || !S3_BUCKET) {
      throw new Error("S3 is required for queued Bhagwat render downloads");
    }

    const uploaded = await uploadIfConfigured(job.outputPath, payload.jobId, "bhagwat/final");
    if (!uploaded.s3Key) {
      throw new Error("Failed to upload rendered Bhagwat video to S3");
    }

    await Promise.allSettled(progressUpdates);
    const filename = job.filename ?? uploaded.filename;
    await updateJobState(payload.jobId, "done", "Bhagwat render complete", {
      progressPct: 100,
      filename,
      filesize: uploaded.filesize,
      s3Key: uploaded.s3Key,
      resultJson: JSON.stringify({ filename, s3Key: uploaded.s3Key }),
    });

    cleanupFile(job.outputPath);
  } finally {
    job.emitter.off("progress", onProgress);
    deleteBhagwatRenderJobState(payload.jobId);
    if (stagedAudioPath) {
      cleanupFile(stagedAudioPath);
    }
  }
}

async function main(): Promise<void> {
  await loadCookiesFromS3IfConfigured();
  const payload = parsePayload();
  logger.info(
    {
      jobId: payload.jobId,
      jobType: payload.jobType,
      sourceUrl: payload.sourceUrl,
    },
    "Queue worker started",
  );

  if (payload.jobType === "download") {
    await handleDownload(payload);
    return;
  }
  if (payload.jobType === "clip-cut") {
    await handleClipCut(payload);
    return;
  }
  if (payload.jobType === "best-clips") {
    await handleBestClips(payload);
    return;
  }
  if (payload.jobType === "subtitles") {
    await handleSubtitles(payload);
    return;
  }
  if (payload.jobType === "bhagwat-analyze") {
    await handleBhagwatAnalyze(payload);
    return;
  }
  if (payload.jobType === "bhagwat-render") {
    await handleBhagwatRender(payload);
    return;
  }

  // Do not mark unsupported job types as done; surface explicit error state.
  await updateJobState(
    payload.jobId,
    "error",
    `Worker handler not implemented for jobType: ${payload.jobType}`,
  );
  throw new Error(`Unsupported jobType in queue worker: ${payload.jobType}`);
}

main()
  .then(() => {
    // Force process termination because imported route modules create housekeeping intervals.
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "Queue worker failed");
    try {
      const raw = process.env.JOB_PAYLOAD;
      if (!raw) process.exit(1);
      const parsed = JSON.parse(raw) as Partial<WorkerPayload>;
      if (parsed.jobId) {
        await updateJobState(
          parsed.jobId,
          "error",
          err instanceof Error ? err.message.slice(0, 800) : "Unknown error",
        );
      }
    } catch {}
    process.exit(1);
  });
