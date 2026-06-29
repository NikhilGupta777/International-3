import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GoogleGenAI } from "@google/genai";
import { getNextAvailableKey, isKeyCooledDown, recordKeyFailure } from "../utils/key-circuit-breaker";

// Explicitly delete Vertex AI environment flags to prevent the @google/genai SDK
// from automatically routing requests to the Vertex AI endpoints.
delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
delete process.env.GEMINI_USE_VERTEXAI;
delete process.env.VERTEX_AI_ENABLED;

type HttpOptions = {
  timeout?: number;
  apiVersion?: string;
  baseUrl?: string;
};



export type GeminiClientOptions = {
  apiKey?: string;
  httpOptions?: HttpOptions;
  caller?: "agent" | "subtitles" | "timestamps" | "video-editor" | "fast-subtitles" | string;
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
  return false;
}

if (!isVertexGeminiEnabled()) {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_CLOUD_PROJECT;
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

export function getPersonalGeminiApiKeysList(): string[] {
  const keys: string[] = [];
  const first = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (first) keys.push(first);
  for (let index = 2; index <= 13; index += 1) {
    const envName = `GEMINI_API_KEY_${index}` as keyof NodeJS.ProcessEnv;
    const value = process.env[envName];
    if (value?.trim()) keys.push(value.trim());
  }
  return Array.from(new Set(keys));
}

export function getPersonalKeysForCaller(caller?: string): string[] {
  const baseKeys = getPersonalGeminiApiKeysList();
  if (baseKeys.length === 0) return [];

  // Timestamp tab: use from key 7 (index 6) going back to 1
  if (caller === "timestamps") {
    const startIndex = Math.min(baseKeys.length - 1, 6);
    const ordered: string[] = [];
    for (let i = startIndex; i >= 0; i--) {
      ordered.push(baseKeys[i]);
    }
    for (let i = 7; i < baseKeys.length; i++) {
      ordered.push(baseKeys[i]);
    }
    return ordered;
  }

  // Subtitles tab: use from last key (13th key, index 12) going back to 1
  if (caller === "subtitles") {
    const ordered: string[] = [];
    for (let i = baseKeys.length - 1; i >= 0; i--) {
      ordered.push(baseKeys[i]);
    }
    return ordered;
  }

  // Fast Subtitles tab: use from 9th key (index 8) to 13th key (index 12), then remaining keys backwards
  if (caller === "fast-subtitles") {
    const ordered: string[] = [];
    for (let i = 8; i < Math.min(baseKeys.length, 13); i++) {
      ordered.push(baseKeys[i]);
    }
    for (let i = Math.min(baseKeys.length - 1, 7); i >= 0; i--) {
      ordered.push(baseKeys[i]);
    }
    for (let i = 13; i < baseKeys.length; i++) {
      ordered.push(baseKeys[i]);
    }
    return ordered;
  }

  // AI Studio / Video Editor: use from 7th key (index 6) going back to 1
  if (caller === "video-editor") {
    const startIndex = Math.min(baseKeys.length - 1, 6);
    const ordered: string[] = [];
    for (let i = startIndex; i >= 0; i--) {
      ordered.push(baseKeys[i]);
    }
    for (let i = 7; i < baseKeys.length; i++) {
      ordered.push(baseKeys[i]);
    }
    return ordered;
  }

  // Agent / Copilot / Default: standard forward order (Key 1 to Key 13)
  return baseKeys;
}

let nextKeyIndex = 0;
export function getNextKeyIndex(): number {
  return nextKeyIndex;
}
export function setNextKeyIndex(index: number): void {
  nextKeyIndex = index;
}
export function getRotatedGeminiApiKey(caller?: string): string {
  const keys = getPersonalKeysForCaller(caller);
  if (keys.length === 0) return "";
  const result = getNextAvailableKey(keys, nextKeyIndex);
  nextKeyIndex = result.index;
  return result.key;
}

export function getPreferredGeminiApiKey(caller?: string): string {
  const keys = getPersonalKeysForCaller(caller);
  if (keys.length === 0) return "";
  return keys.find((key) => !isKeyCooledDown(key)) ?? keys[0];
}

export function getGeminiApiKeyForAttempt(caller: string | undefined, attempt: number): string {
  const keys = getPersonalKeysForCaller(caller);
  if (keys.length === 0) return "";
  const healthyKeys = keys.filter((key) => !isKeyCooledDown(key));
  const candidates = healthyKeys.length > 0 ? healthyKeys : keys;
  return candidates[Math.max(0, attempt) % candidates.length];
}

export function getPrimaryGeminiApiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
}

