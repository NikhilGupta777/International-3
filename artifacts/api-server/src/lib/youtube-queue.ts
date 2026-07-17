import { randomUUID } from "crypto";
import {
  SubmitJobCommand,
  BatchClient,
  TerminateJobCommand,
  DescribeJobsCommand,
} from "@aws-sdk/client-batch";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { logger } from "./logger";
import { maybeFireJobWebhook, isTerminalStatus } from "./webhooks";

type QueueJobType =
  | "download"
  | "clip-cut"
  | "subtitles"
  | "best-clips"
  | "bhagwat-analyze"
  | "bhagwat-render"
  | "editor-render";

type QueuePayload = {
  jobId: string;
  jobType: QueueJobType;
  sourceUrl: string;
  requestedAt: number;
  meta?: Record<string, unknown>;
};

type QueueSubmitInput = {
  jobId: string;
  jobType: QueueJobType;
  sourceUrl: string;
  meta?: Record<string, unknown>;
};

type QueueStatus = {
  status: string;
  message: string | null;
  updatedAt: number | null;
  batchJobId: string | null;
  filename: string | null;
  filesize: number | null;
  s3Key: string | null;
  originalS3Key: string | null;
  originalFilename: string | null;
  durationSecs: number | null;
  progressPct: number | null;
  progressLine: string | null;
  progressSource: string | null;
  speed: string | null;
  eta: string | null;
  startedAt: number | null;
  completedAt: number | null;
  resultJson: string | null;
};

const PENDING_QUEUE_STATES = new Set([
  "pending",
  "queued",
  "downloading",
  "running",
  "processing",
  "audio",
  "uploading",
  "transcribing",
  "generating",
  "correcting",
  "translating",
  "verifying",
]);
const STALE_QUEUE_RECONCILE_MS = 90_000;
const LOCAL_CLIP_STALE_MS =
  Math.max(
    60_000,
    Number.parseInt(process.env.LAMBDA_CLIP_COMMAND_TIMEOUT_MS ?? "840000", 10) || 840_000,
  ) + 120_000;

function envBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

const REGION = process.env.YOUTUBE_QUEUE_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const SHADOW_ENABLED = envBool(process.env.YOUTUBE_QUEUE_SHADOW_ENABLED);
const PRIMARY_ENABLED = envBool(process.env.YOUTUBE_QUEUE_PRIMARY_ENABLED);
const ENABLED = SHADOW_ENABLED || PRIMARY_ENABLED;
const JOB_TABLE = process.env.YOUTUBE_QUEUE_JOB_TABLE ?? process.env.JOB_TABLE ?? "";
const JOB_QUEUE = process.env.YOUTUBE_BATCH_JOB_QUEUE ?? "";
const JOB_DEFINITION = process.env.YOUTUBE_BATCH_JOB_DEFINITION ?? "";

const ddb = JOB_TABLE ? new DynamoDBClient({ region: REGION }) : null;
const batch = JOB_QUEUE && JOB_DEFINITION ? new BatchClient({ region: REGION }) : null;
const CLIP_WORKER_LEASE_KEY = "__clipcut_worker_leases__";

const ALL_JOB_TYPES: QueueJobType[] = [
  "download",
  "clip-cut",
  "subtitles",
  "best-clips",
  "bhagwat-analyze",
  "bhagwat-render",
  "editor-render",
];

function parseJobTypeList(value: string | undefined): Set<QueueJobType> | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const out = new Set<QueueJobType>();
  for (const part of parts) {
    if ((ALL_JOB_TYPES as string[]).includes(part)) {
      out.add(part as QueueJobType);
    }
  }
  return out.size > 0 ? out : null;
}

const DEFAULT_PRIMARY_JOB_TYPES = new Set<QueueJobType>(["clip-cut"]);
const DEFAULT_SHADOW_JOB_TYPES = new Set<QueueJobType>(["download", "clip-cut"]);

const PRIMARY_JOB_TYPES =
  parseJobTypeList(process.env.YOUTUBE_QUEUE_PRIMARY_JOB_TYPES) ??
  DEFAULT_PRIMARY_JOB_TYPES;
const SHADOW_JOB_TYPES =
  parseJobTypeList(process.env.YOUTUBE_QUEUE_SHADOW_JOB_TYPES) ??
  DEFAULT_SHADOW_JOB_TYPES;

