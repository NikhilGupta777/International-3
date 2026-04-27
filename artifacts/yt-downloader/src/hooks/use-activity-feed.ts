import { useCallback, useEffect, useState } from "react";
import {
  loadHistory as loadSubtitleHistory,
  loadActiveJob,
  clearActiveJob,
  saveToHistory as saveSubtitleHistory,
  deleteFromHistory as deleteSubtitle,
  type SubtitleHistoryEntry,
} from "@/lib/subtitle-history";
import {
  loadClipHistory,
  loadActiveClipJobs,
  saveActiveClipJobs,
  saveToClipHistory,
  deleteFromClipHistory,
  type ClipHistoryEntry,
} from "@/lib/clip-history";
import {
  loadActiveDownload,
  clearActiveDownload,
  loadCompletedDownloads,
  deleteCompletedDownload,
  clearCompletedDownloads,
  type CompletedDownloadRecord,
} from "@/lib/download-history";
import {
  loadBestClipsHistory,
  deleteFromBestClipsHistory,
  type BestClipsHistoryEntry,
} from "@/lib/best-clips-history";
import {
  loadActiveTranslatorJobs,
  saveActiveTranslatorJobs,
  loadTranslatorHistory,
  saveTranslatorHistory,
  deleteTranslatorHistory,
  clearTranslatorHistory,
  type TranslatorHistoryEntry,
} from "@/lib/translator-history";
import { translatorAuthHeaders } from "@/lib/translator-client-id";

export type ActivityTabMode = "download" | "clips" | "subtitles" | "clipcutter" | "translator";

export type ActivityCompletedEntry =
  | { kind: "subtitle"; data: SubtitleHistoryEntry }
  | { kind: "clip"; data: ClipHistoryEntry }
  | { kind: "bestclips"; data: BestClipsHistoryEntry }
  | { kind: "download"; data: CompletedDownloadRecord }
  | { kind: "translator"; data: TranslatorHistoryEntry };

export interface ActivityActiveEntry {
  kind: "subtitle" | "clipcutter" | "download" | "translator";
  label: string;
  sub: string;
  tab: ActivityTabMode;
  startedAt: number;
  progress?: number;
}

interface ActivitySnapshot {
  active: ActivityActiveEntry[];
  completed: ActivityCompletedEntry[];
}

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const listeners = new Set<(snapshot: ActivitySnapshot) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollMsActive: number | null = null;
let refreshInFlight: Promise<void> | null = null;
const QUEUE_MISSING_GRACE_MS = 15 * 60 * 1000;

function emit(snapshot: ActivitySnapshot) {
  for (const listener of listeners) listener(snapshot);
}

export function shortActivityUrl(url: string): string {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v) return `youtube.com/watch?v=${v}`;
    return u.hostname + u.pathname.slice(0, 28);
  } catch {
    return url.slice(0, 40);
  }
}

function loadAllCompleted(): ActivityCompletedEntry[] {
  const subtitles = loadSubtitleHistory().map(
    (data): ActivityCompletedEntry => ({ kind: "subtitle", data }),
  );
  const clips = loadClipHistory().map(
    (data): ActivityCompletedEntry => ({ kind: "clip", data }),
  );
  const bestClips = loadBestClipsHistory().map(
    (data): ActivityCompletedEntry => ({ kind: "bestclips", data }),
  );
  const downloads = loadCompletedDownloads().map(
    (data): ActivityCompletedEntry => ({ kind: "download", data }),
  );
  const translations = loadTranslatorHistory().map(
    (data): ActivityCompletedEntry => ({ kind: "translator", data }),
  );
  return [...subtitles, ...clips, ...bestClips, ...downloads, ...translations].sort(
    (a, b) => b.data.createdAt - a.data.createdAt,
  );
}

