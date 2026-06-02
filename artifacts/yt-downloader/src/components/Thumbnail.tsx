import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Loader2, Download, X, Plus,
  ArrowUp, Square, Wand2, Maximize2, SquarePen, ChevronRight, History, Trash2,
  Settings2, Check, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ThumbnailPresets, type PresetSummary } from "@/components/ThumbnailPresets";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const MAX_IMAGES = 10;
const HISTORY_KEY = "thumbnail-studio-history-v1";
const ACTIVE_PRESET_KEY = "thumbnail-studio-active-preset";
const MAX_SAVED_CHATS = 10;

// ── Types (fully independent from the Super Agent) ──────────────────────────
type ThumbPart =
  | { kind: "text"; content: string }
  | { kind: "thinking"; label: string; thoughts: string; live: boolean }
  | { kind: "images"; items: Array<{ previewUrl: string; name: string }> }
  | { kind: "thumb"; status: "loading" | "done" | "error"; mode?: string; imageUrl?: string; filename?: string; message?: string };

type ThumbMessage = { id: string; role: "user" | "assistant"; parts: ThumbPart[] };

type ThumbEvent =
  | { type: "ready"; runId: string; model?: string }
  | { type: "think"; runId?: string; stage?: string; beat?: boolean }
  | { type: "thought"; runId?: string; content: string }
  | { type: "plan"; runId?: string; steps?: Array<{ tool: string }> }
  | { type: "text"; runId?: string; content: string }
  | { type: "thumb_start"; runId?: string; toolId: string; mode?: string }
  | { type: "thumb_progress"; runId?: string; toolId: string; status?: string; message?: string }
  | { type: "thumb_done"; runId?: string; toolId: string; imageUrl: string; filename?: string; note?: string }
  | { type: "error"; runId?: string; message: string }
  | { type: "done"; runId?: string };

type PendingAttachment = { id: string; name: string; mimeType: string; data: string; previewUrl: string };

// ── Saved chat (browser localStorage, last 10) ──────────────────────────────
type SavedChat = { id: string; title: string; updatedAt: number; messages: ThumbMessage[] };

// ── Quick-start suggestions — a big pool; we show a few and reshuffle ───────
const STARTER_POOL: string[] = [
  "Bhavishya Malika prophecy thumbnail with divine golden glow",
  "Motivational talk thumbnail, shocked face, huge DON'T QUIT",
  "Tech review thumbnail, dark bg, bold IS IT WORTH IT?",
  "Podcast cover with two mics and a vibrant gradient",
  "Gaming thumbnail with neon glow and an epic explosion",
  "Cooking video thumbnail, close-up dish, mouth-watering",
  "Finance thumbnail with money rain and a green chart",
  "Fitness transformation thumbnail, before and after split",
  "Travel vlog thumbnail with a stunning mountain sunset",
  "True-crime thumbnail, moody, dramatic red spotlight",
  "Devotional thumbnail with warm temple light and aarti glow",
  "News-style breaking thumbnail with a bold red banner",
  "Reaction thumbnail with a giant shocked emoji",
  "Tutorial thumbnail with clean arrows and labels",
  "Movie-trailer cinematic thumbnail with dramatic lighting",
  "Kids cartoon thumbnail with bright playful colors",
  "Luxury car thumbnail with cinematic studio lighting",
  "Science explainer thumbnail with glowing space visuals",
  "Comparison thumbnail, two products side by side, VS",
  "Festival thumbnail with fireworks and celebration vibe",
];

// Rotating composer placeholders (short, loop with a fade).
const PLACEHOLDERS: string[] = [
  "Describe your thumbnail…",
  "Tell me what to edit…",
  "Attach a face to add…",
  "Pick a bold headline…",
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Downscale a large image to keep request payloads under the body limit ───
// 10 full-res phone photos as base64 can blow past the 10MB server limit.
// We cap the longest edge and re-encode as JPEG (or keep PNG if it has alpha
// and is small). Returns { mimeType, base64, dataUrl }.
async function downscaleImage(file: File, maxEdge = 1600, quality = 0.85): Promise<{ mimeType: string; data: string; previewUrl: string }> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });

  // Small files (< ~1.2MB) and non-raster types: keep as-is.
  if (file.size < 1_200_000) {
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    return { mimeType: file.type || "image/png", data: base64, previewUrl: dataUrl };
  }

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("decode failed"));
      im.src = dataUrl;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    if (scale >= 1) {
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      return { mimeType: file.type || "image/png", data: base64, previewUrl: dataUrl };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const outUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = outUrl.split(",")[1] ?? "";
    return { mimeType: "image/jpeg", data: base64, previewUrl: outUrl };
  } catch {
    // Fallback to original if canvas processing fails.
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    return { mimeType: file.type || "image/png", data: base64, previewUrl: dataUrl };
  }
}

