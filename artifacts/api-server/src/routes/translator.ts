/**
 * Translator API routes — AWS Batch GPU Scale-to-Zero Architecture
 *
 * Routes:
 *   GET  /api/translator/presign      → S3 presigned PUT URL for direct video upload
 *   POST /api/translator/submit       → Creates DynamoDB job + submits AWS Batch GPU job
 *   GET  /api/translator/status/:id   → Poll job status from DynamoDB
 *   GET  /api/translator/result/:id   → Get presigned GET URL for final video/SRT/transcript
 */

import { Router, Request, Response as ExpressResponse } from "express";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createGeminiClient, isGeminiConfigured } from "../lib/gemini-client";
import { setupSse, sseFlush } from "../lib/sse";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BatchClient,
  DescribeJobsCommand,
  SubmitJobCommand,
  TerminateJobCommand,
} from "@aws-sdk/client-batch";
import { randomUUID, createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, extname, join } from "path";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";
import { canUseTranslatorLipSync } from "../lib/admin-features";

const router = Router();

const REGION       = process.env.YOUTUBE_QUEUE_REGION ?? "us-east-1";
const S3_BUCKET    = process.env.S3_BUCKET!;
const DDB_TABLE    = process.env.YOUTUBE_QUEUE_JOB_TABLE!;
const BATCH_QUEUE   = process.env.TRANSLATOR_BATCH_JOB_QUEUE!;
const BATCH_QUEUE_FAST = process.env.TRANSLATOR_BATCH_JOB_QUEUE_FAST ?? "";
const BATCH_JOB_DEF = process.env.TRANSLATOR_BATCH_JOB_DEFINITION!;
// CPU Fargate queue — used for Neural Voice (no GPU) jobs.
// Falls back to GPU queue if not configured.
const CPU_BATCH_QUEUE   = process.env.TRANSLATOR_CPU_BATCH_JOB_QUEUE ?? "";
const CPU_BATCH_JOB_DEF = process.env.TRANSLATOR_CPU_BATCH_JOB_DEFINITION ?? "";
const GEMINI_KEY   = process.env.GEMINI_API_KEY ?? "";
const GEMINI_KEY_2 = process.env.GEMINI_API_KEY_2 ?? "";
const GEMINI_KEY_3 = process.env.GEMINI_API_KEY_3 ?? "";
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
const PUBLIC_SITE_URL = (
  process.env.PUBLIC_SITE_URL ||
  process.env.VITE_PUBLIC_SITE_URL ||
  "https://videomaking.in"
).replace(/\/+$/, "");
const TRANSLATOR_BATCH_TIMEOUT_SECONDS = Math.max(
  900,
  Math.min(21600, Number(process.env.TRANSLATOR_BATCH_TIMEOUT_SECONDS ?? "10800") || 10800),
);
const TRANSLATOR_BATCH_FALLBACK_TIMEOUT_SECONDS = Math.max(
  900,
  Math.min(
    TRANSLATOR_BATCH_TIMEOUT_SECONDS,
    Number(process.env.TRANSLATOR_BATCH_FALLBACK_TIMEOUT_SECONDS ?? "3000") || 3000,
  ),
);
const TRANSLATOR_MAX_VIDEO_SIZE_BYTES = Math.max(
  1,
  Number(process.env.TRANSLATOR_MAX_VIDEO_SIZE_BYTES ?? String(2 * 1024 * 1024 * 1024)) || 2 * 1024 * 1024 * 1024,
);
const TRANSLATOR_ALLOW_RUNTIME_MODEL_DOWNLOADS = process.env.TRANSLATOR_ALLOW_RUNTIME_MODEL_DOWNLOADS ?? "0";
const TRANSLATOR_LAMBDA_FAST_ENABLED = process.env.TRANSLATOR_LAMBDA_FAST_ENABLED !== "false";
const TRANSLATOR_LAMBDA_FAST_MAX_SECONDS = Math.max(
  60,
  Math.min(900, Number(process.env.TRANSLATOR_LAMBDA_FAST_MAX_SECONDS ?? "600") || 600),
);
const FFMPEG_BIN = process.env.FFMPEG_BIN || "/opt/bin/ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "/opt/bin/ffprobe";
const TRANSLATOR_TEXT_MODEL = process.env.TRANSLATOR_TEXT_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash";
// Model for the in-tab AI status assistant. "Gemini 3.5 medium" = gemini-3.5-flash
// with MEDIUM thinking (the codebase has no separate "medium" model id — flash +
// thinkingLevel MEDIUM is the canonical default the agent route uses).
const TRANSLATOR_ASSISTANT_MODEL = process.env.TRANSLATOR_ASSISTANT_MODEL || "gemini-3.5-flash";
const TRANSLATOR_URL_FETCH_TIMEOUT_MS = Math.max(
  5000,
  Math.min(120000, Number(process.env.TRANSLATOR_URL_FETCH_TIMEOUT_MS ?? "45000") || 45000),
);
const VERTEX_ENV_NAMES = [
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS_BASE64",
  "GOOGLE_APPLICATION_CREDENTIALS_S3_KEY",
  "GEMINI_USE_VERTEXAI",
  "VERTEX_AI_ENABLED",
  "VERTEX_AI_PROJECT",
  "VERTEX_AI_LOCATION",
] as const;

const s3    = new S3Client({ region: REGION });
const ddb   = new DynamoDBClient({ region: REGION });
const batch = new BatchClient({ region: REGION });

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

function parseEpoch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate) && asDate > 0) return asDate;
  return undefined;
}

function parseJsonAttribute<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getRequesterId(req: Request): string {
  const explicit = String(req.headers["x-client-id"] ?? "").trim();
  if (explicit) return explicit.slice(0, 120);
  const ip = String(req.headers["x-forwarded-for"] ?? req.ip ?? "").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] ?? "");
  return createHash("sha256").update(`${ip}|${ua}`).digest("hex").slice(0, 32);
}

function isOwnerMatch(req: Request, item: Record<string, any> | undefined): boolean {
  if (!item) return false;
  const ownerId = item.ownerId?.S;
  if (!ownerId) return false; // deny access for legacy rows without owner scope
  return ownerId === getRequesterId(req);
}

function shareUrl(req: Request, jobId: string): string {
  if (PUBLIC_SITE_URL) {
    return `${PUBLIC_SITE_URL}/api/translator/share/${encodeURIComponent(jobId)}`;
  }
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const host = forwardedHost || req.get("host");
  const proto = forwardedProto || req.protocol;
  return `${proto}://${host}/api/translator/share/${encodeURIComponent(jobId)}`;
}

const TERMINAL_TRANSLATOR_STATUSES = new Set(["DONE", "FAILED", "CANCELLED", "EXPIRED"]);
const ALLOWED_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "avi", "webm"]);
const ALLOWED_VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  "video/webm",
  "application/octet-stream",
]);

function isTerminalTranslatorStatus(status: string | undefined): boolean {
  return TERMINAL_TRANSLATOR_STATUSES.has(String(status ?? "").toUpperCase());
}

