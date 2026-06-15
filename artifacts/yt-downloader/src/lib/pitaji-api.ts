// Frontend API helpers for the Pita Ji workspace. Kept tiny and dependency-free
// so it can be imported anywhere without pulling in the existing api-client.
//
// All requests go to /api/pitaji/* and rely on the pitaji_auth signed cookie
// (set on successful POST /api/pitaji/auth) — that cookie is independent from
// the main Narayan Bhakt auth cookie.

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
  speakers: Array<{ id: string; label: string; s3Key: string; uploadedAt: number; url?: string | null }>;
  references: Array<{ id: string; s3Key: string; uploadedAt: number; url?: string | null }>;
  updatedAt: number;
};

export async function getPitajiSettings(): Promise<PitajiSettings> {
  return request<PitajiSettings>("/api/pitaji/settings");
}

export async function savePitajiSettings(data: {
  thumbnailPrompt?: string;
  clipInstructions?: string;
}): Promise<{ ok: boolean }> {
  return request("/api/pitaji/settings", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function uploadSpeakerImage(
  label: string,
  dataUrl: string,
): Promise<{ ok: boolean; speaker: { id: string; label: string; s3Key: string } }> {
  return request("/api/pitaji/settings/speaker", {
    method: "POST",
    body: JSON.stringify({ label, dataUrl }),
  });
}

export async function deleteSpeakerImage(id: string): Promise<{ ok: boolean }> {
  return request(`/api/pitaji/settings/speaker/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function uploadReferenceImage(
  dataUrl: string,
): Promise<{ ok: boolean; reference: { id: string; s3Key: string } }> {
  return request("/api/pitaji/settings/reference", {
    method: "POST",
    body: JSON.stringify({ dataUrl }),
  });
}

export async function deleteReferenceImage(id: string): Promise<{ ok: boolean }> {
  return request(`/api/pitaji/settings/reference/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export type PitajiClipDetail = {
  dispatch: PitajiDispatchView;
  cutProgress: {
    status?: string;
    message?: string | null;
    progressPct?: number | null;
    s3Key?: string | null;
    filename?: string | null;
  } | null;
  cutDownloadUrl: string | null;
  thumbnailUrl: string | null;
};

export async function getPitajiClipDetail(pjcId: string): Promise<PitajiClipDetail> {
  return request<PitajiClipDetail>(`/api/pitaji/clips/${encodeURIComponent(pjcId)}`);
}

export async function getPitajiJob(jobId: string): Promise<{
  job: {
    jobId: string;
    status: string;
    youtubeUrl: string;
    videoId?: string;
    videoTitle?: string;
    durationSec?: number;
    channel?: string;
    pipelineMode?: string;
    chunks?: number;
    clips: PitajiClip[];
    error?: string;
    createdAt: number;
    updatedAt: number;
  };
  dispatches: PitajiDispatchView[];
}> {
  return request(`/api/pitaji/jobs/${encodeURIComponent(jobId)}`);
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
  dispatchedCount?: number;
  cutReadyCount?: number;
  thumbnailReadyCount?: number;
  activeDispatchCount?: number;
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
  | { type: "stage"; stage: string; chunk?: number; total?: number; percent?: number }
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
    // Let callers distinguish user aborts (AbortError) from other failures.
    throw err;
  }
}


// ── Dispatch (Phase 4) ──────────────────────────────────────────────────────

export type PitajiDispatchAction = "cut" | "thumbnail" | "both";

export type PitajiDispatched = {
  pitajiClipId: string;
  clipId: string;
  cutChildJobId?: string;
  cutError?: string;
  reused?: boolean;
};

export async function dispatchPitajiClips(
  jobId: string,
  clipIds: string[],
  action: PitajiDispatchAction,
): Promise<{ ok: boolean; dispatched: PitajiDispatched[] }> {
  return request(`/api/pitaji/jobs/${encodeURIComponent(jobId)}/dispatch`, {
    method: "POST",
    body: JSON.stringify({ clipIds, action }),
  });
}

export type PitajiDispatchView = {
  jobId: string;
  parentJobId: string;
  action: PitajiDispatchAction;
  status: string;
  cutStatus?: string;
  clip: PitajiClip;
  cutChildJobId?: string;
  cutS3Key?: string;
  cutFilename?: string;
  thumbnailStatus?: string;
  thumbnailChildJobId?: string;
  thumbnailS3Key?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  cutProgress?: {
    status?: string;
    message?: string | null;
    progressPct?: number | null;
    s3Key?: string | null;
    filename?: string | null;
  } | null;
};

export function pitajiDispatchHasCut(d: PitajiDispatchView): boolean {
  return d.action === "cut" || d.action === "both";
}

export function pitajiDispatchCutStatus(d: PitajiDispatchView): string | null {
  if (!pitajiDispatchHasCut(d)) return null;
  if (d.cutStatus && d.cutStatus !== "not-requested") return d.cutStatus;
  if (d.cutProgress?.status) return d.cutProgress.status;
  if (d.cutS3Key || d.cutProgress?.s3Key) return "done";
  if (d.status === "error") return "error";
  return d.status || "queued";
}

export function pitajiDispatchCutReady(d: PitajiDispatchView): boolean {
  return pitajiDispatchHasCut(d) && (
    d.cutProgress?.status === "done" ||
    Boolean(d.cutS3Key || d.cutProgress?.s3Key)
  );
}

export function pitajiDispatchThumbnailReady(d: PitajiDispatchView): boolean {
  return d.thumbnailStatus === "done" || Boolean(d.thumbnailS3Key);
}

export async function listPitajiDispatches(
  jobId: string,
): Promise<{ dispatches: PitajiDispatchView[] }> {
  return request<{ dispatches: PitajiDispatchView[] }>(
    `/api/pitaji/jobs/${encodeURIComponent(jobId)}/dispatches`,
  );
}

// ── Refine SSE (Phase 4) ────────────────────────────────────────────────────

export type PitajiRefineEvent =
  | { type: "run_start"; jobId: string; ts?: number }
  | { type: "text"; message: string }
  | { type: "clips_replaced"; total: number }
  | { type: "clip"; clip: PitajiClip }
  | { type: "summary"; totalClips: number; jobId: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type PitajiRefineOptions = {
  jobId: string;
  message: string;
  signal?: AbortSignal;
  onEvent: (evt: PitajiRefineEvent) => void;
};

export async function streamPitajiRefine(opts: PitajiRefineOptions): Promise<void> {
  const res = await fetch(
    `${BASE}/api/pitaji/jobs/${encodeURIComponent(opts.jobId)}/refine`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message: opts.message }),
      signal: opts.signal,
    },
  );
  if (!res.ok || !res.body) {
    let m = `Request failed (${res.status})`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d?.error) m = d.error;
    } catch { /* ignore */ }
    throw new Error(m);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleFrame = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^\s/, ""))
      .join("\n")
      .trim();
    if (!data) return;
    try {
      const evt = JSON.parse(data) as PitajiRefineEvent;
      opts.onEvent(evt);
    } catch {
      /* swallow malformed frame */
    }
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
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