// ── Markdown-lite renderer for assistant text ───────────────────────────────
function renderText(text: string): React.ReactNode {
  return text.split("\n").map((line, i) => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) parts.push(<strong key={`${i}-${m.index}`}>{tok.slice(2, -2)}</strong>);
      else parts.push(<code key={`${i}-${m.index}`} className="thumb-inline-code">{tok.slice(1, -1)}</code>);
      last = m.index + tok.length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return <p key={i} className="thumb-text-line">{parts.length ? parts : "\u00A0"}</p>;
  });
}

// ── Rotating phrases for the generating animation ───────────────────────────
const GEN_PHRASES = [
  "Composing the scene",
  "Setting the lighting",
  "Balancing the colors",
  "Adding bold text",
  "Sharpening details",
  "Polishing the look",
];
const EDIT_PHRASES = [
  "Reading your image",
  "Planning the edit",
  "Reworking composition",
  "Blending changes",
  "Refining details",
  "Finishing touches",
];

// ── Unified generating card: thinking → making → (image revealed) ───────────
function GeneratingThumb({ mode, thinking }: { mode?: string; thinking?: boolean }) {
  const phrases = mode === "edit" ? EDIT_PHRASES : GEN_PHRASES;
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (thinking) { setIdx(0); return; }
    const t = setInterval(() => setIdx(i => (i + 1) % phrases.length), 1900);
    return () => clearInterval(t);
  }, [phrases.length, thinking]);

  const phrase = thinking ? "Thinking" : phrases[idx];

  return (
    <motion.div
      className="thumb-gen"
      role="status"
      aria-label="Generating thumbnail"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="thumb-gen-aurora" />
      <div className="thumb-gen-scan" />
      <span className="thumb-gen-spark thumb-gen-spark-1"><Sparkles className="w-3.5 h-3.5" /></span>
      <span className="thumb-gen-spark thumb-gen-spark-2"><Sparkles className="w-2.5 h-2.5" /></span>
      <span className="thumb-gen-spark thumb-gen-spark-3"><Sparkles className="w-3 h-3" /></span>

      <div className="thumb-gen-center">
        <div className="thumb-gen-orb">
          <div className="thumb-gen-orb-ring" />
          <div className="thumb-gen-orb-core">
            {mode === "edit" ? <Wand2 className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
          </div>
        </div>
        <div className="thumb-gen-phrase-wrap">
          <AnimatePresence mode="wait">
            <motion.span
              key={phrase}
              className="thumb-gen-phrase"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
            >
              {phrase}
              <span className="thumb-gen-dots"><i>.</i><i>.</i><i>.</i></span>
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      <div className="thumb-gen-bar"><div className="thumb-gen-bar-fill" /></div>
    </motion.div>
  );
}

