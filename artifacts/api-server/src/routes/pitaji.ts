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
  newClipJobId,
  putAnalyzeJob,
  putClipDispatch,
  updateAnalyzeJob,
  type PitajiAnalyzeJob,
  type PitajiClip,
  type PitajiClipDispatch,
} from "../lib/pitaji-store";
import { isYoutubeUrl, normalizeYoutubeUrl, extractYoutubeVideoId } from "../lib/pitaji-url";
import { setupSse, sseFlush } from "../lib/sse";
import {
  analyzeAudioChunkInline,
  analyzeYoutubeDirect,
  isLikelyDuplicateClip,
} from "../lib/pitaji-analysis";
import {
  PITAJI_AUDIO_OVERLAP_SEC,
  PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN,
  cleanupJobTmpDir,
  downloadAudioToTmp,
  ensureJobTmpDir,
  pickChunkCount,
  probeAudioDurationSec,
  splitAudioIntoChunks,
  tryUnlink,
} from "../lib/pitaji-audio-pipeline";
import { isGeminiConfigured } from "../lib/gemini-client";
import { join } from "path";

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
// SSE-streaming analysis endpoint. Two paths, picked from the probed video
// duration:
//   * youtube_direct (≤ PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN minutes) — pass
//     the URL straight to Gemini 2.5 Flash via fileData (Phase 2).
//   * audio_split   (> threshold) — yt-dlp -x → ffmpeg N-way split
//     → Vertex Gemini 2.5 Flash on each chunk via inlineData (Phase 3).

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

  // Decide pipeline based on probed duration.
  const durationSec = typeof meta.durationSec === "number" ? meta.durationSec : 0;
  const chunkCount = durationSec > 0 ? pickChunkCount(durationSec) : 1;
  const pipelineMode: "youtube_direct" | "audio_split" =
    chunkCount <= 1 ? "youtube_direct" : "audio_split";
  sseSend(res, {
    type: "pipeline_choice",
    mode: pipelineMode,
    chunks: chunkCount > 1 ? chunkCount : undefined,
    thresholdMin: PITAJI_AUDIO_CHUNK_2_THRESHOLD_MIN,
  });

  // Persist meta + pipeline mode so /jobs/:id reflects them immediately.
  try {
    await updateAnalyzeJob(jobId, {
      status: "running",
      videoTitle: meta.videoTitle,
      durationSec: meta.durationSec,
      channel: meta.channel,
      pipelineMode,
      chunks: chunkCount > 1 ? chunkCount : undefined,
    });
  } catch (err) {
    req_logger_warn(req, err, "Failed to update analyze job after meta probe");
  }

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
  const persistClip = (c: PitajiClip) => {
    collected.push(c);
    sseSend(res, { type: "clip", clip: c });
    const now2 = Date.now();
    if (now2 - lastFlushAt > 5_000) {
      lastFlushAt = now2;
      updateAnalyzeJob(jobId, { clips: [...collected] }).catch((err) => {
        req_logger_warn(req, err, "Periodic clips flush failed");
      });
    }
  };

  try {
    if (pipelineMode === "youtube_direct") {
      sseSend(res, { type: "stage", stage: "analyzing" });
      await analyzeYoutubeDirect({
        youtubeUrl: normalized,
        totalDurationSec: meta.durationSec,
        clipInstructions,
        signal: abortSignalFromClose(res),
        onClip: persistClip,
      });
    } else {
      // Audio-split path. All steps run inside this Lambda (yt-dlp +
      // ffmpeg + Vertex). /tmp is cleaned up in finally.
      const tmpDir = ensureJobTmpDir(jobId);
      const fullAudio = join(tmpDir, "full.m4a");
      const ctrlSignal = abortSignalFromClose(res);

      sseSend(res, { type: "stage", stage: "downloading" });
      try {
        await downloadAudioToTmp({
          youtubeUrl: normalized,
          outPath: fullAudio,
          signal: ctrlSignal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Audio download failed";
        throw new Error(`Audio download failed: ${message}`);
      }

      // Probe the actual duration we got — falls back to meta if probe fails.
      let probedDuration = 0;
      try {
        probedDuration = await probeAudioDurationSec(fullAudio);
      } catch (err) {
        req_logger_warn(req, err, "ffprobe failed — using YouTube metadata duration instead");
      }
      const totalDurationSec = probedDuration > 0 ? probedDuration : durationSec;

      sseSend(res, { type: "stage", stage: "splitting" });
      const chunks = await splitAudioIntoChunks({
        inPath: fullAudio,
        outDir: tmpDir,
        totalDurationSec,
        chunkCount,
        overlapSec: PITAJI_AUDIO_OVERLAP_SEC,
        signal: ctrlSignal,
      });
      // Free the full-length file as soon as the chunks exist — it can be
      // 50 MB+ and Lambda /tmp has limited room.
      tryUnlink(fullAudio);

      // Sequentially analyze each chunk so SSE events arrive in order and
      // we can dedupe overlapping clips against the running collection.
      for (const ch of chunks) {
        if (ctrlSignal.aborted) break;
        sseSend(res, {
          type: "stage",
          stage: "analyzing",
          chunk: ch.index,
          total: ch.total,
        });
        await analyzeAudioChunkInline({
          chunkPath: ch.path,
          mimeType: ch.mimeType,
          chunkOffsetSec: ch.offsetSec,
          chunkDurationSec: ch.durationSec,
          totalDurationSec,
          chunkIndex: ch.index,
          chunkTotal: ch.total,
          clipInstructions,
          signal: ctrlSignal,
          onClip: (clip) => {
            // Dedupe clips that fall in the overlap region between
            // adjacent chunks (Q&A or topic spanning the cut).
            if (isLikelyDuplicateClip(clip, collected, PITAJI_AUDIO_OVERLAP_SEC)) {
              return;
            }
            persistClip(clip);
          },
        });
        // Drop the chunk as soon as it's analyzed — keeps /tmp usage low
        // for very long videos with 3 chunks.
        tryUnlink(ch.path);
      }
    }

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
      totalClips: collected.length,
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
    if (pipelineMode === "audio_split") {
      cleanupJobTmpDir(jobId);
    }
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

// ── /jobs/:jobId/refine — multi-turn clip refinement chat ─────────────────
// User chats with the model to adjust clips: shift timestamps, merge,
// split, add new clips, drop clips, rewrite metadata. The model receives
// the current clip list + user message and returns BOTH a natural-language
// reply and an updated clips array. Server replaces the persisted clips
// and SSE-streams the diff to the client.

const PITAJI_REFINE_SYSTEM_PROMPT = `
You are an editor refining a list of broadcast-worthy video clips a Pita Ji
analysis pipeline previously extracted. The operator will give you the
current clips list (JSON) and a natural-language instruction. Your job:

  1. Apply the requested changes (shift bounds, add/remove/merge/split clips,
     edit titles or descriptions, adjust hashtags, etc.).
  2. Keep every clip you did NOT need to change exactly as it was — preserve
     each clip's "id" so the client can match and update in place.
  3. New clips you add must NOT have an "id" field — the server will mint one.
  4. Times are integer seconds, clips MUST NOT overlap, endSec > startSec.
  5. Preserve full per-clip publish bundle fields (title, summary,
     suggestedTitle, description, hashtags, pinnedComment, kind, speakerHint,
     and question/answer for kind=qna).

OUTPUT FORMAT — STRICT:
  {
    "reply": "<≤2 short sentences explaining what you changed>",
    "clips": [ <full updated clip objects, in chronological order> ]
  }
  No prose outside the JSON. No code fences.
`;

router.post("/pitaji/jobs/:jobId/refine", async (req: Request, res: Response) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "AI is not configured." });
    return;
  }
  if (!isPitajiStoreEnabled()) {
    res.status(503).json({ error: "Pita Ji store is not configured." });
    return;
  }

  const jobId = String(req.params.jobId ?? "").trim();
  if (!/^pj_[A-Za-z0-9]+$/.test(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }
  const message = String((req.body as { message?: unknown })?.message ?? "").trim();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const job = await getAnalyzeJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const existingClips = Array.isArray(job.clips) ? job.clips : [];

  setupSse(res);
  sseSend(res, { type: "run_start", jobId, ts: Date.now() });

  try {
    const { createGeminiClient } = await import("../lib/gemini-client");
    const ai = createGeminiClient();
    const userPrompt = [
      "Current clips (JSON):",
      JSON.stringify({ clips: existingClips }),
      "",
      "Operator instruction:",
      message,
    ].join("\n");

    const resp = await ai.models.generateContent({
      model:
        (process.env.PITAJI_REFINE_MODEL ?? process.env.PITAJI_ANALYSIS_MODEL ?? "gemini-3.5-flash").trim() ||
        "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: PITAJI_REFINE_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 32_768,
      },
    });

    const text = (resp.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("")
      .trim();

    let parsed: { reply?: string; clips?: unknown[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Model returned invalid JSON for refine");
    }

    const reply = typeof parsed.reply === "string" ? parsed.reply : "Updated.";
    const incoming = Array.isArray(parsed.clips) ? parsed.clips : [];

    // Re-mint ids for any clip that lacks one (newly added by the model)
    // and keep existing ids stable so the client can match-and-replace.
    const crypto = await import("node:crypto");
    const updated: PitajiClip[] = incoming
      .map((raw): PitajiClip | null => {
        const o = raw as Record<string, unknown>;
        const start = Number(o.startSec);
        const end = Number(o.endSec);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        const kindRaw = String(o.kind ?? "topic").toLowerCase();
        const kind = kindRaw === "qna" ? ("qna" as const) : ("topic" as const);
        const id =
          typeof o.id === "string" && o.id.length > 0
            ? o.id
            : `clip_${crypto.randomBytes(6).toString("hex")}`;
        const tags = Array.isArray(o.hashtags)
          ? (o.hashtags as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const clip: PitajiClip = {
          id,
          kind,
          title: typeof o.title === "string" ? o.title : "Untitled",
          summary: typeof o.summary === "string" ? o.summary : "",
          startSec: Math.max(0, Math.round(start)),
          endSec: Math.max(Math.round(start) + 1, Math.round(end)),
          speakerHint: typeof o.speakerHint === "string" ? o.speakerHint : "primary",
          suggestedTitle: typeof o.suggestedTitle === "string" ? o.suggestedTitle : "",
          description: typeof o.description === "string" ? o.description : "",
          hashtags: tags.slice(0, 8),
          pinnedComment: typeof o.pinnedComment === "string" ? o.pinnedComment : "",
        };
        if (kind === "qna") {
          clip.question = typeof o.question === "string" ? o.question : "";
          clip.answer = typeof o.answer === "string" ? o.answer : "";
        }
        return clip;
      })
      .filter((c): c is PitajiClip => c !== null)
      .sort((a, b) => a.startSec - b.startSec);

    // Persist + emit. Client clears its clip list on `clips_replaced` and
    // re-renders from the events that follow.
    await updateAnalyzeJob(jobId, { clips: updated });
    sseSend(res, { type: "text", message: reply });
    sseSend(res, { type: "clips_replaced", total: updated.length });
    for (const c of updated) {
      sseSend(res, { type: "clip", clip: c });
    }
    sseSend(res, { type: "summary", totalClips: updated.length, jobId });
    sseSend(res, { type: "done" });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Refine failed";
    req_logger_warn(req, err, "Pita Ji refine failed");
    sseSend(res, { type: "error", message: m });
    sseSend(res, { type: "done" });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ── /jobs/:jobId/dispatch — fire cut + thumbnail jobs in background ───────
// User picks the clips they want and clicks Cut / Thumbnail / Both. The
// dispatcher creates a pjc_<uuid> dispatch record per clip in DDB, calls
// the existing /api/youtube/clip-cut endpoint internally for cuts, and
// (Phase 5) will enqueue the thumbnail agent. Returns the list of created
// dispatch ids immediately — the work continues in the background.

interface DispatchRequestBody {
  clipIds?: unknown;
  action?: unknown;
}

router.post("/pitaji/jobs/:jobId/dispatch", async (req: Request, res: Response) => {
  if (!isPitajiStoreEnabled()) {
    res.status(503).json({ error: "Pita Ji store is not configured." });
    return;
  }

  const jobId = String(req.params.jobId ?? "").trim();
  if (!/^pj_[A-Za-z0-9]+$/.test(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }
  const body = req.body as DispatchRequestBody;
  const wantedIds = Array.isArray(body.clipIds)
    ? body.clipIds.filter((x): x is string => typeof x === "string")
    : [];
  const action = body.action === "thumbnail" || body.action === "both" || body.action === "cut"
    ? (body.action as "cut" | "thumbnail" | "both")
    : null;
  if (wantedIds.length === 0 || !action) {
    res.status(400).json({ error: "clipIds[] and action ('cut'|'thumbnail'|'both') are required" });
    return;
  }

  const job = await getAnalyzeJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const allClips = Array.isArray(job.clips) ? job.clips : [];
  const byId = new Map(allClips.map((c) => [c.id, c]));
  const clipsToDispatch = wantedIds
    .map((id) => byId.get(id))
    .filter((c): c is PitajiClip => Boolean(c));
  if (clipsToDispatch.length === 0) {
    res.status(400).json({ error: "No matching clips found in this job" });
    return;
  }

  const dispatched: Array<{
    pitajiClipId: string;
    clipId: string;
    cutChildJobId?: string;
    cutError?: string;
  }> = [];
  const now = Date.now();

  for (const clip of clipsToDispatch) {
    const pitajiClipId = newClipJobId();
    const dispatchRec: PitajiClipDispatch = {
      jobId: pitajiClipId,
      kind: "pitaji-clip",
      parentJobId: jobId,
      clip,
      action,
      status: action === "thumbnail" ? "thumbnail-pending" : "queued",
      createdAt: now,
      updatedAt: now,
    };

    if (action === "cut" || action === "both") {
      try {
        const child = await dispatchClipCut({
          youtubeUrl: job.youtubeUrl,
          startSec: clip.startSec,
          endSec: clip.endSec,
        });
        dispatchRec.cutChildJobId = child.jobId;
        dispatchRec.status = "cutting";
      } catch (err) {
        const m = err instanceof Error ? err.message : "Failed to start cut job";
        dispatchRec.status = "error";
        dispatchRec.error = m;
        dispatched.push({ pitajiClipId, clipId: clip.id, cutError: m });
        try { await putClipDispatch(dispatchRec); } catch (e2) { req_logger_warn(req, e2, "putClipDispatch failed"); }
        continue;
      }
    }

    try {
      await putClipDispatch(dispatchRec);
    } catch (err) {
      req_logger_warn(req, err, "Failed to persist clip dispatch record");
    }
    dispatched.push({
      pitajiClipId,
      clipId: clip.id,
      cutChildJobId: dispatchRec.cutChildJobId,
    });
  }

  // Mark parent as "dispatched" once at least one cut started successfully.
  try {
    await updateAnalyzeJob(jobId, { status: "dispatched" });
  } catch (err) {
    req_logger_warn(req, err, "Failed to mark parent job dispatched");
  }

  res.json({ ok: true, dispatched });
});

// ── /jobs/:jobId/dispatches — list dispatches with rolled-up cut progress ──
// Frontend polls this every few seconds while clips are being cut.

router.get("/pitaji/jobs/:jobId/dispatches", async (req: Request, res: Response) => {
  if (!isPitajiStoreEnabled()) {
    res.json({ dispatches: [] });
    return;
  }
  const jobId = String(req.params.jobId ?? "").trim();
  if (!/^pj_[A-Za-z0-9]+$/.test(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }

  let dispatches: PitajiClipDispatch[] = [];
  try {
    dispatches = await listClipDispatchesByParent(jobId);
  } catch (err) {
    req_logger_warn(req, err, "Failed to list dispatches");
    res.status(500).json({ error: "Failed to list dispatches" });
    return;
  }

  // Roll up the child cut-job status from /api/youtube/progress so the
  // client can show live "Cutting → 42%" pills inline.
  const enriched = await Promise.all(
    dispatches.map(async (d) => {
      let cutProgress: {
        status?: string;
        message?: string | null;
        progressPct?: number | null;
        s3Key?: string | null;
        filename?: string | null;
      } | null = null;
      if (d.cutChildJobId) {
        cutProgress = await fetchClipCutProgress(d.cutChildJobId);
      }
      return {
        ...stripDispatchForClient(d),
        cutProgress,
      };
    }),
  );

  res.json({ dispatches: enriched });
});

// ── Internal helpers ──────────────────────────────────────────────────────

const INTERNAL_BASE_URL = (() => {
  const fromEnv = (process.env.INTERNAL_API_BASE ?? "").trim().replace(/\/+$/, "");
  return fromEnv || "";
})();
const INTERNAL_AGENT_HEADER = "X-Internal-Agent";
const INTERNAL_AGENT_SECRET =
  process.env.INTERNAL_AGENT_SECRET ?? "internal-agent-bypass-key";

async function dispatchClipCut(params: {
  youtubeUrl: string;
  startSec: number;
  endSec: number;
}): Promise<{ jobId: string; status?: string }> {
  const apiBase = INTERNAL_BASE_URL ? `${INTERNAL_BASE_URL}/api` : "";
  if (!apiBase.startsWith("http")) {
    throw new Error("INTERNAL_API_BASE is not configured (Lambda warm-start should have set it)");
  }
  const r = await fetch(`${apiBase}/youtube/clip-cut`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_SECRET,
    },
    body: JSON.stringify({
      url: params.youtubeUrl,
      startTime: params.startSec,
      endTime: params.endSec,
      quality: "best",
    }),
  });
  if (!r.ok) {
    let msg = `clip-cut returned ${r.status}`;
    try {
      const data = (await r.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = (await r.json()) as { jobId?: string; status?: string };
  if (!data.jobId) throw new Error("clip-cut response missing jobId");
  return { jobId: data.jobId, status: data.status };
}

async function fetchClipCutProgress(childJobId: string): Promise<{
  status?: string;
  message?: string | null;
  progressPct?: number | null;
  s3Key?: string | null;
  filename?: string | null;
} | null> {
  const apiBase = INTERNAL_BASE_URL ? `${INTERNAL_BASE_URL}/api` : "";
  if (!apiBase.startsWith("http")) return null;
  try {
    const r = await fetch(`${apiBase}/youtube/progress/${encodeURIComponent(childJobId)}`, {
      headers: { [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_SECRET },
    });
    if (!r.ok) return null;
    const data = (await r.json()) as Record<string, unknown>;
    return {
      status: typeof data.status === "string" ? data.status : undefined,
      message: typeof data.message === "string" ? data.message : null,
      progressPct:
        typeof data.progressPct === "number"
          ? data.progressPct
          : typeof data.percent === "number"
            ? data.percent
            : null,
      s3Key: typeof data.s3Key === "string" ? data.s3Key : null,
      filename: typeof data.filename === "string" ? data.filename : null,
    };
  } catch {
    return null;
  }
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
