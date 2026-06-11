/**
 * Google Drive connector — service-account auth, folder-restricted.
 *
 * Design:
 *   - One service account credential (no per-user OAuth dance).
 *   - User shares ONE Drive folder with the SA email.
 *   - GOOGLE_DRIVE_WORKSPACE_FOLDER_ID is the only allowed root.
 *   - Every file access validates the parent chain ends at the allowed folder.
 *   - Read-only scope. No write back to Drive in Phase 2.
 *
 * Env:
 *   GOOGLE_DRIVE_WORKSPACE_FOLDER_ID   required — root folder id (must be shared with SA)
 *   GOOGLE_DRIVE_SA_JSON               service-account JSON (inline)   ─ pick one
 *   GOOGLE_DRIVE_SA_JSON_BASE64        service-account JSON (base64)   ─
 *   GOOGLE_DRIVE_SA_S3_KEY             S3 key with SA JSON             ─
 *
 * No googleapis SDK — direct HTTPS calls keep the Lambda image lean.
 */
import crypto from "crypto";
import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { logger } from "./logger";

// ── Config ────────────────────────────────────────────────────────────────
const ALLOWED_FOLDER_ID = (process.env.GOOGLE_DRIVE_WORKSPACE_FOLDER_ID ?? "").trim();
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MAX_PARENT_WALK = 16;
const MAX_DRIVE_FILE_BYTES = Number.parseInt(process.env.DRIVE_MAX_IMPORT_BYTES ?? "", 10) || 1024 * 1024 * 1024; // 1 GB
const TOKEN_REFRESH_SKEW_SEC = 60;

// ── Service account loading ───────────────────────────────────────────────
type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let saPromise: Promise<ServiceAccount | null> | null = null;

async function loadServiceAccount(): Promise<ServiceAccount | null> {
  if (saPromise) return saPromise;
  saPromise = (async () => {
    const inline = process.env.GOOGLE_DRIVE_SA_JSON?.trim();
    if (inline) return parseSaJson(inline, "GOOGLE_DRIVE_SA_JSON");

    const b64 = process.env.GOOGLE_DRIVE_SA_JSON_BASE64?.trim();
    if (b64) {
      try {
        return parseSaJson(Buffer.from(b64, "base64").toString("utf8"), "GOOGLE_DRIVE_SA_JSON_BASE64");
      } catch (err) {
        logger.error({ err }, "[drive] failed to decode SA base64");
        return null;
      }
    }

    const s3Key = process.env.GOOGLE_DRIVE_SA_S3_KEY?.trim();
    if (s3Key) {
      try {
        const bucket = process.env.S3_BUCKET ?? "malikaeditorr";
        const region = process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";
        const s3 = new S3Client({ region });
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
        const body = await res.Body?.transformToString("utf8");
        if (!body) throw new Error("empty SA object body");
        return parseSaJson(body, `s3://${bucket}/${s3Key}`);
      } catch (err) {
        logger.error({ err }, "[drive] failed to load SA from S3");
        return null;
      }
    }

    return null;
  })();
  return saPromise;
}

function parseSaJson(raw: string, source: string): ServiceAccount {
  const obj = JSON.parse(raw);
  if (!obj.client_email || !obj.private_key) {
    throw new Error(`SA JSON from ${source} missing client_email or private_key`);
  }
  return {
    client_email: String(obj.client_email),
    private_key: String(obj.private_key).replace(/\\n/g, "\n"),
    token_uri: obj.token_uri ? String(obj.token_uri) : TOKEN_URI,
  };
}

// ── Access token (cached until expiry) ────────────────────────────────────
let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_SKEW_SEC > now) {
    return tokenCache.accessToken;
  }
  const sa = await loadServiceAccount();
  if (!sa) throw new Error("Google Drive service account is not configured");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = now;
  const exp = now + 3600;
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: DRIVE_SCOPE,
    aud: sa.token_uri ?? TOKEN_URI,
    iat,
    exp,
  }));
  const signingInput = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign({ key: sa.private_key, format: "pem" });
  const jwt = `${signingInput}.${b64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch(sa.token_uri ?? TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`drive token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("drive token response missing access_token");

  tokenCache = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600),
  };
  return tokenCache.accessToken;
}