function isQueueModeEnabledFor(mode: "shadow" | "primary", jobType: QueueJobType): boolean {
  if (mode === "primary") {
    return PRIMARY_ENABLED && PRIMARY_JOB_TYPES.has(jobType);
  }
  return SHADOW_ENABLED && SHADOW_JOB_TYPES.has(jobType);
}

export function isYoutubeQueueShadowEnabled(): boolean {
  return SHADOW_ENABLED;
}

export function isYoutubeQueuePrimaryEnabled(): boolean {
  return PRIMARY_ENABLED;
}

export function isYoutubeQueueEnabled(): boolean {
  return ENABLED;
}

export function isYoutubeQueueShadowEnabledFor(jobType: QueueJobType): boolean {
  return isQueueModeEnabledFor("shadow", jobType);
}

export function isYoutubeQueuePrimaryEnabledFor(jobType: QueueJobType): boolean {
  return isQueueModeEnabledFor("primary", jobType);
}

export function isYoutubeQueueEnabledFor(jobType: QueueJobType): boolean {
  return isYoutubeQueueShadowEnabledFor(jobType) || isYoutubeQueuePrimaryEnabledFor(jobType);
}

async function submitYoutubeQueueJob(
  input: QueueSubmitInput,
  mode: "shadow" | "primary",
): Promise<string | null> {
  if (!isQueueModeEnabledFor(mode, input.jobType)) return null;
  if (!ENABLED) return null;

  if (!ddb || !batch || !JOB_TABLE || !JOB_QUEUE || !JOB_DEFINITION) {
    logger.warn(
      {
        enabled: ENABLED,
        shadowEnabled: SHADOW_ENABLED,
        primaryEnabled: PRIMARY_ENABLED,
        hasDdb: !!ddb,
        hasBatch: !!batch,
        hasJobTable: !!JOB_TABLE,
        hasJobQueue: !!JOB_QUEUE,
        hasJobDefinition: !!JOB_DEFINITION,
      },
      "YouTube queue mode enabled but queue config is incomplete",
    );
    return null;
  }

  const payload: QueuePayload = {
    jobId: input.jobId,
    jobType: input.jobType,
    sourceUrl: input.sourceUrl,
    requestedAt: Date.now(),
    meta: input.meta,
  };

  const now = Date.now();
  const startSec =
    typeof input.meta?.startSec === "number"
      ? input.meta.startSec
      : typeof input.meta?.startTime === "number"
        ? input.meta.startTime
        : null;
  const endSec =
    typeof input.meta?.endSec === "number"
      ? input.meta.endSec
      : typeof input.meta?.endTime === "number"
        ? input.meta.endTime
        : null;
  const durationSecs =
    typeof startSec === "number" && typeof endSec === "number" && Number.isFinite(endSec - startSec)
      ? Math.max(0, endSec - startSec)
      : typeof input.meta?.durationSecs === "number" && Number.isFinite(input.meta.durationSecs)
        ? Math.max(0, input.meta.durationSecs)
      : null;
  await ddb.send(
    new PutItemCommand({
      TableName: JOB_TABLE,
      Item: {
        jobId: { S: input.jobId },
        jobType: { S: input.jobType },
        sourceUrl: { S: input.sourceUrl },
        status: { S: "queued" },
        message: { S: mode === "primary" ? "Submitted by API (primary mode)" : "Submitted by API (shadow mode)" },
        createdAt: { N: String(now) },
        updatedAt: { N: String(now) },
        ...(durationSecs != null ? { durationSecs: { N: String(durationSecs) } } : {}),
      },
    }),
  );

  let submit;
  try {
    submit = await batch.send(
      new SubmitJobCommand({
      jobName: `yt-${mode}-${input.jobType}-${Date.now()}`,
      jobQueue: JOB_QUEUE,
      jobDefinition: JOB_DEFINITION,
      containerOverrides: {
        environment: [
          { name: "JOB_PAYLOAD", value: JSON.stringify(payload) },
          { name: "JOB_TABLE", value: JOB_TABLE },
          { name: "AWS_REGION", value: REGION },
          { name: "QUEUE_MODE", value: mode },
          { name: "QUEUE_INVOCATION_ID", value: randomUUID() },
        ],
      },
      }),
    );
  } catch (err) {
    await updateYoutubeQueueLocalJob(input.jobId, {
      status: "error",
      message: err instanceof Error ? `Background submission failed: ${err.message}` : "Background submission failed",
      completedAt: Date.now(),
    });
    throw err;
  }

  const batchJobId = submit.jobId ?? null;
  if (!batchJobId) {
    await updateYoutubeQueueLocalJob(input.jobId, {
      status: "error",
      message: "Background worker did not accept the job. Please retry.",
      completedAt: Date.now(),
    });
    throw new Error("AWS Batch accepted the request without returning a job ID");
  }
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: input.jobId } },
      UpdateExpression: "SET #s = :queued, #m = :message, batchJobId = :batchJobId, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#s": "status", "#m": "message" },
      ExpressionAttributeValues: {
        ":queued": { S: "queued" },
        ":message": { S: "Queued - starting soon..." },
        ":batchJobId": { S: batchJobId },
        ":updatedAt": { N: String(Date.now()) },
        ":done": { S: "done" },
        ":error": { S: "error" },
        ":cancelled": { S: "cancelled" },
        ":expired": { S: "expired" },
      },
      ConditionExpression: "attribute_exists(jobId) AND NOT (#s IN (:done, :error, :cancelled, :expired))",
    }));
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      await batch.send(new TerminateJobCommand({
        jobId: batchJobId,
        reason: "Job became terminal before Batch submission completed",
      })).catch((terminateErr) => logger.warn({ err: terminateErr, batchJobId }, "Failed to terminate rejected Batch job"));
      return null;
    }
    throw err;
  }
  return batchJobId;
}

