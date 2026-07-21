import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Plus, AudioLines, ArrowUp, Loader2,
  Download, Captions, Scissors,
  AlarmClock, UploadCloud,
  Paperclip, ImagePlus, Music2, Search, Clapperboard,
  Bell, X, Newspaper, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type Mode =
  | "home" | "copilot" | "download" | "clips" | "subtitles"
  | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps"
  | "upload" | "translator" | "findvideo" | "content-manager" | "videostudio" | "help" | "activity";
const ULTRA_KEY = "studio-ultra-mode";
const REASONING_KEY = "studio-reasoning-mode";
const HOME_UPDATES_KEY = "studio-home-updates-read-v1";

const HOME_UPDATES = [
  {
    id: "content-manager-video-link-2026-07-07",
    label: "New",
    date: "7/7/26",
    title: "Content Manager now watches and analyzes videos",
    summary: "Paste an unlisted YouTube video link, select a channel, and AI watches the video context to create the best title, description, tags, SEO pack, and more.",
    mode: "content-manager" as Mode,
    visual: "content" as const,
  },
  {
    id: "content-manager",
    label: "New",
    date: "Earlier",
    title: "AI YT Channel Strategist",
    summary: "Next video title, description, tags, and many more. All in one place, your personalized AI channel strategist.",
    mode: "content-manager" as Mode,
    visual: "content" as const,
  },
  {
    id: "find-video",
    label: "Updated",
    date: "Recent",
    title: "Find Video",
    summary: "Search the Bhavishya Malika knowledge base with chat history, full database mode, live thinking, and stop controls.",
    mode: "findvideo" as Mode,
    visual: "find" as const,
  },
];

type HomeUpdate = typeof HOME_UPDATES[number];

// ── Animated typing placeholder ───────────────────────────────────────────────
const PLACEHOLDER_SUGGESTIONS = [
  "Cut a clip from any YouTube video...",
  "Make music for my documentary...",
  "Generate timestamps for this video...",
  "Write a YouTube script about...",
  "Find the best clips from this video...",
  "Generate subtitles and translate...",
  "Download this video in 4K...",
  "Create a thumbnail image for...",
  "Analyze this video and summarize...",
];

type TypingPhase = "typing" | "paused" | "deleting";

function useTypingPlaceholder(active: boolean) {
  const [displayText, setDisplayText] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);
  const [phase, setPhase] = useState<TypingPhase>("typing");
  const [suggIdx, setSuggIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [blinkCount, setBlinkCount] = useState(0);

  useEffect(() => {
    if (!active) return;
    const suggestion = PLACEHOLDER_SUGGESTIONS[suggIdx];
    if (phase === "typing") {
      if (charIdx < suggestion.length) {
        const t = setTimeout(() => { setDisplayText(suggestion.slice(0, charIdx + 1)); setCharIdx(c => c + 1); }, 48);
        return () => clearTimeout(t);
      } else { setPhase("paused"); setBlinkCount(0); }
    }
    if (phase === "paused") {
      if (blinkCount < 4) {
        const t = setTimeout(() => { setCursorVisible(v => !v); setBlinkCount(b => b + 1); }, 420);
        return () => clearTimeout(t);
      } else { setCursorVisible(true); setPhase("deleting"); }
    }
    if (phase === "deleting") {
      if (charIdx > 0) {
        const t = setTimeout(() => { setCharIdx(c => c - 1); setDisplayText(suggestion.slice(0, charIdx - 1)); }, 28);
        return () => clearTimeout(t);
      } else {
        const t = setTimeout(() => { setSuggIdx(i => (i + 1) % PLACEHOLDER_SUGGESTIONS.length); setPhase("typing"); setBlinkCount(0); setCursorVisible(true); }, 320);
        return () => clearTimeout(t);
      }
    }
    return undefined;
  }, [active, phase, charIdx, suggIdx, blinkCount]);

  return { displayText, cursorVisible };
}

function readUltraInitial(): boolean {
  try { return localStorage.getItem(ULTRA_KEY) === "1"; } catch { return false; }
}