function b64url(input: string | Buffer): string {
  const b = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ── Drive API helpers ─────────────────────────────────────────────────────
async function driveGet<T = any>(pathAndQuery: string): Promise<T> {
  const token = await getAccessToken();
  const url = `${DRIVE_API}${pathAndQuery}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`drive API ${res.status}: ${text.slice(0, 300)}`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  parents?: string[];
  isFolder: boolean;
};

// ── Folder restriction (parent-chain walk) ────────────────────────────────
/**
 * Confirm a file is inside the allowed workspace folder (recursively).
 * Returns the chain of ancestor folder ids on success, throws on violation.
 * Cached per fileId for the lifetime of the Lambda container to keep import
 * fast, but always re-validates on cold start.
 */
const parentChainCache = new Map<string, string[]>();

export async function validateUnderAllowedFolder(fileId: string): Promise<string[]> {
  if (!ALLOWED_FOLDER_ID) throw new Error("GOOGLE_DRIVE_WORKSPACE_FOLDER_ID is not set");
  if (typeof fileId !== "string" || !/^[\w-]{10,128}$/.test(fileId)) {
    throw new Error("invalid driveFileId");
  }
  const cached = parentChainCache.get(fileId);
  if (cached) return cached;

  const chain: string[] = [];
  let currentId = fileId;
  for (let depth = 0; depth < MAX_PARENT_WALK; depth++) {
    const meta = await driveGet<{ id: string; parents?: string[] }>(
      `/files/${encodeURIComponent(currentId)}?fields=id,parents&supportsAllDrives=true`
    );
    const parents = meta.parents ?? [];
    if (parents.length === 0) {
      throw new Error(`file ${fileId} is not inside the allowed workspace folder`);
    }
    // A file/folder can have multiple parents (rare). Accept any path that ends at ALLOWED_FOLDER_ID.
    if (parents.includes(ALLOWED_FOLDER_ID)) {
      chain.push(ALLOWED_FOLDER_ID);
      parentChainCache.set(fileId, chain);
      return chain;
    }
    // Walk up the first parent (typical case).
    currentId = parents[0];
    chain.push(currentId);
  }
  throw new Error(`file ${fileId} parent chain exceeds max depth — rejected`);
}

// ── Public API ────────────────────────────────────────────────────────────
export function isDriveConfigured(): boolean {
  return Boolean(
    ALLOWED_FOLDER_ID && (
      process.env.GOOGLE_DRIVE_SA_JSON
      || process.env.GOOGLE_DRIVE_SA_JSON_BASE64
      || process.env.GOOGLE_DRIVE_SA_S3_KEY
    )
  );
}

export function getAllowedFolderId(): string {
  return ALLOWED_FOLDER_ID;
}

export async function driveStatus(): Promise<{
  configured: boolean;
  allowedFolderId?: string;
  serviceAccount?: string;
  reachable?: boolean;
  reason?: string;
}> {
  if (!isDriveConfigured()) {
    return { configured: false, reason: "missing GOOGLE_DRIVE_WORKSPACE_FOLDER_ID or SA credentials" };
  }
  try {
    const sa = await loadServiceAccount();
    const folder = await driveGet<{ id: string; name: string }>(
      `/files/${encodeURIComponent(ALLOWED_FOLDER_ID)}?fields=id,name&supportsAllDrives=true`
    );
    return {
      configured: true,
      allowedFolderId: folder.id,
      serviceAccount: sa?.client_email,
      reachable: true,
    };
  } catch (err: any) {
    return {
      configured: true,
      allowedFolderId: ALLOWED_FOLDER_ID,
      reachable: false,
      reason: err?.message ?? "unknown error",
    };
  }
}

/**
 * List files inside the allowed folder (or a subfolder under it).
 * folderId defaults to the configured allowed root; subfolder requests
 * are validated against the allowed root before listing.
 */
export async function driveListFolder(opts?: {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  query?: string;
}): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  if (!ALLOWED_FOLDER_ID) throw new Error("GOOGLE_DRIVE_WORKSPACE_FOLDER_ID is not set");

  const targetFolder = (opts?.folderId ?? ALLOWED_FOLDER_ID).trim();
  if (targetFolder !== ALLOWED_FOLDER_ID) {
    // Subfolder — confirm it's actually inside the allowed root.
    await validateUnderAllowedFolder(targetFolder);
  }

  const pageSize = Math.min(Math.max(opts?.pageSize ?? 50, 1), 200);
  const baseQ = `'${targetFolder.replace(/'/g, "\\'")}' in parents and trashed=false`;
  const userQ = opts?.query?.trim();
  const q = userQ ? `${baseQ} and (${userQ})` : baseQ;

  const params = new URLSearchParams({
    q,
    pageSize: String(pageSize),
    fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)",
    orderBy: "folder,name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (opts?.pageToken) params.set("pageToken", opts.pageToken);

  const res = await driveGet<{
    files?: Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; parents?: string[] }>;
    nextPageToken?: string;
  }>(`/files?${params.toString()}`);

  const files: DriveFile[] = (res.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined,
    modifiedTime: f.modifiedTime,
    parents: f.parents,
    isFolder: f.mimeType === "application/vnd.google-apps.folder",
  }));
  return { files, nextPageToken: res.nextPageToken };
}

