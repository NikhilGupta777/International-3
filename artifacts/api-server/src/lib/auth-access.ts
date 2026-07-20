import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

export type AuthRole = "admin" | "user";

// ── In-memory sets (seeded from env vars, refreshed from DynamoDB) ────────────
// DynamoDB is the source of truth once the allowlist document exists; env vars
// are a seed/fallback that is always unioned back in so a deploy-time list can
// never be lost. The in-memory sets are a short-lived cache in front of DDB —
// every Lambda container refreshes them on a TTL so an email approved on one
// container becomes visible to all the others (previously they hydrated exactly
// once per cold start, so warm containers rejected freshly-approved logins).
const approvedUsers = parseCsvSet(process.env.APPROVED_USER_EMAILS);
const approvedAdmins = parseCsvSet(process.env.APPROVED_ADMIN_EMAILS);
// Emails (beyond admins) that an admin has granted Developer/API access to.
// These users can see the Developer tab and mint API keys.
const apiAccessEmails = parseCsvSet(process.env.API_ACCESS_EMAILS);

// Frozen copies of the env seeds — re-applied after every refresh.
const ENV_USERS = [...approvedUsers];
const ENV_ADMINS = [...approvedAdmins];
const ENV_API_ACCESS = [...apiAccessEmails];

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
  Number.parseInt(process.env.ACCESS_ALLOWLIST_TTL_MS ?? "30000", 10) || 30_000,
);

// ── DynamoDB persistence (optional — gracefully disabled when table is absent) ─
const ddbClient = ACCESS_TABLE
  ? new DynamoDBClient({
      region: DDB_REGION,
    })
  : null;

// Single-row document — PK: "allowlist", SK: "v1"
const ALLOWLIST_PK = "allowlist";
const ALLOWLIST_SK = "v1";

let lastRefreshedAt = 0;
let lastKnownUpdatedAt: number | null = null;
let lastItemExists = false;
let inflightRefresh: Promise<void> | null = null;
// Non-zero while a mutation is between its read and its write. A background
// refresh landing in that window would overwrite the pending change before it
// is persisted, so refreshes stand down until the mutation completes.
let mutationDepth = 0;

// ── Load from DynamoDB ───────────────────────────────────────────────────────

function replaceSet(target: Set<string>, next: string[], envSeed: string[]): void {
  target.clear();
  for (const value of next) target.add(value);
  for (const value of envSeed) target.add(value);
}

// Throws on DynamoDB failure — callers that must not proceed on stale data
// (i.e. mutations) let it propagate; the read path swallows it.
async function loadFromDdb(): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return;
  const out = await ddbClient.send(
    new GetItemCommand({
      TableName: ACCESS_TABLE,
      Key: {
        pk: { S: ALLOWLIST_PK },
        sk: { S: ALLOWLIST_SK },
      },
      // Strongly consistent: an eventually-consistent read right after another
      // container's write would resurrect the exact staleness we are fixing.
      ConsistentRead: true,
    }),
  );

  const item = out.Item;
  lastItemExists = Boolean(item);
  if (item) {
    replaceSet(approvedUsers, parseSsList(item.users?.SS), ENV_USERS);
    replaceSet(approvedAdmins, parseSsList(item.admins?.SS), ENV_ADMINS);
    replaceSet(apiAccessEmails, parseSsList(item.apiAccess?.SS), ENV_API_ACCESS);
    // Admins must never also appear in the user set.
    for (const email of approvedAdmins) approvedUsers.delete(email);
    const updatedAt = Number(item.updatedAt?.N);
    lastKnownUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : null;
  } else {
    lastKnownUpdatedAt = null;
  }
  lastRefreshedAt = Date.now();
}

/**
 * Refresh the in-memory allowlist from DynamoDB, at most once per TTL window.
 * Safe to await on any request path; never throws.
 */
export function refreshAllowlist(force = false): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return Promise.resolve();
  if (mutationDepth > 0) return Promise.resolve();
  if (!force && Date.now() - lastRefreshedAt < REFRESH_TTL_MS) return Promise.resolve();
  // A forced refresh must not settle for an in-flight read that started before
  // the caller's write — queue a fresh read behind it instead.
  if (inflightRefresh && !force) return inflightRefresh;
  const previous = inflightRefresh ?? Promise.resolve();

  const chain: Promise<void> = previous
    .catch(() => undefined)
    .then(() => loadFromDdb())
    .catch((err) => {
      console.warn("[auth-access] Could not refresh allowlist from DynamoDB:", err);
    })
    .finally(() => {
      // Only clear if a newer refresh has not already taken the slot.
      if (inflightRefresh === chain) inflightRefresh = null;
    });

  inflightRefresh = chain;
  return chain;
}

