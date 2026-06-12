/**
 * Agent Workspace — storage adapter layer.
 *
 * Every authenticated user gets a workspace with a hard S3 key prefix:
 *   workspace/<workspaceId>/<path>
 *
 * Adapters:
 *   - S3WorkspaceAdapter  (persistent app storage)        — implemented
 *   - DriveWorkspaceAdapter (one allowed folder tree)     — Phase 2 stub
 *
 * The agent and frontend must go through getWorkspace(req) so per-user
 * isolation is enforced server-side. Callers can never supply raw S3 keys.
 */
import crypto from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "./logger";

// ── Config ────────────────────────────────────────────────────────────────
const BUCKET = process.env.S3_BUCKET ?? process.env.S3_BUCKET_NAME ?? "malikaeditorr";
const REGION = process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const ROOT_PREFIX = (process.env.WORKSPACE_ROOT_PREFIX ?? "workspace").replace(/^\/+|\/+$/g, "");
const MAX_FILE_BYTES = Number.parseInt(process.env.WORKSPACE_MAX_FILE_BYTES ?? "", 10) || 1024 * 1024 * 1024; // 1 GB
const MAX_DIRECT_WRITE_BYTES = 5 * 1024 * 1024; // 5 MB cap for JSON text writes
const PRESIGN_PUT_TTL = 3600;
const PRESIGN_GET_TTL = 86_400;
const LIST_MAX = 200;

const FORBIDDEN_EXTS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".dll", ".sh", ".ps1", ".vbs",
]);

// MIME types we refuse to store. Executable bytes the browser shouldn't render
// as code, regardless of extension trickery.
const FORBIDDEN_MIME_PREFIXES = [
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
  "application/x-dosexec",
];
export function assertSafeContentType(ct: string | undefined): void {
  if (!ct) return;
  const lower = ct.toLowerCase().split(";")[0].trim();
  for (const bad of FORBIDDEN_MIME_PREFIXES) {
    if (lower === bad || lower.startsWith(bad + ";")) {
      throw new Error(`MIME type not allowed: ${lower}`);
    }
  }
}

let s3: S3Client | null = null;
function s3Client(): S3Client {
  if (!s3) s3 = new S3Client({ region: REGION });
  return s3;
}

// ── Identity ──────────────────────────────────────────────────────────────
export type WorkspaceIdentity = {
  workspaceId: string;
  displayName: string;
  authMethod: "password" | "google" | "unknown";
};

type AuthSessionLike = {
  authenticated?: boolean;
  method?: string;
  email?: string;
  name?: string;
};

/**
 * Stable per-user workspace id. Derived from auth session — does NOT trust
 * any caller-supplied id. The same user always resolves to the same id;
 * different users (or different login methods) get different prefixes.
 */
export function deriveWorkspaceIdentity(req: any): WorkspaceIdentity {
  const session: AuthSessionLike | undefined = req?.res?.locals?.authSession;
  const method = (session?.method ?? "password") as WorkspaceIdentity["authMethod"];
  const subject = (session?.email && session.email.trim())
    || process.env.WEBSITE_AUTH_USER
    || "kalki_avatar";
  const hash = crypto.createHash("sha256").update(`${method}|${subject.toLowerCase()}`).digest("hex").slice(0, 24);
  return {
    workspaceId: hash,
    displayName: session?.name || session?.email || subject,
    authMethod: method === "google" ? "google" : (method === "password" ? "password" : "unknown"),
  };
}

// ── Path validation ───────────────────────────────────────────────────────
const PATH_SEGMENT_RE = /^[\w.\-() ]{1,160}$/;

/**
 * Normalize and validate a user-supplied workspace-relative path.
 * Rejects: leading slash, `..`, empty segments, forbidden extensions,
 * and anything that would escape the workspace prefix.
 */
export function normalizeWorkspacePath(input: unknown): string {
  if (typeof input !== "string") throw new Error("path must be a string");
  let p = input.trim();
  if (!p) throw new Error("path is empty");
  p = p.replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.length > 800) throw new Error("path too long");
  const segments = p.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("path resolves to empty");
  for (const seg of segments) {
    if (seg === "." || seg === "..") throw new Error("path traversal not allowed");
    if (!PATH_SEGMENT_RE.test(seg)) throw new Error(`invalid path segment: ${seg}`);
  }
  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf(".");
  if (dot >= 0) {
    const ext = last.slice(dot).toLowerCase();
    if (FORBIDDEN_EXTS.has(ext)) throw new Error(`extension not allowed: ${ext}`);
  }
  return segments.join("/");
}

