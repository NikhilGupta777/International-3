import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, Captions, Scissors, Sparkles, Film,
  Clock, ArrowRight, Download, Copy, ChevronDown,
  ChevronUp, ExternalLink, Trash2, Activity, Languages, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { formatFilesize } from "@/lib/clip-history";
import { isDownloadExpired } from "@/lib/download-history";
import {
  useActivityFeed,
  shortActivityUrl,
  type ActivityCompletedEntry as AnyEntry,
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

export function ActivityPanel({
  onSwitchTab,
}: {
  onSwitchTab: (tab: TabMode) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { toast } = useToast();
  const { active, completed, deleteEntry, clearAll } = useActivityFeed(4000);
  const totalCount = active.length + completed.length;

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
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="activity-page">
      <div className="activity-page-inner">
        <header className="activity-page-header">
          <div className="flex items-center gap-3">
            <div className="activity-page-icon">
              <Activity className="w-5 h-5 text-amber-300" />
            </div>
            <div>
              <h2 className="text-xl sm:text-2xl font-display font-bold text-white">
                Activity
              </h2>
              <p className="text-sm text-white/55 mt-0.5">
                Live jobs and completed downloads/clips/subtitles across this device.
                {totalCount > 0 && <span className="text-white/40"> · {totalCount} item{totalCount === 1 ? "" : "s"}</span>}
              </p>
            </div>
          </div>
          {completed.length > 0 && (
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1.5 text-xs text-white/40 hover:text-red-400 transition-colors px-3 py-2 rounded-lg hover:bg-red-500/10 border border-white/8 hover:border-red-500/30"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear completed
            </button>
          )}
        </header>

        <div className="activity-page-body">
          {totalCount === 0 ? (
            <div className="activity-page-empty">
              <Activity className="w-10 h-10 text-white/10 mx-auto mb-3" />
              <p className="text-sm text-white/40">Nothing running yet.</p>
              <p className="text-xs text-white/30 mt-1">
                Start a subtitle, clip, download or translation job and it will appear here.
              </p>
            </div>
          ) : (
            <>
              {active.length > 0 && (
                <section className="activity-page-section">
                  <p className="activity-page-section-title amber">Processing now</p>
                  <div className="space-y-2">
                    {active.map((e) => {
                      const icon =
                        e.kind === "subtitle" ? <Captions className="w-4 h-4 text-teal-400" /> :
                        e.kind === "clipcutter" ? <Scissors className="w-4 h-4 text-orange-400" /> :
                        e.kind === "translator" ? <Languages className="w-4 h-4 text-red-400" /> :
                        <Film className="w-4 h-4 text-blue-400" />;
                      return (
                        <div
                          key={`active-${e.kind}-${e.startedAt}-${e.label}`}
                          className="activity-row activity-row-active"
                        >
                          <div className="shrink-0">{icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Loader2 className="w-3 h-3 text-amber-400 animate-spin shrink-0" />
                              <span className="text-sm font-medium text-white/90 truncate">{e.label}</span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-white/35">
                              <span className="truncate">{e.sub}</span>
                              <span>·</span>
                              <Clock className="w-3 h-3 shrink-0" />
                              <span className="shrink-0">{relativeTime(e.startedAt)}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => navigate(e.tab)}
                            className="shrink-0 flex items-center gap-1 text-xs font-medium text-amber-400 hover:text-amber-300 bg-amber-400/10 hover:bg-amber-400/20 rounded-lg px-2.5 py-1.5 transition-colors"
                          >
                            View <ArrowRight className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {completed.length > 0 && (
                <section className="activity-page-section">
                  <p className="activity-page-section-title">Completed</p>
                  <div className="space-y-2">
                    {completed.map((entry) => {
                      const key =
                        entry.kind === "subtitle" ? `sub-${entry.data.id}` :
                        entry.kind === "clip" ? `clip-${entry.data.jobId}` :
                        entry.kind === "download" ? `dl-${entry.data.jobId}` :
                        entry.kind === "translator" ? `tr-${entry.data.jobId}` :
                        `best-${entry.data.id}`;
                      const isExpanded = expandedId === key;

                      if (entry.kind === "subtitle") {
                        const d = entry.data;
                        return (
                          <div key={key} className="activity-row-card">
                            <div className="activity-row">
                              <Captions className="w-4 h-4 text-teal-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white/85 truncate">{d.srtFilename}</p>
                                <div className="activity-row-meta">
                                  <span className="text-teal-400/70 font-medium">Subtitles</span>
                                  <span>·</span>
                                  <span>{d.entryCount} lines</span>
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="activity-row-actions">
                                <button onClick={() => { navigator.clipboard.writeText(d.srt); toast({ title: "Copied!" }); }} className="activity-icon-btn" title="Copy SRT">
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => downloadSrt(d.srtFilename, d.srt)} className="activity-icon-btn" title="Download SRT">
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => setExpandedId(isExpanded ? null : key)} className="activity-icon-btn">
                                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                </button>
                                <button onClick={() => handleDelete(entry)} className="activity-icon-btn activity-icon-btn-danger">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
                                  <pre className="text-[10px] text-white/40 font-mono bg-black/20 px-3 py-2 overflow-auto max-h-40 leading-relaxed border-t border-white/5">
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
                          <div key={key} className="activity-row-card">
                            <div className="activity-row">
                              <Scissors className="w-4 h-4 text-orange-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white/85 truncate">{d.label}</p>
                                <div className="activity-row-meta">
                                  <span className="text-orange-400/70 font-medium">Clip Cut</span>
                                  <span>·</span>
                                  <span className="uppercase">{d.quality}</span>
                                  {d.filesize && <><span>·</span><span>{formatFilesize(d.filesize)}</span></>}
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="activity-row-actions">
                                <a href={`${BASE}/api/youtube/file/${d.jobId}`} className="activity-icon-btn" title="Download clip">
                                  <Download className="w-3.5 h-3.5" />
                                </a>
                                <button onClick={() => handleDelete(entry)} className="activity-icon-btn activity-icon-btn-danger">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (entry.kind === "bestclips") {
                        const d = entry.data;
                        return (
                          <div key={key} className="activity-row-card">
                            <div className="activity-row">
                              <Sparkles className="w-4 h-4 text-violet-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white/85">{d.clipCount} clips found</p>
                                <div className="activity-row-meta">
                                  <span className="text-violet-400/70 font-medium">Best Clips AI</span>
                                  <span>·</span>
                                  <span className="truncate">{shortActivityUrl(d.url)}</span>
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="activity-row-actions">
                                <button onClick={() => setExpandedId(isExpanded ? null : key)} className="activity-icon-btn">
                                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                </button>
                                <a href={d.url} target="_blank" rel="noopener noreferrer" className="activity-icon-btn">
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                                <button onClick={() => handleDelete(entry)} className="activity-icon-btn activity-icon-btn-danger">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden border-t border-white/5">
                                  <div className="px-3 py-2 space-y-1.5 max-h-44 overflow-auto">
                                    {d.clips.map((clip, i) => (
                                      <div key={i} className="flex gap-2 text-[11px]">
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
                          <div key={key} className="activity-row-card">
                            <div className="activity-row">
                              <Film className="w-4 h-4 text-blue-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white/85 truncate">{d.filename}</p>
                                <div className="activity-row-meta">
                                  <span className={expired ? "text-orange-400/70 font-medium" : "text-blue-400/70 font-medium"}>
                                    {expired ? "Expired" : "Download"}
                                  </span>
                                  {d.filesize && <><span>·</span><span>{formatFilesize(d.filesize)}</span></>}
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="activity-row-actions">
                                {!expired && (
                                  <a href={`${BASE}/api/youtube/file/${d.jobId}`} className="activity-icon-btn" title="Re-download">
                                    <Download className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                <button onClick={() => handleDelete(entry)} className="activity-icon-btn activity-icon-btn-danger">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (entry.kind === "translator") {
                        const d = entry.data;
                        return (
                          <div key={key} className="activity-row-card">
                            <div className="activity-row">
                              <Languages className="w-4 h-4 text-red-400 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white/85 truncate">{d.filename}</p>
                                <div className="activity-row-meta">
                                  <span className="text-red-400/70 font-medium">Translation</span>
                                  <span>·</span>
                                  <span>{d.targetLang}</span>
                                  {d.segmentCount != null && <><span>·</span><span>{d.segmentCount} segments</span></>}
                                  <span>·</span>
                                  <span>{relativeTime(d.createdAt)}</span>
                                </div>
                              </div>
                              <div className="activity-row-actions">
                                {d.videoUrl && (
                                  <a href={d.videoUrl} className="activity-icon-btn" title="Download translated video">
                                    <Download className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                <button onClick={() => navigate("translator")} className="activity-icon-btn" title="Open translator">
                                  <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleDelete(entry)} className="activity-icon-btn activity-icon-btn-danger">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return null;
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
