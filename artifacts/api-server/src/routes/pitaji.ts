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
  newAnalyzeJobId,
  putAnalyzeJob,
  updateAnalyzeJob,
  type PitajiAnalyzeJob,
  type PitajiClip,
  type PitajiClipDispatch,
} from "../lib/pitaji-store";
import { isYoutubeUrl, normalizeYoutubeUrl, extractYoutubeVideoId } from "../lib/pitaji-url";
import { setupSse, sseFlush } from "../lib/sse";
import { analyzeYoutubeDirect } from "../lib/pitaji-analysis";
import { isGeminiConfigured } from "../lib/gemini-client";

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

// ── /analyze ──────────────────────────────────────────────────────────────
// SSE-streaming analysis endpoint. For Phase 2 we only handle the
// YouTube-direct path (≤ THRESHOLD_2_MIN). Long videos return a clear error
// pointing the user at Phase 3 (audio split + Vertex AI).

const PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN = Math.max(
  1,
  Number.parseInt(process.env.PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN ?? "40", 10) || 40,
);

function sseSend(res: Response, payload: object): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
}

interface VideoMeta {
  videoId: string;
  videoTitle?: string;
  durationSec?: number;
  channel?: string;
}

/**
 * Probe video metadata via the existing `/api/youtube/info` endpoint using the
 * internal-agent header. lambda-stream.ts sets INTERNAL_API_BASE on cold
 * start, so this is essentially an in-process call.
 */
async function fetchVideoMeta(youtubeUrl: string): Promise<VideoMeta> {
  const apiBase =
    (process.env.INTERNAL_API_BASE ?? "").replace(/\/+$/, "") + "/api";
  const internalSecret =
    process.env.INTERNAL_AGENT_SECRET ?? "internal-agent-bypass-key";
  const videoId = extractYoutubeVideoId(youtubeUrl) ?? "";

  if (!apiBase.startsWith("http")) {
    return { videoId };
  }

  try {
    const r = await fetch(`${apiBase}/youtube/info`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Agent": internalSecret,
      },
      body: JSON.stringify({ url: youtubeUrl }),
      // `signal` left unset — the call is cheap, and the SSE handler will
      // dispose the response if the client disconnects mid-flight.
    });
    if (!r.ok) {
      return { videoId };
    }
    const data = (await r.json()) as {
      id?: string;
      title?: string;
      duration?: number | null;
      uploader?: string | null;
    };
    return {
      videoId: data.id ?? videoId,
      videoTitle: typeof data.title === "string" ? data.title : undefined,
      durationSec:
        typeof data.duration === "number" && Number.isFinite(data.duration)
          ? Math.round(data.duration)
          : undefined,
      channel: typeof data.uploader === "string" ? data.uploader : undefined,
    };
  } catch {
    return { videoId };
  }
}

