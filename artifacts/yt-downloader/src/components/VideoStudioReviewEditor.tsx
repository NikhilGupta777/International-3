import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  videoEditorApi,
  type Timeline,
  type TimelineClip,
  type TimedOverlay,
  type AudioClip,
  type TransitionType,
} from "@/lib/video-editor-api";
import { workspaceApi } from "@/lib/workspace-api";
import { getLocalMediaUrl, registerLocalMedia } from "@/lib/local-media-cache";

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function uuid(): string {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch { /* */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function clipDuration(clip: TimelineClip): number {
  const src = clip.srcOut > clip.srcIn ? clip.srcOut - clip.srcIn : 0;
  return src / (clip.speed || 1);
}
function timelineDuration(tl: Timeline): number {
  // The render concatenates clips in array order, so total = sum of clip
  // durations (clip tlStart is not used for video placement).
  return tl.tracks.video.reduce((s, c) => s + (clipDuration(c) || 0), 0);
}
function round1(n: number): number { return Math.round(n * 10) / 10; }
function posterTime(clip: TimelineClip): number {
  const dur = clip.srcOut > clip.srcIn ? clip.srcOut - clip.srcIn : 0;
  return clip.srcIn + (dur > 2 ? Math.min(dur / 2, 3) : 0.1);
}
const ASPECT_RATIO: Record<string, number> = { "9:16": 9 / 16, "1:1": 1, "16:9": 16 / 9, original: 16 / 9 };
function colorFilter(preset: string): string | undefined {
  switch (preset) {
    case "vivid": return "saturate(1.35) contrast(1.08)";
    case "muted": return "saturate(0.65) contrast(0.95)";
    case "bw": return "grayscale(1)";
    case "warm": return "sepia(0.25) saturate(1.1)";
    case "cool": return "hue-rotate(-10deg) saturate(1.05)";
    default: return undefined;
  }
}
const ANCHORS = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const;
type Anchor = (typeof ANCHORS)[number];
function overlayBoxStyle(position: string): React.CSSProperties {
  const M = "4.5%";
  const base: React.CSSProperties = { position: "absolute", maxWidth: "92%" };
  switch (position) {
    case "top-left": return { ...base, top: M, left: M };
    case "top-center": return { ...base, top: M, left: "50%", transform: "translateX(-50%)" };
    case "top-right": return { ...base, top: M, right: M };
    case "bottom-left": return { ...base, bottom: M, left: M };
    case "bottom-center": return { ...base, bottom: "8%", left: "50%", transform: "translateX(-50%)" };
    case "bottom-right": return { ...base, bottom: M, right: M };
    default: return { ...base, top: M, right: M };
  }
}
/** Nearest of the 6 supported anchors from a 0..1 x/y point in the stage. */
function anchorFromPoint(x: number, y: number): Anchor {
  const col = x < 0.34 ? "left" : x < 0.66 ? "center" : "right";
  const row = y < 0.5 ? "top" : "bottom";
  if (row === "top") return (col === "center" ? "top-center" : `top-${col}`) as Anchor;
  return (col === "center" ? "bottom-center" : `bottom-${col}`) as Anchor;
}
/** Approx CENTER coords (0..1) for each named anchor — used as the starting
 *  point when converting an anchored overlay to free X/Y. */
function anchorToXY(position: string): { x: number; y: number } {
  const x = position.includes("left") ? 0.08 : position.includes("right") ? 0.92 : 0.5;
  const y = position.startsWith("top") ? 0.1 : 0.9;
  return { x, y };
}
/** Absolute CSS placement for an overlay: free coords (center) if present,
 *  else the named-anchor box. */
function overlayPosStyle(ov: TimedOverlay): React.CSSProperties {
  if (typeof ov.xPct === "number" && typeof ov.yPct === "number") {
    return { position: "absolute", left: `${ov.xPct * 100}%`, top: `${ov.yPct * 100}%`, transform: "translate(-50%, -50%)", maxWidth: "92%" };
  }
  return overlayBoxStyle(ov.position);
}
const TRANSITIONS: TransitionType[] = ["none", "fade", "crossfade", "blur", "dip-to-black", "wipe"];

type AssetKind = "video" | "image" | "audio";
function assetKind(path: string): AssetKind {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].includes(ext)) return "audio";
  return "image";
}

type Selection = { type: "clip" | "overlay" | "audio"; id: string } | null;

