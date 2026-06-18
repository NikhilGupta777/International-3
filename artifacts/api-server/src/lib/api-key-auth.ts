import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// API Key Core
//
// Production-grade, admin-issued API keys that unlock programmatic access to
// every VideoMaking Studio service through a single bearer token.
//
//   Authorization: Bearer vms_live_xxxxxxxxxxxxxxxxxxxxxxxx
//   X-API-Key: vms_live_xxxxxxxxxxxxxxxxxxxxxxxx
//
// SECURITY MODEL
//   - The raw key is shown exactly once (at creation). We persist only a
//     SHA-256 hash + a short non-secret display prefix.
//   - Verification hashes the incoming key and looks it up by primary key.
//   - Revocation flips `status` to "revoked"; checked on every request.
//
// STORAGE
//   Reuses the existing DynamoDB table (ACCESS_TABLE) by default so no new
//   infrastructure is required to get started. Set API_KEYS_TABLE to use a
//   dedicated table. Each key is a discrete item:
//       pk = "apikey#<sha256(rawKey)>"   sk = "v1"
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyStatus = "active" | "revoked";

export interface ApiKeyRecord {
  keyId: string;
  prefix: string; // non-secret display prefix, e.g. "vms_live_a1b2c3"
  name: string;
  ownerEmail: string;
  scopes: string[]; // ["*"] grants everything
  status: ApiKeyStatus;
  createdAt: number; // epoch ms
  createdBy: string; // email of the admin/granted user who issued it
  lastUsedAt?: number; // epoch ms
  expiresAt?: number; // epoch seconds (DynamoDB TTL) — optional
  rateLimitPerMin?: number; // 0/undefined → use server default
  monthlyQuota?: number; // 0/undefined → unlimited
  usageMonth?: number; // requests counted in the current calendar month
  usageTotal?: number; // lifetime request count
  /** Internal: the DynamoDB partition key this row was read from. Not serialized to clients. */
  _pk?: string;
}

export interface CreatedApiKey {
  record: ApiKeyRecord;
  /** The full secret. Returned ONCE — never stored or retrievable again. */
  rawKey: string;
}

const KEY_PREFIX = "vms_live_";
const PK_NAMESPACE = "apikey#";
const SK_VALUE = "v1";
const DISPLAY_PREFIX_LEN = KEY_PREFIX.length + 6;

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

const DEFAULT_RATE_LIMIT_PER_MIN = Number(process.env.API_KEY_RATE_LIMIT_PER_MIN ?? 120);

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7).replace("-", "_"); // e.g. "2026_06"
}
function usageAttrName(): string {
  return `um_${currentMonthKey()}`;
}

export function isApiKeyStoreEnabled(): boolean {
  return Boolean(ddb && TABLE);
}

// ── Verification cache (mirrors the allowlist hydration TTL pattern) ─────────
// Avoids a DynamoDB read on every single API call. Short TTL so revocation
// still takes effect quickly.
const CACHE_TTL_MS = 60_000;
const verifyCache = new Map<string, { record: ApiKeyRecord | null; at: number }>();

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function pkFor(hash: string): string {
  return PK_NAMESPACE + hash;
}

function shortId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** Extract a bearer/api key from the request headers. Returns "" when absent. */
export function extractApiKey(headers: Record<string, unknown>): string {
  const auth = String(headers["authorization"] ?? "").trim();
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m && m[1]) return m[1].trim();
  }
  const direct = headers["x-api-key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return "";
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX);
}

function recordFromItem(item: Record<string, any> | undefined): ApiKeyRecord | null {
  if (!item) return null;
  const status = item.status?.S === "revoked" ? "revoked" : "active";
  return {
    keyId: item.keyId?.S ?? "",
    prefix: item.prefix?.S ?? "",
    name: item.name?.S ?? "",
    ownerEmail: item.ownerEmail?.S ?? "",
    scopes: Array.isArray(item.scopes?.SS) ? item.scopes.SS : [],
    status,
    createdAt: item.createdAt?.N ? Number(item.createdAt.N) : 0,
    createdBy: item.createdBy?.S ?? "",
    lastUsedAt: item.lastUsedAt?.N ? Number(item.lastUsedAt.N) : undefined,
    expiresAt: item.expiresAt?.N ? Number(item.expiresAt.N) : undefined,
    rateLimitPerMin: item.rateLimitPerMin?.N ? Number(item.rateLimitPerMin.N) : undefined,
    monthlyQuota: item.monthlyQuota?.N ? Number(item.monthlyQuota.N) : undefined,
    usageMonth: item[usageAttrName()]?.N ? Number(item[usageAttrName()].N) : 0,
    usageTotal: item.usageTotal?.N ? Number(item.usageTotal.N) : 0,
    _pk: item.pk?.S,
  };
}