function readHomeUpdatesInitial(): string[] {
  try {
    const raw = localStorage.getItem(HOME_UPDATES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function HomeUpdateVisual({ type }: { type: HomeUpdate["visual"] }) {
  const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const imgSrc = type === "content" 
    ? `${BASE}/content_manager_preview.png` 
    : `${BASE}/find_video_preview.png`;
    
  return (
    <div className={`home-update-visual home-update-visual-${type}`} aria-hidden="true">
      <img 
        src={imgSrc} 
        alt={type === "content" ? "Content Manager" : "Find Video"} 
        className="home-update-visual-image"
      />
    </div>
  );
}


export function StudioHome({
  onSwitchMode,
  onLaunchAgent,
}: {
  onSwitchMode: (m: Mode) => void;
  onLaunchAgent: (prompt: string) => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [ultra, setUltra] = useState<boolean>(readUltraInitial);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [activeUpdate, setActiveUpdate] = useState<HomeUpdate | null>(null);
  const [readUpdates, setReadUpdates] = useState<string[]>(readHomeUpdatesInitial);
  const [recentUpdatesOpen, setRecentUpdatesOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    });
  }, []);
  const placeholderActive = !text && !textareaFocused;
  const { displayText: placeholderText, cursorVisible: placeholderCursor } = useTypingPlaceholder(placeholderActive);
  const recognitionRef = useRef<any>(null);
  const unreadUpdates = HOME_UPDATES.filter((update) => !readUpdates.includes(update.id));
  const visibleUpdates = HOME_UPDATES.slice(0, 2);
  const recentUpdates = HOME_UPDATES.slice(2);

  const markUpdateRead = (id: string) => {
    setReadUpdates((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      try { localStorage.setItem(HOME_UPDATES_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
  };

  const openUpdate = (update: HomeUpdate) => {
    markUpdateRead(update.id);
    setActiveUpdate(update);
    setUpdatesOpen(false);
  };

  // Speech recognition is available in Chrome/Edge/Safari on HTTPS or localhost.
  // Firefox and non-secure origins do NOT support the Web Speech API.
  const speechSupported = typeof window !== "undefined" &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  useEffect(() => {
    try {
      localStorage.setItem(ULTRA_KEY, ultra ? "1" : "0");
    } catch { }
  }, [ultra]);

  const setUltraMode = (next: boolean) => {
    setUltra(next);
    try {
      localStorage.setItem(ULTRA_KEY, next ? "1" : "0");
      localStorage.setItem(REASONING_KEY, next ? "advanced" : "flash");
    } catch { }
  };

  // Stop recognition if the component unmounts mid-listen.
  useEffect(() => () => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    recognitionRef.current = null;
  }, []);

  const [activeUploads, setActiveUploads] = useState(0);
  const uploading = activeUploads > 0;

  const submit = () => {
    const t = text.trim();
    if (!t || uploading) return;
    onLaunchAgent(t);
    setText("");
    setShowPlusMenu(false);
    resizeTextarea();
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast({ title: "Voice input not supported", description: "Try Chrome, Edge, or Safari." });
      return;
    }
    if (listening) {
      try { recognitionRef.current?.stop(); } catch { }
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e: any) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      setText(prev => (prev + (prev ? " " : "") + transcript).trimStart());
      resizeTextarea();
    };
    rec.onend = () => { setListening(false); recognitionRef.current = null; };
    rec.onerror = () => { setListening(false); recognitionRef.current = null; };
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = text.trim().length > 0 && !uploading;
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    if (!showPlusMenu) return;
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPlusMenu]);

  const uploadFileInternal = async (file: File) => {
    // Client-side guard: single-part upload limit is 50 MB
    const MAX_SINGLE_MB = 50;
    if (file.size > MAX_SINGLE_MB * 1024 * 1024) {
      toast({
        title: "File too large",
        description: `Attachments must be under ${MAX_SINGLE_MB} MB. Use the Share tab for larger files.`,
        variant: "destructive",
      });
      return;
    }
    try {
      const res = await fetch(`${BASE}/api/uploads/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size, mimeType: file.type || "application/octet-stream", visibility: "public" })
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})) as any; throw new Error(e?.error ?? `Server error ${res.status}`); }
      const { fileId, uploadType, presignedUrl } = await res.json();
      if (uploadType !== "single") throw new Error(`File too large for quick attach (max ${MAX_SINGLE_MB} MB).`);
      const putRes = await fetch(presignedUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!putRes.ok) throw new Error(`S3 upload failed (${putRes.status})`);
      const compRes = await fetch(`${BASE}/api/uploads/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId, parts: [] }) });
      if (!compRes.ok) throw new Error("Could not finalize upload");
      const comp = await compRes.json();
      setText(prev => prev ? prev + "\n" + comp.shareUrl : comp.shareUrl);
      resizeTextarea();
      toast({ title: "File attached ✓", description: `${file.name} added to your message.` });
    } catch (err: any) {
      toast({ title: "Attachment failed", description: err.message, variant: "destructive" });
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setActiveUploads(count => count + files.length);
    try {
      for (const file of files) {
        try {
          await uploadFileInternal(file);
        } catch (err: any) {
          toast({ title: "Attachment failed", description: err.message, variant: "destructive" });
        } finally {
          setActiveUploads(count => Math.max(0, count - 1));
        }
      }
    } finally {
      resizeTextarea();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    try {
      await uploadFiles(files);
    } finally {
      // Always reset the input — without this, picking the same file twice
      // in a row silently no-ops because `change` doesn't fire on identical values.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(i => i.type.startsWith("image/"));
    if (!imageItem) return; // let normal text paste through
    const pastedText = e.clipboardData.getData("text/plain");
    e.preventDefault();
    if (pastedText) {
      const target = e.currentTarget;
      const start = target.selectionStart ?? text.length;
      const end = target.selectionEnd ?? start;
      setText(prev => prev.slice(0, start) + pastedText + prev.slice(end));
      resizeTextarea();
    }
    const rawFile = imageItem.getAsFile();
    if (!rawFile) return;
    // Clipboard images often have an empty or generic name — give them a timestamped one
    const ext = imageItem.type.split("/")[1] ?? "png";
    const named = rawFile.name && rawFile.name !== "image.png"
      ? rawFile
      : new File([rawFile], `pasted-image-${Date.now()}.${ext}`, { type: imageItem.type });
    await uploadFiles([named]);
  };

  /* ── Animated background orbs (canvas) ──────────────────────── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d")!;
    let raf = 0;

    const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    const randSign = () => (Math.random() < 0.5 ? -1 : 1);
    const makeTarget = () => ({
      x: rand(-0.08, 1.08),
      y: rand(-0.08, 0.92),
    });

    const orbs = Array.from({ length: 8 }, () => {
      const baseHue = rand(0, 360);
      const target = makeTarget();
      return {
        x: rand(-0.04, 1.04),
        y: rand(-0.04, 0.88),
        targetX: target.x,
        targetY: target.y,
        r: rand(170, 340),
        speed: rand(0.018, 0.09),
        retargetAt: rand(900, 5200),
        wobbleX: randSign() * rand(0.006, 0.025),
        wobbleY: randSign() * rand(0.006, 0.025),
        wobbleSpeed: rand(0.16, 0.58),
        wobblePhase: rand(0, Math.PI * 2),
        hue: baseHue,
        hueSpeed: randSign() * rand(8, 35),
        sat: rand(55, 85),
        alpha: rand(0.14, 0.34),
        alphaSpeed: rand(0.22, 1.15),
        alphaPhase: rand(0, Math.PI * 2),
        scaleSpeed: rand(0.12, 0.62),
        scalePhase: rand(0, Math.PI * 2),
      };
    });

    // Cap DPR — on retina/4K screens the raw devicePixelRatio multiplies
    // canvas pixel count (and the cost of the CSS blur applied to it) far
    // beyond what's visible once blurred.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    const resize = () => {
      cvs.width = cvs.offsetWidth * dpr;
      cvs.height = cvs.offsetHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    let last = 0;
    let paused = document.hidden;
    const FRAME_INTERVAL = 1000 / 30; // throttle to ~30fps — motion is slow/ambient

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (paused || t - last < FRAME_INTERVAL) return;
      const dt = Math.min(last ? (t - last) / 1000 : 0.016, 0.05);
      last = t;
      const w = cvs.width, h = cvs.height;
      ctx.clearRect(0, 0, w, h);

      for (const o of orbs) {
        const dx = o.targetX - o.x;
        const dy = o.targetY - o.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (t >= o.retargetAt || dist < 0.035) {
          const target = makeTarget();
          o.targetX = target.x;
          o.targetY = target.y;
          o.speed = rand(0.018, 0.09);
          o.retargetAt = t + rand(1300, 6800);
          o.wobbleX = randSign() * rand(0.006, 0.025);
          o.wobbleY = randSign() * rand(0.006, 0.025);
          o.wobbleSpeed = rand(0.16, 0.58);
        }

        const wobble = Math.sin(t * 0.001 * o.wobbleSpeed + o.wobblePhase);
        o.x += (dx / dist) * o.speed * dt + wobble * o.wobbleX * dt;
        o.y += (dy / dist) * o.speed * dt + Math.cos(t * 0.001 * o.wobbleSpeed + o.wobblePhase) * o.wobbleY * dt;

        o.hue = (o.hue + o.hueSpeed * dt) % 360;
        const pulse = Math.sin(t * 0.001 * o.alphaSpeed + o.alphaPhase);
        const alpha = Math.max(0.05, o.alpha + pulse * 0.11);
        const scale = 1 + Math.sin(t * 0.001 * o.scaleSpeed + o.scalePhase) * 0.18;
        const px = o.x * w, py = o.y * h, pr = o.r * scale * dpr;

        const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, `hsla(${o.hue}, ${o.sat}%, 55%, ${alpha})`);
        g.addColorStop(0.45, `hsla(${o.hue + 30}, ${o.sat - 10}%, 40%, ${alpha * 0.4})`);
        g.addColorStop(1, `hsla(${o.hue + 60}, ${o.sat}%, 30%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);

    // Stop drawing entirely while the tab is hidden — no point burning
    // CPU/battery on an animation nobody can see.
    const onVisibility = () => { paused = document.hidden; if (!paused) last = 0; };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="gs-home">
      <canvas ref={canvasRef} className="gs-home-orbs-canvas" style={{ filter: "blur(80px)" }} />
      <div className="home-update-anchor">
        <button
          type="button"
          className={cn("home-update-bell", updatesOpen && "home-update-bell-active")}
          onClick={() => setUpdatesOpen(v => !v)}
          aria-label={`Notifications${unreadUpdates.length ? `, ${unreadUpdates.length} unread` : ""}`}
          title="Latest updates"
        >
          <Bell className="w-4 h-4" />
          {unreadUpdates.length > 0 && <span className="home-update-badge">{unreadUpdates.length}</span>}
        </button>

        {updatesOpen && (
          <div className="home-update-popover">
            <div className="home-update-popover-head">
              <div>
                <span>Latest updates</span>
                <p>New tools added to your workspace</p>
              </div>
              <button type="button" onClick={() => setUpdatesOpen(false)} aria-label="Close updates">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="home-update-list">
              {visibleUpdates.map((update) => {
                const read = readUpdates.includes(update.id);
                return (
                  <button
                    key={update.id}
                    type="button"
                    className={cn("home-update-card", read && "home-update-card-read")}
                    onClick={() => openUpdate(update)}
                  >
                    <HomeUpdateVisual type={update.visual} />
                    <span className="home-update-card-copy">
                      <i>{update.date}</i>
                      <b>{update.title}</b>
                      <small>{update.summary}</small>
                      <em>{read ? "Read again" : "Read more"}</em>
                    </span>
                    {!read && <span className="home-update-dot" />}
                  </button>
                );
              })}
              {recentUpdates.length > 0 ? (
                <div className="home-update-recent-group">
                  <button
                    type="button"
                    className={cn("home-update-recent-toggle", recentUpdatesOpen && "is-open")}
                    onClick={() => setRecentUpdatesOpen((v) => !v)}
                    aria-expanded={recentUpdatesOpen}
                  >
                    <span>Recent</span>
                    <em>{recentUpdates.length} older update{recentUpdates.length !== 1 ? "s" : ""}</em>
                    <ChevronDown className="w-4 h-4" />
                  </button>
                  {recentUpdatesOpen ? (
                    <div className="home-update-recent-list">
                      {recentUpdates.map((update) => {
                        const read = readUpdates.includes(update.id);
                        return (
                          <button
                            key={update.id}
                            type="button"
                            className={cn("home-update-card", read && "home-update-card-read")}
                            onClick={() => openUpdate(update)}
                          >
                            <HomeUpdateVisual type={update.visual} />
                            <span className="home-update-card-copy">
                              <i>{update.date}</i>
                              <b>{update.title}</b>
                              <small>{update.summary}</small>
                              <em>{read ? "Read again" : "Read more"}</em>
                            </span>
                            {!read && <span className="home-update-dot" />}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {activeUpdate && (
        <div className="home-update-modal-backdrop" role="dialog" aria-modal="true" aria-label={activeUpdate.title}>
          <div className="home-update-modal">
            <button
              type="button"
              className="home-update-modal-close"
              onClick={() => setActiveUpdate(null)}
              aria-label="Close update"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="home-update-modal-copy">
              <span>{activeUpdate.label} · {activeUpdate.date}</span>
              <h2>{activeUpdate.title}</h2>
              <p>{activeUpdate.summary}</p>
              <button
                type="button"
                onClick={() => {
                  setActiveUpdate(null);
                  onSwitchMode(activeUpdate.mode);
                }}
              >
                Open {activeUpdate.title}
              </button>
            </div>
            <HomeUpdateVisual type={activeUpdate.visual} />
          </div>
        </div>
      )}

      <div className="gs-home-center">
        {/* Title */}
        <h1 className="gs-home-title">
          <span className="gs-home-title-text gs-home-title-full">Narayan Bhakt Studio Workspace</span>
          <span className="gs-home-title-text gs-home-title-mobile">Narayan Bhakt Workspace</span>
        </h1>

        {/* Big input box */}
        <form
          className="gs-input-card"
          onSubmit={e => { e.preventDefault(); submit(); }}
        >
          <div style={{ position: "relative" }}>
            {placeholderActive && (
              <div
                className="pointer-events-none select-none gs-input-textarea"
                style={{
                  position: "absolute", top: 0, left: 0, right: 0,
                  color: "rgba(255,255,255,0.3)", pointerEvents: "none",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  zIndex: 1, background: "transparent",
                  border: "none", boxShadow: "none",
                }}
              >
                {placeholderText}<span style={{ opacity: placeholderCursor ? 1 : 0, transition: "opacity 0.08s" }}>|</span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="gs-input-textarea"
              placeholder=""
              value={text}
              onFocus={() => setTextareaFocused(true)}
              onBlur={() => setTextareaFocused(false)}
              onChange={e => {
                setText(e.target.value);
                resizeTextarea();
              }}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={handlePaste}
              rows={1}
              style={{ position: "relative", zIndex: 2, background: "transparent" }}
            />
          </div>

          <div className="gs-input-row">
            <div className="gs-input-row-left">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*,video/*,audio/*,.pdf,.srt,.vtt,.txt,.csv,.json,.docx,.xlsx"
                multiple
                onChange={handleFileUpload}
              />
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  className={cn("gs-input-circle-btn", showPlusMenu && "gs-input-circle-btn-active")}
                  title="More options"
                  aria-label="More options"
                  onClick={() => setShowPlusMenu(v => !v)}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {showPlusMenu && (
                  <div className="gs-plus-menu">
                    <button
                      type="button"
                      className="gs-plus-menu-item"
                      disabled={uploading}
                      onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); }}
                    >
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      <span>Upload Files</span>
                    </button>
                    <button
                      type="button"
                      className="gs-plus-menu-item"
                      onClick={() => {
                        const prompt = "Create an image";
                        setText(prev => prev ? prev + "\n" + prompt : prompt);
                        setShowPlusMenu(false);
                        setTimeout(() => textareaRef.current?.focus(), 50);
                      }}
                    >
                      <ImagePlus className="w-4 h-4" />
                      <span>Create Images</span>
                    </button>
                    <button
                      type="button"
                      className="gs-plus-menu-item"
                      onClick={() => {
                        const prompt = "Make music";
                        setText(prev => prev ? prev + "\n" + prompt : prompt);
                        setShowPlusMenu(false);
                        setTimeout(() => textareaRef.current?.focus(), 50);
                      }}
                    >
                      <Music2 className="w-4 h-4" />
                      <span>Create Music</span>
                      <span className="gs-plus-menu-badge gs-plus-menu-badge-new">New</span>
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={cn("gs-pill-ultra", ultra && "gs-pill-ultra-active")}
                title={ultra ? "Ultra mode ON — uses Pro model" : "Ultra mode OFF — uses default model"}
                aria-pressed={ultra}
                onClick={() => setUltraMode(!ultra)}
              >
                <span className="gs-pill-ultra-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M12 2 L14 9 L21 12 L14 15 L12 22 L10 15 L3 12 L10 9 Z" />
                  </svg>
                </span>
                Ultra
              </button>
            </div>
            <div className="gs-input-row-right">
              {/* Speak button: always shown; dimmed with tooltip when browser doesn't support Web Speech API */}
              <button
                type="button"
                className={cn(
                  "gs-pill-speak",
                  listening && "gs-pill-speak-active",
                  !speechSupported && "opacity-40 cursor-not-allowed",
                )}
                title={
                  !speechSupported
                    ? "Voice input requires Chrome, Edge, or Safari"
                    : listening ? "Stop listening" : "Speak"
                }
                aria-pressed={listening}
                aria-disabled={!speechSupported}
                onClick={toggleVoice}
              >
                <AudioLines className="w-3.5 h-3.5" />
                <span>{listening ? "Listening…" : "Speak"}</span>
              </button>
              <button
                type="submit"
                disabled={!canSend}
                className={cn("gs-send-btn", canSend ? "gs-send-active" : "gs-send-disabled")}
                title="Send"
                aria-label="Send"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            </div>
          </div>
        </form>

        {/* Tool bubbles — grid layout */}
        <div className="studio-home-grid mt-4">
          {([
            { icon: <Newspaper className="w-5 h-5" />, label: "Content", desc: "Plan next upload", mode: "content-manager", color: "text-red-300", badge: "New" },
            { icon: <Search className="w-5 h-5" />, label: "Find Video", desc: "Ask NotebookLM", mode: "findvideo", color: "text-sky-400", badge: "New" },
            { icon: <Scissors className="w-5 h-5" />, label: "Clip Cutter", desc: "Trim any range", mode: "clipcutter", color: "text-orange-400" },
            { icon: <Captions className="w-5 h-5" />, label: "Subtitles", desc: "Auto + translate", mode: "subtitles", color: "text-blue-400" },
            { icon: <AlarmClock className="w-5 h-5" />, label: "Timestamps", desc: "Chapter markers", mode: "timestamps", color: "text-purple-400" },
            { icon: <Clapperboard className="w-5 h-5" />, label: "AI Studio", desc: "Finish videos", mode: "videostudio", color: "text-emerald-400" },
            { icon: <Download className="w-5 h-5" />, label: "Download", desc: "MP4, Audio, 4K", mode: "download", color: "text-red-400" },
            { icon: <UploadCloud className="w-5 h-5" />, label: "Share", desc: "Share files", mode: "upload", color: "text-cyan-400" },
          ] as Array<{ icon: React.ReactNode; label: string; desc: string; mode: string; color: string; badge?: string }>).map((tool) => (
            <button
              key={tool.mode}
              onClick={() => onSwitchMode(tool.mode as Mode)}
              className="studio-home-tool"
            >
              {tool.badge ? <span className="studio-home-tool-badge">{tool.badge}</span> : null}
              <span className={tool.color}>{tool.icon}</span>
              <div className="studio-home-tool-text">
                <span className="studio-home-tool-label">{tool.label}</span>
                <span className="studio-home-tool-desc">{tool.desc}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
