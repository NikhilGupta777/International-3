import { useCallback, useEffect, useState } from "react";
import {
  loadHistory as loadSubtitleHistory,
  loadActiveJob,
  clearActiveJob,
  deleteFromHistory as deleteSubtitle,
  type SubtitleHistoryEntry,
} from "@/lib/subtitle-history";
import {
  loadClipHistory,
  loadActiveClipJobs,
  saveActiveClipJobs,
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

export type ActivityTabMode = "download" | "clips" | "subtitles" | "clipcutter";

export type ActivityCompletedEntry =
  | { kind: "subtitle"; data: SubtitleHistoryEntry }
  | { kind: "clip"; data: ClipHistoryEntry }
  | { kind: "bestclips"; data: BestClipsHistoryEntry }
  | { kind: "download"; data: CompletedDownloadRecord };

export interface ActivityActiveEntry {
  kind: "subtitle" | "clipcutter" | "download";
  label: string;
  sub: string;
  tab: ActivityTabMode;
  startedAt: number;
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
  return [...subtitles, ...clips, ...bestClips, ...downloads].sort(
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

  return active.sort((a, b) => b.startedAt - a.startedAt);
}

export function useActivityFeed(pollMs = 4000) {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [active, setActive] = useState<ActivityActiveEntry[]>(() =>
    loadAllActive(),
  );
  const [completed, setCompleted] = useState<ActivityCompletedEntry[]>(() =>
    loadAllCompleted(),
  );

  const syncActiveWithServer = useCallback(async () => {
    const subtitleJob = loadActiveJob();
    if (subtitleJob) {
      try {
        const res = await fetch(
          `${BASE}/api/subtitles/status/${encodeURIComponent(subtitleJob.jobId)}`,
        );
        if (res.status === 404) {
          clearActiveJob();
        } else if (res.ok) {
          const data = (await res.json()) as { status?: string };
          if (
            data.status === "done" ||
            data.status === "error" ||
            data.status === "cancelled"
          ) {
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
            continue;
          }
          if (!res.ok) {
            kept.push(job);
            continue;
          }
          const data = (await res.json()) as { status?: string };
          const status = data.status;
          if (
            status === "done" ||
            status === "error" ||
            status === "cancelled" ||
            status === "expired"
          ) {
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
          clearActiveDownload();
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
  }, [BASE]);

  const refresh = useCallback(async () => {
    await syncActiveWithServer();
    setActive(loadAllActive());
    setCompleted(loadAllCompleted());
  }, [syncActiveWithServer]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const deleteEntry = useCallback(
    (entry: ActivityCompletedEntry) => {
      if (entry.kind === "subtitle") deleteSubtitle(entry.data.id);
      else if (entry.kind === "clip") deleteFromClipHistory(entry.data.jobId);
      else if (entry.kind === "download")
        deleteCompletedDownload(entry.data.jobId);
      else deleteFromBestClipsHistory(entry.data.id);
      void refresh();
    },
    [refresh],
  );

  const clearAll = useCallback(() => {
    loadSubtitleHistory().forEach((entry) => deleteSubtitle(entry.id));
    loadClipHistory().forEach((entry) => deleteFromClipHistory(entry.jobId));
    loadBestClipsHistory().forEach((entry) => deleteFromBestClipsHistory(entry.id));
    clearCompletedDownloads();
    void refresh();
  }, [refresh]);

  return {
    active,
    completed,
    refresh,
    deleteEntry,
    clearAll,
  };
}
