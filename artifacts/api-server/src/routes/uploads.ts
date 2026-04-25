/**
 * File Share Upload route — /api/uploads/*
 * - Presigned S3 multipart uploads (10MB parts, up to 3GB)
 * - DynamoDB metadata (falls back to in-memory if UPLOADS_TABLE not set)
 * - Public/private visibility
 * - Public gallery listing
 */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import pino from "pino";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  ScanCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";

const logger = pino({ name: "uploads" });
const router = Router();

// ── Config ─────────────────────────────────────────────────────────────────
const BUCKET         = process.env.S3_BUCKET_NAME ?? "malikaeditorr";
const REGION         = process.env.AWS_REGION ?? "ap-south-1";
const UPLOADS_TABLE  = process.env.UPLOADS_TABLE ?? "";
const MAX_BYTES      = 3 * 1024 * 1024 * 1024; // 3 GB
const PART_SIZE      = 10 * 1024 * 1024;        // 10 MB per part
const SINGLE_LIMIT   = 50 * 1024 * 1024;        // use single PUT for < 50 MB
const TTL_UPLOAD     = 7_200;                   // 2h presigned upload URL
const TTL_DOWNLOAD   = 86_400;                  // 24h presigned download URL

const s3  = new S3Client({ region: REGION });
const ddb = UPLOADS_TABLE ? new DynamoDBClient({ region: REGION }) : null;

// ── In-memory fallback ─────────────────────────────────────────────────────
const mem = new Map<string, Record<string, any>>();

// ── DynamoDB helpers ───────────────────────────────────────────────────────
function toDb(v: any) {
  if (typeof v === "string")  return { S: v };
  if (typeof v === "number")  return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  return { S: String(v) };
}
function fromDb(item: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(item)) {
    if      (v.S    !== undefined) out[k] = v.S;
    else if (v.N    !== undefined) out[k] = Number(v.N);
    else if (v.BOOL !== undefined) out[k] = v.BOOL;
  }
  return out;
}

async function dbPut(item: Record<string, any>) {
  if (ddb) {
    const dbItem: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) dbItem[k] = toDb(v);
    await ddb.send(new PutItemCommand({ TableName: UPLOADS_TABLE, Item: dbItem }));
  } else {
    mem.set(item.fileId, { ...item });
  }
}

async function dbGet(fileId: string) {
  if (ddb) {
    const res = await ddb.send(new GetItemCommand({
      TableName: UPLOADS_TABLE, Key: { fileId: { S: fileId } }, ConsistentRead: true,
    }));
    return res.Item ? fromDb(res.Item) : null;
  }
  return mem.get(fileId) ?? null;
}

async function dbUpdate(fileId: string, updates: Record<string, any>) {
  if (ddb) {
    const names: Record<string, string> = {};
    const values: Record<string, any>  = {};
    const sets: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(updates)) {
      names[`#k${i}`] = k; values[`:v${i}`] = toDb(v);
      sets.push(`#k${i} = :v${i}`); i++;
    }
    await ddb.send(new UpdateItemCommand({
      TableName: UPLOADS_TABLE, Key: { fileId: { S: fileId } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } else {
    const existing = mem.get(fileId) ?? {};
    mem.set(fileId, { ...existing, ...updates });
  }
}

async function dbListPublic(limit = 24, cursor?: string) {
  if (ddb) {
    const res = await ddb.send(new ScanCommand({
      TableName: UPLOADS_TABLE,
      FilterExpression: "#v = :pub AND #s = :done",
      ExpressionAttributeNames: { "#v": "visibility", "#s": "status" },
      ExpressionAttributeValues: { ":pub": { S: "public" }, ":done": { S: "done" } },
      Limit: limit,
      ...(cursor ? { ExclusiveStartKey: { fileId: { S: cursor } } } : {}),
    }));
    return {
      files: (res.Items ?? []).map(fromDb),
      nextCursor: res.LastEvaluatedKey?.fileId?.S,
    };
  }
  const all = Array.from(mem.values())
    .filter(f => f.visibility === "public" && f.status === "done")
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  return { files: all.slice(0, limit), nextCursor: undefined };
}

async function dbDelete(fileId: string) {
  if (ddb) {
    await ddb.send(new DeleteItemCommand({
      TableName: UPLOADS_TABLE, Key: { fileId: { S: fileId } },
    }));
  } else {
    mem.delete(fileId);
  }
}

// ── POST /api/uploads/presign ─────────────────────────────────────────────
router.post("/presign", async (req: Request, res: Response) => {
  try {
    const { filename, size, mimeType, visibility = "public", title = "", description = "" } = req.body ?? {};
    if (!filename || typeof size !== "number") return res.status(400).json({ error: "filename and size required" });
    if (size > MAX_BYTES) return res.status(400).json({ error: "File exceeds 3 GB limit." });
    if (size < 1) return res.status(400).json({ error: "Invalid file size." });

    const fileId      = randomUUID();
    const safeName    = String(filename).replace(/[^\w.\-]/g, "_").slice(0, 200);
    const vis         = visibility === "private" ? "private" : "public";
    const s3Key       = `share/${vis}/${fileId}/${safeName}`;
    const contentType = String(mimeType || "application/octet-stream").slice(0, 200);

    await dbPut({
      fileId, s3Key, filename: safeName, originalFilename: String(filename).slice(0, 500),
      title: String(title).slice(0, 200), description: String(description).slice(0, 1000),
      size, mimeType: contentType, visibility: vis,
      uploadedAt: Date.now(), status: "pending", downloadCount: 0,
    });

    if (size <= SINGLE_LIMIT) {
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: BUCKET, Key: s3Key, ContentType: contentType, ContentLength: size,
      }), { expiresIn: TTL_UPLOAD });
      return res.json({ fileId, uploadType: "single", presignedUrl: url });
    }

    // Multipart
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
      Bucket: BUCKET, Key: s3Key, ContentType: contentType,
    }));
    await dbUpdate(fileId, { multipartUploadId: UploadId!, status: "uploading" });

    const partCount = Math.ceil(size / PART_SIZE);
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_, i) => ({
        partNumber: i + 1,
        signedUrl: await getSignedUrl(s3, new UploadPartCommand({
          Bucket: BUCKET, Key: s3Key, UploadId: UploadId!, PartNumber: i + 1,
        }), { expiresIn: TTL_UPLOAD }),
      }))
    );

    return res.json({ fileId, uploadType: "multipart", uploadId: UploadId, parts });
  } catch (err) {
    logger.error({ err }, "[uploads] presign failed");
    return res.status(500).json({ error: "Failed to initialize upload." });
  }
});

