import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

// ── Admin-editable Super Agent model ladder ──────────────────────────────────
// The ladder's shape lives in copilot-external-provider.ts (code defaults) and
// COPILOT_ULTRA_MODEL / COPILOT_FAST_MODEL (deploy defaults). This module holds
// the optional *override* an admin sets from the panel, so changing the primary
// model or the fallback order no longer requires a deploy.
//
// Persistence mirrors lib/auth-access.ts deliberately: a single DynamoDB item
// plus a short TTL cache in every Lambda container. The older lib/admin-features
// pattern (a plain module-level object) is NOT usable here — it mutates only the
// one container that served the request and resets on cold start, so an admin
// would see the panel accept a change that production never applied.
//
// This module intentionally imports nothing from copilot-external-provider:
// the provider reads *from* here, and a cycle would make module-init order
// significant. Route-ID validation therefore lives in routes/admin.ts, which
// already knows the provider's catalog.

export type CopilotMode = "ultra" | "fast";

export type CopilotLadderConfig = {
  /** Per-mode primary route override. null = fall back to the env/code default. */
  primary: Record<CopilotMode, string | null>;
  /** Full fallback order override. Empty = use the code ladder. */
  order: string[];
  /** Per-route reasoning_effort override, e.g. { "agentrouter:gpt-5.6-sol": "high" }. */
  reasoning: Record<string, string>;
  updatedAt: number | null;
};

function emptyConfig(): CopilotLadderConfig {
  return {
    primary: { ultra: null, fast: null },
    order: [],
    reasoning: {},
    updatedAt: null,
  };
}

function configured(value: string | undefined): string {
  return value?.trim() ?? "";
}

const ACCESS_TABLE = configured(process.env.ACCESS_TABLE);
const DDB_REGION =
  configured(process.env.YOUTUBE_QUEUE_REGION) ||
  configured(process.env.AWS_DEFAULT_REGION) ||
  "us-east-1";
const REFRESH_TTL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.COPILOT_LADDER_TTL_MS ?? "30000", 10) || 30_000,
);

const ddbClient = ACCESS_TABLE ? new DynamoDBClient({ region: DDB_REGION }) : null;

// Single-row document — PK: "copilot-ladder", SK: "v1"
const LADDER_PK = "copilot-ladder";
const LADDER_SK = "v1";

let current: CopilotLadderConfig = emptyConfig();
let lastRefreshedAt = 0;
let lastKnownUpdatedAt: number | null = null;
let lastItemExists = false;
let inflightRefresh: Promise<void> | null = null;
// Non-zero while a mutation sits between its read and its write; a background
// refresh landing in that window would discard the pending change.
let mutationDepth = 0;

// ── Parsing ──────────────────────────────────────────────────────────────────

function sanitize(raw: unknown): CopilotLadderConfig {
  const next = emptyConfig();
  if (!raw || typeof raw !== "object") return next;
  const value = raw as Record<string, unknown>;

  const primary = value.primary;
  if (primary && typeof primary === "object") {
    for (const mode of ["ultra", "fast"] as const) {
      const route = (primary as Record<string, unknown>)[mode];
      if (typeof route === "string" && route.trim()) next.primary[mode] = route.trim();
    }
  }

  if (Array.isArray(value.order)) {
    const seen = new Set<string>();
    for (const entry of value.order) {
      if (typeof entry !== "string") continue;
      const route = entry.trim();
      if (!route || seen.has(route)) continue;
      seen.add(route);
      next.order.push(route);
    }
  }

  const reasoning = value.reasoning;
  if (reasoning && typeof reasoning === "object") {
    for (const [route, effort] of Object.entries(reasoning as Record<string, unknown>)) {
      if (typeof effort === "string" && effort.trim()) {
        next.reasoning[route.trim()] = effort.trim();
      }
    }
  }

  return next;
}

// ── Load from DynamoDB ───────────────────────────────────────────────────────

// Throws on DynamoDB failure — mutations let it propagate so the admin sees a
// real error; the read path swallows it and keeps serving the cached config.
async function loadFromDdb(): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return;
  const out = await ddbClient.send(
    new GetItemCommand({
      TableName: ACCESS_TABLE,
      Key: { pk: { S: LADDER_PK }, sk: { S: LADDER_SK } },
      // Strongly consistent: an eventually-consistent read straight after
      // another container's write would resurrect the staleness this fixes.
      ConsistentRead: true,
    }),
  );

  const item = out.Item;
  lastItemExists = Boolean(item);
  if (item?.config?.S) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(item.config.S);
    } catch {
      parsed = null;
    }
    const next = sanitize(parsed);
    const updatedAt = Number(item.updatedAt?.N);
    next.updatedAt = Number.isFinite(updatedAt) ? updatedAt : null;
    lastKnownUpdatedAt = next.updatedAt;
    current = next;
  } else {
    current = emptyConfig();
    lastKnownUpdatedAt = null;
  }
  lastRefreshedAt = Date.now();
}

/**
 * Refresh the cached ladder override from DynamoDB, at most once per TTL
 * window. Safe to await on any request path; never throws.
 */
