import { useCallback, useEffect, useRef, useState } from "react";
import {
  History as HistoryIcon,
  RefreshCw,
  ChevronRight,
  Download,
  PlayCircle,
  FolderOpen,
  Film,
  Loader2,
} from "lucide-react";
import {
  listPitajiJobs,
  getPitajiJob,
  type PitajiJobSummary,
  type PitajiDispatchView,
  type PitajiClip,
  getPitajiClipDetail,
  pitajiDispatchCutReady,
  pitajiDispatchCutStatus,
  pitajiDispatchHasCut,
  pitajiDispatchThumbnailReady,
} from "@/lib/pitaji-api";
import PitajiClipDetail from "./PitajiClipDetail";
import { useToast } from "./PitajiToast";

/* ── Helpers ────────────────────────────────────────────────────────────── */

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRelative(ms?: number): string {
  if (!ms) return "--";
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function formatHMS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ytThumbnail(videoId?: string): string | null {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/* ── Types for expanded folder data ─────────────────────────────────────── */

type FolderData = {
  clips: PitajiClip[];
  dispatches: PitajiDispatchView[];
  loading: boolean;
};

/* ── Component ──────────────────────────────────────────────────────────── */

export default function PitajiHistory() {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<PitajiJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  // Folder expand state
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [folderData, setFolderData] = useState<Map<string, FolderData>>(new Map());
  // Stable ref for polling — avoids tearing down the interval on every data update
  const folderDataRef = useRef(folderData);
  folderDataRef.current = folderData;
  const openFoldersRef = useRef(openFolders);
  openFoldersRef.current = openFolders;

  // Clip detail overlay
  const [detailPjcId, setDetailPjcId] = useState<string | null>(null);
  // Track which clip is currently fetching its download URL
  const [downloadingPjcId, setDownloadingPjcId] = useState<string | null>(null);

  // Track previous dispatch statuses for toast notifications
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const data = await listPitajiJobs(100);
      setJobs(data.jobs ?? []);
      setLastUpdated(Date.now());
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Could not load history");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const refreshFolder = useCallback(
    async (jobId: string, notify = true) => {
      const data = await getPitajiJob(jobId);
      const dispatches = data.dispatches ?? [];

      if (notify) {
        for (const d of dispatches) {
          const currStatus = pitajiDispatchHasCut(d)
            ? pitajiDispatchCutStatus(d) ?? d.status
            : d.status;
          const prevStatus = prevStatusRef.current.get(d.jobId);
          if (prevStatus && prevStatus !== "done" && currStatus === "done") {
            toast("success", `${pitajiDispatchHasCut(d) ? "Clip ready" : "Thumbnail ready"}: ${d.clip.suggestedTitle || d.clip.title}`);
          } else if (prevStatus && prevStatus !== "error" && currStatus === "error") {
            toast("error", `Cut failed: ${d.clip.suggestedTitle || d.clip.title}`);
          }
          prevStatusRef.current.set(d.jobId, currStatus ?? "unknown");
        }
      } else {
        for (const d of dispatches) {
          prevStatusRef.current.set(
            d.jobId,
            (pitajiDispatchHasCut(d) ? pitajiDispatchCutStatus(d) : d.status) ?? "unknown",
          );
        }
      }

      setFolderData((prev) => {
        const next = new Map(prev);
        next.set(jobId, {
          clips: data.job.clips ?? [],
          dispatches,
          loading: false,
        });
        return next;
      });
    },
    [toast],
  );

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live polling — every 4 seconds, refresh open folders with in-progress jobs.
  // Uses refs for folderData / openFolders so the interval is NOT torn down on
  // every data update (avoids resetting the 4s timer continuously).
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) return;
      void refresh(true);
      for (const jobId of openFoldersRef.current) {
        void refreshFolder(jobId).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const t = window.setInterval(async () => {
      if (document.hidden) return;

      // Refresh the job list silently
      void refresh(true);

      // Refresh any open folders that have in-progress dispatches
      for (const jobId of openFoldersRef.current) {
        const fd = folderDataRef.current.get(jobId);
        if (!fd || fd.loading) continue;
        const hasActive = fd.dispatches.some((d) => {
          if (pitajiDispatchHasCut(d) && !pitajiDispatchCutReady(d)) {
            const s = pitajiDispatchCutStatus(d);
            return s !== "error" && s !== "cancelled";
          }
          if ((d.action === "thumbnail" || d.action === "both") && !pitajiDispatchThumbnailReady(d) && !d.error) {
            return d.status !== "error";
          }
          return false;
        });
        if (!hasActive && fd.dispatches.length > 0) continue;
        try {
          const data = await getPitajiJob(jobId);
          const dispatches = data.dispatches ?? [];

          // Check for newly completed cuts → toast
          for (const d of dispatches) {
            const currStatus = pitajiDispatchHasCut(d)
              ? pitajiDispatchCutStatus(d) ?? d.status
              : d.status;
            const prevStatus = prevStatusRef.current.get(d.jobId);
            if (prevStatus && prevStatus !== "done" && currStatus === "done") {
              toast("success", `${pitajiDispatchHasCut(d) ? "Clip ready" : "Thumbnail ready"}: ${d.clip.suggestedTitle || d.clip.title}`);
            } else if (prevStatus && prevStatus !== "error" && currStatus === "error") {
              toast("error", `Cut failed: ${d.clip.suggestedTitle || d.clip.title}`);
            }
            prevStatusRef.current.set(d.jobId, currStatus ?? "unknown");
          }

          setFolderData((prev) => {
            const next = new Map(prev);
            next.set(jobId, {
              clips: data.job.clips ?? [],
              dispatches,
              loading: false,
            });
            return next;
          });
        } catch {
          /* keep last good data */
        }
      }
    }, 4000);

    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh, refreshFolder, toast]);

  const toggleFolder = useCallback(
    async (job: PitajiJobSummary) => {
      const jobId = job.jobId;
      setOpenFolders((prev) => {
        const next = new Set(prev);
        if (next.has(jobId)) {
          next.delete(jobId);
        } else {
          next.add(jobId);
        }
        return next;
      });

      // If opening and not yet loaded, fetch
      if (!folderData.has(jobId)) {
        setFolderData((prev) => {
          const next = new Map(prev);
          next.set(jobId, { clips: [], dispatches: [], loading: true });
          return next;
        });
        try {
          const data = await getPitajiJob(jobId);
          const dispatches = data.dispatches ?? [];
          // Seed prev status map
          for (const d of dispatches) {
            prevStatusRef.current.set(
              d.jobId,
              (pitajiDispatchHasCut(d) ? pitajiDispatchCutStatus(d) : d.status) ?? "unknown",
            );
          }
          setFolderData((prev) => {
            const next = new Map(prev);
            next.set(jobId, { clips: data.job.clips ?? [], dispatches, loading: false });
            return next;
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not load job");
          setFolderData((prev) => {
            const next = new Map(prev);
            next.set(jobId, { clips: [], dispatches: [], loading: false });
            return next;
          });
        }
      }
    },
    [folderData],
  );

  // Download all ready clips in a folder — uses hidden anchor clicks instead of
  // window.open to avoid pop-up blockers that fire after the first tab.
  const downloadAll = useCallback(
    async (jobId: string) => {
      const fd = folderDataRef.current.get(jobId);
      if (!fd) return;
      const readyDispatches = fd.dispatches.filter((d) => {
        return pitajiDispatchCutReady(d);
      });
      if (readyDispatches.length === 0) {
        toast("info", "No clips ready to download yet");
        return;
      }
      toast("info", `Downloading ${readyDispatches.length} clip${readyDispatches.length > 1 ? "s" : ""}...`);
      for (const d of readyDispatches) {
        try {
          const detail = await getPitajiClipDetail(d.jobId);
          if (detail.cutDownloadUrl) {
            const a = document.createElement("a");
            a.href = detail.cutDownloadUrl;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        } catch {
          toast("error", `Could not get download URL for ${d.clip.title}`);
        }
        // Small delay between downloads
        await new Promise((r) => setTimeout(r, 600));
      }
    },
    [toast],
  );

  return (
    <section className="pj-history">
      <header className="pj-history-header">
        <div>
          <p className="pj-eyebrow">Workspace</p>
          <h1 className="pj-h1">
            <FolderOpen size={24} strokeWidth={2} aria-hidden />
            History
          </h1>
          <p className="pj-history-subtitle">
            Every analyzed live-stream organized by video. Only dispatched clips appear inside each folder.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {lastUpdated > 0 && (
            <span className="pj-last-updated">Updated {formatRelative(lastUpdated)}</span>
          )}
          <button type="button" className="pj-button-ghost" onClick={() => refresh()} disabled={loading}>
            <RefreshCw size={14} strokeWidth={2} className={loading ? "pj-spin" : undefined} aria-hidden />
            <span>{loading ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
      </header>

      {error ? <div className="pj-alert">{error}</div> : null}

      {/* Loading skeleton */}
      {loading && jobs.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="pj-skeleton pj-skeleton-folder" />
          ))}
        </div>
      ) : null}

      {/* Empty state */}
      {!loading && jobs.length === 0 && !error ? (
        <div className="pj-empty">
          <div className="pj-empty-icon" aria-hidden>
            <HistoryIcon size={28} strokeWidth={1.6} />
          </div>
          <h3>No live-stream analyses yet</h3>
          <p>
            Once you analyze your first stream from the Live tab, completed clips and their assets
            will appear here organized by video.
          </p>
        </div>
      ) : null}

      {/* Folder list */}
      {jobs.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {jobs.map((j) => {
            const isOpen = openFolders.has(j.jobId);
            const fd = folderData.get(j.jobId);
            const thumb = ytThumbnail(j.videoId);
            // Count dispatched clips only. Summary counts come from /jobs so
            // folders are useful before the user expands them.
            const dispatchedCount = fd ? fd.dispatches.length : j.dispatchedCount ?? 0;
            const readyCount = fd
              ? fd.dispatches.filter(pitajiDispatchCutReady).length
              : j.cutReadyCount ?? 0;
            const thumbnailReadyCount = fd
              ? fd.dispatches.filter(pitajiDispatchThumbnailReady).length
              : j.thumbnailReadyCount ?? 0;
            const activeDispatchCount = fd
              ? fd.dispatches.filter((d) => {
                  if (pitajiDispatchHasCut(d) && !pitajiDispatchCutReady(d)) {
                    const s = pitajiDispatchCutStatus(d);
                    return s !== "error" && s !== "cancelled";
                  }
                  if ((d.action === "thumbnail" || d.action === "both") && !pitajiDispatchThumbnailReady(d) && !d.error) {
                    return d.status !== "error";
                  }
                  return false;
                }).length
              : j.activeDispatchCount ?? 0;

            return (
              <li key={j.jobId} className={`pj-folder${isOpen ? " is-open" : ""}`}>
                {/* Folder header */}
                <div
                  className="pj-folder-header"
                  onClick={() => toggleFolder(j)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void toggleFolder(j);
                    }
                  }}
                >
                  {thumb ? (
                    <img src={thumb} alt="" className="pj-folder-thumb" loading="lazy" />
                  ) : (
                    <div className="pj-folder-thumb-placeholder">
                      <Film size={18} strokeWidth={1.8} />
                    </div>
                  )}
                  <div className="pj-folder-info">
                    <h3 className="pj-folder-title">{j.videoTitle ?? j.youtubeUrl}</h3>
                    <div className="pj-folder-meta">
                      {j.channel ? <span>{j.channel}</span> : null}
                      <span>{formatDuration(j.durationSec)}</span>
                      <span>{j.clipCount} clip{j.clipCount !== 1 ? "s" : ""} found</span>
                      <span>{formatRelative(j.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="pj-folder-right">
                    <span className={`pj-status pj-status--${j.status}`}>{j.status}</span>
                    {dispatchedCount > 0 && (
                      <span className="pj-folder-count">
                        {readyCount}/{dispatchedCount} MP4
                      </span>
                    )}
                    {thumbnailReadyCount > 0 && (
                      <span className="pj-folder-count pj-folder-count--muted">
                        {thumbnailReadyCount} thumb
                      </span>
                    )}
                    {activeDispatchCount > 0 && (
                      <span className="pj-folder-count pj-folder-count--active">
                        {activeDispatchCount} active
                      </span>
                    )}
                    <ChevronRight size={16} strokeWidth={2} className="pj-folder-chevron" />
                  </div>
                </div>

                {/* Folder body — only dispatched clips */}
                {isOpen && (
                  <div className="pj-folder-body">
                    {fd?.loading ? (
                      <div className="pj-detail-loading">
                        <RefreshCw size={16} className="pj-spin" />
                        <span>Loading clips...</span>
                      </div>
                    ) : fd && fd.dispatches.length === 0 ? (
                      <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pj-fg-2)", fontSize: 13 }}>
                        No clips dispatched for this video yet. Go to the Live tab to cut clips.
                      </div>
                    ) : fd ? (
                      <>
                        {/* Action bar */}
                        <div className="pj-folder-actions">
                          <span className="pj-folder-actions-label">
                            {fd.dispatches.length} dispatched clip{fd.dispatches.length !== 1 ? "s" : ""}
                          </span>
                          {readyCount > 0 && (
                            <button
                              type="button"
                              className="pj-download-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                void downloadAll(j.jobId);
                              }}
                            >
                              <Download size={12} strokeWidth={2.5} />
                              Download All ({readyCount})
                            </button>
                          )}
                        </div>

                        {/* Clip grid */}
                        <ul className="pj-folder-clips-grid">
                          {fd.dispatches.map((d, idx) => {
                            const clip = d.clip;
                            const hasCut = pitajiDispatchHasCut(d);
                            const cutStatus = pitajiDispatchCutStatus(d);
                            const cutPct =
                              typeof d.cutProgress?.progressPct === "number"
                                ? d.cutProgress.progressPct
                                : null;
                            const isDone = pitajiDispatchCutReady(d);
                            const isError = cutStatus === "error";
                            const isCutting = hasCut && !isDone && !isError && cutStatus !== "cancelled";
                            const thumbnailReady = pitajiDispatchThumbnailReady(d);
                            const thumbnailPending =
                              (d.action === "thumbnail" || d.action === "both") &&
                              !thumbnailReady &&
                              !d.error &&
                              d.status !== "error";
                            const thumbnailFailed =
                              (d.action === "thumbnail" || d.action === "both") &&
                              !thumbnailReady &&
                              Boolean(d.error);

                            return (
                              <li key={d.jobId} className="pj-folder-clip">
                                <div className="pj-folder-clip-top">
                                  <span className="pj-folder-clip-idx">{idx + 1}</span>
                                  <span className={`pj-clip-kind pj-clip-kind--${clip.kind}`}>
                                    {clip.kind === "qna" ? "Q&A" : "Topic"}
                                  </span>
                                  <h4 className="pj-folder-clip-title">
                                    {clip.suggestedTitle || clip.title}
                                  </h4>
                                </div>

                                <div className="pj-folder-clip-times">
                                  <PlayCircle size={11} strokeWidth={2.5} style={{ display: "inline", verticalAlign: "middle" }} />{" "}
                                  {formatHMS(clip.startSec)} -&gt; {formatHMS(clip.endSec)}
                                  {" "}({Math.round(clip.endSec - clip.startSec)}s)
                                </div>

                                <div className="pj-folder-clip-status">
                                  {hasCut ? (
                                    <span
                                      className={`pj-status pj-status--${
                                        isDone ? "done" : isError ? "error" : cutStatus === "cancelled" ? "cancelled" : "running"
                                      }`}
                                    >
                                      {isDone
                                        ? "Ready"
                                        : isError
                                          ? "Failed"
                                          : cutStatus === "cancelled"
                                            ? "Cancelled"
                                            : cutPct != null
                                              ? `Cutting ${Math.round(cutPct)}%`
                                              : "Cutting..."}
                                    </span>
                                  ) : null}
                                  {thumbnailReady && (
                                    <span className="pj-status pj-status--done">Thumb</span>
                                  )}
                                  {thumbnailPending ? (
                                    <span className="pj-status pj-status--running">Thumb...</span>
                                  ) : null}
                                  {thumbnailFailed ? (
                                    <span className="pj-status pj-status--error">Thumb failed</span>
                                  ) : null}
                                </div>

                                {/* Progress bar for in-progress cuts */}
                                {isCutting && (
                                  <div className="pj-progress-bar">
                                    <div
                                      className="pj-progress-fill"
                                      style={{ width: `${cutPct ?? 5}%` }}
                                    />
                                  </div>
                                )}

                                {/* Action buttons */}
                                <div className="pj-folder-clip-actions">
                                  {isDone && (
                                    <button
                                      type="button"
                                      className="pj-download-btn"
                                      disabled={downloadingPjcId === d.jobId}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void (async () => {
                                          setDownloadingPjcId(d.jobId);
                                          try {
                                            const detail = await getPitajiClipDetail(d.jobId);
                                            if (detail.cutDownloadUrl) {
                                              window.open(detail.cutDownloadUrl, "_blank", "noopener,noreferrer");
                                            }
                                          } catch {
                                            toast("error", "Could not get download URL");
                                          } finally {
                                            setDownloadingPjcId(null);
                                          }
                                        })();
                                      }}
                                    >
                                      {downloadingPjcId === d.jobId ? (
                                        <Loader2 size={12} strokeWidth={2.5} className="pj-spin" />
                                      ) : (
                                        <Download size={12} strokeWidth={2.5} />
                                      )}
                                      {downloadingPjcId === d.jobId ? "Loading…" : "Download"}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="pj-download-btn pj-download-btn--ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDetailPjcId(d.jobId);
                                    }}
                                  >
                                    Detail
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Clip detail overlay */}
      {detailPjcId ? (
        <PitajiClipDetail pjcId={detailPjcId} onClose={() => setDetailPjcId(null)} />
      ) : null}
    </section>
  );
}
