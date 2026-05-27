// Phase 5 — Full clip detail modal/drawer with auto-refresh.
//   * Thumbnail (with re-generate button)
//   * Suggested title, description, hashtags, pinned comment (each with copy)
//   * Summary, Q&A
//   * Source URL + timestamps
//   * Live progress bar while cutting
//   * Download MP4 button

import { useEffect, useState, useCallback, useRef } from "react";
import {
  X,
  Download,
  Copy,
  Check,
  Image as ImageIcon,
  Loader2,
  PlayCircle,
  Hash,
  MessageSquare,
  FileText,
} from "lucide-react";
import {
  getPitajiClipDetail,
  pitajiDispatchCutReady,
  pitajiDispatchCutStatus,
  pitajiDispatchHasCut,
  pitajiDispatchThumbnailReady,
  type PitajiClipDetail as ClipDetailT,
} from "@/lib/pitaji-api";

interface Props {
  pjcId: string;
  onClose: () => void;
}

function formatHMS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button type="button" className="pj-copy-btn" onClick={copy} title={`Copy ${label ?? ""}`}>
      {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export default function PitajiClipDetail({ pjcId, onClose }: Props) {
  const [data, setData] = useState<ClipDetailT | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError("");
    try {
      const d = await getPitajiClipDetail(pjcId);
      setData(d);
      return d;
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Failed to load clip");
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [pjcId]);

  // Initial load
  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh while cutting (every 2 seconds)
  useEffect(() => {
    if (!data) return;
    const cutStatus = pitajiDispatchCutStatus(data.dispatch);
    const hasCut = pitajiDispatchHasCut(data.dispatch);
    const thumbPending =
      (data.dispatch.action === "thumbnail" || data.dispatch.action === "both") &&
      !pitajiDispatchThumbnailReady(data.dispatch) &&
      !data.dispatch.error &&
      data.dispatch.status !== "error";
    const isActive = (hasCut && cutStatus && cutStatus !== "done" && cutStatus !== "error" && cutStatus !== "cancelled") || thumbPending;
    if (!isActive) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void load(true);
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [data, load]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const clip = data?.dispatch?.clip;
  const cutStatus = data?.dispatch ? pitajiDispatchCutStatus(data.dispatch) : null;
  const hasCut = data?.dispatch ? pitajiDispatchHasCut(data.dispatch) : false;
  const cutDone = data?.dispatch ? pitajiDispatchCutReady(data.dispatch) : false;
  const isError = cutStatus === "error";
  const isCutting = hasCut && cutStatus && !cutDone && !isError && cutStatus !== "cancelled";
  const cutPct = typeof data?.cutProgress?.progressPct === "number" ? data.cutProgress.progressPct : null;
  const thumbnailUrl = data?.thumbnailUrl;
  const thumbnailReady = data?.dispatch ? pitajiDispatchThumbnailReady(data.dispatch) : false;
  const thumbnailPending = Boolean(
    data?.dispatch &&
      (data.dispatch.action === "thumbnail" || data.dispatch.action === "both") &&
      !thumbnailReady &&
      !data.dispatch.error &&
      data.dispatch.status !== "error",
  );
  const thumbnailFailed = Boolean(
    data?.dispatch &&
      (data.dispatch.action === "thumbnail" || data.dispatch.action === "both") &&
      !thumbnailReady &&
      data.dispatch.error,
  );

  return (
    <div className="pj-detail-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pj-detail-panel">
        <header className="pj-detail-header">
          <h2>Clip Detail</h2>
          <button type="button" className="pj-detail-close" onClick={onClose}>
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        {loading ? (
          <div className="pj-detail-loading">
            <Loader2 size={24} className="pj-spin" />
            <span>Loading...</span>
          </div>
        ) : error ? (
          <div className="pj-alert">{error}</div>
        ) : !clip ? (
          <div className="pj-alert">Clip not found</div>
        ) : (
          <div className="pj-detail-body">
            {/* Thumbnail */}
            <section className="pj-detail-section pj-detail-thumbnail-section">
              {thumbnailUrl ? (
                <img src={thumbnailUrl} alt="Thumbnail" className="pj-detail-thumbnail" />
              ) : (
                <div className="pj-detail-no-thumbnail">
                  <ImageIcon size={32} strokeWidth={1.5} />
                  <span>No thumbnail yet</span>
                </div>
              )}
            </section>

            {/* Status + Progress */}
            <section className="pj-detail-section">
              <div className="pj-detail-label">
                <span>Status</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {hasCut ? (
                  <span className={`pj-status pj-status--${cutDone ? "done" : isError ? "error" : cutStatus === "cancelled" ? "cancelled" : "running"}`}>
                    {cutDone
                      ? "Ready to download"
                      : isError
                        ? "Cut failed"
                        : cutStatus === "cancelled"
                          ? "Cancelled"
                          : cutPct != null
                            ? `Cutting ${Math.round(cutPct)}%`
                            : cutStatus ?? "Unknown"}
                  </span>
                ) : null}
                {thumbnailReady ? <span className="pj-status pj-status--done">Thumbnail ready</span> : null}
                {thumbnailFailed ? <span className="pj-status pj-status--error">Thumbnail failed</span> : null}
                {thumbnailPending ? <span className="pj-status pj-status--running">Thumbnail pending</span> : null}
                {isCutting && (
                  <Loader2 size={14} strokeWidth={2.5} className="pj-spin" style={{ color: "var(--pj-accent)" }} />
                )}
              </div>
              {isCutting && (
                <div className="pj-progress-bar" style={{ marginTop: 8 }}>
                  <div className="pj-progress-fill" style={{ width: `${cutPct ?? 5}%` }} />
                </div>
              )}
            </section>

            {/* Download */}
            {data?.cutDownloadUrl && (
              <a
                href={data.cutDownloadUrl}
                className="pj-button-primary pj-detail-download"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download size={15} strokeWidth={2} />
                <span>Download MP4</span>
              </a>
            )}

            {/* Title */}
            {clip.suggestedTitle ? (
              <section className="pj-detail-section">
                <div className="pj-detail-label">
                  <FileText size={14} strokeWidth={2} />
                  <span>Suggested Title</span>
                  <CopyButton text={clip.suggestedTitle} label="title" />
                </div>
                <p className="pj-detail-value pj-detail-title-value">{clip.suggestedTitle}</p>
              </section>
            ) : null}

            {/* Description */}
            {clip.description ? (
              <section className="pj-detail-section">
                <div className="pj-detail-label">
                  <FileText size={14} strokeWidth={2} />
                  <span>Description</span>
                  <CopyButton text={clip.description} label="description" />
                </div>
                <p className="pj-detail-value">{clip.description}</p>
              </section>
            ) : null}

            {/* Hashtags */}
            {clip.hashtags && clip.hashtags.length > 0 ? (
              <section className="pj-detail-section">
                <div className="pj-detail-label">
                  <Hash size={14} strokeWidth={2} />
                  <span>Hashtags</span>
                  <CopyButton text={clip.hashtags.join(" ")} label="hashtags" />
                </div>
                <div className="pj-detail-tags">
                  {clip.hashtags.map((tag, i) => (
                    <span key={i} className="pj-detail-tag">{tag}</span>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Pinned Comment */}
            {clip.pinnedComment ? (
              <section className="pj-detail-section">
                <div className="pj-detail-label">
                  <MessageSquare size={14} strokeWidth={2} />
                  <span>Pinned Comment</span>
                  <CopyButton text={clip.pinnedComment} label="pinned comment" />
                </div>
                <p className="pj-detail-value">{clip.pinnedComment}</p>
              </section>
            ) : null}

            {/* Summary */}
            {clip.summary ? (
              <section className="pj-detail-section">
                <div className="pj-detail-label">
                  <FileText size={14} strokeWidth={2} />
                  <span>Summary</span>
                </div>
                <p className="pj-detail-value pj-detail-summary">{clip.summary}</p>
              </section>
            ) : null}

            {/* Q&A */}
            {clip.kind === "qna" && clip.question ? (
              <section className="pj-detail-section">
                <div className="pj-detail-label">
                  <MessageSquare size={14} strokeWidth={2} />
                  <span>Q &amp; A</span>
                </div>
                <p className="pj-detail-value"><strong>Q.</strong> {clip.question}</p>
                {clip.answer ? <p className="pj-detail-value"><strong>A.</strong> {clip.answer}</p> : null}
              </section>
            ) : null}

            {/* Timestamps */}
            <section className="pj-detail-section">
              <div className="pj-detail-label">
                <PlayCircle size={14} strokeWidth={2} />
                <span>Time range</span>
              </div>
              <p className="pj-detail-value pj-detail-times">
                {formatHMS(clip.startSec)} -&gt; {formatHMS(clip.endSec)}
                <span className="pj-detail-duration">
                  ({Math.round(clip.endSec - clip.startSec)}s)
                </span>
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
