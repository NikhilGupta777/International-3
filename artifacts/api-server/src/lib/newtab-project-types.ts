/**
 * New Tab Studio projects.
 *
 * A project is the unit of work: one brief, one or more source videos, and the
 * clips cut out of them. The New Tab chat only ever *creates* a project — the
 * runner (phase 2) executes it in the background and writes progress here.
 */

export type ClipStatus =
  | "queued"
  | "cutting"
  | "captioning"
  | "editing"
  | "packaging"
  | "ready"
  | "failed"
  | "needs_input"
  | "cancelled";

/** What the project card shows. Derived from the clips — see deriveProjectStatus. */
export type ProjectStatus =
  | "queued"
  | "planning"
  | "running"
  | "needs_input"
  | "ready"
  | "failed"
  | "cancelled";

/** Set by the API/runner; only cancelled and error override the derived status. */
export type ProjectLifecycle = "draft" | "queued" | "planning" | "running" | "cancelled" | "error";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "original";

export type ClipJobRefs = {
  cut?: string | null;
  subtitles?: string | null;
  render?: string | null;
};

export type ClipOutputs = {
  videoKey?: string | null;
  srtKey?: string | null;
  thumbKey?: string | null;
};

export type ClipSeo = {
  title?: string;
  description?: string;
  tags?: string[];
};

export type ProjectClip = {
  clipId: string;
  label: string;
  sourceVideoId: string;
  startSec: number;
  endSec: number;
  /** 2-4 bullets from the discovery pass explaining what is said in this range. */
  details: string[];
  status: ClipStatus;
  progress: number;
  message: string;
  error?: string | null;
  jobs: ClipJobRefs;
  outputs: ClipOutputs;
  seo?: ClipSeo;
  createdAt: number;
  updatedAt: number;
};

export type ProjectSourceVideo = {
  videoId: string;
  url: string;
  title: string;
  durationSec: number;
  thumbnailUrl?: string | null;
  addedAt: number;
};

export type ClipStrategy = "exhaustive" | "explicit_ranges";

export type ProjectBrief = {
  /** What the user actually asked for, in their words. */
  goal: string;
  clipStrategy: ClipStrategy;
  explicitRanges?: Array<{ startSec: number; endSec: number; label?: string }>;
  editStyle: string;
  outputSpec: {
    aspectRatio: AspectRatio;
    burnCaptions: boolean;
    captionLanguage?: string;
  };
  channelProfileId?: string | null;
  channelName?: string | null;
  /**
   * Free-form handoff context: everything the intake agent learned that doesn't
   * fit the schema. Goes into the runner's system prompt verbatim.
   */
  context: string;
};

