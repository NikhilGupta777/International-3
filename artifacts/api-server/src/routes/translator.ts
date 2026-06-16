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
import { Type } from "@google/genai";
import { Sandbox } from "e2b";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createGeminiClient, isGeminiConfigured, isVertexGeminiEnabled } from "../lib/gemini-client";
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
import { createReadStream, createWriteStream, existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, extname, join } from "path";
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
const GEMINI_TRANSCRIBE_MAX_SECONDS = Math.max(
  60,
  Number(process.env.GEMINI_TRANSCRIBE_MAX_SECONDS ?? "1020") || 1020,
);
const GEMINI_TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
// Thinking level for transcription. MEDIUM keeps Pro quality while avoiding max-latency ASR calls.
const GEMINI_TRANSCRIBE_THINKING = (process.env.GEMINI_TRANSCRIBE_THINKING || "MEDIUM").toUpperCase();
const GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS = Math.max(
  6,
  Number(process.env.GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS ?? "15") || 15,
);
const ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK = /^(1|true|yes|on)$/i.test(
  process.env.ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK ?? "false",
);
// Model for the in-tab Translation Assistant debugger.
const TRANSLATOR_ASSISTANT_MODEL = process.env.TRANSLATOR_ASSISTANT_MODEL || "gemini-3.1-pro-preview";
const TRANSLATOR_ASSISTANT_SEARCH_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.TRANSLATOR_ASSISTANT_SEARCH ?? "false",
);
const TRANSLATOR_ASSISTANT_CODE_CONTEXT_ENABLED = !/^(0|false|no|off)$/i.test(
  process.env.TRANSLATOR_ASSISTANT_CODE_CONTEXT ?? "true",
);
const TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_CHARS = Math.max(
  100000,
  Math.min(1500000, Number(process.env.TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_CHARS ?? "900000") || 900000),
);
const TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_FILE_CHARS = Math.max(
  50000,
  Math.min(500000, Number(process.env.TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_FILE_CHARS ?? "400000") || 400000),
);
const TRANSLATOR_ASSISTANT_SANDBOX_ENABLED = !/^(0|false|no|off)$/i.test(
  process.env.TRANSLATOR_ASSISTANT_SANDBOX ?? "true",
);
const TRANSLATOR_ASSISTANT_MAX_TOOL_ITERATIONS = Math.max(
  1,
  Math.min(10, Number(process.env.TRANSLATOR_ASSISTANT_MAX_TOOL_ITERATIONS ?? "6") || 6),
);
const TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS = Number.parseInt(process.env.E2B_SANDBOX_TIMEOUT_MS ?? "3600000", 10) || 3600000;
const TRANSLATOR_ASSISTANT_E2B_COMMAND_TIMEOUT_MS = Number.parseInt(process.env.E2B_COMMAND_TIMEOUT_MS ?? "120000", 10) || 120000;
const TRANSLATOR_ASSISTANT_E2B_MAX_OUTPUT_CHARS = Number.parseInt(process.env.E2B_MAX_OUTPUT_CHARS ?? "24000", 10) || 24000;
const TRANSLATOR_ASSISTANT_E2B_MAX_FILE_CHARS = Number.parseInt(process.env.E2B_MAX_FILE_CHARS ?? "120000", 10) || 120000;
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

// ── Translator S3 cleanup ─────────────────────────────────────────────────────
const TRANSLATOR_S3_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function cleanupOldTranslatorJobs(): Promise<void> {
  if (!S3_BUCKET) return;
  try {
    const cutoff = Date.now() - TRANSLATOR_S3_MAX_AGE_MS;
    let token: string | undefined;
    const toDelete: { Key: string }[] = [];
    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: "translator-jobs/",
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const obj of result.Contents ?? []) {
        if (obj.Key && obj.LastModified && obj.LastModified.getTime() < cutoff) {
          toDelete.push({ Key: obj.Key });
        }
      }
      token = result.NextContinuationToken;
    } while (token);
    for (let i = 0; i < toDelete.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: toDelete.slice(i, i + 1000), Quiet: true },
      }));
    }
    if (toDelete.length > 0) console.log(`[translator] Cleaned up ${toDelete.length} S3 objects older than 7 days`);
  } catch (err) {
    console.error("[translator] S3 cleanup error:", (err as Error).message);
  }
}