// ── Live thinking block (Super Agent style) ─────────────────────────────────
function ThinkingBlock({ part }: { part: ThumbPart & { kind: "thinking" } }) {
  const hasThoughts = part.thoughts.trim().length > 0;
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the thoughts scrolled to the latest line while streaming.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [part.thoughts, open]);

  const label = part.live
    ? (part.label || "Thinking")
    : (hasThoughts ? "Thought process" : "Thought for a moment");

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="thumb-thinking-block"
    >
      <button
        type="button"
        className={cn("thumb-thinking-head", hasThoughts && "thumb-thinking-head-clickable")}
        onClick={() => hasThoughts && setOpen(o => !o)}
        disabled={!hasThoughts}
      >
        {part.live && <span className="thumb-thinking-spinner" />}
        <span className="thumb-thinking-label">{label}</span>
        {part.live && (
          <span className="thumb-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        )}
        {hasThoughts && <ChevronRight className={cn("w-3.5 h-3.5 thumb-thinking-chev", open && "thumb-thinking-chev-open")} />}
      </button>
      <AnimatePresence initial={false}>
        {open && hasThoughts && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="thumb-thinking-body-wrap"
          >
            <div ref={bodyRef} className="thumb-thinking-body">{part.thoughts}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Finished thumbnail card with blur-to-sharp reveal ───────────────────────
function ThumbCard({ part, thinking, onPreview }: { part: ThumbPart & { kind: "thumb" }; thinking?: boolean; onPreview: (url: string) => void }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const download = async () => {
    if (!part.imageUrl) return;
    setDownloading(true);
    const filename = part.filename ?? `thumbnail-${Date.now()}.png`;
    try {
      if (part.imageUrl.startsWith("data:")) {
        const a = document.createElement("a");
        a.href = part.imageUrl; a.download = filename; a.click();
      } else {
        const r = await fetch(part.imageUrl);
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      }
    } catch {
      window.open(part.imageUrl, "_blank");
      toast({ title: "Opened in new tab", description: "Right-click to save." });
    } finally {
      setDownloading(false);
    }
  };

  if (part.status === "loading") {
    return <GeneratingThumb mode={part.mode} thinking={thinking} />;
  }
  if (part.status === "error") {
    return (
      <div className="thumb-card thumb-card-error">
        <X className="w-4 h-4 shrink-0" />
        <span>{part.message ?? "Generation failed."}</span>
      </div>
    );
  }
  return (
    <motion.div
      className="thumb-card thumb-card-done"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <button className="thumb-card-img-btn" onClick={() => part.imageUrl && onPreview(part.imageUrl)} title="Click to preview">
        {!loaded && <div className="thumb-card-img-skeleton" />}
        <img
          src={part.imageUrl}
          alt="Generated thumbnail"
          ref={el => { if (el?.complete) setLoaded(true); }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
          className={cn("thumb-card-img", loaded ? "thumb-card-img-revealed" : "thumb-card-img-hidden")}
        />
        {loaded && (
          <>
            <span className="thumb-card-reveal-flash" />
            <span className="thumb-card-zoom-hint"><Maximize2 className="w-3.5 h-3.5" /></span>
          </>
        )}
      </button>
      <button className="thumb-card-download" onClick={download} disabled={downloading} title="Download">
        {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        <span>Download</span>
      </button>
    </motion.div>
  );
}

// ── Message row ─────────────────────────────────────────────────────────────
function MessageRow({ message, thinking, onPreview }: { message: ThumbMessage; thinking?: boolean; onPreview: (url: string) => void }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn("thumb-row", isUser ? "thumb-row-user" : "thumb-row-assistant")}
    >
      <div className="thumb-bubble">
        {message.parts.map((p, i) => {
          if (p.kind === "text") {
            return <div key={i} className={cn("thumb-text", isUser && "thumb-text-user")}>{renderText(p.content)}</div>;
          }
          if (p.kind === "thinking") {
            return <ThinkingBlock key={i} part={p} />;
          }
          if (p.kind === "images") {
            return (
              <div key={i} className={cn("thumb-user-images", p.items.length === 1 && "thumb-user-images-single")}>
                {p.items.map((img, j) => (
                  <div key={j} className="thumb-user-image">
                    <img src={img.previewUrl} alt={img.name} />
                  </div>
                ))}
              </div>
            );
          }
          return <ThumbCard key={i} part={p} thinking={thinking} onPreview={onPreview} />;
        })}
      </div>
    </motion.div>
  );
}

export function Thumbnail({ onBackToHome }: { onBackToHome?: () => void }) {
  void onBackToHome; // header removed per design — kept for API compatibility
  const { toast } = useToast();

  const [messages, setMessages] = useState<ThumbMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // Empty-state suggestions (reshuffle every few seconds) + rotating placeholder
  const [starters, setStarters] = useState<string[]>(() => shuffle(STARTER_POOL).slice(0, 4));
  const [placeholderIdx, setPlaceholderIdx] = useState(0);

  // Browser-local chat history (last 10)
  const [history, setHistory] = useState<SavedChat[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);

  // Brand presets (AWS-backed) + the currently selected one
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [canEditPresets, setCanEditPresets] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [showPresetMenu, setShowPresetMenu] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const assistantIdRef = useRef<string | null>(null);

  const isEmpty = messages.length === 0;

  // ── Load saved history once on mount ──────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, MAX_SAVED_CHATS));
      }
    } catch { /* ignore */ }
  }, []);

  // ── Load brand presets + restore the last selected one ────────────────────
  const loadPresets = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/thumbnail/presets`, { credentials: "include" });
      const data = await r.json().catch(() => ({}));
      const rows: PresetSummary[] = Array.isArray(data?.presets) ? data.presets : [];
      setPresets(rows);
      setCanEditPresets(Boolean(data?.canEdit));
      // Drop the active selection if that preset no longer exists.
      setActivePresetId(prev => (prev && rows.some(p => p.id === prev) ? prev : prev));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadPresets();
    try {
      const saved = localStorage.getItem(ACTIVE_PRESET_KEY);
      if (saved) setActivePresetId(saved);
    } catch { /* ignore */ }
  }, [loadPresets]);

  // Persist the active preset choice.
  useEffect(() => {
    try {
      if (activePresetId) localStorage.setItem(ACTIVE_PRESET_KEY, activePresetId);
      else localStorage.removeItem(ACTIVE_PRESET_KEY);
    } catch { /* ignore */ }
  }, [activePresetId]);

  // ── Reshuffle starter suggestions every 4s while on the empty screen ──────
  useEffect(() => {
    if (!isEmpty) return;
    const t = setInterval(() => setStarters(shuffle(STARTER_POOL).slice(0, 4)), 4000);
    return () => clearInterval(t);
  }, [isEmpty]);

  // ── Rotate the composer placeholder every ~3.5s (only when input is empty) ─
  useEffect(() => {
    if (input.trim()) return;
    const t = setInterval(() => setPlaceholderIdx(i => (i + 1) % PLACEHOLDERS.length), 3500);
    return () => clearInterval(t);
  }, [input]);

  // Autoscroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, thinking]);

  // Auto-grow textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  const patchAssistant = useCallback((updater: (m: ThumbMessage) => ThumbMessage) => {
    const id = assistantIdRef.current;
    if (!id) return;
    setMessages(prev => prev.map(m => (m.id === id ? updater(m) : m)));
  }, []);

  const appendText = useCallback((content: string) => {
    if (!content) return;
    patchAssistant(m => {
      const parts = [...m.parts];
      const last = parts[parts.length - 1];
      if (last?.kind === "text") {
        return { ...m, parts: [...parts.slice(0, -1), { kind: "text", content: last.content + content }] };
      }
      if (!content.trim()) return m;
      return { ...m, parts: [...parts, { kind: "text", content }] };
    });
  }, [patchAssistant]);

  const addFiles = useCallback((files: File[]) => {
    const images = files.filter(f => f.type.startsWith("image/"));
    if (images.length === 0) {
      toast({ title: "Images only", description: "Attach image files to use as references.", variant: "destructive" });
      return;
    }
    images.forEach(async file => {
      try {
        const processed = await downscaleImage(file);
        setPending(cur => {
          if (cur.length >= MAX_IMAGES) {
            toast({ title: "Limit reached", description: `Up to ${MAX_IMAGES} images per message.` });
            return cur;
          }
          return [...cur, {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name, mimeType: processed.mimeType, data: processed.data, previewUrl: processed.previewUrl,
          }];
        });
      } catch {
        toast({ title: "Couldn't read image", description: file.name, variant: "destructive" });
      }
    });
  }, [toast]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) addFiles(files);
    e.target.value = "";
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter(it => it.type.startsWith("image/"))
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imgs.length) { addFiles(imgs); e.preventDefault(); }
  };

  const removePending = (id: string) => setPending(prev => prev.filter(p => p.id !== id));

  const setThinkingPart = useCallback((updater: (p: ThumbPart & { kind: "thinking" }) => ThumbPart & { kind: "thinking" }) => {
    patchAssistant(m => {
      const has = m.parts.some(p => p.kind === "thinking");
      if (!has) return m;
      return { ...m, parts: m.parts.map(p => p.kind === "thinking" ? updater(p as any) : p) };
    });
  }, [patchAssistant]);

  const handleEvent = useCallback((evt: ThumbEvent) => {
    switch (evt.type) {
      case "ready":
        return;
      case "think":
        if (!evt.beat) setThinking(true);
        return;
      case "thought":
        // Stream the model's reasoning into the live thinking block. Derive a
        // short dynamic label from the latest bold/sentence fragment.
        setThinkingPart(p => {
          const thoughts = p.thoughts + evt.content;
          let label = p.label;
          const bold = thoughts.match(/\*\*([^*]+)\*\*/g);
          if (bold && bold.length) {
            const last = bold[bold.length - 1].replace(/\*\*/g, "").trim();
            if (last.length > 3 && last.length < 60) label = last;
          }
          return { ...p, thoughts, label, live: true };
        });
        return;
      case "plan":
        // Model decided to call a tool — flip the thinking block to "done" and
        // open the generation animation.
        setThinkingPart(p => ({ ...p, live: false }));
        return;
      case "text":
        setThinking(false);
        // Finalize the thinking block, then append the visible reply.
        setThinkingPart(p => ({ ...p, live: false }));
        appendText(evt.content);
        return;
      case "thumb_start":
        setThinking(false);
        setThinkingPart(p => ({ ...p, live: false }));
        patchAssistant(m => {
          if (m.parts.some(p => p.kind === "thumb" && p.status === "loading")) {
            return { ...m, parts: m.parts.map(p => p.kind === "thumb" && p.status === "loading" ? { ...p, mode: evt.mode } : p) };
          }
          return { ...m, parts: [...m.parts, { kind: "thumb", status: "loading", mode: evt.mode }] };
        });
        return;
      case "thumb_progress":
        patchAssistant(m => ({
          ...m,
          parts: m.parts.map(p =>
            p.kind === "thumb" && p.status === "loading"
              ? { ...p, message: evt.message ?? p.message, status: evt.status === "error" ? "error" : p.status }
              : p),
        }));
        return;
      case "thumb_done":
        patchAssistant(m => {
          let filled = false;
          const parts = m.parts.map(p => {
            if (!filled && p.kind === "thumb" && p.status === "loading") {
              filled = true;
              return { kind: "thumb" as const, status: "done" as const, imageUrl: evt.imageUrl, filename: evt.filename };
            }
            return p;
          });
          if (!filled) parts.push({ kind: "thumb", status: "done", imageUrl: evt.imageUrl, filename: evt.filename });
          return { ...m, parts };
        });
        return;
      case "error":
        setThinking(false);
        setThinkingPart(p => ({ ...p, live: false }));
        appendText(`⚠️ ${evt.message}`);
        return;
      case "done":
        setThinking(false);
        setThinkingPart(p => ({ ...p, live: false }));
        return;
    }
  }, [appendText, patchAssistant, setThinkingPart]);

  const sendMessage = useCallback(async (text: string, attachments: PendingAttachment[]) => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || streaming) return;

    const userParts: ThumbPart[] = [];
    if (attachments.length > 0) {
      userParts.push({ kind: "images", items: attachments.map(a => ({ previewUrl: a.previewUrl, name: a.name })) });
    }
    if (trimmed) userParts.push({ kind: "text", content: trimmed });

    const userMsg: ThumbMessage = { id: `u-${Date.now()}`, role: "user", parts: userParts };
    const assistantId = `a-${Date.now()}`;
    assistantIdRef.current = assistantId;
    // Pre-seed the assistant message with a live "thinking" block so the user
    // sees reasoning the instant they send — it then flows into the generation
    // animation and the final image (all inside ONE message, no gaps).
    const assistantMsg: ThumbMessage = {
      id: assistantId,
      role: "assistant",
      parts: [{ kind: "thinking", label: "Thinking", thoughts: "", live: true }],
    };

    const priorWire = messages.map(m => ({
      role: m.role === "user" ? ("user" as const) : ("model" as const),
      content: m.parts.filter(p => p.kind === "text").map(p => (p as any).content).join("\n"),
    })).filter(m => m.content.trim());

    const currentWire: any = {
      role: "user",
      content: trimmed,
      ...(attachments.length > 0 ? {
        attachments: attachments.map(a => ({ type: "image", name: a.name, mimeType: a.mimeType, data: a.data })),
      } : {}),
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput("");
    setPending([]);
    setStreaming(true);
    setThinking(true);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    let sawAnything = false;
    const markSeen = () => { sawAnything = true; };

    try {
      const resp = await fetch(`${BASE}/api/thumbnail/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...priorWire, currentWire], presetId: activePresetId ?? undefined }),
        signal: abortRef.current.signal,
      });
      if (!resp.ok || !resp.body) {
        const detail = await resp.text().catch(() => "");
        throw new Error(detail || `Server error: ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const raw = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
          if (!raw) continue;
          try { const e = JSON.parse(raw) as ThumbEvent; if (e.type === "text" || e.type === "thumb_done" || e.type === "error" || e.type === "thought" || e.type === "plan") markSeen(); handleEvent(e); } catch { /* ignore */ }
        }
      }
      const tail = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (tail) { try { const e = JSON.parse(tail) as ThumbEvent; if (e.type === "text" || e.type === "thumb_done" || e.type === "error" || e.type === "thought" || e.type === "plan") markSeen(); handleEvent(e); } catch { /* ignore */ } }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        let msg = "Connection interrupted. Please try again.";
        if (/Server error:/.test(err?.message ?? "")) msg = err.message;
        appendText(`⚠️ ${msg}`);
        markSeen();
      }
    } finally {
      // Remove the live thinking block if it never produced anything visible,
      // and drop any orphan loading card.
      patchAssistant(m => {
        let parts = m.parts.filter(p => !(p.kind === "thumb" && p.status === "loading"));
        // If the thinking block has no captured thoughts, remove it entirely.
        parts = parts.filter(p => !(p.kind === "thinking" && !p.thoughts.trim()));
        // Otherwise just mark it finished.
        parts = parts.map(p => p.kind === "thinking" ? { ...p, live: false } : p);
        return { ...m, parts };
      });
      if (!sawAnything) {
        patchAssistant(m => m.parts.length === 0 ? { ...m, parts: [{ kind: "text", content: "Hmm, nothing came back. Try again?" }] } : m);
      }
      setStreaming(false);
      setThinking(false);
      assistantIdRef.current = null;
    }
  }, [messages, streaming, handleEvent, appendText, patchAssistant, activePresetId]);

  const handleStop = () => {
    abortRef.current?.abort();
    patchAssistant(m => ({
      ...m,
      parts: m.parts
        .filter(p => !(p.kind === "thinking" && !p.thoughts.trim()))
        .map(p => {
          if (p.kind === "thinking") return { ...p, live: false };
          if (p.kind === "thumb" && p.status === "loading") return { kind: "thumb", status: "error", message: "Stopped." };
          return p;
        }),
    }));
    setStreaming(false);
    setThinking(false);
  };

  // ── Persist the current chat to localStorage (last 10) ────────────────────
  const persistChat = useCallback((msgs: ThumbMessage[], chatId: string | null): string | null => {
    // Only save chats that have at least one finished exchange.
    const meaningful = msgs.filter(m =>
      m.parts.some(p => p.kind === "text" || (p.kind === "thumb" && p.status === "done") || p.kind === "images"),
    );
    if (meaningful.length === 0) return chatId;

    const firstUserText = msgs.find(m => m.role === "user")?.parts.find(p => p.kind === "text") as
      | { kind: "text"; content: string } | undefined;
    const title = (firstUserText?.content ?? "Untitled thumbnail").slice(0, 60);
    const id = chatId ?? `c-${Date.now()}`;

    setHistory(prev => {
      const others = prev.filter(c => c.id !== id);
      const updated: SavedChat = { id, title, updatedAt: Date.now(), messages: msgs };
      const next = [updated, ...others]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SAVED_CHATS);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
    return id;
  }, []);

  // Save whenever a turn completes (streaming flips false with messages present).
  useEffect(() => {
    if (streaming || messages.length === 0) return;
    const id = persistChat(messages, currentChatId);
    if (id && id !== currentChatId) setCurrentChatId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const loadChat = (chat: SavedChat) => {
    if (streaming) return;
    setMessages(chat.messages);
    setCurrentChatId(chat.id);
    setShowHistory(false);
    setInput("");
    setPending([]);
  };

  const deleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory(prev => {
      const next = prev.filter(c => c.id !== id);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    if (id === currentChatId) { setMessages([]); setCurrentChatId(null); }
  };

  const newChat = () => {
    if (streaming) return;
    setMessages([]);
    setInput("");
    setPending([]);
    setCurrentChatId(null);
    setShowHistory(false);
  };

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const canSend = (input.trim().length > 0 || pending.length > 0) && !streaming;

  return (
    <div className={cn("thumb-wrap", isEmpty && "thumb-wrap-empty")}>
      {/* Top bar — Settings (admin presets) + History + New chat (top-right) */}
      <div className="thumb-topbar">
        {canEditPresets && (
          <button
            className="thumb-topbar-btn"
            onClick={() => setShowPresetsModal(true)}
            title="Manage brand presets"
            aria-label="Manage brand presets"
          >
            <Settings2 className="w-[18px] h-[18px]" />
          </button>
        )}
        <button
          className="thumb-topbar-btn"
          onClick={() => setShowHistory(s => !s)}
          title="Chat history"
          aria-label="Chat history"
        >
          <History className="w-[18px] h-[18px]" />
        </button>
        <button
          className="thumb-topbar-btn"
          onClick={newChat}
          disabled={streaming}
          title="New chat"
          aria-label="New chat"
        >
          <SquarePen className="w-[18px] h-[18px]" />
        </button>
      </div>

      {/* Presets manager modal */}
      <ThumbnailPresets
        open={showPresetsModal}
        onClose={() => setShowPresetsModal(false)}
        onChanged={(rows) => {
          setPresets(rows);
          // If the active preset was deleted, clear it.
          setActivePresetId(prev => (prev && rows.some(p => p.id === prev) ? prev : null));
        }}
      />

      {/* History panel */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              className="thumb-history-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
            />
            <motion.div
              className="thumb-history-panel"
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <div className="thumb-history-head">
                <span>Recent chats</span>
                <button onClick={() => setShowHistory(false)} title="Close" aria-label="Close history">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="thumb-history-list">
                {history.length === 0 ? (
                  <div className="thumb-history-empty">No saved chats yet</div>
                ) : (
                  history.map(c => (
                    <div
                      key={c.id}
                      className={cn("thumb-history-item", c.id === currentChatId && "thumb-history-item-active")}
                      onClick={() => loadChat(c)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === "Enter") loadChat(c); }}
                    >
                      <span className="thumb-history-title">{c.title}</span>
                      <button className="thumb-history-del" onClick={e => deleteChat(c.id, e)} title="Delete" aria-label="Delete chat">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              {history.length > 0 && (
                <p className="thumb-history-note">Last {MAX_SAVED_CHATS} chats are kept on this device.</p>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Messages / welcome */}
      <div className="thumb-scroll">
        <div className="thumb-col">
          {!isEmpty && (
            messages.map(m => (
              <MessageRow
                key={m.id}
                message={m}
                thinking={thinking && m.id === assistantIdRef.current}
                onPreview={setPreview}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className={cn("thumb-composer-wrap", isEmpty && "thumb-composer-wrap-empty")}>
        <div className="thumb-composer-col">
          {isEmpty && <h2 className="thumb-empty-prompt">What thumbnail can I make?</h2>}

          <form
            className="thumb-composer"
            onSubmit={e => { e.preventDefault(); void sendMessage(input, pending); }}
          >
            {/* Active brand preset selector */}
            <div className="thumb-preset-bar">
              <div className="thumb-preset-wrap">
                <button
                  type="button"
                  className={cn("thumb-preset-trigger", activePresetId && "thumb-preset-trigger-active")}
                  onClick={() => setShowPresetMenu(s => !s)}
                  title="Brand preset"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="thumb-preset-trigger-label">
                    {activePresetId
                      ? (presets.find(p => p.id === activePresetId)?.name ?? "Preset")
                      : "No preset"}
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 opacity-60" />
                </button>

                <AnimatePresence>
                  {showPresetMenu && (
                    <>
                      <div className="thumb-preset-menu-backdrop" onClick={() => setShowPresetMenu(false)} />
                      <motion.div
                        className="thumb-preset-menu"
                        initial={{ opacity: 0, y: 8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.98 }}
                        transition={{ duration: 0.15 }}
                      >
                        <button
                          type="button"
                          className={cn("thumb-preset-opt", !activePresetId && "thumb-preset-opt-active")}
                          onClick={() => { setActivePresetId(null); setShowPresetMenu(false); }}
                        >
                          <span>No preset</span>
                          {!activePresetId && <Check className="w-3.5 h-3.5" />}
                        </button>
                        {presets.map(p => (
                          <button
                            key={p.id}
                            type="button"
                            className={cn("thumb-preset-opt", activePresetId === p.id && "thumb-preset-opt-active")}
                            onClick={() => { setActivePresetId(p.id); setShowPresetMenu(false); }}
                          >
                            <span className="thumb-preset-opt-thumbs">
                              {p.images.slice(0, 3).map((im, i) => <img key={i} src={im.url} alt="" />)}
                            </span>
                            <span className="thumb-preset-opt-name">{p.name}</span>
                            {activePresetId === p.id && <Check className="w-3.5 h-3.5 shrink-0" />}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="thumb-preset-opt thumb-preset-manage"
                          onClick={() => { setShowPresetMenu(false); setShowPresetsModal(true); }}
                        >
                          <Settings2 className="w-3.5 h-3.5" />
                          <span>Manage presets…</span>
                        </button>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {pending.length > 0 && (
              <div className="thumb-attach-row">
                {pending.map(a => (
                  <div key={a.id} className="thumb-attach-chip">
                    <img src={a.previewUrl} alt={a.name} />
                    <button type="button" onClick={() => removePending(a.id)} title="Remove" aria-label="Remove image">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {pending.length < MAX_IMAGES && (
                  <button type="button" className="thumb-attach-add" onClick={() => fileRef.current?.click()} title="Add more">
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}

            <div className="thumb-composer-input-row">
              <button
                type="button"
                className="thumb-icon-btn"
                onClick={() => fileRef.current?.click()}
                title="Attach images (up to 10)"
                aria-label="Attach images"
              >
                <Plus className="w-5 h-5" />
              </button>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFileChange} />

              <div className="thumb-textarea-wrap">
                <textarea
                  ref={taRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(input, pending); }
                  }}
                  onPaste={onPaste}
                  rows={1}
                  placeholder=""
                  className="thumb-textarea"
                  aria-label="Describe your thumbnail"
                />
                {!input && (
                  <div className="thumb-placeholder" aria-hidden="true">
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={placeholderIdx}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.3 }}
                      >
                        {PLACEHOLDERS[placeholderIdx]}
                      </motion.span>
                    </AnimatePresence>
                  </div>
                )}
              </div>

              {streaming ? (
                <button type="button" className="thumb-send thumb-send-stop" onClick={handleStop} title="Stop">
                  <Square className="w-4 h-4" />
                </button>
              ) : (
                <button type="submit" className="thumb-send" disabled={!canSend} title="Send">
                  <ArrowUp className="w-5 h-5" />
                </button>
              )}
            </div>
          </form>

          {/* Starter suggestions — only on the empty state; reshuffle every 4s */}
          {isEmpty && (
            <div className="thumb-starters">
              <AnimatePresence mode="popLayout">
                {starters.map((s) => (
                  <motion.button
                    key={s}
                    layout
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.3 }}
                    className="thumb-starter"
                    onClick={() => void sendMessage(s, [])}
                  >
                    <span className="thumb-starter-icon"><Sparkles className="w-4 h-4" /></span>
                    <span className="thumb-starter-text">{s}</span>
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {preview && (
          <motion.div
            className="thumb-lightbox"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setPreview(null)}
          >
            <motion.div
              className="thumb-lightbox-inner"
              initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              onClick={e => e.stopPropagation()}
            >
              <img src={preview} alt="Thumbnail preview" />
              <button className="thumb-lightbox-close" onClick={() => setPreview(null)} title="Close">
                <X className="w-5 h-5" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