/** Normalize a directory-style prefix (may be empty for workspace root). */
export function normalizeWorkspaceDir(input: unknown): string {
  if (input === undefined || input === null || input === "") return "";
  if (typeof input !== "string") throw new Error("dir must be a string");
  let p = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p) return "";
  const segments = p.split("/").filter(Boolean);
  for (const seg of segments) {
    if (seg === "." || seg === "..") throw new Error("path traversal not allowed");
    if (!PATH_SEGMENT_RE.test(seg)) throw new Error(`invalid path segment: ${seg}`);
  }
  return segments.join("/");
}

// ── Adapter interface ─────────────────────────────────────────────────────
export type WorkspaceFile = {
  path: string;
  size: number;
  modifiedAt: number;
  contentType?: string;
};

export type WorkspaceListing = {
  files: WorkspaceFile[];
  nextCursor?: string;
};

export interface WorkspaceAdapter {
  readonly kind: "s3" | "drive";
  list(dir: string, opts?: { limit?: number; cursor?: string }): Promise<WorkspaceListing>;
  stat(path: string): Promise<WorkspaceFile | null>;
  readText(path: string, maxBytes?: number): Promise<{ content: string; contentType: string; size: number }>;
  writeText(path: string, content: string, opts?: { contentType?: string }): Promise<WorkspaceFile>;
  delete(path: string): Promise<void>;
  copy(srcPath: string, dstPath: string): Promise<WorkspaceFile>;
  presignPut(path: string, opts: { size: number; contentType?: string }): Promise<{ uploadUrl: string; expiresIn: number }>;
  presignGet(path: string, opts?: { disposition?: "inline" | "attachment"; filename?: string }): Promise<{ url: string; expiresIn: number }>;
}

// ── S3 adapter ────────────────────────────────────────────────────────────
class S3WorkspaceAdapter implements WorkspaceAdapter {
  readonly kind = "s3" as const;
  private readonly prefix: string;

  constructor(workspaceId: string) {
    if (!/^[a-f0-9]{8,64}$/.test(workspaceId)) throw new Error("invalid workspaceId");
    this.prefix = `${ROOT_PREFIX}/${workspaceId}/`;
  }

  private key(path: string): string {
    return this.prefix + normalizeWorkspacePath(path);
  }

