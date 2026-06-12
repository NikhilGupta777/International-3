import { workspaceApi, type WorkspaceFile } from "@/lib/workspace-api";

export type EditorAspectRatio = "original" | "9:16" | "16:9" | "1:1";
export type EditorCropMode = "smart" | "fit-blur" | "contain";
export type EditorAssets = {
  logo?: string | null;
  intro?: string | null;
  outro?: string | null;
};

// ─── Timeline v2 types ────────────────────────────────────────────────────────
export type TransitionType = "none" | "fade" | "crossfade" | "blur" | "dip-to-black" | "wipe";
export type TransitionDef = { type: TransitionType; duration: number };

export type TimelineClip = {
  id: string;
  asset: string;
  srcIn: number;
  srcOut: number;
  tlStart: number;
  speed: number;
  transitionIn?: TransitionDef;
  transitionOut?: TransitionDef;
  colorPreset?: string;
  reverse?: boolean;
};

export type TimedOverlay = {
  id: string;
  type: "logo" | "text" | "image";
  content: string;
  tlStart: number;
  tlEnd: number;
  position: string;
  style: Record<string, any>;
};

export type AudioClip = {
  id: string;
  asset: string;
  tlStart: number;
  tlEnd: number;
  volumeDb: number;
  fadeIn: number;
  fadeOut: number;
  duckSpeech: boolean;
};

export type Timeline = {
  tracks: {
    video: TimelineClip[];
    overlays: TimedOverlay[];
    audio: AudioClip[];
  };
  export: {
    aspectRatio: EditorAspectRatio;
    resolution: string;
    cropMode: EditorCropMode;
    colorPreset: string;
  };
};

export type ProposalDiffItem = {
  action: "add" | "remove" | "modify" | "reorder";
  target: string;
  description: string;
};

export type Proposal = {
  proposalId: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  summary: string;
  diff: ProposalDiffItem[];
  timeline: Timeline;
  createdAt: number;
};

export type EditRecipe = {
  aspectRatio: EditorAspectRatio;
  cropMode: EditorCropMode;
  trim: { start: number; end: number | null };
  overlays: Array<
    | { type: "logo"; asset: string; position: "top-right" | "top-left" | "bottom-right" | "bottom-left"; widthPercent: number; key?: "none" | "auto-white" | "auto-black" }
    | { type: "text"; text: string; position: "bottom-center" | "bottom-right" | "top-left"; style: "bold-clean" | "headline" }
  >;
  intro: { enabled: boolean; asset: string | null };
  outro: { enabled: boolean; asset: string | null };
  transitions?: { fade: boolean };
  export: {
    format: "mp4";
    resolution: "1080p";
    videoCodec: "h264";
    audioCodec: "aac";
  };
};

export type EditorProject = {
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceVideo: string | null;
  assets: EditorAssets;
  prompt: string;
  recipe: EditRecipe;
  timeline?: Timeline | null;
  proposals?: Proposal[];
  version?: number;
  renders: EditorJobSummary[];
};

export type EditorJobSummary = {
  jobId: string;
  kind: "preview" | "final";
  status: "pending" | "running" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  outputPath: string | null;
  createdAt: number;
  completedAt: number | null;
};

async function req<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data as T;
}

export type EditorProjectSummary = {
  projectId: string;
  title: string;
  updatedAt: number;
  sourceVideo: string | null;
};

export const videoEditorApi = {
  listProjects: () =>
    req<{ projects: EditorProjectSummary[] }>("/api/video-editor/projects"),

  createProject: (body: { title?: string; prompt?: string; sourceVideo?: string | null; assets?: EditorAssets }) =>
    req<{ project: EditorProject }>("/api/video-editor/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getProject: (projectId: string) =>
    req<{ project: EditorProject }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}`),

  deleteProject: (projectId: string) =>
    req<{ ok: boolean }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),

  generateRecipe: (projectId: string, body: { prompt: string; sourceVideo?: string | null; assets?: EditorAssets }) =>
    req<{ project: EditorProject; message: string }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}/agent`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  startPreview: (projectId: string) =>
    req<{ project: EditorProject; job: EditorJobSummary }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}/preview`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  startRender: (projectId: string) =>
    req<{ project: EditorProject; job: EditorJobSummary }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}/render`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  getJob: (jobId: string) =>
    req<{ job: EditorJobSummary }>(`/api/video-editor/jobs/${encodeURIComponent(jobId)}`),

  uploadAsset: async (projectId: string, role: "source" | "logo" | "intro" | "outro", file: File): Promise<WorkspaceFile> => {
    const safeName = file.name.replace(/[^\w.\-() ]+/g, "_").slice(-120) || `${role}.bin`;
    return workspaceApi.uploadFile(`editor/uploads/${projectId}/${role}/${safeName}`, file);
  },

  patchRecipe: (projectId: string, recipe: Partial<EditRecipe>) =>
    req<{ project: EditorProject }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}/recipe`, {
      method: "PATCH",
      body: JSON.stringify({ recipe }),
    }),

  getChat: (projectId: string) =>
    req<{ messages: EditorChatMessage[] }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}/chat`),

  streamChat: (projectId: string, message: string, handlers: EditorChatHandlers): { cancel: () => void } => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const resp = await fetch(`/api/video-editor/projects/${encodeURIComponent(projectId)}/chat`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ message }),
          signal: ctrl.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`${resp.status} ${resp.statusText}`);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let parseErrorReported = false;
        let sawDone = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const event = JSON.parse(raw);
              if (event?.type === "done") sawDone = true;
              handlers.onEvent(event);
            } catch (err) {
              console.warn("[video-editor] malformed SSE frame", {
                error: err instanceof Error ? err.message : String(err),
                preview: raw.slice(0, 200),
              });
              parseErrorReported = true;
            }
          }
        }
        if (parseErrorReported && !sawDone) {
          handlers.onEvent({
            type: "error",
            message: "The response stream ended with an incomplete update. Please retry if anything looks missing.",
          });
        }
        handlers.onClose?.();
      } catch (err) {
        if ((err as any)?.name === "AbortError") return;
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return { cancel: () => ctrl.abort() };
  },

  applyProposal: (projectId: string, proposalId: string) =>
    req<{ project: EditorProject; proposal: Proposal }>(
      `/api/video-editor/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  rejectProposal: (projectId: string, proposalId: string) =>
    req<{ project: EditorProject; proposal: Proposal }>(
      `/api/video-editor/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  getProposals: (projectId: string) =>
    req<{ proposals: Proposal[] }>(
      `/api/video-editor/projects/${encodeURIComponent(projectId)}/proposals`
    ),
};

export type EditorChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool?: { name: string; args?: any; result?: any };
  createdAt: number;
};

export type EditorChatEvent =
  | { type: "run_start"; runId: string }
  | { type: "heartbeat"; ts: number }
  | { type: "thinking"; iteration: number; total: number }
  | { type: "project"; project: EditorProject }
  | { type: "user_message"; message: EditorChatMessage }
  | { type: "assistant_message"; message: EditorChatMessage }
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; args: any; toolCallId?: string }
  | { type: "tool_progress"; name: string; message?: string; percent?: number }
  | { type: "tool_done"; name: string; ok: boolean; message?: string; error?: string; project?: EditorProject; job?: EditorJobSummary; toolCallId?: string }
  | { type: "proposal"; proposalId: string; summary: string; diff: ProposalDiffItem[]; timeline: Timeline; duration: number }
  | { type: "proposal_applied"; proposalId: string }
  | { type: "proposal_rejected"; proposalId: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type EditorChatHandlers = {
  onEvent: (event: EditorChatEvent) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
};
