/**
 * Translator API routes — AWS Batch GPU Scale-to-Zero Architecture
 *
 * Routes:
 *   GET  /api/translator/presign      → S3 presigned PUT URL for direct video upload
 *   POST /api/translator/submit       → Creates DynamoDB job + submits AWS Batch GPU job
 *   GET  /api/translator/status/:id   → Poll job status from DynamoDB
 *   GET  /api/translator/result/:id   → Get presigned GET URL for final video/SRT/transcript
 */

import { Router, Request, Response } from "express";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
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

const router = Router();

const REGION       = process.env.YOUTUBE_QUEUE_REGION ?? "us-east-1";
const S3_BUCKET    = process.env.S3_BUCKET!;
const DDB_TABLE    = process.env.YOUTUBE_QUEUE_JOB_TABLE!;
const BATCH_QUEUE  = process.env.TRANSLATOR_BATCH_JOB_QUEUE!;
const BATCH_JOB_DEF = process.env.TRANSLATOR_BATCH_JOB_DEFINITION!;
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
  60,
  Math.min(1800, Number(process.env.TRANSLATOR_BATCH_TIMEOUT_SECONDS ?? "1800") || 1800),
);
const TRANSLATOR_LAMBDA_FAST_ENABLED = process.env.TRANSLATOR_LAMBDA_FAST_ENABLED !== "false";
const TRANSLATOR_LAMBDA_FAST_MAX_SECONDS = Math.max(
  60,
  Math.min(900, Number(process.env.TRANSLATOR_LAMBDA_FAST_MAX_SECONDS ?? "600") || 600),
);
const FFMPEG_BIN = process.env.FFMPEG_BIN || "/opt/bin/ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "/opt/bin/ffprobe";
const TRANSLATOR_TEXT_MODEL = process.env.TRANSLATOR_TEXT_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

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

function isTerminalTranslatorStatus(status: string | undefined): boolean {
  return TERMINAL_TRANSLATOR_STATUSES.has(String(status ?? "").toUpperCase());
}

async function syncTerminalBatchState(item: Record<string, any>): Promise<Record<string, any>> {
  const status = item.status?.S ?? "UNKNOWN";
  const batchJobId = item.batchJobId?.S;
  if (!batchJobId || isTerminalTranslatorStatus(status)) return item;

  const described = await batch.send(new DescribeJobsCommand({ jobs: [batchJobId] }));
  const batchJob = described.jobs?.[0];
  if (!batchJob || !["FAILED", "SUCCEEDED"].includes(batchJob.status ?? "")) return item;

  const nextStatus = batchJob.status === "SUCCEEDED" ? "DONE" : "FAILED";
  const reason =
    batchJob.statusReason ||
    batchJob.attempts?.find((attempt) => attempt.statusReason)?.statusReason ||
    (nextStatus === "DONE" ? "Translation complete." : "AWS Batch job failed.");
  const step =
    nextStatus === "DONE"
      ? "Translation complete!"
      : reason === "Job attempt duration exceeded timeout"
        ? "Translation stopped after the 30 minute limit."
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

function isLambdaFastCandidate(options: TranslatorOptions): boolean {
  return TRANSLATOR_LAMBDA_FAST_ENABLED && !options.voiceClone && !options.lipSync;
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
    { name: "TARGET_LANG",       value: options.targetLang },
    { name: "TARGET_LANG_CODE",  value: options.targetLangCode },
    { name: "SOURCE_LANG",       value: options.sourceLang },
    { name: "VOICE_CLONE",       value: String(options.voiceClone) },
    { name: "LIP_SYNC",          value: String(options.lipSync) },
    { name: "LIP_SYNC_QUALITY",  value: options.lipSyncQuality },
    { name: "USE_DEMUCS",        value: String(options.useDemucs) },
    { name: "PREMIUM_ASR",       value: String(options.premiumAsr) },
    { name: "MULTI_SPEAKER",     value: String(options.multiSpeaker) },
    { name: "ASR_MODEL",         value: options.asrModel },
    { name: "TRANSLATION_MODE",  value: options.translationMode },
    { name: "ASSEMBLYAI_API_KEY", value: ASSEMBLYAI_KEY },
    { name: "MODEL_CACHE_DIR",   value: "/model-cache" },
  ];
}