if (S3_BUCKET) {
  cleanupOldTranslatorJobs().catch(() => {});
  setInterval(() => { cleanupOldTranslatorJobs().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

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
    { name: "GEMINI_TRANSCRIBE_MAX_SECONDS", value: process.env.GEMINI_TRANSCRIBE_MAX_SECONDS ?? "1020" },
    { name: "GEMINI_TRANSCRIBE_CHUNK_SECONDS", value: process.env.GEMINI_TRANSCRIBE_CHUNK_SECONDS ?? "600" },
    { name: "GEMINI_TRANSCRIBE_MIN_COVERAGE", value: process.env.GEMINI_TRANSCRIBE_MIN_COVERAGE ?? "0.9" },
    { name: "GEMINI_TRANSCRIBE_MODEL", value: process.env.GEMINI_TRANSCRIBE_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.1-pro-preview" },
    { name: "GEMINI_TRANSCRIBE_THINKING", value: process.env.GEMINI_TRANSCRIBE_THINKING ?? "MEDIUM" },
    { name: "GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS", value: process.env.GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS ?? "15" },
    { name: "ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK", value: process.env.ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK ?? "false" },
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
  const useFastGpuQueue = !useCpuQueue && (options.lipSync || options.voiceClone) && Boolean(BATCH_QUEUE_FAST);
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
const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_BULK_VIDEOS = envInt("TRANSLATOR_MAX_BULK_VIDEOS", 10);
const BULK_PER_VIDEO_SECONDS = envInt("TRANSLATOR_BULK_PER_VIDEO_SECONDS", 1200);
const BULK_MAX_TIMEOUT_SECONDS = envInt("TRANSLATOR_BULK_MAX_TIMEOUT_SECONDS", 21600);

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

function buildGeminiTranscriptionPrompt(sourceLang: string, targetLang: string, durationSeconds?: number, repair = false): string {
  const durationHint = Number.isFinite(durationSeconds) && durationSeconds! > 0
    ? durationSeconds!.toFixed(3)
    : "unknown";
  const repairNote = repair
    ? "\n\nSTRICT REPAIR MODE: A previous attempt returned invalid or incomplete JSON. Transcribe the ENTIRE audio from the first word to the last word — do not stop early. Return exactly ONE complete, valid JSON object and nothing else."
    : "";
  return [
    "You are the transcription engine for a video translation and dubbing pipeline.",
    "",
    "Transcribe the provided audio exactly in the original spoken language. Do not translate. Do not summarize. Preserve the speaker's actual words, filler words, repetitions, false starts, names, numbers, and code-switching exactly as spoken.",
    "",
    "Source language hint may be wrong. First detect the actual spoken language from the audio. Use the detected language and script for transcription even when the hint says something else.",
    "For Indic and other non-Latin languages, native script is required. Do not romanize Hindi, Odia/Oriya, Bengali, Punjabi, Gujarati, Marathi, Sanskrit, Nepali, Tamil, Telugu, Kannada, Malayalam, Urdu, Arabic, Chinese, Japanese, Korean, Russian, or any other native-script language unless the speaker literally says a Latin-script word or name.",
    "",
    "Top priority: create professional, broadcast-quality, audio-aware segments.",
    "You must listen to the real audio rhythm, not just count words. Segment boundaries must follow when the speaker actually starts speaking, continues speaking, pauses, changes speaker, or finishes a connected thought.",
    "If the speaker continues talking at a consistent pace with no meaningful pause, keep the connected thought together only up to a practical dubbing unit. Avoid paragraph-sized segments.",
    "If the speaker says a short phrase and then pauses for about 1-2 seconds, or clearly stops before the next phrase, make that phrase its own short segment.",
    "Do not chop continuous speech into tiny fixed-size fragments. Do not merge across real pauses. Do not use a rigid word count as the main rule.",
    "",
    "Return ONLY valid JSON matching this shape:",
    "{\"languageCode\":\"string\",\"languageName\":\"string\",\"durationSeconds\":number,\"segments\":[{\"id\":number,\"speaker\":\"SPEAKER_A\",\"start\":number,\"end\":number,\"text\":\"string\",\"words\":[{\"word\":\"string\",\"start\":number,\"end\":number}]}]}",
    "",
    "Rules:",
    "1. Output only JSON. No markdown, no explanation, no comments.",
    "2. All timestamps must be in seconds from the start of the audio.",
    "3. Segment start must be when the speaker begins that utterance. Segment end must be when the speaker finishes that utterance.",
    "4. Do not split just because the text is long. If the speaker keeps talking without a meaningful pause, keep the connected speech together, but still prefer natural phrase-sized dubbing units over paragraph-sized blocks.",
    "5. If the speaker clearly pauses around 1-2 seconds, stops, or begins a new thought, create a boundary.",
    "6. Prefer 1-6 words for naturally short utterances. Allow 7-15 words when the speaker continues without a meaningful pause. Allow more than 15 words only when the audio is genuinely continuous. Even then, avoid segments longer than about 12-15 seconds; split at the nearest phrase or sentence boundary.",
    "7. Preserve the exact original-language text in native script. Do not translate to the target language.",
    "8. Preserve code-switching exactly.",
    "9. Assign stable speaker labels as SPEAKER_A, SPEAKER_B, SPEAKER_C, etc.",
    "10. Do not include speaker labels inside the text field.",
    "",
    `Source language hint: ${sourceLang || "auto"}`,
    `Known duration seconds: ${durationHint}`,
    `Target translation language after transcription: ${targetLang}. This is only context for segmentation. Do not translate into this language.`,
  ].join("\n") + repairNote;
}

function extractJsonPayload(text: string): any {
  const cleaned = String(text ?? "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const objectStart = cleaned.indexOf("{");
    const arrayStart = cleaned.indexOf("[");
    const starts = [objectStart, arrayStart].filter((n) => n >= 0);
    if (!starts.length) throw new Error("Gemini returned invalid transcription JSON");
    const start = Math.min(...starts);
    const endChar = cleaned[start] === "{" ? "}" : "]";
    const end = cleaned.lastIndexOf(endChar);
    if (end <= start) throw new Error("Gemini returned invalid transcription JSON");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function stripSpeakerPrefix(text: string): string {
  return String(text ?? "").replace(/^\s*(?:speaker\s+[a-z0-9_]+|SPEAKER_[a-z0-9_]+)\s*[:-]\s*/i, "").trim();
}

function splitOverlongFastSegment(seg: FastSegment): FastSegment[] {
  const durationMs = seg.endMs - seg.startMs;
  const maxMs = GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS * 1000;
  if (durationMs <= maxMs + 50) return [seg];

  const words = seg.text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [seg];

  const pieces: FastSegment[] = [];
  const msPerWord = durationMs / words.length;
  let index = 0;
  while (index < words.length) {
    const pieceStartMs = Math.round(seg.startMs + index * msPerWord);
    const remainingWords = words.length - index;
    const maxWords = Math.max(1, Math.floor(maxMs / Math.max(1, msPerWord)));
    let take = Math.min(remainingWords, maxWords);

    const minWords = Math.max(1, Math.floor(take * 0.45));
    for (let i = take - 1; i >= minWords; i--) {
      if (/[।॥.!?;:,]$/u.test(words[index + i - 1] ?? "")) {
        take = i;
        break;
      }
    }

    const pieceEndMs = index + take >= words.length
      ? seg.endMs
      : Math.min(seg.endMs, Math.round(seg.startMs + (index + take) * msPerWord));
    pieces.push({
      startMs: pieceStartMs,
      endMs: Math.max(pieceStartMs + 1, pieceEndMs),
      text: words.slice(index, index + take).join(" "),
    });
    index += take;
  }

  return pieces;
}

function splitOverlongFastSegments(segments: FastSegment[]): FastSegment[] {
  return segments.flatMap(splitOverlongFastSegment);
}

function normalizeGeminiTranscriptPayload(payload: unknown, durationSeconds?: number): FastSegment[] {
  const rawSegments = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.segments)
      ? (payload as any).segments
      : null;
  if (!rawSegments) throw new Error("Gemini transcription returned invalid JSON shape");
  const duration = finiteNumber(durationSeconds);
  const segments: FastSegment[] = [];
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== "object") continue;
    const text = stripSpeakerPrefix(String((raw as any).text ?? (raw as any).content ?? ""));
    let start = finiteNumber((raw as any).start ?? (raw as any).startSec ?? (raw as any).start_seconds);
    let end = finiteNumber((raw as any).end ?? (raw as any).endSec ?? (raw as any).end_seconds);
    if (!text || start == null || end == null) continue;
    if (duration && end > Math.max(duration * 2, 1000)) {
      start /= 1000;
      end /= 1000;
    }
    start = Math.max(0, start);
    if (duration) end = Math.min(duration, end);
    if (end <= start) continue;
    segments.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text });
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const repaired: FastSegment[] = [];
  for (const seg of segments) {
    const prev = repaired[repaired.length - 1];
    if (prev && prev.endMs > seg.startMs) {
      const overlap = prev.endMs - seg.startMs;
      if (overlap <= 120 || prev.text || seg.text) prev.endMs = seg.startMs;
      if (prev.endMs <= prev.startMs) repaired.pop();
    }
    repaired.push(seg);
  }
  return splitOverlongFastSegments(repaired);
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

async function transcribeFastMediaUrlAssemblyAI(mediaUrl: string, sourceLang: string): Promise<{ segments: FastSegment[]; durationSeconds: number; provider: "assemblyai" }> {
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
      return { segments, durationSeconds: Number(result.audio_duration ?? 0) || 0, provider: "assemblyai" };
    }
    if (result.status === "error") throw new Error(result.error || "AssemblyAI transcription failed");
  }

  throw new Error("AssemblyAI transcription timed out");
}

// Gemini transcription needs the audio uploaded via the Files API. `fileData.fileUri`
// only accepts Gemini Files API URIs (or YouTube / gs:// URIs) — a signed S3 https URL
// is NOT fetched by the model. So we extract a small mono 16k WAV locally and upload it,
// mirroring the proven subtitles.ts pattern.
async function transcribeFastAudioGemini(
  audioPath: string,
  sourceLang: string,
  targetLang: string,
  knownDurationSeconds?: number,
): Promise<{ segments: FastSegment[]; durationSeconds: number; provider: "gemini"; model: string }> {
  if (!isGeminiConfigured()) throw new Error("Gemini is not configured. Add Vertex Gemini env or GEMINI_API_KEY.");
  const ai = createGeminiClient();

  // One generateContent call for the given audio part. `repair` swaps in the strict
  // repair prompt (#3 retry / #2 truncation guard reuse the same uploaded audio part).
  const attempt = async (audioPart: any, repair: boolean): Promise<FastSegment[]> => {
    const prompt = buildGeminiTranscriptionPrompt(sourceLang, targetLang, knownDurationSeconds, repair);
    const resp = await ai.models.generateContent({
      model: GEMINI_TRANSCRIBE_MODEL,
      contents: [{ role: "user", parts: [audioPart, { text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingLevel: GEMINI_TRANSCRIBE_THINKING as any },
      },
    } as any);
    const text = (resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim()
      || (resp as any).text
      || "";
    const segs = normalizeGeminiTranscriptPayload(extractJsonPayload(text), knownDurationSeconds);
    if (!segs.length) throw new Error("Gemini returned no usable timed speech segments");
    return segs;
  };

  const transcribeWithPart = async (audioPart: any): Promise<FastSegment[]> => {
    let segments: FastSegment[];
    try {
      segments = await attempt(audioPart, false);            // (#3) first pass
    } catch (firstErr) {
      console.warn("[Translator] Gemini transcription attempt failed; retrying in repair mode:", firstErr);
      segments = await attempt(audioPart, true);
    }
    // (#2) truncation/early-stop guard: if it stops well short of a known duration, retry once.
    const dur = knownDurationSeconds;
    if (dur && dur > 30 && segments.length) {
      const covered = segments[segments.length - 1].endMs / 1000;
      if (covered < dur * 0.9) {
        console.warn(`[Translator] Gemini output covers only ${covered.toFixed(1)}s of ${dur.toFixed(1)}s; retrying in repair mode.`);
        try {
          const retry = await attempt(audioPart, true);
          if (retry.length && retry[retry.length - 1].endMs > segments[segments.length - 1].endMs) segments = retry;
        } catch (retryErr) {
          console.warn("[Translator] Repair retry failed; keeping first result:", retryErr);
        }
      }
    }
    return segments;
  };

  let segments: FastSegment[];
  if (isVertexGeminiEnabled()) {
    // Vertex AI has no Files API — send the audio inline as base64 bytes.
    const audioBase64 = (await readFile(audioPath)).toString("base64");
    segments = await transcribeWithPart({ inlineData: { mimeType: "audio/wav", data: audioBase64 } });
  } else {
    // API-key mode: upload via the Files API, poll until ACTIVE, then reuse the URI.
    const uploaded = await ai.files.upload({
      file: audioPath,
      config: { mimeType: "audio/wav", displayName: basename(audioPath) },
    });
    const fileName: string | undefined = uploaded.name;
    try {
      let fileInfo: any = uploaded;
      let attempts = 0;
      while (fileInfo.state === "PROCESSING" && attempts < 90) {
        await new Promise((r) => setTimeout(r, 2000));
        fileInfo = await ai.files.get({ name: fileName! });
        attempts++;
      }
      if (fileInfo.state !== "ACTIVE") throw new Error("Gemini audio processing timed out");
      segments = await transcribeWithPart({ fileData: { fileUri: fileInfo.uri as string, mimeType: "audio/wav" } });
    } finally {
      if (fileName) {
        try { await ai.files.delete({ name: fileName }); }
        catch (cleanupErr) { console.warn("[Translator] Gemini file cleanup skipped:", cleanupErr); }
      }
    }
  }

  // When the duration probe failed, fall back to the last segment's end.
  const fallbackDuration = segments.length ? segments[segments.length - 1].endMs / 1000 : 0;
  return {
    segments,
    durationSeconds: knownDurationSeconds || fallbackDuration,
    provider: "gemini",
    model: GEMINI_TRANSCRIBE_MODEL,
  };
}

// Transcribe a local audio file with Gemini; fall back to AssemblyAI (from the signed
// URL) only when ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK is set. Long videos never reach
// here — they are handed to the GPU Batch worker before transcription (see caller).
async function transcribeFastLocalAudio(
  audioPath: string,
  mediaUrl: string,
  sourceLang: string,
  targetLang: string,
  durationSeconds?: number,
): Promise<{ segments: FastSegment[]; durationSeconds: number; provider: "gemini" | "assemblyai"; model?: string }> {
  try {
    return await transcribeFastAudioGemini(audioPath, sourceLang, targetLang, durationSeconds);
  } catch (err) {
    if (!ALLOW_ASSEMBLYAI_TRANSCRIBE_FALLBACK) throw err;
    console.warn("[Translator] Gemini transcription failed; using AssemblyAI emergency fallback:", err);
    return transcribeFastMediaUrlAssemblyAI(mediaUrl, sourceLang);
  }
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

    await updateTranslatorJob(jobId, "TRANSCRIBING", 18, "Transcribing speech with Gemini...");
    // Probe the signed source URL, then hand long videos to the GPU Batch worker
    // BEFORE transcribing (the GPU worker transcribes long audio with chunked
    // Gemini). The signed URL is reused for fast audio extraction and fallback.
    const audioPath = join(workDir, "fast-audio.wav");
    const mediaUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }), { expiresIn: 3600 });

    let segments: FastSegment[];
    let durationSeconds: number;
    let provider: "gemini" | "assemblyai";
    let model: string | undefined;
    let durationKnown = false;
    try {
      let probed: number | undefined;
      try {
        probed = await probeDurationSeconds(mediaUrl);
      } catch (probeErr) {
        console.warn("[Translator] Remote duration probe failed; proceeding with Gemini:", probeErr);
      }
      durationKnown = probed != null;

      // Over the fast limit → GPU Batch, before any transcription work.
      if (probed != null && probed > TRANSLATOR_LAMBDA_FAST_MAX_SECONDS) {
        await updateTranslatorJob(jobId, "QUEUED", 0, "Video is over the fast subtitle limit; starting GPU worker...", {
          runtime: "batch",
          durationSeconds: Math.round(probed),
        });
        await submitTranslatorBatchJob(jobId, s3Key, options, false, probed);
        handedToBatch = true;
        return;
      }

      await extractAudioForTranscription(mediaUrl, audioPath);
      const r = await transcribeFastLocalAudio(audioPath, mediaUrl, options.sourceLang, options.targetLang, probed);
      segments = r.segments;
      durationSeconds = r.durationSeconds;
      provider = r.provider;
      model = r.model;
    } finally {
      await rm(audioPath, { force: true }).catch(() => {});
    }

    // Safety net for the probe-failed case: if the transcript reveals it was over the
    // fast limit after all, hand off to Batch instead of producing a partial result.
    if (durationSeconds > TRANSLATOR_LAMBDA_FAST_MAX_SECONDS) {
      await updateTranslatorJob(jobId, "QUEUED", 0, "Video is over the fast subtitle limit; starting GPU worker...", {
        runtime: "batch",
        durationSeconds: Math.round(durationSeconds),
        transcriptionProvider: provider,
      });
      await submitTranslatorBatchJob(jobId, s3Key, options, false, durationSeconds);
      handedToBatch = true;
      return;
    }

    await updateTranslatorJob(jobId, "TRANSLATING", 55, `Translating subtitles to ${options.targetLang}...`, {
      segmentCount: segments.length,
      durationSeconds: Math.round(durationSeconds),
      transcriptionProvider: provider,
      ...(model ? { transcriptionModel: model } : {}),
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
      transcriptionProvider: provider,
      transcriptionModel: model ?? provider,
      transcriptionCutoffSeconds: GEMINI_TRANSCRIBE_MAX_SECONDS,
      transcriptionMaxSegmentSeconds: GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS,
      durationProbe: durationKnown ? "ok" : "failed",
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
      transcriptionProvider: provider,
      ...(model ? { transcriptionModel: model } : {}),
      transcriptionThinking: GEMINI_TRANSCRIBE_THINKING,
      transcriptionMaxSegmentSeconds: GEMINI_TRANSCRIBE_MAX_SEGMENT_SECONDS,
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
  // Best-effort: probe duration from a presigned S3 URL. If it fails or takes
  // longer than 15s, return undefined so the caller falls back to static timeout.
  // This keeps the submit endpoint responsive even for large or slow uploads.
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;

  const probePromise = (async (): Promise<number> => {
    const presigned = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }), { expiresIn: 3600 });
    return probeDurationSeconds(presigned);
  })();

  try {
    const duration = await Promise.race<number | undefined>([
      probePromise,
      new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
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
    // In a bulk batch, many videos share ONE Batch job — terminating it here
    // would kill every sibling. So for a bulk member we only mark THIS video
    // cancelled (the worker skips it if it hasn't started yet) and leave the
    // shared job running. Use /cancel-batch/:groupId to stop the whole batch.
    const isBulk = Boolean(current.Item.batchGroupId?.S);
    if (batchJobId && !isBulk) {
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

// ── POST /cancel-batch/:groupId ───────────────────────────────────────────────
// Stop an entire bulk batch: terminate the shared GPU job and mark every
// non-terminal member CANCELLED. Owner-scoped.
router.post("/cancel-batch/:groupId", async (req: Request, res: ExpressResponse) => {
  try {
    const groupId = String(req.params.groupId);
    const ownerId = getRequesterId(req);

    // Find this owner's jobs in the group.
    const out = await ddb.send(new ScanCommand({
      TableName: DDB_TABLE,
      FilterExpression: "batchGroupId = :g AND #ownerId = :o",
      ExpressionAttributeNames: { "#ownerId": "ownerId" },
      ExpressionAttributeValues: { ":g": { S: groupId }, ":o": { S: ownerId } },
    }));
    const items = out.Items ?? [];
    if (!items.length) {
      return res.status(404).json({ error: "Batch not found" });
    }

    // Terminate the shared Batch job once.
    const batchJobId = items.find((it) => it.batchJobId?.S)?.batchJobId?.S;
    if (batchJobId) {
      await batch.send(new TerminateJobCommand({ jobId: batchJobId, reason: "Bulk batch cancelled by user" }));
    }

    const now = Date.now();
    const cancelled: string[] = [];
    await Promise.all(items.map((it) => {
      const id = it.jobId?.S;
      if (!id || isTerminalTranslatorStatus(it.status?.S)) return Promise.resolve();
      cancelled.push(id);
      return ddb.send(new UpdateItemCommand({
        TableName: DDB_TABLE,
        Key: { jobId: { S: id } },
        UpdateExpression: "SET #s = :s, step = :st, #e = :e, updatedAt = :u",
        ExpressionAttributeNames: { "#s": "status", "#e": "error" },
        ExpressionAttributeValues: {
          ":s": { S: "CANCELLED" },
          ":st": { S: "Bulk batch cancelled by user." },
          ":e": { S: "Cancelled by user." },
          ":u": { N: String(now) },
        },
      }));
    }));

    return res.json({ groupId, batchJobId, cancelled, status: "CANCELLED" });
  } catch (err: any) {
    console.error("[Translator] /cancel-batch error:", err);
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
  "visibility into the focused job snapshot, recent job records, step logs and warnings.",
  "You cannot start, cancel, retry, edit production files, deploy, or access the production shell;",
  "guide the user to the right control instead.",
  "You may receive an allowlisted read-only backend/frontend/worker code context for this pipeline.",
  "Use that code context to debug translation issues, but do not claim broader filesystem or sandbox access.",
  "When sandbox tools are available, you may run deep code search, scripts, package installs, and public",
  "internet fetches inside the isolated E2B sandbox only. The sandbox is separate from production.",
  "Before code-searching in sandbox, inspect /home/user/translation-code; if files are missing, explain",
  "that the sandbox lacks that file and use public fetches only when the user provided a URL or the source",
  "is clearly public.",
  "You are given a live snapshot of the current user's active video-translation jobs and most recent completed jobs -",
  "their status, progress, per-step logs, warnings, errors, options (voice clone, lip-sync,",
  "keep background music, multi-speaker, dynamic video length), runtime and timestamps —",
  "plus the client-side activity log the user is currently looking at.",
  "",
  "## Your job",
  "Answer the user's questions about status and what happened. Be specific, accurate and friendly.",
  "Use the actual job data provided as the source of truth for statuses, times and logs —",
  "never invent statuses, times or logs that aren't there. If the data doesn't contain",
  "something, say so plainly.",
  "For generic questions like 'status', 'what is happening', or 'what now', focus first on:",
  "  1. the job currently open in the UI,",
  "  2. other live/running jobs,",
  "  3. the most recent completed job.",
  "Do not bring up old failed jobs unless the user explicitly asks about history, older jobs,",
  "failures, audits, or a specific job id.",
  "Do not use internet knowledge or citations unless the user explicitly asks to search the web",
  "and the server has web search enabled. Prefer the live job data and code context.",
  "",
  "When a job failed, diagnose it deeply: read its error + step logs, explain the most likely",
  "root cause in plain language, and give concrete next steps (retry, cancel, shorten the clip,",
  "turn off lip-sync, switch voice mode, etc.). You understand this pipeline well:",
  "  - LatentSync lip-sync 'Face not detected' → the video has no clear front-facing face in",
  "    some frames; tell the user to turn OFF lip-sync for that video (audio dub still works).",
  "  - CosyVoice voice-clone warnings → clone fell back to a neural voice; the dub still",
  "    completed, just not in the original speaker's timbre.",
  "  - Gemini/translation errors, Demucs/keep-music issues, GPU timeouts, upload size limits.",
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

function latestUserText(messages: Array<{ role?: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user" && typeof msg.content === "string") return msg.content;
  }
  return "";
}

function userAskedForHistory(text: string): boolean {
  return /\b(all|older|old|history|past|previous|failed|failures|audit|deep|dig|last\s+\d+|recent\s+\d+|today|yesterday)\b/i.test(text);
}

function userAskedForWebSearch(text: string): boolean {
  return /\b(web|internet|google|search|look\s*up|external|source|citation)\b/i.test(text);
}

const TRANSLATOR_SANDBOX_TOOLS = [
  {
    name: "run_sandbox_command",
    description: [
      "Run a Linux shell command inside this Translation Assistant chat's isolated E2B sandbox.",
      "Use this for deep code search, grep/rg, scripts, package installs, filesystem work, public internet fetches, and analysis.",
      "Translation source files are preloaded under /home/user/translation-code when available.",
      "This cannot access or mutate the production server filesystem.",
    ].join(" "),
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: "Shell command to execute, e.g. rg \"sidechaincompress\" /home/user/translation-code or python3 audit.py." },
        cwd: { type: Type.STRING, description: "Working directory inside sandbox. Default: /home/user/translation-code." },
        timeoutMs: { type: Type.NUMBER, description: "Timeout in milliseconds. Default server configured; max 10 minutes." },
        writeFiles: {
          type: Type.ARRAY,
          description: "Optional files to write before running the command.",
          items: {
            type: Type.OBJECT,
            properties: {
              path: { type: Type.STRING, description: "Absolute sandbox path, e.g. /home/user/audit.py." },
              content: { type: Type.STRING, description: "Text content to write." },
            },
            required: ["path", "content"],
          },
        },
        readFiles: {
          type: Type.ARRAY,
          description: "Optional absolute sandbox text file paths to read after the command finishes.",
          items: { type: Type.STRING },
        },
      },
      required: ["command"],
    },
  },
  {
    name: "sandbox_status",
    description: "Report whether E2B is configured and whether this Translation Assistant chat has a connected sandbox.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "reset_sandbox",
    description: "Destroy this Translation Assistant chat's current E2B sandbox and start fresh on the next sandbox command.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
];

function selectAssistantJobs(
  jobs: Record<string, any>[],
  focusJobId: string | undefined,
  includeHistory: boolean,
): Record<string, any>[] {
  const sorted = [...jobs].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  if (includeHistory) return sorted.slice(0, 30);

  const picked = new Map<string, Record<string, any>>();
  const add = (job: Record<string, any> | undefined) => {
    if (job?.jobId && !picked.has(job.jobId)) picked.set(job.jobId, job);
  };

  add(sorted.find((j) => focusJobId && j.jobId === focusJobId));
  for (const job of sorted) {
    if (!isTerminalTranslatorStatus(String(job.status))) add(job);
  }
  for (const job of sorted.filter((j) => isTerminalTranslatorStatus(String(j.status)))) {
    if (picked.size >= 8) break;
    add(job);
  }
  return [...picked.values()].sort((a, b) => {
    if (focusJobId && a.jobId === focusJobId) return -1;
    if (focusJobId && b.jobId === focusJobId) return 1;
    const aLive = !isTerminalTranslatorStatus(String(a.status));
    const bLive = !isTerminalTranslatorStatus(String(b.status));
    if (aLive !== bLive) return aLive ? -1 : 1;
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  });
}

async function buildAssistantCodeContext(): Promise<string> {
  if (!TRANSLATOR_ASSISTANT_CODE_CONTEXT_ENABLED) return "";
  const roots = [
    process.cwd(),
    join(process.cwd(), "code-context"),
    join(process.cwd(), "..", ".."),
  ];
  const files = [
    "artifacts/api-server/src/routes/translator.ts",
    "artifacts/api-server/src/lib/gemini-client.ts",
    "artifacts/api-server/package.json",
    "artifacts/yt-downloader/src/pages/VideoTranslator.tsx",
    "artifacts/yt-downloader/src/lib/translator-history.ts",
    "artifacts/yt-downloader/src/lib/translator-client-id.ts",
    "artifacts/yt-downloader/package.json",
    "artifacts/video-translator-service/worker.py",
    "artifacts/video-translator-service/runtime_deps.py",
    "artifacts/video-translator-service/test_worker_guards.py",
    "artifacts/video-translator-service/test_runtime_deps.py",
    "artifacts/video-translator-service/test_phase1_pacing.py",
    "artifacts/video-translator-service/test_phase2_translation.py",
    "artifacts/video-translator-service/test_phase3_cloning.py",
    "artifacts/video-translator-service/test_phase4_5_mixing.py",
    "artifacts/video-translator-service/requirements.txt",
    "artifacts/video-translator-service/requirements.cpu.txt",
    "artifacts/video-translator-service/constraints.txt",
    "artifacts/video-translator-service/Dockerfile",
    "artifacts/video-translator-service/Dockerfile.cpu",
    "artifacts/video-translator-service/Dockerfile.base",
  ];
  const sections: string[] = [];
  let used = 0;
  for (const rel of files) {
    let found = "";
    for (const root of roots) {
      const full = join(root, rel);
      if (existsSync(full)) {
        found = full;
        break;
      }
    }
    if (!found) continue;
    try {
      const text = await readFile(found, "utf8");
      const remaining = TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_CHARS - used;
      if (remaining <= 0) break;
      const maxForFile = Math.min(TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_FILE_CHARS, remaining);
      const body = text.length > maxForFile
        ? `${text.slice(0, maxForFile)}\n\n/* TRUNCATED: file is ${text.length} chars; ask the user for a deeper audit if more context is needed. */`
        : text;
      const section = `--- ${rel} (${found}) ---\n${body}`;
      sections.push(section);
      used += section.length;
    } catch {
      // Code context is optional; job/log data remains the source of truth.
    }
  }
  if (!sections.length) return "";
  return [
    "=== READ-ONLY TRANSLATION CODE CONTEXT (allowlisted backend/frontend/worker files) ===",
    "The assistant can inspect these bundled files for debugging, but cannot edit files, run commands, deploy, or access an interactive sandbox.",
    `Context budget: ${used}/${TRANSLATOR_ASSISTANT_CODE_CONTEXT_MAX_CHARS} chars. Large files may be truncated.`,
    ...sections,
  ].join("\n");
}

const translatorSandboxBySession = new Map<string, { sandboxId: string; lastUsed: number; preloaded: boolean }>();

function translatorE2BConfigured(): boolean {
  return Boolean(process.env.E2B_API_KEY?.trim());
}

function pruneTranslatorSandboxEntries(): void {
  const cutoff = Date.now() - TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS;
  for (const [key, entry] of translatorSandboxBySession) {
    if (entry.lastUsed < cutoff) translatorSandboxBySession.delete(key);
  }
}

function translatorSandboxSessionKey(req: Request): string {
  const ownerId = getRequesterId(req);
  const body = (req.body ?? {}) as { sessionId?: string; focusJobId?: string };
  const raw = `${ownerId}:${String(body.sessionId || body.focusJobId || "translator-assistant")}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function normalizeTranslatorSandboxPath(value: unknown, fallback = "/home/user/translation-code"): string {
  const path = String(value ?? fallback).trim() || fallback;
  if (!path.startsWith("/")) throw new Error(`Sandbox paths must be absolute: ${path}`);
  return path.replace(/\0/g, "");
}

function truncateTranslatorToolText(value: string, limit = TRANSLATOR_ASSISTANT_E2B_MAX_OUTPUT_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`;
}

function translationCodeFiles(): string[] {
  return [
    "artifacts/api-server/src/routes/translator.ts",
    "artifacts/api-server/src/lib/gemini-client.ts",
    "artifacts/api-server/package.json",
    "artifacts/yt-downloader/src/pages/VideoTranslator.tsx",
    "artifacts/yt-downloader/src/lib/translator-history.ts",
    "artifacts/yt-downloader/src/lib/translator-client-id.ts",
    "artifacts/yt-downloader/package.json",
    "artifacts/video-translator-service/worker.py",
    "artifacts/video-translator-service/runtime_deps.py",
    "artifacts/video-translator-service/test_worker_guards.py",
    "artifacts/video-translator-service/test_runtime_deps.py",
    "artifacts/video-translator-service/test_phase1_pacing.py",
    "artifacts/video-translator-service/test_phase2_translation.py",
    "artifacts/video-translator-service/test_phase3_cloning.py",
    "artifacts/video-translator-service/test_phase4_5_mixing.py",
    "artifacts/video-translator-service/requirements.txt",
    "artifacts/video-translator-service/requirements.cpu.txt",
    "artifacts/video-translator-service/constraints.txt",
    "artifacts/video-translator-service/Dockerfile",
    "artifacts/video-translator-service/Dockerfile.cpu",
    "artifacts/video-translator-service/Dockerfile.base",
  ];
}

function findTranslationCodeFile(rel: string): string | null {
  const roots = [
    process.cwd(),
    join(process.cwd(), "code-context"),
    join(process.cwd(), "..", ".."),
  ];
  for (const root of roots) {
    const full = join(root, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

async function preloadTranslationCodeIntoSandbox(sandbox: any, sessionKey: string): Promise<void> {
  const entry = translatorSandboxBySession.get(sessionKey);
  if (entry?.preloaded) return;
  await sandbox.files.makeDir("/home/user/translation-code").catch(() => {});
  for (const rel of translationCodeFiles()) {
    const found = findTranslationCodeFile(rel);
    if (!found) continue;
    try {
      const text = await readFile(found, "utf8");
      const target = `/home/user/translation-code/${rel}`;
      await sandbox.files.makeDir(dirname(target)).catch(() => {});
      await sandbox.files.write(target, text);
    } catch {
      // Sandbox preload is best-effort. The model can still use prompt context.
    }
  }
  await sandbox.files.write(
    "/home/user/translation-code/README.md",
    [
      "# Translation Assistant Sandbox",
      "",
      "This sandbox is isolated from production.",
      "Bundled translation source files are under `/home/user/translation-code/artifacts/...`.",
      "Use `find`, `grep`, `rg` if installed, `python3`, package installs, or public fetches as needed.",
      "The sandbox cannot edit production code or deploy changes.",
    ].join("\n"),
  ).catch(() => {});
  const current = translatorSandboxBySession.get(sessionKey);
  if (current) translatorSandboxBySession.set(sessionKey, { ...current, preloaded: true, lastUsed: Date.now() });
}

async function getTranslatorSandbox(req: Request): Promise<any> {
  if (!TRANSLATOR_ASSISTANT_SANDBOX_ENABLED) {
    throw new Error("Translation Assistant sandbox is disabled.");
  }
  if (!translatorE2BConfigured()) {
    throw new Error("E2B sandbox is not configured. Set E2B_API_KEY on the API server.");
  }
  pruneTranslatorSandboxEntries();
  const sessionKey = translatorSandboxSessionKey(req);
  const existing = translatorSandboxBySession.get(sessionKey);
  if (existing) {
    try {
      const connected = await Sandbox.connect(existing.sandboxId, { timeoutMs: TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS });
      await connected.setTimeout(TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS).catch(() => {});
      translatorSandboxBySession.set(sessionKey, { ...existing, lastUsed: Date.now() });
      await preloadTranslationCodeIntoSandbox(connected, sessionKey);
      return connected;
    } catch {
      translatorSandboxBySession.delete(sessionKey);
    }
  }
  const sandbox = await Sandbox.create({
    timeoutMs: TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS,
    metadata: { app: "videomaking-translator-assistant", sessionId: sessionKey },
  });
  translatorSandboxBySession.set(sessionKey, { sandboxId: sandbox.sandboxId, lastUsed: Date.now(), preloaded: false });
  await preloadTranslationCodeIntoSandbox(sandbox, sessionKey);
  return sandbox;
}

async function resetTranslatorSandbox(req: Request): Promise<{ reset: boolean; sandboxId?: string }> {
  const sessionKey = translatorSandboxSessionKey(req);
  const entry = translatorSandboxBySession.get(sessionKey);
  translatorSandboxBySession.delete(sessionKey);
  if (entry?.sandboxId && translatorE2BConfigured()) {
    await Sandbox.kill(entry.sandboxId).catch(() => {});
  }
  return { reset: true, sandboxId: entry?.sandboxId };
}

async function translatorSandboxStatus(req: Request): Promise<Record<string, any>> {
  const configured = translatorE2BConfigured();
  const enabled = TRANSLATOR_ASSISTANT_SANDBOX_ENABLED;
  const sessionKey = translatorSandboxSessionKey(req);
  const entry = translatorSandboxBySession.get(sessionKey);
  let running: boolean | undefined;
  if (configured && enabled && entry?.sandboxId) {
    try {
      const sandbox = await Sandbox.connect(entry.sandboxId, { timeoutMs: TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS });
      running = await sandbox.isRunning();
    } catch {
      running = false;
      translatorSandboxBySession.delete(sessionKey);
    }
  }
  return {
    enabled,
    configured,
    sessionKey,
    sandboxId: entry?.sandboxId,
    running,
    codePath: "/home/user/translation-code",
    timeoutMs: TRANSLATOR_ASSISTANT_E2B_TIMEOUT_MS,
  };
}

async function runTranslatorSandboxCommand(
  req: Request,
  args: Record<string, any>,
  send?: (payload: object) => void,
): Promise<Record<string, any>> {
  const command = String(args.command ?? "").trim();
  if (!command) throw new Error("command is required.");
  const sandbox = await getTranslatorSandbox(req);
  const cwd = normalizeTranslatorSandboxPath(args.cwd, "/home/user/translation-code");
  const timeoutMsRaw = Number(args.timeoutMs ?? TRANSLATOR_ASSISTANT_E2B_COMMAND_TIMEOUT_MS);
  const timeoutMs = Math.max(1000, Math.min(Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : TRANSLATOR_ASSISTANT_E2B_COMMAND_TIMEOUT_MS, 10 * 60 * 1000));
  await sandbox.files.makeDir(cwd).catch(() => {});

  const writeFiles = Array.isArray(args.writeFiles) ? args.writeFiles : [];
  for (const file of writeFiles.slice(0, 20)) {
    const path = normalizeTranslatorSandboxPath(file?.path, "/home/user");
    const content = String(file?.content ?? "");
    if (content.length > TRANSLATOR_ASSISTANT_E2B_MAX_FILE_CHARS) throw new Error(`Sandbox file too large: ${path}`);
    await sandbox.files.makeDir(dirname(path)).catch(() => {});
    await sandbox.files.write(path, content);
  }

  send?.({ type: "tool", name: "run_sandbox_command", status: "running", command: command.slice(0, 180) });
  let liveOut = "";
  let liveErr = "";
  const result = await sandbox.commands.run(command, {
    cwd,
    timeoutMs,
    onStdout: (data: string) => { liveOut += data; },
    onStderr: (data: string) => { liveErr += data; },
  });

  const readFiles = Array.isArray(args.readFiles) ? args.readFiles : [];
  const files: Array<{ path: string; content: string }> = [];
  for (const rawPath of readFiles.slice(0, 10)) {
    const path = normalizeTranslatorSandboxPath(rawPath, "/home/user");
    try {
      const content = await sandbox.files.read(path, { format: "text" });
      files.push({ path, content: truncateTranslatorToolText(String(content), TRANSLATOR_ASSISTANT_E2B_MAX_FILE_CHARS) });
    } catch (err: any) {
      files.push({ path, content: `[could not read file: ${String(err?.message ?? err)}]` });
    }
  }

  const stdout = truncateTranslatorToolText(String(result.stdout || liveOut || ""));
  const stderr = truncateTranslatorToolText(String(result.stderr || liveErr || ""));
  send?.({ type: "tool", name: "run_sandbox_command", status: "done", exitCode: result.exitCode });
  return {
    sandbox: "e2b",
    sandboxId: sandbox.sandboxId,
    cwd,
    exitCode: result.exitCode,
    error: result.error,
    stdout,
    stderr,
    files,
  };
}

async function runTranslatorAssistantTool(
  req: Request,
  name: string,
  args: Record<string, any>,
  send?: (payload: object) => void,
): Promise<Record<string, any>> {
  if (name === "run_sandbox_command") return runTranslatorSandboxCommand(req, args, send);
  if (name === "sandbox_status") {
    send?.({ type: "tool", name, status: "running" });
    const result = await translatorSandboxStatus(req);
    send?.({ type: "tool", name, status: "done" });
    return result;
  }
  if (name === "reset_sandbox") {
    send?.({ type: "tool", name, status: "running" });
    const result = await resetTranslatorSandbox(req);
    send?.({ type: "tool", name, status: "done" });
    return result;
  }
  return { error: `Unknown tool: ${name}` };
}

type AssistantContext = {
  convo: Array<{ role: string; parts: Array<{ text: string }> }>;
  jobs: Record<string, any>[];
  systemInstruction: string;
  allowWebSearch: boolean;
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
    sessionId?: string;
    clientLogs?: Array<{ ts?: number; level?: string; msg?: string }>;
  };
  const lastUser = latestUserText(messages);

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

  // Gather this user's translator jobs (same owner scope as /history). The
  // assistant only receives a focused subset unless the user asks for history.
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

  const allJobs = synced
    .map(serializeJobForAssistant)
    .filter((j): j is Record<string, any> => Boolean(j))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

  const jobs = selectAssistantJobs(allJobs, focusJobId ? String(focusJobId) : undefined, userAskedForHistory(lastUser));

  const safeClientLogs = Array.isArray(clientLogs) ? clientLogs : [];
  const dataBlock = buildAssistantDataBlock(jobs, focusJobId ? String(focusJobId) : undefined, safeClientLogs);
  const codeContext = await buildAssistantCodeContext();
  const systemInstruction = [
    TRANSLATOR_ASSISTANT_SYSTEM_PROMPT,
    "=== LIVE DATA (current focused snapshot) ===",
    dataBlock,
    codeContext,
  ].filter(Boolean).join("\n\n");
  const allowWebSearch = TRANSLATOR_ASSISTANT_SEARCH_ENABLED && userAskedForWebSearch(lastUser);

  return { ok: true, ctx: { convo, jobs, systemInstruction, allowWebSearch } };
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
    const { convo, jobs, systemInstruction, allowWebSearch } = built.ctx;

    const ai = createGeminiClient();
    // Web grounding is opt-in: enabled by env and only used when the user asks
    // for web/external search. Job data and code context are the default source.
    const useSearch = allowWebSearch;

    const buildTools = (search: boolean) => [
      ...(TRANSLATOR_ASSISTANT_SANDBOX_ENABLED ? [{ functionDeclarations: TRANSLATOR_SANDBOX_TOOLS as any }] : []),
      ...(search ? [{ googleSearch: {} }] : []),
    ];

    const runGenerate = (contents: any[], opts: { search: boolean }) =>
      ai.models.generateContent({
        model: TRANSLATOR_ASSISTANT_MODEL,
        contents,
        config: {
          systemInstruction,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "LOW" as any },
          ...(buildTools(opts.search).length ? {
            tools: buildTools(opts.search),
            toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
          } : {}),
        },
      });

    let contents: any[] = [...convo];
    let reply = "";
    let finishReason: string | undefined;
    for (let iter = 0; iter < TRANSLATOR_ASSISTANT_MAX_TOOL_ITERATIONS; iter += 1) {
      const response = await runGenerate(contents, { search: useSearch });
      const cand = response?.candidates?.[0];
      finishReason = cand?.finishReason;
      const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
      const functionCalls = parts
        .filter((p: any) => p?.functionCall)
        .map((p: any) => p.functionCall);
      const extracted = extractAssistantReply(response).text;
      if (!functionCalls.length) {
        reply = extracted;
        break;
      }
      contents.push({ role: "model", parts });
      const toolParts = [];
      for (const fc of functionCalls.slice(0, 4)) {
        const name = String(fc.name || "");
        const args = (fc.args ?? {}) as Record<string, any>;
        try {
          const result = await runTranslatorAssistantTool(req, name, args);
          toolParts.push({ functionResponse: { id: fc.id, name, response: { result } } });
        } catch (err: any) {
          toolParts.push({ functionResponse: { id: fc.id, name, response: { result: { error: String(err?.message ?? err) } } } });
        }
      }
      contents.push({ role: "user", parts: toolParts });
    }

    if (!reply) {
      try {
        ({ text: reply, finishReason } = extractAssistantReply(await runGenerate(contents, { search: false })));
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
  const { convo, jobs, systemInstruction, allowWebSearch } = built.ctx;

  setupSse(res);
  let connected = true;
  res.on("close", () => { connected = false; });
  const isConnected = () => connected && !res.writableEnded;

  // Keep the connection warm across slow thinking phases (Lambda/CloudFront).
  const heartbeat = setInterval(() => { if (isConnected()) send({ type: "ping" }); }, 8000);

  try {
    send({ type: "meta", jobCount: jobs.length });

    const ai = createGeminiClient();
    const useSearch = allowWebSearch;

    const buildTools = (search: boolean) => [
      ...(TRANSLATOR_ASSISTANT_SANDBOX_ENABLED ? [{ functionDeclarations: TRANSLATOR_SANDBOX_TOOLS as any }] : []),
      ...(search ? [{ googleSearch: {} }] : []),
    ];

    const runStream = (contents: any[], opts: { search: boolean }) =>
      ai.models.generateContentStream({
        model: TRANSLATOR_ASSISTANT_MODEL,
        contents,
        config: {
          systemInstruction,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "LOW" as any, includeThoughts: true },
          ...(buildTools(opts.search).length ? {
            tools: buildTools(opts.search),
            toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
          } : {}),
        },
      });

    const seenQueries = new Set<string>();
    const sources = new Map<string, { title: string; url: string }>();

    const consume = async (contents: any[], opts: { search: boolean }): Promise<{ answer: string; parts: any[]; functionCalls: any[] }> => {
      let answer = "";
      const parts: any[] = [];
      const functionCalls: any[] = [];
      const stream = await runStream(contents, opts);
      for await (const chunk of stream) {
        if (!isConnected()) break;
        const cand = chunk.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          parts.push(p);
          if (p?.thought && p?.text) {
            send({ type: "thought", content: p.text });
          } else if (p?.functionCall) {
            functionCalls.push(p.functionCall);
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
      return { answer: answer.trim(), parts, functionCalls };
    };

    let contents: any[] = [...convo];
    let answer = "";
    for (let iter = 0; iter < TRANSLATOR_ASSISTANT_MAX_TOOL_ITERATIONS && isConnected(); iter += 1) {
      const result = await consume(contents, { search: useSearch });
      answer += result.answer ? `${answer ? "\n" : ""}${result.answer}` : "";
      if (!result.functionCalls.length) break;

      contents.push({ role: "model", parts: result.parts });
      const toolParts = [];
      for (const fc of result.functionCalls.slice(0, 4)) {
        const name = String(fc.name || "");
        const args = (fc.args ?? {}) as Record<string, any>;
        send({ type: "tool", name, status: "start", args });
        try {
          const toolResult = await runTranslatorAssistantTool(req, name, args, send);
          toolParts.push({ functionResponse: { id: fc.id, name, response: { result: toolResult } } });
          send({ type: "tool", name, status: "done" });
        } catch (err: any) {
          const message = String(err?.message ?? err);
          toolParts.push({ functionResponse: { id: fc.id, name, response: { result: { error: message } } } });
          send({ type: "tool", name, status: "error", error: message });
        }
      }
      contents.push({ role: "user", parts: toolParts });
    }

    if (!answer && isConnected()) {
      const retry = await consume(contents, { search: false });
      answer = retry.answer;
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
