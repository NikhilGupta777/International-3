// Pita Ji thumbnail generator — Phase 5.
//
// Uses Gemini image generation (same pattern as bhagwat.ts) to create a
// thumbnail for a dispatched clip. The workflow:
//
//   1. Load settings from DDB (master thumbnail prompt + speaker images +
//      reference thumbnails).
//   2. Download speaker portrait + 2-3 reference images from S3.
//   3. Call Gemini with [speakerImage, refImages, textPrompt] → PNG.
//   4. Upload result to S3 at pitaji/jobs/{parentJobId}/thumbnails/{clipId}.png.
//   5. Update the pjc_* dispatch record with thumbnailS3Key + status.
//
// The generator runs fire-and-forget from the dispatch endpoint — it's
// non-blocking. Errors are written to the dispatch record, not thrown.

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import crypto from "crypto";
import { GoogleGenAI, Modality } from "@google/genai";
import { createGeminiClient, isGeminiConfigured, isVertexGeminiEnabled } from "./gemini-client";
import { uploadFileToS3, isS3StorageEnabled, readBufferFromS3 } from "./s3-storage";
import {
  getSettings,
  getClipDispatch,
  updateClipDispatch,
  type PitajiClip,
  type PitajiSpeakerImage,
  type PitajiReferenceThumbnail,
} from "./pitaji-store";

const THUMBNAIL_MODEL = "gemini-3.1-flash-image-preview";
const IMAGE_GEN_TIMEOUT_MS = 90_000;

// ── Main entry point ────────────────────────────────────────────────────────

export interface GenerateThumbnailArgs {
  /** pjc_* dispatch record ID */
  dispatchJobId: string;
  /** Parent analyze job ID (for S3 path organisation) */
  parentJobId: string;
  /** The clip metadata the thumbnail is for */
  clip: PitajiClip;
}

/**
 * Generate a thumbnail for a dispatched clip and persist the result.
 * This is designed to be called fire-and-forget — all errors are caught
 * and written to the dispatch record rather than thrown.
 */