function safeVideoExtension(filename: string): string {
  const raw = String(filename || "input.mp4").split(/[\\/]/).pop() || "input.mp4";
  const ext = raw.includes(".") ? raw.split(".").pop()!.toLowerCase() : "mp4";
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported video file type ".${ext}". Use MP4, MOV, MKV, AVI, or WebM.`);
  }
  return ext;
}

function normalizeContentType(contentType: string | undefined): string {
  return String(contentType || "video/mp4").split(";")[0].trim().toLowerCase() || "video/mp4";
}

function assertAllowedVideoContentType(contentType: string | undefined): string {
  const normalized = normalizeContentType(contentType);
  if (!ALLOWED_VIDEO_CONTENT_TYPES.has(normalized)) {
    throw new Error(`Unsupported video content type "${normalized}".`);
  }
  return normalized;
}

function assertTranslatorInputKey(jobId: string, s3Key: string): void {
  const expectedPrefix = `translator-jobs/${jobId}/input.`;
  if (!s3Key.startsWith(expectedPrefix)) {
    throw new Error("Invalid translator input key for this job.");
  }
  safeVideoExtension(s3Key);
}

async function assertUploadedTranslatorObject(jobId: string, s3Key: string): Promise<void> {
  assertTranslatorInputKey(jobId, s3Key);
  const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
  const size = Number(head.ContentLength ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("Uploaded video is empty or missing.");
  }
  if (size > TRANSLATOR_MAX_VIDEO_SIZE_BYTES) {
    throw new Error(`Video is larger than the ${Math.round(TRANSLATOR_MAX_VIDEO_SIZE_BYTES / 1024 / 1024)}MB upload limit.`);
  }
  assertAllowedVideoContentType(head.ContentType);
}

function assertPublicHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("fileUrl must be an HTTP or HTTPS URL.");
  }
  if (url.username || url.password) {
    throw new Error("fileUrl must not include credentials.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "") {
    throw new Error("fileUrl host is required.");
  }
  if (host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("fileUrl must be a public URL.");
  }
  if (
    host === "[::1]" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    throw new Error("fileUrl must be a public URL.");
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.startsWith("169.254.")
  ) {
    throw new Error("fileUrl must be a public URL.");
  }
  return url;
}

function translatorErrorStatus(error: any): number {
  const message = String(error?.message ?? "");
  if (
    message.startsWith("Unsupported") ||
    message.startsWith("Invalid translator input") ||
    message.startsWith("Video is larger") ||
    message.startsWith("Uploaded video") ||
    message.startsWith("Downloaded video") ||
    message.startsWith("fileUrl must") ||
    message === "Invalid URL"
  ) {
    return 400;
  }
  return 500;
}

async function downloadUrlToTempFile(url: URL, destination: string): Promise<{ bytes: number; contentType: string }> {
  const timeout = AbortSignal.timeout(TRANSLATOR_URL_FETCH_TIMEOUT_MS);
  const maxRedirects = 3;
  let currentUrl = url;
  let downloadRes: Response | undefined;

  for (let i = 0; i <= maxRedirects; i += 1) {
    downloadRes = await fetch(currentUrl, {
      redirect: "manual",
      signal: timeout,
    });
    if (downloadRes.status >= 300 && downloadRes.status < 400) {
      const location = downloadRes.headers.get("location");
      if (!location) {
        throw new Error("Redirect response missing location header.");
      }
      const nextUrl = assertPublicHttpUrl(new URL(location, currentUrl).toString());
      currentUrl = nextUrl;
      continue;
    }
    break;
  }

  if (!downloadRes) {
    throw new Error("Failed to download file from URL.");
  }
  if (downloadRes.status >= 300 && downloadRes.status < 400) {
    throw new Error("Too many redirects while downloading file.");
  }
  if (!downloadRes.ok) {
    throw new Error(`Failed to download file from URL: ${downloadRes.status}`);
  }
  if (!downloadRes.body) {
    throw new Error("Downloaded file response had no body.");
  }

  const contentLength = Number(downloadRes.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > TRANSLATOR_MAX_VIDEO_SIZE_BYTES) {
    throw new Error(`Video is larger than the ${Math.round(TRANSLATOR_MAX_VIDEO_SIZE_BYTES / 1024 / 1024)}MB upload limit.`);
  }

  const contentType = assertAllowedVideoContentType(downloadRes.headers.get("content-type") ?? "video/mp4");
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > TRANSLATOR_MAX_VIDEO_SIZE_BYTES) {
        callback(new Error(`Video is larger than the ${Math.round(TRANSLATOR_MAX_VIDEO_SIZE_BYTES / 1024 / 1024)}MB upload limit.`));
        return;
      }
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(downloadRes.body as any), limit, createWriteStream(destination));
  if (bytes <= 0) {
    throw new Error("Downloaded video is empty.");
  }
  return { bytes, contentType };
}

function isConditionalWriteFailure(error: unknown): boolean {
  const err = error as { name?: string; message?: string } | undefined;
  return (
    err?.name === "ConditionalCheckFailedException" ||
    String(err?.message ?? "").includes("ConditionalCheckFailedException")
  );
}

// Map AWS Batch intermediate states → human-readable step messages shown
// while the GPU instance boots and the Docker image is pulled (~2-4 min with
// custom AMI, ~10-20 min on a cold fresh instance).
const BATCH_PRESTART_STEPS: Record<string, { step: string; progress: number }> = {
  SUBMITTED: { step: "Job submitted to GPU queue…",                              progress: 1  },
  PENDING:   { step: "Waiting for GPU instance to be allocated…",                progress: 2  },
  RUNNABLE:  { step: "GPU instance allocated — waiting to start…",               progress: 3  },
  STARTING:  { step: "GPU instance starting, loading translator image… (2–4 min with warm AMI, up to 20 min cold)", progress: 5  },
};

async function syncTerminalBatchState(item: Record<string, any>): Promise<Record<string, any>> {
  const status = item.status?.S ?? "UNKNOWN";
  const batchJobId = item.batchJobId?.S;
  if (!batchJobId || isTerminalTranslatorStatus(status)) return item;

  const described = await batch.send(new DescribeJobsCommand({ jobs: [batchJobId] }));
  const batchJob = described.jobs?.[0];
  if (!batchJob) return item;

  // ── Pre-start states: update step message so frontend shows real progress
  // instead of "QUEUED 0%" for the entire boot+pull duration.
  // Only update when DDB still says QUEUED (worker hasn't taken over yet).
  const batchStatus = batchJob.status ?? "";
  if (status === "QUEUED" && batchStatus in BATCH_PRESTART_STEPS) {
    const { step, progress } = BATCH_PRESTART_STEPS[batchStatus];
    const currentStep = item.step?.S ?? "";
    // Avoid redundant DDB writes — only update when step message changes
    if (currentStep !== step) {
      const now = String(Date.now());
      await ddb.send(new UpdateItemCommand({
        TableName: DDB_TABLE,
        Key: { jobId: { S: item.jobId.S } },
        UpdateExpression: "SET #st = :st, progress = :p, updatedAt = :ua",
        ExpressionAttributeNames: { "#st": "step" },
        ExpressionAttributeValues: {
          ":st": { S: step },
          ":p":  { N: String(progress) },
          ":ua": { N: now },
        },
      }));
      return { ...item, step: { S: step }, progress: { N: String(progress) }, updatedAt: { N: now } };
    }
    return item;
  }

  // ── Terminal states ───────────────────────────────────────────────────────
  if (!["FAILED", "SUCCEEDED"].includes(batchStatus)) return item;

  // "Trust but verify" — AWS Batch marks a container SUCCEEDED whenever
  // the process exits with code 0.  The NVIDIA base image entrypoint can
  // do exactly that before Python ever starts (driver compatibility check
  // exits 0, Batch says SUCCEEDED, user sees "Complete!" with no output).
  // We verify that output.mp4 actually exists in S3 and has real bytes
  // before accepting SUCCEEDED as DONE.  If the file is missing we override
  // to FAILED with a clear diagnostic message.
  let nextStatus = batchJob.status === "SUCCEEDED" ? "DONE" : "FAILED";

  if (nextStatus === "DONE") {
    const jobId = item.jobId?.S ?? "";
    const outputKey = `translator-jobs/${jobId}/output.mp4`;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: outputKey }));
      const size = Number(head.ContentLength ?? 0);
      if (!Number.isFinite(size) || size < 1024) {
        // File missing (HeadObject would throw) or suspiciously tiny
        nextStatus = "FAILED";
        console.error(
          `[Translator] Job ${jobId} Batch=SUCCEEDED but output.mp4 is ${size} bytes — ` +
          "worker likely exited before producing output (NVIDIA entrypoint or early crash)."
        );
      }
    } catch {
      // HeadObject threw → file does not exist at all
      nextStatus = "FAILED";
      console.error(
        `[Translator] Job ${jobId} Batch=SUCCEEDED but output.mp4 not found in S3 — ` +
        "worker exited with code 0 but never wrote output (NVIDIA entrypoint or early crash)."
      );
    }
  }

  const reason =
    batchJob.statusReason ||
    batchJob.attempts?.find((attempt) => attempt.statusReason)?.statusReason ||
    (nextStatus === "DONE" ? "Translation complete." : "AWS Batch job failed.");
  const step =
    nextStatus === "DONE"
      ? "Translation complete!"
      : nextStatus === "FAILED" && reason === "Translation complete."
        ? "Worker exited successfully but produced no output — the process likely crashed before starting. Please retry."
        : reason === "Job attempt duration exceeded timeout"
          ? `Translation stopped after the ${Math.round(TRANSLATOR_BATCH_TIMEOUT_SECONDS / 60)} minute limit.`
          : reason;
  const progress = nextStatus === "DONE" ? "100" : item.progress?.N ?? "0";
  const now = String(Date.now());

  await ddb.send(new UpdateItemCommand({
    TableName: DDB_TABLE,
    Key: { jobId: { S: item.jobId.S } },
    UpdateExpression: "SET #status = :status, progress = :progress, step = :step, #error = :error, updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#status": "status",
      "#error": "error",
    },
    ExpressionAttributeValues: {
      ":status": { S: nextStatus },
      ":progress": { N: progress },
      ":step": { S: step },
      ":error": { S: nextStatus === "DONE" ? "" : step },
      ":updatedAt": { N: now },
    },
  }));

  return {
    ...item,
    status: { S: nextStatus },
    progress: { N: progress },
    step: { S: step },
    error: { S: nextStatus === "DONE" ? "" : step },
    updatedAt: { N: now },
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type TranslatorOptions = {
  targetLang: string;
  targetLangCode: string;
  sourceLang: string;
  voiceClone: boolean;
  lipSync: boolean;
  lipSyncQuality: string;
  useDemucs: boolean;
  premiumAsr: boolean;
  multiSpeaker: boolean;
  asrModel: string;
  translationMode: string;
  dynamicVideoLength: boolean;
  preserveChants: boolean;
  filename: string;
};

type FastSegment = {
  startMs: number;
  endMs: number;
  text: string;
  translatedText?: string;
};

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

function authEmailFromResponse(res: ExpressResponse): string | undefined {
  const session = res.locals.authSession as { email?: unknown } | undefined;
  return typeof session?.email === "string" ? session.email : undefined;
}

function resolveRequestedLipSync(req: Request, res: ExpressResponse, value: unknown): {
  enabled: boolean;
  warning?: string;
} {
  const requested = boolValue(value, false);
  if (!requested) return { enabled: false };
  if (canUseTranslatorLipSync(authEmailFromResponse(res))) return { enabled: true };
  const isInternal = req.headers["x-internal-agent"] === (process.env.INTERNAL_AGENT_SECRET ?? "internal-agent-bypass-key");
  return {
    enabled: false,
    warning: isInternal
      ? "Lip sync is disabled for internal agent requests until an approved user starts the job."
      : "Lip sync is currently limited to approved users. The job will run without lip sync.",
  };
}

function isCpuBatchCandidate(options: TranslatorOptions): boolean {
  // Neural Voice jobs (no GPU): edge-tts dubbing on Fargate CPU.
  // Requires TRANSLATOR_CPU_BATCH_JOB_QUEUE + TRANSLATOR_CPU_BATCH_JOB_DEFINITION.
  // Falls back to GPU queue when CPU queue not configured (safe degradation).
  //
  // NOTE: subtitle-only must NOT route here. The Python worker ignores
  // TRANSLATION_MODE and would run the full edge-tts dubbing pipeline anyway,
  // so a user who picked "Subtitles Only" would still get an audible dubbed
  // track. Subtitle-only goes through the Lambda fast path which actually
  // honours the mode and emits only SRT + transcript.
  return (
    !options.voiceClone &&
    !options.lipSync &&
    options.translationMode !== "subtitle-only" &&
    Boolean(CPU_BATCH_QUEUE) &&
    Boolean(CPU_BATCH_JOB_DEF)
  );
}

function isLambdaFastCandidate(options: TranslatorOptions): boolean {
  // Lambda subtitle-only path: only used when CPU Batch queue is not configured.
  // When CPU queue IS configured, Neural Voice jobs go there for actual dubbing.
  if (isCpuBatchCandidate(options)) return false;
  if (!TRANSLATOR_LAMBDA_FAST_ENABLED) return false;
  if (options.translationMode !== "subtitle-only") return false;
  return (
    !options.voiceClone &&
    !options.lipSync &&
    !options.useDemucs &&
    !options.multiSpeaker
  );
}

async function updateTranslatorJob(
  jobId: string,
  status: string,
  progress: number,
  step: string,
  extra: Record<string, any> = {},
): Promise<void> {
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, any> = {
    ":status": { S: status },
    ":progress": { N: String(progress) },
    ":step": { S: step },
    ":updatedAt": { N: String(Date.now()) },
  };
  const sets = ["#status = :status", "progress = :progress", "step = :step", "updatedAt = :updatedAt"];

  for (const [key, rawValue] of Object.entries(extra)) {
    const name = `#${key}`;
    const value = `:${key}`;
    names[name] = key;
    if (typeof rawValue === "boolean") values[value] = { BOOL: rawValue };
    else if (typeof rawValue === "number") values[value] = { N: String(rawValue) };
    else values[value] = { S: String(rawValue ?? "") };
    sets.push(`${name} = ${value}`);
  }

  await ddb.send(new UpdateItemCommand({
    TableName: DDB_TABLE,
    Key: { jobId: { S: jobId } },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function markTranslatorFailed(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await updateTranslatorJob(jobId, "FAILED", 0, message, { error: message });
}

function buildBatchEnvironment(jobId: string, s3Key: string, options: TranslatorOptions) {
  return [
    { name: "JOB_ID",            value: jobId },
    { name: "S3_BUCKET",         value: S3_BUCKET },
    { name: "S3_INPUT_KEY",      value: s3Key },
    { name: "S3_OUTPUT_PREFIX",  value: `translator-jobs/${jobId}` },
    { name: "DYNAMODB_TABLE",    value: DDB_TABLE },
    { name: "DYNAMODB_REGION",   value: REGION },
    { name: "GEMINI_API_KEY",    value: GEMINI_KEY },
    { name: "GEMINI_API_KEY_2",  value: GEMINI_KEY_2 },
    { name: "GEMINI_API_KEY_3",  value: GEMINI_KEY_3 },
    ...VERTEX_ENV_NAMES.map((name) => ({ name, value: process.env[name] ?? "" })),
    { name: "TARGET_LANG",       value: options.targetLang },
    { name: "TARGET_LANG_CODE",  value: options.targetLangCode },
    { name: "SOURCE_LANG",       value: options.sourceLang },
    { name: "VOICE_CLONE",       value: String(options.voiceClone) },
    { name: "LIP_SYNC",          value: String(options.lipSync) },
    { name: "LIP_SYNC_QUALITY",  value: options.lipSyncQuality },
    { name: "PREMIUM_ASR",       value: String(options.premiumAsr) },
    { name: "ASR_MODEL",         value: options.asrModel },
    { name: "TRANSLATION_MODE",  value: options.translationMode },
    // Dynamic Video Length (advanced): worker keeps the voice at natural speed
    // and grows the output video instead of speeding up the dub.
    { name: "DYNAMIC_VIDEO_LENGTH", value: String(options.dynamicVideoLength) },
    // Preserve devotional content (bhajans/kirtan/shlokas) in the original
    // audio instead of translating it.
    { name: "PRESERVE_CHANTS", value: String(options.preserveChants) },
    // Allow overriding the exact Gemini model ID used for translation via Lambda env.
    // Defaults to gemini-3.5-flash in the worker when blank.
    { name: "TRANSLATION_MODEL", value: process.env.TRANSLATION_MODEL ?? "" },
    // CosyVoice3 model ID — passed explicitly so no job uses an old baked-in default.
    { name: "COSYVOICE_MODEL_ID", value: process.env.TRANSLATOR_COSYVOICE_MODEL_ID ?? "FunAudioLLM/Fun-CosyVoice3-0.5B-2512" },
    { name: "ASSEMBLYAI_API_KEY", value: ASSEMBLYAI_KEY },
    { name: "MODEL_CACHE_DIR",   value: "/model-cache" },
    { name: "ALLOW_VOICE_CLONE_FALLBACK", value: process.env.TRANSLATOR_ALLOW_VOICE_CLONE_FALLBACK ?? "true" },
    { name: "ALLOW_LIP_SYNC_FALLBACK",    value: process.env.TRANSLATOR_ALLOW_LIP_SYNC_FALLBACK    ?? "false" },
    { name: "ALLOW_RUNTIME_MODEL_DOWNLOADS", value: TRANSLATOR_ALLOW_RUNTIME_MODEL_DOWNLOADS },
    // Preserve the explicit frontend/API toggles. Forcing these on for every
    // voice-clone job makes short single-speaker clips pay the Demucs and
    // diarization cost even when the user disabled those quality-heavy paths.
    { name: "USE_DEMUCS",    value: String(options.useDemucs) },
    { name: "MULTI_SPEAKER", value: String(options.multiSpeaker) },
  ];
}

async function submitTranslatorBatchJob(
  jobId: string,
  s3Key: string,
  options: TranslatorOptions,
  useCpuQueue = false,
  durationSeconds?: number,
): Promise<string> {
  const useFastGpuQueue = !useCpuQueue && options.lipSync && Boolean(BATCH_QUEUE_FAST);
  const queue   = useCpuQueue ? CPU_BATCH_QUEUE   : (useFastGpuQueue ? BATCH_QUEUE_FAST : BATCH_QUEUE);
  const jobDef  = useCpuQueue ? CPU_BATCH_JOB_DEF : BATCH_JOB_DEF;
  const runtime = useCpuQueue ? "batch-cpu"       : (useFastGpuQueue ? "batch-lipsync" : "batch");

  // Phase 5 (P2-3): Dynamic Batch timeout based on video duration.
  // Formula: max(configured cold-start floor, source_duration × 6).
  // CosyVoice cold start can exceed 15 min even for short videos, so the floor
  // must be the configured fallback timeout rather than a hard-coded 900s.
  // Unknown duration also uses the same bounded fallback.
  const cpuTimeout = 1800;
  let gpuTimeout = TRANSLATOR_BATCH_FALLBACK_TIMEOUT_SECONDS;
  if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    gpuTimeout = Math.max(TRANSLATOR_BATCH_FALLBACK_TIMEOUT_SECONDS, Math.round(durationSeconds * 6));
    // Never exceed the env-var configured maximum (safety cap)
    gpuTimeout = Math.min(gpuTimeout, TRANSLATOR_BATCH_TIMEOUT_SECONDS);
  }
  const timeout = useCpuQueue ? cpuTimeout : gpuTimeout;

  const batchResult = await batch.send(new SubmitJobCommand({
    jobName:       `translator-${useCpuQueue ? "cpu-" : ""}${jobId.slice(0, 8)}`,
    jobQueue:      queue,
    jobDefinition: jobDef,
    timeout:       { attemptDurationSeconds: timeout },
    containerOverrides: { environment: buildBatchEnvironment(jobId, s3Key, options) },
  }));

  await ddb.send(new UpdateItemCommand({
    TableName: DDB_TABLE,
    Key: { jobId: { S: jobId } },
    UpdateExpression: "SET batchJobId = :batchJobId, timeoutSeconds = :timeoutSeconds, runtime = :runtime, updatedAt = :updatedAt",
    ExpressionAttributeValues: {
      ":batchJobId":      { S: String(batchResult.jobId) },
      ":timeoutSeconds":  { N: String(timeout) },
      ":runtime":         { S: runtime },
      ":updatedAt":       { N: String(Date.now()) },
    },
  }));

  console.log(`[Translator] Submitted ${runtime} Batch job ${batchResult.jobId} for translator job ${jobId}`);
  return String(batchResult.jobId);
}

// ── Bulk: one GPU Batch job that translates many videos in a single session ────
// The worker loads CosyVoice/LatentSync once and loops the manifest, so the
// model-load + GPU cold start is paid once for the whole batch instead of N×.
const MAX_BULK_VIDEOS = Number(process.env.TRANSLATOR_MAX_BULK_VIDEOS ?? "10");
const BULK_PER_VIDEO_SECONDS = Number(process.env.TRANSLATOR_BULK_PER_VIDEO_SECONDS ?? "1200");
const BULK_MAX_TIMEOUT_SECONDS = Number(process.env.TRANSLATOR_BULK_MAX_TIMEOUT_SECONDS ?? "21600");

async function submitBulkTranslatorBatchJob(
  groupId: string,
  manifestKey: string,
  options: TranslatorOptions,
  videoCount: number,
): Promise<string> {
  // Bulk always runs on the GPU queue — the whole point is to share one warm
  // GPU + loaded models across every video. Reuse the per-job env builder with
  // empty job/input (the worker reads BULK_MANIFEST_KEY and ignores them) and
  // append the manifest pointer.
  const environment = [
    ...buildBatchEnvironment("", "", options),
    { name: "BULK_MANIFEST_KEY", value: manifestKey },
  ];

  // Timeout scales with the batch size: a cold-start floor + per-video budget,
  // capped so a runaway batch can't hold a GPU indefinitely.
  const timeout = Math.min(
    BULK_MAX_TIMEOUT_SECONDS,
    Math.max(TRANSLATOR_BATCH_FALLBACK_TIMEOUT_SECONDS, videoCount * BULK_PER_VIDEO_SECONDS),
  );

  const batchResult = await batch.send(new SubmitJobCommand({
    jobName:       `translator-bulk-${groupId.slice(0, 8)}`,
    jobQueue:      BATCH_QUEUE,
    jobDefinition: BATCH_JOB_DEF,
    timeout:       { attemptDurationSeconds: timeout },
    containerOverrides: { environment },
  }));

  console.log(`[Translator] Submitted BULK Batch job ${batchResult.jobId} (group ${groupId}, ${videoCount} videos, timeout ${timeout}s)`);
  return String(batchResult.jobId);
}

function runCommand(command: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

async function downloadS3ObjectToFile(key: string, filePath: string, abortSignal?: AbortSignal): Promise<void> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    abortSignal ? { abortSignal } : undefined,
  );
  if (!result.Body) throw new Error("Input object has no body");
  await mkdir(dirname(filePath), { recursive: true });
  if (abortSignal?.aborted) throw new Error("S3 download aborted");
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(filePath));
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  try {
    const { stdout } = await runCommand(FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], 10_000);
    const duration = Number(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch (error) {
    console.warn("[Translator] ffprobe duration probe failed; trying ffmpeg metadata", error);
  }

  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${FFMPEG_BIN} metadata probe timed out`));
    }, 10_000);
    child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error("Could not read video duration");
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function extractAudioForTranscription(inputPath: string, outputPath: string): Promise<void> {
  await runCommand(FFMPEG_BIN, [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputPath,
  ], 180_000);
}

async function remuxToMp4(inputPath: string, outputPath: string): Promise<void> {
  try {
    await runCommand(FFMPEG_BIN, [
      "-y",
      "-i", inputPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ], 180_000);
  } catch {
    await runCommand(FFMPEG_BIN, [
      "-y",
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outputPath,
    ], 480_000);
  }
}

function msToSrt(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const x = Math.floor(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(x).padStart(3, "0")}`;
}

function wordsToSegments(words: Array<{ start?: number; end?: number; text?: string }>): FastSegment[] {
  const segments: FastSegment[] = [];
  let current: FastSegment | null = null;
  const MAX_WORDS_PER_SEGMENT = 6;
  const MAX_MS_PER_SEGMENT = 5000;
  const GAP_BREAK_MS = 850;
  const TERMINAL_PUNCTUATION = /[.!?।！？]$/u;
  for (const word of words) {
    const text = String(word.text ?? "").trim();
    const start = Number(word.start);
    const end = Number(word.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const previousEndsSentence = current ? TERMINAL_PUNCTUATION.test(current.text.trim()) : false;
    const shouldStart =
      !current ||
      previousEndsSentence ||
      current.text.split(/\s+/).length >= MAX_WORDS_PER_SEGMENT ||
      start - current.startMs >= MAX_MS_PER_SEGMENT ||
      start - current.endMs > GAP_BREAK_MS;
    if (shouldStart) {
      current = { startMs: start, endMs: end, text };
      segments.push(current);
    } else if (current) {
      current.endMs = end;
      current.text += ` ${text}`;
    }
  }
  return segments;
}

function segmentsToSrt(segments: FastSegment[]): string {
  return segments
    .map((seg, index) => `${index + 1}\n${msToSrt(seg.startMs)} --> ${msToSrt(seg.endMs)}\n${seg.translatedText || seg.text}`)
    .join("\n\n") + "\n";
}

function targetScriptInstruction(targetLang: string): string {
  const normalized = targetLang.trim().toLowerCase();
  const scriptRules: Array<[RegExp, string]> = [
    [/^(hi|hindi|mr|marathi|sa|sanskrit|ne|nepali)\b/, "Use native Devanagari script only. Do not romanize; do not output Hinglish."],
    [/^(or|odia|oriya)\b/, "Use native Odia script only. Do not romanize."],
    [/^(bn|bengali|bangla)\b/, "Use native Bengali script only. Do not romanize."],
    [/^(pa|punjabi)\b/, "Use native Gurmukhi script only. Do not romanize."],
    [/^(gu|gujarati)\b/, "Use native Gujarati script only. Do not romanize."],
    [/^(ta|tamil)\b/, "Use native Tamil script only. Do not romanize."],
    [/^(te|telugu)\b/, "Use native Telugu script only. Do not romanize."],
    [/^(kn|kannada)\b/, "Use native Kannada script only. Do not romanize."],
    [/^(ml|malayalam)\b/, "Use native Malayalam script only. Do not romanize."],
    [/^(ar|arabic|ur|urdu)\b/, "Use the language's native Arabic-derived script only. Do not romanize."],
    [/^(ja|japanese)\b/, "Use natural Japanese writing with kana/kanji. Do not romanize."],
    [/^(ko|korean)\b/, "Use Hangul. Do not romanize."],
    [/^(zh|chinese|mandarin|cantonese)\b/, "Use Chinese characters. Do not romanize."],
    [/^(ru|russian|uk|ukrainian)\b/, "Use Cyrillic script. Do not romanize."],
  ];
  for (const [pattern, instruction] of scriptRules) {
    if (pattern.test(normalized)) return instruction;
  }
  return "Use the normal native writing system for the target language. Do not romanize unless that language is normally written in Latin script.";
}

function toAssemblyLanguageCode(language: string): string | undefined {
  const normalized = language.trim().toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  if (/^[a-z]{2,3}(-[a-z]{2})?$/i.test(normalized)) return normalized;
  const map: Record<string, string> = {
    english: "en",
    hindi: "hi",
    spanish: "es",
    french: "fr",
    german: "de",
    portuguese: "pt",
    italian: "it",
    japanese: "ja",
    korean: "ko",
    chinese: "zh",
    mandarin: "zh",
    cantonese: "zh",
    arabic: "ar",
    russian: "ru",
    dutch: "nl",
    turkish: "tr",
    polish: "pl",
    swedish: "sv",
    ukrainian: "uk",
    bengali: "bn",
    gujarati: "gu",
    marathi: "mr",
    indonesian: "id",
    vietnamese: "vi",
    filipino: "fil",
    finnish: "fi",
    tamil: "ta",
    telugu: "te",
    punjabi: "pa",
  };
  return map[normalized];
}

async function transcribeFastAudio(audioPath: string, sourceLang: string): Promise<FastSegment[]> {
  if (!ASSEMBLYAI_KEY) throw new Error("ASSEMBLYAI_API_KEY is not configured");
  const { request } = await import("https");

  const uploadUrl = await new Promise<string>((resolve, reject) => {
    const req = request({
      hostname: "api.assemblyai.com",
      path: "/v2/upload",
      method: "POST",
      headers: { authorization: ASSEMBLYAI_KEY, "content-type": "application/octet-stream" },
    }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.upload_url) resolve(json.upload_url);
          else reject(new Error(json.error || `AssemblyAI upload failed (${res.statusCode})`));
        } catch {
          reject(new Error("AssemblyAI upload returned invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    createReadStream(audioPath).pipe(req);
  });

  const sourceLangCode = toAssemblyLanguageCode(sourceLang);
  const payload = JSON.stringify({
    audio_url: uploadUrl,
    language_detection: !sourceLangCode,
    ...(sourceLangCode ? { language_code: sourceLangCode } : {}),
    punctuate: true,
    format_text: true,
  });

  const transcriptId = await new Promise<string>((resolve, reject) => {
    const req = request({
      hostname: "api.assemblyai.com",
      path: "/v2/transcript",
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_KEY,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.id) resolve(json.id);
          else reject(new Error(json.error || `AssemblyAI transcript submit failed (${res.statusCode})`));
        } catch {
          reject(new Error("AssemblyAI transcript submit returned invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  for (let i = 0; i < 160; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = await new Promise<any>((resolve, reject) => {
      const req = request({
        hostname: "api.assemblyai.com",
        path: `/v2/transcript/${transcriptId}`,
        method: "GET",
        headers: { authorization: ASSEMBLYAI_KEY },
      }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("AssemblyAI poll returned invalid JSON")); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (result.status === "completed") {
      const segments = wordsToSegments(Array.isArray(result.words) ? result.words : []);
      if (!segments.length) throw new Error("AssemblyAI returned no timed words");
      return segments;
    }
    if (result.status === "error") throw new Error(result.error || "AssemblyAI transcription failed");
  }

  throw new Error("AssemblyAI transcription timed out");
}

async function transcribeFastMediaUrl(mediaUrl: string, sourceLang: string): Promise<{ segments: FastSegment[]; durationSeconds: number }> {
  if (!ASSEMBLYAI_KEY) throw new Error("ASSEMBLYAI_API_KEY is not configured");
  const { request } = await import("https");
  const sourceLangCode = toAssemblyLanguageCode(sourceLang);
  const payload = JSON.stringify({
    audio_url: mediaUrl,
    language_detection: !sourceLangCode,
    ...(sourceLangCode ? { language_code: sourceLangCode } : {}),
    punctuate: true,
    format_text: true,
  });

  const transcriptId = await new Promise<string>((resolve, reject) => {
    const req = request({
      hostname: "api.assemblyai.com",
      path: "/v2/transcript",
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_KEY,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.id) resolve(json.id);
          else reject(new Error(json.error || `AssemblyAI transcript submit failed (${res.statusCode})`));
        } catch {
          reject(new Error("AssemblyAI transcript submit returned invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  for (let i = 0; i < 160; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = await new Promise<any>((resolve, reject) => {
      const req = request({
        hostname: "api.assemblyai.com",
        path: `/v2/transcript/${transcriptId}`,
        method: "GET",
        headers: { authorization: ASSEMBLYAI_KEY },
      }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("AssemblyAI poll returned invalid JSON")); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (result.status === "completed") {
      const segments = wordsToSegments(Array.isArray(result.words) ? result.words : []);
      if (!segments.length) throw new Error("AssemblyAI returned no timed words");
      return { segments, durationSeconds: Number(result.audio_duration ?? 0) || 0 };
    }
    if (result.status === "error") throw new Error(result.error || "AssemblyAI transcription failed");
  }

  throw new Error("AssemblyAI transcription timed out");
}

async function translateSegmentsFast(segments: FastSegment[], targetLang: string): Promise<FastSegment[]> {
  if (!isGeminiConfigured()) throw new Error("Gemini is not configured. Add Vertex Gemini env or GEMINI_API_KEY.");
  const ai = createGeminiClient();
  const payload = segments.map((seg, i) => {
    const durationSec = Math.max(0.2, (seg.endMs - seg.startMs) / 1000);
    const maxChars = Math.max(8, Math.ceil(durationSec * 15));
    return {
      id: i + 1,
      text: seg.text,
      duration_sec: Number(durationSec.toFixed(2)),
      max_chars: maxChars,
      prev_text: segments[i - 1]?.text ?? "",
      next_text: segments[i + 1]?.text ?? "",
    };
  });
  const prompt = [
    `Translate each item to ${targetLang}.`,
    targetScriptInstruction(targetLang),
    "Translate meaning, tone, and intent like a skilled dubbing interpreter, not word-for-word.",
    "Keep each line natural, concise, and speakable in the target language.",
    "Each translated line MUST fit its time slot and stay within max_chars.",
    "If needed, rewrite shorter while preserving intent and tone.",
    "Use prev_text and next_text ONLY as context. Do not translate them or include them in the output.",
    "Return ONLY a JSON array with objects: {\"id\": number, \"text\": string}.",
    "Do not add explanations, labels, transliteration, source text, or commentary.",
    JSON.stringify(payload),
  ].join("\n");

  const resp = await ai.models.generateContent({
    model: TRANSLATOR_TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 8192 },
  } as any);
  const text = (resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  let parsed: Array<{ id: number; text: string }>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Gemini returned invalid translation JSON");
  }
  const byId = new Map(parsed.map((item) => [Number(item.id), String(item.text ?? "").trim()]));
  return segments.map((seg, i) => ({ ...seg, translatedText: byId.get(i + 1) || seg.text }));
}

async function processLambdaFastTranslation(jobId: string, s3Key: string, options: TranslatorOptions): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), `translator-${jobId}-`));
  let handedToBatch = false;
  try {
    await updateTranslatorJob(jobId, "STARTING", 3, "Starting fast Lambda translation...", { runtime: "lambda-fast" });
    const srtPath = join(workDir, "subtitles.srt");
    const transcriptPath = join(workDir, "transcript.json");

    await updateTranslatorJob(jobId, "TRANSCRIBING", 18, "Transcribing speech from cloud video...");
    const mediaUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }), { expiresIn: 3600 });
    const { segments, durationSeconds } = await transcribeFastMediaUrl(mediaUrl, options.sourceLang);
    if (durationSeconds > TRANSLATOR_LAMBDA_FAST_MAX_SECONDS) {
      await updateTranslatorJob(jobId, "QUEUED", 0, "Video is over the fast subtitle limit; starting GPU worker...", {
        runtime: "batch",
        durationSeconds: Math.round(durationSeconds),
      });
      await submitTranslatorBatchJob(jobId, s3Key, options, false, durationSeconds);
      return;
    }

    await updateTranslatorJob(jobId, "TRANSLATING", 55, `Translating subtitles to ${options.targetLang}...`, {
      segmentCount: segments.length,
      durationSeconds: Math.round(durationSeconds),
    });
    const translated = await translateSegmentsFast(segments, options.targetLang);
    await writeFile(srtPath, segmentsToSrt(translated), "utf8");
    // Normalise to the canonical worker.py transcript schema so every
    // consumer (TranscriptPanel, analytics, future SDKs) sees the same shape
    // regardless of which runtime produced the job.
    // Worker schema:  { id, start (sec), end (sec), originalText, translatedText }
    // Lambda-fast raw: { startMs (ms), endMs (ms), text, translatedText }
    const canonicalSegments = translated.map((seg, idx) => ({
      id: idx + 1,
      start: seg.startMs / 1000,
      end: seg.endMs / 1000,
      originalText: seg.text,
      translatedText: seg.translatedText ?? seg.text,
    }));
    await writeFile(transcriptPath, JSON.stringify({
      jobId,
      mode: "lambda-fast-subtitle-translation",
      targetLang: options.targetLang,
      durationSeconds,
      segments: canonicalSegments,
    }, null, 2), "utf8");

    const prefix = `translator-jobs/${jobId}`;
    await updateTranslatorJob(jobId, "UPLOADING", 93, "Uploading translation results...");
    await Promise.all([
      s3.send(new CopyObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${prefix}/output.mp4`,
        CopySource: `${S3_BUCKET}/${encodeURIComponent(s3Key).replace(/%2F/g, "/")}`,
        MetadataDirective: "REPLACE",
        ContentType: "video/mp4",
      })),
      s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${prefix}/subtitles.srt`,
        Body: await readFile(srtPath),
        ContentType: "application/x-subrip; charset=utf-8",
      })),
      s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${prefix}/transcript.json`,
        Body: await readFile(transcriptPath),
        ContentType: "application/json; charset=utf-8",
      })),
    ]);

    await updateTranslatorJob(jobId, "DONE", 100, "Fast subtitle translation complete.", {
      outputKey: `${prefix}/output.mp4`,
      srtKey: `${prefix}/subtitles.srt`,
      transcriptKey: `${prefix}/transcript.json`,
      voiceCloneApplied: false,
      lipSyncApplied: false,
      runtime: "lambda-fast",
    });
  } catch (error) {
    console.error(`[Translator] Lambda fast path failed for ${jobId}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    try {
      await updateTranslatorJob(jobId, "QUEUED", 0, `Fast Lambda path unavailable (${message.slice(0, 160)}); starting GPU worker...`, {
        runtime: "batch",
        lambdaFastError: message,
      });
      await submitTranslatorBatchJob(jobId, s3Key, options);
      handedToBatch = true;
    } catch (batchError) {
      await markTranslatorFailed(jobId, batchError);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (handedToBatch) {
      console.log(`[Translator] Lambda fast path handed ${jobId} to Batch fallback`);
    }
  }
}

const PROBE_S3_VIDEO_DURATION_TIMEOUT_MS = 15_000;

async function probeS3VideoDuration(s3Key: string): Promise<number | undefined> {
  // Best-effort: download the video to a temp file, probe duration via ffprobe,
  // then clean up. If it fails or the full download+probe workflow takes longer
  // than 15s, return undefined so the caller falls back to the static timeout.
  // This keeps the submit endpoint responsive even for large or slow uploads.
  const tmpPath = join(tmpdir(), `probe-${randomUUID()}.mp4`);
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  const abortController = new AbortController();

  const probePromise = (async (): Promise<number> => {
    await downloadS3ObjectToFile(s3Key, tmpPath, abortController.signal);
    return probeDurationSeconds(tmpPath);
  })();

  try {
    const duration = await Promise.race<number | undefined>([
      probePromise,
      new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          abortController.abort();
          resolve(undefined);
        }, PROBE_S3_VIDEO_DURATION_TIMEOUT_MS);
      }),
    ]);

    if (timedOut) {
      console.warn(
        `[Translator] Duration probe timed out after ${PROBE_S3_VIDEO_DURATION_TIMEOUT_MS}ms (non-blocking)`
      );
      return undefined;
    }

    return duration;
  } catch (err) {
    console.warn("[Translator] Duration probe failed (non-blocking):", err);
    return undefined;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    void probePromise
      .catch((err) => {
        if (timedOut) {
          console.warn("[Translator] Timed-out duration probe stopped with error:", err);
        }
      })
      .finally(() => {
        rm(tmpPath, { force: true }).catch(() => {});
      });
  }
}

async function createTranslatorJobRecord(jobId: string, s3Key: string, options: TranslatorOptions, ownerId: string): Promise<void> {
  const now = Date.now();
  await ddb.send(new PutItemCommand({
    TableName: DDB_TABLE,
    ConditionExpression: "attribute_not_exists(jobId)",
    Item: {
      jobId:       { S: jobId },
      type:        { S: "translator" },
      status:      { S: "QUEUED" },
      progress:    { N: "0" },
      step:        { S: isLambdaFastCandidate(options) ? "Queued for fast Lambda translation..." : "Job queued, waiting for worker..." },
      s3InputKey:  { S: s3Key },
      filename:    { S: options.filename },
      targetLang:  { S: options.targetLang },
      targetLangCode: { S: options.targetLangCode },
      sourceLang:  { S: options.sourceLang },
      ownerId:     { S: ownerId },
      voiceClone:  { BOOL: options.voiceClone },
      lipSync:     { BOOL: options.lipSync },
      useDemucs:   { BOOL: options.useDemucs },
      multiSpeaker: { BOOL: options.multiSpeaker },
      dynamicVideoLength: { BOOL: options.dynamicVideoLength },
      preserveChants: { BOOL: options.preserveChants },
      runtime:     { S: isLambdaFastCandidate(options) ? "lambda-fast" : "batch" },
      createdAt:   { N: String(now) },
      updatedAt:   { N: String(now) },
    },
  }));
}

async function startTranslatorJob(jobId: string, s3Key: string, options: TranslatorOptions): Promise<{ runtime: string; batchJobId?: string }> {
  // Neural Voice (no GPU): route to CPU Fargate Batch queue for actual edge-tts dubbing.
  // The CPU worker runs worker.py with VOICE_CLONE=false — uses edge-tts, no CosyVoice.
  // Starts in ~30 seconds (Fargate), no cold start, 10× cheaper than GPU.
  if (isCpuBatchCandidate(options)) {
    const batchJobId = await submitTranslatorBatchJob(jobId, s3Key, options, true);
    return { runtime: "batch-cpu", batchJobId };
  }

  // Subtitle-only Lambda fast path (fallback when CPU Batch not configured)
  if (isLambdaFastCandidate(options)) {
    void processLambdaFastTranslation(jobId, s3Key, options);
    return { runtime: "lambda-fast" };
  }

  // Clone Voice: GPU Batch queue.
  // Probe video duration so we can compute a dynamic Batch timeout (P2-3).
  // This is best-effort: if the probe fails we fall back to the static max.
  const durationSeconds = await probeS3VideoDuration(s3Key);
  const batchJobId = await submitTranslatorBatchJob(jobId, s3Key, options, false, durationSeconds);
  return { runtime: "batch", batchJobId };
}

// ── GET /presign ──────────────────────────────────────────────────────────────
// Returns an S3 presigned PUT URL so the browser can upload directly to S3.
router.get("/presign", async (req: Request, res: ExpressResponse) => {
  try {
    const { filename = "input.mp4", contentType = "video/mp4" } = req.query as Record<string, string>;
    const ext = safeVideoExtension(filename);
    const normalizedContentType = assertAllowedVideoContentType(contentType);
    const jobId = randomUUID();
    const s3Key = `translator-jobs/${jobId}/input.${ext}`;

    const command = new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         s3Key,
      ContentType: normalizedContentType,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return res.json({ jobId, presignedUrl, s3Key });
  } catch (err: any) {
    console.error("[Translator] /presign error:", err);
    return res.status(translatorErrorStatus(err)).json({ error: err.message });
  }
});

// ── POST /submit ──────────────────────────────────────────────────────────────
// Creates a DynamoDB job record and submits an AWS Batch GPU job.
router.post("/submit", async (req: Request, res: ExpressResponse) => {
  try {
    const ownerId = getRequesterId(req);
    const {
      jobId,
      s3Key,
      targetLang     = "Hindi",
      targetLangCode = "hi",
      sourceLang     = "auto",
      voiceClone     = true,
      lipSync        = false,
      lipSyncQuality = "latentsync",
      useDemucs      = false,
      premiumAsr     = false,
      multiSpeaker   = false,
      asrModel       = "large-v3-turbo",
      translationMode = "default",
      dynamicVideoLength = false,
      preserveChants = true,
      filename,
    } = req.body;

    if (!jobId || !s3Key) {
      return res.status(400).json({ error: "jobId and s3Key are required" });
    }
    await assertUploadedTranslatorObject(String(jobId), String(s3Key));

    const resolvedLipSync = resolveRequestedLipSync(req, res, lipSync);
    const options: TranslatorOptions = {
      targetLang: String(targetLang),
      targetLangCode: String(targetLangCode),
      sourceLang: String(sourceLang),
      voiceClone: boolValue(voiceClone, true),
      lipSync: resolvedLipSync.enabled,
      lipSyncQuality: String(lipSyncQuality),
      useDemucs: boolValue(useDemucs, false),
      premiumAsr: boolValue(premiumAsr, false),
      multiSpeaker: boolValue(multiSpeaker, false),
      asrModel: String(asrModel),
      translationMode: String(translationMode),
      dynamicVideoLength: boolValue(dynamicVideoLength, false),
      preserveChants: boolValue(preserveChants, true),
      filename: typeof filename === "string" && filename.trim() ? filename.trim() : "video.mp4",
    };

    await createTranslatorJobRecord(jobId, s3Key, options, ownerId);

    const started = await startTranslatorJob(jobId, s3Key, options);
    return res.json({ jobId, batchJobId: started.batchJobId, runtime: started.runtime, status: "QUEUED", lipsyncWarning: resolvedLipSync.warning });
  } catch (err: any) {
    console.error("[Translator] /submit error:", err);
    if (isConditionalWriteFailure(err)) {
      return res.status(409).json({ error: "A translation job with this jobId already exists." });
    }
    return res.status(translatorErrorStatus(err)).json({ error: err.message });
  }
});

// ── POST /submit-from-url ──────────────────────────────────────────────────────
// Accepts a public file URL (e.g., S3 presigned URL from the uploads API).
// Downloads the file, copies it to the translator-jobs S3 prefix, then submits.
// This is the path used when a user uploads a video directly in the agent chat.
router.post("/submit-from-url", async (req: Request, res: ExpressResponse) => {
  try {
    const ownerId = getRequesterId(req);
    const {
      fileUrl,
      targetLang     = "Hindi",
      targetLangCode = "hi",
      sourceLang     = "auto",
      voiceClone     = true,
      lipSync        = false,
      lipSyncQuality = "latentsync",
      useDemucs      = false,
      premiumAsr     = false,
      multiSpeaker   = false,
      asrModel       = "large-v3-turbo",
      translationMode = "default",
      dynamicVideoLength = false,
      preserveChants = true,
      filename       = "uploaded-video.mp4",
    } = req.body;

    if (!fileUrl) {
      return res.status(400).json({ error: "fileUrl is required" });
    }

    const jobId = randomUUID();
    const sourceUrl = assertPublicHttpUrl(String(fileUrl));
    const ext = safeVideoExtension(String(filename || "uploaded-video.mp4"));
    const s3Key = `translator-jobs/${jobId}/input.${ext}`;
    const resolvedLipSync = resolveRequestedLipSync(req, res, lipSync);
    const options: TranslatorOptions = {
      targetLang: String(targetLang),
      targetLangCode: String(targetLangCode),
      sourceLang: String(sourceLang),
      voiceClone: boolValue(voiceClone, true),
      lipSync: resolvedLipSync.enabled,
      lipSyncQuality: String(lipSyncQuality),
      useDemucs: boolValue(useDemucs, false),
      premiumAsr: boolValue(premiumAsr, false),
      multiSpeaker: boolValue(multiSpeaker, false),
      asrModel: String(asrModel),
      translationMode: String(translationMode),
      dynamicVideoLength: boolValue(dynamicVideoLength, false),
      preserveChants: boolValue(preserveChants, true),
      filename: typeof filename === "string" && filename.trim() ? filename.trim() : "uploaded-video.mp4",
    };

    console.log(`[Translator] /submit-from-url downloading ${sourceUrl.href}`);
    const tempDir = await mkdtemp(join(tmpdir(), `translator-url-${jobId}-`));
    try {
      const inputPath = join(tempDir, `input.${ext}`);
      const { bytes, contentType } = await downloadUrlToTempFile(sourceUrl, inputPath);
      await s3.send(new PutObjectCommand({
        Bucket:      S3_BUCKET,
        Key:         s3Key,
        Body:        createReadStream(inputPath),
        ContentType: contentType,
      }));
      console.log(`[Translator] Copied uploaded file to s3://${S3_BUCKET}/${s3Key} (${bytes} bytes)`);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    await createTranslatorJobRecord(jobId, s3Key, options, ownerId);

    const started = await startTranslatorJob(jobId, s3Key, options);
    return res.json({ jobId, batchJobId: started.batchJobId, runtime: started.runtime, status: "QUEUED", lipsyncWarning: resolvedLipSync.warning });
  } catch (err: any) {
    console.error("[Translator] /submit-from-url error:", err);
    if (isConditionalWriteFailure(err)) {
      return res.status(409).json({ error: "A translation job with this jobId already exists." });
    }
    return res.status(translatorErrorStatus(err)).json({ error: err.message });
  }
});

// ── POST /submit-from-s3 ───────────────────────────────────────────────────────
// Ingests a video that already lives in our S3 bucket (a finished YouTube
// download or clip-cut produced by the /youtube/* endpoints) by COPYING it
// server-side into the translator-jobs prefix, then submitting the job.
// This is how "translate a YouTube URL / a specific part of it" works: the
// frontend first cuts/downloads the clip via the existing /youtube/clip-cut
// or /youtube/download endpoints (same battle-tested yt-dlp path the Studio
// copilot uses), then hands the resulting S3 key here. No re-download: a
// same-bucket CopyObject is fast and avoids Lambda size/time limits.
// The real S3 key produced by buildObjectKey() in lib/s3-storage.ts is
//   `${S3_OBJECT_PREFIX}/youtube/(clips|downloads)/${day}/${jobId}-${file}`
// e.g. "ytgrabber/youtube/clips/2026-06-13/abc-clip.mp4" — it is NOT a bare
// "youtube/clips/..." prefix.  Match the namespace as a path segment so the
// configurable S3_OBJECT_PREFIX and the date segment don't break the check.
const ALLOWED_TRANSLATOR_SOURCE_RE = /(?:^|\/)youtube\/(?:clips|downloads)\/.+/;

function assertAllowedTranslatorSourceKey(sourceKey: string): string {
  const key = String(sourceKey || "").replace(/^\/+/, "");
  if (!key || key.includes("..")) {
    throw Object.assign(new Error("Invalid sourceS3Key."), { statusCode: 400 });
  }
  if (!ALLOWED_TRANSLATOR_SOURCE_RE.test(key)) {
    throw Object.assign(
      new Error("sourceS3Key must be a YouTube download or clip output."),
      { statusCode: 400 },
    );
  }
  return key;
}

router.post("/submit-from-s3", async (req: Request, res: ExpressResponse) => {
  try {
    const ownerId = getRequesterId(req);
    const {
      sourceS3Key,
      targetLang     = "Hindi",
      targetLangCode = "hi",
      sourceLang     = "auto",
      voiceClone     = true,
      lipSync        = false,
      lipSyncQuality = "latentsync",
      useDemucs      = false,
      premiumAsr     = false,
      multiSpeaker   = false,
      asrModel       = "large-v3-turbo",
      translationMode = "default",
      dynamicVideoLength = false,
      preserveChants = true,
      filename       = "youtube-video.mp4",
    } = req.body;

    if (!sourceS3Key) {
      return res.status(400).json({ error: "sourceS3Key is required" });
    }
    const validatedSourceKey = assertAllowedTranslatorSourceKey(String(sourceS3Key));

    // Confirm the source object exists before we create a job around it.
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: validatedSourceKey }));

    const jobId = randomUUID();
    // Be lenient about the container: yt-dlp may produce mp4/webm/mkv and the
    // worker probes by content, not extension.  Never 500 here on an unusual
    // extension — fall back to mp4.
    let ext = "mp4";
    try { ext = safeVideoExtension(validatedSourceKey); } catch { ext = "mp4"; }
    const s3Key = `translator-jobs/${jobId}/input.${ext}`;
    const resolvedLipSync = resolveRequestedLipSync(req, res, lipSync);
    const options: TranslatorOptions = {
      targetLang: String(targetLang),
      targetLangCode: String(targetLangCode),
      sourceLang: String(sourceLang),
      voiceClone: boolValue(voiceClone, true),
      lipSync: resolvedLipSync.enabled,
      lipSyncQuality: String(lipSyncQuality),
      useDemucs: boolValue(useDemucs, false),
      premiumAsr: boolValue(premiumAsr, false),
      multiSpeaker: boolValue(multiSpeaker, false),
      asrModel: String(asrModel),
      translationMode: String(translationMode),
      dynamicVideoLength: boolValue(dynamicVideoLength, false),
      preserveChants: boolValue(preserveChants, true),
      filename: typeof filename === "string" && filename.trim() ? filename.trim() : "youtube-video.mp4",
    };

    await s3.send(new CopyObjectCommand({
      Bucket:     S3_BUCKET,
      Key:        s3Key,
      CopySource: `${S3_BUCKET}/${encodeURIComponent(validatedSourceKey).replace(/%2F/g, "/")}`,
    }));
    console.log(`[Translator] /submit-from-s3 copied s3://${S3_BUCKET}/${validatedSourceKey} → ${s3Key}`);

    await createTranslatorJobRecord(jobId, s3Key, options, ownerId);

    const started = await startTranslatorJob(jobId, s3Key, options);
    return res.json({ jobId, batchJobId: started.batchJobId, runtime: started.runtime, status: "QUEUED", lipsyncWarning: resolvedLipSync.warning });
  } catch (err: any) {
    console.error("[Translator] /submit-from-s3 error:", err);
    if (isConditionalWriteFailure(err)) {
      return res.status(409).json({ error: "A translation job with this jobId already exists." });
    }
    return res.status(translatorErrorStatus(err)).json({ error: err.message });
  }
});