// ── POST /api/uploads/complete ────────────────────────────────────────────
router.post("/complete", async (req: Request, res: Response) => {
  try {
    const { fileId, parts } = req.body ?? {};
    if (!fileId) return res.status(400).json({ error: "fileId required" });
    const record = await dbGet(fileId);
    if (!record) return res.status(404).json({ error: "Upload not found." });

    if (Array.isArray(parts) && parts.length > 0 && record.multipartUploadId) {
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: BUCKET, Key: record.s3Key, UploadId: record.multipartUploadId,
        MultipartUpload: { Parts: parts.map((p: any) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }));
    }

    await dbUpdate(fileId, { status: "done" });
    const host = `${req.protocol}://${req.get("host")}`;
    return res.json({
      fileId,
      shareUrl: `${host}/api/uploads/file/${fileId}`,
      filename: record.filename,
      size: record.size,
      visibility: record.visibility,
    });
  } catch (err) {
    logger.error({ err }, "[uploads] complete failed");
    return res.status(500).json({ error: "Failed to complete upload." });
  }
});

// ── GET /api/uploads/file/:fileId ─────────────────────────────────────────
router.get("/file/:fileId", async (req: Request, res: Response) => {
  try {
    const record = await dbGet(String(req.params.fileId));
    if (!record || record.status !== "done") return res.status(404).json({ error: "File not found." });
    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: BUCKET, Key: record.s3Key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(record.filename)}"`,
    }), { expiresIn: TTL_DOWNLOAD });
    dbUpdate(record.fileId, { downloadCount: (record.downloadCount ?? 0) + 1 }).catch(() => {});
    const { s3Key: _, multipartUploadId: __, ...safe } = record;
    return res.json({ ...safe, downloadUrl });
  } catch (err) {
    logger.error({ err }, "[uploads] get file failed");
    return res.status(500).json({ error: "Failed to get file." });
  }
});

// ── GET /api/uploads/public ───────────────────────────────────────────────
router.get("/public", async (req: Request, res: Response) => {
  try {
    const limit  = Math.min(parseInt(String(req.query.limit ?? "24")), 50);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const { files, nextCursor } = await dbListPublic(limit, cursor);
    const safe = files.map(({ s3Key: _, multipartUploadId: __, ...f }) => f);
    return res.json({ files: safe, nextCursor });
  } catch (err) {
    logger.error({ err }, "[uploads] list public failed");
    return res.status(500).json({ error: "Failed to list files." });
  }
});

// ── DELETE /api/uploads/file/:fileId ─────────────────────────────────────
router.delete("/file/:fileId", async (req: Request, res: Response) => {
  try {
    const record = await dbGet(String(req.params.fileId));
    if (!record) return res.status(404).json({ error: "File not found." });
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: record.s3Key })).catch(() => {});
    await dbDelete(record.fileId);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "[uploads] delete failed");
    return res.status(500).json({ error: "Failed to delete." });
  }
});

export default router;
