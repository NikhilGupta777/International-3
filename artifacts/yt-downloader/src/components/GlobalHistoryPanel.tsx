import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  History, Captions, Scissors, Sparkles, Trash2, Download,
  Copy, ChevronDown, ChevronUp, Clock, X, ExternalLink
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

import {
  loadHistory as loadSubtitleHistory,
  deleteFromHistory as deleteSubtitle,
  type SubtitleHistoryEntry,
} from "@/lib/subtitle-history";
import {
  loadClipHistory,
  deleteFromClipHistory,
  formatFilesize,
  type ClipHistoryEntry,
} from "@/lib/clip-history";
import {
  loadBestClipsHistory,
  deleteFromBestClipsHistory,
  type BestClipsHistoryEntry,
} from "@/lib/best-clips-history";

type AnyEntry =
  | { kind: "subtitle"; data: SubtitleHistoryEntry }
  | { kind: "clip"; data: ClipHistoryEntry }
  | { kind: "bestclips"; data: BestClipsHistoryEntry };

function loadAll(): AnyEntry[] {
  const subs = loadSubtitleHistory().map((d): AnyEntry => ({ kind: "subtitle", data: d }));
  const clips = loadClipHistory().map((d): AnyEntry => ({ kind: "clip", data: d }));
  const best = loadBestClipsHistory().map((d): AnyEntry => ({ kind: "bestclips", data: d }));
  return [...subs, ...clips, ...best].sort((a, b) => {
    const ta = a.kind === "subtitle" ? a.data.createdAt : a.kind === "clip" ? a.data.createdAt : a.data.createdAt;
    const tb = b.kind === "subtitle" ? b.data.createdAt : b.kind === "clip" ? b.data.createdAt : b.data.createdAt;
    return tb - ta;
  });
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

function downloadSrt(filename: string, srt: string) {
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

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
            <Badge className="text-[10px] px-1.5 py-0 bg-primary/15 text-red-300 border-primary/20">
              Subtitles
            </Badge>
            {entry.translateTo && entry.translateTo !== "none" && (
              <Badge className="text-[10px] px-1.5 py-0 bg-blue-500/15 text-blue-300 border-blue-500/20">
                → {entry.translateTo.toUpperCase()}
              </Badge>
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
          <button
            onClick={copySrt}
            title="Copy SRT"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => downloadSrt(entry.srtFilename, entry.srt)}
            title="Download SRT"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? "Collapse" : "Preview"}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => onDelete(entry.id)}
            title="Delete"
            className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
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
          <Badge className="text-[10px] px-1.5 py-0 bg-purple-500/15 text-purple-300 border-purple-500/20">
            Clip Cut
          </Badge>
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
        <a
          href={`${BASE}/api/youtube/download/${entry.jobId}`}
          title="Re-download"
          className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
        <button
          onClick={() => onDelete(entry.jobId)}
          title="Delete"
          className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
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
            <Badge className="text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-300 border-amber-500/20">
              Best Clips AI
            </Badge>
            {!entry.hasTranscript && (
              <Badge className="text-[10px] px-1.5 py-0 bg-white/5 text-white/40 border-white/10">
                no transcript
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-white/40">
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate max-w-[180px] hover:text-white/70 transition-colors"
            >
              {shortUrl(entry.url)}
            </a>
            <span>·</span>
            <Clock className="w-3 h-3" />
            <span>{relativeTime(entry.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? "Collapse" : "View clips"}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <a
            href={entry.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on YouTube"
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => onDelete(entry.id)}
            title="Delete"
            className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-white/5"
          >
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

export function GlobalHistoryPanel() {
  const [entries, setEntries] = useState<AnyEntry[]>(() => loadAll());
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(() => setEntries(loadAll()), []);

  const handleDeleteSubtitle = (id: string) => {
    deleteSubtitle(id);
    refresh();
  };
  const handleDeleteClip = (jobId: string) => {
    deleteFromClipHistory(jobId);
    refresh();
  };
  const handleDeleteBestClips = (id: string) => {
    deleteFromBestClipsHistory(id);
    refresh();
  };

  const handleClearAll = () => {
    loadSubtitleHistory().forEach((e) => deleteSubtitle(e.id));
    loadClipHistory().forEach((e) => deleteFromClipHistory(e.jobId));
    loadBestClipsHistory().forEach((e) => deleteFromBestClipsHistory(e.id));
    refresh();
    toast({ title: "History cleared", description: "All recent activity has been removed." });
  };

  if (entries.length === 0 && !open) return null;

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
          {entries.length > 0 && (
            <span className="text-[10px] bg-white/10 text-white/50 rounded-full px-2 py-0.5 font-medium">
              {entries.length}
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
              Clear all
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
              {entries.length === 0 ? (
                <p className="text-center text-white/30 text-sm py-8">No activity yet — results from all tabs will appear here.</p>
              ) : (
                entries.map((entry) => {
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
                  return (
                    <BestClipsRow
                      key={`best-${entry.data.id}`}
                      entry={entry.data}
                      onDelete={handleDeleteBestClips}
                    />
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