export async function generateThumbnailForClip(args: GenerateThumbnailArgs): Promise<void> {
  const { dispatchJobId, parentJobId, clip } = args;
  const tmpDir = join(
    process.env.TMPDIR ?? process.env.TMP ?? "/tmp",
    `pitaji-thumb-${dispatchJobId}`,
  );

  try {
    if (!isGeminiConfigured()) {
      throw new Error("Gemini is not configured — cannot generate thumbnails");
    }
    if (!isS3StorageEnabled()) {
      throw new Error("S3 is not configured — cannot store thumbnails");
    }

    // Load settings
    const settings = await getSettings();
    const thumbnailPrompt = settings.thumbnailPrompt?.trim() || DEFAULT_THUMBNAIL_PROMPT;

    // Build the full prompt with clip context
    const fullPrompt = buildThumbnailPrompt(thumbnailPrompt, clip);

    // Generate the image
    const pngBytes = await withTimeout(
      generateImageBytes(fullPrompt, settings.speakers, settings.references),
      IMAGE_GEN_TIMEOUT_MS,
      "Thumbnail generation",
    );

    // Write to tmp + upload to S3
    mkdirSync(tmpDir, { recursive: true });
    const localPath = join(tmpDir, `${clip.id}.png`);
    writeFileSync(localPath, pngBytes);

    const s3Result = await uploadFileToS3({
      localPath,
      jobId: `${parentJobId}/thumbnails`,
      namespace: "pitaji",
      filename: `${clip.id}.png`,
      contentType: "image/png",
    });

    // Update dispatch record. For "both", thumbnail completion must not mark
    // the cut MP4 as ready; the cut status is rolled up separately.
    const current = await getClipDispatch(dispatchJobId).catch(() => null);
    await updateClipDispatch(dispatchJobId, {
      thumbnailS3Key: s3Result.key,
      thumbnailStatus: "done",
      ...(current?.action === "thumbnail" ? { status: "done" as const } : {}),
    });

    console.log(
      `[pitaji-thumbnail] Generated thumbnail for ${dispatchJobId} → ${s3Result.key}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Thumbnail generation failed";
    console.error(`[pitaji-thumbnail] Error for ${dispatchJobId}:`, err);
    try {
      const current = await getClipDispatch(dispatchJobId).catch(() => null);
      await updateClipDispatch(dispatchJobId, {
        thumbnailStatus: "error",
        ...(current?.action === "thumbnail" ? { status: "error" as const } : {}),
        error: `Thumbnail: ${message}`,
      });
    } catch {
      /* best effort */
    }
  } finally {
    // Cleanup tmp
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Prompt builder ──────────────────────────────────────────────────────────

const DEFAULT_THUMBNAIL_PROMPT = `Create a professional, eye-catching YouTube thumbnail.
Use bold typography, vibrant colors, and high contrast.
The thumbnail should be cinematic and spiritual in tone.
Include the speaker's face prominently.
Format: 16:9 landscape, 1280x720 resolution.`;

function buildThumbnailPrompt(masterPrompt: string, clip: PitajiClip): string {
  const parts: string[] = [masterPrompt];

  parts.push("");
  parts.push("=== CLIP CONTEXT ===");
  parts.push(`Title: ${clip.suggestedTitle || clip.title}`);
  if (clip.summary) parts.push(`Summary: ${clip.summary}`);
  if (clip.kind === "qna" && clip.question) {
    parts.push(`Question: ${clip.question}`);
  }
  if (clip.hashtags && clip.hashtags.length > 0) {
    parts.push(`Tags: ${clip.hashtags.join(", ")}`);
  }
  parts.push("");
  parts.push(
    "Create a thumbnail that visually represents this topic and would attract clicks on YouTube.",
  );

  return parts.join("\n");
}

// ── Image generation (mirrors bhagwat.ts pattern) ───────────────────────────

function getPersonalGeminiApiKeys(): string[] {
  if (isVertexGeminiEnabled()) return ["__vertex__"];
  const keys: string[] = [];
  const primary = (process.env.GEMINI_API_KEY ?? "").trim();
  if (primary) keys.push(primary);
  for (let i = 2; i <= 10; i++) {
    const k = (process.env[`GEMINI_API_KEY_${i}`] ?? "").trim();
    if (k) keys.push(k);
  }
  return keys;
}

async function generateImageBytes(
  prompt: string,
  _speakers: PitajiSpeakerImage[],
  _references: PitajiReferenceThumbnail[],
): Promise<Buffer> {
  const imageParts = await buildReferenceImageParts(_speakers, _references);

  // Try Replit integration first
  const replitBaseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const replitApiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (replitBaseUrl && replitApiKey) {
    try {
      const client = new GoogleGenAI({
        apiKey: replitApiKey,
        httpOptions: { apiVersion: "", baseUrl: replitBaseUrl },
      });
      const response = await client.models.generateContent({
        model: THUMBNAIL_MODEL,
        contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
        config: { responseModalities: [Modality.IMAGE] },
      });
      return extractImageBytes(response);
    } catch (err) {
      console.warn("[pitaji-thumbnail] Replit image gen failed, falling back:", err);
    }
  }

  // Fallback to own Gemini key
  const keys = getPersonalGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error("No Gemini API key configured for image generation");
  }

  let lastErr: unknown;
  for (let i = 0; i < keys.length; i++) {
    try {
      const client = isVertexGeminiEnabled()
        ? createGeminiClient()
        : new GoogleGenAI({ apiKey: keys[i] });
      const response = await client.models.generateContent({
        model: THUMBNAIL_MODEL,
        contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
          imageConfig: { aspectRatio: "16:9", imageSize: "2K" } as any,
        },
      });
      return extractImageBytes(response);
    } catch (err) {
      lastErr = err;
      console.warn(
        `[pitaji-thumbnail] Key ${i + 1}/${keys.length} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  throw lastErr ?? new Error("All image generation attempts failed");
}

async function buildReferenceImageParts(
  speakers: PitajiSpeakerImage[],
  references: PitajiReferenceThumbnail[],
): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const picked = [
    ...speakers.slice(0, 2).map((img) => img.s3Key),
    ...references.slice(0, 3).map((img) => img.s3Key),
  ];
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  for (const key of picked) {
    try {
      const bytes = await readBufferFromS3(key);
      if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) continue;
      parts.push({
        inlineData: {
          mimeType: inferImageMimeType(key),
          data: bytes.toString("base64"),
        },
      });
    } catch (err) {
      console.warn("[pitaji-thumbnail] Could not load reference image:", key, err);
    }
  }
  return parts;
}

function inferImageMimeType(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function extractImageBytes(response: unknown): Buffer {
  const resp = response as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }
  throw new Error("No image data in Gemini response");
}

// ── Timeout helper ──────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