export async function driveGetFileMeta(fileId: string): Promise<DriveFile> {
  await validateUnderAllowedFolder(fileId);
  const f = await driveGet<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; parents?: string[] }>(
    `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,parents&supportsAllDrives=true`
  );
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined,
    modifiedTime: f.modifiedTime,
    parents: f.parents,
    isFolder: f.mimeType === "application/vnd.google-apps.folder",
  };
}

/**
 * Download a Drive file's bytes. Validates folder membership first and
 * enforces DRIVE_MAX_IMPORT_BYTES. Returns the buffer plus content metadata.
 *
 * Google Docs/Sheets/Slides need an export MIME type — we map common ones
 * to PDF by default so binary imports always work.
 */
export async function driveDownload(fileId: string): Promise<{
  body: Buffer;
  name: string;
  mimeType: string;
  size: number;
}> {
  const meta = await driveGetFileMeta(fileId);
  if (meta.isFolder) throw new Error("cannot download a folder");
  if (meta.size && meta.size > MAX_DRIVE_FILE_BYTES) {
    throw new Error(`file too large to import (${meta.size} bytes, limit ${MAX_DRIVE_FILE_BYTES})`);
  }

  const token = await getAccessToken();
  let url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  let exportName = meta.name;
  let exportMime = meta.mimeType;

  // Google-native formats can't use ?alt=media — must export to a concrete type.
  const exportMap: Record<string, { mime: string; ext: string }> = {
    "application/vnd.google-apps.document": { mime: "application/pdf", ext: ".pdf" },
    "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
    "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: ".pdf" },
    "application/vnd.google-apps.drawing": { mime: "image/png", ext: ".png" },
    "application/vnd.google-apps.script": { mime: "application/vnd.google-apps.script+json", ext: ".json" },
  };
  const exp = exportMap[meta.mimeType];
  if (exp) {
    url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exp.mime)}&supportsAllDrives=true`;
    exportMime = exp.mime;
    if (!exportName.toLowerCase().endsWith(exp.ext)) exportName = `${exportName}${exp.ext}`;
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`drive download failed: ${res.status} ${text.slice(0, 200)}`);
  }

  // Stream into buffer with hard byte cap to protect Lambda memory.
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("drive download produced no body");
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_DRIVE_FILE_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`drive download exceeded ${MAX_DRIVE_FILE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  const body = Buffer.concat(chunks, total);
  return { body, name: exportName, mimeType: exportMime, size: body.byteLength };
}

export const DRIVE_LIMITS = {
  MAX_DRIVE_FILE_BYTES,
  MAX_PARENT_WALK,
};

logger.info({
  configured: isDriveConfigured(),
  folder: ALLOWED_FOLDER_ID ? `${ALLOWED_FOLDER_ID.slice(0, 6)}…` : "(unset)",
}, "[drive] connector module loaded");
