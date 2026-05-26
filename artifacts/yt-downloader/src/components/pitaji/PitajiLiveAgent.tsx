// Pita Ji "Live" tab — chat-style analyzer.
//
// Left column: progress / chat events streaming from /api/pitaji/analyze.
// Right column: clip cards that fill in real time as the agent emits them.
// Bottom row: action bar (selection summary; full Cut/Thumbnail/Both
// dispatch lands in Phase 4).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Wand2,
  StopCircle,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  MessageSquare,
  PlayCircle,
  Pencil,
} from "lucide-react";
import { streamPitajiAnalyze, type PitajiAnalyzeEvent, type PitajiClip } from "@/lib/pitaji-api";

type ChatLine =
  | { id: string; kind: "thinking" | "info" | "warn" | "error" | "ok"; text: string; ts: number }
  | { id: string; kind: "user"; text: string; ts: number };

type RunState = "idle" | "running" | "done" | "error" | "cancelled";

function formatHMS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clipDurationLabel(c: PitajiClip): string {
  const d = Math.max(0, Math.round(c.endSec - c.startSec));
  if (d >= 60) {
    const m = Math.floor(d / 60);
    const s = d % 60;
    return `${m}m ${s}s`;
  }
  return `${d}s`;
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export default function PitajiLiveAgent() {
  const [url, setUrl] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [clips, setClips] = useState<PitajiClip[]>([]);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ title?: string; durationSec?: number; channel?: string } | null>(null);
  const [pipeline, setPipeline] = useState<{ mode: string; overThreshold?: boolean; thresholdMin?: number } | null>(null);
  const [error, setError] = useState("");
  const [editingClipId, setEditingClipId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll chat to bottom on new lines.
  useEffect(() => {
    const node = chatScrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat]);

  const pushChat = useCallback((kind: ChatLine["kind"], text: string) => {
    setChat((prev) => [...prev, { id: cryptoId(), kind, text, ts: Date.now() }]);
  }, []);

  const handleEvent = useCallback(
    (evt: PitajiAnalyzeEvent) => {
      switch (evt.type) {
        case "run_start":
          pushChat("info", `Job started (${evt.jobId.slice(0, 12)}…)`);
          break;
        case "meta": {
          const parts: string[] = [];
          if (evt.videoTitle) parts.push(evt.videoTitle);
          if (evt.channel) parts.push(`· ${evt.channel}`);
          if (evt.durationSec) parts.push(`· ${formatHMS(evt.durationSec)}`);
          pushChat("info", parts.length > 0 ? parts.join(" ") : "Loaded video metadata");
          setMeta({
            title: evt.videoTitle ?? undefined,
            durationSec: evt.durationSec ?? undefined,
            channel: evt.channel ?? undefined,
          });
          break;
        }
        case "pipeline_choice":
          setPipeline({
            mode: evt.mode,
            overThreshold: evt.overThreshold,
            thresholdMin: evt.thresholdMin,
          });
          pushChat(
            "info",
            evt.mode === "youtube_direct"
              ? "Pipeline: direct YouTube watching via Gemini"
              : `Pipeline: audio split into ${evt.chunks ?? "?"} chunks via Vertex AI`,
          );
          break;
        case "stage":
          if (evt.stage === "analyzing") {
            pushChat("thinking", "Watching the full video and extracting clips…");
          } else {
            pushChat("info", `Stage: ${evt.stage}${evt.chunk ? ` (chunk ${evt.chunk})` : ""}`);
          }
          break;
        case "warning":
          pushChat("warn", evt.message);
          break;
        case "clip":
          setClips((prev) => [...prev, evt.clip]);
          // Default: select all clips for keeping. Operator unticks if needed.
          setKeep((prev) => {
            const next = new Set(prev);
            next.add(evt.clip.id);
            return next;
          });
          break;
        case "summary":
          pushChat("ok", `Found ${evt.totalClips} ${evt.totalClips === 1 ? "clip" : "clips"}.`);
          break;
        case "error":
          setError(evt.message);
          pushChat("error", evt.message);
          break;
        case "done":
          // run state finalised by the awaiting promise below
          break;
        case "thinking":
          pushChat("thinking", evt.message);
          break;
      }
    },
    [pushChat],
  );

  const start = async () => {
    if (runState === "running") return;
    const trimmed = url.trim();
    if (!trimmed) return;

    setError("");
    setChat([{ id: cryptoId(), kind: "user", text: trimmed, ts: Date.now() }]);
    setClips([]);
    setKeep(new Set());
    setMeta(null);
    setPipeline(null);
    setRunState("running");

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await streamPitajiAnalyze({
        youtubeUrl: trimmed,
        signal: ctrl.signal,
        onEvent: handleEvent,
      });
      setRunState((prev) => (prev === "error" || prev === "cancelled" ? prev : "done"));
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        pushChat("warn", "Stopped by user.");
        setRunState("cancelled");
        return;
      }
      const message = err instanceof Error ? err.message : "Analysis failed";
      setError(message);
      pushChat("error", message);
      setRunState("error");
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const toggleKeep = (clipId: string, on: boolean) => {
    setKeep((prev) => {
      const next = new Set(prev);
      if (on) next.add(clipId);
      else next.delete(clipId);
      return next;
    });
  };

  const updateClipBounds = (clipId: string, startSec: number, endSec: number) => {
    setClips((prev) =>
      prev.map((c) =>
        c.id === clipId
          ? {
              ...c,
              startSec: Math.max(0, Math.round(startSec)),
              endSec: Math.max(Math.round(startSec) + 1, Math.round(endSec)),
            }
          : c,
      ),
    );
  };

  const keptCount = useMemo(() => clips.filter((c) => keep.has(c.id)).length, [clips, keep]);

  return (
    <section className="pj-live">
      <header className="pj-live-header">
        <div className="pj-live-header-text">
          <p className="pj-live-eyebrow">Live agent</p>
          <h1 className="pj-live-title">Drop a finished live-stream URL</h1>
          <p className="pj-live-subtitle">
            The agent will watch the full recording, identify every broadcast-worthy topic and Q&amp;A,
            and queue them for cutting plus thumbnail generation in the background.
          </p>
        </div>
      </header>

      <form
        className="pj-live-form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="pj-live-input">
          <Sparkles size={16} strokeWidth={2} className="pj-live-input-icon" aria-hidden />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste any YouTube live, watch, or share URL (e.g. youtu.be/…, /live/…)"
            spellCheck={false}
            autoComplete="off"
            disabled={runState === "running"}
          />
          {runState === "running" ? (
            <button type="button" className="pj-live-submit pj-live-submit--stop" onClick={stop}>
              <StopCircle size={15} strokeWidth={2} aria-hidden />
              <span>Stop</span>
            </button>
          ) : (
            <button type="submit" disabled={!url.trim()} className="pj-live-submit">
              <Wand2 size={15} strokeWidth={2} aria-hidden />
              <span>Analyze</span>
            </button>
          )}
        </div>
        <p className="pj-live-hint">
          Any YouTube URL form is accepted — it&apos;s normalized to <code>watch?v=</code> automatically.
        </p>
      </form>

      {/* When idle and no clips → show empty-state explainer */}
      {runState === "idle" && clips.length === 0 && chat.length === 0 ? (
        <div className="pj-live-empty">
          <div className="pj-live-empty-card">
            <p className="pj-live-empty-eyebrow">What happens next</p>
            <ol className="pj-live-empty-steps">
              <li>
                <strong>Watch.</strong> Short videos (≤40 min) are analyzed directly via Gemini&apos;s YouTube
                connection. Longer videos have their audio split into 2 or 3 chunks and analyzed via Vertex AI.
              </li>
              <li>
                <strong>Review.</strong> Every topic and Q&amp;A clip streams in with start/end times, a summary,
                suggested title, description, hashtags, and a pinned comment.
              </li>
              <li>
                <strong>Pick &amp; ship.</strong> Tick the clips you want, optionally adjust start/end, then click
                Cut, Thumbnail, or Both. Background workers do the rest. History keeps every result.
              </li>
            </ol>
          </div>
        </div>
      ) : null}

      {(chat.length > 0 || clips.length > 0) && (
        <div className="pj-live-grid">
          {/* Chat / progress column */}
          <div className="pj-live-chat-col">
            <div className="pj-live-chat-header">
              <MessageSquare size={14} strokeWidth={2} aria-hidden />
              <span>Agent</span>
              <span className="pj-live-chat-state">
                {runState === "running" ? (
                  <>
                    <Loader2 size={12} strokeWidth={2.5} className="pj-spin" aria-hidden /> Running
                  </>
                ) : runState === "done" ? (
                  <>
                    <CheckCircle2 size={12} strokeWidth={2.5} aria-hidden /> Done
                  </>
                ) : runState === "error" ? (
                  <>
                    <AlertTriangle size={12} strokeWidth={2.5} aria-hidden /> Error
                  </>
                ) : runState === "cancelled" ? (
                  "Stopped"
                ) : (
                  "Idle"
                )}
              </span>
            </div>

            <div className="pj-live-chat-body" ref={chatScrollRef}>
              {chat.map((line) => (
                <div key={line.id} className={`pj-chat-line pj-chat-line--${line.kind}`}>
                  {line.kind === "thinking" ? (
                    <span className="pj-chat-thinking">
                      <Loader2 size={12} strokeWidth={2.5} className="pj-spin" aria-hidden />{" "}
                      {line.text}
                    </span>
                  ) : (
                    <span>{line.text}</span>
                  )}
                </div>
              ))}
            </div>

            {meta || pipeline ? (
              <div className="pj-live-chat-meta">
                {meta?.title ? <p className="pj-live-meta-title">{meta.title}</p> : null}
                <p className="pj-live-meta-line">
                  {meta?.channel ? <span>{meta.channel}</span> : null}
                  {meta?.durationSec ? <span>· {formatHMS(meta.durationSec)}</span> : null}
                  {pipeline ? (
                    <span className="pj-history-pill">
                      {pipeline.mode === "audio_split" ? "Audio split" : "YouTube direct"}
                    </span>
                  ) : null}
                </p>
              </div>
            ) : null}
          </div>

          {/* Clips column */}
          <div className="pj-live-clips-col">
            <div className="pj-live-clips-header">
              <span>{clips.length} {clips.length === 1 ? "clip" : "clips"} found</span>
              <span className="pj-live-clips-counter">
                {keptCount} kept
              </span>
            </div>

            <ul className="pj-clips-list">
              {clips.map((clip, idx) => {
                const kept = keep.has(clip.id);
                const isEditing = editingClipId === clip.id;
                return (
                  <li
                    key={clip.id}
                    className={`pj-clip-card${kept ? " is-kept" : ""}${clip.kind === "qna" ? " pj-clip-card--qna" : ""}`}
                  >
                    <div className="pj-clip-row">
                      <label className="pj-clip-keep">
                        <input
                          type="checkbox"
                          checked={kept}
                          onChange={(e) => toggleKeep(clip.id, e.target.checked)}
                          aria-label="Keep clip"
                        />
                        <span>{idx + 1}</span>
                      </label>
                      <div className="pj-clip-main">
                        <div className="pj-clip-title-row">
                          <span className={`pj-clip-kind pj-clip-kind--${clip.kind}`}>
                            {clip.kind === "qna" ? "Q&A" : "Topic"}
                          </span>
                          <h4 className="pj-clip-title">{clip.title}</h4>
                          <span className="pj-clip-duration">{clipDurationLabel(clip)}</span>
                        </div>
                        <p className="pj-clip-summary">{clip.summary}</p>
                        <div className="pj-clip-times">
                          {isEditing ? (
                            <ClipBoundsEditor
                              clip={clip}
                              onSave={(s, e) => {
                                updateClipBounds(clip.id, s, e);
                                setEditingClipId(null);
                              }}
                              onCancel={() => setEditingClipId(null)}
                            />
                          ) : (
                            <>
                              <span className="pj-time">
                                <PlayCircle size={11} strokeWidth={2.5} aria-hidden /> {formatHMS(clip.startSec)} → {formatHMS(clip.endSec)}
                              </span>
                              <button
                                type="button"
                                className="pj-clip-edit-btn"
                                onClick={() => setEditingClipId(clip.id)}
                              >
                                <Pencil size={11} strokeWidth={2} aria-hidden />
                                Adjust times
                              </button>
                            </>
                          )}
                        </div>
                        {clip.kind === "qna" && clip.question ? (
                          <details className="pj-clip-details">
                            <summary>Q · A</summary>
                            <p><strong>Q.</strong> {clip.question}</p>
                            {clip.answer ? <p><strong>A.</strong> {clip.answer}</p> : null}
                          </details>
                        ) : null}
                        {clip.suggestedTitle || (clip.hashtags && clip.hashtags.length > 0) ? (
                          <details className="pj-clip-details">
                            <summary>Publish bundle</summary>
                            {clip.suggestedTitle ? (
                              <p><strong>Title.</strong> {clip.suggestedTitle}</p>
                            ) : null}
                            {clip.description ? (
                              <p><strong>Description.</strong> {clip.description}</p>
                            ) : null}
                            {clip.hashtags && clip.hashtags.length > 0 ? (
                              <p><strong>Tags.</strong> {clip.hashtags.join(" ")}</p>
                            ) : null}
                            {clip.pinnedComment ? (
                              <p><strong>Pinned.</strong> {clip.pinnedComment}</p>
                            ) : null}
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {clips.length > 0 ? (
              <div className="pj-live-action-bar">
                <span className="pj-live-action-summary">
                  {keptCount} of {clips.length} selected
                </span>
                <div className="pj-live-action-buttons">
                  <button type="button" className="pj-button-ghost" disabled title="Coming in Phase 4">
                    Cut
                  </button>
                  <button type="button" className="pj-button-ghost" disabled title="Coming in Phase 5">
                    Thumbnail
                  </button>
                  <button type="button" className="pj-button-primary" disabled title="Coming in Phase 4 / 5">
                    Both
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {error && runState !== "running" ? <div className="pj-alert">{error}</div> : null}
    </section>
  );
}

function ClipBoundsEditor({
  clip,
  onSave,
  onCancel,
}: {
  clip: PitajiClip;
  onSave: (start: number, end: number) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState(clip.startSec);
  const [e, setE] = useState(clip.endSec);
  return (
    <div className="pj-clip-edit">
      <input
        type="number"
        min={0}
        value={s}
        onChange={(ev) => setS(Number(ev.target.value))}
        aria-label="Start seconds"
      />
      <span>→</span>
      <input
        type="number"
        min={1}
        value={e}
        onChange={(ev) => setE(Number(ev.target.value))}
        aria-label="End seconds"
      />
      <button type="button" className="pj-clip-edit-save" onClick={() => onSave(s, e)}>Save</button>
      <button type="button" className="pj-clip-edit-cancel" onClick={onCancel}>Cancel</button>
    </div>
  );
}
