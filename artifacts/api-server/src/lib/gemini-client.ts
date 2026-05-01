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
