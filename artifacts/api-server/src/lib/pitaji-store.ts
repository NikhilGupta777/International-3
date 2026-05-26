// Pita Ji DynamoDB store — reuses the existing `ytgrabber-green-jobs` table
// (configured via YOUTUBE_QUEUE_JOB_TABLE) so we don't introduce new infra.
//
// Records are partitioned by `jobId` PK with prefixes:
//   pj_<uuid>           → analyze job (kind="pitaji-analyze")
//   pjc_<uuid>          → dispatched clip (kind="pitaji-clip")
//   pitaji-settings     → singleton settings row (kind="pitaji-settings")
//
// All other table consumers (download / clip-cut / bhagwat / etc.) ignore
// records whose `kind` doesn't match their own prefix, and never collide on
// jobId thanks to the `pj_` / `pjc_` namespace.
//
// We follow the codebase's existing DDB style — raw AttributeValue maps
// (`{ S: ... }`, `{ N: ... }`) — instead of `@aws-sdk/util-dynamodb`, which is
// not a workspace dependency. Complex nested values (clip arrays, settings
// lists) are JSON-stringified into a single `S` attribute.

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";

function envTrim(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

const TABLE_NAME =
  envTrim("PITAJI_JOB_TABLE") ||
  envTrim("YOUTUBE_QUEUE_JOB_TABLE") ||
  "ytgrabber-green-jobs";

const REGION =
  envTrim("PITAJI_DDB_REGION") ||
  envTrim("YOUTUBE_QUEUE_REGION") ||
  envTrim("AWS_DEFAULT_REGION") ||
  "us-east-1";

let _client: DynamoDBClient | null = null;
function client(): DynamoDBClient {
  if (!_client) _client = new DynamoDBClient({ region: REGION });
  return _client;
}

export function isPitajiStoreEnabled(): boolean {
  return Boolean(TABLE_NAME);
}

export function newAnalyzeJobId(): string {
  return `pj_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function newClipJobId(): string {
  return `pjc_${crypto.randomUUID().replace(/-/g, "")}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type PitajiClipKind = "topic" | "qna";

export interface PitajiClip {
  id: string;
  kind: PitajiClipKind;
  title: string;
  summary: string;
  question?: string;
  answer?: string;
  startSec: number;
  endSec: number;
  speakerHint?: string;
  suggestedTitle?: string;
  description?: string;
  hashtags?: string[];
  pinnedComment?: string;
  /** Set after dispatch to track the cut + thumbnail children */
  dispatchedAt?: number;
}

export type PitajiPipelineMode = "youtube_direct" | "audio_split";

export type PitajiAnalyzeStatus =
  | "queued"
  | "running"
  | "reviewing"
  | "dispatched"
  | "done"
  | "error"
  | "cancelled";

export interface PitajiAnalyzeJob {
  jobId: string;
  kind: "pitaji-analyze";
  status: PitajiAnalyzeStatus;
  youtubeUrl: string;
  videoId?: string;
  videoTitle?: string;
  durationSec?: number;
  channel?: string;
  pipelineMode?: PitajiPipelineMode;
  chunks?: number;
  clips?: PitajiClip[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type PitajiClipDispatchStatus =
  | "queued"
  | "cutting"
  | "thumbnail-pending"
  | "done"
  | "error";

export interface PitajiClipDispatch {
  jobId: string; // pjc_*
  kind: "pitaji-clip";
  parentJobId: string; // pj_*
  clip: PitajiClip;
  action: "cut" | "thumbnail" | "both";
  status: PitajiClipDispatchStatus;
  cutChildJobId?: string; // points to a youtube clip-cut job
  cutS3Key?: string;
  cutFilename?: string;
  thumbnailChildJobId?: string;
  thumbnailS3Key?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PitajiSpeakerImage {
  id: string;
  label: string;
  s3Key: string;
  uploadedAt: number;
}

export interface PitajiReferenceThumbnail {
  id: string;
  s3Key: string;
  uploadedAt: number;
}

export interface PitajiSettings {
  jobId: "pitaji-settings";
  kind: "pitaji-settings";
  thumbnailPrompt: string;
  clipInstructions: string;
  speakers: PitajiSpeakerImage[];
  references: PitajiReferenceThumbnail[];
  updatedAt: number;
}

// ── Attribute encode / decode ────────────────────────────────────────────────

function S(value: string | undefined | null): AttributeValue | null {
  if (value === undefined || value === null || value === "") return null;
  return { S: value };
}

function N(value: number | undefined | null): AttributeValue | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  return { N: String(value) };
}

function J(value: unknown): AttributeValue | null {
  if (value === undefined || value === null) return null;
  // Empty arrays still serialize as "[]" — keep them so the reader sees a defined list.
  return { S: JSON.stringify(value) };
}

function readS(item: Record<string, AttributeValue> | undefined, key: string): string | undefined {
  const v = item?.[key];
  return v && typeof v.S === "string" ? v.S : undefined;
}

function readN(item: Record<string, AttributeValue> | undefined, key: string): number | undefined {
  const v = item?.[key];
  if (v && typeof v.N === "string") {
    const n = Number(v.N);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function readJ<T>(item: Record<string, AttributeValue> | undefined, key: string): T | undefined {
  const raw = readS(item, key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function dropNulls(obj: Record<string, AttributeValue | null>): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

// ── Analyze job CRUD ─────────────────────────────────────────────────────────

function encodeAnalyzeJob(job: PitajiAnalyzeJob): Record<string, AttributeValue> {
  return dropNulls({
    jobId: S(job.jobId),
    kind: S(job.kind),
    status: S(job.status),
    youtubeUrl: S(job.youtubeUrl),
    videoId: S(job.videoId),
    videoTitle: S(job.videoTitle),
    durationSec: N(job.durationSec),
    channel: S(job.channel),
    pipelineMode: S(job.pipelineMode),
    chunks: N(job.chunks),
    clips: J(job.clips ?? []),
    error: S(job.error),
    createdAt: N(job.createdAt),
    updatedAt: N(job.updatedAt),
  });
}

function decodeAnalyzeJob(item: Record<string, AttributeValue>): PitajiAnalyzeJob | null {
  const jobId = readS(item, "jobId");
  const kind = readS(item, "kind");
  if (!jobId || kind !== "pitaji-analyze") return null;
  return {
    jobId,
    kind: "pitaji-analyze",
    status: (readS(item, "status") as PitajiAnalyzeStatus | undefined) ?? "queued",
    youtubeUrl: readS(item, "youtubeUrl") ?? "",
    videoId: readS(item, "videoId"),
    videoTitle: readS(item, "videoTitle"),
    durationSec: readN(item, "durationSec"),
    channel: readS(item, "channel"),
    pipelineMode: readS(item, "pipelineMode") as PitajiPipelineMode | undefined,
    chunks: readN(item, "chunks"),
    clips: readJ<PitajiClip[]>(item, "clips") ?? [],
    error: readS(item, "error"),
    createdAt: readN(item, "createdAt") ?? 0,
    updatedAt: readN(item, "updatedAt") ?? 0,
  };
}

export async function putAnalyzeJob(job: PitajiAnalyzeJob): Promise<void> {
  await client().send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: encodeAnalyzeJob(job),
    }),
  );
}

export async function getAnalyzeJob(jobId: string): Promise<PitajiAnalyzeJob | null> {
  const out = await client().send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
    }),
  );
  if (!out.Item) return null;
  return decodeAnalyzeJob(out.Item);
}

/**
 * Apply a partial update to an analyze job. Updates `updatedAt` automatically.
 * Complex fields (clips array) are re-serialized via JSON.
 */
export async function updateAnalyzeJob(
  jobId: string,
  patch: Partial<Omit<PitajiAnalyzeJob, "jobId" | "kind" | "createdAt">>,
): Promise<void> {
  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  let i = 0;

  const pushAttr = (key: string, value: AttributeValue | null): void => {
    if (value === null) return;
    const nameAlias = `#k${i}`;
    const valueAlias = `:v${i}`;
    sets.push(`${nameAlias} = ${valueAlias}`);
    names[nameAlias] = key;
    values[valueAlias] = value;
    i += 1;
  };

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    switch (k) {
      case "status":
      case "youtubeUrl":
      case "videoId":
      case "videoTitle":
      case "channel":
      case "pipelineMode":
      case "error":
        pushAttr(k, S(v as string | undefined));
        break;
      case "durationSec":
      case "chunks":
        pushAttr(k, N(v as number | undefined));
        break;
      case "clips":
        pushAttr(k, J(v));
        break;
      default:
        // Ignore unknown keys — keeps the encoder strict and predictable.
        break;
    }
  }

  pushAttr("updatedAt", N(Date.now()));
  if (sets.length === 0) return;

  await client().send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deleteAnalyzeJob(jobId: string): Promise<void> {
  await client().send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
    }),
  );
}

