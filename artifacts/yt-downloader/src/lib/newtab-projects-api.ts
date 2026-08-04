import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client for /api/newtab/projects. Types mirror
 * artifacts/api-server/src/lib/newtab-project-types.ts — keep them in sync.
 */

export type ClipStatus =
  | "queued" | "cutting" | "captioning" | "editing" | "packaging"
  | "ready" | "failed" | "needs_input" | "cancelled";

export type ProjectStatus =
  | "queued" | "planning" | "running" | "needs_input" | "ready" | "failed" | "cancelled";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "original";

export type ProjectClip = {
  clipId: string;
  label: string;
  sourceVideoId: string;
  startSec: number;
  endSec: number;
  details: string[];
  status: ClipStatus;
  progress: number;
  message: string;
  error?: string | null;
  jobs: { cut?: string | null; subtitles?: string | null; render?: string | null };
  outputs: { videoKey?: string | null; srtKey?: string | null; thumbKey?: string | null };
  seo?: { title?: string; description?: string; tags?: string[] };
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

export type ProjectBrief = {
  goal: string;
  clipStrategy: "exhaustive" | "explicit_ranges";
  explicitRanges?: Array<{ startSec: number; endSec: number; label?: string }>;
  editStyle: string;
  outputSpec: { aspectRatio: AspectRatio; burnCaptions: boolean; captionLanguage?: string };
  channelProfileId?: string | null;
  channelName?: string | null;
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
  lifecycle: string;
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
  // Derived server-side
  status: ProjectStatus;
  progress: number;
  message: string;
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

const BASE = typeof import.meta !== "undefined" ? import.meta.env.BASE_URL.replace(/\/$/, "") : "";
const API = `${BASE}/api/newtab/projects`;

const ACTIVE_STATUSES: ReadonlySet<ProjectStatus> = new Set(["queued", "planning", "running"]);

export function isProjectActive(status: ProjectStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function listProjects(signal?: AbortSignal): Promise<{ projects: NewTabProjectSummary[] }> {
  return request(API, { signal });
}

export function getProject(projectId: string, signal?: AbortSignal): Promise<{ project: NewTabProject }> {
  return request(`${API}/${projectId}`, { signal });
}

export function cancelProject(projectId: string): Promise<{ project: NewTabProject }> {
  return request(`${API}/${projectId}/cancel`, { method: "POST" });
}

export function retryClip(projectId: string, clipId: string): Promise<{ project: NewTabProject }> {
  return request(`${API}/${projectId}/clips/${clipId}/retry`, { method: "POST" });
}

export function deleteProject(projectId: string): Promise<{ ok: boolean }> {
  return request(`${API}/${projectId}`, { method: "DELETE" });
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

/**
 * Polls the project list. Backs off to a slow cadence when nothing is running and
 * pauses entirely while the tab is hidden — the same approach as use-activity-feed.
 */
export function useProjects(enabled = true) {
  const [projects, setProjects] = useState<NewTabProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  const loadedOnceRef = useRef(false);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await listProjects(controller.signal);
      setProjects(data.projects ?? []);
      setError(null);
      return data.projects ?? [];
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setError(err.message);
      return null;
    } finally {
      loadedOnceRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // Skip polling while hidden, but never the first load: a tab opened in the
      // background would otherwise sit on the loading state until it happened to
      // be foregrounded during a poll window.
      if (document.visibilityState === "hidden" && loadedOnceRef.current) {
        timerRef.current = setTimeout(tick, 8000);
        return;
      }
      const list = await refresh();
      if (cancelled) return;
      const anyActive = (list ?? []).some((project) => isProjectActive(project.status));
      timerRef.current = setTimeout(tick, anyActive ? 4000 : 20000);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const handleProjectChanged = () => { void refresh(); };
    window.addEventListener("newtab-project-changed", handleProjectChanged);
    return () => window.removeEventListener("newtab-project-changed", handleProjectChanged);
  }, [enabled, refresh]);

  // Coming back to a backgrounded tab should show current state immediately
  // rather than whatever the last poll before it was hidden had captured.
  useEffect(() => {
    if (!enabled) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [enabled, refresh]);

  return { projects, loading, error, refresh };
}

/** Live single-project state over SSE, with a polling fallback if the stream drops. */
export function useProject(projectId: string | null) {
  const [project, setProject] = useState<NewTabProject | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await getProject(projectId);
      setProject(data.project);
      setError(null);
    } catch (err) {
      if (err instanceof Error) setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setProject(null); setLoading(false); return; }
    setLoading(true);

    const source = new EventSource(`${API}/${projectId}/stream`);
    let fallback: ReturnType<typeof setInterval> | null = null;

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type: string; project?: NewTabProject };
        if (payload.type === "project" && payload.project) {
          setProject(payload.project);
          setError(null);
          setLoading(false);
        }
        if (payload.type === "deleted") setError("This project was deleted.");
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => {
      // Stream dropped (Lambda timeout, network blip) — fall back to polling.
      source.close();
      if (!fallback) fallback = setInterval(() => void refresh(), 5000);
      void refresh();
    };

    return () => {
      source.close();
      if (fallback) clearInterval(fallback);
    };
  }, [projectId, refresh]);

  return { project, loading, error, refresh, setProject };
}

// ── Formatting ─────────────────────────────────────────────────────────────────

export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