function isExpired(record: ApiKeyRecord): boolean {
  if (!record.expiresAt) return false;
  return record.expiresAt * 1000 <= Date.now();
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * Validate a raw API key. Returns the active key record, or null when the key
 * is unknown, revoked, expired, or the store is not configured.
 */
export async function verifyApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
  if (!rawKey || !looksLikeApiKey(rawKey) || !ddb) return null;

  const hash = hashKey(rawKey);

  const cached = verifyCache.get(hash);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.record;
  }

  try {
    const out = await ddb.send(
      new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: pkFor(hash) }, sk: { S: SK_VALUE } },
      }),
    );
    let record = recordFromItem(out.Item);
    if (record && (record.status !== "active" || isExpired(record))) {
      record = null;
    }
    verifyCache.set(hash, { record, at: Date.now() });
    return record;
  } catch (err) {
    console.warn("[api-key-auth] verify failed:", err);
    return null;
  }
}

// ── Scopes & route allowlist ─────────────────────────────────────────────────
//
// SECURITY MODEL
//   API keys are confined to an explicit allowlist of *public* service segments.
//   Any path outside the allowlist (workspace, video-editor, ops, notebook,
//   pitaji, notifications, admin, keys, …) is denied for EVERY key — including
//   wildcard ("*") keys. This is a hard boundary, independent of scopes.
//
//   Within the public surface, scopes provide least-privilege control:
//     - "*"                → every public service
//     - "<service>"        → the whole service (e.g. "youtube")
//     - "<service>:<op>"   → a single operation (e.g. "youtube:clips")
//
//   YouTube create-operations are individually scopable; shared operations
//   (cancel / file / stream / status) are granted to any youtube scope so a
//   narrowly-scoped key can still manage and download its own jobs.

/** Public service segments an API key may reach. Everything else is blocked. */
export const PUBLIC_API_SEGMENTS: ReadonlySet<string> = new Set([
  "youtube",
  "subtitles",
  "translator",
  "uploads",
  "thumbnail",
  "agent",
  "bhagwat",
]);

/** Canonical, assignable scopes. POST /keys rejects anything not in this set. */
export const API_KEY_SCOPE_CATALOG: readonly string[] = [
  "*",
  "youtube",
  "youtube:download",
  "youtube:clip-cut",
  "youtube:clips",
  "youtube:timestamps",
  "youtube:info",
  "subtitles",
  "subtitles:create",
  "translator",
  "translator:create",
  "uploads",
  "uploads:create",
  "thumbnail",
  "agent",
  "bhagwat",
];

const SCOPE_SET: ReadonlySet<string> = new Set(API_KEY_SCOPE_CATALOG);

/** First path segment after /api (the coarse service). */
export function requiredScopeForPath(path: string): string | null {
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg || null;
}

/**
 * Validate & de-duplicate a requested scope list. Throws on any unknown scope
 * so keys can never be minted for internal or non-existent services. Returns
 * the cleaned list (may be empty — the caller decides the default).
 */
