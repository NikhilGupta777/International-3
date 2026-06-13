import type { EditorJobSummary } from "@/lib/video-editor-api";

const ACTIVE_KEY = "videomaking_active_video_studio_renders";
const HISTORY_KEY = "videomaking_video_studio_render_history";
const MAX_HISTORY = 30;

export type ActiveVideoStudioRender = {
  projectId: string;
  jobId: string;
  title: string;
  kind: "preview" | "final";
  startedAt: number;
  progress: number;
  status: EditorJobSummary["status"];
  message: string;
};

export type VideoStudioRenderHistoryEntry = {
  projectId: string;
  jobId: string;
  title: string;
  kind: "preview" | "final";
  createdAt: number;
  outputPath: string | null;
};

export function loadActiveVideoStudioRenders(): ActiveVideoStudioRender[] {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveActiveVideoStudioRenders(jobs: ActiveVideoStudioRender[]): void {
  try {
    if (jobs.length === 0) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, JSON.stringify(jobs));
  } catch {
    /* ignore */
  }
}

export function upsertActiveVideoStudioRender(render: ActiveVideoStudioRender): void {
  const existing = loadActiveVideoStudioRenders();
  const next = [render, ...existing.filter((job) => job.jobId !== render.jobId)].slice(0, 10);
  saveActiveVideoStudioRenders(next);
}

export function removeActiveVideoStudioRender(jobId: string): void {
  saveActiveVideoStudioRenders(loadActiveVideoStudioRenders().filter((job) => job.jobId !== jobId));
}

export function loadVideoStudioRenderHistory(): VideoStudioRenderHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVideoStudioRenderHistory(entry: VideoStudioRenderHistoryEntry): void {
  try {
    const existing = loadVideoStudioRenderHistory();
    const next = [entry, ...existing.filter((item) => item.jobId !== entry.jobId)].slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function deleteVideoStudioRenderHistory(jobId: string): void {
  try {
    const next = loadVideoStudioRenderHistory().filter((item) => item.jobId !== jobId);
    if (next.length === 0) localStorage.removeItem(HISTORY_KEY);
    else localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function clearVideoStudioRenderHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
