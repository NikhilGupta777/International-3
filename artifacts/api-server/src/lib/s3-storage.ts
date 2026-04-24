import { createReadStream } from "fs";
import { basename, extname } from "path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "./logger";

const S3_BUCKET = process.env.S3_BUCKET ?? process.env.AWS_S3_BUCKET ?? "";
const S3_REGION = process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const S3_OBJECT_PREFIX = (process.env.S3_OBJECT_PREFIX ?? "ytgrabber").replace(
  /^\/+|\/+$/g,
  "",
);
const S3_SIGNED_URL_TTL_SEC = Math.max(
  60,
  Math.min(
    7 * 24 * 60 * 60,
    Number.parseInt(process.env.S3_SIGNED_URL_TTL_SEC ?? "7200", 10) || 7200,
  ),
);

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!isS3StorageEnabled()) {
    throw new Error(
      "S3 is not configured. Set S3_BUCKET (or AWS_S3_BUCKET) and AWS credentials.",
    );
  }
  if (!s3Client) {
    s3Client = new S3Client({ region: S3_REGION });
  }
  return s3Client;
}

function safeFilename(value: string): string {
  const cleaned = value.replace(/[^\w.\-() ]+/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 160) : "file.bin";
}

function inferContentType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".srt":
      return "application/x-subrip";
    case ".vtt":
      return "text/vtt";
    default:
      return "application/octet-stream";
  }
}

function buildObjectKey(namespace: string, jobId: string, filename: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const cleanedNamespace = namespace.replace(/^\/+|\/+$/g, "").replace(/\s+/g, "-");
  const objectName = `${jobId}-${safeFilename(filename)}`;
  return `${S3_OBJECT_PREFIX}/${cleanedNamespace}/${day}/${objectName}`;
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) return "";
  if (typeof (body as any).transformToString === "function") {
    return (body as any).transformToString();
  }
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    (body as NodeJS.ReadableStream)
      .on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      .on("error", reject);
  });
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof (body as any).transformToByteArray === "function") {
    return Buffer.from(await (body as any).transformToByteArray());
  }
  if (typeof (body as any).transformToString === "function") {
    return Buffer.from(await (body as any).transformToString(), "utf8");
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    (body as NodeJS.ReadableStream)
      .on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

export function isS3StorageEnabled(): boolean {
  return Boolean(S3_BUCKET);
}

export function getS3StorageConfig() {
  return {
    enabled: isS3StorageEnabled(),
    bucket: S3_BUCKET || null,
    region: S3_REGION,
    prefix: S3_OBJECT_PREFIX,
    signedUrlTtlSec: S3_SIGNED_URL_TTL_SEC,
  };
}

export async function uploadFileToS3(params: {
  localPath: string;
  jobId: string;
  namespace: string;
  filename?: string;
  contentType?: string;
}): Promise<{ bucket: string; key: string; filename: string }> {
  const client = getS3Client();
  const resolvedFilename = safeFilename(params.filename ?? basename(params.localPath));
  const key = buildObjectKey(params.namespace, params.jobId, resolvedFilename);
  const contentType = params.contentType ?? inferContentType(resolvedFilename);

  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: createReadStream(params.localPath),
      ContentType: contentType,
      CacheControl: "private, max-age=7200",
      Metadata: {
        "created-at": String(Date.now()),
        "source-app": "ytgrabber",
      },
    }),
  );

  return { bucket: S3_BUCKET, key, filename: resolvedFilename };
}

export async function uploadTextToS3(params: {
  body: string;
  jobId: string;
  namespace: string;
  filename: string;
  contentType?: string;
}): Promise<{ bucket: string; key: string; filename: string }> {
  const client = getS3Client();
  const resolvedFilename = safeFilename(params.filename);
  const key = buildObjectKey(params.namespace, params.jobId, resolvedFilename);
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: params.body,
      ContentType: params.contentType ?? inferContentType(resolvedFilename),
      CacheControl: "private, max-age=7200",
      Metadata: {
        "created-at": String(Date.now()),
        "source-app": "ytgrabber",
      },
    }),
  );
  return { bucket: S3_BUCKET, key, filename: resolvedFilename };
}

export async function createS3PresignedUpload(params: {
  jobId: string;
  namespace: string;
  filename: string;
  contentType?: string;
  expiresInSec?: number;
}): Promise<{ bucket: string; key: string; uploadUrl: string; filename: string }> {
  const client = getS3Client();
  const resolvedFilename = safeFilename(params.filename);
  const key = buildObjectKey(params.namespace, params.jobId, resolvedFilename);
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: params.contentType ?? inferContentType(resolvedFilename),
      CacheControl: "private, max-age=7200",
      Metadata: {
        "created-at": String(Date.now()),
        "source-app": "ytgrabber-upload",
      },
    }),
    {
      expiresIn: Math.max(
        60,
        Math.min(60 * 60, params.expiresInSec ?? 15 * 60),
      ),
    },
  );
  return { bucket: S3_BUCKET, key, uploadUrl, filename: resolvedFilename };
}

export async function getS3SignedDownloadUrl(params: {
  key: string;
  filename: string;
  expiresInSec?: number;
}): Promise<string> {
  const client = getS3Client();
  const expiresInSec = Math.max(
    60,
    Math.min(
      7 * 24 * 60 * 60,
      params.expiresInSec ?? S3_SIGNED_URL_TTL_SEC,
    ),
  );
  const contentType = inferContentType(params.filename);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: params.key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(params.filename)}"`,
      ResponseContentType: contentType,
    }),
    { expiresIn: expiresInSec },
  );
}

export async function deleteS3Object(key: string): Promise<void> {
  if (!isS3StorageEnabled()) return;
  const client = getS3Client();
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }),
    );
  } catch (err) {
    logger.warn({ err, key }, "Failed to delete S3 object");
  }
}

export async function readTextFromS3(key: string): Promise<string> {
  const client = getS3Client();
  const out = await client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
  );
  return bodyToString(out.Body);
}

export async function readBufferFromS3(key: string): Promise<Buffer> {
  const client = getS3Client();
  const out = await client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
  );
  return bodyToBuffer(out.Body);
}

export async function cleanupOldS3Objects(params: {
  namespace: string;
  maxAgeMs: number;
}): Promise<number> {
  if (!isS3StorageEnabled()) return 0;

  const client = getS3Client();
  const prefix = `${S3_OBJECT_PREFIX}/${params.namespace.replace(/^\/+|\/+$/g, "").replace(/\s+/g, "-")}/`;
  const cutoff = Date.now() - params.maxAgeMs;
  let continuationToken: string | undefined;
  let deletedCount = 0;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    const objects = result.Contents ?? [];
    for (const object of objects) {
      if (!object.Key || !object.LastModified) continue;
      if (object.LastModified.getTime() >= cutoff) continue;
      await deleteS3Object(object.Key);
      deletedCount += 1;
    }

    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return deletedCount;
}
