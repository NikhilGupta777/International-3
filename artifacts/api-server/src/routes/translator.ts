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
} from "@aws-sdk/client-dynamodb";
import {
  BatchClient,
  SubmitJobCommand,
} from "@aws-sdk/client-batch";
import { randomUUID } from "crypto";

const router = Router();

const REGION       = process.env.YOUTUBE_QUEUE_REGION ?? "us-east-1";
const S3_BUCKET    = process.env.S3_BUCKET!;
const DDB_TABLE    = process.env.YOUTUBE_QUEUE_JOB_TABLE!;
const BATCH_QUEUE  = process.env.TRANSLATOR_BATCH_JOB_QUEUE!;
const BATCH_JOB_DEF = process.env.TRANSLATOR_BATCH_JOB_DEFINITION!;
const GEMINI_KEY   = process.env.GEMINI_API_KEY ?? "";
const GEMINI_KEY_2 = process.env.GEMINI_API_KEY_2 ?? "";
const GEMINI_KEY_3 = process.env.GEMINI_API_KEY_3 ?? "";

const s3    = new S3Client({ region: REGION });
const ddb   = new DynamoDBClient({ region: REGION });
const batch = new BatchClient({ region: REGION });

function shareUrl(req: Request, jobId: string): string {
  return `${req.protocol}://${req.get("host")}/api/translator/share/${encodeURIComponent(jobId)}`;
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
    const {
      jobId,
      s3Key,
      targetLang     = "Hindi",
      targetLangCode = "hi",
      sourceLang     = "auto",
      voiceClone     = true,
      lipSync        = false,
      lipSyncQuality = "musetalk",
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
      { name: "MODEL_CACHE_DIR",   value: "/model-cache" },
    ];

    // Submit AWS Batch job
    const batchResult = await batch.send(new SubmitJobCommand({
      jobName:          `translator-${jobId.slice(0, 8)}`,
      jobQueue:         BATCH_QUEUE,
      jobDefinition:    BATCH_JOB_DEF,
      containerOverrides: {
        environment: envVars,
      },
    }));

    console.log(`[Translator] Submitted Batch job ${batchResult.jobId} for translator job ${jobId}`);

    return res.json({ jobId, batchJobId: batchResult.jobId, status: "QUEUED" });
  } catch (err: any) {
    console.error("[Translator] /submit error:", err);
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

    const item = result.Item;
    return res.json({
      jobId,
      status:       item.status?.S ?? "UNKNOWN",
      progress:     parseInt(item.progress?.N ?? "0"),
      step:         item.step?.S ?? "",
      error:        item.error?.S,
      filename:     item.filename?.S,
      targetLang:   item.targetLang?.S,
      targetLangCode: item.targetLangCode?.S,
      sourceLang:   item.sourceLang?.S,
      voiceClone:   item.voiceClone?.BOOL,
      lipSync:      item.lipSync?.BOOL,
      segmentCount: item.segmentCount ? parseInt(item.segmentCount.N!) : undefined,
      updatedAt:    item.updatedAt?.N ? parseInt(item.updatedAt.N) : item.updatedAt?.S,
      createdAt:    item.createdAt?.N ? parseInt(item.createdAt.N) : item.createdAt?.S,
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
    const limitParam = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, limitParam)) : 20;

    const items = [];
    let exclusiveStartKey: Record<string, any> | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await ddb.send(new ScanCommand({
        TableName: DDB_TABLE,
        FilterExpression: "#type = :type",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: { ":type": { S: "translator" } },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
      if (!exclusiveStartKey || items.length >= 200) break;
    }

    const jobs = items
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
        createdAt: item.createdAt?.N ? parseInt(item.createdAt.N) : undefined,
        updatedAt: item.updatedAt?.N ? parseInt(item.updatedAt.N) : item.updatedAt?.S,
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
