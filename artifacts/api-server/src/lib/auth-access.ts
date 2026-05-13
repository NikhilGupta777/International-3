import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

export type AuthRole = "admin" | "user";

// ── In-memory sets (seeded from env vars on cold start) ──────────────────────
// These are the authoritative runtime sets. DynamoDB is used as a persistent
// backing store so that emails added via the admin panel survive Lambda restarts.
const approvedUsers = parseCsvSet(process.env.APPROVED_USER_EMAILS);
const approvedAdmins = parseCsvSet(process.env.APPROVED_ADMIN_EMAILS);

// ── DynamoDB persistence (optional — gracefully disabled when table is absent) ─
const ddbClient =
  process.env.ACCESS_TABLE
    ? new DynamoDBClient({
        region: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      })
    : null;

const ACCESS_TABLE = process.env.ACCESS_TABLE ?? "";
// Single-row document — PK: "allowlist", SK: "v1"
const ALLOWLIST_PK = "allowlist";
const ALLOWLIST_SK = "v1";

// ── Hydrate from DynamoDB on cold start ─────────────────────────────────────
// Fire-and-forget: if DynamoDB is unavailable we fall back to env-var lists.
let _hydratePromise: Promise<void> | null = null;

export function hydrateAllowlistFromDdb(): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return Promise.resolve();
  if (_hydratePromise) return _hydratePromise;

  _hydratePromise = (async () => {
    try {
      const out = await ddbClient.send(
        new GetItemCommand({
          TableName: ACCESS_TABLE,
          Key: {
            pk: { S: ALLOWLIST_PK },
            sk: { S: ALLOWLIST_SK },
          },
        }),
      );
      const item = out.Item;
      if (!item) return;

      const ddbUsers = parseSsList(item.users?.SS);
      const ddbAdmins = parseSsList(item.admins?.SS);

      for (const e of ddbUsers) approvedUsers.add(e);
      for (const e of ddbAdmins) {
        approvedAdmins.add(e);
        approvedUsers.delete(e); // ensure no duplicates
      }
    } catch (err) {
      console.warn("[auth-access] Could not hydrate allowlist from DynamoDB:", err);
    }
  })();

  return _hydratePromise;
}

// Persist current in-memory state to DynamoDB (best-effort)
async function persistAllowlistToDdb(): Promise<void> {
  if (!ddbClient || !ACCESS_TABLE) return;
  try {
    const users = [...approvedUsers].sort();
    const admins = [...approvedAdmins].sort();
    await ddbClient.send(
      new PutItemCommand({
        TableName: ACCESS_TABLE,
        Item: {
          pk: { S: ALLOWLIST_PK },
          sk: { S: ALLOWLIST_SK },
          users: users.length > 0 ? { SS: users } : { NULL: true },
          admins: admins.length > 0 ? { SS: admins } : { NULL: true },
          updatedAt: { N: String(Date.now()) },
        },
      }),
    );
  } catch (err) {
    console.warn("[auth-access] Could not persist allowlist to DynamoDB:", err);
  }
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

// ── Public API ───────────────────────────────────────────────────────────────

export function listApprovedAccess() {
  return {
    users: [...approvedUsers].sort(),
    admins: [...approvedAdmins].sort(),
  };
}

export function isEmailApproved(email: string): { approved: boolean; role: AuthRole } {
  const normalized = normalizeEmail(email);
  if (approvedAdmins.has(normalized)) return { approved: true, role: "admin" };
  if (approvedUsers.has(normalized)) return { approved: true, role: "user" };
  return { approved: false, role: "user" };
}

export async function setApprovedEmail(email: string, role: AuthRole): Promise<{ email: string; role: AuthRole }> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error("Email is required");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Invalid email address");
  }

  if (role === "admin") {
    approvedUsers.delete(normalized);
    approvedAdmins.add(normalized);
  } else {
    approvedAdmins.delete(normalized);
    approvedUsers.add(normalized);
  }

  await persistAllowlistToDdb();
  return { email: normalized, role };
}

export async function removeApprovedEmail(email: string): Promise<{ email: string; removed: boolean }> {
  const normalized = normalizeEmail(email);
  const removed = approvedUsers.delete(normalized) || approvedAdmins.delete(normalized);
  await persistAllowlistToDdb();
  return { email: normalized, removed };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