async function submitTranslatorBatchJob(jobId: string, s3Key: string, options: TranslatorOptions): Promise<string> {
  const batchResult = await batch.send(new SubmitJobCommand({
    jobName:       `translator-${jobId.slice(0, 8)}`,
    jobQueue:      BATCH_QUEUE,
    jobDefinition: BATCH_JOB_DEF,
    timeout:       { attemptDurationSeconds: TRANSLATOR_BATCH_TIMEOUT_SECONDS },
    containerOverrides: { environment: buildBatchEnvironment(jobId, s3Key, options) },
  }));

  await ddb.send(new UpdateItemCommand({
    TableName: DDB_TABLE,
    Key: { jobId: { S: jobId } },
    UpdateExpression: "SET batchJobId = :batchJobId, timeoutSeconds = :timeoutSeconds, runtime = :runtime, updatedAt = :updatedAt",
    ExpressionAttributeValues: {
      ":batchJobId": { S: String(batchResult.jobId) },
      ":timeoutSeconds": { N: String(TRANSLATOR_BATCH_TIMEOUT_SECONDS) },
      ":runtime": { S: "batch" },
      ":updatedAt": { N: String(Date.now()) },
    },
  }));

  console.log(`[Translator] Submitted Batch job ${batchResult.jobId} for translator job ${jobId}`);
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

async function downloadS3ObjectToFile(key: string, filePath: string): Promise<void> {
  const result = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  if (!result.Body) throw new Error("Input object has no body");
  await mkdir(dirname(filePath), { recursive: true });
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(filePath));
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await runCommand(FFPROBE_BIN, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], 30_000);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read video duration");
  return duration;
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
  for (const word of words) {
    const text = String(word.text ?? "").trim();
    const start = Number(word.start);
    const end = Number(word.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const shouldStart =
      !current ||
      current.text.split(/\s+/).length >= 8 ||
      start - current.startMs >= 4500 ||
      start - current.endMs > 900;
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

function toAssemblyLanguageCode(language: string): string | undefined {
  const normalized = language.trim().toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(normalized)) return normalized;
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

async function translateSegmentsFast(segments: FastSegment[], targetLang: string): Promise<FastSegment[]> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  const payload = segments.map((seg, i) => ({ id: i + 1, text: seg.text }));
  const prompt = [
    `Translate each item to ${targetLang}.`,
    "Return ONLY a JSON array with objects: {\"id\": number, \"text\": string}.",
    "Keep meaning natural and concise for video subtitles. Do not add commentary.",
    JSON.stringify(payload),
  ].join("\n");

  const resp = await ai.models.generateContent({
    model: TRANSLATOR_TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature: 0.2, maxOutputTokens: 8192 },
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
  try {
    await updateTranslatorJob(jobId, "STARTING", 3, "Starting fast Lambda translation...", { runtime: "lambda-fast" });
    const inputExt = extname(options.filename || s3Key) || ".mp4";
    const inputPath = join(workDir, `input${inputExt}`);
    const audioPath = join(workDir, "audio.wav");
    const outputPath = join(workDir, "output.mp4");
    const srtPath = join(workDir, "subtitles.srt");
    const transcriptPath = join(workDir, "transcript.json");

    await downloadS3ObjectToFile(s3Key, inputPath);
    const duration = await probeDurationSeconds(inputPath);
    if (duration > TRANSLATOR_LAMBDA_FAST_MAX_SECONDS) {
      await updateTranslatorJob(jobId, "QUEUED", 0, "Video is over 10 minutes; starting GPU worker...", {
        runtime: "batch",
        durationSeconds: Math.round(duration),
      });
      await submitTranslatorBatchJob(jobId, s3Key, options);
      return;
    }

    await updateTranslatorJob(jobId, "EXTRACTING", 12, "Extracting audio in Lambda...", { durationSeconds: Math.round(duration) });
    await extractAudioForTranscription(inputPath, audioPath);

    await updateTranslatorJob(jobId, "TRANSCRIBING", 28, "Transcribing speech...");
    const segments = await transcribeFastAudio(audioPath, options.sourceLang);

    await updateTranslatorJob(jobId, "TRANSLATING", 55, `Translating subtitles to ${options.targetLang}...`, {
      segmentCount: segments.length,
    });
    const translated = await translateSegmentsFast(segments, options.targetLang);
    await writeFile(srtPath, segmentsToSrt(translated), "utf8");
    await writeFile(transcriptPath, JSON.stringify({
      jobId,
      mode: "lambda-fast-subtitle-translation",
      targetLang: options.targetLang,
      durationSeconds: duration,
      segments: translated,
    }, null, 2), "utf8");

    await updateTranslatorJob(jobId, "MERGING", 82, "Preparing translated video and subtitle files...");
    await remuxToMp4(inputPath, outputPath);

    const prefix = `translator-jobs/${jobId}`;
    await updateTranslatorJob(jobId, "UPLOADING", 93, "Uploading translation results...");
    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${prefix}/output.mp4`,
        Body: createReadStream(outputPath),
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
      lipSyncApplied: false,
      runtime: "lambda-fast",
    });
  } catch (error) {
    console.error(`[Translator] Lambda fast path failed for ${jobId}:`, error);
    await markTranslatorFailed(jobId, error);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function startTranslatorJob(jobId: string, s3Key: string, options: TranslatorOptions): Promise<{ runtime: string; batchJobId?: string }> {
  if (isLambdaFastCandidate(options)) {
    void processLambdaFastTranslation(jobId, s3Key, options);
    return { runtime: "lambda-fast" };
  }
  const batchJobId = await submitTranslatorBatchJob(jobId, s3Key, options);
  return { runtime: "batch", batchJobId };
}

// ── GET /presign ──────────────────────────────────────────────────────────────
// Returns an S3 presigned PUT URL so the browser can upload directly to S3.
router.get("/presign", async (req: Request, res: Response) => {
  try {
    const { filename = "input.mp4", contentType = "video/mp4" } = req.query as Record<string, string>;
    const jobId = randomUUID();
    const ext   = filename.split(".").pop() ?? "mp4";
    const s3Key = `translator-jobs/${jobId}/input.${ext}`;

    const command = new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         s3Key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return res.json({ jobId, presignedUrl, s3Key });
  } catch (err: any) {
    console.error("[Translator] /presign error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /submit ──────────────────────────────────────────────────────────────
// Creates a DynamoDB job record and submits an AWS Batch GPU job.
router.post("/submit", async (req: Request, res: Response) => {
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
      filename,
    } = req.body;

    if (!jobId || !s3Key) {
      return res.status(400).json({ error: "jobId and s3Key are required" });
    }

    const now = Date.now();
    const options: TranslatorOptions = {
      targetLang: String(targetLang),
      targetLangCode: String(targetLangCode),
      sourceLang: String(sourceLang),
      voiceClone: boolValue(voiceClone, true),
      lipSync: boolValue(lipSync, false),
      lipSyncQuality: String(lipSyncQuality),
      useDemucs: boolValue(useDemucs, false),
      premiumAsr: boolValue(premiumAsr, false),
      multiSpeaker: boolValue(multiSpeaker, false),
      asrModel: String(asrModel),
      translationMode: String(translationMode),
      filename: typeof filename === "string" && filename.trim() ? filename.trim() : "video.mp4",
    };

    // Create DynamoDB job record
    await ddb.send(new PutItemCommand({
      TableName: DDB_TABLE,
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
        runtime:     { S: isLambdaFastCandidate(options) ? "lambda-fast" : "batch" },
        createdAt:   { N: String(now) },
        updatedAt:   { N: String(now) },
      },
    }));

    const started = await startTranslatorJob(jobId, s3Key, options);
    return res.json({ jobId, batchJobId: started.batchJobId, runtime: started.runtime, status: "QUEUED" });
  } catch (err: any) {
    console.error("[Translator] /submit error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /submit-from-url ──────────────────────────────────────────────────────
// Accepts a public file URL (e.g., S3 presigned URL from the uploads API).
// Downloads the file, copies it to the translator-jobs S3 prefix, then submits.
// This is the path used when a user uploads a video directly in the agent chat.
router.post("/submit-from-url", async (req: Request, res: Response) => {
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
      filename       = "uploaded-video.mp4",
    } = req.body;

    if (!fileUrl) {
      return res.status(400).json({ error: "fileUrl is required" });
    }

    const jobId = randomUUID();
    const ext   = (filename as string).split(".").pop() ?? "mp4";
    const s3Key = `translator-jobs/${jobId}/input.${ext}`;
    const options: TranslatorOptions = {
      targetLang: String(targetLang),
      targetLangCode: String(targetLangCode),
      sourceLang: String(sourceLang),
      voiceClone: boolValue(voiceClone, true),
      lipSync: boolValue(lipSync, false),
      lipSyncQuality: String(lipSyncQuality),
      useDemucs: boolValue(useDemucs, false),
      premiumAsr: boolValue(premiumAsr, false),
      multiSpeaker: boolValue(multiSpeaker, false),
      asrModel: String(asrModel),
      translationMode: String(translationMode),
      filename: typeof filename === "string" && filename.trim() ? filename.trim() : "uploaded-video.mp4",
    };

    // Download the file from the public URL and upload to translator S3 prefix
    console.log(`[Translator] /submit-from-url downloading ${fileUrl}`);
    const downloadRes = await fetch(fileUrl as string);
    if (!downloadRes.ok) {
      return res.status(400).json({ error: `Failed to download file from URL: ${downloadRes.status}` });
    }
    const fileBuffer = Buffer.from(await downloadRes.arrayBuffer());

    // Determine content type from response or filename
    const contentType = downloadRes.headers.get("content-type") ?? "video/mp4";

    // Upload to translator S3 prefix
    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         s3Key,
      Body:        fileBuffer,
      ContentType: contentType,
    }));
    console.log(`[Translator] Copied uploaded file to s3://${S3_BUCKET}/${s3Key} (${fileBuffer.length} bytes)`);

    const now = Date.now();
    await ddb.send(new PutItemCommand({
      TableName: DDB_TABLE,
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
        runtime:     { S: isLambdaFastCandidate(options) ? "lambda-fast" : "batch" },
        createdAt:   { N: String(now) },
        updatedAt:   { N: String(now) },
      },
    }));

    const started = await startTranslatorJob(jobId, s3Key, options);
    return res.json({ jobId, batchJobId: started.batchJobId, runtime: started.runtime, status: "QUEUED" });
  } catch (err: any) {
    console.error("[Translator] /submit-from-url error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /status/:jobId ────────────────────────────────────────────────────────
// Reads real-time job status from DynamoDB (updated by the Python worker).
router.get("/status/:jobId", async (req: Request, res: Response) => {

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
      error:        item.error?.S,
      lipsyncWarning:     item.lipsync_warning?.S,
      voiceCloneWarning:  item.voice_clone_warning?.S,
      filename:     item.filename?.S,
      targetLang:   item.targetLang?.S,
      targetLangCode: item.targetLangCode?.S,
      sourceLang:   item.sourceLang?.S,
      voiceClone:   item.voiceClone?.BOOL,
      lipSync:      item.lipSync?.BOOL,
      runtime:      item.runtime?.S,
      segmentCount: item.segmentCount ? parseInt(item.segmentCount.N!) : undefined,
      batchJobId:   item.batchJobId?.S,
      updatedAt:    item.updatedAt?.N ? parseInt(item.updatedAt.N) : item.updatedAt?.S,
      createdAt:    item.createdAt?.N ? parseInt(item.createdAt.N) : (parseEpoch(item.createdAt?.S) ?? item.createdAt?.S),
    });
  } catch (err: any) {
    console.error("[Translator] /status error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /result/:jobId ────────────────────────────────────────────────────────
// Returns presigned GET URLs for the final output files.
router.get("/history", async (req: Request, res: Response) => {
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
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
      if (!exclusiveStartKey || items.length >= 200) break;
    }

    const syncedItems = await Promise.all(
      items.slice(0, 80).map((item) => syncTerminalBatchState(item).catch(() => item)),
    );

    const jobs = syncedItems
      .map((item) => ({
        jobId: item.jobId?.S,
        status: item.status?.S ?? "UNKNOWN",
        progress: parseInt(item.progress?.N ?? "0"),
        step: item.step?.S ?? "",
        error: item.error?.S,
        filename: item.filename?.S ?? "video.mp4",
        targetLang: item.targetLang?.S,
        targetLangCode: item.targetLangCode?.S,
        sourceLang: item.sourceLang?.S,
        voiceClone: item.voiceClone?.BOOL,
        lipSync: item.lipSync?.BOOL,
        runtime: item.runtime?.S,
        segmentCount: item.segmentCount ? parseInt(item.segmentCount.N!) : undefined,
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

router.post("/cancel/:jobId", async (req: Request, res: Response) => {
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

router.get("/share/:jobId", async (req: Request, res: Response) => {
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

router.get("/result/:jobId", async (req: Request, res: Response) => {
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

    return res.json({ jobId, videoUrl, shareUrl: shareUrl(req, jobId), srtUrl, transcriptUrl });
  } catch (err: any) {
    console.error("[Translator] /result error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