export type ProjectActivityEntry = {
  at: number;
  stage: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type NewTabProject = {
  projectId: string;
  owner: string;
  title: string;
  lifecycle: ProjectLifecycle;
  chatSessionId?: string | null;
  brief: ProjectBrief;
  sourceVideos: ProjectSourceVideo[];
  clips: ProjectClip[];
  activity: ProjectActivityEntry[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  error?: string | null;
};

export type NewTabProjectSummary = {
  projectId: string;
  title: string;
  status: ProjectStatus;
  progress: number;
  message: string;
  clipCount: number;
  readyClipCount: number;
  failedClipCount: number;
  sourceTitle: string | null;
  thumbnailUrl: string | null;
  channelName: string | null;
  createdAt: number;
  updatedAt: number;
};

// ── Derivation ─────────────────────────────────────────────────────────────────

const TERMINAL_CLIP_STATUSES: ReadonlySet<ClipStatus> = new Set(["ready", "failed", "cancelled"]);
const ACTIVE_CLIP_STATUSES: ReadonlySet<ClipStatus> = new Set(["cutting", "captioning", "editing", "packaging"]);

export function isClipTerminal(status: ClipStatus): boolean {
  return TERMINAL_CLIP_STATUSES.has(status);
}

const CLIP_STAGE_LABEL: Record<ClipStatus, string> = {
  queued: "Queued",
  cutting: "Cutting",
  captioning: "Captioning",
  editing: "Editing",
  packaging: "Packaging",
  ready: "Ready",
  failed: "Failed",
  needs_input: "Needs input",
  cancelled: "Cancelled",
};

export function clipStageLabel(status: ClipStatus): string {
  return CLIP_STAGE_LABEL[status] ?? status;
}

/**
 * The project status is always computed from its clips, never stored independently
 * — that is what stops the card from claiming "done" while a clip is still failing.
 * Only an explicit cancel or a planning-stage error overrides it.
 */
export function deriveProjectStatus(project: NewTabProject): ProjectStatus {
  if (project.lifecycle === "cancelled") return "cancelled";
  if (project.lifecycle === "error") return "failed";

  const clips = project.clips ?? [];
  if (clips.length === 0) {
    if (project.lifecycle === "planning") return "planning";
    if (project.lifecycle === "running") return "running";
    return "queued";
  }

  if (clips.some((clip) => clip.status === "needs_input")) return "needs_input";
  if (clips.some((clip) => ACTIVE_CLIP_STATUSES.has(clip.status))) return "running";

  const allTerminal = clips.every((clip) => isClipTerminal(clip.status));
  if (allTerminal) {
    if (clips.some((clip) => clip.status === "ready")) return "ready";
    if (clips.every((clip) => clip.status === "cancelled")) return "cancelled";
    return "failed";
  }

  return project.lifecycle === "running" ? "running" : "queued";
}

export function computeProjectProgress(project: NewTabProject): number {
  const clips = project.clips ?? [];
  if (clips.length === 0) return project.lifecycle === "planning" ? 5 : 0;
  const total = clips.reduce((sum, clip) => {
    if (clip.status === "ready") return sum + 100;
    if (clip.status === "failed" || clip.status === "cancelled") return sum + 100;
    return sum + Math.max(0, Math.min(100, clip.progress || 0));
  }, 0);
  return Math.round(total / clips.length);
}

export function describeProject(project: NewTabProject): string {
  const status = deriveProjectStatus(project);
  const clips = project.clips ?? [];

  if (status === "cancelled") return "Cancelled";
  if (status === "planning") return "Planning clips…";
  if (status === "failed" && clips.length === 0) return project.error || "Failed";
  if (status === "queued" && clips.length === 0) return "Waiting to start";
  if (status === "running" && clips.length === 0) return "Project AI is preparing the work";

  if (status === "ready") {
    const failed = clips.filter((clip) => clip.status === "failed").length;
    const ready = clips.filter((clip) => clip.status === "ready").length;
    return failed > 0 ? `${ready} of ${clips.length} clips ready · ${failed} failed` : `${clips.length} clips ready`;
  }
  if (status === "failed") return project.error || "All clips failed";
  if (status === "needs_input") {
    const index = clips.findIndex((clip) => clip.status === "needs_input");
    return `Clip ${index + 1} of ${clips.length} needs input`;
  }

  const activeIndex = clips.findIndex((clip) => !isClipTerminal(clip.status));
  if (activeIndex < 0) return `${clips.length} clips`;
  const active = clips[activeIndex]!;
  return `${clipStageLabel(active.status)} clip ${activeIndex + 1} of ${clips.length}`;
}

export function summarizeProject(project: NewTabProject): NewTabProjectSummary {
  const clips = project.clips ?? [];
  const firstSource = project.sourceVideos?.[0] ?? null;
  return {
    projectId: project.projectId,
    title: project.title,
    status: deriveProjectStatus(project),
    progress: computeProjectProgress(project),
    message: describeProject(project),
    clipCount: clips.length,
    readyClipCount: clips.filter((clip) => clip.status === "ready").length,
    failedClipCount: clips.filter((clip) => clip.status === "failed").length,
    sourceTitle: firstSource?.title ?? null,
    thumbnailUrl: firstSource?.thumbnailUrl ?? null,
    channelName: project.brief?.channelName ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}
