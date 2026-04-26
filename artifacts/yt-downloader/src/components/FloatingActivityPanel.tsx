import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Loader2, Captions, Scissors, Sparkles, Film,
  Clock, ArrowRight, Download, Copy, ChevronDown,
  ChevronUp, ExternalLink, Trash2, Activity, CircleHelp, BellRing,
  Languages,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { formatFilesize } from "@/lib/clip-history";
import { isDownloadExpired } from "@/lib/download-history";
import {
  useActivityFeed,
  shortActivityUrl,
  type ActivityCompletedEntry as AnyEntry,
  type ActivityActiveEntry as ActiveEntry,
  type ActivityTabMode as TabMode,
} from "@/hooks/use-activity-feed";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function downloadSrt(filename: string, srt: string) {
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

export function FloatingActivityPanel({
  onSwitchTab,
  onOpenGuide,
  pushProps,
  inline = false,
}: {
  onSwitchTab: (tab: TabMode) => void;
  onOpenGuide: () => void;
  pushProps?: {
    supported: boolean;
    configured: boolean;
    permission: string;
    enabling: boolean;
    onEnable: () => void;
  };
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { toast } = useToast();
  const { active, completed, deleteEntry, clearAll } = useActivityFeed(4000);

  const totalCount = active.length + completed.length;
  const hasActive = active.length > 0;

  const handleDelete = (entry: AnyEntry) => {
    deleteEntry(entry);
  };

  const handleClearAll = () => {
    const confirmed = window.confirm(
      "Clear all completed activity from this device?",
    );
    if (!confirmed) return;
    clearAll();
    toast({ title: "History cleared" });
  };

  const navigate = (tab: TabMode) => {
    onSwitchTab(tab);
    setOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={inline
      ? "relative flex items-center gap-1.5"
      : "fixed top-2 right-2 sm:top-4 sm:right-6 z-50 flex flex-col items-end gap-2 max-w-[calc(100vw-12px)]"
    }>
      <div className="flex items-center gap-2">
        {pushProps && pushProps.supported && pushProps.configured && pushProps.permission !== "granted" && (
          <button
            onClick={pushProps.onEnable}
            disabled={pushProps.enabling}
            className="flex items-center gap-2 pl-3 pr-3 h-9 rounded-full bg-[#1a1a1f] border border-teal-500/30 hover:border-teal-400/50 hover:bg-teal-500/10 shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-200 group"
            title="Enable browser alerts for background jobs"
          >
            <BellRing className={cn("w-4 h-4 text-teal-300", pushProps.enabling && "animate-pulse")} />
            <span className="text-sm font-medium text-teal-300/80 hidden sm:inline group-hover:text-teal-300">
              {pushProps.enabling ? "Enabling..." : "Alerts"}
            </span>
          </button>
        )}

        <button
          onClick={onOpenGuide}
          className="flex items-center gap-2 pl-3 pr-3 h-9 rounded-full bg-[#1a1a1f] border border-white/10 hover:border-white/25 hover:scale-[1.03] shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-200"
          title="Open quick guide"
        >
          <CircleHelp className="w-4 h-4 text-teal-300" />
          <span className="text-sm font-medium text-white/70 hidden sm:inline">
            Help
          </span>
        </button>

      {/* Pill button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex items-center gap-2 pl-3 pr-4 h-9 rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-200",
          open
            ? "bg-white/15 border border-white/20"
            : "bg-[#1a1a1f] border border-white/10 hover:border-white/25 hover:scale-[1.03]"
        )}
        title="Activity panel"
      >
        {hasActive && !open && (
          <span className="absolute inset-0 rounded-full border-2 border-amber-400/50 animate-ping" />
        )}
        <Activity className={cn("w-4 h-4 transition-colors shrink-0", open ? "text-white/60" : "text-white/50")} />
        <span className="text-sm font-medium text-white/70">Activity</span>
        {totalCount > 0 && (
          <span className={cn(
            "min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1",
            hasActive ? "bg-amber-400 text-black" : "bg-white/20 text-white/80"
          )}>
            {totalCount > 99 ? "99+" : totalCount}
          </span>
        )}
      </button>
      </div>

      {/* Panel — opens downward */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn(
              "w-[min(380px,calc(100vw-16px))] max-h-[72vh] sm:max-h-[520px] flex flex-col rounded-2xl border border-white/10 bg-[#0d0d0f]/95 backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.6)] overflow-hidden",
              inline
                ? "absolute right-0 top-full mt-2 z-50"
                : ""
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 shrink-0">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-white/50" />
                <span className="text-sm font-semibold text-white/80">Activity</span>
                {totalCount > 0 && (
                  <span className="text-[10px] bg-white/10 text-white/50 rounded-full px-2 py-0.5 font-medium">
                    {totalCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {completed.length > 0 && (
                  <button
                    onClick={handleClearAll}
                    className="flex items-center gap-1 text-[11px] text-white/30 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 p-3 space-y-2">
              {totalCount === 0 ? (
                <div className="py-10 text-center">
                  <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                  <p className="text-sm text-white/30">Nothing running yet.</p>
                  <p className="text-xs text-white/20 mt-1">Start a subtitle, clip, or download job and it'll appear here.</p>
                </div>
              ) : (
                <>
                  {/* Active jobs */}
                  {active.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold text-amber-400/60 uppercase tracking-wider px-1">
                        Processing now
                      </p>
                      {active.map((e) => {
                        const icon =
                          e.kind === "subtitle" ? <Captions className="w-3.5 h-3.5 text-teal-400" /> :
                          e.kind === "clipcutter" ? <Scissors className="w-3.5 h-3.5 text-orange-400" /> :
                          e.kind === "translator" ? <Languages className="w-3.5 h-3.5 text-red-400" /> :
                          <Film className="w-3.5 h-3.5 text-blue-400" />;
                        return (
                          <div
                            key={`active-${e.kind}-${e.startedAt}-${e.label}`}
                            className="flex items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5"
                          >
                            <div className="shrink-0">{icon}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <Loader2 className="w-2.5 h-2.5 text-amber-400 animate-spin shrink-0" />
                                <span className="text-xs font-medium text-white/90 truncate">{e.label}</span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                                <span className="truncate max-w-[140px]">{e.sub}</span>
                                <span>·</span>
                                <Clock className="w-2.5 h-2.5 shrink-0" />
                                <span className="shrink-0">{relativeTime(e.startedAt)}</span>
                              </div>
                            </div>
                            <button
                              onClick={() => navigate(e.tab)}
                              className="shrink-0 flex items-center gap-0.5 text-[10px] font-medium text-amber-400 hover:text-amber-300 bg-amber-400/10 hover:bg-amber-400/20 rounded-lg px-2 py-1.5 transition-colors"
                            >
                              View <ArrowRight className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Completed */}
                  {completed.length > 0 && (
                    <div className="space-y-2">
                      {active.length > 0 && (
                        <div className="h-px bg-white/5 my-1" />
                      )}
                      <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1">
                        Completed
                      </p>
                      {completed.map((entry) => {
                        const key =
                          entry.kind === "subtitle" ? `sub-${entry.data.id}` :
                          entry.kind === "clip" ? `clip-${entry.data.jobId}` :
                          entry.kind === "download" ? `dl-${entry.data.jobId}` :
                          entry.kind === "translator" ? `tr-${entry.data.jobId}` :
                          `best-${entry.data.id}`;
                        const isExpanded = expandedId === key;
                        const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

                        if (entry.kind === "subtitle") {
                          const d = entry.data;
                          return (
                            <div key={key} className="rounded-xl border border-white/5 bg-white/3 overflow-hidden">
                              <div className="flex items-center gap-2.5 px-3 py-2.5">
                                <Captions className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium text-white/85 truncate">{d.srtFilename}</p>
                                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                                    <span className="text-teal-400/70 font-medium">Subtitles</span>
                                    <span>·</span>
                                    <span>{d.entryCount} lines</span>
                                    <span>·</span>
                                    <span>{relativeTime(d.createdAt)}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-0.5 shrink-0">
                                  <button
                                    onClick={() => { navigator.clipboard.writeText(d.srt); toast({ title: "Copied!" }); }}
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                    title="Copy SRT"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => downloadSrt(d.srtFilename, d.srt)}
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                    title="Download SRT"
                                  >
                                    <Download className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => setExpandedId(isExpanded ? null : key)}
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                  >
                                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                  </button>
                                  <button
                                    onClick={() => handleDelete(entry)}
                                    className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                              <AnimatePresence>
                                {isExpanded && (
                                  <motion.div
                                    initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
                                    transition={{ duration: 0.15 }} className="overflow-hidden"
                                  >
                                    <pre className="text-[9px] text-white/40 font-mono bg-black/20 px-3 py-2 overflow-auto max-h-28 leading-relaxed border-t border-white/5">
                                      {d.srt.slice(0, 600)}{d.srt.length > 600 ? "\n…" : ""}
                                    </pre>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        }

                        if (entry.kind === "clip") {
                          const d = entry.data;
                          return (
                            <div key={key} className="rounded-xl border border-white/5 bg-white/3 flex items-center gap-2.5 px-3 py-2.5">
                              <Scissors className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-white/85 truncate">{d.label}</p>
                                <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                                  <span className="text-orange-400/70 font-medium">Clip Cut</span>
                                  <span>·</span>
                                  <span className="uppercase">{d.quality}</span>
                                  {d.filesize && <><span>·</span><span>{formatFilesize(d.filesize)}</span></>}
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                <a
                                  href={`${BASE}/api/youtube/file/${d.jobId}`}
                                  className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                  title="Download clip"
                                >
                                  <Download className="w-3 h-3" />
                                </a>
                                <button
                                  onClick={() => handleDelete(entry)}
                                  className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          );
                        }

                        if (entry.kind === "bestclips") {
                          const d = entry.data;
                          return (
                            <div key={key} className="rounded-xl border border-white/5 bg-white/3 overflow-hidden">
                              <div className="flex items-center gap-2.5 px-3 py-2.5">
                                <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium text-white/85">{d.clipCount} clips found</p>
                                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                                    <span className="text-violet-400/70 font-medium">Best Clips AI</span>
                                    <span>·</span>
                                    <span className="truncate max-w-[100px]">{shortActivityUrl(d.url)}</span>
                                    <span>·</span>
                                    <span>{relativeTime(d.createdAt)}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-0.5 shrink-0">
                                  <button
                                    onClick={() => setExpandedId(isExpanded ? null : key)}
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                  >
                                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                  </button>
                                  <a
                                    href={d.url} target="_blank" rel="noopener noreferrer"
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                  <button
                                    onClick={() => handleDelete(entry)}
                                    className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                              <AnimatePresence>
                                {isExpanded && (
                                  <motion.div
                                    initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
                                    transition={{ duration: 0.15 }} className="overflow-hidden border-t border-white/5"
                                  >
                                    <div className="px-3 py-2 space-y-1.5 max-h-36 overflow-auto">
                                      {d.clips.map((clip, i) => (
                                        <div key={i} className="flex gap-2 text-[10px]">
                                          <span className="shrink-0 font-mono text-white/25 w-20 mt-0.5">
                                            {clip.startFormatted}→{clip.endFormatted}
                                          </span>
                                          <div>
                                            <p className="text-white/70 font-medium leading-tight">{clip.title}</p>
                                            {clip.description && (
                                              <p className="text-white/35 leading-snug mt-0.5">{clip.description}</p>
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

                        if (entry.kind === "download") {
                          const d = entry.data;
                          const expired = isDownloadExpired(d);
                          return (
                            <div key={key} className="rounded-xl border border-white/5 bg-white/3 flex items-center gap-2.5 px-3 py-2.5">
                              <Film className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-white/85 truncate">{d.filename}</p>
                                <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                                  <span className={expired ? "text-orange-400/70 font-medium" : "text-blue-400/70 font-medium"}>
                                    {expired ? "Expired" : "Download"}
                                  </span>
                                  {d.filesize && <><span>·</span><span>{formatFilesize(d.filesize)}</span></>}
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {!expired && (
                                  <a
                                    href={`${BASE}/api/youtube/file/${d.jobId}`}
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                    title="Re-download"
                                  >
                                    <Download className="w-3 h-3" />
                                  </a>
                                )}
                                <button
                                  onClick={() => handleDelete(entry)}
                                  className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          );
                        }

                        if (entry.kind === "translator") {
                          const d = entry.data;
                          return (
                            <div key={key} className="rounded-xl border border-white/5 bg-white/3 flex items-center gap-2.5 px-3 py-2.5">
                              <Languages className="w-3.5 h-3.5 text-red-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-white/85 truncate">{d.filename}</p>
                                <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/35">
                                  <span className="text-red-400/70 font-medium">Translation</span>
                                  <span>{"\u00b7"}</span>
                                  <span>{d.targetLang}</span>
                                  {d.segmentCount != null && <><span>{"\u00b7"}</span><span>{d.segmentCount} segments</span></>}
                                  <span>{"\u00b7"}</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {d.videoUrl && (
                                  <a
                                    href={d.videoUrl}
                                    className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                    title="Download translated video"
                                  >
                                    <Download className="w-3 h-3" />
                                  </a>
                                )}
                                <button
                                  onClick={() => navigate("translator")}
                                  className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors"
                                  title="Open translator"
                                >
                                  <ArrowRight className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => handleDelete(entry)}
                                  className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          );
                        }

                        return null;
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
