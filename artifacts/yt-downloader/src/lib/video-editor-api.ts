import { workspaceApi, type WorkspaceFile } from "@/lib/workspace-api";

export type EditorAspectRatio = "original" | "9:16" | "16:9" | "1:1";
export type EditorCropMode = "smart" | "fit-blur" | "contain";
export type EditorAssets = {
  logo?: string | null;
  intro?: string | null;
  outro?: string | null;
};

export type EditRecipe = {
  aspectRatio: EditorAspectRatio;
  cropMode: EditorCropMode;
  trim: { start: number; end: number | null };
  overlays: Array<
    | { type: "logo"; asset: string; position: "top-right" | "top-left" | "bottom-right" | "bottom-left"; widthPercent: number }
    | { type: "text"; text: string; position: "bottom-center" | "bottom-right" | "top-left"; style: "bold-clean" | "headline" }
  >;
  intro: { enabled: boolean; asset: string | null };
  outro: { enabled: boolean; asset: string | null };
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

export const videoEditorApi = {
  createProject: (body: { title?: string; prompt?: string; sourceVideo?: string | null; assets?: EditorAssets }) =>
    req<{ project: EditorProject }>("/api/video-editor/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getProject: (projectId: string) =>
    req<{ project: EditorProject }>(`/api/video-editor/projects/${encodeURIComponent(projectId)}`),

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
};
