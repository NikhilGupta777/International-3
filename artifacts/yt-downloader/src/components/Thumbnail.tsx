import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Loader2, Download, X, Plus,
  ArrowUp, Square, Wand2, Maximize2, SquarePen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const MAX_IMAGES = 10;

// ── Types (fully independent from the Super Agent) ──────────────────────────
type ThumbPart =
  | { kind: "text"; content: string }
  | { kind: "images"; items: Array<{ previewUrl: string; name: string }> }
  | { kind: "thumb"; status: "loading" | "done" | "error"; mode?: string; imageUrl?: string; filename?: string; message?: string };

type ThumbMessage = { id: string; role: "user" | "assistant"; parts: ThumbPart[] };

type ThumbEvent =
  | { type: "ready"; runId: string; model?: string }
  | { type: "think"; runId?: string; stage?: string; beat?: boolean }
  | { type: "text"; runId?: string; content: string }
  | { type: "thumb_start"; runId?: string; toolId: string; mode?: string }
  | { type: "thumb_progress"; runId?: string; toolId: string; status?: string; message?: string }
  | { type: "thumb_done"; runId?: string; toolId: string; imageUrl: string; filename?: string; note?: string }
  | { type: "error"; runId?: string; message: string }
  | { type: "done"; runId?: string };

type PendingAttachment = { id: string; name: string; mimeType: string; data: string; previewUrl: string };

// ── Quick-start chips (empty state) ─────────────────────────────────────────
const STARTERS: string[] = [
  "Make a bold thumbnail for a Bhavishya Malika prophecy video with a divine golden glow and the headline “2025 की भविष्यवाणी”",
  "Create a high-energy YouTube thumbnail for a motivational talk — shocked face, dark background, huge text “DON’T QUIT”",
];

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
      layout
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
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <button className="thumb-card-img-btn" onClick={() => part.imageUrl && onPreview(part.imageUrl)} title="Click to preview">
        {!loaded && <div className="thumb-card-img-skeleton" />}
        <img
          src={part.imageUrl}
          alt="Generated thumbnail"
          onLoad={() => setLoaded(true)}
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

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const assistantIdRef = useRef<string | null>(null);

  const isEmpty = messages.length === 0;

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
    images.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
        setPending(cur => {
          if (cur.length >= MAX_IMAGES) {
            toast({ title: "Limit reached", description: `Up to ${MAX_IMAGES} images per message.` });
            return cur;
          }
          return [...cur, {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name, mimeType: file.type, data: base64, previewUrl: dataUrl,
          }];
        });
      };
      reader.readAsDataURL(file);
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

  const handleEvent = useCallback((evt: ThumbEvent) => {
    switch (evt.type) {
      case "ready":
        return;
      case "think":
        if (!evt.beat) setThinking(true);
        return;
      case "text":
        setThinking(false);
        appendText(evt.content);
        return;
      case "thumb_start":
        setThinking(false);
        patchAssistant(m => {
          // Reuse an existing loading card if one is already showing (seamless
          // thinking → making with no flicker); otherwise add one.
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
        appendText(`⚠️ ${evt.message}`);
        return;
      case "done":
        setThinking(false);
        return;
    }
  }, [appendText, patchAssistant]);

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
    // Pre-seed the assistant message with a loading card so thinking → making
    // happens inside ONE element (no appearing/disappearing gap).
    const assistantMsg: ThumbMessage = {
      id: assistantId,
      role: "assistant",
      parts: [{ kind: "thumb", status: "loading" }],
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
        body: JSON.stringify({ messages: [...priorWire, currentWire] }),
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
          try { const e = JSON.parse(raw) as ThumbEvent; if (e.type === "text" || e.type === "thumb_done" || e.type === "error") markSeen(); handleEvent(e); } catch { /* ignore */ }
        }
      }
      const tail = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (tail) { try { const e = JSON.parse(tail) as ThumbEvent; if (e.type === "text" || e.type === "thumb_done" || e.type === "error") markSeen(); handleEvent(e); } catch { /* ignore */ } }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        let msg = "Connection interrupted. Please try again.";
        if (/Server error:/.test(err?.message ?? "")) msg = err.message;
        appendText(`⚠️ ${msg}`);
        markSeen();
      }
    } finally {
      // Clean up any orphan loading card (e.g. the model replied with text only).
      patchAssistant(m => ({
        ...m,
        parts: m.parts.filter(p => !(p.kind === "thumb" && p.status === "loading")),
      }));
      if (!sawAnything) {
        patchAssistant(m => m.parts.length === 0 ? { ...m, parts: [{ kind: "text", content: "Hmm, nothing came back. Try again?" }] } : m);
      }
      setStreaming(false);
      setThinking(false);
      assistantIdRef.current = null;
    }
  }, [messages, streaming, handleEvent, appendText, patchAssistant]);

  const handleStop = () => {
    abortRef.current?.abort();
    patchAssistant(m => ({
      ...m,
      parts: m.parts.map(p => (p.kind === "thumb" && p.status === "loading" ? { kind: "thumb", status: "error", message: "Stopped." } : p)),
    }));
    setStreaming(false);
    setThinking(false);
  };

  const newChat = () => {
    if (streaming) return;
    setMessages([]);
    setInput("");
    setPending([]);
  };

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const canSend = (input.trim().length > 0 || pending.length > 0) && !streaming;

  return (
    <div className={cn("thumb-wrap", isEmpty && "thumb-wrap-empty")}>
      {/* Top bar — only a New Chat button on the right (ChatGPT style) */}
      {!isEmpty && (
        <div className="thumb-topbar">
          <button className="thumb-topbar-new" onClick={newChat} disabled={streaming} title="New chat" aria-label="New chat">
            <SquarePen className="w-[18px] h-[18px]" />
          </button>
        </div>
      )}

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

              <textarea
                ref={taRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(input, pending); }
                }}
                onPaste={onPaste}
                rows={1}
                placeholder="Describe your thumbnail, or attach images to edit…"
                className="thumb-textarea"
              />

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

          {/* Starter suggestions — only on the empty state, ChatGPT-style */}
          {isEmpty && (
            <div className="thumb-starters">
              {STARTERS.map((s, i) => (
                <button key={i} className="thumb-starter" onClick={() => void sendMessage(s, [])}>
                  <span className="thumb-starter-icon"><Sparkles className="w-4 h-4" /></span>
                  <span className="thumb-starter-text">{s}</span>
                </button>
              ))}
            </div>
          )}

          {!isEmpty && <p className="thumb-disclaimer">Thumbnail Studio uses AI image generation — results may vary.</p>}
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
