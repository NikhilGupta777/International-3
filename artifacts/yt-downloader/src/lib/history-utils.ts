import { useState, useEffect, useCallback } from "react";

import {
  loadHistory as loadSubtitleHistory,
  loadActiveJob,
  type SubtitleHistoryEntry,
} from "./subtitle-history";
import {
  loadClipHistory,
  loadActiveClipJobs,
  type ClipHistoryEntry,
} from "./clip-history";
import {
  loadActiveDownload,
  loadCompletedDownloads,
  type CompletedDownloadRecord,
} from "./download-history";
import {
  loadBestClipsHistory,
  type BestClipsHistoryEntry,
} from "./best-clips-history";

export type TabMode = "download" | "clips" | "subtitles" | "clipcutter";

export type AnyEntry =
  | { kind: "subtitle"; data: SubtitleHistoryEntry }
  | { kind: "clip"; data: ClipHistoryEntry }
  | { kind: "bestclips"; data: BestClipsHistoryEntry }
  | { kind: "download"; data: CompletedDownloadRecord };

export interface ActiveEntry {
  kind: "subtitle" | "clipcutter" | "download";
  label: string;
  sub: string;
  tab: TabMode;
  startedAt: number;
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v) return `youtube.com/watch?v=${v}`;
    return u.hostname + u.pathname.slice(0, 28);
  } catch {
    return url.slice(0, 40);
  }
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function downloadSrt(filename: string, srt: string): void {
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function loadAllCompleted(): AnyEntry[] {
  const subs = loadSubtitleHistory().map((d): AnyEntry => ({ kind: "subtitle", data: d }));
  const clips = loadClipHistory().map((d): AnyEntry => ({ kind: "clip", data: d }));
  const best = loadBestClipsHistory().map((d): AnyEntry => ({ kind: "bestclips", data: d }));
  const dls = loadCompletedDownloads().map((d): AnyEntry => ({ kind: "download", data: d }));
  return [...subs, ...clips, ...best, ...dls].sort((a, b) => b.data.createdAt - a.data.createdAt);
}

export function loadAllActive(): ActiveEntry[] {
  const result: ActiveEntry[] = [];

  const sub = loadActiveJob();
  if (sub) {
    result.push({
      kind: "subtitle",
      label: "Generating subtitles…",
      sub:
        sub.mode === "url"
          ? sub.url
            ? shortUrl(sub.url)
            : "YouTube video"
          : (sub.inputFilename ?? "uploaded file"),
      tab: "subtitles",
      startedAt: sub.startedAt,
    });
  }

  for (const c of loadActiveClipJobs()) {
    result.push({
      kind: "clipcutter",
      label: `Cutting clip ${c.label}`,
      sub: shortUrl(c.url),
      tab: "clipcutter",
      startedAt: c.startedAt,
    });
  }

  const dl = loadActiveDownload();
  if (dl) {
    result.push({
      kind: "download",
      label: "Downloading video…",
      sub: shortUrl(dl.url),
      tab: "download",
      startedAt: dl.savedAt,
    });
  }

  return result.sort((a, b) => b.startedAt - a.startedAt);
}

export function useActivityHistory(pollMs = 4000) {
  const [active, setActive] = useState<ActiveEntry[]>(() => loadAllActive());
  const [completed, setCompleted] = useState<AnyEntry[]>(() => loadAllCompleted());

  const refresh = useCallback(() => {
    setActive(loadAllActive());
    setCompleted(loadAllCompleted());
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { active, completed, refresh };
}
