// Pita Ji Live workspace — separate auth, separate UI, but shares this same
// Lambda + CloudFront. All endpoints live under /api/pitaji/*.
//
// Auth model:
//   * pitaji_auth signed cookie (independent of videomaking_auth)
//   * /api/pitaji/auth, /api/pitaji/auth/logout, /api/pitaji/session are public
//   * everything else requires the cookie (or X-Internal-Agent for worker → API)
//
// Phase 1 (this file) ships:
//   * auth login / logout / session
//   * GET /settings (returns defaults for now)
//   * GET /jobs (history list — empty until Phase 2)
//   * GET /jobs/:id (404 stub)
//
// Phase 2+ will append more endpoints to the same router.

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  PITAJI_COOKIE_NAME,
  clearPitajiAuthCookie,
  extractPitajiCredentials,
  getPitajiSession,
  getPitajiUsername,
  isPitajiAuthenticated,
  isPitajiConfigured,
  isPitajiFeatureEnabled,
  requirePitajiAuth,
  setPitajiAuthCookie,
  verifyPitajiCredentials,
} from "../lib/pitaji-auth";
import {
  getAnalyzeJob,
  getSettings,
  isPitajiStoreEnabled,
  listAnalyzeJobs,
  listClipDispatchesByParent,
  type PitajiAnalyzeJob,
  type PitajiClipDispatch,
} from "../lib/pitaji-store";

const router: IRouter = Router();

// ── Feature gate ─────────────────────────────────────────────────────────────
// If the workspace is disabled we 404 the entire prefix so it never appears.
router.use("/pitaji", (_req: Request, res: Response, next: NextFunction) => {
  if (!isPitajiFeatureEnabled()) {
    res.status(404).json({ error: "Pita Ji workspace is not enabled" });
    return;
  }
  next();
});

// ── Public auth endpoints (no cookie required) ───────────────────────────────

router.get("/pitaji/session", (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const session = getPitajiSession(req);
  res.json({
    authenticated: session.authenticated,
    user: session.authenticated ? { username: session.username ?? getPitajiUsername() } : null,
    features: {
      configured: isPitajiConfigured(),
    },
  });
});

router.post("/pitaji/auth", (req: Request, res: Response) => {
  if (!isPitajiConfigured()) {
    res.status(503).json({ error: "Pita Ji password is not configured" });
    return;
  }
  const { username, password } = extractPitajiCredentials(req);
  const ok = typeof username === "string" && typeof password === "string" &&
    verifyPitajiCredentials(username, password);
  if (!ok) {
    req.log?.warn(
      { hasUsername: typeof username === "string", hasPassword: typeof password === "string" },
      "Pita Ji login failed",
    );
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  setPitajiAuthCookie(res, getPitajiUsername());
  res.json({ ok: true, user: { username: getPitajiUsername() } });
});

router.post("/pitaji/auth/logout", (_req: Request, res: Response) => {
  clearPitajiAuthCookie(res);
  res.json({ ok: true });
});

// ── Authenticated zone ───────────────────────────────────────────────────────
router.use("/pitaji", requirePitajiAuth);

// Settings — Phase 1 returns persisted record OR defaults if nothing saved yet.
router.get("/pitaji/settings", async (_req: Request, res: Response) => {
  if (!isPitajiStoreEnabled()) {
    res.status(503).json({ error: "Pita Ji store is not configured" });
    return;
  }
  try {
    const settings = await getSettings();
    res.json({
      thumbnailPrompt: settings.thumbnailPrompt ?? "",
      clipInstructions: settings.clipInstructions ?? "",
      speakers: settings.speakers ?? [],
      references: settings.references ?? [],
      updatedAt: settings.updatedAt ?? 0,
    });
  } catch (err) {
    req_logger_warn(_req, err, "Failed to load Pita Ji settings");
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// History list (Phase 1 — works as soon as analyze jobs exist; empty otherwise)
router.get("/pitaji/jobs", async (req: Request, res: Response) => {
  if (!isPitajiStoreEnabled()) {
    res.json({ jobs: [] });
    return;
  }
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const jobs = await listAnalyzeJobs(limit);
    res.json({
      jobs: jobs.map((j) => ({
        jobId: j.jobId,
        status: j.status,
        youtubeUrl: j.youtubeUrl,
        videoId: j.videoId,
        videoTitle: j.videoTitle,
        durationSec: j.durationSec,
        channel: j.channel,
        pipelineMode: j.pipelineMode,
        chunks: j.chunks,
        clipCount: Array.isArray(j.clips) ? j.clips.length : 0,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      })),
    });
  } catch (err) {
    req_logger_warn(req, err, "Failed to list Pita Ji jobs");
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

router.get("/pitaji/jobs/:jobId", async (req: Request, res: Response) => {
  if (!isPitajiStoreEnabled()) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  try {
    const jobId = String(req.params.jobId ?? "").trim();
    if (!/^pj_[A-Za-z0-9]+$/.test(jobId)) {
      res.status(400).json({ error: "Invalid jobId" });
      return;
    }
    const job = await getAnalyzeJob(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    let dispatches: PitajiClipDispatch[] = [];
    try {
      dispatches = await listClipDispatchesByParent(jobId);
    } catch {
      dispatches = [];
    }
    res.json({
      job: stripJobForClient(job),
      dispatches: dispatches.map(stripDispatchForClient),
    });
  } catch (err) {
    req_logger_warn(req, err, "Failed to load Pita Ji job");
    res.status(500).json({ error: "Failed to load job" });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripJobForClient(job: PitajiAnalyzeJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    youtubeUrl: job.youtubeUrl,
    videoId: job.videoId,
    videoTitle: job.videoTitle,
    durationSec: job.durationSec,
    channel: job.channel,
    pipelineMode: job.pipelineMode,
    chunks: job.chunks,
    clips: Array.isArray(job.clips) ? job.clips : [],
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function stripDispatchForClient(d: PitajiClipDispatch) {
  return {
    jobId: d.jobId,
    parentJobId: d.parentJobId,
    action: d.action,
    status: d.status,
    clip: d.clip,
    cutChildJobId: d.cutChildJobId,
    cutS3Key: d.cutS3Key,
    cutFilename: d.cutFilename,
    thumbnailChildJobId: d.thumbnailChildJobId,
    thumbnailS3Key: d.thumbnailS3Key,
    error: d.error,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function req_logger_warn(req: Request | undefined, err: unknown, msg: string): void {
  const log = (req as Request & { log?: { warn: (...args: unknown[]) => void } } | undefined)?.log;
  if (log && typeof log.warn === "function") {
    log.warn({ err }, msg);
    return;
  }
  console.warn(`[pitaji] ${msg}:`, err);
}

// Surface the cookie name + auth probe for any other module that needs them.
export {
  isPitajiAuthenticated,
  isPitajiFeatureEnabled,
  PITAJI_COOKIE_NAME,
};

export default router;