export async function submitYoutubeQueueShadowJob(input: QueueSubmitInput): Promise<string | null> {
  return submitYoutubeQueueJob(input, "shadow");
}

export async function submitYoutubeQueuePrimaryJob(input: QueueSubmitInput): Promise<string | null> {
  return submitYoutubeQueueJob(input, "primary");
}

/**
 * Move an already-persisted Lambda clip job to the primary Batch queue without
 * replacing its original creation metadata. This is used by the adaptive
 * Lambda fast path when observed ffmpeg speed cannot finish safely before the
 * Lambda deadline.
 */
export async function handoffYoutubeQueuePrimaryJob(input: QueueSubmitInput): Promise<string | null> {
  if (!isQueueModeEnabledFor("primary", input.jobType)) return null;
  if (!ddb || !batch || !JOB_TABLE || !JOB_QUEUE || !JOB_DEFINITION) return null;

  const payload: QueuePayload = {
    jobId: input.jobId,
    jobType: input.jobType,
    sourceUrl: input.sourceUrl,
    requestedAt: Date.now(),
    meta: input.meta,
  };
  const submit = await batch.send(new SubmitJobCommand({
    jobName: `yt-handoff-${input.jobType}-${Date.now()}`,
    jobQueue: JOB_QUEUE,
    jobDefinition: JOB_DEFINITION,
    containerOverrides: {
      environment: [
        { name: "JOB_PAYLOAD", value: JSON.stringify(payload) },
        { name: "JOB_TABLE", value: JOB_TABLE },
        { name: "AWS_REGION", value: REGION },
        { name: "QUEUE_MODE", value: "primary" },
        { name: "QUEUE_INVOCATION_ID", value: randomUUID() },
      ],
    },
  }));
  const batchJobId = submit.jobId ?? null;
  if (!batchJobId) return null;

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: input.jobId } },
      UpdateExpression:
        "SET #s = :queued, #m = :message, batchJobId = :batchJobId, updatedAt = :updatedAt, progressPct = :progressPct",
      ExpressionAttributeNames: { "#s": "status", "#m": "message" },
      ExpressionAttributeValues: {
        ":queued": { S: "queued" },
        ":message": { S: "Taking longer than expected - continuing in background..." },
        ":batchJobId": { S: batchJobId },
        ":updatedAt": { N: String(Date.now()) },
        ":progressPct": { N: "0" },
        ":done": { S: "done" },
        ":error": { S: "error" },
        ":cancelled": { S: "cancelled" },
        ":expired": { S: "expired" },
      },
      ConditionExpression: "attribute_not_exists(#s) OR NOT (#s IN (:done, :error, :cancelled, :expired))",
    }));
  } catch (err) {
    const conditionalFailure =
      (err as { name?: string })?.name === "ConditionalCheckFailedException";
    try {
      await batch.send(new TerminateJobCommand({
        jobId: batchJobId,
        reason: conditionalFailure
          ? "Clip job became terminal before adaptive handoff completed"
          : "Failed to persist adaptive clip handoff",
      }));
    } catch (terminateErr) {
      logger.warn(
        { err: terminateErr, jobId: input.jobId, batchJobId },
        "Failed to terminate rejected handoff job",
      );
    }
    if (conditionalFailure) return null;
    throw err;
  }
  return batchJobId;
}