export function validateScopes(requested: string[]): string[] {
  const cleaned = Array.from(
    new Set(requested.map((s) => s.trim()).filter(Boolean)),
  );
  const invalid = cleaned.filter((s) => !SCOPE_SET.has(s));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown scope(s): ${invalid.join(", ")}. Allowed: ${API_KEY_SCOPE_CATALOG.join(", ")}`,
    );
  }
  return cleaned;
}

/** The specific create-scope a youtube path maps to, or null for shared ops. */
function youtubeOperationScope(path: string): string | null {
  const rest = path.replace(/^\/+/, "").replace(/^youtube\/?/, "");
  if (rest.startsWith("clip-cut")) return "youtube:clip-cut";
  if (rest.startsWith("clips")) return "youtube:clips";
  if (rest.startsWith("download")) return "youtube:download";
  if (rest.startsWith("timestamps")) return "youtube:timestamps";
  if (rest.startsWith("info")) return "youtube:info";
  return null; // cancel / file / stream / best-clips status / subtitles-dl …
}

export function apiKeyAllowsPath(record: ApiKeyRecord, path: string): boolean {
  const seg = requiredScopeForPath(path);
  if (!seg) return true; // root
  // The /v1 facade forwards in-process to a canonical service path where the
  // real per-service scope is enforced — treat the v1 entrypoint as transparent.
  if (seg === "v1") return true;
  // Hard boundary: never allow non-public segments, even for "*" keys.
  if (!PUBLIC_API_SEGMENTS.has(seg)) return false;

  const scopes = record.scopes;
  if (scopes.includes("*")) return true;
  // Service-level scope grants the whole service.
  if (scopes.includes(seg)) return true;

  if (seg === "youtube") {
    const op = youtubeOperationScope(path);
    if (op) return scopes.includes(op);
    // Shared op (cancel/file/stream/status): any youtube sub-scope grants it.
    return scopes.some((s) => s === "youtube" || s.startsWith("youtube:"));
  }

  // Other services: the service-level scope or its ":<op>" sub-scope.
  return scopes.some((s) => s.startsWith(seg + ":"));
}

// ── lastUsedAt touch (throttled, fire-and-forget) ────────────────────────────

const lastTouchAt = new Map<string, number>();
const TOUCH_THROTTLE_MS = 5 * 60_000;

export async function touchApiKeyUsage(record: ApiKeyRecord): Promise<void> {
  if (!ddb || !record.keyId) return;
  const now = Date.now();
  const prev = lastTouchAt.get(record.keyId) ?? 0;
  if (now - prev < TOUCH_THROTTLE_MS) return;
  lastTouchAt.set(record.keyId, now);

  // Persist lastUsedAt keyed by the same pk this record was read from.
  const hashPk = record._pk;
  if (!hashPk) return;
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: { pk: { S: hashPk }, sk: { S: SK_VALUE } },
        UpdateExpression: "SET lastUsedAt = :now",
        ExpressionAttributeValues: { ":now": { N: String(now) } },
      }),
    );
  } catch {
    /* best-effort */
  }
}

// ── Create / List / Revoke (used by the admin-gated key routes) ──────────────

export async function createApiKey(input: {
  name: string;
  ownerEmail: string;
  createdBy: string;
  scopes?: string[];
  expiresAt?: number; // epoch seconds
  rateLimitPerMin?: number;
  monthlyQuota?: number;
}): Promise<CreatedApiKey> {
  if (!ddb) throw new Error("API key store is not configured (set ACCESS_TABLE or API_KEYS_TABLE)");

  const token = crypto.randomBytes(24).toString("base64url");
  const rawKey = KEY_PREFIX + token;
  const hash = hashKey(rawKey);
  const now = Date.now();

  const record: ApiKeyRecord = {
    keyId: shortId(),
    prefix: rawKey.slice(0, DISPLAY_PREFIX_LEN),
    name: input.name?.trim() || "Untitled key",
    ownerEmail: (input.ownerEmail || "").trim().toLowerCase(),
    scopes: input.scopes && input.scopes.length > 0 ? input.scopes : ["*"],
    status: "active",
    createdAt: now,
    createdBy: (input.createdBy || "").trim().toLowerCase(),
    expiresAt: input.expiresAt,
    rateLimitPerMin:
      Number.isFinite(input.rateLimitPerMin) && (input.rateLimitPerMin as number) > 0
        ? Math.floor(input.rateLimitPerMin as number)
        : undefined,
    monthlyQuota:
      Number.isFinite(input.monthlyQuota) && (input.monthlyQuota as number) > 0
        ? Math.floor(input.monthlyQuota as number)
        : undefined,
  };

  const item: Record<string, any> = {
    pk: { S: pkFor(hash) },
    sk: { S: SK_VALUE },
    type: { S: "apikey" },
    keyId: { S: record.keyId },
    prefix: { S: record.prefix },
    name: { S: record.name },
    ownerEmail: { S: record.ownerEmail },
    scopes: { SS: record.scopes },
    status: { S: record.status },
    createdAt: { N: String(record.createdAt) },
    createdBy: { S: record.createdBy },
  };
  if (record.expiresAt) item.expiresAt = { N: String(record.expiresAt) };
  if (record.rateLimitPerMin) item.rateLimitPerMin = { N: String(record.rateLimitPerMin) };
  if (record.monthlyQuota) item.monthlyQuota = { N: String(record.monthlyQuota) };

  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));
  return { record, rawKey };
}

/** List all issued keys (metadata only — never the secret). Admin volume. */
export async function listApiKeys(ownerEmail?: string): Promise<ApiKeyRecord[]> {
  if (!ddb) return [];
  const records: ApiKeyRecord[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  const wantOwner = ownerEmail?.trim().toLowerCase();

  do {
    const out: any = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: "begins_with(pk, :ns)",
        ExpressionAttributeValues: { ":ns": { S: PK_NAMESPACE } },
        ExclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) {
      const rec = recordFromItem(item);
      if (!rec) continue;
      if (wantOwner && rec.ownerEmail !== wantOwner) continue;
      records.push(rec);
    }
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  records.sort((a, b) => b.createdAt - a.createdAt);
  return records;
}

/** Revoke a key by its keyId. Returns true when a key was flipped to revoked. */
export async function revokeApiKey(keyId: string): Promise<boolean> {
  if (!ddb) return false;
  // We index by hash, so locate the row by scanning for the keyId (admin volume).
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const out: any = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: "begins_with(pk, :ns) AND keyId = :kid",
        ExpressionAttributeValues: {
          ":ns": { S: PK_NAMESPACE },
          ":kid": { S: keyId },
        },
        ExclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) {
      const pk = item.pk?.S;
      if (!pk) continue;
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: pk }, sk: { S: SK_VALUE } },
          UpdateExpression: "SET #s = :revoked",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":revoked": { S: "revoked" } },
        }),
      );
      // Invalidate any cached verification for this row.
      const hash = pk.slice(PK_NAMESPACE.length);
      verifyCache.delete(hash);
      return true;
    }
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return false;
}

// ── Rate limiting + monthly quota + usage accounting ─────────────────────────
// In-memory sliding window per key (best-effort per instance, consistent with
// the existing IP limiter). Usage counts accumulate in memory and flush to
// DynamoDB on a throttle so we don't write on every request.

type RateWindow = { count: number; resetAt: number };
const keyRateWindows = new Map<string, RateWindow>();
const pendingUsage = new Map<string, number>(); // keyId -> uncommitted request count
const keyPk = new Map<string, string>(); // keyId -> DynamoDB pk (hash) for flushing
const RATE_WINDOW_MS = 60_000;

export interface LimitDecision {
  allowed: boolean;
  status?: number;
  error?: string;
  retryAfterSec?: number;
}

/**
 * Enforce per-key rate limit + monthly quota and record one unit of usage.
 * Call exactly once per externally-initiated request (skip on in-process
 * re-dispatch). Synchronous decision; persistence is flushed asynchronously.
 */
export function enforceApiKeyLimits(record: ApiKeyRecord): LimitDecision {
  const keyId = record.keyId;
  if (record._pk) keyPk.set(keyId, record._pk);

  // 1) Rate limit (requests per minute)
  const max = record.rateLimitPerMin && record.rateLimitPerMin > 0 ? record.rateLimitPerMin : DEFAULT_RATE_LIMIT_PER_MIN;
  const now = Date.now();
  const win = keyRateWindows.get(keyId);
  if (!win || now >= win.resetAt) {
    keyRateWindows.set(keyId, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else if (win.count >= max) {
    return {
      allowed: false,
      status: 429,
      error: "Rate limit exceeded for this API key.",
      retryAfterSec: Math.max(1, Math.ceil((win.resetAt - now) / 1000)),
    };
  } else {
    win.count += 1;
  }

  // 2) Monthly quota
  if (record.monthlyQuota && record.monthlyQuota > 0) {
    const effective = (record.usageMonth ?? 0) + (pendingUsage.get(keyId) ?? 0);
    if (effective >= record.monthlyQuota) {
      return {
        allowed: false,
        status: 429,
        error: "Monthly quota exceeded for this API key.",
      };
    }
  }

  // 3) Record usage (deferred persistence)
  pendingUsage.set(keyId, (pendingUsage.get(keyId) ?? 0) + 1);
  return { allowed: true };
}

async function flushUsage(): Promise<void> {
  if (!ddb || pendingUsage.size === 0) return;
  const attr = usageAttrName();
  const batch = [...pendingUsage.entries()];
  pendingUsage.clear();
  for (const [keyId, count] of batch) {
    const pk = keyPk.get(keyId);
    if (!pk || count <= 0) continue;
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: pk }, sk: { S: SK_VALUE } },
          UpdateExpression: "ADD #m :n, usageTotal :n",
          ExpressionAttributeNames: { "#m": attr },
          ExpressionAttributeValues: { ":n": { N: String(count) } },
        }),
      );
    } catch {
      // Re-queue on failure so the count isn't lost.
      pendingUsage.set(keyId, (pendingUsage.get(keyId) ?? 0) + count);
    }
  }
}

// Periodic flush; unref so it never holds the process open.
const _usageFlushTimer = setInterval(() => {
  void flushUsage();
}, 30_000);
if (typeof (_usageFlushTimer as { unref?: () => void }).unref === "function") {
  (_usageFlushTimer as { unref?: () => void }).unref!();
}
