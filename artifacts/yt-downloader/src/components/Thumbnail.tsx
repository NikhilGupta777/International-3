import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Image as ImageIcon, Sparkles, Loader2, Download, X, Paperclip,
  ArrowUp, Square, Wand2, Palette, Type as TypeIcon, RotateCcw, Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

// ── Types (fully independent from the Super Agent) ──────────────────────────
type ThumbPart =
  | { kind: "text"; content: string }
  | { kind: "image"; previewUrl: string; name: string }
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

type PendingAttachment = { name: string; mimeType: string; data: string; previewUrl: string };

// ── Quick-start chips ───────────────────────────────────────────────────────
const STARTERS: Array<{ icon: React.ReactNode; text: string }> = [
  { icon: <Sparkles className="w-4 h-4" />, text: "Make a high-energy thumbnail for a motivational talk with the headline “DON’T QUIT”" },
  { icon: <Palette className="w-4 h-4" />, text: "Calm devotional thumbnail with warm golden light and soft glow" },
  { icon: <TypeIcon className="w-4 h-4" />, text: "Bold tech-review thumbnail, dark background, big text “IS IT WORTH IT?”" },
  { icon: <ImageIcon className="w-4 h-4" />, text: "Clean podcast cover with two mics and a vibrant gradient" },
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

// ── Thumbnail image card ────────────────────────────────────────────────────
function ThumbCard({ part, onPreview }: { part: ThumbPart & { kind: "thumb" }; onPreview: (url: string) => void }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

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
    return (
      <div className="thumb-card thumb-card-loading">
        <Loader2 className="w-6 h-6 animate-spin text-white/40" />
        <span className="thumb-card-loading-text">{part.message ?? "Designing your thumbnail…"}</span>
      </div>
    );
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
    <div className="thumb-card thumb-card-done">
      <button className="thumb-card-img-btn" onClick={() => part.imageUrl && onPreview(part.imageUrl)} title="Preview">
        <img src={part.imageUrl} alt="Generated thumbnail" loading="lazy" />
      </button>
      <button className="thumb-card-download" onClick={download} disabled={downloading} title="Download">
        {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        <span>Download</span>
      </button>
    </div>
  );
}

// ── Message row ─────────────────────────────────────────────────────────────
function MessageRow({ message, onPreview }: { message: ThumbMessage; onPreview: (url: string) => void }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn("thumb-row", isUser ? "thumb-row-user" : "thumb-row-assistant")}
    >
      <div className="thumb-bubble">
        {message.parts.map((p, i) => {
          if (p.kind === "text") {
            return <div key={i} className={cn("thumb-text", isUser && "thumb-text-user")}>{renderText(p.content)}</div>;
          }
          if (p.kind === "image") {
            return (
              <div key={i} className="thumb-user-image">
                <img src={p.previewUrl} alt={p.name} />
              </div>
            );
          }
          return <ThumbCard key={i} part={p} onPreview={onPreview} />;
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
  const [pending, setPending] = useState<PendingAttachment | null>(null);
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

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Images only", description: "Attach an image to use as a reference.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      setPending({ name: file.name, mimeType: file.type, data: base64, previewUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  }, [toast]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find(it => it.type.startsWith("image/"));
    if (item) {
      const f = item.getAsFile();
      if (f) { handleFile(f); e.preventDefault(); }
    }
  };

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
        patchAssistant(m => ({
          ...m,
          parts: [...m.parts, { kind: "thumb", status: "loading", mode: evt.mode, message: "Designing your thumbnail…" }],
        }));
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
          // Fill the most recent loading card.
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

  const sendMessage = useCallback(async (text: string, attachment?: PendingAttachment | null) => {
    const trimmed = text.trim();
    if ((!trimmed && !attachment) || streaming) return;

    const userParts: ThumbPart[] = [];
    if (attachment) userParts.push({ kind: "image", previewUrl: attachment.previewUrl, name: attachment.name });
    if (trimmed) userParts.push({ kind: "text", content: trimmed });

    const userMsg: ThumbMessage = { id: `u-${Date.now()}`, role: "user", parts: userParts };
    const assistantId = `a-${Date.now()}`;
    assistantIdRef.current = assistantId;
    const assistantMsg: ThumbMessage = { id: assistantId, role: "assistant", parts: [] };

    // Build wire history BEFORE clearing input.
    const priorWire = messages.map(m => ({
      role: m.role === "user" ? ("user" as const) : ("model" as const),
      content: m.parts.filter(p => p.kind === "text").map(p => (p as any).content).join("\n"),
    })).filter(m => m.content.trim());

    const currentWire: any = {
      role: "user",
      content: trimmed,
      ...(attachment ? { attachments: [{ type: "image", name: attachment.name, mimeType: attachment.mimeType, data: attachment.data }] } : {}),
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput("");
    setPending(null);
    setStreaming(true);
    setThinking(true);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

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
          try { handleEvent(JSON.parse(raw) as ThumbEvent); } catch { /* ignore */ }
        }
      }
      const tail = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (tail) { try { handleEvent(JSON.parse(tail) as ThumbEvent); } catch { /* ignore */ } }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        let msg = "Connection interrupted. Please try again.";
        if (/Server error:/.test(err?.message ?? "")) msg = err.message;
        appendText(`⚠️ ${msg}`);
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      assistantIdRef.current = null;
    }
  }, [messages, streaming, handleEvent, appendText]);

  const handleStop = () => {
    abortRef.current?.abort();
    patchAssistant(m => ({
      ...m,
      parts: m.parts.map(p => (p.kind === "thumb" && p.status === "loading" ? { ...p, status: "error", message: "Stopped." } : p)),
    }));
    setStreaming(false);
    setThinking(false);
  };

  const newChat = () => {
    if (streaming) return;
    setMessages([]);
    setInput("");
    setPending(null);
  };

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const canSend = (input.trim().length > 0 || pending) && !streaming;

  return (
    <div className="thumb-wrap">
      {/* Messages / welcome */}
      <div className="thumb-scroll">
        <div className="thumb-col">
          {isEmpty ? (
            <div className="thumb-welcome">
              <div className="thumb-welcome-badge">
                <ImageIcon className="w-5 h-5" />
              </div>
              <h1 className="thumb-welcome-title">Thumbnail Studio</h1>
              <p className="thumb-welcome-sub">
                Tell me about your video and I’ll design scroll-stopping thumbnails. Attach a face or logo to include it.
              </p>
              <div className="thumb-starters">
                {STARTERS.map((s, i) => (
                  <button key={i} className="thumb-starter" onClick={() => void sendMessage(s.text)}>
                    <span className="thumb-starter-icon">{s.icon}</span>
                    <span className="thumb-starter-text">{s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map(m => <MessageRow key={m.id} message={m} onPreview={setPreview} />)}
              {thinking && (
                <div className="thumb-row thumb-row-assistant">
                  <div className="thumb-thinking">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Thinking…</span>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="thumb-composer-wrap">
        <div className="thumb-composer-col">
          {!isEmpty && (
            <div className="thumb-composer-toolbar">
              <button className="thumb-newchat" onClick={newChat} disabled={streaming} title="New thumbnail chat">
                <RotateCcw className="w-3.5 h-3.5" />
                <span>New</span>
              </button>
            </div>
          )}

          <form
            className="thumb-composer"
            onSubmit={e => { e.preventDefault(); void sendMessage(input, pending); }}
          >
            {pending && (
              <div className="thumb-attach-chip">
                <img src={pending.previewUrl} alt={pending.name} />
                <span className="truncate">{pending.name}</span>
                <button type="button" onClick={() => setPending(null)} title="Remove">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            <div className="thumb-composer-input-row">
              <button
                type="button"
                className="thumb-icon-btn"
                onClick={() => fileRef.current?.click()}
                title="Attach reference image"
                aria-label="Attach reference image"
              >
                <Paperclip className="w-5 h-5" />
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

              <textarea
                ref={taRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(input, pending); }
                }}
                onPaste={onPaste}
                rows={1}
                placeholder="Describe your thumbnail, or attach an image to edit…"
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
          <p className="thumb-disclaimer">Thumbnail Studio uses AI image generation — results may vary.</p>
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