async function submitEditorRenderJobDurable(input: {
  jobId: string;
  workspaceId: string;
  projectId: string;
  kind: "preview" | "final";
}): Promise<string | null> {
  if (!ddb || !batch || !JOB_TABLE || !JOB_QUEUE || !JOB_DEFINITION) return null;

  const payload: QueuePayload = {
    jobId: input.jobId,
    jobType: "editor-render",
    sourceUrl: `editor://${input.projectId}/${input.kind}`,
    requestedAt: Date.now(),
    meta: { workspaceId: input.workspaceId, projectId: input.projectId, kind: input.kind },
  };
  const now = Date.now();
  await ddb.send(new PutItemCommand({
    TableName: JOB_TABLE,
    Item: {
      jobId: { S: input.jobId },
      jobType: { S: "editor-render" },
      sourceUrl: { S: payload.sourceUrl },
      status: { S: "queued" },
      message: { S: "Submitting editor render..." },
      createdAt: { N: String(now) },
      updatedAt: { N: String(now) },
    },
  }));

  let submit;
  try {
    submit = await batch.send(new SubmitJobCommand({
      jobName: `editor-${input.kind}-${Date.now()}`,
      jobQueue: JOB_QUEUE,
      jobDefinition: process.env.VIDEO_EDITOR_BATCH_JOB_DEFINITION || JOB_DEFINITION,
      containerOverrides: {
        environment: [
          { name: "JOB_PAYLOAD", value: JSON.stringify(payload) },
          { name: "JOB_TABLE", value: JOB_TABLE },
          { name: "AWS_REGION", value: REGION },
          { name: "QUEUE_MODE", value: "primary" },
          { name: "QUEUE_INVOCATION_ID", value: randomUUID() },
        ],
      },
    }));
  } catch (err) {
    await ddb.send(new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: input.jobId } },
      UpdateExpression: "SET #s = :s, #m = :m, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#s": "status", "#m": "message" },
      ExpressionAttributeValues: {
        ":s": { S: "error" },
        ":m": { S: err instanceof Error ? `Batch submission failed: ${err.message}` : "Batch submission failed" },
        ":updatedAt": { N: String(Date.now()) },
      },
    }));
    throw err;
  }

  const batchJobId = submit.jobId ?? null;
  if (batchJobId) {
    await ddb.send(new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: input.jobId } },
      UpdateExpression: "SET #m = :m, batchJobId = :batchJobId, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#m": "message" },
      ExpressionAttributeValues: {
        ":m": { S: "Queued - starting soon..." },
        ":batchJobId": { S: batchJobId },
        ":updatedAt": { N: String(Date.now()) },
      },
    }));
  }
  return batchJobId;
}

/**
 * Submit an editor render job to Batch. Independent of the youtube
 * primary/shadow allowlist; gated on its own env flag, but shares the same
 * Batch queue/definition and DynamoDB jobs table.
 */
export async function submitEditorRenderJob(input: {
  jobId: string;
  workspaceId: string;
  projectId: string;
  kind: "preview" | "final";
}): Promise<string | null> {
  if (!ddb || !batch || !JOB_TABLE || !JOB_QUEUE || !JOB_DEFINITION) {
    logger.warn(
      { hasDdb: !!ddb, hasBatch: !!batch, hasJobTable: !!JOB_TABLE, hasJobQueue: !!JOB_QUEUE, hasJobDefinition: !!JOB_DEFINITION },
      "[editor-render] queue config incomplete",
    );
    return null;
  }
  return submitEditorRenderJobDurable(input);
}

// ─── Editor render via Lambda self-invoke worker (fast path) ──────────────────
// These let the editor run renders on a worker Lambda (near-instant start) and
// report progress through the same DynamoDB jobs table that getJobStatusFromDdb
// reads — so the frontend polls identically whether the render ran on Lambda or
// Batch. Returns false when DDB isn't configured (local dev → in-process render).
export function isEditorDdbConfigured(): boolean {
  return !!(ddb && JOB_TABLE);
}