/**
 * List analyze jobs newest-first. Pita Ji is single-user so we scan and filter
 * — at expected volumes (≤ a few hundred per month) this is cheap. If volume
 * grows we can later add a GSI on `kind`.
 */
export async function listAnalyzeJobs(limit = 50): Promise<PitajiAnalyzeJob[]> {
  const normalizedLimit = Math.max(1, Math.min(500, limit));
  const collected: PitajiAnalyzeJob[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  for (let page = 0; page < 10; page += 1) {
    const out = await client().send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "#kind = :kind",
        ExpressionAttributeNames: { "#kind": "kind" },
        ExpressionAttributeValues: { ":kind": { S: "pitaji-analyze" } },
        Limit: Math.max(100, normalizedLimit * 4),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );

    const pageItems = (out.Items ?? [])
      .map(decodeAnalyzeJob)
      .filter((x): x is PitajiAnalyzeJob => x !== null);
    collected.push(...pageItems);

    exclusiveStartKey = out.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    if (!exclusiveStartKey || collected.length >= normalizedLimit * 8) break;
  }

  collected.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return collected.slice(0, normalizedLimit);
}
  );
  const items = (out.Items ?? [])
    .map(decodeAnalyzeJob)
    .filter((x): x is PitajiAnalyzeJob => x !== null);
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return items.slice(0, Math.max(1, Math.min(500, limit)));
}

