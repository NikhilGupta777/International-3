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
        step:        { S: "Job queued, waiting for GPU..." },
        s3InputKey:  { S: s3Key },
        targetLang:  { S: targetLang },
        targetLangCode: { S: targetLangCode },
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
    const { jobId } = req.params;

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
      targetLang:   item.targetLang?.S,
      segmentCount: item.segmentCount ? parseInt(item.segmentCount.N!) : undefined,
      updatedAt:    item.updatedAt?.S,
      createdAt:    item.createdAt?.S,
    });
  } catch (err: any) {
    console.error("[Translator] /status error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /result/:jobId ────────────────────────────────────────────────────────
// Returns presigned GET URLs for the final output files.
router.get("/result/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

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

    return res.json({ jobId, videoUrl, srtUrl, transcriptUrl });
  } catch (err: any) {
    console.error("[Translator] /result error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