export async function putEditorJobQueued(jobId: string, projectId: string, kind: "preview" | "final"): Promise<boolean> {
  if (!ddb || !JOB_TABLE) return false;
  const now = Date.now();
  await ddb.send(new PutItemCommand({
    TableName: JOB_TABLE,
    Item: {
      jobId: { S: jobId },
      jobType: { S: "editor-render" },
      sourceUrl: { S: `editor://${projectId}/${kind}` },
      status: { S: "queued" },
      message: { S: "Starting render..." },
      progressPct: { N: "1" },
      createdAt: { N: String(now) },
      updatedAt: { N: String(now) },
    },
  }));
  return true;
}

export async function updateEditorJobStatus(
  jobId: string,
  patch: { status?: string; message?: string; progressPct?: number; s3Key?: string },
): Promise<void> {
  if (!ddb || !JOB_TABLE) return;
  const sets: string[] = ["updatedAt = :updatedAt"];
  const names: Record<string, string> = {};
  const values: Record<string, any> = { ":updatedAt": { N: String(Date.now()) } };
  if (patch.status !== undefined) { sets.push("#s = :s"); names["#s"] = "status"; values[":s"] = { S: patch.status }; }
  if (patch.message !== undefined) { sets.push("#m = :m"); names["#m"] = "message"; values[":m"] = { S: patch.message }; }
  if (patch.progressPct !== undefined) { sets.push("progressPct = :p"); values[":p"] = { N: String(Math.round(patch.progressPct)) }; }
  if (patch.s3Key !== undefined) { sets.push("s3Key = :k"); values[":k"] = { S: patch.s3Key }; }
  await ddb.send(new UpdateItemCommand({
    TableName: JOB_TABLE,
    Key: { jobId: { S: jobId } },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));
}

export async function getJobStatusFromDdb(jobId: string): Promise<{
  status: string;
  message: string;
  progressPct: number | null;
  s3Key: string | null;
  batchJobId: string | null;
} | null> {
  if (!ddb || !JOB_TABLE) return null;
  const resp = await ddb.send(new GetItemCommand({ TableName: JOB_TABLE, Key: { jobId: { S: jobId } } }));
  if (!resp.Item) return null;
  return {
    status: resp.Item.status?.S ?? "queued",
    message: resp.Item.message?.S ?? "",
    progressPct: resp.Item.progressPct ? Number(resp.Item.progressPct.N) : null,
    s3Key: resp.Item.s3Key?.S ?? null,
    batchJobId: resp.Item.batchJobId?.S ?? null,
  };
}

export async function putYoutubeQueueLocalJob(input: {
  jobId: string;
  status: string;
  message: string;
  jobType?: QueueJobType;
  sourceUrl?: string;
  progressPct?: number;
  filename?: string | null;
  filesize?: number | null;
  s3Key?: string | null;
  durationSecs?: number | null;
  progressLine?: string | null;
  progressSource?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
}): Promise<boolean> {
  if (!ddb || !JOB_TABLE) return false;
  const now = Date.now();
  const item: Record<string, any> = {
    jobId: { S: input.jobId },
    status: { S: input.status },
    message: { S: input.message },
    createdAt: { N: String(now) },
    updatedAt: { N: String(now) },
  };
  if (input.jobType) item.jobType = { S: input.jobType };
  if (input.sourceUrl) item.sourceUrl = { S: input.sourceUrl };
  if (typeof input.progressPct === "number") item.progressPct = { N: String(input.progressPct) };
  if (input.filename) item.filename = { S: input.filename };
  if (typeof input.filesize === "number") item.filesize = { N: String(input.filesize) };
  if (input.s3Key) item.s3Key = { S: input.s3Key };
  if (typeof input.durationSecs === "number") item.durationSecs = { N: String(input.durationSecs) };
  if (input.progressLine) item.progressLine = { S: input.progressLine };
  if (input.progressSource) item.progressSource = { S: input.progressSource };
  if (typeof input.startedAt === "number") item.startedAt = { N: String(input.startedAt) };
  if (typeof input.completedAt === "number") item.completedAt = { N: String(input.completedAt) };
  await ddb.send(new PutItemCommand({ TableName: JOB_TABLE, Item: item }));
  return true;
}

export async function updateYoutubeQueueLocalJob(
  jobId: string,
  fields: {
    status?: string;
    message?: string | null;
    progressPct?: number | null;
    filename?: string | null;
    filesize?: number | null;
    s3Key?: string | null;
    durationSecs?: number | null;
    progressLine?: string | null;
    progressSource?: string | null;
    speed?: string | null;
    eta?: string | null;
    startedAt?: number | null;
    completedAt?: number | null;
    resultJson?: string | null;
  },
): Promise<boolean> {
  if (!ddb || !JOB_TABLE) return false;
  const names: Record<string, string> = { "#u": "updatedAt" };
  const values: Record<string, any> = { ":u": { N: String(Date.now()) } };
  const sets = ["#u = :u"];

  const addString = (name: string, value: string | null | undefined) => {
    if (value === undefined) return;
    names[`#${name}`] = name;
    values[`:${name}`] = { S: value ?? "" };
    sets.push(`#${name} = :${name}`);
  };
  const addNumber = (name: string, value: number | null | undefined) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return;
    names[`#${name}`] = name;
    values[`:${name}`] = { N: String(value) };
    sets.push(`#${name} = :${name}`);
  };

  addString("status", fields.status);
  addString("message", fields.message);
  addNumber("progressPct", fields.progressPct);
  addString("filename", fields.filename);
  addNumber("filesize", fields.filesize);
  addString("s3Key", fields.s3Key);
  addNumber("durationSecs", fields.durationSecs);
  addString("progressLine", fields.progressLine);
  addString("progressSource", fields.progressSource);
  addString("speed", fields.speed);
  addString("eta", fields.eta);
  addNumber("startedAt", fields.startedAt);
  addNumber("completedAt", fields.completedAt);
  addString("resultJson", fields.resultJson);

  const nextStatus = fields.status;
  if (nextStatus) {
    names["#statusGuard"] = "status";
    values[":terminalDone"] = { S: "done" };
    values[":terminalError"] = { S: "error" };
    values[":terminalCancelled"] = { S: "cancelled" };
    values[":terminalExpired"] = { S: "expired" };
    values[":nextStatus"] = { S: nextStatus };
  }

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: jobId } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(nextStatus
        ? {
            ConditionExpression:
              "attribute_not_exists(#statusGuard) OR NOT (#statusGuard IN (:terminalDone, :terminalError, :terminalCancelled, :terminalExpired)) OR #statusGuard = :nextStatus",
          }
        : {}),
    }));
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
  // Fire a completion webhook if one is registered and this write is terminal.
  if (fields.status && isTerminalStatus(fields.status)) {
    void maybeFireJobWebhook(jobId, fields.status, { message: fields.message ?? null });
  }
  return true;
}

