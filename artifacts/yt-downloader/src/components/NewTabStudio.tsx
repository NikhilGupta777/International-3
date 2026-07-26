import React, { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUp, Scissors, Loader2, Sparkles,
  Plus, Globe, Captions, Film, ArrowLeft,
  Square, Copy, Check, RotateCcw,
  ChevronDown, X, Paperclip,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

type DeepThinkMode = "fast" | "max";

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "tool_start"; name: string; args: Record<string, unknown>; done?: boolean; result?: unknown }
  | { kind: "artifact"; artifactType: string; label: string; downloadUrl?: string; content?: string };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: Date;
  thinkingContent?: string;
};

type SseEvent =
  | { type: "run_start"; runId: string }
  | { type: "thinking"; stage?: string }
  | { type: "thought_delta"; content: string }
  | { type: "text_delta"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; toolId?: string }
  | { type: "tool_done"; name: string; result: unknown; toolId?: string }
  | { type: "tool_progress"; name: string; message?: string }
  | { type: "artifact"; artifactType: string; label: string; downloadUrl?: string; content?: string }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "heartbeat" };

type Attachment = {
  name: string;
  type: string;
  mimeType: string;
  data?: string;
  previewUrl?: string;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const INDIAN_LANGUAGES = [
  { lang: "English", text: "you?" },
  { lang: "Hindi", text: "आप?" },
  { lang: "Bengali", text: "আপনি?" },
  { lang: "Telugu", text: "మీరు?" },
  { lang: "Marathi", text: "तुम्ही?" },
  { lang: "Tamil", text: "நீங்கள்?" },
  { lang: "Gujarati", text: "તમે?" },
  { lang: "Kannada", text: "ನೀವು?" },
  { lang: "Malayalam", text: "നിങ്ങൾ?" },
  { lang: "Odia", text: "ଆପଣ?" },
  { lang: "Punjabi", text: "ਤੁਸੀਂ?" },
  { lang: "Assamese", text: "আপুনি?" },
  { lang: "Urdu", text: "آپ؟" },
  { lang: "Maithili", text: "अहाँ?" },
  { lang: "Sanskrit", text: "भवान्?" },
  { lang: "Manipuri", text: "নহাাক?" },
  { lang: "Kashmiri", text: "تہہ؟" },
];

const CHIPS = [
  { id: "edit", label: "Edit Videos", prompt: "Edit video with AI cuts, transitions, and audio sync.", icon: Film },
  { id: "clips", label: "Create Clips", prompt: "Extract top viral clips and short moments from this video.", icon: Scissors },
  { id: "subtitles", label: "Auto Subtitles", prompt: "Generate auto subtitles and multi-language captions for this video.", icon: Captions },
];

const BASE = typeof import.meta !== "undefined" ? import.meta.env.BASE_URL.replace(/\/$/, "") : "";

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split(/\r?\n/);
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data: ")) data += line.slice(6);
    else if (line.startsWith("data:")) data += line.slice(5);
  }
  if (!data) return null;
  try { return JSON.parse(data) as SseEvent; } catch { return null; }
}

