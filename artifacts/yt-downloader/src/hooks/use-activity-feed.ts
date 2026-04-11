import { useCallback, useEffect, useState } from "react";
import {
  loadHistory as loadSubtitleHistory,
  loadActiveJob,
  deleteFromHistory as deleteSubtitle,
  type SubtitleHistoryEntry,
} from "@/lib/subtitle-history";
import {
  loadClipHistory,
  loadActiveClipJobs,
  deleteFromClipHistory,
  type ClipHistoryEntry,
} from "@/lib/clip-history";
import {
  loadActiveDownload,
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
  const [active, setActive] = useState<ActivityActiveEntry[]>(() =>
    loadAllActive(),
  );
  const [completed, setCompleted] = useState<ActivityCompletedEntry[]>(() =>
    loadAllCompleted(),
  );

  const refresh = useCallback(() => {
    setActive(loadAllActive());
    setCompleted(loadAllCompleted());
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const deleteEntry = useCallback(
    (entry: ActivityCompletedEntry) => {
      if (entry.kind === "subtitle") deleteSubtitle(entry.data.id);
      else if (entry.kind === "clip") deleteFromClipHistory(entry.data.jobId);
      else if (entry.kind === "download")
        deleteCompletedDownload(entry.data.jobId);
      else deleteFromBestClipsHistory(entry.data.id);
      refresh();
    },
    [refresh],
  );

  const clearAll = useCallback(() => {
    loadSubtitleHistory().forEach((entry) => deleteSubtitle(entry.id));
    loadClipHistory().forEach((entry) => deleteFromClipHistory(entry.jobId));
    loadBestClipsHistory().forEach((entry) => deleteFromBestClipsHistory(entry.id));
    clearCompletedDownloads();
    refresh();
  }, [refresh]);

  return {
    active,
    completed,
    refresh,
    deleteEntry,
    clearAll,
  };
}