// ── Clip dispatch CRUD ───────────────────────────────────────────────────────

function encodeClipDispatch(rec: PitajiClipDispatch): Record<string, AttributeValue> {
  return dropNulls({
    jobId: S(rec.jobId),
    kind: S(rec.kind),
    parentJobId: S(rec.parentJobId),
    clip: J(rec.clip),
    action: S(rec.action),
    status: S(rec.status),
    cutChildJobId: S(rec.cutChildJobId),
    cutS3Key: S(rec.cutS3Key),
    cutFilename: S(rec.cutFilename),
    thumbnailChildJobId: S(rec.thumbnailChildJobId),
    thumbnailS3Key: S(rec.thumbnailS3Key),
    error: S(rec.error),
    createdAt: N(rec.createdAt),
    updatedAt: N(rec.updatedAt),
  });
}

function decodeClipDispatch(item: Record<string, AttributeValue>): PitajiClipDispatch | null {
  const jobId = readS(item, "jobId");
  const kind = readS(item, "kind");
  if (!jobId || kind !== "pitaji-clip") return null;
  const clip = readJ<PitajiClip>(item, "clip");
  if (!clip) return null;
  return {
    jobId,
    kind: "pitaji-clip",
    parentJobId: readS(item, "parentJobId") ?? "",
    clip,
    action: (readS(item, "action") as PitajiClipDispatch["action"]) ?? "cut",
    status: (readS(item, "status") as PitajiClipDispatchStatus) ?? "queued",
    cutChildJobId: readS(item, "cutChildJobId"),
    cutS3Key: readS(item, "cutS3Key"),
    cutFilename: readS(item, "cutFilename"),
    thumbnailChildJobId: readS(item, "thumbnailChildJobId"),
    thumbnailS3Key: readS(item, "thumbnailS3Key"),
    error: readS(item, "error"),
    createdAt: readN(item, "createdAt") ?? 0,
    updatedAt: readN(item, "updatedAt") ?? 0,
  };
}