  private rel(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  async list(dir: string, opts?: { limit?: number; cursor?: string }): Promise<WorkspaceListing> {
    const sub = normalizeWorkspaceDir(dir);
    const Prefix = sub ? `${this.prefix}${sub}/` : this.prefix;
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), LIST_MAX);
    const res = await s3Client().send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix,
      MaxKeys: limit,
      ContinuationToken: opts?.cursor,
    }));
    const files: WorkspaceFile[] = (res.Contents ?? []).map((obj) => ({
      path: this.rel(obj.Key ?? ""),
      size: obj.Size ?? 0,
      modifiedAt: obj.LastModified ? obj.LastModified.getTime() : Date.now(),
    }));
    return { files, nextCursor: res.NextContinuationToken };
  }

  async stat(path: string): Promise<WorkspaceFile | null> {
    try {
      const Key = this.key(path);
      const res = await s3Client().send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
      return {
        path: normalizeWorkspacePath(path),
        size: res.ContentLength ?? 0,
        modifiedAt: res.LastModified ? res.LastModified.getTime() : Date.now(),
        contentType: res.ContentType,
      };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return null;
      throw err;
    }
  }

  async readText(path: string, maxBytes = 2 * 1024 * 1024): Promise<{ content: string; contentType: string; size: number }> {
    const Key = this.key(path);
    const res = await s3Client().send(new GetObjectCommand({ Bucket: BUCKET, Key }));
    const size = res.ContentLength ?? 0;
    if (size > maxBytes) {
      throw new Error(`file too large to read inline (${size} bytes, limit ${maxBytes})`);
    }
    const body = await res.Body?.transformToString("utf8");
    return {
      content: body ?? "",
      contentType: res.ContentType ?? "application/octet-stream",
      size,
    };
  }

  async writeText(path: string, content: string, opts?: { contentType?: string }): Promise<WorkspaceFile> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_DIRECT_WRITE_BYTES) {
      throw new Error(`content exceeds ${MAX_DIRECT_WRITE_BYTES} bytes; use presignPut for larger payloads`);
    }
    assertSafeContentType(opts?.contentType);
    const Key = this.key(path);
    await s3Client().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key,
      Body: content,
      ContentType: opts?.contentType ?? inferContentType(path),
    }));
    return {
      path: normalizeWorkspacePath(path),
      size: bytes,
      modifiedAt: Date.now(),
      contentType: opts?.contentType ?? inferContentType(path),
    };
  }

  async delete(path: string): Promise<void> {
    const Key = this.key(path);
    await s3Client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
  }

  async copy(srcPath: string, dstPath: string): Promise<WorkspaceFile> {
    const src = this.key(srcPath);
    const dst = this.key(dstPath);
    await s3Client().send(new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `/${BUCKET}/${src}`,
      Key: dst,
    }));
    const stat = await this.stat(dstPath);
    if (!stat) throw new Error("copy failed: destination not found");
    return stat;
  }

  async presignPut(path: string, opts: { size: number; contentType?: string }): Promise<{ uploadUrl: string; expiresIn: number }> {
    if (!Number.isFinite(opts.size) || opts.size <= 0) throw new Error("size required");
    if (opts.size > MAX_FILE_BYTES) throw new Error(`size exceeds workspace limit (${MAX_FILE_BYTES} bytes)`);
    assertSafeContentType(opts.contentType);
    const Key = this.key(path);
    const uploadUrl = await getSignedUrl(s3Client(), new PutObjectCommand({
      Bucket: BUCKET,
      Key,
      ContentType: opts.contentType ?? inferContentType(path),
      ContentLength: opts.size,
    }), { expiresIn: PRESIGN_PUT_TTL });
    return { uploadUrl, expiresIn: PRESIGN_PUT_TTL };
  }

  async presignGet(path: string, opts?: { disposition?: "inline" | "attachment"; filename?: string }): Promise<{ url: string; expiresIn: number }> {
    const Key = this.key(path);
    const filename = opts?.filename ?? path.split("/").pop() ?? "file";
    const disp = opts?.disposition === "inline"
      ? "inline"
      : `attachment; filename="${filename.replace(/"/g, "")}"`;
    const url = await getSignedUrl(s3Client(), new GetObjectCommand({
      Bucket: BUCKET,
      Key,
      ResponseContentDisposition: disp,
    }), { expiresIn: PRESIGN_GET_TTL });
    return { url, expiresIn: PRESIGN_GET_TTL };
  }
}

// ── Workspace facade ──────────────────────────────────────────────────────
export type Workspace = {
  identity: WorkspaceIdentity;
  s3: WorkspaceAdapter;
  // drive?: WorkspaceAdapter; // Phase 2
};

export function getWorkspace(req: any): Workspace {
  const identity = deriveWorkspaceIdentity(req);
  return {
    identity,
    s3: new S3WorkspaceAdapter(identity.workspaceId),
  };
}

export function getWorkspaceById(workspaceId: string): Workspace {
  return {
    identity: { workspaceId, displayName: workspaceId, authMethod: "unknown" },
    s3: new S3WorkspaceAdapter(workspaceId),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function inferContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot).toLowerCase();
  switch (ext) {
    case ".txt": return "text/plain; charset=utf-8";
    case ".md": return "text/markdown; charset=utf-8";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".srt": case ".vtt": return "text/plain; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".mp4": return "video/mp4";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

export const WORKSPACE_LIMITS = {
  MAX_FILE_BYTES,
  MAX_DIRECT_WRITE_BYTES,
  PRESIGN_PUT_TTL,
  PRESIGN_GET_TTL,
  LIST_MAX,
};

logger.info({ ROOT_PREFIX, BUCKET, MAX_FILE_BYTES }, "[workspace] adapter ready");
