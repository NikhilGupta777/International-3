// Thumbnail Studio — Brand Preset store (AWS DynamoDB + S3).
//
// Mirrors the codebase's existing DDB style (see pitaji-store.ts): reuse the
// shared jobs table, namespace records with a `kind` + id prefix, and store the
// record as raw AttributeValue maps. Reference-image BYTES live in S3 (a DDB
// item caps at 400KB, far too small for 5–12 images); the DDB record only holds
// each image's S3 key + mime type, plus channel name and style prompt.
//
//   PK jobId = tp_<uuid>     kind = "thumbnail-preset"
//   owner    = user email (presets are per-user)
//   images   = JSON [{ key, mimeType }]  → S3 objects under thumbnail-presets/<id>/

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import {
  isS3StorageEnabled,
  uploadTextToS3,
  readTextFromS3,
  deleteS3Object,
  getS3SignedDownloadUrl,
} from "./s3-storage";

function envTrim(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

const TABLE_NAME =
  envTrim("THUMBNAIL_PRESET_TABLE") ||
  envTrim("YOUTUBE_QUEUE_JOB_TABLE") ||
  "ytgrabber-green-jobs";

const REGION =
  envTrim("THUMBNAIL_DDB_REGION") ||
  envTrim("YOUTUBE_QUEUE_REGION") ||
  envTrim("AWS_DEFAULT_REGION") ||
  envTrim("AWS_REGION") ||
  "us-east-1";

const KIND = "thumbnail-preset";
const PRESET_NS = "thumbnail-presets";
export const PRESET_MAX_IMAGES = 12;
// Presets are shared across the whole app (channel brand assets), stored under
// one fixed owner key. Admins write them; everyone reads/uses them.
export const SHARED_PRESET_OWNER = "__thumbnail_shared__";

let _client: DynamoDBClient | null = null;
function client(): DynamoDBClient {
  if (!_client) _client = new DynamoDBClient({ region: REGION });
  return _client;
}

export function isPresetStoreEnabled(): boolean {
  return Boolean(TABLE_NAME) && isS3StorageEnabled();
}

export function newPresetId(): string {
  return `tp_${crypto.randomUUID().replace(/-/g, "")}`;
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface PresetImageRef {
  key: string;       // S3 object key (stores base64 text of the image)
  mimeType: string;
  filename?: string;
}

export interface ThumbnailPresetRecord {
  jobId: string;     // tp_<uuid>
  kind: typeof KIND;
  owner: string;
  name: string;
  stylePrompt: string;
  images: PresetImageRef[];
  createdAt: number;
  updatedAt: number;
}

// Image as sent to / from the client (base64, no data: prefix).
export interface PresetImageInput {
  mimeType: string;
  data: string;       // base64 (no data: prefix)
  filename?: string;
}

// ── Encode / decode DDB item ───────────────────────────────────────────────
function encode(rec: ThumbnailPresetRecord): Record<string, AttributeValue> {
  return {
    jobId: { S: rec.jobId },
    kind: { S: rec.kind },
    owner: { S: rec.owner },
    name: { S: rec.name },
    stylePrompt: { S: rec.stylePrompt ?? "" },
    images: { S: JSON.stringify(rec.images ?? []) },
    createdAt: { N: String(rec.createdAt) },
    updatedAt: { N: String(rec.updatedAt) },
  };
}

function decode(item: Record<string, AttributeValue>): ThumbnailPresetRecord | null {
  if (!item?.jobId?.S || item.kind?.S !== KIND) return null;
  let images: PresetImageRef[] = [];
  try { images = JSON.parse(item.images?.S ?? "[]"); } catch { images = []; }
  return {
    jobId: item.jobId.S,
    kind: KIND,
    owner: item.owner?.S ?? "",
    name: item.name?.S ?? "Untitled",
    stylePrompt: item.stylePrompt?.S ?? "",
    images,
    createdAt: Number(item.createdAt?.N ?? "0"),
    updatedAt: Number(item.updatedAt?.N ?? "0"),
  };
}

// ── S3 image helpers (store base64 text per image) ─────────────────────────
async function putPresetImage(presetId: string, idx: number, img: PresetImageInput): Promise<PresetImageRef> {
  const ext = img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg";
  const filename = `ref-${idx}-${Date.now()}.${ext}.b64`;
  const { key } = await uploadTextToS3({
    body: img.data,
    jobId: presetId,
    namespace: PRESET_NS,
    filename,
    contentType: "text/plain",
  });
  return { key, mimeType: img.mimeType, filename };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** List a user's presets with short-lived signed preview URLs for each image. */
export async function listPresetsForOwner(owner: string): Promise<Array<{
  id: string;
  name: string;
  stylePrompt: string;
  imageCount: number;
  images: Array<{ key: string; url: string }>;
  updatedAt: number;
}>> {
  if (!isPresetStoreEnabled() || !owner) return [];
  const out = await client().send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: "#kind = :kind AND #owner = :owner",
    ExpressionAttributeNames: { "#kind": "kind", "#owner": "owner" },
    ExpressionAttributeValues: { ":kind": { S: KIND }, ":owner": { S: owner } },
  }));
  const recs = (out.Items ?? []).map(decode).filter(Boolean) as ThumbnailPresetRecord[];
  recs.sort((a, b) => b.updatedAt - a.updatedAt);

  // Signed preview URLs. The stored objects are base64 text; for previews we
  // return a signed URL to the raw object — the client only needs the data it
  // already has at create time, so previews are best-effort here.
  const result = [];
  for (const r of recs) {
    const images = await Promise.all(
      r.images.map(async (im) => ({
        key: im.key,
        url: await getS3SignedDownloadUrl({ key: im.key, filename: "ref", expiresInSec: 6 * 60 * 60 }).catch(() => ""),
      })),
    );
    result.push({
      id: r.jobId,
      name: r.name,
      stylePrompt: r.stylePrompt,
      imageCount: r.images.length,
      images,
      updatedAt: r.updatedAt,
    });
  }
  return result;
}