export async function getYoutubeQueueJobStatus(jobId: string): Promise<QueueStatus | null> {
  if (!ENABLED || !ddb || !JOB_TABLE) return null;
  const out = await ddb.send(
    new GetItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: jobId } },
      ConsistentRead: true,
    }),
  );
  if (!out.Item) return null;

  let status = out.Item.status?.S ?? "pending";
  let message = out.Item.message?.S ?? null;
  let updatedAt = out.Item.updatedAt?.N ? Number(out.Item.updatedAt.N) : null;
  const createdAt = out.Item.createdAt?.N ? Number(out.Item.createdAt.N) : null;
  const jobType = out.Item.jobType?.S ?? null;
  const batchJobId = out.Item.batchJobId?.S ?? null;
  const s3Key = out.Item.s3Key?.S ?? null;

  if (
    jobType === "clip-cut" &&
    !batchJobId &&
    createdAt &&
    Date.now() - createdAt >= LOCAL_CLIP_STALE_MS &&
    PENDING_QUEUE_STATES.has(status)
  ) {
    const observedStatus = status;
    const observedUpdatedAt = updatedAt;
    status = "error";
    message = "Clip cut timed out in Lambda. Please retry with a shorter section or try again.";
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: JOB_TABLE,
          Key: { jobId: { S: jobId } },
          UpdateExpression: "SET #s = :s, #m = :m, #u = :u, progressPct = :p",
          ExpressionAttributeNames: {
            "#s": "status",
            "#m": "message",
            "#u": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":s": { S: status },
            ":m": { S: message },
            ":u": { N: String(Date.now()) },
            ":p": { N: "0" },
            ":observedStatus": { S: observedStatus },
            ...(observedUpdatedAt != null
              ? { ":observedUpdatedAt": { N: String(observedUpdatedAt) } }
              : {}),
          },
          ConditionExpression: observedUpdatedAt != null
            ? "#s = :observedStatus AND #u = :observedUpdatedAt"
            : "#s = :observedStatus AND attribute_not_exists(#u)",
        }),
      );
      updatedAt = Date.now();
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return getYoutubeQueueJobStatus(jobId);
      }
      logger.warn({ err, jobId }, "Failed to mark stale local clip job");
    }
  }

  if (
    batch &&
    batchJobId &&
    updatedAt &&
    Date.now() - updatedAt >= STALE_QUEUE_RECONCILE_MS &&
    PENDING_QUEUE_STATES.has(status)
  ) {
    const observedStatus = status;
    const observedUpdatedAt = updatedAt;
    try {
      const desc = await batch.send(
        new DescribeJobsCommand({
          jobs: [batchJobId],
        }),
      );
      const job = desc.jobs?.[0];
      if (!job) {
        status = "error";
        message = "Queue job missing. Please retry.";
      } else if (job.status === "FAILED") {
        status = "error";
        message =
          job.statusReason ??
          job.attempts?.[job.attempts.length - 1]?.statusReason ??
          "Queue job failed";
      } else if (job.status === "SUCCEEDED" && status !== "done") {
        if (s3Key) {
          status = "done";
          message = message ?? "Completed";
        } else {
          status = "error";
          message = "Queue job finished but no downloadable file was produced. Please retry.";
        }
      } else if (["SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"].includes(job.status ?? "")) {
        const batchState = job.status ?? "";
        const previousStatus = status;
        if (batchState === "STARTING") {
          status = "running";
          message = "Worker container is starting...";
        } else if (batchState === "RUNNING") {
          status = "running";
          message = previousStatus === "queued" ? "Worker is processing the job..." : (message ?? "Worker is processing the job...");
        } else {
          status = "queued";
          message = batchState === "RUNNABLE"
            ? "Waiting for Fargate capacity..."
            : "Queued - starting soon...";
        }
      }

      await ddb.send(
        new UpdateItemCommand({
          TableName: JOB_TABLE,
          Key: { jobId: { S: jobId } },
          UpdateExpression: "SET #s = :s, #m = :m, #u = :u",
          ExpressionAttributeNames: {
            "#s": "status",
            "#m": "message",
            "#u": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":s": { S: status },
            ":m": { S: message ?? status },
            ":u": { N: String(Date.now()) },
            ":observedStatus": { S: observedStatus },
            ":observedUpdatedAt": { N: String(observedUpdatedAt) },
          },
          ConditionExpression: "#s = :observedStatus AND #u = :observedUpdatedAt",
        }),
      );
      updatedAt = Date.now();
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return getYoutubeQueueJobStatus(jobId);
      }
      logger.warn({ err, jobId, batchJobId }, "Failed queue state reconciliation");
    }
  }

  if (isTerminalStatus(status)) {
    void maybeFireJobWebhook(jobId, status, { message });
  }
  return {
    status,
    message,
    updatedAt,
    batchJobId,
    filename: out.Item.filename?.S ?? null,
    filesize: out.Item.filesize?.N ? Number(out.Item.filesize.N) : null,
    s3Key,
    originalS3Key: out.Item.originalS3Key?.S ?? null,
    originalFilename: out.Item.originalFilename?.S ?? null,
    durationSecs: out.Item.durationSecs?.N ? Number(out.Item.durationSecs.N) : null,
    progressPct: out.Item.progressPct?.N ? Number(out.Item.progressPct.N) : null,
    progressLine: out.Item.progressLine?.S ?? null,
    progressSource: out.Item.progressSource?.S ?? null,
    speed: out.Item.speed?.S || null,
    eta: out.Item.eta?.S || null,
    startedAt: out.Item.startedAt?.N ? Number(out.Item.startedAt.N) : null,
    completedAt: out.Item.completedAt?.N ? Number(out.Item.completedAt.N) : null,
    resultJson: out.Item.resultJson?.S ?? null,
  };
}

