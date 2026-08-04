import { appendActivity, listProjects, newClipId, newProjectId, patchProject, saveProject } from "./newtab-project-store";
import { extractJsonBlock, runNewTabCompletion } from "./newtab-models";
import type { NewTabProject, ProjectClip, ProjectSourceVideo } from "./newtab-project-types";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function videoIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1) || url;
    if (parsed.hostname.includes("youtube.com")) return parsed.searchParams.get("v") || url;
  } catch {
    // Keep the URL as a stable source identifier when it is not parseable.
  }
  return url;
}

function sourcesFromText(text: string): ProjectSourceVideo[] {
  return [...new Set(text.match(URL_RE) ?? [])].slice(0, 12).map((url) => ({
    videoId: videoIdFromUrl(url),
    url,
    title: "Source video",
    durationSec: 0,
    thumbnailUrl: null,
    addedAt: Date.now(),
  }));
}

function titleFromRequest(text: string): string {
  const clean = text.replace(URL_RE, "").replace(/\s+/g, " ").trim();
  return (clean || "New video project").slice(0, 96);
}

export async function createOrReuseChatProject(params: {
  owner: string;
  sessionId: string;
  requestText: string;
  fullContext: string;
  approvedBrief?: {
    title?: string;
    goal?: string;
    sourceUrls?: string[];
    channelName?: string;
    channelProfileId?: string;
    editStyle?: string;
    aspectRatio?: "16:9" | "9:16" | "1:1" | "original";
    burnCaptions?: boolean;
    captionLanguage?: string;
    requirements?: string;
  };
}): Promise<{ project: NewTabProject; created: boolean }> {
  const brief = params.approvedBrief;
  const incomingSources = sourcesFromText([params.requestText, ...(brief?.sourceUrls ?? [])].join("\n"));
  const incomingSourceIds = new Set(incomingSources.map((source) => source.videoId));
  const existing = (await listProjects(params.owner)).find((project) => {
    if (project.chatSessionId !== params.sessionId || project.lifecycle === "cancelled") return false;
    if (incomingSourceIds.size === 0 || project.sourceVideos.length === 0) return true;
    return project.sourceVideos.some((source) => incomingSourceIds.has(source.videoId));
  });

  if (existing) {
    const updated = await patchProject(existing.projectId, params.owner, (project) => {
      const known = new Set(project.sourceVideos.map((source) => source.videoId));
      project.sourceVideos.push(...incomingSources.filter((source) => !known.has(source.videoId)));
      project.title = brief?.title?.trim().slice(0, 160) || project.title;
      project.brief.goal = brief?.goal?.trim() || params.requestText;
      project.brief.context = [params.fullContext, brief?.requirements].filter(Boolean).join("\n\nApproved requirements:\n");
      if (brief?.channelName) project.brief.channelName = brief.channelName.slice(0, 160);
      if (brief?.channelProfileId) project.brief.channelProfileId = brief.channelProfileId.slice(0, 128);
      if (brief?.editStyle) project.brief.editStyle = brief.editStyle.slice(0, 8000);
      if (brief?.aspectRatio) project.brief.outputSpec.aspectRatio = brief.aspectRatio;
      if (typeof brief?.burnCaptions === "boolean") project.brief.outputSpec.burnCaptions = brief.burnCaptions;
      if (brief?.captionLanguage) project.brief.outputSpec.captionLanguage = brief.captionLanguage.slice(0, 16);
      project.lifecycle = "planning";
      project.completedAt = null;
      project.error = null;
      appendActivity(project, {
        stage: "handoff",
        level: "info",
        message: "New chat request handed to Project AI",
      });
    });
    if (!updated) throw new Error("Could not update the existing project");
    return { project: updated, created: false };
  }

  const now = Date.now();
  const project: NewTabProject = {
    projectId: newProjectId(),
    owner: params.owner,
    title: brief?.title?.trim().slice(0, 160) || titleFromRequest(params.requestText),
    lifecycle: "planning",
    chatSessionId: params.sessionId,
    brief: {
      goal: brief?.goal?.trim() || params.requestText,
      clipStrategy: "exhaustive",
      editStyle: brief?.editStyle?.slice(0, 8000) || "",
      outputSpec: {
        aspectRatio: brief?.aspectRatio || "original",
        burnCaptions: Boolean(brief?.burnCaptions),
        captionLanguage: brief?.captionLanguage?.slice(0, 16) || undefined,
      },
      channelProfileId: brief?.channelProfileId?.slice(0, 128) || null,
      channelName: brief?.channelName?.slice(0, 160) || null,
      context: [params.fullContext, brief?.requirements].filter(Boolean).join("\n\nApproved requirements:\n"),
    },
    sourceVideos: incomingSources,
    clips: [],
    activity: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    error: null,
  };
  appendActivity(project, { stage: "created", level: "info", message: "Project created from chat" });
  appendActivity(project, { stage: "handoff", level: "info", message: "Complete chat context handed to Project AI" });
  return { project: await saveProject(project), created: true };
}

