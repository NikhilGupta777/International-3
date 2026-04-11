import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  History, Captions, Scissors, Sparkles, Trash2, Download,
  Copy, ChevronDown, ChevronUp, Clock, X, ExternalLink,
  Loader2, ArrowRight, Film,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

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
  formatFilesize,
  type ClipHistoryEntry,
  type ActiveClipJob,
} from "@/lib/clip-history";
import {
  loadActiveDownload,
  loadCompletedDownloads,
  deleteCompletedDownload,
  clearCompletedDownloads,
  isDownloadExpired,
  type ActiveDownloadRecord,
  type CompletedDownloadRecord,
} from "@/lib/download-history";
import {
  loadBestClipsHistory,
  deleteFromBestClipsHistory,
  type BestClipsHistoryEntry,
} from "@/lib/best-clips-history";
import { useActivityFeed } from "@/hooks/use-activity-feed";

type TabMode = "download" | "clips" | "subtitles" | "clipcutter";

// ── Unified completed-entry type ─────────────────────────────────────────────

type AnyEntry =
  | { kind: "subtitle"; data: SubtitleHistoryEntry }
  | { kind: "clip"; data: ClipHistoryEntry }
  | { kind: "bestclips"; data: BestClipsHistoryEntry }
  | { kind: "download"; data: CompletedDownloadRecord };

function loadAll(): AnyEntry[] {
  const subs = loadSubtitleHistory().map((d): AnyEntry => ({ kind: "subtitle", data: d }));
  const clips = loadClipHistory().map((d): AnyEntry => ({ kind: "clip", data: d }));
  const best = loadBestClipsHistory().map((d): AnyEntry => ({ kind: "bestclips", data: d }));
  const dls = loadCompletedDownloads().map((d): AnyEntry => ({ kind: "download", data: d }));
  return [...subs, ...clips, ...best, ...dls].sort((a, b) => {
    const ta = a.data.createdAt;
    const tb = b.data.createdAt;
    return tb - ta;
  });
}

// ── Active / in-progress entries ─────────────────────────────────────────────

interface ActiveEntry {
  kind: "subtitle" | "clipcutter" | "download";
  label: string;
  sub: string;
  tab: TabMode;
  startedAt: number;
}

function loadActiveEntries(): ActiveEntry[] {
  const result: ActiveEntry[] = [];

  const activeSub = loadActiveJob();
  if (activeSub) {
    result.push({
      kind: "subtitle",
      label: "Generating subtitles…",
      sub: activeSub.mode === "url"
        ? activeSub.url ? shortUrl(activeSub.url) : "YouTube video"
        : activeSub.inputFilename ?? "uploaded file",
      tab: "subtitles",
      startedAt: activeSub.startedAt,
    });
  }

  const activeClips = loadActiveClipJobs();
  for (const c of activeClips) {
    result.push({
      kind: "clipcutter",
      label: `Cutting clip ${c.label}`,
      sub: shortUrl(c.url),
      tab: "clipcutter",
      startedAt: c.startedAt,
    });
  }

  const activeDl = loadActiveDownload();
  if (activeDl) {
    result.push({
      kind: "download",
      label: "Downloading video…",
      sub: shortUrl(activeDl.url),
      tab: "download",
      startedAt: activeDl.savedAt,
    });
  }

  return result.sort((a, b) => b.startedAt - a.startedAt);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v) return `youtube.com/watch?v=${v}`;
    return u.hostname + u.pathname.slice(0, 28);
  } catch {
    return url.slice(0, 40);
  }
}