// ── POST /submit-bulk ─────────────────────────────────────────────────────────
// Translate many already-uploaded videos in ONE GPU Batch job so the model load
// + GPU cold start is paid once for the whole batch. Each video still gets its
// own job record (own status/progress/result); they share the GPU session.
// Body: { videos: [{ jobId, s3Key, filename }], <shared options> }.
router.post("/submit-bulk", async (req: Request, res: ExpressResponse) => {
  try {
    const ownerId = getRequesterId(req);
    const {
      videos,
      targetLang     = "Hindi",
      targetLangCode = "hi",
      sourceLang     = "auto",
      voiceClone     = true,
      lipSync        = false,
      lipSyncQuality = "latentsync",
      useDemucs      = false,
      premiumAsr     = false,
      multiSpeaker   = false,
      asrModel       = "large-v3-turbo",
      translationMode = "default",
      dynamicVideoLength = false,
      preserveChants = true,
    } = req.body ?? {};

    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: "videos array is required" });
    }
    if (videos.length > MAX_BULK_VIDEOS) {
      return res.status(400).json({ error: `Too many videos: max ${MAX_BULK_VIDEOS} per batch.` });
    }

    const entries = videos.map((v: any, i: number) => ({
      jobId: String(v?.jobId ?? "").trim(),
      s3Key: String(v?.s3Key ?? "").trim(),
      filename: typeof v?.filename === "string" && v.filename.trim() ? v.filename.trim() : `video-${i + 1}.mp4`,
    }));
    if (entries.some((e) => !e.jobId || !e.s3Key)) {
      return res.status(400).json({ error: "each video needs jobId and s3Key" });
    }

    const resolvedLipSync = resolveRequestedLipSync(req, res, lipSync);
    const sharedOptions: Omit<TranslatorOptions, "filename"> = {
      targetLang: String(targetLang),
      targetLangCode: String(targetLangCode),
      sourceLang: String(sourceLang),
      voiceClone: boolValue(voiceClone, true),
      lipSync: resolvedLipSync.enabled,
      lipSyncQuality: String(lipSyncQuality),
      useDemucs: boolValue(useDemucs, false),
      premiumAsr: boolValue(premiumAsr, false),
      multiSpeaker: boolValue(multiSpeaker, false),
      asrModel: String(asrModel),
      translationMode: String(translationMode),
      dynamicVideoLength: boolValue(dynamicVideoLength, false),
      preserveChants: boolValue(preserveChants, true),
    };

    // Confirm every upload exists, then create one job record per video.
    for (const e of entries) {
      await assertUploadedTranslatorObject(e.jobId, e.s3Key);
    }
    const groupId = randomUUID();
    for (const e of entries) {
      await createTranslatorJobRecord(e.jobId, e.s3Key, { ...sharedOptions, filename: e.filename }, ownerId);
    }

    // Write the manifest the worker loops over, then submit ONE GPU job.
    const manifestKey = `translator-jobs/bulk/${groupId}/manifest.json`;
    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         manifestKey,
      Body:        JSON.stringify({ groupId, jobs: entries.map((e) => ({ jobId: e.jobId, s3InputKey: e.s3Key })) }),
      ContentType: "application/json",
    }));

    const batchJobId = await submitBulkTranslatorBatchJob(
      groupId,
      manifestKey,
      { ...sharedOptions, filename: entries[0].filename },
      entries.length,
    );

    // Tag every record with the shared batch + group so the UI can track them.
    const now = Date.now();
    await Promise.all(entries.map((e) => ddb.send(new UpdateItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: e.jobId } },
      UpdateExpression: "SET batchJobId = :b, batchGroupId = :g, runtime = :r, #st = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#st": "step" },
      ExpressionAttributeValues: {
        ":b": { S: batchJobId },
        ":g": { S: groupId },
        ":r": { S: "batch-bulk" },
        ":s": { S: "Queued in bulk batch, waiting for shared GPU worker..." },
        ":u": { N: String(now) },
      },
    }))));

    return res.json({
      groupId,
      batchJobId,
      status: "QUEUED",
      jobIds: entries.map((e) => e.jobId),
      lipsyncWarning: resolvedLipSync.warning,
    });
  } catch (err: any) {
    console.error("[Translator] /submit-bulk error:", err);
    if (isConditionalWriteFailure(err)) {
      return res.status(409).json({ error: "A translation job with this jobId already exists." });
    }
    return res.status(translatorErrorStatus(err)).json({ error: err.message });
  }
});