router.post("/pitaji/analyze", async (req: Request, res: Response) => {
  // Validate Gemini availability before opening SSE so the client gets a
  // proper JSON 503 instead of a half-open stream.
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "AI is not configured (Gemini API key or Vertex required)." });
    return;
  }
  if (!isPitajiStoreEnabled()) {
    res.status(503).json({ error: "Pita Ji store (DDB) is not configured." });
    return;
  }

  const rawUrl = String((req.body as { youtubeUrl?: unknown })?.youtubeUrl ?? "").trim();
  if (!rawUrl) {
    res.status(400).json({ error: "youtubeUrl is required" });
    return;
  }
  if (!isYoutubeUrl(rawUrl)) {
    res.status(400).json({
      error:
        "URL is not a YouTube link. Paste any YouTube watch / live / shorts / youtu.be URL.",
    });
    return;
  }

  const normalized = normalizeYoutubeUrl(rawUrl);
  const videoId = extractYoutubeVideoId(normalized);
  if (!videoId) {
    res.status(400).json({ error: "Could not extract a YouTube video id from the URL." });
    return;
  }

  // Build the analyze job record and persist it immediately so the client
  // can re-attach via /jobs/:jobId if its connection drops mid-stream.
  const now = Date.now();
  const jobId = newAnalyzeJobId();
  const job: PitajiAnalyzeJob = {
    jobId,
    kind: "pitaji-analyze",
    status: "running",
    youtubeUrl: normalized,
    videoId,
    clips: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    await putAnalyzeJob(job);
  } catch (err) {
    req_logger_warn(req, err, "Failed to persist analyze job");
    res.status(500).json({ error: "Failed to start analysis (DDB write failed)" });
    return;
  }

  // ── From here on, we stream SSE ────────────────────────────────────────
  setupSse(res);
  sseSend(res, { type: "run_start", jobId, ts: Date.now() });

  let aborted = false;
  const onClose = () => {
    aborted = true;
  };
  res.on("close", onClose);

  // Best-effort metadata probe (non-fatal).
  let meta: VideoMeta = { videoId };
  try {
    meta = await fetchVideoMeta(normalized);
  } catch {
    /* meta stays as-is */
  }
  sseSend(res, {
    type: "meta",
    videoId: meta.videoId,
    videoTitle: meta.videoTitle ?? null,
    durationSec: meta.durationSec ?? null,
    channel: meta.channel ?? null,
  });

  // Decide pipeline. Phase 2 only handles youtube_direct.
  const durationMin =
    typeof meta.durationSec === "number" ? meta.durationSec / 60 : 0;
  const overThreshold = durationMin > PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN;
  const pipelineMode = "youtube_direct" as const;
  sseSend(res, {
    type: "pipeline_choice",
    mode: pipelineMode,
    overThreshold,
    thresholdMin: PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN,
  });
  if (overThreshold) {
    sseSend(res, {
      type: "warning",
      message:
        `This video is longer than ${PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN} minutes. ` +
        "We will still try direct analysis; the dedicated audio-split path is wired up in Phase 3.",
    });
  }

  // Persist meta + pipeline mode so /jobs/:id reflects them immediately.
  try {
    await updateAnalyzeJob(jobId, {
      status: "running",
      videoTitle: meta.videoTitle,
      durationSec: meta.durationSec,
      channel: meta.channel,
      pipelineMode,
    });
  } catch (err) {
    req_logger_warn(req, err, "Failed to update analyze job after meta probe");
  }

  sseSend(res, { type: "stage", stage: "analyzing" });

  // Load operator clip-instructions from settings (best-effort).
  let clipInstructions = "";
  try {
    const settings = await getSettings();
    clipInstructions = settings.clipInstructions ?? "";
  } catch {
    /* keep empty */
  }

  const collected: PitajiClip[] = [];
  let lastFlushAt = 0;

  try {
    const result = await analyzeYoutubeDirect({
      youtubeUrl: normalized,
      totalDurationSec: meta.durationSec,
      clipInstructions,
      signal: abortSignalFromClose(res),
      onClip: (clip) => {
        if (aborted) return;
        collected.push(clip);
        sseSend(res, { type: "clip", clip });
        // Persist progress periodically — keeps history live during long runs.
        const now2 = Date.now();
        if (now2 - lastFlushAt > 5_000) {
          lastFlushAt = now2;
          // Fire-and-forget; failures don't break the stream.
          updateAnalyzeJob(jobId, { clips: [...collected] }).catch((err) => {
            req_logger_warn(req, err, "Periodic clips flush failed");
          });
        }
      },
    });

    if (aborted) {
      try {
        await updateAnalyzeJob(jobId, { status: "cancelled", clips: collected });
      } catch (err) {
        req_logger_warn(req, err, "Failed to mark job cancelled");
      }
      return;
    }

    try {
      await updateAnalyzeJob(jobId, {
        status: "reviewing",
        clips: collected,
      });
    } catch (err) {
      req_logger_warn(req, err, "Final clips flush failed");
    }

    sseSend(res, {
      type: "summary",
      totalClips: result.totalClips,
      jobId,
    });
    sseSend(res, { type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    req_logger_warn(req, err, "Pita Ji analysis failed");
    try {
      await updateAnalyzeJob(jobId, { status: "error", error: message, clips: collected });
    } catch (e2) {
      req_logger_warn(req, e2, "Failed to mark job errored");
    }
    sseSend(res, { type: "error", message });
    sseSend(res, { type: "done" });
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

function abortSignalFromClose(res: Response): AbortSignal {
  const ctrl = new AbortController();
  res.once("close", () => ctrl.abort());
  return ctrl.signal;
}

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
