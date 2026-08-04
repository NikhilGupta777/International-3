import { Router, type Request, type Response } from "express";
import { setupSse, sseFlush } from "../lib/sse";
import { deriveWorkspaceIdentity } from "../lib/workspace";
import {
  PROJECT_ID_RE,
  appendActivity,
  deleteProject,
  getProject,
  listProjects,
  newClipId,
  newProjectId,
  patchProject,
  saveProject,
  updateClip,
} from "../lib/newtab-project-store";
import {
  computeProjectProgress,
  deriveProjectStatus,
  describeProject,
  isClipTerminal,
  summarizeProject,
  type AspectRatio,
  type ClipStatus,
  type NewTabProject,
  type ProjectBrief,
  type ProjectClip,
  type ProjectSourceVideo,
} from "../lib/newtab-project-types";

const router = Router();

const MAX_TITLE_CHARS = 160;
const MAX_TEXT_CHARS = 8000;
const MAX_CLIPS_PER_REQUEST = 200;
const SSE_POLL_MS = 1500;
const SSE_HEARTBEAT_MS = 8000;
const SSE_MAX_DURATION_MS = 30 * 60_000;

const CLIP_STATUSES: ReadonlySet<string> = new Set([
  "queued", "cutting", "captioning", "editing", "packaging",
  "ready", "failed", "needs_input", "cancelled",
]);
const ASPECT_RATIOS: ReadonlySet<string> = new Set(["16:9", "9:16", "1:1", "original"]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function ownerOf(req: Request): string {
  return deriveWorkspaceIdentity(req).workspaceId;
}

function bad(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function str(value: unknown, max = MAX_TEXT_CHARS): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPercent(value: unknown, fallback = 0): number {
  return Math.max(0, Math.min(100, Math.round(num(value, fallback))));
}

function normalizeBrief(raw: unknown): ProjectBrief {
  const input = (raw ?? {}) as Record<string, unknown>;
  const spec = (input.outputSpec ?? {}) as Record<string, unknown>;
  const aspect = str(spec.aspectRatio, 12);
  const strategy = str(input.clipStrategy, 32) === "explicit_ranges" ? "explicit_ranges" : "exhaustive";

  const explicitRanges = Array.isArray(input.explicitRanges)
    ? (input.explicitRanges as unknown[]).slice(0, MAX_CLIPS_PER_REQUEST).map((item) => {
        const range = (item ?? {}) as Record<string, unknown>;
        return {
          startSec: Math.max(0, num(range.startSec)),
          endSec: Math.max(0, num(range.endSec)),
          label: str(range.label, MAX_TITLE_CHARS) || undefined,
        };
      })
    : undefined;

  return {
    goal: str(input.goal),
    clipStrategy: strategy,
    explicitRanges,
    editStyle: str(input.editStyle),
    outputSpec: {
      aspectRatio: (ASPECT_RATIOS.has(aspect) ? aspect : "original") as AspectRatio,
      burnCaptions: Boolean(spec.burnCaptions),
      captionLanguage: str(spec.captionLanguage, 16) || undefined,
    },
    channelProfileId: str(input.channelProfileId, 128) || null,
    channelName: str(input.channelName, MAX_TITLE_CHARS) || null,
    context: str(input.context),
  };
}

function normalizeSourceVideo(raw: unknown): ProjectSourceVideo | null {
  const input = (raw ?? {}) as Record<string, unknown>;
  const url = str(input.url, 2000);
  const videoId = str(input.videoId, 64) || url;
  if (!url && !videoId) return null;
  return {
    videoId,
    url,
    title: str(input.title, MAX_TITLE_CHARS) || "Untitled video",
    durationSec: Math.max(0, num(input.durationSec)),
    thumbnailUrl: str(input.thumbnailUrl, 2000) || null,
    addedAt: Date.now(),
  };
}

function normalizeIncomingClip(raw: unknown, defaultSourceId: string): ProjectClip | null {
  const input = (raw ?? {}) as Record<string, unknown>;
  const startSec = Math.max(0, num(input.startSec));
  const endSec = Math.max(0, num(input.endSec));
  if (endSec <= startSec) return null;

  const status = str(input.status, 32);
  const now = Date.now();
  return {
    clipId: newClipId(),
    label: str(input.label, MAX_TITLE_CHARS) || "Untitled clip",
    sourceVideoId: str(input.sourceVideoId, 64) || defaultSourceId,
    startSec,
    endSec,
    details: Array.isArray(input.details)
      ? (input.details as unknown[]).slice(0, 8).map((item) => str(item, 500)).filter(Boolean)
      : [],
    status: (CLIP_STATUSES.has(status) ? status : "queued") as ClipStatus,
    progress: clampPercent(input.progress, 0),
    message: str(input.message, 300),
    error: null,
    jobs: {},
    outputs: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** The shape the UI reads: the stored doc plus everything derived from it. */
function projectView(project: NewTabProject) {
  return {
    ...project,
    status: deriveProjectStatus(project),
    progress: computeProjectProgress(project),
    message: describeProject(project),
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/newtab/projects", async (req, res) => {
  try {
    const projects = await listProjects(ownerOf(req));
    res.json({ projects: projects.map(summarizeProject) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to list projects");
  }
});

router.post("/newtab/projects", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const brief = normalizeBrief(body.brief);
    const title = str(body.title, MAX_TITLE_CHARS);

    const sourceVideos = Array.isArray(body.sourceVideos)
      ? (body.sourceVideos as unknown[]).map(normalizeSourceVideo).filter((item): item is ProjectSourceVideo => Boolean(item))
      : [];

    if (!title && !brief.goal && sourceVideos.length === 0) {
      bad(res, 400, "A title, a brief goal, or at least one source video is required.");
      return;
    }

    const defaultSourceId = sourceVideos[0]?.videoId ?? "";
    const clips = Array.isArray(body.clips)
      ? (body.clips as unknown[])
          .slice(0, MAX_CLIPS_PER_REQUEST)
          .map((clip) => normalizeIncomingClip(clip, defaultSourceId))
          .filter((clip): clip is ProjectClip => Boolean(clip))
      : [];

    const now = Date.now();
    const project: NewTabProject = {
      projectId: newProjectId(),
      owner: ownerOf(req),
      title: title || brief.goal.slice(0, MAX_TITLE_CHARS) || sourceVideos[0]?.title || "Untitled project",
      lifecycle: clips.length > 0 ? "running" : "queued",
      chatSessionId: str(body.chatSessionId, 128) || null,
      brief,
      sourceVideos,
      clips,
      activity: [],
      createdAt: now,
      updatedAt: now,
      startedAt: clips.length > 0 ? now : null,
      completedAt: null,
      error: null,
    };
    appendActivity(project, { stage: "created", level: "info", message: "Project created" });

    const saved = await saveProject(project);
    res.status(201).json({ project: projectView(saved) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to create project");
  }
});

router.get("/newtab/projects/:projectId", async (req, res) => {
  const { projectId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    const project = await getProject(projectId, ownerOf(req));
    if (!project) { bad(res, 404, "Project not found"); return; }
    res.json({ project: projectView(project) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to read project");
  }
});

router.patch("/newtab/projects/:projectId", async (req, res) => {
  const { projectId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await patchProject(projectId, ownerOf(req), (project) => {
      const title = str(body.title, MAX_TITLE_CHARS);
      if (title) project.title = title;
      if (body.brief !== undefined) {
        project.brief = { ...project.brief, ...normalizeBrief({ ...project.brief, ...(body.brief as object) }) };
        appendActivity(project, { stage: "brief", level: "info", message: "Brief updated" });
      }
    });
    if (!updated) { bad(res, 404, "Project not found"); return; }
    res.json({ project: projectView(updated) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to update project");
  }
});

router.post("/newtab/projects/:projectId/clips", async (req, res) => {
  const { projectId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    const incoming = Array.isArray((req.body ?? {}).clips) ? (req.body.clips as unknown[]) : [];
    if (incoming.length === 0) { bad(res, 400, "clips must be a non-empty array"); return; }

    let added = 0;
    const updated = await patchProject(projectId, ownerOf(req), (project) => {
      const defaultSourceId = project.sourceVideos[0]?.videoId ?? "";
      const clips = incoming
        .slice(0, MAX_CLIPS_PER_REQUEST)
        .map((clip) => normalizeIncomingClip(clip, defaultSourceId))
        .filter((clip): clip is ProjectClip => Boolean(clip));
      if (clips.length === 0) return;
      added = clips.length;
      project.clips = [...project.clips, ...clips];
      if (project.lifecycle === "queued" || project.lifecycle === "planning") {
        project.lifecycle = "running";
        project.startedAt ??= Date.now();
      }
      appendActivity(project, { stage: "clips", level: "info", message: `${clips.length} clip(s) added` });
    });

    if (!updated) { bad(res, 404, "Project not found"); return; }
    if (added === 0) { bad(res, 400, "No valid clips in request (endSec must be greater than startSec)"); return; }
    res.status(201).json({ project: projectView(updated) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to add clips");
  }
});

/**
 * Clip state transitions. The runner will call this internally in phase 2; for now
 * it is also how the shell gets driven through its states for testing.
 */
router.patch("/newtab/projects/:projectId/clips/:clipId", async (req, res) => {
  const { projectId, clipId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = str(body.status, 32);
    if (status && !CLIP_STATUSES.has(status)) { bad(res, 400, `Invalid clip status: ${status}`); return; }

    let found = false;
    const updated = await patchProject(projectId, ownerOf(req), (project) => {
      const patch: Partial<ProjectClip> = {};
      if (status) patch.status = status as ClipStatus;
      if (body.progress !== undefined) patch.progress = clampPercent(body.progress);
      if (body.message !== undefined) patch.message = str(body.message, 300);
      if (body.error !== undefined) patch.error = str(body.error, 1000) || null;
      if (body.label !== undefined) patch.label = str(body.label, MAX_TITLE_CHARS);
      if (body.outputs !== undefined) patch.outputs = (body.outputs ?? {}) as ProjectClip["outputs"];
      if (body.jobs !== undefined) patch.jobs = (body.jobs ?? {}) as ProjectClip["jobs"];
      if (body.seo !== undefined) patch.seo = (body.seo ?? {}) as ProjectClip["seo"];
      if (status === "ready") patch.progress = 100;

      const clip = updateClip(project, clipId, patch);
      if (!clip) return;
      found = true;

      if (status) {
        appendActivity(project, {
          stage: "clip",
          level: status === "failed" ? "error" : "info",
          message: `${clip.label}: ${status}${clip.error ? ` — ${clip.error}` : ""}`,
        });
      }
      if (project.clips.every((item) => isClipTerminal(item.status))) {
        project.completedAt = Date.now();
      } else {
        project.completedAt = null;
      }
    });

    if (!updated) { bad(res, 404, "Project not found"); return; }
    if (!found) { bad(res, 404, "Clip not found"); return; }
    res.json({ project: projectView(updated) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to update clip");
  }
});

router.post("/newtab/projects/:projectId/clips/:clipId/retry", async (req, res) => {
  const { projectId, clipId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    let found = false;
    const updated = await patchProject(projectId, ownerOf(req), (project) => {
      const clip = updateClip(project, clipId, {
        status: "queued", progress: 0, message: "Queued for retry", error: null,
      });
      if (!clip) return;
      found = true;
      project.completedAt = null;
      if (project.lifecycle === "cancelled" || project.lifecycle === "error") project.lifecycle = "running";
      appendActivity(project, { stage: "clip", level: "info", message: `${clip.label}: retry requested` });
    });
    if (!updated) { bad(res, 404, "Project not found"); return; }
    if (!found) { bad(res, 404, "Clip not found"); return; }
    res.json({ project: projectView(updated) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to retry clip");
  }
});

router.post("/newtab/projects/:projectId/cancel", async (req, res) => {
  const { projectId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    const updated = await patchProject(projectId, ownerOf(req), (project) => {
      project.lifecycle = "cancelled";
      project.completedAt = Date.now();
      for (const clip of project.clips) {
        if (!isClipTerminal(clip.status)) {
          clip.status = "cancelled";
          clip.message = "Cancelled";
          clip.updatedAt = Date.now();
        }
      }
      appendActivity(project, { stage: "cancel", level: "warn", message: "Project cancelled" });
    });
    if (!updated) { bad(res, 404, "Project not found"); return; }
    // Phase 2: also terminate in-flight Batch jobs referenced by clip.jobs.
    res.json({ project: projectView(updated) });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to cancel project");
  }
});

router.delete("/newtab/projects/:projectId", async (req, res) => {
  const { projectId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }
  try {
    const deleted = await deleteProject(projectId, ownerOf(req));
    if (!deleted) { bad(res, 404, "Project not found"); return; }
    res.json({ ok: true });
  } catch (err: any) {
    bad(res, 500, err?.message ?? "Failed to delete project");
  }
});

/** Live project updates for the detail view. Polls the store and emits on change. */
router.get("/newtab/projects/:projectId/stream", async (req, res) => {
  const { projectId } = req.params;
  if (!PROJECT_ID_RE.test(projectId)) { bad(res, 400, "Invalid project id"); return; }

  const owner = ownerOf(req);
  const initial = await getProject(projectId, owner);
  if (!initial) { bad(res, 404, "Project not found"); return; }

  setupSse(res);
  let lastUpdatedAt = 0;
  let closed = false;

  const send = (payload: object) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    sseFlush(res);
  };

  const emit = (project: NewTabProject) => {
    lastUpdatedAt = project.updatedAt;
    send({ type: "project", project: projectView(project) });
  };
  emit(initial);

  const poll = setInterval(async () => {
    if (closed) return;
    try {
      const project = await getProject(projectId, owner);
      if (!project) { send({ type: "deleted" }); cleanup(); return; }
      if (project.updatedAt !== lastUpdatedAt) emit(project);
    } catch {
      // transient store error — keep the stream open and retry on the next tick
    }
  }, SSE_POLL_MS);

  const heartbeat = setInterval(() => send({ type: "heartbeat" }), SSE_HEARTBEAT_MS);
  const maxDuration = setTimeout(() => { send({ type: "done" }); cleanup(); }, SSE_MAX_DURATION_MS);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    clearTimeout(maxDuration);
    if (!res.writableEnded) res.end();
  }

  // res.on("close") — not req.on("close"), which fires once the body is consumed.
  res.on("close", cleanup);
});

export default router;