type PlannedClip = { label?: string; startSec?: number; endSec?: number; details?: string[] };
type ProjectPlan = {
  title?: string;
  channelName?: string;
  editStyle?: string;
  aspectRatio?: "16:9" | "9:16" | "1:1" | "original";
  burnCaptions?: boolean;
  captionLanguage?: string;
  clips?: PlannedClip[];
};

/** Best-effort background intake. Durable media execution can consume the queued clips. */
export async function runProjectIntake(projectId: string, owner: string): Promise<void> {
  const project = (await listProjects(owner)).find((item) => item.projectId === projectId);
  if (!project) return;

  try {
    await patchProject(projectId, owner, (draft) => {
      draft.lifecycle = "planning";
      appendActivity(draft, { stage: "planning", level: "info", message: "Project AI is understanding the request" });
    });

    const completion = await runNewTabCompletion({
      systemInstruction: `You are the intake and planning agent for a video-editing project. Read the complete handoff context, infer sensible defaults, and return JSON only. Do not chat with the user. Schema: {"title":string,"channelName":string,"editStyle":string,"aspectRatio":"16:9"|"9:16"|"1:1"|"original","burnCaptions":boolean,"captionLanguage":string,"clips":[{"label":string,"startSec":number,"endSec":number,"details":string[]}]}. Only include clips when timestamps are explicit or reliably present in the request.`,
      userText: project.brief.context,
    });
    const plan = JSON.parse(extractJsonBlock(completion.text)) as ProjectPlan;

    await patchProject(projectId, owner, (draft) => {
      if (plan.title?.trim()) draft.title = plan.title.trim().slice(0, 160);
      if (plan.channelName?.trim()) draft.brief.channelName = plan.channelName.trim().slice(0, 160);
      if (plan.editStyle?.trim()) draft.brief.editStyle = plan.editStyle.trim().slice(0, 8000);
      if (plan.aspectRatio) draft.brief.outputSpec.aspectRatio = plan.aspectRatio;
      if (typeof plan.burnCaptions === "boolean") draft.brief.outputSpec.burnCaptions = plan.burnCaptions;
      if (plan.captionLanguage?.trim()) draft.brief.outputSpec.captionLanguage = plan.captionLanguage.trim().slice(0, 16);

      const sourceId = draft.sourceVideos[0]?.videoId ?? "";
      const now = Date.now();
      const planned: ProjectClip[] = (plan.clips ?? []).slice(0, 200).flatMap((clip) => {
        const startSec = Number(clip.startSec);
        const endSec = Number(clip.endSec);
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return [];
        return [{
          clipId: newClipId(),
          label: clip.label?.trim().slice(0, 160) || "Planned clip",
          sourceVideoId: sourceId,
          startSec: Math.max(0, startSec),
          endSec: Math.max(0, endSec),
          details: (clip.details ?? []).slice(0, 8).map(String),
          status: "queued",
          progress: 0,
          message: "Ready for the editing worker",
          error: null,
          jobs: {},
          outputs: {},
          createdAt: now,
          updatedAt: now,
        }];
      });
      if (planned.length) draft.clips.push(...planned);
      draft.lifecycle = "running";
      appendActivity(draft, {
        stage: "planned",
        level: "info",
        message: planned.length ? `${planned.length} clip(s) planned by Project AI` : "Project AI completed intake",
      });
    });
  } catch (error) {
    await patchProject(projectId, owner, (draft) => {
      draft.lifecycle = "error";
      draft.error = error instanceof Error ? error.message : "Project AI intake failed";
      appendActivity(draft, { stage: "planning", level: "error", message: draft.error });
    });
  }
}
