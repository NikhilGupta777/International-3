import { Storage } from "@google-cloud/storage";
import { ensureVertexCredentials } from "./gemini-client";
import { logger } from "./logger";

/**
 * Uploads a local file to GCS and returns the gs:// URI.
 */
export async function uploadLocalFileToGCS(
  localPath: string,
  destinationBlobName: string,
  mimeType: string
): Promise<string> {
  // Ensure credentials are hydrated
  await ensureVertexCredentials();

  const bucketName = (
    process.env.GOOGLE_CLOUD_STORAGE_BUCKET ||
    process.env.GCS_BUCKET ||
    ""
  ).trim();

  if (!bucketName) {
    throw new Error(
      "GCS upload requested but GOOGLE_CLOUD_STORAGE_BUCKET (or GCS_BUCKET) is not configured in .env."
    );
  }

  logger.info(
    { bucketName, destinationBlobName, mimeType },
    "Uploading file to Google Cloud Storage"
  );

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  await bucket.upload(localPath, {
    destination: destinationBlobName,
    metadata: {
      contentType: mimeType,
      cacheControl: "private, max-age=7200",
    },
  });

  const gcsUri = `gs://${bucketName}/${destinationBlobName}`;
  logger.info({ gcsUri }, "GCS upload complete");
  return gcsUri;
}

/**
 * Downloads a file from a URL to a temporary local path.
 */
export async function downloadUrlToTempFile(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file from URL ${url}: ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`No response body for URL ${url}`);
  }
  
  const { createWriteStream } = await import("fs");
  const { pipeline } = await import("stream/promises");
  const { Readable } = await import("stream");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const { randomUUID } = await import("crypto");

  const tempPath = join(tmpdir(), `vms-chat-attachment-${randomUUID()}`);
  const nodeStream = Readable.fromWeb(response.body as any);
  const fileStream = createWriteStream(tempPath);
  await pipeline(nodeStream, fileStream);
  return tempPath;
}

/**
 * Deletes a local temporary file.
 */
export async function deleteLocalFile(path: string): Promise<void> {
  const { promises: fsPromises } = await import("fs");
  try {
    await fsPromises.unlink(path);
  } catch (err: any) {
    logger.warn({ path, error: err.message }, "Failed to delete temp local file");
  }
}