export async function putClipDispatch(rec: PitajiClipDispatch): Promise<void> {
  await client().send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: encodeClipDispatch(rec),
    }),
  );
}

export async function getClipDispatch(jobId: string): Promise<PitajiClipDispatch | null> {
  const out = await client().send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
    }),
  );
  if (!out.Item) return null;
  return decodeClipDispatch(out.Item);
}

export async function updateClipDispatch(
  jobId: string,
  patch: Partial<Omit<PitajiClipDispatch, "jobId" | "kind" | "createdAt">>,
): Promise<void> {
  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  let i = 0;
  const pushAttr = (key: string, value: AttributeValue | null): void => {
    if (value === null) return;
    const nameAlias = `#k${i}`;
    const valueAlias = `:v${i}`;
    sets.push(`${nameAlias} = ${valueAlias}`);
    names[nameAlias] = key;
    values[valueAlias] = value;
    i += 1;
  };

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    switch (k) {
      case "parentJobId":
      case "action":
      case "status":
      case "cutChildJobId":
      case "cutS3Key":
      case "cutFilename":
      case "thumbnailChildJobId":
      case "thumbnailS3Key":
      case "error":
        pushAttr(k, S(v as string | undefined));
        break;
      case "clip":
        pushAttr(k, J(v));
        break;
      default:
        break;
    }
  }
  pushAttr("updatedAt", N(Date.now()));
  if (sets.length === 0) return;

  await client().send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function listClipDispatchesByParent(parentJobId: string): Promise<PitajiClipDispatch[]> {
  const out = await client().send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#kind = :kind AND #parent = :parent",
      ExpressionAttributeNames: { "#kind": "kind", "#parent": "parentJobId" },
      ExpressionAttributeValues: {
        ":kind": { S: "pitaji-clip" },
        ":parent": { S: parentJobId },
      },
    }),
  );
  return (out.Items ?? [])
    .map(decodeClipDispatch)
    .filter((x): x is PitajiClipDispatch => x !== null)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

// ── Settings (singleton) ─────────────────────────────────────────────────────

const SETTINGS_KEY = "pitaji-settings";

const DEFAULT_SETTINGS: PitajiSettings = {
  jobId: SETTINGS_KEY,
  kind: "pitaji-settings",
  thumbnailPrompt: "",
  clipInstructions: "",
  speakers: [],
  references: [],
  updatedAt: 0,
};

function decodeSettings(item: Record<string, AttributeValue>): PitajiSettings | null {
  const kind = readS(item, "kind");
  if (kind !== "pitaji-settings") return null;
  return {
    jobId: SETTINGS_KEY,
    kind: "pitaji-settings",
    thumbnailPrompt: readS(item, "thumbnailPrompt") ?? "",
    clipInstructions: readS(item, "clipInstructions") ?? "",
    speakers: readJ<PitajiSpeakerImage[]>(item, "speakers") ?? [],
    references: readJ<PitajiReferenceThumbnail[]>(item, "references") ?? [],
    updatedAt: readN(item, "updatedAt") ?? 0,
  };
}

export async function getSettings(): Promise<PitajiSettings> {
  const out = await client().send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: SETTINGS_KEY } },
    }),
  );
  if (!out.Item) return { ...DEFAULT_SETTINGS };
  return decodeSettings(out.Item) ?? { ...DEFAULT_SETTINGS };
}

export async function putSettings(settings: PitajiSettings): Promise<void> {
  const rec: PitajiSettings = {
    ...settings,
    jobId: SETTINGS_KEY,
    kind: "pitaji-settings",
    updatedAt: Date.now(),
  };
  await client().send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: dropNulls({
        jobId: S(rec.jobId),
        kind: S(rec.kind),
        thumbnailPrompt: S(rec.thumbnailPrompt) ?? { S: "" },
        clipInstructions: S(rec.clipInstructions) ?? { S: "" },
        speakers: J(rec.speakers ?? []),
        references: J(rec.references ?? []),
        updatedAt: N(rec.updatedAt),
      }),
    }),
  );
}
