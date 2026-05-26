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
