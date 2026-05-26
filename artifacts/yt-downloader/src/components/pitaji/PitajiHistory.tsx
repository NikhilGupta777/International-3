import { useCallback, useEffect, useState } from "react";
import { History as HistoryIcon, RefreshCw, ChevronRight, ArrowLeft } from "lucide-react";
import {
  listPitajiJobs,
  getPitajiJob,
  type PitajiJobSummary,
  type PitajiDispatchView,
  type PitajiClip,
} from "@/lib/pitaji-api";
import PitajiClipDetail from "./PitajiClipDetail";

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRelative(ms?: number): string {
  if (!ms) return "—";
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

export default function PitajiHistory() {
  const [jobs, setJobs] = useState<PitajiJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Expanded job detail view
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [expandedClips, setExpandedClips] = useState<PitajiClip[]>([]);
  const [expandedDispatches, setExpandedDispatches] = useState<PitajiDispatchView[]>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [expandedJob, setExpandedJob] = useState<PitajiJobSummary | null>(null);
  // Clip detail overlay
  const [detailPjcId, setDetailPjcId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listPitajiJobs(100);
      setJobs(data.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openJob = useCallback(async (job: PitajiJobSummary) => {
    setExpandedJobId(job.jobId);
    setExpandedJob(job);
    setExpandedLoading(true);
    try {
      const data = await getPitajiJob(job.jobId);
      setExpandedClips(data.job.clips ?? []);
      setExpandedDispatches(data.dispatches ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load job");
    } finally {
      setExpandedLoading(false);
    }
  }, []);

  const closeJob = () => {
    setExpandedJobId(null);
    setExpandedClips([]);
    setExpandedDispatches([]);
    setExpandedJob(null);
  };

  // Build dispatch lookup by clipId
  const dispatchByClip = new Map<string, PitajiDispatchView>();
  for (const d of expandedDispatches) {
    const existing = dispatchByClip.get(d.clip.id);
    if (!existing || d.updatedAt > existing.updatedAt) dispatchByClip.set(d.clip.id, d);
  }

  // Expanded detail view
  if (expandedJobId && expandedJob) {
    return (
      <section className="pj-history">
        <header className="pj-history-header">
          <div>
            <button type="button" className="pj-button-ghost" onClick={closeJob}>
              <ArrowLeft size={14} strokeWidth={2} />
              <span>Back</span>
            </button>
            <h1 className="pj-h1" style={{ marginTop: 8 }}>
              {expandedJob.videoTitle ?? expandedJob.youtubeUrl}
            </h1>
            <p className="pj-history-subtitle">
              {expandedJob.channel ? `${expandedJob.channel} · ` : ""}
              {formatDuration(expandedJob.durationSec)} · {expandedJob.clipCount}{" "}
              {expandedJob.clipCount === 1 ? "clip" : "clips"} · {expandedJob.status}
            </p>
          </div>
        </header>

        {expandedLoading ? (
          <div className="pj-detail-loading">
            <RefreshCw size={18} className="pj-spin" />
            <span>Loading clips…</span>
          </div>
        ) : expandedClips.length === 0 ? (
          <div className="pj-empty">
            <h3>No clips in this job</h3>
          </div>
        ) : (
          <ul className="pj-history-clips-list">
            {expandedClips.map((clip, idx) => {
              const dispatch = dispatchByClip.get(clip.id);
              const hasCut = dispatch?.cutS3Key || dispatch?.cutProgress?.s3Key;
              const hasThumb = dispatch?.thumbnailS3Key;
              return (
                <li key={clip.id} className="pj-history-clip-card">
                  <div className="pj-history-clip-main">
                    <span className="pj-history-clip-idx">{idx + 1}</span>
                    <div className="pj-history-clip-info">
                      <h4>{clip.suggestedTitle || clip.title}</h4>
                      <p className="pj-history-clip-meta">
                        <span className={`pj-clip-kind pj-clip-kind--${clip.kind}`}>
                          {clip.kind === "qna" ? "Q&A" : "Topic"}
                        </span>
                        <span>{formatHMS(clip.startSec)} → {formatHMS(clip.endSec)}</span>
                        <span>({Math.round(clip.endSec - clip.startSec)}s)</span>
                      </p>
                      <p className="pj-history-clip-summary">{clip.summary}</p>
                    </div>
                  </div>
                  <div className="pj-history-clip-actions">
                    {dispatch ? (
                      <>
                        {hasCut ? (
                          <span className="pj-status pj-status--done">Cut ✓</span>
                        ) : dispatch.cutChildJobId ? (
                          <span className="pj-status pj-status--running">Cutting…</span>
                        ) : null}
                        {hasThumb ? (
                          <span className="pj-status pj-status--done">Thumb ✓</span>
                        ) : null}
                        <button
                          type="button"
                          className="pj-clip-detail-btn"
                          onClick={() => setDetailPjcId(dispatch.jobId)}
                        >
                          Detail <ChevronRight size={12} strokeWidth={2.5} />
                        </button>
                      </>
                    ) : (
                      <span className="pj-status pj-status--idle">Not dispatched</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {detailPjcId ? (
          <PitajiClipDetail pjcId={detailPjcId} onClose={() => setDetailPjcId(null)} />
        ) : null}
      </section>
    );
  }

  return (
    <section className="pj-history">
      <header className="pj-history-header">
        <div>
          <p className="pj-eyebrow">Workspace</p>
          <h1 className="pj-h1">History</h1>
          <p className="pj-history-subtitle">
            Every analyzed live-stream and the clips it produced.
          </p>
        </div>
        <button type="button" className="pj-button-ghost" onClick={refresh} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} className={loading ? "pj-spin" : undefined} aria-hidden />
          <span>{loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>

      {error ? <div className="pj-alert">{error}</div> : null}

      {!loading && jobs.length === 0 && !error ? (
        <div className="pj-empty">
          <div className="pj-empty-icon" aria-hidden>
            <HistoryIcon size={28} strokeWidth={1.6} />
          </div>
          <h3>No live-stream analyses yet</h3>
          <p>
            Once you analyze your first stream from the Live tab, completed clips and their assets
            will appear here.
          </p>
        </div>
      ) : null}

      {jobs.length > 0 ? (
        <ul className="pj-history-list">
          {jobs.map((j) => (
            <li
              key={j.jobId}
              className="pj-history-item pj-history-item--clickable"
              onClick={() => openJob(j)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") openJob(j); }}
            >
              <div className="pj-history-item-main">
                <h3 className="pj-history-item-title">{j.videoTitle ?? j.youtubeUrl}</h3>
                <p className="pj-history-item-meta">
                  {j.channel ? <span>{j.channel}</span> : null}
                  <span>{formatDuration(j.durationSec)}</span>
                  <span>
                    {j.clipCount} {j.clipCount === 1 ? "clip" : "clips"}
                  </span>
                  {j.pipelineMode ? (
                    <span className="pj-history-pill">
                      {j.pipelineMode === "audio_split"
                        ? `Audio · ${j.chunks ?? "?"} chunks`
                        : "YouTube direct"}
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="pj-history-item-side">
                <span className={`pj-status pj-status--${j.status}`}>{j.status}</span>
                <span className="pj-history-time">{formatRelative(j.updatedAt)}</span>
                <ChevronRight size={14} strokeWidth={2} className="pj-history-chevron" />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