function relativeTime(ts: number): string {
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

function downloadSrt(filename: string, srt: string) {
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── In-progress row ───────────────────────────────────────────────────────────

function ActiveRow({
  entry,
  onView,
}: {
  entry: ActiveEntry;
  onView: (tab: TabMode) => void;
}) {
  const icon =
    entry.kind === "subtitle" ? <Captions className="w-4 h-4 text-red-400" /> :
    entry.kind === "clipcutter" ? <Scissors className="w-4 h-4 text-purple-400" /> :
    <Film className="w-4 h-4 text-blue-400" />;

  const ringColor =
    entry.kind === "subtitle" ? "bg-primary/20" :
    entry.kind === "clipcutter" ? "bg-purple-500/20" :
    "bg-blue-500/20";

  return (
    <div className="glass-panel rounded-xl border border-white/10 border-l-2 border-l-amber-400/60 p-3 flex items-center gap-3">
      <div className={cn("shrink-0 w-8 h-8 rounded-lg flex items-center justify-center", ringColor)}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Loader2 className="w-3 h-3 text-amber-400 animate-spin shrink-0" />
          <span className="text-xs font-semibold text-white/90">{entry.label}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-white/40">
          <span className="truncate max-w-[200px]">{entry.sub}</span>
          <span>·</span>
          <Clock className="w-3 h-3" />
          <span>Started {relativeTime(entry.startedAt)}</span>
        </div>
      </div>
      <button
        onClick={() => onView(entry.tab)}
        className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-amber-400/80 hover:text-amber-300 bg-amber-400/10 hover:bg-amber-400/20 rounded-lg px-2.5 py-1.5 transition-colors"
      >
        View <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── Completed rows ────────────────────────────────────────────────────────────

function SubtitleRow({
  entry,
  onDelete,
}: {
  entry: SubtitleHistoryEntry;
  onDelete: (id: string) => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const copySrt = () => {
    navigator.clipboard.writeText(entry.srt).then(() => {
      toast({ title: "Copied!", description: "SRT content copied to clipboard." });
    });
  };

  return (
    <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-3 p-3">
        <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
          <Captions className="w-4 h-4 text-red-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-white/90 truncate max-w-[200px]">
              {entry.srtFilename}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-red-300 border border-primary/20 font-medium">
              Subtitles
            </span>
            {entry.translateTo && entry.translateTo !== "none" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/20 font-medium">
                → {entry.translateTo.toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-white/40">
            {entry.mode === "url" && entry.url && (
              <span className="truncate max-w-[160px]">{shortUrl(entry.url)}</span>
            )}
            {entry.mode === "file" && entry.inputFilename && (
              <span className="truncate max-w-[160px]">{entry.inputFilename}</span>
            )}
            <span>·</span>
            <span>{entry.entryCount} lines</span>
            <span>·</span>
            <Clock className="w-3 h-3" />
            <span>{relativeTime(entry.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={copySrt} title="Copy SRT"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => downloadSrt(entry.srtFilename, entry.srt)} title="Download SRT"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <Download className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setExpanded((e) => !e)} title={expanded ? "Collapse" : "Preview"}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => onDelete(entry.id)} title="Delete"
            className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <pre className="text-[10px] text-white/50 font-mono bg-black/20 px-4 py-3 overflow-auto max-h-40 leading-relaxed border-t border-white/5">
              {entry.srt.slice(0, 800)}{entry.srt.length > 800 ? "\n…" : ""}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ClipRow({
  entry,
  onDelete,
}: {
  entry: ClipHistoryEntry;
  onDelete: (id: string) => void;
}) {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="glass-panel rounded-xl border border-white/5 p-3 flex items-center gap-3">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
        <Scissors className="w-4 h-4 text-purple-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-white/90">{entry.label}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/20 font-medium">
            Clip Cut
          </span>
          <span className="text-[10px] text-white/40 font-medium uppercase">{entry.quality}</span>
          {entry.filesize && (
            <span className="text-[10px] text-white/30">{formatFilesize(entry.filesize)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-white/40">
          <span className="truncate max-w-[160px]">{shortUrl(entry.url)}</span>
          <span>·</span>
          <Clock className="w-3 h-3" />
          <span>{relativeTime(entry.createdAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <a href={`${BASE}/api/youtube/file/${entry.jobId}`} title="Re-download"
          className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
          <Download className="w-3.5 h-3.5" />
        </a>
        <button onClick={() => onDelete(entry.jobId)} title="Delete"
          className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function BestClipsRow({
  entry,
  onDelete,
}: {
  entry: BestClipsHistoryEntry;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-3 p-3">
        <div className="shrink-0 w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-white/90">{entry.clipCount} clips found</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20 font-medium">
              Best Clips AI
            </span>
            {!entry.hasTranscript && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-white/40 border border-white/10 font-medium">
                no transcript
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-white/40">
            <a href={entry.url} target="_blank" rel="noopener noreferrer"
              className="truncate max-w-[180px] hover:text-white/70 transition-colors">
              {shortUrl(entry.url)}
            </a>
            <span>·</span>
            <Clock className="w-3 h-3" />
            <span>{relativeTime(entry.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setExpanded((e) => !e)} title={expanded ? "Collapse" : "View clips"}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <a href={entry.url} target="_blank" rel="noopener noreferrer" title="Open on YouTube"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button onClick={() => onDelete(entry.id)} title="Delete"
            className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t border-white/5">
            <div className="px-4 py-3 space-y-2 max-h-60 overflow-auto">
              {entry.clips.map((clip, i) => (
                <div key={i} className="flex items-start gap-3 text-xs">
                  <span className="shrink-0 font-mono text-white/30 text-[10px] mt-0.5 w-20">
                    {clip.startFormatted} → {clip.endFormatted}
                  </span>
                  <div>
                    <p className="font-medium text-white/80">{clip.title}</p>
                    {clip.description && (
                      <p className="text-white/40 text-[10px] mt-0.5 leading-relaxed">{clip.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DownloadRow({
  entry,
  onDelete,
}: {
  entry: CompletedDownloadRecord;
  onDelete: (jobId: string) => void;
}) {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const expired = isDownloadExpired(entry);

  return (
    <div className="glass-panel rounded-xl border border-white/5 p-3 flex items-center gap-3">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
        <Film className="w-4 h-4 text-blue-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-white/90 truncate max-w-[200px]">{entry.filename}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${expired ? "bg-orange-500/10 text-orange-300 border-orange-500/20" : "bg-blue-500/15 text-blue-300 border-blue-500/20"}`}>
            {expired ? "Expired" : "Video"}
          </span>
          {entry.filesize && (
            <span className="text-[10px] text-white/30">{formatFilesize(entry.filesize)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-white/40">
          {entry.url && (
            <a href={entry.url} target="_blank" rel="noopener noreferrer"
              className="truncate max-w-[160px] hover:text-white/70 transition-colors">
              {shortUrl(entry.url)}
            </a>
          )}
          {entry.url && <span>·</span>}
          <Clock className="w-3 h-3" />
          <span>{relativeTime(entry.createdAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!expired && (
          <a href={`${BASE}/api/youtube/file/${entry.jobId}`} title="Re-download"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <Download className="w-3.5 h-3.5" />
          </a>
        )}
        <button onClick={() => onDelete(entry.jobId)} title="Delete"
          className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function GlobalHistoryPanel({ onSwitchTab }: { onSwitchTab: (tab: TabMode) => void }) {
  const { active: activeEntries, completed: entries, deleteEntry, clearAll } =
    useActivityFeed(4000);
  const [open, setOpen] = useState(true);
  const { toast } = useToast();

  const handleDeleteSubtitle = (id: string) => {
    const entry = entries.find((item) => item.kind === "subtitle" && item.data.id === id);
    if (entry) deleteEntry(entry);
  };
  const handleDeleteClip = (jobId: string) => {
    const entry = entries.find(
      (item) => item.kind === "clip" && item.data.jobId === jobId,
    );
    if (entry) deleteEntry(entry);
  };
  const handleDeleteBestClips = (id: string) => {
    const entry = entries.find(
      (item) => item.kind === "bestclips" && item.data.id === id,
    );
    if (entry) deleteEntry(entry);
  };
  const handleDeleteDownload = (jobId: string) => {
    const entry = entries.find(
      (item) => item.kind === "download" && item.data.jobId === jobId,
    );
    if (entry) deleteEntry(entry);
  };

  const handleClearAll = () => {
    clearAll();
    toast({ title: "History cleared", description: "All recent activity has been removed." });
  };

  // Auto-open when there are active jobs so user notices them immediately
  useEffect(() => {
    if (activeEntries.length > 0) setOpen(true);
  }, [activeEntries.length]);

  const totalCount = entries.length + activeEntries.length;

  return (
    <div className="mt-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-2 py-1 group"
      >
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-white/40 group-hover:text-white/70 transition-colors" />
          <span className="text-sm font-semibold text-white/50 group-hover:text-white/80 transition-colors">
            Recent Activity
          </span>
          {totalCount > 0 && (
            <span className="text-[10px] bg-white/10 text-white/50 rounded-full px-2 py-0.5 font-medium">
              {totalCount}
            </span>
          )}
          {activeEntries.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] bg-amber-400/15 text-amber-300 rounded-full px-2 py-0.5 font-medium border border-amber-400/20">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              {activeEntries.length} running
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {open && entries.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleClearAll(); }}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-red-500/10"
            >
              <Trash2 className="w-3 h-3" />
              Clear history
            </button>
          )}
          <ChevronDown
            className={cn(
              "w-4 h-4 text-white/30 group-hover:text-white/60 transition-all duration-200",
              open && "rotate-180"
            )}
          />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-2 pb-4">
              {/* In-progress section */}
              {activeEntries.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1 pb-1">
                    Processing in background
                  </p>
                  {activeEntries.map((e, i) => (
                    <ActiveRow
                      key={`active-${e.kind}-${i}`}
                      entry={e}
                      onView={onSwitchTab}
                    />
                  ))}
                  {entries.length > 0 && (
                    <div className="h-px bg-white/5 my-3" />
                  )}
                </>
              )}

              {/* Completed section */}
              {entries.length === 0 && activeEntries.length === 0 ? (
                <p className="text-center text-white/30 text-sm py-8">
                  No activity yet — results from all tabs will appear here.
                </p>
              ) : entries.length > 0 ? (
                <>
                  {activeEntries.length > 0 && (
                    <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1 pb-1">
                      Completed
                    </p>
                  )}
                  {entries.map((entry) => {
                    if (entry.kind === "subtitle") {
                      return (
                        <SubtitleRow
                          key={`sub-${entry.data.id}`}
                          entry={entry.data}
                          onDelete={handleDeleteSubtitle}
                        />
                      );
                    }
                    if (entry.kind === "clip") {
                      return (
                        <ClipRow
                          key={`clip-${entry.data.jobId}`}
                          entry={entry.data}
                          onDelete={handleDeleteClip}
                        />
                      );
                    }
                    if (entry.kind === "download") {
                      return (
                        <DownloadRow
                          key={`dl-${entry.data.jobId}`}
                          entry={entry.data}
                          onDelete={handleDeleteDownload}
                        />
                      );
                    }
                    return (
                      <BestClipsRow
                        key={`best-${entry.data.id}`}
                        entry={entry.data}
                        onDelete={handleDeleteBestClips}
                      />
                    );
                  })}
                </>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
