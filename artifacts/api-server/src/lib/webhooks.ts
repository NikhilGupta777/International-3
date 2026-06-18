import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import { lookup } from "dns/promises";
import * as net from "net";

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks — optional, HMAC-signed completion callbacks for API jobs.
//
// A client may register a callback URL for a specific job (via the v1 create
// body `webhookUrl`) or a default URL for an API key. When the job reaches a
// terminal state, we POST a signed JSON payload to that URL:
//
//   POST <webhookUrl>
//   X-VMS-Event: job.completed | job.failed
//   X-VMS-Signature: sha256=<hex hmac of the raw body>
//   { "jobId", "status", "message", "ready", "timestamp" }
//
// Registrations are stored in the shared table (ACCESS_TABLE / API_KEYS_TABLE):
//   pk = "webhook#<jobId>"  sk = "v1"   (per-job)
// The row also carries a `fired` flag so we deliver at-most-once.
// ─────────────────────────────────────────────────────────────────────────────

function trimEnv(v: string | undefined): string {
  return v?.trim() ?? "";
}

const TABLE = trimEnv(process.env.API_KEYS_TABLE) || trimEnv(process.env.ACCESS_TABLE);
const REGION =
  trimEnv(process.env.YOUTUBE_QUEUE_REGION) ||
  trimEnv(process.env.AWS_DEFAULT_REGION) ||
  "us-east-1";
const SIGNING_SECRET =
  trimEnv(process.env.WEBHOOK_SIGNING_SECRET) ||
  trimEnv(process.env.SESSION_SECRET) ||
  trimEnv(process.env.AUTH_COOKIE_SECRET);

const ddb = TABLE ? new DynamoDBClient({ region: REGION }) : null;
const SK = "v1";

const TERMINAL = new Set(["done", "DONE", "error", "failed", "FAILED", "cancelled", "CANCELLED", "expired", "EXPIRED"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export function isWebhooksEnabled(): boolean {
  return Boolean(ddb && TABLE && SIGNING_SECRET);
}

function pkForJob(jobId: string): string {
  return `webhook#${jobId}`;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isPrivateOrReservedIp(value: string): boolean {
  const ip = normalizeHost(value);
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe80") ||
      ip.startsWith("::ffff:10.") ||
      ip.startsWith("::ffff:127.") ||
      ip.startsWith("::ffff:169.254.") ||
      ip.startsWith("::ffff:172.") ||
      ip.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateOrReservedIp(host)
  );
}

function parseWebhookUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (isBlockedHost(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

/** Fast structural check used by the UI/API before DNS validation. */
export function isValidWebhookUrl(raw: string): boolean {
  return Boolean(parseWebhookUrl(raw));
}

async function publicWebhookUrl(raw: string): Promise<string | null> {
  const parsed = parseWebhookUrl(raw);
  if (!parsed) return null;
  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length) return null;
    if (addresses.some((entry) => isPrivateOrReservedIp(entry.address))) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function registerJobWebhook(jobId: string, url: string, keyId?: string): Promise<boolean> {
  if (!isWebhooksEnabled() || !ddb || !jobId) return false;
  const safeUrl = await publicWebhookUrl(url);
  if (!safeUrl) return false;
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: pkForJob(jobId) },
          sk: { S: SK },
          type: { S: "webhook" },
          jobId: { S: jobId },
          url: { S: safeUrl },
          keyId: keyId ? { S: keyId } : { NULL: true },
          fired: { BOOL: false },
          createdAt: { N: String(Date.now()) },
          // Auto-expire registrations after 7 days (DynamoDB TTL, if enabled).
          expiresAt: { N: String(Math.floor(Date.now() / 1000) + 7 * 86400) },
        },
      }),
    );
    return true;
  } catch (err) {
    console.warn("[webhooks] register failed:", err);
    return false;
  }
}

function signBody(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SIGNING_SECRET).update(body, "utf8").digest("hex");
}

async function postWebhook(url: string, event: string, payload: Record<string, unknown>): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = signBody(body);
  const attempt = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VMS-Event": event,
          "X-VMS-Signature": signature,
        },
        body,
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  // One retry with a short backoff.
  if (await attempt()) return true;
  await new Promise((r) => setTimeout(r, 1500));
  return attempt();
}

/**
 * Fire the webhook for a job if one is registered, the status is terminal, and
 * it has not been delivered yet. At-most-once via a conditional `fired` flip.
 * Safe to call repeatedly (no-op when nothing to do). Never throws.
 */
export async function maybeFireJobWebhook(
  jobId: string,
  status: string,
  extra?: { message?: string | null },
): Promise<void> {
  if (!isWebhooksEnabled() || !ddb || !jobId || !isTerminalStatus(status)) return;
  try {
    const out = await ddb.send(
      new GetItemCommand({ TableName: TABLE, Key: { pk: { S: pkForJob(jobId) }, sk: { S: SK } } }),
    );
    const item = out.Item;
    if (!item || item.fired?.BOOL === true) return;
    const url = item.url?.S;
    if (!url) return;
    const safeUrl = await publicWebhookUrl(url);
    if (!safeUrl) return;

    // Claim delivery atomically so concurrent callers don't double-send.
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: pkForJob(jobId) }, sk: { S: SK } },
          UpdateExpression: "SET fired = :t",
          ConditionExpression: "fired = :f",
          ExpressionAttributeValues: { ":t": { BOOL: true }, ":f": { BOOL: false } },
        }),
      );
    } catch {
      return; // someone else already claimed it
    }

    const failed = ["error", "failed", "FAILED", "cancelled", "CANCELLED"].includes(status);
    await postWebhook(safeUrl, failed ? "job.failed" : "job.completed", {
      jobId,
      status,
      message: extra?.message ?? null,
      ready: true,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn("[webhooks] fire failed:", err);
  }
}
