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

type QueueJobType =
  | "download"
  | "clip-cut"
  | "subtitles"
  | "best-clips"
  | "bhagwat-analyze"
  | "bhagwat-render";

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
  resultJson: string | null;
};

const PENDING_QUEUE_STATES = new Set([
  "pending",
  "queued",
  "running",
  "processing",
  "audio",
  "uploading",
  "transcribing",
  "correcting",
  "translating",
]);
const STALE_QUEUE_RECONCILE_MS = 90_000;

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

const ALL_JOB_TYPES: QueueJobType[] = [
  "download",
  "clip-cut",
  "subtitles",
  "best-clips",
  "bhagwat-analyze",
  "bhagwat-render",
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
  await ddb.send(
    new PutItemCommand({
      TableName: JOB_TABLE,
      Item: {
        jobId: { S: input.jobId },
        status: { S: "queued" },
        message: { S: mode === "primary" ? "Submitted by API (primary mode)" : "Submitted by API (shadow mode)" },
        createdAt: { N: String(now) },
        updatedAt: { N: String(now) },
      },
    }),
  );

  const submit = await batch.send(
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

  const batchJobId = submit.jobId ?? null;
  if (batchJobId) {
    await ddb.send(
      new PutItemCommand({
        TableName: JOB_TABLE,
        Item: {
          jobId: { S: input.jobId },
          status: { S: "queued" },
          message: {
            S: "Queued - starting soon...",
          },
          batchJobId: { S: batchJobId },
          createdAt: { N: String(now) },
          updatedAt: { N: String(Date.now()) },
        },
      }),
    );
  }
  return batchJobId;
}

export async function submitYoutubeQueueShadowJob(input: QueueSubmitInput): Promise<string | null> {
  return submitYoutubeQueueJob(input, "shadow");
}

export async function submitYoutubeQueuePrimaryJob(input: QueueSubmitInput): Promise<string | null> {
  return submitYoutubeQueueJob(input, "primary");
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
  const batchJobId = out.Item.batchJobId?.S ?? null;

  if (
    batch &&
    batchJobId &&
    updatedAt &&
    Date.now() - updatedAt >= STALE_QUEUE_RECONCILE_MS &&
    PENDING_QUEUE_STATES.has(status)
  ) {
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
        status = "done";
        message = message ?? "Completed";
      } else if (["SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"].includes(job.status ?? "")) {
        status = status === "queued" ? "queued" : "running";
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
          },
        }),
      );
      updatedAt = Date.now();
    } catch (err) {
      logger.warn({ err, jobId, batchJobId }, "Failed queue state reconciliation");
    }
  }

  return {
    status,
    message,
    updatedAt,
    batchJobId,
    filename: out.Item.filename?.S ?? null,
    filesize: out.Item.filesize?.N ? Number(out.Item.filesize.N) : null,
    s3Key: out.Item.s3Key?.S ?? null,
    originalS3Key: out.Item.originalS3Key?.S ?? null,
    originalFilename: out.Item.originalFilename?.S ?? null,
    durationSecs: out.Item.durationSecs?.N ? Number(out.Item.durationSecs.N) : null,
    progressPct: out.Item.progressPct?.N ? Number(out.Item.progressPct.N) : null,
    resultJson: out.Item.resultJson?.S ?? null,
  };
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
        ":s": { S: "cancelled" },
        ":m": { S: "Cancelled by user" },
        ":u": { N: String(Date.now()) },
      },
    }),
  );

  return { ok: true, status: "cancelled", batchJobId: status.batchJobId };
}