/** Create or replace a preset. Uploads image bytes to S3, writes the DDB record. */
export async function upsertPreset(params: {
  id?: string;
  owner: string;
  name: string;
  stylePrompt: string;
  images: PresetImageInput[];   // full desired image set (base64)
}): Promise<ThumbnailPresetRecord> {
  if (!isPresetStoreEnabled()) throw new Error("Preset storage is not configured.");
  if (!params.owner) throw new Error("Not authenticated.");
  const name = params.name.trim();
  if (!name) throw new Error("Channel name is required.");
  const imgs = params.images.slice(0, PRESET_MAX_IMAGES);
  if (imgs.length < 1) throw new Error("Add at least one reference image.");

  const id = params.id && params.id.startsWith("tp_") ? params.id : newPresetId();

  // If updating, delete old S3 objects first (we re-upload the full set).
  if (params.id) {
    const existing = await getPresetRecord(id);
    if (existing && existing.owner === params.owner) {
      await Promise.allSettled(existing.images.map((im) => deleteS3Object(im.key)));
    }
  }

  const refs: PresetImageRef[] = [];
  for (let i = 0; i < imgs.length; i++) {
    refs.push(await putPresetImage(id, i, imgs[i]));
  }

  const now = Date.now();
  const rec: ThumbnailPresetRecord = {
    jobId: id,
    kind: KIND,
    owner: params.owner,
    name,
    stylePrompt: params.stylePrompt.trim().slice(0, 2000),
    images: refs,
    createdAt: now,
    updatedAt: now,
  };
  await client().send(new PutItemCommand({ TableName: TABLE_NAME, Item: encode(rec) }));
  return rec;
}

export async function getPresetRecord(id: string): Promise<ThumbnailPresetRecord | null> {
  if (!isPresetStoreEnabled() || !id) return null;
  const out = await client().send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { jobId: { S: id } },
  }));
  return out.Item ? decode(out.Item) : null;
}

export async function deletePresetForOwner(id: string, owner: string): Promise<boolean> {
  if (!isPresetStoreEnabled()) return false;
  const rec = await getPresetRecord(id);
  if (!rec || rec.owner !== owner) return false;
  await Promise.allSettled(rec.images.map((im) => deleteS3Object(im.key)));
  await client().send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { jobId: { S: id } } }));
  return true;
}

/** Load a preset's reference images as base64 (for feeding the image model). */
export async function loadPresetImages(id: string, owner: string): Promise<{
  name: string;
  stylePrompt: string;
  images: Array<{ data: string; mimeType: string }>;
} | null> {
  const rec = await getPresetRecord(id);
  if (!rec || rec.owner !== owner) return null;
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const im of rec.images) {
    try {
      const b64 = await readTextFromS3(im.key);
      if (b64) images.push({ data: b64, mimeType: im.mimeType });
    } catch { /* skip unreadable */ }
  }
  return { name: rec.name, stylePrompt: rec.stylePrompt, images };
}
