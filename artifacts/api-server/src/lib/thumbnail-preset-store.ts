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
  uploadBufferToS3,
  readBufferFromS3,
  deleteS3Object,
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
export const PRESET_MIN_IMAGES = 5;
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
  key: string;       // S3 object key for the reference image
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
  data?: string;       // base64 (no data: prefix), for newly-added images
  key?: string;        // existing S3 object key, for edits that preserve refs
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

// ── S3 image helpers ───────────────────────────────────────────────────────
async function putPresetImage(presetId: string, idx: number, img: PresetImageInput): Promise<PresetImageRef> {
  const ext = img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg";
  const filename = `ref-${idx}-${Date.now()}.${ext}`;
  const { key } = await uploadBufferToS3({
    body: Buffer.from(img.data ?? "", "base64"),
    jobId: presetId,
    namespace: PRESET_NS,
    filename,
    contentType: img.mimeType,
  });
  return { key, mimeType: img.mimeType, filename };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** List a user's presets with app-served preview URLs for each image. */
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

  const result = [];
  for (const r of recs) {
    result.push({
      id: r.jobId,
      name: r.name,
      stylePrompt: r.stylePrompt,
      imageCount: r.images.length,
      images: r.images.map((im, idx) => ({
        key: im.key,
        url: `/api/thumbnail/presets/${encodeURIComponent(r.jobId)}/images/${idx}`,
      })),
      updatedAt: r.updatedAt,
    });
  }
  return result;
}

// ── Simple in-process preset image cache ────────────────────────────────────
// Loading 12 reference images from S3 on every /chat request adds 1-3s
// latency per generation. Cache them in-process for 5 minutes.
type CachedPreset = {
  name: string;
  stylePrompt: string;
  images: Array<{ data: string; mimeType: string }>;
  expiresAt: number;
};
const presetCache = new Map<string, CachedPreset>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export async function upsertPreset(params: {
  id?: string;
  owner: string;
  name: string;
  stylePrompt: string;
  images: PresetImageInput[];   // full desired image set
}): Promise<ThumbnailPresetRecord> {
  if (!isPresetStoreEnabled()) throw new Error("Preset storage is not configured.");
  if (!params.owner) throw new Error("Not authenticated.");
  const name = params.name.trim();
  if (!name) throw new Error("Channel name is required.");
  const imgs = params.images.slice(0, PRESET_MAX_IMAGES);
  if (imgs.length < PRESET_MIN_IMAGES) throw new Error(`Add at least ${PRESET_MIN_IMAGES} reference images.`);

  const id = params.id && params.id.startsWith("tp_") ? params.id : newPresetId();

  // Capture the old image refs BEFORE uploading, so we can clean them up
  // AFTER the new DDB record is committed. This avoids a partial-failure
  // state where the old objects are deleted but the new record is not yet written.
  let oldImages: PresetImageRef[] = [];
  let existing: ThumbnailPresetRecord | null = null;
  if (params.id) {
    existing = await getPresetRecord(id);
    if (existing && existing.owner === params.owner) {
      oldImages = existing.images;
    }
  }
  const oldByKey = new Map(oldImages.map((im) => [im.key, im]));

  // 1. Preserve existing refs that still belong to this preset, and validate
  //    the full desired set before uploading any new image bytes.
  const desired = imgs.map((img) => {
    if (img.key) {
      const old = oldByKey.get(img.key);
      if (old) return { kind: "existing" as const, ref: old };
    }
    if (img.data) return { kind: "upload" as const, image: img };
    return null;
  }).filter((item): item is { kind: "existing"; ref: PresetImageRef } | { kind: "upload"; image: PresetImageInput } => item !== null);

  if (desired.length < PRESET_MIN_IMAGES) {
    throw new Error(`Add at least ${PRESET_MIN_IMAGES} valid reference images.`);
  }

  // 2. Upload new images. If a later upload fails, remove the already-uploaded
  //    objects so a failed save does not leak orphan preset assets.
  const refs: PresetImageRef[] = [];
  const uploaded: PresetImageRef[] = [];
  try {
    for (let i = 0; i < desired.length; i++) {
      const item = desired[i];
      if (item.kind === "existing") {
        refs.push(item.ref);
      } else {
        const ref = await putPresetImage(id, i, item.image);
        uploaded.push(ref);
        refs.push(ref);
      }
    }
  } catch (err) {
    await Promise.allSettled(uploaded.map((im) => deleteS3Object(im.key)));
    throw err;
  }

  const now = Date.now();
  const rec: ThumbnailPresetRecord = {
    jobId: id,
    kind: KIND,
    owner: params.owner,
    name,
    stylePrompt: params.stylePrompt.trim().slice(0, 2000),
    images: refs,
    // Preserve the original createdAt if this is an update.
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // 3. Write the DDB record (atomically replaces the old one). If this write
  //    fails, clean up newly uploaded images because no record references them.
  try {
    await client().send(new PutItemCommand({ TableName: TABLE_NAME, Item: encode(rec) }));
  } catch (err) {
    await Promise.allSettled(uploaded.map((im) => deleteS3Object(im.key)));
    throw err;
  }

  // 4. ONLY AFTER DDB is committed, delete old S3 objects (best-effort).
  //    If this fails, some unreferenced objects remain in S3 — acceptable.
  if (oldImages.length > 0) {
    const kept = new Set(refs.map((im) => im.key));
    await Promise.allSettled(oldImages.filter((im) => !kept.has(im.key)).map((im) => deleteS3Object(im.key)));
  }

  // Invalidate cache so next load picks up the new images.
  presetCache.delete(id);

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
  await client().send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { jobId: { S: id } } }));
  await Promise.allSettled(rec.images.map((im) => deleteS3Object(im.key)));
  presetCache.delete(id);
  return true;
}

