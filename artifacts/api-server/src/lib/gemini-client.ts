import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GoogleGenAI } from "@google/genai";

type HttpOptions = {
  timeout?: number;
  apiVersion?: string;
  baseUrl?: string;
};

type GeminiClientOptions = {
  apiKey?: string;
  httpOptions?: HttpOptions;
};

let credentialsHydrated = false;
let s3CredentialsFetched = false;
// In-flight deduplicator: if multiple callers race before credentials are
// ready they all await the same promise instead of each returning early.
let s3FetchInFlight: Promise<void> | null = null;

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function isVertexGeminiEnabled(): boolean {
  return (
    envFlag(process.env.GOOGLE_GENAI_USE_VERTEXAI) ||
    envFlag(process.env.GEMINI_USE_VERTEXAI) ||
    envFlag(process.env.VERTEX_AI_ENABLED)
  );
}

export function getVertexProject(): string {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.VERTEX_AI_PROJECT ||
    process.env.GEMINI_VERTEX_PROJECT ||
    ""
  ).trim();
}

export function getVertexLocation(): string {
  return (
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.VERTEX_AI_LOCATION ||
    process.env.GEMINI_VERTEX_LOCATION ||
    "global"
  ).trim();
}

/**
 * Load Vertex credentials from S3 if GOOGLE_APPLICATION_CREDENTIALS_S3_KEY is set.
 * This avoids the 4 KB Lambda env-var limit by storing the service-account JSON in
 * the same S3 bucket the rest of the app uses.  The file is written to /tmp once at
 * cold start and cached for the Lambda lifetime.
 */
async function fetchCredentialsFromS3(): Promise<void> {
  // Already done — fast path.
  if (s3CredentialsFetched) return;

  // Another caller is already fetching — wait for that promise so we don't
  // race past it with a stale flag check.
  if (s3FetchInFlight) return s3FetchInFlight;

  s3FetchInFlight = (async () => {
    const s3Key = (process.env.GOOGLE_APPLICATION_CREDENTIALS_S3_KEY ?? "").trim();
    const bucket = (process.env.S3_BUCKET ?? "").trim();
    const region = (process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1").trim();
    if (!s3Key || !bucket) { s3CredentialsFetched = true; return; }

    // Already have a valid local file — nothing to do.
    const existingPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (existingPath && existsSync(existingPath)) { s3CredentialsFetched = true; return; }

    try {
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region });
      const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
      const chunks: Buffer[] = [];
      for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const payload = Buffer.concat(chunks).toString("utf8").trim();
      if (payload) {
        const credPath = join(tmpdir(), "google-vertex-credentials.json");
        writeFileSync(credPath, payload, { encoding: "utf8", mode: 0o600 });
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
        console.log("[gemini-client] Vertex credentials loaded from S3");
      }
      // Only mark done AFTER credentials are successfully on disk.
      s3CredentialsFetched = true;
    } catch (err) {
      console.error("[gemini-client] Failed to load Vertex credentials from S3:", (err as Error).message);
      // Leave s3CredentialsFetched = false so the next request retries.
    } finally {
      s3FetchInFlight = null;
    }
  })();

  return s3FetchInFlight;
}

function hydrateGoogleCredentials(): void {
  if (credentialsHydrated) return;
  credentialsHydrated = true;

  const existingPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (existingPath && existsSync(existingPath)) return;

  const rawJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  const rawBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64?.trim();
  const payload = rawJson || (rawBase64 ? Buffer.from(rawBase64, "base64").toString("utf8") : "");
  if (!payload) return;

  const path = join(tmpdir(), "google-vertex-credentials.json");
  writeFileSync(path, payload, { encoding: "utf8", mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
}

/**
 * Pre-warm: fetch Vertex credentials from S3 at cold start.
 * This runs once when the module loads so credentials are ready before the
 * first request. Errors are logged but do not crash the process.
 */
if (isVertexGeminiEnabled() && (process.env.GOOGLE_APPLICATION_CREDENTIALS_S3_KEY ?? "").trim()) {
  fetchCredentialsFromS3().catch((err) => {
    console.error("[gemini-client] S3 credential pre-warm failed:", (err as Error).message);
  });
}

export function getPrimaryGeminiApiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
}

export function isGeminiConfigured(): boolean {
  if (isVertexGeminiEnabled()) {
    return !!getVertexProject() && !!getVertexLocation();
  }
  return !!getPrimaryGeminiApiKey();
}

export function geminiProviderLabel(): "vertex" | "api-key" {
  return isVertexGeminiEnabled() ? "vertex" : "api-key";
}

export async function ensureVertexCredentials(): Promise<void> {
  await fetchCredentialsFromS3();
  hydrateGoogleCredentials();
}

export function createGeminiClient(options: GeminiClientOptions = {}): GoogleGenAI {
  if (isVertexGeminiEnabled()) {
    const project = getVertexProject();
    const location = getVertexLocation();
    if (!project) throw new Error("Vertex Gemini is enabled but GOOGLE_CLOUD_PROJECT is not configured.");
    if (!location) throw new Error("Vertex Gemini is enabled but GOOGLE_CLOUD_LOCATION is not configured.");
    hydrateGoogleCredentials();
    return new GoogleGenAI({
      vertexai: true,
      project,
      location,
      httpOptions: options.httpOptions,
    });
  }

  const apiKey = (options.apiKey || getPrimaryGeminiApiKey()).trim();
  if (!apiKey) throw new Error("Gemini API key is not configured.");
  return new GoogleGenAI({ apiKey, httpOptions: options.httpOptions });
}