/** Back-compat alias used at cold start. */
export function hydrateAllowlistFromDdb(): Promise<void> {
  return refreshAllowlist(true);
}

// ── Persist to DynamoDB ──────────────────────────────────────────────────────

// Conditional write: fails when another container wrote in between, so a stale
// container can no longer clobber emails it never knew about.
async function persistAllowlistToDdb(): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return;

  const users = [...approvedUsers].sort();
  const admins = [...approvedAdmins].sort();
  const apiAccess = [...apiAccessEmails].sort();
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
        pk: { S: ALLOWLIST_PK },
        sk: { S: ALLOWLIST_SK },
        users: users.length > 0 ? { SS: users } : { NULL: true },
        admins: admins.length > 0 ? { SS: admins } : { NULL: true },
        apiAccess: apiAccess.length > 0 ? { SS: apiAccess } : { NULL: true },
        updatedAt: { N: String(now) },
      },
      ConditionExpression: condition,
      ...(lastKnownUpdatedAt !== null
        ? { ExpressionAttributeValues: { ":prev": { N: String(lastKnownUpdatedAt) } } }
        : {}),
    }),
  );

  lastKnownUpdatedAt = now;
  lastItemExists = true;
  lastRefreshedAt = Date.now();
}

/**
 * Read the latest allowlist, apply `mutate`, then write it back.
 * Retries on a concurrent-write conflict, and — critically — surfaces storage
 * failures to the caller instead of reporting a phantom success to the admin.
 */
async function applyAndPersist<T>(mutate: () => T): Promise<T> {
  let lastErr: unknown;
  mutationDepth += 1;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await loadFromDdb();
      const result = mutate();
      try {
        await persistAllowlistToDdb();
        return result;
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
    `Could not save the access list to DynamoDB: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseSsList(value: string[] | undefined): string[] {
  if (!value) return [];
  return value.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function assertValidEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error("Email is required");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Invalid email address");
  }
  return normalized;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function listApprovedAccess() {
  return {
    users: [...approvedUsers].sort(),
    admins: [...approvedAdmins].sort(),
    apiAccess: [...apiAccessEmails].sort(),
  };
}

/**
 * Whether an email may access the Developer tab and mint API keys.
 * Admins always qualify; other emails must be explicitly granted by an admin.
 */
export function isApiAccessAllowed(email: string | undefined): boolean {
  const normalized = normalizeEmail(email ?? "");
  if (!normalized) return false;
  if (approvedAdmins.has(normalized)) return true;
  return apiAccessEmails.has(normalized);
}

export async function setApiAccessEmail(email: string): Promise<{ email: string }> {
  const normalized = assertValidEmail(email);
  return applyAndPersist(() => {
    apiAccessEmails.add(normalized);
    return { email: normalized };
  });
}

export async function removeApiAccessEmail(email: string): Promise<{ email: string; removed: boolean }> {
  const normalized = normalizeEmail(email);
  return applyAndPersist(() => {
    const removed = apiAccessEmails.delete(normalized);
    return { email: normalized, removed };
  });
}

export function isEmailApproved(email: string): { approved: boolean; role: AuthRole } {
  const normalized = normalizeEmail(email);
  if (approvedAdmins.has(normalized)) return { approved: true, role: "admin" };
  if (approvedUsers.has(normalized)) return { approved: true, role: "user" };
  return { approved: false, role: "user" };
}

export async function setApprovedEmail(email: string, role: AuthRole): Promise<{ email: string; role: AuthRole }> {
  const normalized = assertValidEmail(email);
  return applyAndPersist(() => {
    if (role === "admin") {
      approvedUsers.delete(normalized);
      approvedAdmins.add(normalized);
    } else {
      approvedAdmins.delete(normalized);
      approvedUsers.add(normalized);
    }
    return { email: normalized, role };
  });
}

export async function removeApprovedEmail(email: string): Promise<{ email: string; removed: boolean }> {
  const normalized = normalizeEmail(email);
  return applyAndPersist(() => {
    const removed = approvedUsers.delete(normalized) || approvedAdmins.delete(normalized);
    return { email: normalized, removed };
  });
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
