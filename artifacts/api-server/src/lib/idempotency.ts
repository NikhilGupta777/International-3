import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency keys for create operations.
//
// A client may send `Idempotency-Key: <unique>` on a POST so that retrying the
// same request (after a network blip or timeout) returns the SAME job instead
// of creating a duplicate. We store the response envelope keyed by
// (ownerKeyId, idempotencyKey) together with a hash of the request so that
// reusing the same key with a different body is rejected.
//
// Storage reuses the existing table (API_KEYS_TABLE / ACCESS_TABLE):
//   pk = "idem#<ownerKeyId>#<idempotencyKey>", sk = "v1", 24h TTL.
// ─────────────────────────────────────────────────────────────────────────────

export interface IdempotentRecord {
  requestHash: string;
  response: unknown;
  jobId: string;
  createdAt: number;
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
const SK_VALUE = "v1";
const TTL_SECONDS = 24 * 60 * 60; // 24h

export function isIdempotencyStoreEnabled(): boolean {
  return Boolean(ddb && TABLE);
}

/** Deterministic hash of the request so key reuse with a different body fails. */
export function requestHash(op: string, ownerKeyId: string, body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${op}|${ownerKeyId}|${stableStringify(body)}`, "utf8")
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function pkFor(ownerKeyId: string, idemKey: string): string {
  return `idem#${ownerKeyId}#${idemKey}`;
}

export async function getIdempotentRecord(
  ownerKeyId: string,
  idemKey: string,
): Promise<IdempotentRecord | null> {
  if (!ddb || !idemKey) return null;
  try {
    const out = await ddb.send(
      new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: pkFor(ownerKeyId, idemKey) }, sk: { S: SK_VALUE } },
      }),
    );
    const item = out.Item;
    if (!item) return null;
    return {
      requestHash: item.requestHash?.S ?? "",
      response: item.response?.S ? safeParse(item.response.S) : null,
      jobId: item.jobId?.S ?? "",
      createdAt: item.createdAt?.N ? Number(item.createdAt.N) : 0,
    };
  } catch (err) {
    logger.warn({ err }, "getIdempotentRecord failed");
    return null;
  }
}

/**
 * Persist the response for an idempotency key. Uses a conditional put so the
 * first writer wins under a race; subsequent writers are silently ignored.
 */
export async function saveIdempotentRecord(
  ownerKeyId: string,
  idemKey: string,
  rec: IdempotentRecord,
): Promise<void> {
  if (!ddb || !idemKey) return;
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: pkFor(ownerKeyId, idemKey) },
          sk: { S: SK_VALUE },
          type: { S: "idem" },
          requestHash: { S: rec.requestHash },
          response: { S: JSON.stringify(rec.response) },
          jobId: { S: rec.jobId },
          createdAt: { N: String(rec.createdAt) },
          expiresAt: { N: String(expiresAt) },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err: any) {
    // ConditionalCheckFailed = another request already stored it. Not an error.
    if (err?.name !== "ConditionalCheckFailedException") {
      logger.warn({ err }, "saveIdempotentRecord failed");
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
