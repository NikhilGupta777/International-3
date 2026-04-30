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
const TRANSLATOR_BATCH_TIMEOUT_SECONDS = Math.max(
  60,
  Math.min(1800, Number(process.env.TRANSLATOR_BATCH_TIMEOUT_SECONDS ?? "1800") || 1800),
);

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

    // Create DynamoDB job record
    await ddb.send(new PutItemCommand({
      TableName: DDB_TABLE,
      Item: {
        jobId:       { S: jobId },
        type:        { S: "translator" },
        status:      { S: "QUEUED" },
        progress:    { N: "0" },
        step:        { S: "Job queued, waiting for worker..." },
        s3InputKey:  { S: s3Key },
        filename:    { S: typeof filename === "string" && filename.trim() ? filename.trim() : "video.mp4" },
        targetLang:  { S: targetLang },
        targetLangCode: { S: targetLangCode },
        sourceLang:  { S: sourceLang },
        ownerId:     { S: ownerId },
        voiceClone:  { BOOL: Boolean(voiceClone) },
        lipSync:     { BOOL: Boolean(lipSync) },
        createdAt:   { N: String(now) },
        updatedAt:   { N: String(now) },
      },
    }));

    // Build environment variables for the Batch worker
    const envVars = [
      { name: "JOB_ID",            value: jobId },
      { name: "S3_BUCKET",         value: S3_BUCKET },
      { name: "S3_INPUT_KEY",      value: s3Key },
      { name: "S3_OUTPUT_PREFIX",  value: `translator-jobs/${jobId}` },
      { name: "DYNAMODB_TABLE",    value: DDB_TABLE },
      { name: "DYNAMODB_REGION",   value: REGION },
      { name: "GEMINI_API_KEY",    value: GEMINI_KEY },
      { name: "GEMINI_API_KEY_2",  value: GEMINI_KEY_2 },
      { name: "GEMINI_API_KEY_3",  value: GEMINI_KEY_3 },
      { name: "TARGET_LANG",       value: targetLang },
      { name: "TARGET_LANG_CODE",  value: targetLangCode },
      { name: "SOURCE_LANG",       value: sourceLang },
      { name: "VOICE_CLONE",       value: String(voiceClone) },
      { name: "LIP_SYNC",          value: String(lipSync) },
      { name: "LIP_SYNC_QUALITY",  value: lipSyncQuality },
      { name: "USE_DEMUCS",        value: String(useDemucs) },
      { name: "PREMIUM_ASR",       value: String(premiumAsr) },
      { name: "MULTI_SPEAKER",     value: String(multiSpeaker) },
      { name: "ASR_MODEL",         value: asrModel },
      { name: "TRANSLATION_MODE",  value: translationMode },
      { name: "ASSEMBLYAI_API_KEY", value: ASSEMBLYAI_KEY },
      { name: "MODEL_CACHE_DIR",   value: "/model-cache" },
    ];

    // Submit AWS Batch job
    const batchResult = await batch.send(new SubmitJobCommand({
      jobName:          `translator-${jobId.slice(0, 8)}`,
      jobQueue:         BATCH_QUEUE,
      jobDefinition:    BATCH_JOB_DEF,
      timeout:          { attemptDurationSeconds: TRANSLATOR_BATCH_TIMEOUT_SECONDS },
      containerOverrides: {
        environment: envVars,
      },
    }));

    await ddb.send(new UpdateItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: jobId } },
      UpdateExpression: "SET batchJobId = :batchJobId, timeoutSeconds = :timeoutSeconds, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":batchJobId": { S: String(batchResult.jobId) },
        ":timeoutSeconds": { N: String(TRANSLATOR_BATCH_TIMEOUT_SECONDS) },
        ":updatedAt": { N: String(Date.now()) },
      },
    }));

    console.log(`[Translator] Submitted Batch job ${batchResult.jobId} for translator job ${jobId}`);

    return res.json({ jobId, batchJobId: batchResult.jobId, status: "QUEUED" });
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
        step:        { S: "Job queued, waiting for worker..." },
        s3InputKey:  { S: s3Key },
        filename:    { S: typeof filename === "string" && filename.trim() ? filename.trim() : "uploaded-video.mp4" },
        targetLang:  { S: targetLang },
        targetLangCode: { S: targetLangCode },
        sourceLang:  { S: sourceLang },
        ownerId:     { S: ownerId },
        voiceClone:  { BOOL: Boolean(voiceClone) },
        lipSync:     { BOOL: Boolean(lipSync) },
        createdAt:   { N: String(now) },
        updatedAt:   { N: String(now) },
      },
    }));

    const envVars = [
      { name: "JOB_ID",            value: jobId },
      { name: "S3_BUCKET",         value: S3_BUCKET },
      { name: "S3_INPUT_KEY",      value: s3Key },
      { name: "S3_OUTPUT_PREFIX",  value: `translator-jobs/${jobId}` },
      { name: "DYNAMODB_TABLE",    value: DDB_TABLE },
      { name: "DYNAMODB_REGION",   value: REGION },
      { name: "GEMINI_API_KEY",    value: GEMINI_KEY },
      { name: "GEMINI_API_KEY_2",  value: GEMINI_KEY_2 },
      { name: "GEMINI_API_KEY_3",  value: GEMINI_KEY_3 },
      { name: "TARGET_LANG",       value: targetLang },
      { name: "TARGET_LANG_CODE",  value: targetLangCode },
      { name: "SOURCE_LANG",       value: sourceLang },
      { name: "VOICE_CLONE",       value: String(voiceClone) },
      { name: "LIP_SYNC",          value: String(lipSync) },
      { name: "LIP_SYNC_QUALITY",  value: lipSyncQuality },
      { name: "USE_DEMUCS",        value: String(useDemucs) },
      { name: "PREMIUM_ASR",       value: String(premiumAsr) },
      { name: "MULTI_SPEAKER",     value: String(multiSpeaker) },
      { name: "ASR_MODEL",         value: asrModel },
      { name: "TRANSLATION_MODE",  value: translationMode },
      { name: "ASSEMBLYAI_API_KEY", value: ASSEMBLYAI_KEY },
      { name: "MODEL_CACHE_DIR",   value: "/model-cache" },
    ];

    const { BatchClient, SubmitJobCommand: SJC } = await import("@aws-sdk/client-batch");
    const batchClient = new BatchClient({ region: REGION });
    const batchResult = await batchClient.send(new SJC({
      jobName:        `translator-${jobId.slice(0, 8)}`,
      jobQueue:       BATCH_QUEUE,
      jobDefinition:  BATCH_JOB_DEF,
      timeout:        { attemptDurationSeconds: TRANSLATOR_BATCH_TIMEOUT_SECONDS },
      containerOverrides: { environment: envVars },
    }));

    await ddb.send(new UpdateItemCommand({
      TableName: DDB_TABLE,
      Key: { jobId: { S: jobId } },
      UpdateExpression: "SET batchJobId = :batchJobId, timeoutSeconds = :timeoutSeconds, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":batchJobId": { S: String(batchResult.jobId) },
        ":timeoutSeconds": { N: String(TRANSLATOR_BATCH_TIMEOUT_SECONDS) },
        ":updatedAt": { N: String(Date.now()) },
      },
    }));

    console.log(`[Translator] submit-from-url: Batch job ${batchResult.jobId} for translator job ${jobId}`);
    return res.json({ jobId, batchJobId: batchResult.jobId, status: "QUEUED" });
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