export function refreshCopilotLadder(force = false): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return Promise.resolve();
  if (mutationDepth > 0) return Promise.resolve();
  if (!force && Date.now() - lastRefreshedAt < REFRESH_TTL_MS) return Promise.resolve();
  // A forced refresh must not settle for a read that started before the
  // caller's write — queue a fresh read behind it instead.
  if (inflightRefresh && !force) return inflightRefresh;
  const previous = inflightRefresh ?? Promise.resolve();

  const chain: Promise<void> = previous
    .catch(() => undefined)
    .then(() => loadFromDdb())
    .catch((err) => {
      console.warn("[copilot-ladder] Could not refresh ladder from DynamoDB:", err);
    })
    .finally(() => {
      if (inflightRefresh === chain) inflightRefresh = null;
    });

  inflightRefresh = chain;
  return chain;
}

// ── Persist to DynamoDB ──────────────────────────────────────────────────────

// Conditional write: fails when another container wrote in between, so a stale
// container cannot clobber an override it never saw.
async function persistToDdb(next: CopilotLadderConfig): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) {
    throw new Error(
      "ACCESS_TABLE is not configured, so the model ladder cannot be saved. " +
        "Without it the change would apply to a single Lambda container and be lost on the next cold start.",
    );
  }

  const now = Date.now();
  const condition =
    lastKnownUpdatedAt !== null
      ? "updatedAt = :prev"
      : lastItemExists
        ? "attribute_exists(pk)"
        : "attribute_not_exists(pk)";

  await ddbClient.send(
    new PutItemCommand({
      TableName: ACCESS_TABLE,
      Item: {
        pk: { S: LADDER_PK },
        sk: { S: LADDER_SK },
        config: {
          S: JSON.stringify({
            primary: next.primary,
            order: next.order,
            reasoning: next.reasoning,
          }),
        },
        updatedAt: { N: String(now) },
      },
      ConditionExpression: condition,
      ...(lastKnownUpdatedAt !== null
        ? { ExpressionAttributeValues: { ":prev": { N: String(lastKnownUpdatedAt) } } }
        : {}),
    }),
  );

  next.updatedAt = now;
  current = next;
  lastKnownUpdatedAt = now;
  lastItemExists = true;
  lastRefreshedAt = Date.now();
}

export type CopilotLadderPatch = {
  primary?: Partial<Record<CopilotMode, string | null>>;
  order?: string[];
  reasoning?: Record<string, string | null>;
};

/**
 * Read the latest override, apply `patch`, write it back. Retries on a
 * concurrent-write conflict and surfaces storage failures to the caller rather
 * than reporting a phantom success to the admin.
 */
export async function updateCopilotLadder(
  patch: CopilotLadderPatch,
): Promise<CopilotLadderConfig> {
  let lastErr: unknown;
  mutationDepth += 1;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await loadFromDdb();

      const next: CopilotLadderConfig = {
        primary: { ...current.primary },
        order: [...current.order],
        reasoning: { ...current.reasoning },
        updatedAt: current.updatedAt,
      };

      if (patch.primary) {
        for (const mode of ["ultra", "fast"] as const) {
          if (!(mode in patch.primary)) continue;
          const route = patch.primary[mode];
          next.primary[mode] =
            typeof route === "string" && route.trim() ? route.trim() : null;
        }
      }
      if (patch.order) {
        const seen = new Set<string>();
        next.order = [];
        for (const entry of patch.order) {
          const route = String(entry ?? "").trim();
          if (!route || seen.has(route)) continue;
          seen.add(route);
          next.order.push(route);
        }
      }
      if (patch.reasoning) {
        for (const [route, effort] of Object.entries(patch.reasoning)) {
          const key = route.trim();
          if (!key) continue;
          if (effort === null || String(effort).trim() === "") delete next.reasoning[key];
          else next.reasoning[key] = String(effort).trim();
        }
      }

      try {
        await persistToDdb(next);
        return current;
      } catch (err) {
        lastErr = err;
        const name = (err as { name?: string })?.name;
        if (name !== "ConditionalCheckFailedException") break;
      }
    }
  } finally {
    mutationDepth -= 1;
  }
  throw new Error(
    `Could not save the Super Agent model ladder: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// ── Read accessors (synchronous — callers refresh on the request path) ───────

export function getCopilotLadderConfig(): CopilotLadderConfig {
  return {
    primary: { ...current.primary },
    order: [...current.order],
    reasoning: { ...current.reasoning },
    updatedAt: current.updatedAt,
  };
}

export function isCopilotLadderPersistent(): boolean {
  return Boolean(ddbClient && ACCESS_TABLE);
}

/** Admin-selected primary route for a mode, or null to use the env/code default. */
export function getLadderPrimary(mode: CopilotMode): string | null {
  return current.primary[mode];
}

/** Admin-selected fallback order, or null when the code ladder should be used. */
export function getLadderOrder(): string[] | null {
  return current.order.length > 0 ? [...current.order] : null;
}

/** Admin-selected reasoning_effort for a route, or null for the code default. */
export function getLadderReasoning(route: string): string | null {
  return current.reasoning[route] ?? null;
}
