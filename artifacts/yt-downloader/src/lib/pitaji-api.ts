// Frontend API helpers for the Pita Ji workspace. Kept tiny and dependency-free
// so it can be imported anywhere without pulling in the existing api-client.
//
// All requests go to /api/pitaji/* and rely on the pitaji_auth signed cookie
// (set on successful POST /api/pitaji/auth) — that cookie is independent from
// the main videomaking_auth cookie.

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export type PitajiSessionResp = {
  authenticated: boolean;
  user: { username: string } | null;
  features?: { configured?: boolean };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* swallow */
    }
    throw new Error(message);
  }
  // Some endpoints (logout) may return text; tolerate that.
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return undefined as unknown as T;
}

export async function getPitajiSession(): Promise<PitajiSessionResp> {
  return request<PitajiSessionResp>("/api/pitaji/session");
}

export async function loginPitaji(username: string, password: string): Promise<{ ok: boolean; user: { username: string } }> {
  return request("/api/pitaji/auth", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function logoutPitaji(): Promise<void> {
  await request("/api/pitaji/auth/logout", { method: "POST" });
}

export type PitajiSettings = {
  thumbnailPrompt: string;
  clipInstructions: string;
  speakers: Array<{ id: string; label: string; s3Key: string; uploadedAt: number }>;
  references: Array<{ id: string; s3Key: string; uploadedAt: number }>;
  updatedAt: number;
};

export async function getPitajiSettings(): Promise<PitajiSettings> {
  return request<PitajiSettings>("/api/pitaji/settings");
}

export type PitajiJobSummary = {
  jobId: string;
  status: string;
  youtubeUrl: string;
  videoId?: string;
  videoTitle?: string;
  durationSec?: number;
  channel?: string;
  pipelineMode?: "youtube_direct" | "audio_split";
  chunks?: number;
  clipCount: number;
  createdAt: number;
  updatedAt: number;
};

export async function listPitajiJobs(limit = 50): Promise<{ jobs: PitajiJobSummary[] }> {
  return request<{ jobs: PitajiJobSummary[] }>(`/api/pitaji/jobs?limit=${limit}`);
}

// ── Analyze SSE stream ──────────────────────────────────────────────────────

export type PitajiClip = {
  id: string;
  kind: "topic" | "qna";
  title: string;
  summary: string;
  question?: string;
  answer?: string;
  startSec: number;
  endSec: number;
  speakerHint?: string;
  suggestedTitle?: string;
  description?: string;
  hashtags?: string[];
  pinnedComment?: string;
};

export type PitajiAnalyzeEvent =
  | { type: "run_start"; jobId: string; ts?: number }
  | { type: "meta"; videoId?: string; videoTitle: string | null; durationSec: number | null; channel: string | null }
  | {
      type: "pipeline_choice";
      mode: "youtube_direct" | "audio_split";
      overThreshold?: boolean;
      thresholdMin?: number;
      chunks?: number;
    }
  | { type: "stage"; stage: string; chunk?: number; percent?: number }
  | { type: "warning"; message: string }
  | { type: "thinking"; message: string }
  | { type: "clip"; clip: PitajiClip }
  | { type: "summary"; totalClips: number; jobId: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type PitajiAnalyzeOptions = {
  youtubeUrl: string;
  signal?: AbortSignal;
  onEvent: (evt: PitajiAnalyzeEvent) => void;
};

/**
 * POST /api/pitaji/analyze with SSE streaming. Reads the response body as a
 * `text/event-stream` and dispatches each `data: { ... }` frame to onEvent.
 * Returns when the stream ends or is aborted.
 */
export async function streamPitajiAnalyze(opts: PitajiAnalyzeOptions): Promise<void> {
  const res = await fetch(`${BASE}/api/pitaji/analyze`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ youtubeUrl: opts.youtubeUrl }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* swallow */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleFrame = (frame: string): void => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^\s/, ""))
      .join("\n")
      .trim();
    if (!dataLines) return;
    try {
      const evt = JSON.parse(dataLines) as PitajiAnalyzeEvent;
      opts.onEvent(evt);
    } catch {
      // Comments / heartbeat lines / partial JSON — ignore.
    }
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE frames are separated by a blank line (\n\n).
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleFrame(frame);
      }
    }
    if (buffer.trim().length > 0) handleFrame(buffer);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  }
}
