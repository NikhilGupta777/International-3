import { useEffect, useState } from "react";
import { History as HistoryIcon, RefreshCw } from "lucide-react";
import { listPitajiJobs, type PitajiJobSummary } from "@/lib/pitaji-api";

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

export default function PitajiHistory() {
  const [jobs, setJobs] = useState<PitajiJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
          <div className="pj-empty-icon" aria-hidden><HistoryIcon size={28} strokeWidth={1.6} /></div>
          <h3>No live-stream analyses yet</h3>
          <p>Once you analyze your first stream from the Live tab, completed clips and their assets will appear here.</p>
        </div>
      ) : null}

      {jobs.length > 0 ? (
        <ul className="pj-history-list">
          {jobs.map((j) => (
            <li key={j.jobId} className="pj-history-item">
              <div className="pj-history-item-main">
                <h3 className="pj-history-item-title">{j.videoTitle ?? j.youtubeUrl}</h3>
                <p className="pj-history-item-meta">
                  {j.channel ? <span>{j.channel}</span> : null}
                  <span>{formatDuration(j.durationSec)}</span>
                  <span>{j.clipCount} {j.clipCount === 1 ? "clip" : "clips"}</span>
                  {j.pipelineMode ? (
                    <span className="pj-history-pill">{j.pipelineMode === "audio_split" ? `Audio · ${j.chunks ?? "?"} chunks` : "YouTube direct"}</span>
                  ) : null}
                </p>
              </div>
              <div className="pj-history-item-side">
                <span className={`pj-status pj-status--${j.status}`}>{j.status}</span>
                <span className="pj-history-time">{formatRelative(j.updatedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