// ─── Component ────────────────────────────────────────────────────────────────
export function VideoStudioReviewEditor({
  projectId,
  initialTimeline,
  title,
  proposalId,
  busy = false,
  onClose,
  onRender,
  onChangePlan,
}: {
  projectId: string;
  initialTimeline: Timeline;
  title?: string;
  proposalId: string | null;
  busy?: boolean;
  onClose: () => void;
  onRender: (timeline: Timeline) => void;
  onChangePlan: () => void;
}) {
  const [tl, setTl] = useState<Timeline>(() => structuredCloneSafe(initialTimeline));
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | { for: "clip" | "image" | "audio" }>(null);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const stageRef = useRef<HTMLDivElement>(null);
  // Live player state
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);          // current video time (source seconds)
  const [srcUrls, setSrcUrls] = useState<Record<string, string>>({}); // server stream fallback cache

  // Re-clone if the agent pushes a new proposal into the same open editor.
  useEffect(() => { setTl(structuredCloneSafe(initialTimeline)); setDirty(false); setSel(null); setPreviewIdx(0); }, [initialTimeline]);

  const clips = tl.tracks.video;
  const overlays = tl.tracks.overlays;
  const audio = tl.tracks.audio;
  const total = useMemo(() => timelineDuration(tl), [tl]);
  const activeClip = clips[previewIdx] ?? clips[0];
  const playhead = activeClip ? activeClip.tlStart + clipDuration(activeClip) / 2 : 0;
  const fit = tl.export.cropMode === "contain" || tl.export.cropMode === "fit-blur" ? "contain" : "cover";
  const aspect = ASPECT_RATIO[tl.export.aspectRatio] ?? 16 / 9;
  const cFilter = colorFilter(tl.export.colorPreset);
  const posterUrl = activeClip ? videoEditorApi.assetFrameUrl(projectId, activeClip.asset, posterTime(activeClip)) : null;

  // ── Resolve a playable source for the active clip: local File (instant) →
  //    streamed server URL (fallback) → poster still while it loads.
  const activeAsset = activeClip?.asset || null;
  const localUrl = activeAsset ? getLocalMediaUrl(activeAsset) : null;
  const previewUrl = localUrl || (activeAsset ? srcUrls[activeAsset] : null) || null;
  useEffect(() => {
    if (!activeAsset || localUrl || srcUrls[activeAsset]) return;
    let cancelled = false;
    void videoEditorApi.getAssetUrl(projectId, activeAsset)
      .then(({ url }) => { if (!cancelled) setSrcUrls((s) => (s[activeAsset] ? s : { ...s, [activeAsset]: url })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeAsset, localUrl, projectId, srcUrls]);

  // Timeline playhead (concatenated seconds) from the active clip + its progress.
  const clipsBefore = useMemo(() => clips.slice(0, previewIdx).reduce((s, c) => s + clipDuration(c), 0), [clips, previewIdx]);
  const playheadTl = activeClip ? clipsBefore + Math.max(0, curTime - activeClip.srcIn) / (activeClip.speed || 1) : 0;
  const scrubMax = activeClip
    ? (activeClip.srcOut > activeClip.srcIn ? activeClip.srcOut : (durations[activeClip.asset] || curTime || 0))
    : 0;

  // Keep playbackRate in sync with the clip speed.
  useEffect(() => {
    const v = videoRef.current;
    if (v && activeClip) { try { v.playbackRate = activeClip.speed || 1; } catch { /* */ } }
  }, [activeClip?.speed, previewUrl]);

  // On clip/source switch, stop playback (the new source seeks on metadata load).
  useEffect(() => { setPlaying(false); }, [previewIdx, previewUrl]);

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) { v.play().then(() => setPlaying(true)).catch(() => {}); }
    else { v.pause(); setPlaying(false); }
  };
  const onVideoMeta = () => {
    const v = videoRef.current; if (!v || !activeClip) return;
    try { v.currentTime = activeClip.srcIn || 0; v.playbackRate = activeClip.speed || 1; } catch { /* */ }
    setCurTime(activeClip.srcIn || 0);
  };
  const onVideoTime = () => {
    const v = videoRef.current; if (!v || !activeClip) return;
    const out = activeClip.srcOut > activeClip.srcIn ? activeClip.srcOut : (v.duration || 0);
    if (out > 0 && v.currentTime >= out - 0.04) { try { v.currentTime = activeClip.srcIn || 0; } catch { /* */ } }
    setCurTime(v.currentTime);
  };
  const seekTo = (t: number) => { const v = videoRef.current; if (v) { try { v.currentTime = t; setCurTime(t); } catch { /* */ } } };

  // ── mutation helpers (immutable; mark dirty) ──
  const mutate = useCallback((fn: (draft: Timeline) => void) => {
    setTl((prev) => { const next = structuredCloneSafe(prev); fn(next); return next; });
    setDirty(true);
  }, []);
  const patchClip = (id: string, patch: Partial<TimelineClip>) =>
    mutate((d) => { const c = d.tracks.video.find((x) => x.id === id); if (c) Object.assign(c, patch); });
  const patchOverlay = (id: string, patch: Partial<TimedOverlay>) =>
    mutate((d) => { const o = d.tracks.overlays.find((x) => x.id === id); if (o) Object.assign(o, patch); });
  const patchOverlayStyle = (id: string, patch: Record<string, any>) =>
    mutate((d) => { const o = d.tracks.overlays.find((x) => x.id === id); if (o) o.style = { ...o.style, ...patch }; });
  const patchAudio = (id: string, patch: Partial<AudioClip>) =>
    mutate((d) => { const a = d.tracks.audio.find((x) => x.id === id); if (a) Object.assign(a, patch); });

  const removeSelected = () => {
    if (!sel) return;
    mutate((d) => {
      if (sel.type === "clip") d.tracks.video = d.tracks.video.filter((c) => c.id !== sel.id);
      if (sel.type === "overlay") d.tracks.overlays = d.tracks.overlays.filter((o) => o.id !== sel.id);
      if (sel.type === "audio") d.tracks.audio = d.tracks.audio.filter((a) => a.id !== sel.id);
    });
    setSel(null);
  };
  const moveClip = (id: string, dir: -1 | 1) => {
    mutate((d) => {
      const arr = d.tracks.video;
      const i = arr.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      // recompute sequential tlStart
      let cur = 0;
      for (const c of arr) { c.tlStart = cur; cur += clipDuration(c) || 1; }
    });
  };

  // ── add assets ──
  const addAsset = async (path: string, kind: AssetKind) => {
    if (kind === "video") {
      let duration = 0;
      try { duration = (await videoEditorApi.getAssetMeta(projectId, path)).duration; } catch { /* */ }
      mutate((d) => {
        let cur = 0;
        for (const c of d.tracks.video) cur = Math.max(cur, c.tlStart + clipDuration(c));
        d.tracks.video.push({ id: uuid(), asset: path, srcIn: 0, srcOut: duration > 0 ? duration : 0, tlStart: cur, speed: 1 });
      });
    } else if (kind === "image") {
      mutate((d) => d.tracks.overlays.push({ id: uuid(), type: "image", content: path, tlStart: 0, tlEnd: 0, position: "top-right", style: { widthPercent: 28 } }));
    } else {
      mutate((d) => d.tracks.audio.push({ id: uuid(), asset: path, tlStart: 0, tlEnd: 0, volumeDb: -10, fadeIn: 0, fadeOut: 0, duckSpeech: true }));
    }
    setPicker(null);
  };
  const addText = () => {
    const id = uuid();
    mutate((d) => d.tracks.overlays.push({ id, type: "text", content: "Your text", tlStart: 0, tlEnd: 0, position: "bottom-center", style: { style: "bold-clean" } }));
    setSel({ type: "overlay", id });
  };
  const addLogoFromImage = () => setPicker({ for: "image" });

  // ── clip duration probing (for trim bounds + split) ──
  const ensureDuration = useCallback((asset: string) => {
    setDurations((prev) => {
      if (prev[asset] != null) return prev;
      void videoEditorApi.getAssetMeta(projectId, asset)
        .then((m) => { if (m?.duration) setDurations((d) => ({ ...d, [asset]: m.duration })); })
        .catch(() => {});
      return prev;
    });
  }, [projectId]);

  // Probe durations for open-ended clips so trim/split have real bounds.
  useEffect(() => {
    for (const c of tl.tracks.video) if (!(c.srcOut > c.srcIn)) ensureDuration(c.asset);
  }, [tl.tracks.video, ensureDuration]);

  // ── split selected clip at its source midpoint ──
  const splitClip = (id: string) => {
    mutate((d) => {
      const arr = d.tracks.video;
      const i = arr.findIndex((c) => c.id === id);
      if (i < 0) return;
      const c = arr[i];
      const out = c.srcOut > c.srcIn ? c.srcOut : (durations[c.asset] || 0);
      if (!(out > c.srcIn + 0.4)) return;
      const mid = round1(c.srcIn + (out - c.srcIn) / 2);
      const a: TimelineClip = { ...c, id: uuid(), srcOut: mid, transitionOut: undefined };
      const b: TimelineClip = { ...c, id: uuid(), srcIn: mid, srcOut: round1(out), transitionIn: undefined };
      arr.splice(i, 1, a, b);
    });
  };

  // ── draggable trim handles on a clip block ──
  const startTrim = (e: React.PointerEvent, clip: TimelineClip, edge: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    const block = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
    const widthPx = block ? block.getBoundingClientRect().width : 200;
    const dispSec = clipDuration(clip) || 1;
    const pxPerSec = widthPx / dispSec;        // timeline-seconds per pixel
    const speed = clip.speed || 1;
    const startX = e.clientX;
    const startIn = clip.srcIn;
    const startOut = clip.srcOut > clip.srcIn ? clip.srcOut : (durations[clip.asset] || startIn + dispSec * speed);
    const maxDur = durations[clip.asset] || Number.MAX_SAFE_INTEGER;
    const onMove = (ev: PointerEvent) => {
      const deltaSource = ((ev.clientX - startX) / pxPerSec) * speed;
      if (edge === "in") {
        const ni = round1(Math.max(0, Math.min(startOut - 0.2, startIn + deltaSource)));
        patchClip(clip.id, { srcIn: ni });
        if (videoRef.current) { try { videoRef.current.currentTime = ni; } catch { /* */ } }
      } else {
        const no = round1(Math.max(startIn + 0.2, Math.min(maxDur, startOut + deltaSource)));
        patchClip(clip.id, { srcOut: no });
        if (videoRef.current) { try { videoRef.current.currentTime = Math.max(0, no - 0.1); } catch { /* */ } }
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── overlay drag-to-move on the stage ──
  const dragRef = useRef<{ id: string } | null>(null);
  const onOverlayPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    setSel({ type: "overlay", id });
    dragRef.current = { id };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    patchOverlay(dragRef.current.id, { xPct: round1(x * 100) / 100, yPct: round1(y * 100) / 100 });
  };
  const onStagePointerUp = () => { dragRef.current = null; };

  // ── persistence ──
  const save = async (): Promise<boolean> => {
    setSaving(true); setSaveError(null);
    try { await videoEditorApi.patchTimeline(projectId, tl); setDirty(false); return true; }
    catch (err) { setSaveError(err instanceof Error ? err.message : "Save failed"); return false; }
    finally { setSaving(false); }
  };
  const handleRender = async () => { if (dirty) { const ok = await save(); if (!ok) return; } onRender(tl); };

  const selOverlay = sel?.type === "overlay" ? overlays.find((o) => o.id === sel.id) : undefined;
  const selClip = sel?.type === "clip" ? clips.find((c) => c.id === sel.id) : undefined;
  const selAudio = sel?.type === "audio" ? audio.find((a) => a.id === sel.id) : undefined;

  return (
    <div className="vse-overlay" role="dialog" aria-modal="true" aria-label="Editor">
      <div className="vse-shell vse-shell--editable">
        {/* Header */}
        <div className="vse-header">
          <div className="vse-header-title">
            <span className="vse-header-badge">Editor</span>
            <span className="vse-header-name">{title || "Edit your video"}</span>
            {dirty && <span className="vse-dirty">● unsaved</span>}
          </div>
          <div className="vse-header-controls">
            <label>AR
              <select value={tl.export.aspectRatio} onChange={(e) => mutate((d) => { d.export.aspectRatio = e.target.value as any; })}>
                <option value="original">original</option><option value="16:9">16:9</option>
                <option value="9:16">9:16</option><option value="1:1">1:1</option>
              </select>
            </label>
            <label>Crop
              <select value={tl.export.cropMode} onChange={(e) => mutate((d) => { d.export.cropMode = e.target.value as any; })}>
                <option value="smart">smart</option><option value="fit-blur">fit-blur</option><option value="contain">contain</option>
              </select>
            </label>
            <label>Color
              <select value={tl.export.colorPreset} onChange={(e) => mutate((d) => { d.export.colorPreset = e.target.value as any; })}>
                <option value="none">none</option><option value="vivid">vivid</option><option value="muted">muted</option>
                <option value="bw">b&w</option><option value="warm">warm</option><option value="cool">cool</option>
              </select>
            </label>
            <span className="vse-total">{fmt(total)}</span>
          </div>
          <button type="button" className="vse-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="vse-body">
          {/* Left: stage + tracks */}
          <div className="vse-main">
            <div className="vse-stage-wrap">
              <div
                ref={stageRef}
                className="vse-stage"
                style={{ aspectRatio: String(aspect) }}
                onPointerMove={onStagePointerMove}
                onPointerUp={onStagePointerUp}
                onClick={() => setSel(null)}
              >
                {activeClip ? (
                  <>
                    {posterUrl && (
                      <img className="vse-stage-frame vse-stage-frame--bg" src={posterUrl} alt=""
                        style={{ objectFit: fit, filter: cFilter }} />
                    )}
                    {previewUrl && (
                      <video key={previewUrl} ref={videoRef} className="vse-stage-frame" src={previewUrl}
                        playsInline preload="metadata" style={{ objectFit: fit, filter: cFilter }}
                        onLoadedMetadata={onVideoMeta} onTimeUpdate={onVideoTime}
                        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                        onClick={(e) => { e.stopPropagation(); togglePlay(); }} />
                    )}
                  </>
                ) : (
                  <div className="vse-stage-empty">No clips — add one below</div>
                )}

                {overlays.map((ov) => {
                  const active = playheadTl >= (ov.tlStart || 0) && ((!ov.tlEnd || ov.tlEnd <= 0) || playheadTl <= ov.tlEnd);
                  const style = { ...overlayPosStyle(ov), opacity: active ? 1 : 0.4 };
                  const isSel = sel?.type === "overlay" && sel.id === ov.id;
                  const cls = `vse-ov ${isSel ? "vse-ov--sel" : ""}`;
                  if (ov.type === "text") {
                    return (
                      <div key={ov.id} className={cls} style={style}
                        onPointerDown={(e) => onOverlayPointerDown(e, ov.id)}>
                        <span className="vse-ov-text">{ov.content}</span>
                      </div>
                    );
                  }
                  const widthPercent = (ov.style?.widthPercent as number) || (ov.type === "logo" ? 8 : 28);
                  return (
                    <div key={ov.id} className={cls} style={{ ...style, width: `${widthPercent}%` }}
                      onPointerDown={(e) => onOverlayPointerDown(e, ov.id)}>
                      <img className="vse-ov-img" src={videoEditorApi.assetFrameUrl(projectId, ov.content, 0)} alt={ov.type}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                    </div>
                  );
                })}

                {activeClip && (
                  <div className="vse-stage-tag">Clip {previewIdx + 1} · {fmt(activeClip.srcIn)}–{activeClip.srcOut > 0 ? fmt(activeClip.srcOut) : "end"}{activeClip.speed !== 1 && ` · ${activeClip.speed}x`}</div>
                )}
              </div>

              {/* Transport */}
              <div className="vse-transport">
                <button type="button" className="vse-play" onClick={togglePlay} disabled={!previewUrl} aria-label={playing ? "Pause" : "Play"}>
                  {playing ? "❚❚" : "►"}
                </button>
                <input className="vse-scrub" type="range"
                  min={activeClip?.srcIn || 0}
                  max={Math.max((activeClip?.srcIn || 0) + 0.1, scrubMax)}
                  step={0.05} value={Math.min(curTime, Math.max((activeClip?.srcIn || 0) + 0.1, scrubMax))}
                  onChange={(e) => seekTo(Number(e.target.value))} disabled={!previewUrl} />
                <span className="vse-time">{fmt(Math.max(0, curTime - (activeClip?.srcIn || 0)))} / {fmt(Math.max(0, scrubMax - (activeClip?.srcIn || 0)))}</span>
              </div>
              <div className="vse-stage-hint">{previewUrl ? "Tap video to play · drag the logo to move · scrub to preview" : "Loading preview…"}</div>
            </div>

            {/* Tracks */}
            <div className="vse-tracks">
              <div className="vse-track">
                <div className="vse-track-label">🎬 Video</div>
                <div className="vse-track-lane">
                  {clips.length === 0 && <div className="vse-track-empty">No clips</div>}
                  {clips.map((clip, i) => {
                    const dur = clipDuration(clip) || 1;
                    const widthPct = total > 0 ? Math.max(8, (dur / total) * 100) : 100 / Math.max(1, clips.length);
                    const isSel = sel?.type === "clip" && sel.id === clip.id;
                    return (
                      <button type="button" key={clip.id}
                        className={`vse-clip ${i === previewIdx ? "vse-clip--active" : ""} ${isSel ? "vse-clip--sel" : ""}`}
                        style={{ width: `${widthPct}%`, backgroundImage: `url(${videoEditorApi.assetFrameUrl(projectId, clip.asset, posterTime(clip))})` }}
                        onClick={() => { setPreviewIdx(i); setSel({ type: "clip", id: clip.id }); ensureDuration(clip.asset); }}
                        title={`Clip ${i + 1}`}>
                        <span className="vse-clip-scrim" />
                        <span className="vse-clip-label">{i + 1}</span>
                        <span className="vse-clip-dur">{fmt(dur)}</span>
                        {clip.transitionOut && clip.transitionOut.type !== "none" && <span className="vse-clip-xfade">⤬</span>}
                        {isSel && <span className="vse-trim vse-trim--l" onPointerDown={(e) => startTrim(e, clip, "in")} title="Trim start" />}
                        {isSel && <span className="vse-trim vse-trim--r" onPointerDown={(e) => startTrim(e, clip, "out")} title="Trim end" />}
                      </button>
                    );
                  })}
                  <button type="button" className="vse-add-chip" onClick={() => setPicker({ for: "clip" })} title="Add clip">＋</button>
                </div>
              </div>

              {overlays.length > 0 && (
                <div className="vse-track">
                  <div className="vse-track-label">🖼 Overlays</div>
                  <div className="vse-track-lane vse-track-lane--overlays">
                    {overlays.map((ov) => {
                      const start = ov.tlStart || 0;
                      const end = ov.tlEnd && ov.tlEnd > 0 ? ov.tlEnd : total;
                      const leftPct = total > 0 ? (start / total) * 100 : 0;
                      const widthPct = total > 0 ? Math.max(12, ((end - start) / total) * 100) : 100;
                      const label = ov.type === "text" ? `“${ov.content}”` : (ov.content.split("/").pop() || ov.type);
                      const isSel = sel?.type === "overlay" && sel.id === ov.id;
                      return (
                        <button type="button" key={ov.id} className={`vse-ovbar vse-ovbar--${ov.type} ${isSel ? "vse-ovbar--sel" : ""}`}
                          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                          onClick={() => setSel({ type: "overlay", id: ov.id })}
                          title={`${label} · ${ov.position}`}>
                          <span>{ov.type === "text" ? "📝" : ov.type === "logo" ? "🏷" : "🎨"} {label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {audio.length > 0 && (
                <div className="vse-track">
                  <div className="vse-track-label">🎵 Audio</div>
                  <div className="vse-track-lane vse-track-lane--overlays">
                    {audio.map((a) => {
                      const start = a.tlStart || 0;
                      const end = a.tlEnd && a.tlEnd > 0 ? a.tlEnd : total;
                      const leftPct = total > 0 ? (start / total) * 100 : 0;
                      const widthPct = total > 0 ? Math.max(12, ((end - start) / total) * 100) : 100;
                      const isSel = sel?.type === "audio" && sel.id === a.id;
                      return (
                        <button type="button" key={a.id} className={`vse-ovbar vse-ovbar--audio ${isSel ? "vse-ovbar--sel" : ""}`}
                          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                          onClick={() => setSel({ type: "audio", id: a.id })}
                          title={a.asset.split("/").pop() || "audio"}>
                          <span>🎵 {a.asset.split("/").pop()}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="vse-add-row">
                <button type="button" className="vse-add-btn" onClick={() => setPicker({ for: "clip" })}>＋ Clip</button>
                <button type="button" className="vse-add-btn" onClick={addLogoFromImage}>＋ Logo/Image</button>
                <button type="button" className="vse-add-btn" onClick={addText}>＋ Text</button>
                <button type="button" className="vse-add-btn" onClick={() => setPicker({ for: "audio" })}>＋ Audio</button>
              </div>
            </div>
          </div>

          {/* Right: inspector */}
          <div className="vse-inspector">
            {!sel && <div className="vse-inspector-empty">Select a clip or overlay to edit it.</div>}

            {selClip && (
              <div className="vse-insp">
                <div className="vse-insp-title">Clip {clips.findIndex((c) => c.id === selClip.id) + 1}</div>
                <label className="vse-field">Trim start (s)
                  <input type="number" min={0} step={0.1} value={selClip.srcIn}
                    onChange={(e) => patchClip(selClip.id, { srcIn: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <label className="vse-field">Trim end (s, 0=end)
                  <input type="number" min={0} step={0.1} value={selClip.srcOut}
                    onChange={(e) => patchClip(selClip.id, { srcOut: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <label className="vse-field">Speed ({selClip.speed}x)
                  <input type="range" min={0.25} max={4} step={0.05} value={selClip.speed}
                    onChange={(e) => patchClip(selClip.id, { speed: Number(e.target.value) })} />
                </label>
                <label className="vse-field">Transition out
                  <select value={selClip.transitionOut?.type || "none"}
                    onChange={(e) => patchClip(selClip.id, { transitionOut: { type: e.target.value as TransitionType, duration: selClip.transitionOut?.duration || 0.4 } })}>
                    {TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                {durations[selClip.asset] != null && (
                  <div className="vse-field-static">Source length: {fmt(durations[selClip.asset])}</div>
                )}
                <div className="vse-insp-actions">
                  <button type="button" onClick={() => moveClip(selClip.id, -1)}>◀ Move</button>
                  <button type="button" onClick={() => moveClip(selClip.id, 1)}>Move ▶</button>
                  <button type="button" onClick={() => splitClip(selClip.id)}>✂ Split</button>
                  <button type="button" className="vse-danger" onClick={removeSelected}>🗑 Delete</button>
                </div>
              </div>
            )}

            {selOverlay && (
              <div className="vse-insp">
                <div className="vse-insp-title">{selOverlay.type === "text" ? "Text" : selOverlay.type === "logo" ? "Logo" : "Image"} overlay</div>
                {selOverlay.type === "text" && (
                  <label className="vse-field">Text
                    <textarea rows={2} value={selOverlay.content} onChange={(e) => patchOverlay(selOverlay.id, { content: e.target.value })} />
                  </label>
                )}
                <div className="vse-field">Position
                  <div className="vse-anchor-grid">
                    {ANCHORS.map((a) => (
                      <button type="button" key={a}
                        className={selOverlay.xPct == null && selOverlay.position === a ? "vse-anchor--active" : ""}
                        onClick={() => patchOverlay(selOverlay.id, { position: a, xPct: undefined, yPct: undefined })}>
                        {a.replace("-", " ")}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="vse-field">X ({Math.round((selOverlay.xPct ?? anchorToXY(selOverlay.position).x) * 100)}%)
                  <input type="range" min={0} max={100}
                    value={Math.round((selOverlay.xPct ?? anchorToXY(selOverlay.position).x) * 100)}
                    onChange={(e) => patchOverlay(selOverlay.id, { xPct: Number(e.target.value) / 100, yPct: selOverlay.yPct ?? anchorToXY(selOverlay.position).y })} />
                </label>
                <label className="vse-field">Y ({Math.round((selOverlay.yPct ?? anchorToXY(selOverlay.position).y) * 100)}%)
                  <input type="range" min={0} max={100}
                    value={Math.round((selOverlay.yPct ?? anchorToXY(selOverlay.position).y) * 100)}
                    onChange={(e) => patchOverlay(selOverlay.id, { yPct: Number(e.target.value) / 100, xPct: selOverlay.xPct ?? anchorToXY(selOverlay.position).x })} />
                </label>
                <div className="vse-field-static">{selOverlay.xPct != null ? "Free position — drag it on the preview, or use X/Y." : "Anchored — drag on preview or set X/Y for an exact spot."}</div>
                {selOverlay.type !== "text" && (
                  <label className="vse-field">Size ({Math.round((selOverlay.style?.widthPercent as number) || (selOverlay.type === "logo" ? 8 : 28))}%)
                    <input type="range" min={3} max={60} step={1}
                      value={(selOverlay.style?.widthPercent as number) || (selOverlay.type === "logo" ? 8 : 28)}
                      onChange={(e) => patchOverlayStyle(selOverlay.id, { widthPercent: Number(e.target.value) })} />
                  </label>
                )}
                <label className="vse-field">Show from (s)
                  <input type="number" min={0} step={0.1} value={selOverlay.tlStart || 0}
                    onChange={(e) => patchOverlay(selOverlay.id, { tlStart: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <label className="vse-field">Show until (s, 0=end)
                  <input type="number" min={0} step={0.1} value={selOverlay.tlEnd || 0}
                    onChange={(e) => patchOverlay(selOverlay.id, { tlEnd: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <div className="vse-insp-actions">
                  <button type="button" className="vse-danger" onClick={removeSelected}>🗑 Delete</button>
                </div>
              </div>
            )}

            {selAudio && (
              <div className="vse-insp">
                <div className="vse-insp-title">Audio</div>
                <div className="vse-field-static">{selAudio.asset.split("/").pop()}</div>
                <label className="vse-field">Volume ({selAudio.volumeDb} dB)
                  <input type="range" min={-30} max={6} step={1} value={selAudio.volumeDb}
                    onChange={(e) => patchAudio(selAudio.id, { volumeDb: Number(e.target.value) })} />
                </label>
                <label className="vse-field">Fade in (s)
                  <input type="number" min={0} step={0.1} value={selAudio.fadeIn}
                    onChange={(e) => patchAudio(selAudio.id, { fadeIn: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <label className="vse-field">Fade out (s)
                  <input type="number" min={0} step={0.1} value={selAudio.fadeOut}
                    onChange={(e) => patchAudio(selAudio.id, { fadeOut: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <div className="vse-insp-actions">
                  <button type="button" className="vse-danger" onClick={removeSelected}>🗑 Delete</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="vse-footer">
          {saveError && <span className="vse-save-error">{saveError}</span>}
          <button type="button" className="vse-btn vse-btn--ghost" onClick={onChangePlan} disabled={busy || saving}>✏ Ask agent</button>
          <button type="button" className="vse-btn vse-btn--ghost" onClick={() => void save()} disabled={busy || saving || !dirty}>{saving ? "Saving…" : dirty ? "💾 Save" : "Saved"}</button>
          <button type="button" className="vse-btn vse-btn--primary" onClick={() => void handleRender()} disabled={busy || saving || clips.length === 0}>{busy ? "Rendering…" : "✓ Render"}</button>
        </div>

        {picker && (
          <AssetPicker
            projectId={projectId}
            kind={picker.for === "clip" ? "video" : picker.for === "image" ? "image" : "audio"}
            onClose={() => setPicker(null)}
            onPick={(path, kind) => void addAsset(path, kind)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Asset picker (lists workspace uploads, lets user upload more) ─────────────
function AssetPicker({
  projectId, kind, onClose, onPick,
}: {
  projectId: string;
  kind: AssetKind;
  onClose: () => void;
  onPick: (path: string, kind: AssetKind) => void;
}) {
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    setLoading(true);
    void workspaceApi.listFiles(`editor/uploads/${projectId}/`, 100)
      .then((res) => setFiles((res.files || []).filter((f) => f.path && !f.path.endsWith("/") && assetKind(f.path) === kind)))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, [projectId, kind]);
  useEffect(() => { reload(); }, [reload]);

  const onUpload = async (file: File) => {
    setUploading(true);
    try {
      const role = kind === "video" ? "source" : kind === "audio" ? "audio" : "logo";
      const wf = await videoEditorApi.uploadAsset(projectId, role as any, file);
      registerLocalMedia(wf.path, file);
      onPick(wf.path, kind);
    } catch { /* ignore */ }
    finally { setUploading(false); }
  };

  return (
    <div className="vse-picker-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="vse-picker">
        <div className="vse-picker-head">
          <span>Add {kind}</span>
          <button type="button" className="vse-close" onClick={onClose}>×</button>
        </div>
        <button type="button" className="vse-picker-upload" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? "Uploading…" : "⤴ Upload new file"}
        </button>
        <input ref={fileRef} type="file" hidden
          accept={kind === "video" ? "video/*" : kind === "audio" ? "audio/*" : "image/*"}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }} />
        <div className="vse-picker-list">
          {loading && <div className="vse-picker-empty">Loading…</div>}
          {!loading && files.length === 0 && <div className="vse-picker-empty">No {kind} files yet — upload one.</div>}
          {!loading && files.map((f) => {
            const name = f.path.split("/").pop() || f.path;
            return (
              <button type="button" key={f.path} className="vse-picker-item" onClick={() => onPick(f.path, kind)}>
                <span>{kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "🖼"} {name}</span>
                <span className="vse-picker-size">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function structuredCloneSafe<T>(v: T): T {
  try { if (typeof structuredClone === "function") return structuredClone(v); } catch { /* */ }
  return JSON.parse(JSON.stringify(v));
}

export default VideoStudioReviewEditor;
