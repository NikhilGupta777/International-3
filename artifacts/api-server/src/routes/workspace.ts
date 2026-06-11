/**
 * Agent Workspace — REST API.
 *
 * All routes resolve the workspace from the authenticated session.
 * Callers never supply raw S3 keys; only workspace-relative paths.
 *
 *   GET    /api/workspace/info
 *   GET    /api/workspace/files          ?dir=&limit=&cursor=
 *   GET    /api/workspace/file?path=...&download=1
 *   POST   /api/workspace/file           { path, content, contentType? }
 *   DELETE /api/workspace/file?path=...
 *   POST   /api/workspace/presign-put    { path, size, contentType? }
 *   POST   /api/workspace/copy           { srcPath, dstPath }
 *   POST   /api/workspace/import-drive   (Phase 2 — returns 501)
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import pino from "pino";
import { getWorkspace, WORKSPACE_LIMITS, deriveWorkspaceIdentity } from "../lib/workspace";
import {
  isDriveConfigured,
  driveStatus,
  driveListFolder,
  driveGetFileMeta,
  driveDownload,
  getAllowedFolderId,
} from "../lib/google-drive";

const logger = pino({ name: "workspace" });
const router = Router();

// ── Per-user write rate limit ────────────────────────────────────────────
// Hourly token bucket keyed by workspaceId. Applies only to mutating routes
// (write / delete / copy / presign-put / import-drive). Reads are unbounded.
const WRITE_LIMIT_PER_HOUR = Number.parseInt(process.env.WORKSPACE_WRITE_LIMIT_PER_HOUR ?? "", 10) || 200;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function workspaceWriteLimit(req: Request, res: Response, next: NextFunction): void {
  try {
    const { workspaceId } = deriveWorkspaceIdentity(req);
    const now = Date.now();
    const rec = rateLimitMap.get(workspaceId) ?? { count: 0, resetAt: now + 3600_000 };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 3600_000; }
    if (rec.count >= WRITE_LIMIT_PER_HOUR) {
      res.setHeader("Retry-After", Math.ceil((rec.resetAt - now) / 1000));
      res.status(429).json({ error: `workspace write limit exceeded (${WRITE_LIMIT_PER_HOUR}/hour)` });
      return;
    }
    rec.count++;
    rateLimitMap.set(workspaceId, rec);
    next();
  } catch (err) {
    res.status(500).json({ error: "rate limit check failed" });
  }
}

function bad(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function fail(res: Response, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid|too large|not allowed|traversal|exceeds|empty/i.test(msg)) {
    return res.status(400).json({ error: msg });
  }
  logger.error({ err }, "[workspace] unexpected failure");
  return res.status(500).json({ error: "workspace operation failed" });
}

// ── GET /info ────────────────────────────────────────────────────────────
router.get("/info", (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    return res.json({
      displayName: ws.identity.displayName,
      authMethod: ws.identity.authMethod,
      adapters: {
        s3: { enabled: true, limits: WORKSPACE_LIMITS },
        drive: {
          enabled: isDriveConfigured(),
          allowedFolderId: isDriveConfigured() ? getAllowedFolderId() : undefined,
        },
      },
    });
  } catch (err) { return fail(res, err); }
});

// ── GET /files ───────────────────────────────────────────────────────────
router.get("/files", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const dir = typeof req.query.dir === "string" ? req.query.dir : "";
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, WORKSPACE_LIMITS.LIST_MAX);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const listing = await ws.s3.list(dir, { limit, cursor });
    return res.json(listing);
  } catch (err) { return fail(res, err); }
});

// ── GET /file ────────────────────────────────────────────────────────────
router.get("/file", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const path = String(req.query.path ?? "");
    if (!path) return bad(res, 400, "path required");
    const wantsDownload = req.query.download === "1";
    const wantsInline = req.query.inline === "1";
    const wantsText = req.query.text === "1";

    if (wantsText) {
      const data = await ws.s3.readText(path);
      return res.json(data);
    }

    const stat = await ws.s3.stat(path);
    if (!stat) return bad(res, 404, "file not found");

    const { url, expiresIn } = await ws.s3.presignGet(path, {
      disposition: wantsInline ? "inline" : "attachment",
    });

    if (wantsDownload) return res.redirect(url);
    return res.json({ stat, url, expiresIn });
  } catch (err) { return fail(res, err); }
});

// ── POST /file ───────────────────────────────────────────────────────────
router.post("/file", workspaceWriteLimit, async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { path, content, contentType } = req.body ?? {};
    if (typeof path !== "string" || !path) return bad(res, 400, "path required");
    if (typeof content !== "string") return bad(res, 400, "content (string) required");
    const file = await ws.s3.writeText(path, content, { contentType });
    return res.json({ file });
  } catch (err) { return fail(res, err); }
});

// ── DELETE /file ─────────────────────────────────────────────────────────
router.delete("/file", workspaceWriteLimit, async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const path = String(req.query.path ?? req.body?.path ?? "");
    if (!path) return bad(res, 400, "path required");
    await ws.s3.delete(path);
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
});

// ── POST /presign-put ────────────────────────────────────────────────────
router.post("/presign-put", workspaceWriteLimit, async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { path, size, contentType } = req.body ?? {};
    if (typeof path !== "string" || !path) return bad(res, 400, "path required");
    if (typeof size !== "number") return bad(res, 400, "size (number) required");
    const out = await ws.s3.presignPut(path, { size, contentType });
    return res.json(out);
  } catch (err) { return fail(res, err); }
});

// ── POST /copy ───────────────────────────────────────────────────────────
router.post("/copy", workspaceWriteLimit, async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { srcPath, dstPath } = req.body ?? {};
    if (typeof srcPath !== "string" || !srcPath) return bad(res, 400, "srcPath required");
    if (typeof dstPath !== "string" || !dstPath) return bad(res, 400, "dstPath required");
    const file = await ws.s3.copy(srcPath, dstPath);
    return res.json({ file });
  } catch (err) { return fail(res, err); }
});

// ── GET /drive/status ────────────────────────────────────────────────────
router.get("/drive/status", async (_req: Request, res: Response) => {
  try {
    const status = await driveStatus();
    return res.json(status);
  } catch (err) { return fail(res, err); }
});

// ── GET /drive/files ─────────────────────────────────────────────────────
router.get("/drive/files", async (req: Request, res: Response) => {
  try {
    if (!isDriveConfigured()) {
      return bad(res, 503, "Google Drive connector is not configured");
    }
    const folderId = typeof req.query.folderId === "string" && req.query.folderId.trim()
      ? String(req.query.folderId)
      : undefined;
    const pageSize = parseInt(String(req.query.pageSize ?? "50"), 10) || 50;
    const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const listing = await driveListFolder({ folderId, pageSize, pageToken, query });
    return res.json(listing);
  } catch (err) { return fail(res, err); }
});

// ── POST /import-drive ───────────────────────────────────────────────────
router.post("/import-drive", workspaceWriteLimit, async (req: Request, res: Response) => {
  try {
    if (!isDriveConfigured()) {
      return res.status(503).json({
        error: "Google Drive connector is not configured. Set GOOGLE_DRIVE_WORKSPACE_FOLDER_ID and SA credentials.",
      });
    }
    const ws = getWorkspace(req);
    const { driveFileId, path } = req.body ?? {};
    if (typeof driveFileId !== "string" || !driveFileId) return bad(res, 400, "driveFileId required");
    if (typeof path !== "string" || !path) return bad(res, 400, "path required");

    // Folder restriction is enforced inside driveDownload via validateUnderAllowedFolder.
    const meta = await driveGetFileMeta(driveFileId);
    if (meta.isFolder) return bad(res, 400, "cannot import a folder; pick a file");

    const { body, mimeType, size } = await driveDownload(driveFileId);

    // Upload to workspace via presigned PUT (don't buffer through Lambda twice).
    const presign = await ws.s3.presignPut(path, { size, contentType: mimeType });
    const putRes = await fetch(presign.uploadUrl, {
      method: "PUT",
      body,
      headers: { "Content-Type": mimeType },
    });
    if (!putRes.ok) {
      return res.status(502).json({ error: `workspace upload failed: ${putRes.status}` });
    }
    const stat = await ws.s3.stat(path);
    const { url } = await ws.s3.presignGet(path, { disposition: "attachment" });
    return res.json({
      file: stat,
      driveFileId,
      driveName: meta.name,
      driveMimeType: meta.mimeType,
      downloadUrl: url,
    });
  } catch (err) {
    if (err instanceof Error && /not inside the allowed/i.test(err.message)) {
      return res.status(403).json({ error: err.message });
    }
    return fail(res, err);
  }
});

export default router;