// ── GET /status/:jobId ────────────────────────────────────────────────────────
// Reads real-time job status from DynamoDB (updated by the Python worker).
router.get("/status/:jobId", async (req: Request, res: ExpressResponse) => {
  try {
    const jobId = String(req.params.jobId);

    const result = await ddb.send(new GetItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: String(jobId) } },
    }));

    if (!result.Item) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!isOwnerMatch(req, result.Item)) {
      return res.status(404).json({ error: "Job not found" });
    }

    const item = await syncTerminalBatchState(result.Item);
    return res.json({
      jobId,
      status:       item.status?.S ?? "UNKNOWN",
      progress:     parseInt(item.progress?.N ?? "0"),
      step:         item.step?.S ?? "",
      steps:        parseJsonAttribute(item.stepsJson?.S, []),
      error:        item.error?.S,
      lipsyncWarning:     item.lipsync_warning?.S,
      voiceCloneWarning:  item.voice_clone_warning?.S,
      filename:     item.filename?.S,
      targetLang:   item.targetLang?.S,
      targetLangCode: item.targetLangCode?.S,
      sourceLang:   item.sourceLang?.S,
      voiceClone:   item.voiceClone?.BOOL,
      voiceCloneApplied: item.voiceCloneApplied?.BOOL,
      lipSync:      item.lipSync?.BOOL,
      lipSyncApplied: item.lipSyncApplied?.BOOL,
      useDemucs:    item.useDemucs?.BOOL,
      multiSpeaker: item.multiSpeaker?.BOOL,
      dynamicVideoLength: item.dynamicVideoLength?.BOOL,
      preserveChants: item.preserveChants?.BOOL,
      dynamicExtraSeconds: item.dynamicExtraSeconds?.N ? parseFloat(item.dynamicExtraSeconds.N) : undefined,
      outputDurationSeconds: item.outputDurationSeconds?.N ? parseFloat(item.outputDurationSeconds.N) : undefined,
      runtime:      item.runtime?.S,
      segmentCount: item.segmentCount?.N != null ? parseInt(item.segmentCount.N) : undefined,
      batchJobId:   item.batchJobId?.S,
      updatedAt:    item.updatedAt?.N ? parseInt(item.updatedAt.N) : item.updatedAt?.S,
      createdAt:    item.createdAt?.N ? parseInt(item.createdAt.N) : (parseEpoch(item.createdAt?.S) ?? item.createdAt?.S),
    });
  } catch (err: any) {
    console.error("[Translator] /status error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /history ─────────────────────────────────────────────────────────────
// Returns paginated list of translator jobs for the current user.
router.get("/history", async (req: Request, res: ExpressResponse) => {
  try {
    const ownerId = getRequesterId(req);
    const limitParam = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, limitParam)) : 20;

    const items = [];
    let exclusiveStartKey: Record<string, any> | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await ddb.send(new ScanCommand({
        TableName: DDB_TABLE,
        FilterExpression: "#type = :type AND #ownerId = :ownerId",
        ExpressionAttributeNames: { "#type": "type", "#ownerId": "ownerId" },
        ExpressionAttributeValues: { ":type": { S: "translator" }, ":ownerId": { S: ownerId } },
        Limit: Math.max(50, limit * 4),
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
      if (!exclusiveStartKey || items.length >= 200) break;
    }

    const syncedItems = await Promise.all(
      items.slice(0, Math.max(20, limit * 2)).map((item) => syncTerminalBatchState(item).catch(() => item)),
    );

    const jobs = syncedItems
      .map((item) => ({
        jobId: item.jobId?.S,
        status: item.status?.S ?? "UNKNOWN",
        progress: parseInt(item.progress?.N ?? "0"),
        step: item.step?.S ?? "",
        steps: parseJsonAttribute(item.stepsJson?.S, []),
        error: item.error?.S,
        filename: item.filename?.S ?? "video.mp4",
        targetLang: item.targetLang?.S,
        targetLangCode: item.targetLangCode?.S,
        sourceLang: item.sourceLang?.S,
        voiceClone: item.voiceClone?.BOOL,
        voiceCloneApplied: item.voiceCloneApplied?.BOOL,
        lipSync: item.lipSync?.BOOL,
        lipSyncApplied: item.lipSyncApplied?.BOOL,
        runtime: item.runtime?.S,
        segmentCount: item.segmentCount?.N != null ? parseInt(item.segmentCount.N) : undefined,
        createdAt: item.createdAt?.N ? parseInt(item.createdAt.N) : parseEpoch(item.createdAt?.S),
        updatedAt: item.updatedAt?.N ? parseInt(item.updatedAt.N) : parseEpoch(item.updatedAt?.S),
        outputKey: item.outputKey?.S,
        shareUrl: item.jobId?.S ? shareUrl(req, item.jobId.S) : undefined,
      }))
      .filter((job) => job.jobId)
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .slice(0, limit);

    return res.json({ jobs });
  } catch (err: any) {
    console.error("[Translator] /history error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/cancel/:jobId", async (req: Request, res: ExpressResponse) => {
  try {
    const jobId = String(req.params.jobId);
    const current = await ddb.send(new GetItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: jobId } },
    }));

    if (!current.Item || current.Item.type?.S !== "translator" || !isOwnerMatch(req, current.Item)) {
      return res.status(404).json({ error: "Job not found" });
    }

    const status = current.Item.status?.S ?? "UNKNOWN";
    if (["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(status)) {
      return res.json({ jobId, status, alreadyTerminal: true });
    }

    const batchJobId = current.Item.batchJobId?.S;
    if (batchJobId) {
      await batch.send(new TerminateJobCommand({
        jobId: batchJobId,
        reason: "Cancelled by user",
      }));
    }

    await ddb.send(new UpdateItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: jobId } },
      UpdateExpression: "SET #status = :status, progress = :progress, step = :step, #error = :error, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
        "#error": "error",
      },
      ExpressionAttributeValues: {
        ":status": { S: "CANCELLED" },
        ":progress": { N: current.Item.progress?.N ?? "0" },
        ":step": { S: "Cancelled by user." },
        ":error": { S: "Cancelled by user." },
        ":updatedAt": { N: String(Date.now()) },
      },
    }));

    return res.json({ jobId, batchJobId, status: "CANCELLED" });
  } catch (err: any) {
    console.error("[Translator] /cancel error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/share/:jobId", async (req: Request, res: ExpressResponse) => {
  try {
    const jobId = String(req.params.jobId);

    const result = await ddb.send(new GetItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: String(jobId) } },
    }));

    if (!result.Item) {
      return res.status(404).json({ error: "Job not found" });
    }
    // NOTE: No owner check here — share links are intentionally public
    if (result.Item.type?.S !== "translator") {
      return res.status(404).json({ error: "Job not found" });
    }
    if (result.Item.status?.S !== "DONE") {
      return res.status(409).json({ error: `Job is not complete. Status: ${result.Item.status?.S ?? "UNKNOWN"}` });
    }

    const filename = result.Item.filename?.S ?? "translated_video.mp4";
    const prefix = `translator-jobs/${jobId}`;
    const key = `${prefix}/output.mp4`;
    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
    }), { expiresIn: 86400 });
    const previewUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ResponseContentDisposition: "inline",
    }), { expiresIn: 86400 });

    if (req.query.json === "1") {
      return res.json({
        jobId,
        filename,
        targetLang: result.Item.targetLang?.S,
        createdAt: result.Item.createdAt?.N ? Number(result.Item.createdAt.N) : undefined,
        shareUrl: shareUrl(req, jobId),
        downloadUrl,
        previewUrl,
      });
    }

    if (req.query.download === "1") {
      return res.redirect(downloadUrl);
    }

    const safeTitle = escapeHtml(filename);
    const safeLang = escapeHtml(result.Item.targetLang?.S ?? "Translated video");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body{margin:0;background:#0a0a0a;color:white;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
    .wrap{width:min(920px,100%)}
    video{width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;border:1px solid rgba(255,255,255,.1)}
    h1{font-size:20px;line-height:1.35;margin:18px 0 6px;word-break:break-word}
    p{margin:0 0 18px;color:rgba(255,255,255,.55);font-size:14px}
    a{display:inline-flex;align-items:center;justify-content:center;background:white;color:#050505;text-decoration:none;border-radius:12px;padding:12px 18px;font-weight:700;font-size:14px}
  </style>
</head>
<body>
  <main class="wrap">
    <video src="${previewUrl}" controls playsinline></video>
    <h1>${safeTitle}</h1>
    <p>${safeLang} translation shared from VideoMaking.</p>
    <a href="?download=1">Download Video</a>
  </main>
</body>
</html>`;
    return res.send(html);
  } catch (err: any) {
    console.error("[Translator] /share error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/result/:jobId", async (req: Request, res: ExpressResponse) => {
  try {
    const jobId = String(req.params.jobId);

    // Verify job is done
    const result = await ddb.send(new GetItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: String(jobId) } },
    }));

    if (!result.Item) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (!isOwnerMatch(req, result.Item)) {
      return res.status(404).json({ error: "Job not found" });
    }

    const status = result.Item.status?.S;
    if (status !== "DONE") {
      return res.status(409).json({ error: `Job is not complete. Status: ${status}` });
    }

    const prefix = `translator-jobs/${jobId}`;

    const [videoUrl, srtUrl, transcriptUrl] = await Promise.all([
      getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}/output.mp4` }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}/subtitles.srt` }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}/transcript.json` }), { expiresIn: 3600 }),
    ]);

    return res.json({
      jobId,
      videoUrl,
      shareUrl: shareUrl(req, jobId),
      srtUrl,
      transcriptUrl,
      voiceCloneApplied: result.Item.voiceCloneApplied?.BOOL,
      lipSyncApplied: result.Item.lipSyncApplied?.BOOL,
      runtime: result.Item.runtime?.S,
    });
  } catch (err: any) {
    console.error("[Translator] /result error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /assistant ────────────────────────────────────────────────────────
// A temporary in-tab AI helper for the Translation page.  It can see EVERY
// translator job for the current user (status, progress, per-step logs,
// warnings, errors, options, runtime, timestamps) plus the client-side
// activity log the user is currently looking at, and answers natural-language
// questions like "what's the status?", "what happened to my last job?",
// "why did it fail?".  Uses Gemini 3.5 Flash with MEDIUM thinking — the same
// client/model the rest of the app uses.  Non-streaming JSON for robustness.
const TRANSLATOR_ASSISTANT_SYSTEM_PROMPT = [
  "You are the Video Translation Assistant built into the Translation tab of this app —",
  "a senior debugging engineer for this dubbing pipeline. You have full read-only",
  "visibility into the user's jobs and logs (you cannot start, cancel or change jobs;",
  "you guide the user to the right control instead).",
  "You are given a live snapshot of ALL of the current user's video-translation jobs —",
  "their status, progress, per-step logs, warnings, errors, options (voice clone, lip-sync,",
  "keep background music, multi-speaker, dynamic video length), runtime and timestamps —",
  "plus the client-side activity log the user is currently looking at.",
  "",
  "## Your job",
  "Answer the user's questions about status and what happened. Be specific, accurate and friendly.",
  "Use the actual job data provided as the source of truth for statuses, times and logs —",
  "never invent statuses, times or logs that aren't there. If the data doesn't contain",
  "something, say so plainly.",
  "",
  "When a job failed, diagnose it deeply: read its error + step logs, explain the most likely",
  "root cause in plain language, and give concrete next steps (retry, cancel, shorten the clip,",
  "turn off lip-sync, switch voice mode, etc.). You understand this pipeline well:",
  "  - LatentSync lip-sync 'Face not detected' → the video has no clear front-facing face in",
  "    some frames; tell the user to turn OFF lip-sync for that video (audio dub still works).",
  "  - CosyVoice voice-clone warnings → clone fell back to a neural voice; the dub still",
  "    completed, just not in the original speaker's timbre.",
  "  - Gemini/translation errors, Demucs/keep-music issues, GPU timeouts, upload size limits.",
  "If you are unsure about a technical error message, you may use web knowledge to explain it,",
  "but always tie the advice back to the controls this app actually exposes.",
  "",
  "## Formatting",
  "Reply in clean GitHub-flavored Markdown. Use **bold** for key facts, `code` for job ids,",
  "statuses and filenames, and bullet lists for multiple jobs or steps. Use short ## headings",
  "only when the answer has clearly separate sections.",
  "Keep answers tight by default. When the user explicitly asks to 'dig in', go 'fully', or",
  "wants details, give a thorough, well-structured breakdown — per job, per failed step, with",
  "root cause and fix for each.",
].join("\n");

function serializeJobForAssistant(item: Record<string, any>): Record<string, any> | null {
  const jobId = item.jobId?.S;
  if (!jobId) return null;
  const steps = parseJsonAttribute<any[]>(item.stepsJson?.S, []);
  return {
    jobId,
    status: item.status?.S ?? "UNKNOWN",
    progress: parseInt(item.progress?.N ?? "0"),
    step: item.step?.S ?? "",
    steps: Array.isArray(steps)
      ? steps.map((s) => ({ label: s?.label ?? s?.name, status: s?.status, progress: s?.progress, message: s?.message }))
      : [],
    error: item.error?.S,
    lipsyncWarning: item.lipsync_warning?.S,
    voiceCloneWarning: item.voice_clone_warning?.S,
    filename: item.filename?.S,
    sourceLang: item.sourceLang?.S,
    targetLang: item.targetLang?.S,
    voiceClone: item.voiceClone?.BOOL,
    voiceCloneApplied: item.voiceCloneApplied?.BOOL,
    lipSync: item.lipSync?.BOOL,
    lipSyncApplied: item.lipSyncApplied?.BOOL,
    useDemucs: item.useDemucs?.BOOL,
    multiSpeaker: item.multiSpeaker?.BOOL,
    dynamicVideoLength: item.dynamicVideoLength?.BOOL,
    runtime: item.runtime?.S,
    segmentCount: item.segmentCount?.N != null ? parseInt(item.segmentCount.N) : undefined,
    createdAt: item.createdAt?.N ? parseInt(item.createdAt.N) : parseEpoch(item.createdAt?.S),
    updatedAt: item.updatedAt?.N ? parseInt(item.updatedAt.N) : parseEpoch(item.updatedAt?.S),
    batchJobId: item.batchJobId?.S,
  };
}

function buildAssistantDataBlock(
  jobs: Record<string, any>[],
  focusJobId: string | undefined,
  clientLogs: Array<{ ts?: number; level?: string; msg?: string }>,
): string {
  const now = Date.now();
  const ago = (ts: unknown) =>
    typeof ts === "number" && ts > 0 ? `${Math.max(0, Math.round((now - ts) / 60000))} min ago` : "unknown";
  const lines: string[] = [];
  lines.push(`Now: ${new Date(now).toISOString()}`);
  lines.push(`Total jobs visible: ${jobs.length}`);
  if (focusJobId) lines.push(`The user currently has this job open: ${focusJobId}`);
  lines.push("");
  lines.push("JOBS (newest first):");
  if (!jobs.length) lines.push("  (no translation jobs found for this user yet)");
  for (const j of jobs) {
    lines.push(`- jobId=${j.jobId}${j.jobId === focusJobId ? " (CURRENTLY OPEN)" : ""}`);
    lines.push(
      `  file="${j.filename ?? "?"}" ${j.sourceLang ?? "?"}->${j.targetLang ?? "?"} ` +
      `status=${j.status} progress=${j.progress}% step="${j.step ?? ""}"`,
    );
    const opts = [
      j.voiceClone && "voiceClone",
      j.lipSync && "lipSync",
      j.useDemucs && "keepMusic",
      j.multiSpeaker && "multiSpeaker",
      j.dynamicVideoLength && "dynamicLength",
    ].filter(Boolean).join(",");
    if (opts) lines.push(`  options=${opts}`);
    if (j.runtime || j.segmentCount != null) lines.push(`  runtime=${j.runtime ?? "?"} segments=${j.segmentCount ?? "?"}`);
    lines.push(`  created=${ago(j.createdAt)} updated=${ago(j.updatedAt)}`);
    if (j.error) lines.push(`  ERROR: ${String(j.error).slice(0, 500)}`);
    if (j.voiceCloneWarning) lines.push(`  voiceCloneWarning: ${String(j.voiceCloneWarning).slice(0, 300)}`);
    if (j.lipsyncWarning) lines.push(`  lipsyncWarning: ${String(j.lipsyncWarning).slice(0, 300)}`);
    if (Array.isArray(j.steps) && j.steps.length) {
      lines.push("  steps:");
      for (const s of j.steps) {
        lines.push(
          `    - ${s.label ?? "?"}: ${s.status ?? "?"}` +
          `${typeof s.progress === "number" ? ` ${s.progress}%` : ""}` +
          `${s.message ? ` - ${String(s.message).slice(0, 200)}` : ""}`,
        );
      }
    }
  }
  if (Array.isArray(clientLogs) && clientLogs.length) {
    lines.push("");
    lines.push("CLIENT ACTIVITY LOG (what the user has seen in the UI, oldest -> newest):");
    for (const l of clientLogs.slice(-120)) {
      const ts = typeof l?.ts === "number" ? new Date(l.ts).toISOString().slice(11, 19) : "";
      lines.push(`  [${ts}] ${String(l?.level ?? "info").toUpperCase()}: ${String(l?.msg ?? "").slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

type AssistantContext = {
  convo: Array<{ role: string; parts: Array<{ text: string }> }>;
  jobs: Record<string, any>[];
  systemInstruction: string;
};

// Gather everything the assistant needs: the trimmed conversation plus a live,
// read-only snapshot of ALL of this user's translator jobs (status, steps,
// errors, warnings) and the client-side activity log. Shared by the JSON and
// streaming endpoints. Returns an error tuple instead of throwing for the
// validation cases so callers can map them to the right transport.
async function buildAssistantContext(
  req: Request,
): Promise<{ ok: true; ctx: AssistantContext } | { ok: false; status: number; error: string }> {
  const ownerId = getRequesterId(req);
  const { messages = [], focusJobId, clientLogs = [] } = (req.body ?? {}) as {
    messages?: Array<{ role?: string; content?: string }>;
    focusJobId?: string;
    clientLogs?: Array<{ ts?: number; level?: string; msg?: string }>;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, error: "messages array is required" };
  }

  const convo = messages
    .filter((m) => m && (m.role === "user" || m.role === "model" || m.role === "assistant") && typeof m.content === "string")
    .slice(-24)
    .map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: String(m.content).slice(0, 4000) }],
    }));

  if (!convo.length) {
    return { ok: false, status: 400, error: "messages array has no valid messages" };
  }

  // Gather ALL of this user's translator jobs (same owner scope as /history).
  const items: Record<string, any>[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  for (let page = 0; page < 5; page += 1) {
    const out = await ddb.send(new ScanCommand({
      TableName: DDB_TABLE,
      FilterExpression: "#type = :type AND #ownerId = :ownerId",
      ExpressionAttributeNames: { "#type": "type", "#ownerId": "ownerId" },
      ExpressionAttributeValues: { ":type": { S: "translator" }, ":ownerId": { S: ownerId } },
      Limit: 100,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...(out.Items ?? []));
    exclusiveStartKey = out.LastEvaluatedKey;
    if (!exclusiveStartKey || items.length >= 120) break;
  }

  // Refresh only the jobs whose status could be stale (non-terminal), capped
  // so we never fan out dozens of Batch DescribeJobs calls per question.
  let syncBudget = 15;
  const synced = await Promise.all(items.map((it) => {
    const terminal = isTerminalTranslatorStatus(it.status?.S);
    if (!terminal && syncBudget > 0) {
      syncBudget -= 1;
      return syncTerminalBatchState(it).catch(() => it);
    }
    return Promise.resolve(it);
  }));

  const jobs = synced
    .map(serializeJobForAssistant)
    .filter((j): j is Record<string, any> => Boolean(j))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, 40);

  const safeClientLogs = Array.isArray(clientLogs) ? clientLogs : [];
  const dataBlock = buildAssistantDataBlock(jobs, focusJobId ? String(focusJobId) : undefined, safeClientLogs);
  const systemInstruction = `${TRANSLATOR_ASSISTANT_SYSTEM_PROMPT}\n\n=== LIVE DATA (current snapshot) ===\n${dataBlock}`;

  return { ok: true, ctx: { convo, jobs, systemInstruction } };
}

// Pull the answer out of a non-streaming response, tolerating the case where
// the SDK's `.text` getter returns empty (e.g. only thought/grounding parts).
function extractAssistantReply(response: any): { text: string; finishReason?: string } {
  let text = "";
  try { text = String(response?.text ?? "").trim(); } catch { text = ""; }
  const cand = response?.candidates?.[0];
  if (!text && Array.isArray(cand?.content?.parts)) {
    text = cand.content.parts
      .filter((p: any) => typeof p?.text === "string" && p?.thought !== true)
      .map((p: any) => p.text)
      .join("")
      .trim();
  }
  return { text, finishReason: cand?.finishReason };
}

router.post("/assistant", async (req: Request, res: ExpressResponse) => {
  try {
    if (!isGeminiConfigured()) {
      return res.status(503).json({ error: "AI assistant is not configured on the server." });
    }

    const built = await buildAssistantContext(req);
    if (!built.ok) return res.status(built.status).json({ error: built.error });
    const { convo, jobs, systemInstruction } = built.ctx;

    const ai = createGeminiClient();
    // Web grounding gives the assistant "search" ability to explain unfamiliar
    // technical errors. Toggle off with TRANSLATOR_ASSISTANT_SEARCH=0.
    const useSearch = process.env.TRANSLATOR_ASSISTANT_SEARCH !== "0";

    // Low thinking + a generous output budget so the model never exhausts the
    // budget on thinking tokens (the old 1400 cap + MEDIUM thinking routinely
    // produced empty replies). Optionally grounded with web search.
    const runGenerate = (opts: { search: boolean }) =>
      ai.models.generateContent({
        model: TRANSLATOR_ASSISTANT_MODEL,
        contents: convo,
        config: {
          systemInstruction,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "LOW" as any },
          ...(opts.search ? { tools: [{ googleSearch: {} }] } : {}),
        },
      });

    let { text: reply, finishReason } = extractAssistantReply(await runGenerate({ search: useSearch }));

    // Retry once without tools if the first pass came back empty. Grounding can
    // occasionally return only grounding metadata with no text part.
    if (!reply) {
      try {
        ({ text: reply, finishReason } = extractAssistantReply(await runGenerate({ search: false })));
      } catch (retryErr) {
        console.warn("[Translator] /assistant retry failed:", retryErr);
      }
    }

    if (!reply) {
      reply = finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT"
        ? "I can't answer that one — it was blocked by a safety filter. Try rephrasing your question about your jobs."
        : "I couldn't generate a response just now — please try asking again.";
    }

    return res.json({ reply, jobCount: jobs.length });
  } catch (err: any) {
    console.error("[Translator] /assistant error:", err);
    return res.status(500).json({ error: err?.message || "Assistant failed." });
  }
});

// Streaming variant: emits SSE events so the UI can show the assistant's live
// thinking, web searches and the answer as it is written. Event types:
//   meta     { jobCount }
//   thought  { content }   — reasoning summary delta (Gemini thinking mode)
//   search   { queries }   — web-search queries the model issued (grounding)
//   text     { content }   — answer delta (Markdown)
//   sources  { items }     — grounding citations { title, url }
//   done     {}            — stream finished cleanly
//   error    { message }
router.post("/assistant/stream", async (req: Request, res: ExpressResponse) => {
  const send = (payload: object) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    sseFlush(res);
  };

  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "AI assistant is not configured on the server." });
    return;
  }

  let built;
  try {
    built = await buildAssistantContext(req);
  } catch (err: any) {
    console.error("[Translator] /assistant/stream context error:", err);
    res.status(500).json({ error: err?.message || "Assistant failed." });
    return;
  }
  if (!built.ok) {
    res.status(built.status).json({ error: built.error });
    return;
  }
  const { convo, jobs, systemInstruction } = built.ctx;

  setupSse(res);
  let connected = true;
  res.on("close", () => { connected = false; });
  const isConnected = () => connected && !res.writableEnded;

  // Keep the connection warm across slow thinking phases (Lambda/CloudFront).
  const heartbeat = setInterval(() => { if (isConnected()) send({ type: "ping" }); }, 8000);

  try {
    send({ type: "meta", jobCount: jobs.length });

    const ai = createGeminiClient();
    const useSearch = process.env.TRANSLATOR_ASSISTANT_SEARCH !== "0";

    const runStream = (opts: { search: boolean }) =>
      ai.models.generateContentStream({
        model: TRANSLATOR_ASSISTANT_MODEL,
        contents: convo,
        config: {
          systemInstruction,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "LOW" as any, includeThoughts: true },
          ...(opts.search ? { tools: [{ googleSearch: {} }] } : {}),
        },
      });

    const seenQueries = new Set<string>();
    const sources = new Map<string, { title: string; url: string }>();

    const consume = async (opts: { search: boolean }): Promise<string> => {
      let answer = "";
      const stream = await runStream(opts);
      for await (const chunk of stream) {
        if (!isConnected()) break;
        const cand = chunk.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          if (p?.thought && p?.text) {
            send({ type: "thought", content: p.text });
          } else if (typeof p?.text === "string" && p.text) {
            answer += p.text;
            send({ type: "text", content: p.text });
          }
        }
        // Grounding: surface the web-search queries + citation links.
        const gm: any = cand?.groundingMetadata;
        if (gm) {
          const queries: string[] = (gm.webSearchQueries ?? []).filter(
            (q: string) => q && !seenQueries.has(q) && (seenQueries.add(q), true),
          );
          if (queries.length) send({ type: "search", queries });
          for (const c of gm.groundingChunks ?? []) {
            const web = c?.web;
            if (web?.uri && !sources.has(web.uri)) {
              sources.set(web.uri, { title: web.title || web.uri, url: web.uri });
            }
          }
        }
      }
      return answer.trim();
    };

    let answer = await consume({ search: useSearch });
    // Retry once without grounding if nothing came back (grounding can yield
    // only metadata with no text part).
    if (!answer && isConnected()) {
      answer = await consume({ search: false });
    }

    if (isConnected()) {
      if (sources.size) send({ type: "sources", items: [...sources.values()] });
      if (!answer) {
        send({ type: "text", content: "I couldn't generate a response just now — please try asking again." });
      }
      send({ type: "done" });
    }
  } catch (err: any) {
    console.error("[Translator] /assistant/stream error:", err);
    if (isConnected()) send({ type: "error", message: err?.message || "Assistant failed." });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

export default router;