// ── ThinkingBlock ──────────────────────────────────────────────────────────────

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!content && !isStreaming) return null;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 text-xs text-white/50 hover:text-white/70 transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5 text-purple-400/70" />
        <span className="font-medium">
          {isStreaming ? "Thinking..." : "Thought Process"}
        </span>
        {isStreaming && <span className="flex gap-0.5">{[0, 1, 2].map(i => (
          <span key={i} className="w-1 h-1 rounded-full bg-purple-400/60 animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}</span>}
        <ChevronDown className={cn("w-3 h-3 transition-transform", expanded && "rotate-180")} />
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 pl-4 border-l-2 border-purple-500/20 text-[13px] text-white/40 leading-relaxed whitespace-pre-wrap font-light italic max-h-[300px] overflow-y-auto">
              {content}
              {isStreaming && <span className="inline-block w-1.5 h-4 bg-purple-400/50 ml-0.5 animate-pulse align-middle" />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── ChatMessageBubble ──────────────────────────────────────────────────────────

function ChatMessageBubble({ message, onRegenerate }: {
  message: ChatMessage;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const textContent = message.parts.filter(p => p.kind === "text").map(p => (p as { kind: "text"; content: string }).content).join("\n");

  const handleCopy = () => {
    void navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div className="flex justify-end mb-6">
        <div className="max-w-[80%] bg-white/[0.08] backdrop-blur-sm rounded-2xl rounded-tr-md px-4 py-3 text-[14px] text-white/90 leading-relaxed">
          {textContent}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-6">
      <div className="max-w-[90%]">
        {message.thinkingContent && (
          <ThinkingBlock content={message.thinkingContent} isStreaming={false} />
        )}
        {message.parts.filter((p): p is MessagePart & { kind: "tool_start" } => p.kind === "tool_start").map((tool, i) => (
          <div key={i} className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/8 text-xs text-white/50">
            <Sparkles className="w-3 h-3 text-cyan-400/60" />
            <span className="font-medium text-white/60">{tool.name.replace(/_/g, " ")}</span>
            {tool.done && <Check className="w-3 h-3 text-green-400/60" />}
          </div>
        ))}
        {message.parts.filter((p): p is MessagePart & { kind: "artifact" } => p.kind === "artifact").map((art, i) => (
          <div key={i} className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-cyan-500/[0.06] border border-cyan-400/15 text-xs text-cyan-200/70">
            <Film className="w-3.5 h-3.5" />
            <span className="font-medium">{art.label}</span>
          </div>
        ))}
        {textContent && (
          <div className="text-[14px] text-white/85 leading-relaxed whitespace-pre-wrap">{textContent}</div>
        )}
        {textContent && (
          <div className="flex items-center gap-1 mt-2">
            <button type="button" onClick={handleCopy} className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors" title="Copy">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            {onRegenerate && (
              <button type="button" onClick={onRegenerate} className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors" title="Regenerate">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── DeepThinkDropdown ──────────────────────────────────────────────────────────

function DeepThinkDropdown({ mode, onChange }: { mode: DeepThinkMode; onChange: (m: DeepThinkMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white/60 hover:text-white/80 hover:bg-white/5 transition-colors"
      >
        <Sparkles className="w-3 h-3 text-purple-400/70" />
        <span>Deep Think</span>
        <span className={cn(
          "px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider",
          mode === "max" ? "bg-purple-500/25 text-purple-300" : "bg-white/10 text-white/50"
        )}>{mode === "max" ? "Max" : "Fast"}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full right-0 mb-2 w-[220px] bg-[#1a1a1f] border border-white/12 rounded-xl shadow-2xl p-1.5 z-50"
          >
            <button type="button" onClick={() => { onChange("max"); setOpen(false); }} className={cn("w-full flex flex-col px-3 py-2.5 rounded-lg text-left transition-colors", mode === "max" ? "bg-purple-500/15" : "hover:bg-white/5")}>
              <span className="text-xs font-semibold text-white/90 flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-purple-400" /> Max (Deep)
              </span>
              <span className="text-[10px] text-white/40 mt-0.5">Gemma 4 · HIGH thinking · Best quality</span>
            </button>
            <button type="button" onClick={() => { onChange("fast"); setOpen(false); }} className={cn("w-full flex flex-col px-3 py-2.5 rounded-lg text-left transition-colors mt-0.5", mode === "fast" ? "bg-white/10" : "hover:bg-white/5")}>
              <span className="text-xs font-semibold text-white/90">Fast</span>
              <span className="text-[10px] text-white/40 mt-0.5">Quick responses · Lower latency</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function NewTabStudio() {
  // ── Phase ──
  const [phase, setPhase] = useState<"launchpad" | "chatting">("launchpad");

  // ── Launchpad ──
  const [prompt, setPrompt] = useState("");
  const [langIndex, setLangIndex] = useState(0);
  const [activeChip, setActiveChip] = useState<string | null>(null);

  // ── Toolbar ──
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [deepThinkMode, setDeepThinkMode] = useState<DeepThinkMode>("max");
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // ── Chat ──
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [currentThinkingText, setCurrentThinkingText] = useState("");
  const [sessionId] = useState(() => `newtab-${generateId()}`);

  const { toast } = useToast();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  // ── Language animation ──
  useEffect(() => {
    const timer = setInterval(() => setLangIndex(prev => (prev + 1) % INDIAN_LANGUAGES.length), 2500);
    return () => clearInterval(timer);
  }, []);

  // ── Auto-scroll ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentThinkingText, isThinking]);

  // ── File attachment ──
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        toast({ title: "File too large", description: `${file.name} exceeds 20MB limit`, variant: "destructive" });
        continue;
      }
      const data = await fileToBase64(file);
      const typeCategory = file.type.startsWith("image/") ? "image"
        : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("audio/") ? "audio" : "document";
      setAttachments(prev => [...prev, {
        name: file.name, type: typeCategory, mimeType: file.type, data,
        previewUrl: typeCategory === "image" ? URL.createObjectURL(file) : undefined,
      }]);
    }
    e.target.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  // ── Send message ──
  const sendMessage = useCallback(async (text: string) => {
    if (streaming || !text.trim()) return;

    const userMsg: ChatMessage = {
      id: generateId(), role: "user",
      parts: [{ kind: "text", content: text.trim() }],
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);

    const assistantId = generateId();
    streamingMsgIdRef.current = assistantId;
    setMessages(prev => [...prev, {
      id: assistantId, role: "assistant", parts: [], timestamp: new Date(), thinkingContent: "",
    }]);

    setStreaming(true);
    setIsThinking(true);
    setCurrentThinkingText("");

    const controller = new AbortController();
    abortRef.current = controller;

    const history = [...messages, userMsg].map(m => ({
      role: m.role,
      parts: m.parts.filter(p => p.kind === "text").map(p => ({ text: (p as { kind: "text"; content: string }).content })),
    }));

    let accText = "";
    let accThinking = "";

    const patchAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
      setMessages(prev => prev.map(m => m.id === assistantId ? updater(m) : m));
    };

    try {
      const resp = await fetch(`${BASE}/api/newtab-studio/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messages: history, model: deepThinkMode, webSearch: webSearchEnabled }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) throw new Error(`Server error: ${resp.status}`);

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
          const evt = parseSseFrame(frame);
          if (!evt) continue;

          if (evt.type === "thought_delta") {
            accThinking += evt.content;
            setCurrentThinkingText(accThinking);
            patchAssistant(m => ({ ...m, thinkingContent: accThinking }));
          }
          if (evt.type === "thinking") setIsThinking(true);
          if (evt.type === "text_delta" || evt.type === "text") {
            setIsThinking(false);
            accText += evt.content;
            patchAssistant(m => {
              const nonText = m.parts.filter(p => p.kind !== "text");
              return { ...m, parts: [...nonText, { kind: "text", content: accText }] };
            });
          }
          if (evt.type === "tool_start") {
            patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "tool_start", name: evt.name, args: evt.args }] }));
          }
          if (evt.type === "tool_done") {
            patchAssistant(m => ({
              ...m,
              parts: m.parts.map(p =>
                p.kind === "tool_start" && (p as { name: string }).name === evt.name && !(p as { done?: boolean }).done
                  ? { ...p, done: true, result: evt.result } : p
              ),
            }));
          }
          if (evt.type === "artifact") {
            patchAssistant(m => ({
              ...m, parts: [...m.parts, { kind: "artifact", artifactType: evt.artifactType, label: evt.label, downloadUrl: evt.downloadUrl, content: evt.content }],
            }));
          }
          if (evt.type === "error") {
            let cleanMsg = evt.message ?? "Something went wrong";
            try { const p = JSON.parse(cleanMsg); cleanMsg = String(p?.error?.message ?? p?.message ?? cleanMsg).split(/\.?\s*Please refer to https?:\/\//).shift()!.trim(); } catch { /* ok */ }
            patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: `Error: ${cleanMsg}` }] }));
            setStreaming(false); setIsThinking(false); return;
          }
          if (evt.type === "done") {
            setStreaming(false); setIsThinking(false); setCurrentThinkingText(""); return;
          }
        }
      }
      if (buf.trim()) {
        const evt = parseSseFrame(buf);
        if (evt?.type === "done") { setStreaming(false); setIsThinking(false); setCurrentThinkingText(""); }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: `Connection error: ${err.message}` }] }));
      }
    } finally {
      setStreaming(false); setIsThinking(false); setCurrentThinkingText("");
      streamingMsgIdRef.current = null; abortRef.current = null;
    }
  }, [streaming, messages, sessionId, deepThinkMode, webSearchEnabled]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    setStreaming(false); setIsThinking(false); setCurrentThinkingText("");
  };

  const handleLaunchpadSubmit = (text: string) => {
    if (!text.trim()) return;
    setPhase("chatting");
    const submitText = text;
    setPrompt("");
    setChatInput("");
    setAttachments([]);
    setTimeout(() => void sendMessage(submitText), 100);
  };

  const handleChatSubmit = () => {
    if (!chatInput.trim() || streaming) return;
    const text = chatInput.trim();
    setChatInput("");
    setAttachments([]);
    void sendMessage(text);
  };

  const handleRegenerate = (messageIndex: number) => {
    if (streaming) return;
    const lastUser = [...messages.slice(0, messageIndex)].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    const userText = lastUser.parts.filter(p => p.kind === "text").map(p => (p as { kind: "text"; content: string }).content).join("\n");
    setMessages(prev => prev.filter((_, i) => i !== messageIndex));
    void sendMessage(userText);
  };

  const handleLaunchpadKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleLaunchpadSubmit(prompt); }
  };
  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSubmit(); }
  };
  const handleChipClick = (chipPrompt: string, chipId: string) => {
    setActiveChip(chipId);
    setPrompt(chipPrompt);
    inputRef.current?.focus();
  };

  // ── Shared UI pieces ──

  const ConsoleToolbar = ({ isChat }: { isChat?: boolean }) => (
    <div className="flex items-center justify-between pt-2 border-t border-white/5 mt-1">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => fileInputRef.current?.click()} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/5 transition-colors" title="Attach file">
          <Plus className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => setWebSearchEnabled(v => !v)} className={cn("w-8 h-8 rounded-lg flex items-center justify-center transition-colors", webSearchEnabled ? "text-cyan-400 bg-cyan-500/15 hover:bg-cyan-500/25" : "text-white/50 hover:text-white hover:bg-white/5")} title={webSearchEnabled ? "Web search ON" : "Web search OFF"}>
          <Globe className="w-4 h-4" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <DeepThinkDropdown mode={deepThinkMode} onChange={setDeepThinkMode} />
        {streaming ? (
          <button type="button" onClick={stopStreaming} className="w-8 h-8 rounded-xl flex items-center justify-center bg-white/10 hover:bg-white/20 text-white transition-colors" title="Stop">
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        ) : (
          <button type="button" onClick={() => isChat ? handleChatSubmit() : handleLaunchpadSubmit(prompt)} disabled={isChat ? (!chatInput.trim() || streaming) : !prompt.trim()} className={cn("w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-300", (isChat ? chatInput.trim() : prompt.trim()) && !streaming ? "bg-white hover:bg-white/90 text-black shadow-lg scale-100" : "bg-white/10 text-white/30 cursor-not-allowed scale-95")}>
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );

  const AttachmentsStrip = () => attachments.length > 0 ? (
    <div className="flex gap-2 flex-wrap px-1 pt-2">
      {attachments.map((att, i) => (
        <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[11px] text-white/60">
          {att.previewUrl ? <img src={att.previewUrl} alt="" className="w-5 h-5 rounded object-cover" /> : <Paperclip className="w-3 h-3" />}
          <span className="truncate max-w-[100px]">{att.name}</span>
          <button type="button" onClick={() => removeAttachment(i)} className="text-white/30 hover:text-white/60"><X className="w-3 h-3" /></button>
        </div>
      ))}
    </div>
  ) : null;

  const FileInput = () => (
    <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,video/*,audio/*,.txt,.srt,.vtt,.json,.csv,.pdf" onChange={handleFileSelect} />
  );

  // ── CHAT VIEW ────────────────────────────────────────────────────────────────
  if (phase === "chatting") {
    return (
      <div className="w-full h-full flex-1 flex flex-col bg-transparent text-white">
        <FileInput />
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/5">
          <button type="button" onClick={() => { stopStreaming(); setPhase("launchpad"); }} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 border border-white/8 flex items-center justify-center text-white/60 hover:text-white transition-colors" title="Back to Launchpad">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white/80 truncate">New Tab Studio</h2>
            <p className="text-[10px] text-white/35">
              {deepThinkMode === "max" ? "Gemma 4 · Deep Think" : "Fast Mode"}{webSearchEnabled ? " · Web Search" : ""}
            </p>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-6">
          <div className="max-w-[800px] mx-auto">
            {messages.map((msg, i) => (
              <ChatMessageBubble key={msg.id} message={msg} onRegenerate={msg.role === "assistant" && !streaming ? () => handleRegenerate(i) : undefined} />
            ))}
            {streaming && isThinking && streamingMsgIdRef.current && (
              <div className="flex justify-start mb-6">
                <div className="max-w-[90%]">
                  {currentThinkingText ? (
                    <ThinkingBlock content={currentThinkingText} isStreaming />
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-white/40">
                      <span className="flex gap-1">
                        {[0, 1, 2, 3].map(i => (
                          <span key={i} className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse" style={{ animationDelay: `${i * 0.15}s` }} />
                        ))}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="shrink-0 px-4 sm:px-8 pb-4 pt-2">
          <div className="max-w-[800px] mx-auto">
            <div className="relative rounded-2xl border border-white/10 bg-[#161619] p-3 shadow-xl">
              <AttachmentsStrip />
              <textarea ref={chatInputRef} value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={handleChatKeyDown} disabled={streaming} placeholder="Send a Message" className="w-full bg-transparent text-white placeholder-white/35 border-none outline-none resize-none py-1 min-h-[40px] max-h-[120px] text-[14px] leading-relaxed" rows={1} />
              <ConsoleToolbar isChat />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── LAUNCHPAD VIEW ───────────────────────────────────────────────────────────
  return (
    <div className="newtab-studio-wrapper w-full min-h-full flex-1 flex flex-col items-center pt-[6vh] overflow-y-auto px-4 pb-20 select-none bg-transparent text-white">
      <FileInput />

      {/* Heading */}
      <motion.div
        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-[850px] flex flex-col items-center text-center mb-6"
      >
        <h1 className="text-3xl sm:text-5xl font-serif text-white tracking-tight leading-snug mb-1 font-normal">
          What can I edit for
        </h1>
        <div className="h-16 py-1 my-1 flex items-center justify-center overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.span key={langIndex} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -14 }} transition={{ duration: 0.35, ease: "easeInOut" }} className="text-3xl sm:text-5xl font-serif text-white tracking-tight font-normal leading-normal py-0.5">
              {INDIAN_LANGUAGES[langIndex].text}
            </motion.span>
          </AnimatePresence>
        </div>
        <p className="text-white/45 text-xs sm:text-sm max-w-[580px] font-normal tracking-wide mt-2">
          Interact with AI Studio and explore the boundless creative world
        </p>
      </motion.div>

      {/* Console */}
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, delay: 0.1 }} className="w-full max-w-[760px] relative mb-6 group">
        <style>{`
          @keyframes studioConsoleGlow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
        <div className="absolute -inset-[5.5px] rounded-[18px] opacity-25 blur-[14px] transition-all duration-500 group-hover:opacity-75 group-focus-within:opacity-100" style={{ background: "linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)", backgroundSize: "300% 300%", animation: "studioConsoleGlow 10s ease-in-out infinite" }} />
        <div className="relative w-full rounded-[18px] p-[1.2px] overflow-hidden bg-zinc-800 shadow-2xl">
          <div className="absolute inset-0 opacity-60 group-hover:opacity-90 group-focus-within:opacity-100 transition-opacity duration-500" style={{ background: "linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)", backgroundSize: "300% 300%", animation: "studioConsoleGlow 10s ease-in-out infinite" }} />
          <div className="relative rounded-[17px] bg-[#161619] p-4 flex flex-col justify-between min-h-[140px]">
            <AttachmentsStrip />
            <textarea ref={inputRef} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleLaunchpadKeyDown} placeholder="How can I help you today?" className="w-full bg-transparent text-white placeholder-white/35 border-none outline-none resize-none py-1 min-h-[60px] max-h-[160px] text-[16px] leading-relaxed" rows={2} />
            <ConsoleToolbar />
          </div>
        </div>
      </motion.div>

      {/* Chips */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 }} className="w-full max-w-[760px] flex items-center justify-center gap-3 mb-8 flex-wrap">
        {CHIPS.map(chip => {
          const Icon = chip.icon;
          const isActive = activeChip === chip.id;
          return (
            <button key={chip.id} type="button" onClick={() => handleChipClick(chip.prompt, chip.id)} className={cn("px-4 py-2 rounded-xl text-xs font-medium flex items-center gap-2 transition-all duration-200 border", isActive ? "bg-white text-black border-white shadow-lg font-semibold" : "bg-[#18181c] border-white/10 text-white/70 hover:text-white hover:bg-white/10 hover:border-white/25")}>
              <Icon className={cn("w-3.5 h-3.5 transition-colors", isActive ? "text-black" : "text-white/50")} />
              <span>{chip.label}</span>
            </button>
          );
        })}
      </motion.div>
    </div>
  );
}