function loadAllActive(): ActivityActiveEntry[] {
  const active: ActivityActiveEntry[] = [];

  const subtitleJob = loadActiveJob();
  if (subtitleJob) {
    active.push({
      kind: "subtitle",
      label: "Generating subtitles",
      sub:
        subtitleJob.mode === "url"
          ? subtitleJob.url
            ? shortActivityUrl(subtitleJob.url)
            : "YouTube video"
          : subtitleJob.inputFilename ?? "uploaded file",
      tab: "subtitles",
      startedAt: subtitleJob.startedAt,
    });
  }

  for (const clipJob of loadActiveClipJobs()) {
    active.push({
      kind: "clipcutter",
      label: `Cutting clip ${clipJob.label}`,
      sub: shortActivityUrl(clipJob.url),
      tab: "clipcutter",
      startedAt: clipJob.startedAt,
    });
  }

  const downloadJob = loadActiveDownload();
  if (downloadJob) {
    active.push({
      kind: "download",
      label: "Downloading video",
      sub: shortActivityUrl(downloadJob.url),
      tab: "download",
      startedAt: downloadJob.savedAt,
    });
  }

  for (const translatorJob of loadActiveTranslatorJobs()) {
    active.push({
      kind: "translator",
      label: `Translating ${translatorJob.progress}%`,
      sub: translatorJob.filename,
      tab: "translator",
      startedAt: translatorJob.startedAt,
      progress: translatorJob.progress,
    });
  }

  return active.sort((a, b) => b.startedAt - a.startedAt);
}

let currentSnapshot: ActivitySnapshot = {
  active: loadAllActive(),
  completed: loadAllCompleted(),
};

async function syncActiveWithServer() {
  const subtitleJob = loadActiveJob();
  if (subtitleJob) {
    try {
      const res = await fetch(
        `${BASE}/api/subtitles/status/${encodeURIComponent(subtitleJob.jobId)}`,
      );
      if (res.status === 404) {
        clearActiveJob();
      } else if (res.ok) {
        const data = (await res.json()) as {
          status?: string;
          srt?: string;
          filename?: string;
          originalSrt?: string;
          originalFilename?: string;
        };
        if (
          data.status === "done" ||
          data.status === "error" ||
          data.status === "cancelled"
        ) {
          if (data.status === "done" && data.srt) {
            const entry: SubtitleHistoryEntry = {
              id: subtitleJob.jobId,
              createdAt: Date.now(),
              mode: subtitleJob.mode,
              url: subtitleJob.mode === "url" ? subtitleJob.url : undefined,
              inputFilename:
                subtitleJob.mode === "file"
                  ? subtitleJob.inputFilename
                  : undefined,
              srtFilename: data.filename ?? "subtitles.srt",
              language: subtitleJob.language,
              translateTo: subtitleJob.translateTo,
              srt: data.srt,
              originalSrt: data.originalSrt,
              originalFilename: data.originalFilename,
              entryCount: data.srt
                .trim()
                .split(/\n\n+/)
                .filter(Boolean).length,
            };
            saveSubtitleHistory(entry);
          }
          clearActiveJob();
        }
      }
    } catch {}
  }

  const clipJobs = loadActiveClipJobs();
  if (clipJobs.length > 0) {
    const kept = [] as typeof clipJobs;
    for (const job of clipJobs) {
      try {
        const res = await fetch(
          `${BASE}/api/youtube/progress/${encodeURIComponent(job.jobId)}`,
        );
        if (res.status === 404) {
          // Queue-backed jobs can briefly return 404 during propagation/restarts.
          // Keep recent jobs so they don't disappear from UI/activity on refresh.
          if (Date.now() - job.startedAt < QUEUE_MISSING_GRACE_MS) {
            kept.push(job);
          }
          continue;
        }
        if (!res.ok) {
          kept.push(job);
          continue;
        }
        const data = (await res.json()) as {
          status?: string;
          filename?: string | null;
          filesize?: number | null;
        };
        const status = data.status;
        if (
          status === "done" ||
          status === "error" ||
          status === "cancelled" ||
          status === "expired"
        ) {
          if (status === "done") {
            saveToClipHistory({
              jobId: job.jobId,
              createdAt: Date.now(),
              label: job.label,
              url: job.url,
              quality: job.quality,
              filename: data.filename ?? "clip.mp4",
              filesize: data.filesize ?? null,
              durationSecs: Math.max(1, job.endSecs - job.startSecs),
            });
          }
          continue;
        }
        kept.push(job);
      } catch {
        kept.push(job);
      }
    }
    if (kept.length !== clipJobs.length) {
      saveActiveClipJobs(kept);
    }
  }

  const downloadJob = loadActiveDownload();
  if (downloadJob) {
    try {
      const res = await fetch(
        `${BASE}/api/youtube/progress/${encodeURIComponent(downloadJob.jobId)}`,
      );
      if (res.status === 404) {
        if (Date.now() - downloadJob.savedAt >= QUEUE_MISSING_GRACE_MS) {
          clearActiveDownload();
        }
      } else if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (
          data.status === "done" ||
          data.status === "error" ||
          data.status === "cancelled" ||
          data.status === "expired"
        ) {
          clearActiveDownload();
        }
      }
    } catch {}
  }

  const translatorJobs = loadActiveTranslatorJobs();
  if (translatorJobs.length > 0) {
    const kept = [] as typeof translatorJobs;
    for (const job of translatorJobs) {
      try {
        const res = await fetch(
          `${BASE}/api/translator/status/${encodeURIComponent(job.jobId)}`,
          { headers: translatorAuthHeaders() },
        );
        if (res.status === 404) {
          if (Date.now() - job.startedAt < QUEUE_MISSING_GRACE_MS) kept.push(job);
          continue;
        }
        if (!res.ok) {
          kept.push(job);
          continue;
        }
        const data = (await res.json()) as {
          status?: string;
          progress?: number;
          step?: string;
          filename?: string;
          targetLang?: string;
          targetLangCode?: string;
          sourceLang?: string;
          segmentCount?: number;
          createdAt?: number | string;
        };
        const status = data.status ?? job.status;
        if (status === "DONE") {
          let urls: Partial<TranslatorHistoryEntry> = {};
          try {
            const result = await fetch(
              `${BASE}/api/translator/result/${encodeURIComponent(job.jobId)}`,
              { headers: translatorAuthHeaders() },
            );
            if (result.ok) urls = await result.json();
          } catch {}
          saveTranslatorHistory({
            jobId: job.jobId,
            createdAt: typeof data.createdAt === "number" ? data.createdAt : job.startedAt,
            filename: data.filename ?? job.filename,
            targetLang: data.targetLang ?? job.targetLang,
            targetLangCode: data.targetLangCode ?? job.targetLangCode,
            sourceLang: data.sourceLang ?? job.sourceLang,
            progress: 100,
            segmentCount: data.segmentCount,
            ...urls,
          });
          continue;
        }
        if (status === "FAILED" || status === "CANCELLED" || status === "EXPIRED") {
          continue;
        }
        kept.push({
          ...job,
          status,
          progress: data.progress ?? job.progress,
          step: data.step ?? job.step,
        });
      } catch {
        kept.push(job);
      }
    }
    saveActiveTranslatorJobs(kept);
  }
}

