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
const BUCKET = process.env.S3_BUCKET_NAME ?? "malikaeditorr";
const REGION = process.env.AWS_REGION ?? "ap-south-1";
const UPLOADS_TABLE = process.env.UPLOADS_TABLE ?? "";
const MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB
const PART_SIZE = 10 * 1024 * 1024;        // 10 MB per part
const SINGLE_LIMIT = 50 * 1024 * 1024;        // use single PUT for < 50 MB
const TTL_UPLOAD = 7_200;                   // 2h presigned upload URL
const TTL_DOWNLOAD = 86_400;                  // 24h presigned download URL

const s3 = new S3Client({ region: REGION });
const ddb = UPLOADS_TABLE ? new DynamoDBClient({ region: REGION }) : null;

// ── In-memory fallback & Rate Limiting ───────────────────────────────────────
const mem = new Map<string, Record<string, any>>();
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + 3600000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 3600000;
  }
  if (record.count >= 20) return false;
  record.count++;
  rateLimitMap.set(ip, record);
  return true;
}

// ── DynamoDB helpers ───────────────────────────────────────────────────────
function toDb(v: any) {
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  return { S: String(v) };
}
function fromDb(item: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(item)) {
    if (v.S !== undefined) out[k] = v.S;
    else if (v.N !== undefined) out[k] = Number(v.N);
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
    const values: Record<string, any> = {};
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
    let collected: Record<string, any>[] = [];
    let currentCursor: Record<string, any> | undefined = cursor ? { fileId: { S: cursor } } : undefined;

    while (collected.length < limit) {
      const res = await ddb.send(new ScanCommand({
        TableName: UPLOADS_TABLE,
        FilterExpression: "#v = :pub AND #s = :done",
        ExpressionAttributeNames: { "#v": "visibility", "#s": "status" },
        ExpressionAttributeValues: { ":pub": { S: "public" }, ":done": { S: "done" } },
        Limit: 100, // Process 100 items per batch to find public ones
        ...(currentCursor ? { ExclusiveStartKey: currentCursor } : {}),
      }));
      collected.push(...(res.Items ?? []));
      currentCursor = res.LastEvaluatedKey as Record<string, any> | undefined;
      if (!currentCursor) break;
    }

    const sliced = collected.slice(0, limit);
    let nextCursorStr: string | undefined = undefined;

    if (collected.length > limit) {
      nextCursorStr = sliced[sliced.length - 1].fileId.S;
    } else if (currentCursor) {
      nextCursorStr = currentCursor.fileId?.S;
    }

    return {
      files: sliced.map(fromDb),
      nextCursor: nextCursorStr,
    };
  }
  const all = Array.from(mem.values())
    .filter(f => f.visibility === "public" && f.status === "done")
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  const startIndex = cursor ? all.findIndex(f => f.fileId === cursor) + 1 : 0;
  const sliced = all.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < all.length ? sliced[sliced.length - 1]?.fileId : undefined;
  return { files: sliced, nextCursor };
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
    const rawIp = req.headers["x-forwarded-for"] || req.ip || req.socket.remoteAddress || "unknown";
    const ip = Array.isArray(rawIp) ? rawIp[0] : rawIp.split(",")[0].trim();
    if (!checkRateLimit(ip)) return res.status(429).json({ error: "Rate limit exceeded. Max 20 uploads per hour." });

    const { filename, size, mimeType, visibility = "public", title = "", description = "" } = req.body ?? {};
    if (!filename || typeof size !== "number") return res.status(400).json({ error: "filename and size required" });
    if (size > MAX_BYTES) return res.status(400).json({ error: "File exceeds 3 GB limit." });
    if (size < 1) return res.status(400).json({ error: "Invalid file size." });

    const fileId = randomUUID();
    const safeName = String(filename).replace(/[^\w.\-]/g, "_").slice(0, 200);
    const vis = visibility === "private" ? "private" : "public";
    const s3Key = `share/${vis}/${fileId}/${safeName}`;
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

    if (record.multipartUploadId) {
      if (!Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: "Parts array is required for multipart complete." });
      }
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

    const isPreview = req.query.preview === "1";
    const wantsJson = req.query.json === "1";
    const wantsDownload = req.query.download === "1";

    const params: any = { Bucket: BUCKET, Key: record.s3Key };
    if (!isPreview) {
      params.ResponseContentDisposition = `attachment; filename="${encodeURIComponent(record.filename)}"`;
    }
    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: BUCKET, Key: record.s3Key,
      ResponseContentDisposition: isPreview ? "inline" : `attachment; filename="${record.filename}"`
    }), { expiresIn: TTL_DOWNLOAD });

    // If they actually download or preview, increment count
    if (!isPreview && (wantsJson || wantsDownload)) {
      dbUpdate(record.fileId, { downloadCount: (record.downloadCount ?? 0) + 1 }).catch(() => { });
    }

    const { s3Key: _, multipartUploadId: __, ...safe } = record;

    if (wantsJson || isPreview) {
      return res.json({ ...safe, downloadUrl });
    }

    if (wantsDownload) {
      return res.redirect(downloadUrl);
    }

    // Direct browser visit -> Return a beautiful HTML landing page
    const sizeMB = (record.size / 1024 / 1024).toFixed(2);
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Download ${record.filename}</title>
  <style>
    body { margin: 0; background: #0a0a0a; color: white; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; overflow: hidden; }
    .bg-grid { position: absolute; inset: 0; background-size: 40px 40px; background-image: linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px); z-index: -1; }
    .bg-glow { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 600px; height: 600px; background: radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%); z-index: -1; }
    .card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); padding: 2.5rem 2rem; border-radius: 1.25rem; text-align: center; max-width: 420px; width: 90%; backdrop-filter: blur(10px); }
    .icon { width: 56px; height: 56px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 1rem; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem auto; }
    .icon svg { width: 28px; height: 28px; color: rgba(255,255,255,0.7); }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 0.5rem 0; line-height: 1.4; word-break: break-all; color: rgba(255,255,255,0.9); }
    p.meta { color: rgba(255,255,255,0.4); font-size: 0.85rem; margin: 0 0 2rem 0; }
    a.btn { display: flex; align-items: center; justify-content: center; gap: 0.5rem; background: white; color: black; text-decoration: none; padding: 0.875rem 1.5rem; border-radius: 0.75rem; font-weight: 600; font-size: 0.9rem; transition: all 0.2s; box-shadow: 0 4px 12px rgba(255,255,255,0.1); }
    a.btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(255,255,255,0.15); }
    a.btn svg { width: 18px; height: 18px; }
    .footer { margin-top: 1.5rem; font-size: 0.75rem; color: rgba(255,255,255,0.25); }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="bg-glow"></div>
  <div class="card">
    <div class="icon">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
    </div>
    <h1>${record.title || record.filename}</h1>
    <p class="meta">${sizeMB} MB • Shared securely</p>
    <a href="?download=1" class="btn">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download File
    </a>
    <div class="footer">Powered by VideoMaking</div>
  </div>
</body>
</html>
    `;
    return res.send(html);
  } catch (err) {
    logger.error({ err }, "[uploads] get file failed");
    return res.status(500).json({ error: "Failed to get file." });
  }
});

// ── GET /api/uploads/public ───────────────────────────────────────────────
router.get("/public", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "24")), 50);
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
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: record.s3Key })).catch(() => { });
    await dbDelete(record.fileId);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "[uploads] delete failed");
    return res.status(500).json({ error: "Failed to delete." });
  }
});

export default router;