export async function isYoutubeQueueJobCancelled(jobId: string): Promise<boolean> {
  if (!ddb || !JOB_TABLE) return false;
  const out = await ddb.send(new GetItemCommand({
    TableName: JOB_TABLE,
    Key: { jobId: { S: jobId } },
    ProjectionExpression: "#s",
    ExpressionAttributeNames: { "#s": "status" },
    ConsistentRead: true,
  }));
  return out.Item?.status?.S === "cancelled";
}

type ClipWorkerLeases = Record<string, number>;

async function mutateClipWorkerLeases(
  mutate: (leases: ClipWorkerLeases, now: number) => { changed: boolean; acquired?: boolean },
): Promise<boolean> {
  if (!ddb || !JOB_TABLE) return true;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await ddb.send(new GetItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: CLIP_WORKER_LEASE_KEY } },
      ConsistentRead: true,
    }));
    const revision = current.Item?.revision?.N ? Number(current.Item.revision.N) : 0;
    let leases: ClipWorkerLeases = {};
    try {
      const parsed = JSON.parse(current.Item?.leasesJson?.S ?? "{}");
      if (parsed && typeof parsed === "object") leases = parsed as ClipWorkerLeases;
    } catch {}
    const now = Date.now();
    for (const [id, expiresAt] of Object.entries(leases)) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) delete leases[id];
    }
    const result = mutate(leases, now);
    if (!result.changed) return result.acquired ?? true;
    try {
      await ddb.send(new PutItemCommand({
        TableName: JOB_TABLE,
        Item: {
          jobId: { S: CLIP_WORKER_LEASE_KEY },
          status: { S: "control" },
          leasesJson: { S: JSON.stringify(leases) },
          revision: { N: String(revision + 1) },
          updatedAt: { N: String(now) },
        },
        ConditionExpression: current.Item
          ? "#revision = :revision"
          : "attribute_not_exists(#jobId)",
        ExpressionAttributeNames: current.Item
          ? { "#revision": "revision" }
          : { "#jobId": "jobId" },
        ...(current.Item
          ? { ExpressionAttributeValues: { ":revision": { N: String(revision) } } }
          : {}),
      }));
      return result.acquired ?? true;
    } catch (err) {
      if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
    }
  }
  throw new Error("Could not update ClipCut worker lease after repeated contention");
}

