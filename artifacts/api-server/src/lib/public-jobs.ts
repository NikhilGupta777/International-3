import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Public job registry
//
// Every job created through the public /api/v1 surface is recorded here so the
// unified endpoints (`GET /api/v1/jobs/{id}`, `…/events`, `…/cancel`) work for
// EVERY operation — not just the ones that happen to persist to the shared
// YouTube job table. The registry records:
//   - which v1 operation produced the job (so results can be shaped correctly),
//   - the canonical status / stream / cancel paths to route to,
//   - the owning API key (so one key cannot read or cancel another key's jobs).
//
// Storage reuses the existing table (API_KEYS_TABLE or ACCESS_TABLE) — no new
// infrastructure. Each job is one item: pk = "pubjob#<jobId>", sk = "v1", with
// a DynamoDB TTL so records self-expire.
// ─────────────────────────────────────────────────────────────────────────────

export type PublicJobResultKind =
  | "file"
  | "clips"
  | "chapters"
  | "subtitles"
  | "translation";

export interface PublicJobRecord {
  jobId: string;
  op: string; // v1 operation, e.g. "clips"
  ownerKeyId: string; // keyId of the API key that created the job ("" if unknown)
  statusPath: string; // canonical /api/... status URL
  streamPath?: string; // canonical /api/... SSE URL
  cancelPath?: string; // canonical /api/... cancel URL
  resultKind: PublicJobResultKind;
  createdAt: number; // epoch ms
}

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

const TABLE =
  trimEnv(process.env.API_KEYS_TABLE) || trimEnv(process.env.ACCESS_TABLE);
const REGION =
  trimEnv(process.env.YOUTUBE_QUEUE_REGION) ||
  trimEnv(process.env.AWS_DEFAULT_REGION) ||
  "us-east-1";

const ddb = TABLE ? new DynamoDBClient({ region: REGION }) : null;

const PK_NAMESPACE = "pubjob#";
const SK_VALUE = "v1";
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function isPublicJobStoreEnabled(): boolean {
  return Boolean(ddb && TABLE);
}

function pkFor(jobId: string): string {
  return PK_NAMESPACE + jobId;
}

export async function registerPublicJob(rec: PublicJobRecord): Promise<void> {
  if (!ddb) return; // store not configured — unified endpoints fall back gracefully
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const item: Record<string, any> = {
    pk: { S: pkFor(rec.jobId) },
    sk: { S: SK_VALUE },
    type: { S: "pubjob" },
    jobId: { S: rec.jobId },
    op: { S: rec.op },
    ownerKeyId: { S: rec.ownerKeyId || "" },
    statusPath: { S: rec.statusPath },
    resultKind: { S: rec.resultKind },
    createdAt: { N: String(rec.createdAt) },
    expiresAt: { N: String(expiresAt) },
  };
  if (rec.streamPath) item.streamPath = { S: rec.streamPath };
  if (rec.cancelPath) item.cancelPath = { S: rec.cancelPath };

  try {
    await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));
  } catch (err) {
    // Best-effort: a missing registry row only degrades to the legacy fallback.
    logger.warn({ err, jobId: rec.jobId }, "registerPublicJob failed");
  }
}

export async function getPublicJob(jobId: string): Promise<PublicJobRecord | null> {
  if (!ddb || !jobId) return null;
  try {
    const out = await ddb.send(
      new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: pkFor(jobId) }, sk: { S: SK_VALUE } },
      }),
    );
    const item = out.Item;
    if (!item) return null;
    return {
      jobId: item.jobId?.S ?? jobId,
      op: item.op?.S ?? "",
      ownerKeyId: item.ownerKeyId?.S ?? "",
      statusPath: item.statusPath?.S ?? "",
      streamPath: item.streamPath?.S || undefined,
      cancelPath: item.cancelPath?.S || undefined,
      resultKind: (item.resultKind?.S as PublicJobResultKind) ?? "file",
      createdAt: item.createdAt?.N ? Number(item.createdAt.N) : 0,
    };
  } catch (err) {
    logger.warn({ err, jobId }, "getPublicJob failed");
    return null;
  }
}