export function isGeminiConfigured(): boolean {
  if (isVertexGeminiEnabled()) {
    return !!getVertexProject() && !!getVertexLocation();
  }
  const keys = getPersonalGeminiApiKeysList();
  return keys.length > 0;
}

export function geminiProviderLabel(): "vertex" | "api-key" {
  return isVertexGeminiEnabled() ? "vertex" : "api-key";
}

export async function ensureVertexCredentials(): Promise<void> {
  if (!isVertexGeminiEnabled()) return;
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
      httpOptions: { apiVersion: "v1beta", ...options.httpOptions },
    });
  }

  const apiKey = (options.apiKey || getPreferredGeminiApiKey(options.caller)).trim();
  if (!apiKey) throw new Error("Gemini API key is not configured.");

  const baseKeys = getPersonalGeminiApiKeysList();
  const indexInBase = baseKeys.indexOf(apiKey);
  console.log(`[Gemini Keys] Client instantiated with key ...${apiKey.slice(-6)} (key ${indexInBase + 1}) for ${options.caller ?? "default"}`);

  return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta", ...options.httpOptions } });
}

export function buildThinkingConfig(
  model: string,
  level: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | string,
): Record<string, any> {
  const normalizedLevel = level === "MINIMAL" || level === "LOW" || level === "MEDIUM" || level === "HIGH" ? level : "MEDIUM";
  if (model.includes("2.5")) {
    const budget = normalizedLevel === "HIGH" ? 24576 : normalizedLevel === "MEDIUM" ? 8192 : 1024;
    return { thinkingBudget: budget };
  }
  return { thinkingLevel: normalizedLevel };
}

function isRetryableGeminiError(err: any): boolean {
  const message = String(err?.message ?? err ?? "");
  const status = err?.status ?? err?.code;
  return (
    status === 429 ||
    status === 500 ||
    status === 503 ||
    /resource.?exhausted|quota.*exceeded|rate.?limit|429|503|unavailable|overloaded|high demand|timeout|deadline|fetch failed|ECONNRESET|internal|500/i.test(message)
  );
}

export async function generateContentWithRotation(
  params: {
    model: string;
    fallbackModels?: string[];
    contents: any;
    config?: any;
  },
  options: GeminiClientOptions = {},
): Promise<any> {
  if (isVertexGeminiEnabled()) {
    const client = createGeminiClient(options);
    return client.models.generateContent(params);
  }

  const keys = getPersonalKeysForCaller(options.caller);
  if (keys.length === 0) {
    throw new Error("No Gemini API key configured.");
  }

  let lastErr: any = null;
  const models = Array.from(new Set([params.model, ...(params.fallbackModels ?? [])].filter(Boolean)));
  const totalAttempts = Math.min(keys.length, 13) * models.length;
  let attempt = 0;
  for (const model of models) {
    for (let keyAttempt = 0; keyAttempt < Math.min(keys.length, 13); keyAttempt++) {
      attempt++;
      const apiKey = getGeminiApiKeyForAttempt(options.caller, keyAttempt);

      const baseKeys = getPersonalGeminiApiKeysList();
      const indexInBase = baseKeys.indexOf(apiKey);
      console.log(`[Gemini Keys] Rotation attempt ${attempt}/${totalAttempts} using key ...${apiKey.slice(-6)} (key ${indexInBase + 1}) on model ${model} for ${options.caller ?? "default"}`);

      try {
        const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta", ...options.httpOptions } });
        const result = await client.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        return result;
      } catch (err: any) {
        lastErr = err;
        const errMsg = err?.message ?? String(err);
        console.warn(
          `[Gemini Rotation] Attempt ${attempt}/${totalAttempts} failed on ${model} using key suffix ...${apiKey.slice(-6)}: ${errMsg}. Trying next key/model...`
        );
        // Asynchronously report the key failure to the circuit breaker
        recordKeyFailure(apiKey, err).catch(() => {});

        if (isRetryableGeminiError(err)) {
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 100));
        }
      }
    }
  }

  throw lastErr ?? new Error("Gemini call failed on all keys in rotation.");
}