export async function acquireClipWorkerLease(
  jobId: string,
  maxConcurrent: number,
  leaseMs = 17 * 60 * 1000,
): Promise<boolean> {
  return mutateClipWorkerLeases((leases, now) => {
    if (leases[jobId]) return { changed: false, acquired: true };
    if (Object.keys(leases).length >= Math.max(1, maxConcurrent)) {
      return { changed: false, acquired: false };
    }
    leases[jobId] = now + leaseMs;
    return { changed: true, acquired: true };
  });
}

export async function releaseClipWorkerLease(jobId: string): Promise<void> {
  await mutateClipWorkerLeases((leases) => {
    if (!leases[jobId]) return { changed: false };
    delete leases[jobId];
    return { changed: true };
  });
}

export async function cancelYoutubeQueueJob(
  jobId: string,
): Promise<{ ok: boolean; status: string; batchJobId: string | null; alreadyFinished?: boolean }> {
  const status = await getYoutubeQueueJobStatus(jobId);
  if (!status || !ddb || !JOB_TABLE) {
    return { ok: false, status: "not-found", batchJobId: null };
  }

  if (["done", "error", "expired", "cancelled"].includes(status.status)) {
    return {
      ok: true,
      status: status.status,
      batchJobId: status.batchJobId,
      alreadyFinished: true,
    };
  }

  const cancelled = await updateYoutubeQueueLocalJob(jobId, {
    status: "cancelled",
    message: "Cancelled by user",
    completedAt: Date.now(),
  });
  if (!cancelled) {
    const latest = await getYoutubeQueueJobStatus(jobId);
    return {
      ok: !!latest,
      status: latest?.status ?? "not-found",
      batchJobId: latest?.batchJobId ?? status.batchJobId,
      alreadyFinished: true,
    };
  }

  if (status.batchJobId && batch) {
    try {
      await batch.send(
        new TerminateJobCommand({
          jobId: status.batchJobId,
          reason: "Cancelled by user",
        }),
      );
    } catch (err) {
      logger.warn({ err, jobId, batchJobId: status.batchJobId }, "Failed to terminate queue batch job");
    }
  }

  return { ok: true, status: "cancelled", batchJobId: status.batchJobId };
}