async function refreshShared() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    await syncActiveWithServer();
    currentSnapshot = {
      active: loadAllActive(),
      completed: loadAllCompleted(),
    };
    emit(currentSnapshot);
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

function ensurePolling(pollMs: number) {
  if (pollTimer && pollMsActive !== null && pollMs >= pollMsActive) return;
  if (pollTimer) clearInterval(pollTimer);

  pollMsActive = pollMs;
  pollTimer = setInterval(() => {
    void refreshShared();
  }, pollMs);
}

function stopPollingIfUnused() {
  if (listeners.size > 0) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollMsActive = null;
}

export function useActivityFeed(pollMs = 4000) {
  const [active, setActive] = useState<ActivityActiveEntry[]>(
    () => currentSnapshot.active,
  );
  const [completed, setCompleted] = useState<ActivityCompletedEntry[]>(
    () => currentSnapshot.completed,
  );

  useEffect(() => {
    const listener = (snapshot: ActivitySnapshot) => {
      setActive(snapshot.active);
      setCompleted(snapshot.completed);
    };
    listeners.add(listener);
    ensurePolling(pollMs);
    void refreshShared();

    return () => {
      listeners.delete(listener);
      stopPollingIfUnused();
    };
  }, [pollMs]);

  const refresh = useCallback(async () => {
    await refreshShared();
  }, []);

  const deleteEntry = useCallback(async (entry: ActivityCompletedEntry) => {
    if (entry.kind === "subtitle") deleteSubtitle(entry.data.id);
    else if (entry.kind === "clip") deleteFromClipHistory(entry.data.jobId);
    else if (entry.kind === "download")
      deleteCompletedDownload(entry.data.jobId);
    else if (entry.kind === "translator")
      deleteTranslatorHistory(entry.data.jobId);
    else deleteFromBestClipsHistory(entry.data.id);
    await refreshShared();
  }, []);

  const clearAll = useCallback(async () => {
    loadSubtitleHistory().forEach((entry) => deleteSubtitle(entry.id));
    loadClipHistory().forEach((entry) => deleteFromClipHistory(entry.jobId));
    loadBestClipsHistory().forEach((entry) =>
      deleteFromBestClipsHistory(entry.id),
    );
    clearTranslatorHistory();
    clearCompletedDownloads();
    await refreshShared();
  }, []);

  return {
    active,
    completed,
    refresh,
    deleteEntry,
    clearAll,
  };
}
