import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

export type EmailSubmissionInput = {
  email: string;
  name?: string;
  loginMethod?: "password" | "google" | "unknown";
  loginEmail?: string;
  role?: "admin" | "user";
  userAgent?: string;
};

export type EmailSubmissionRecord = {
  email: string;
  name: string;
  loginMethod: "password" | "google" | "unknown";
  loginEmail: string;
  role: "admin" | "user";
  source: "settings-email-notice";
  userAgent: string;
  submittedAt: number;
  updatedAt: number;
};

const ACCESS_TABLE = process.env.ACCESS_TABLE?.trim() ?? "";
const DDB_REGION =
  process.env.YOUTUBE_QUEUE_REGION?.trim() ||
  process.env.AWS_DEFAULT_REGION?.trim() ||
  "us-east-1";
const EMAIL_SUBMISSION_PK = "email-submission";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ddbClient = ACCESS_TABLE ? new DynamoDBClient({ region: DDB_REGION }) : null;

export function normalizeSubmittedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidSubmittedEmail(email: string): string {
  const normalized = normalizeSubmittedEmail(email);
  if (!normalized) throw new Error("Email is required");
  if (normalized.length > 254) throw new Error("Email is too long");
  if (!EMAIL_RE.test(normalized)) throw new Error("Invalid email address");
  return normalized;
}

function cleanString(value: string | undefined, maxLength: number): string {
  return (value ?? "").trim().slice(0, maxLength);
}

function cleanMethod(value: EmailSubmissionInput["loginMethod"]): EmailSubmissionRecord["loginMethod"] {
  return value === "password" || value === "google" ? value : "unknown";
}

function cleanRole(value: EmailSubmissionInput["role"]): EmailSubmissionRecord["role"] {
  return value === "admin" ? "admin" : "user";
}

function numberAttr(value: unknown): number {
  if (typeof value !== "object" || value === null || !("N" in value)) return 0;
  const parsed = Number((value as { N?: string }).N);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringAttr(value: unknown): string {
  if (typeof value !== "object" || value === null || !("S" in value)) return "";
  return String((value as { S?: string }).S ?? "");
}

function parseRecord(item: Record<string, unknown>): EmailSubmissionRecord {
  return {
    email: stringAttr(item.email || item.sk),
    name: stringAttr(item.name),
    loginMethod: cleanMethod(stringAttr(item.loginMethod) as EmailSubmissionInput["loginMethod"]),
    loginEmail: stringAttr(item.loginEmail),
    role: cleanRole(stringAttr(item.role) as EmailSubmissionInput["role"]),
    source: "settings-email-notice",
    userAgent: stringAttr(item.userAgent),
    submittedAt: numberAttr(item.submittedAt),
    updatedAt: numberAttr(item.updatedAt),
  };
}

export async function saveEmailSubmission(input: EmailSubmissionInput): Promise<EmailSubmissionRecord> {
  if (!ddbClient || !ACCESS_TABLE) {
    throw new Error("Email submission storage is not configured");
  }

  const now = Date.now();
  const email = assertValidSubmittedEmail(input.email);
  const name = cleanString(input.name, 120);
  if (!name) throw new Error("Name is required");
  const record: EmailSubmissionRecord = {
    email,
    name,
    loginMethod: cleanMethod(input.loginMethod),
    loginEmail: cleanString(input.loginEmail, 254).toLowerCase(),
    role: cleanRole(input.role),
    source: "settings-email-notice",
    userAgent: cleanString(input.userAgent, 240),
    submittedAt: now,
    updatedAt: now,
  };

  await ddbClient.send(
    new PutItemCommand({
      TableName: ACCESS_TABLE,
      Item: {
        pk: { S: EMAIL_SUBMISSION_PK },
        sk: { S: record.email },
        email: { S: record.email },
        name: { S: record.name },
        loginMethod: { S: record.loginMethod },
        loginEmail: { S: record.loginEmail },
        role: { S: record.role },
        source: { S: record.source },
        userAgent: { S: record.userAgent },
        submittedAt: { N: String(record.submittedAt) },
        updatedAt: { N: String(record.updatedAt) },
      },
    }),
  );

  return record;
}

export async function listEmailSubmissions(limit = 200): Promise<EmailSubmissionRecord[]> {
  if (!ddbClient || !ACCESS_TABLE) return [];

  const out = await ddbClient.send(
    new ScanCommand({
      TableName: ACCESS_TABLE,
      FilterExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: EMAIL_SUBMISSION_PK },
      },
      Limit: Math.min(Math.max(limit, 1), 500),
    }),
  );

  return (out.Items ?? [])
    .map((item) => parseRecord(item as Record<string, unknown>))
    .filter((item) => item.email)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