/** Load a preset's reference images as base64 (for feeding the image model).
 *  Results are cached in-process for 5 minutes to avoid S3 round-trips on
 *  every /chat request when a preset is active. */
export async function loadPresetImages(id: string, owner: string): Promise<{
  name: string;
  stylePrompt: string;
  images: Array<{ data: string; mimeType: string }>;
} | null> {
  // Check cache first.
  const cached = presetCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { name: cached.name, stylePrompt: cached.stylePrompt, images: cached.images };
  }

  const rec = await getPresetRecord(id);
  if (!rec || rec.owner !== owner) return null;

  // Load all images in parallel for speed.
  const imageResults = await Promise.allSettled(
    rec.images.map(async (im) => {
      const data = await readPresetImageBytes(im.key, im.mimeType);
      return data.bytes.length > 0 ? { data: data.bytes.toString("base64"), mimeType: data.mimeType } : null;
    }),
  );
  const images = imageResults
    .filter((r): r is PromiseFulfilledResult<{ data: string; mimeType: string }> =>
      r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);

  // Cache the result.
  presetCache.set(id, { name: rec.name, stylePrompt: rec.stylePrompt, images, expiresAt: Date.now() + CACHE_TTL_MS });

  return { name: rec.name, stylePrompt: rec.stylePrompt, images };
}

export async function readPresetImageAt(id: string, owner: string, index: number): Promise<{
  bytes: Buffer;
  mimeType: string;
  filename: string;
} | null> {
  const rec = await getPresetRecord(id);
  if (!rec || rec.owner !== owner) return null;
  const ref = rec.images[index];
  if (!ref) return null;
  const data = await readPresetImageBytes(ref.key, ref.mimeType);
  return { ...data, filename: ref.filename ?? `reference-${index + 1}` };
}

async function readPresetImageBytes(key: string, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const raw = await readBufferFromS3(key);
  if (looksLikeBase64Text(raw)) {
    const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
    if (decoded.length > 0) return { bytes: decoded, mimeType };
  }
  return { bytes: raw, mimeType };
}

function looksLikeBase64Text(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 256)).toString("utf8");
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(sample)) return false;
  const text = buf.toString("utf8").trim();
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(text);
}
