import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Bot, User, Loader2, CheckCircle, ChevronRight,
  Download, Scissors, Sparkles, Captions, AlarmClock,
  UploadCloud, Shield, ListVideo, X, Mic, MicOff, Trash2, Clock, History,
} from "lucide-react";
import { cn } from "@/lib/utils";

const HISTORY_KEY = "copilot-sessions-v2";

type ChatSession = {
  id: string;
  title: string;
  updatedAt: Date;
  messages: Message[];
};

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as any[];
    return parsed.map(s => ({
      ...s,
      updatedAt: new Date(s.updatedAt),
      messages: s.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }))
    })).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  try {
    // Keep last 30 sessions
    const toSave = sessions.slice(0, 30);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(toSave));
  } catch { /* storage full */ }
}

// ── Types ─────────────────────────────────────────────────────────────────────
type SseEvent =
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, any> }
  | { type: "tool_progress"; name: string; status?: string; percent?: number | null; message?: string; jobId?: string }
  | { type: "tool_done"; name: string; result: any }
  | { type: "navigate"; tab: string }
  | { type: "artifact"; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; content?: string }
  | { type: "error"; message: string }
  | { type: "done" };

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "tool_start"; name: string; args: Record<string, any>; done?: boolean; result?: any; progress?: number | null; progressMsg?: string }
  | { kind: "artifact"; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; content?: string };

type Message = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: Date;
};

// ── Tool icon/label mapping ───────────────────────────────────────────────────
const TOOL_META: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  get_video_info:      { icon: <Bot className="w-3.5 h-3.5" />,       label: "Fetching video info",       color: "text-blue-400"   },
  download_video:      { icon: <Download className="w-3.5 h-3.5" />,   label: "Downloading video",         color: "text-green-400"  },
  cut_video_clip:      { icon: <Scissors className="w-3.5 h-3.5" />,   label: "Cutting clip",              color: "text-yellow-400" },
  find_best_clips:     { icon: <Sparkles className="w-3.5 h-3.5" />,   label: "Finding best clips",        color: "text-purple-400" },
  generate_subtitles:  { icon: <Captions className="w-3.5 h-3.5" />,   label: "Generating subtitles",      color: "text-teal-400"   },
  generate_timestamps: { icon: <AlarmClock className="w-3.5 h-3.5" />, label: "Generating timestamps",     color: "text-orange-400" },
  list_shared_files:   { icon: <UploadCloud className="w-3.5 h-3.5" />,label: "Listing shared files",      color: "text-pink-400"   },
  navigate_to_tab:     { icon: <ChevronRight className="w-3.5 h-3.5" />,label: "Navigating to tab",        color: "text-white/60"   },
};

const TAB_ICONS: Record<string, React.ReactNode> = {
  download:    <Download className="w-3.5 h-3.5" />,
  clips:       <Sparkles className="w-3.5 h-3.5" />,
  subtitles:   <Captions className="w-3.5 h-3.5" />,
  clipcutter:  <Scissors className="w-3.5 h-3.5" />,
  bhagwat:     <Shield className="w-3.5 h-3.5" />,
  scenefinder: <ListVideo className="w-3.5 h-3.5" />,
  timestamps:  <AlarmClock className="w-3.5 h-3.5" />,
  upload:      <UploadCloud className="w-3.5 h-3.5" />,
};

// ── Starter prompts ───────────────────────────────────────────────────────────
const STARTERS = [
  { icon: <Scissors className="w-4 h-4" />, text: "Cut a clip from 5:32 to 6:23" },
  { icon: <Sparkles className="w-4 h-4" />, text: "Find the best clips from this video" },
  { icon: <Captions className="w-4 h-4" />, text: "Generate Hindi subtitles for a video" },
  { icon: <AlarmClock className="w-4 h-4" />, text: "Create chapter timestamps" },
  { icon: <Download className="w-4 h-4" />, text: "Download this YouTube video in 1080p" },
  { icon: <Bot className="w-4 h-4" />, text: "What can you do?" },
];

// ── Simple inline Markdown renderer ─────────────────────────────────────────
function renderMd(text: string): React.ReactNode {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];

  lines.forEach((line, li) => {
    // Ordered list item
    const olMatch = /^(\d+)\.\s+(.*)/.exec(line);
    // Unordered list item
    const ulMatch = /^[-*]\s+(.*)/.exec(line);

    const inlineRender = (str: string, key: string): React.ReactNode => {
      const parts: React.ReactNode[] = [];
      // Split on bold (**text**), inline code (`code`)
      const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0; let m;
      let k = 0;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) parts.push(<span key={`${key}-t${k++}`}>{str.slice(last, m.index)}</span>);
        const tok = m[0];
        if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${k++}`}>{tok.slice(2, -2)}</strong>);
        else if (tok.startsWith("`")) parts.push(<code key={`${key}-c${k++}`}>{tok.slice(1, -1)}</code>);
        last = m.index + tok.length;
      }
      if (last < str.length) parts.push(<span key={`${key}-e`}>{str.slice(last)}</span>);
      return parts.length > 0 ? parts : str;
    };

    if (olMatch) {
      result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/40 shrink-0">{olMatch[1]}.</span><span>{inlineRender(olMatch[2], `ol${li}`)}</span></div>);
    } else if (ulMatch) {
      result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/30 shrink-0">•</span><span>{inlineRender(ulMatch[1], `ul${li}`)}</span></div>);
    } else if (line.trim() === "") {
      if (li < lines.length - 1) result.push(<div key={li} className="h-2" />);
    } else {
      result.push(<div key={li}>{inlineRender(line, `ln${li}`)}</div>);
    }
  });

  return result;
}

// ── Genspark-style ToolCard (inline row) ────────────────────────────────────
function ToolCard({ part }: { part: MessagePart & { kind: "tool_start" } }) {
  const meta = TOOL_META[part.name] ?? { icon: <Bot className="w-3.5 h-3.5" />, label: part.name, color: "text-white/60" };

  const argStr = Object.entries(part.args)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).length > 50 ? String(v).slice(0, 47) + "…" : v}`)
    .join(" · ");

  const pct = part.progress;
  const hasProgress = pct !== null && pct !== undefined;

  return (
    <div className="copilot-tool-row">
      {/* "Using Tool" label */}
      <span className="text-white/25 text-[10px] font-medium shrink-0">Using Tool</span>
      <span className="copilot-tool-divider" />
      {/* Icon + name */}
      <span className={cn("shrink-0", meta.color)}>{meta.icon}</span>
      <span className={cn("copilot-tool-label", meta.color)}>{meta.label}</span>
      {/* Args */}
      {argStr && (
        <>
          <span className="copilot-tool-divider" />
          <span className="copilot-tool-args">{argStr}</span>
        </>
      )}
      {/* Status icon */}
      <span className="copilot-tool-status">
        {part.done
          ? <CheckCircle className="w-3.5 h-3.5 text-green-500" />
          : hasProgress
            ? <span className="text-[10px] text-white/40 font-mono">{pct}%</span>
            : <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />
        }
      </span>

      {/* Progress bar row below (when in progress) */}
      {!part.done && hasProgress && (
        <div className="absolute left-0 right-0 bottom-0 h-[2px] rounded-b-[8px] bg-white/5 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-500" style={{ width: `${Math.max(2, pct!)}%` }} />
        </div>
      )}
    </div>
  );
}

// ── ArtifactCard sub-component ────────────────────────────────────────────────
function ArtifactCard({
  part,
  onNavigate,
}: {
  part: MessagePart & { kind: "artifact" };
  onNavigate?: (tab: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyText = () => {
    if (!part.content) return;
    void navigator.clipboard.writeText(part.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Download artifact — real file link
  if (part.artifactType === "download" && part.downloadUrl) {
    return (
      <div className="rounded-2xl border border-green-500/25 bg-green-500/8 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="p-2 rounded-xl bg-green-500/15 shrink-0">
            <CheckCircle className="w-5 h-5 text-green-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-green-300">✅ Ready to download</p>
            <p className="text-xs text-white/50 truncate mt-0.5">{part.label}</p>
          </div>
        </div>
        <div className="px-4 pb-3 flex gap-2">
          <a
            href={part.downloadUrl}
            download
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-sm text-white transition-all"
            style={{ background: "linear-gradient(135deg, #16a34a, #15803d)", boxShadow: "0 4px 16px rgba(22,163,74,0.35)" }}
          >
            <Download className="w-4 h-4" />
            Download File
          </a>
          {part.tab && onNavigate && (
            <button
              onClick={() => onNavigate(part.tab!)}
              className="px-3 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-xs font-medium transition-colors"
            >
              Open Tab
            </button>
          )}
        </div>
      </div>
    );
  }

  // Text artifact (timestamps, etc.)
  if (part.artifactType === "text" && part.content) {
    return (
      <div className="rounded-xl border border-white/12 bg-white/[0.04] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/8">
          <span className="text-xs font-semibold text-white/70">{part.label}</span>
          <button
            onClick={copyText}
            className="text-[10px] text-white/40 hover:text-white/80 transition-colors px-2 py-0.5 rounded bg-white/6"
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        <pre className="text-xs text-white/70 font-mono p-3 overflow-x-auto max-h-48 whitespace-pre-wrap">
          {part.content}
        </pre>
      </div>
    );
  }

  // Tab link artifact
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/8 px-3 py-2.5 flex items-center gap-3">
      <div className="p-1.5 rounded-lg bg-primary/15">
        {part.tab ? (TAB_ICONS[part.tab] ?? <Bot className="w-4 h-4" />) : <CheckCircle className="w-4 h-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white/90 truncate">{part.label}</p>
        {part.tab && (
          <p className="text-[10px] text-white/40 mt-0.5">
            View in <span className="capitalize">{part.tab}</span> tab
          </p>
        )}
      </div>
      {part.tab && onNavigate && (
        <button
          onClick={() => onNavigate(part.tab!)}
          className="shrink-0 px-2.5 py-1 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary text-xs font-semibold transition-colors"
        >
          Open →
        </button>
      )}
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────
function MessageBubble({
  message,
  onNavigate,
}: {
  message: Message;
  onNavigate?: (tab: string) => void;
}) {
  const isUser = message.role === "user";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={cn("flex gap-3 w-full", isUser ? "justify-end" : "justify-start")}
    >
      {!isUser && (
        <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
          style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}

      <div className={cn("flex flex-col gap-2 max-w-[82%]", isUser && "items-end")}>
        {message.parts.map((part, i) => {
          if (part.kind === "text") {
            if (!part.content.trim()) return null;
            return (
              <div
                key={i}
                className={cn(
                  "rounded-2xl px-4 py-3 text-sm leading-relaxed",
                  isUser
                    ? "bg-[#dc2626] text-white rounded-tr-sm"
                    : "bg-white/[0.05] text-white/90 rounded-tl-sm border border-white/[0.07] copilot-md"
                )}
              >
                {isUser ? part.content : renderMd(part.content)}
              </div>
            );
          }

          if (part.kind === "tool_start") {
            return <ToolCard key={i} part={part} />;
          }

          if (part.kind === "artifact") {
            return <ArtifactCard key={i} part={part} onNavigate={onNavigate} />;
          }

          return null;
        })}
        <span className="text-[10px] text-white/25 px-1">
          {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      {isUser && (
        <div className="shrink-0 w-7 h-7 rounded-full bg-white/10 border border-white/15 flex items-center justify-center mt-0.5">
          <User className="w-3.5 h-3.5 text-white/60" />
        </div>
      )}
    </motion.div>
  );
}

// ── Main StudioCopilot component ──────────────────────────────────────────────
export function StudioCopilot({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<any>(null);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  // Load sessions on mount
  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    if (loaded.length > 0) {
      setCurrentSessionId(loaded[0].id);
    }
  }, []);

  const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages ?? [];

  // Save sessions to localStorage whenever they change
  useEffect(() => {
    if (!streaming && sessions.length > 0) {
      saveSessions(sessions);
    }
  }, [sessions, streaming]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentMessages]);

  const updateCurrentSession = useCallback((updater: (msgs: Message[]) => Message[]) => {
    setSessions(prev => {
      const activeId = currentSessionId ?? crypto.randomUUID();
      const existing = prev.find(s => s.id === activeId);

      const oldMsgs = existing?.messages ?? [];
      const newMsgs = updater(oldMsgs);

      // Extract title from first user message
      let title = existing?.title ?? "New Chat";
      if (!existing || existing.title === "New Chat") {
        const firstUser = newMsgs.find(m => m.role === "user")?.parts[0];
        if (firstUser?.kind === "text") {
          title = firstUser.content.slice(0, 40) + (firstUser.content.length > 40 ? "..." : "");
        }
      }

      const updatedSession: ChatSession = {
        id: activeId,
        title,
        updatedAt: new Date(),
        messages: newMsgs
      };

      if (!existing && !currentSessionId) {
        setTimeout(() => setCurrentSessionId(activeId), 0);
      }

      const filtered = prev.filter(s => s.id !== activeId);
      return [updatedSession, ...filtered];
    });
  }, [currentSessionId]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  };

  // Send message and stream response
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", content: trimmed }],
      timestamp: new Date(),
    };

    updateCurrentSession(prev => [...prev, userMsg]);
    setStreaming(true);

    // Build conversation history for API
    const history = [...currentMessages, userMsg].map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      content: m.parts.filter(p => p.kind === "text").map(p => (p as any).content).join("\n"),
    }));

    // Create assistant message placeholder
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      parts: [],
      timestamp: new Date(),
    };
    updateCurrentSession(prev => [...prev, assistantMsg]);

    abortRef.current = new AbortController();

    try {
      const resp = await fetch(`${BASE}/api/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`Server error: ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const updateAssistant = (updater: (prev: Message) => Message) => {
        updateCurrentSession(msgs => msgs.map(m => m.id === assistantId ? updater(m) : m));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6)) as SseEvent;

            if (evt.type === "text") {
              updateAssistant(m => {
                const parts = [...m.parts];
                const last = parts[parts.length - 1];
                if (last?.kind === "text") {
                  return { ...m, parts: [...parts.slice(0, -1), { kind: "text", content: last.content + evt.content }] };
                }
                return { ...m, parts: [...parts, { kind: "text", content: evt.content }] };
              });
            }

            else if (evt.type === "tool_start") {
              updateAssistant(m => ({
                ...m,
                parts: [...m.parts, { kind: "tool_start", name: evt.name, args: evt.args, done: false }],
              }));
            }

            else if (evt.type === "tool_progress") {
              updateAssistant(m => ({
                ...m,
                parts: m.parts.map(p =>
                  p.kind === "tool_start" && p.name === evt.name && !p.done
                    ? { ...p, progress: evt.percent ?? null, progressMsg: evt.message ?? evt.status }
                    : p
                ),
              }));
            }

            else if (evt.type === "tool_done") {
              updateAssistant(m => ({
                ...m,
                parts: m.parts.map(p =>
                  p.kind === "tool_start" && p.name === evt.name && !p.done
                    ? { ...p, done: true, result: evt.result, progress: 100 }
                    : p
                ),
              }));
            }

            else if (evt.type === "navigate" && onNavigate) {
              onNavigate(evt.tab);
            }

            else if (evt.type === "artifact") {
              const e = evt as any;
              updateAssistant(m => ({
                ...m,
                parts: [...m.parts, {
                  kind: "artifact",
                  artifactType: e.artifactType,
                  label: e.label,
                  tab: e.tab,
                  jobId: e.jobId,
                  downloadUrl: e.downloadUrl,
                  content: e.content,
                }],
              }));
            }

            else if (evt.type === "error") {
              updateAssistant(m => ({
                ...m,
                parts: [...m.parts, { kind: "text", content: `⚠️ ${evt.message}` }],
              }));
            }

          } catch { /* malformed SSE line, ignore */ }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        updateCurrentSession(msgs => msgs.map(m => m.id === assistantId
          ? { ...m, parts: [...m.parts, { kind: "text", content: "⚠️ Connection error. Please try again." }] }
          : m
        ));
      }
    } finally {
      setStreaming(false);
    }
  }, [currentMessages, streaming, BASE, onNavigate, updateCurrentSession, currentSessionId]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  // Stop streaming
  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  // Voice input
  const toggleVoice = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (ev: any) => {
      const transcript = ev.results[0]?.[0]?.transcript ?? "";
      setInput(prev => prev + (prev ? " " : "") + transcript);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognition.start();
    setListening(true);
  };

  const isEmpty = currentMessages.length === 0;
  const speechSupported = !!(
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );

  const handleNewChat = () => {
    if (streaming) return;
    setCurrentSessionId(null);
    setShowHistory(false);
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) setCurrentSessionId(null);
  };

  return (
    <div className="copilot-wrap">
      {/* ── Top Header Bar ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-[#111111]/80 shrink-0 z-10 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-white/90">Copilot</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={cn("p-2 rounded-lg transition-colors", showHistory ? "bg-white/10 text-white" : "text-white/40 hover:bg-white/5 hover:text-white/80")}
            title="Chat History"
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={handleNewChat}
            disabled={streaming}
            className="p-2 rounded-lg text-white/40 hover:bg-white/5 hover:text-white/80 transition-colors disabled:opacity-40"
            title="New Chat"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── History Panel Overlay ── */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="absolute inset-y-[45px] left-0 right-0 bg-[#111111]/95 backdrop-blur-xl z-20 flex flex-col border-b border-white/[0.06]"
          >
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
              <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Chat History</span>
              <button onClick={() => setShowHistory(false)} className="text-white/40 hover:text-white"><X className="w-4 h-4"/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
              {sessions.length === 0 ? (
                <div className="p-4 text-center text-white/30 text-xs">No previous chats</div>
              ) : (
                sessions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => { setCurrentSessionId(s.id); setShowHistory(false); }}
                    className={cn(
                      "flex items-center justify-between px-3 py-2.5 rounded-xl text-left text-sm transition-colors group",
                      currentSessionId === s.id ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5"
                    )}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium truncate pr-4">{s.title}</span>
                      <span className="text-[10px] text-white/30 mt-0.5">{s.updatedAt.toLocaleDateString()} {s.updatedAt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    </div>
                    <div
                      onClick={(e) => deleteSession(s.id, e)}
                      className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Empty state / Welcome ── */}
      {isEmpty && (
        <div className="copilot-welcome">
          <div className="copilot-orb">
            <Bot className="w-8 h-8 text-primary" />
          </div>
          <h2 className="copilot-welcome-title">AI Studio Copilot</h2>
          <p className="copilot-welcome-sub">
            Autonomous AI agent with full access to every studio tool.<br />
            Just give me a YouTube URL and a task — I'll handle everything.
          </p>

          <div className="copilot-starters">
            {STARTERS.map((s, i) => (
              <button
                key={i}
                onClick={() => void sendMessage(s.text)}
                className="copilot-starter-btn"
              >
                <span className="copilot-starter-icon">{s.icon}</span>
                <span>{s.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      {!isEmpty && (
        <div className="copilot-messages">
          <AnimatePresence initial={false}>
            {currentMessages.map(msg => (
              <MessageBubble key={msg.id} message={msg} onNavigate={onNavigate} />
            ))}
          </AnimatePresence>

          {/* Streaming indicator */}
          {streaming && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex gap-3 items-center"
            >
              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="flex items-center gap-1 px-4 py-3 rounded-2xl rounded-tl-sm bg-white/[0.07] border border-white/8">
                {[0, 0.15, 0.3].map((delay, i) => (
                  <span key={i} className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce"
                    style={{ animationDelay: `${delay}s`, animationDuration: "0.8s" }} />
                ))}
              </div>
            </motion.div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

      {/* ── Input area ── */}
      <div className="copilot-input-wrap">
        <form onSubmit={handleSubmit} className="copilot-input-form">
          <div className="copilot-input-box">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything — cut a clip, find best moments, download, subtitle…"
              rows={1}
              className="copilot-textarea"
              disabled={streaming}
            />

            <div className="copilot-input-actions">
              {speechSupported && (
                <button
                  type="button"
                  onClick={toggleVoice}
                  className={cn("copilot-action-btn", listening && "text-red-400")}
                  title={listening ? "Stop listening" : "Voice input"}
                >
                  {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              )}

              {streaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="copilot-action-btn text-red-400"
                  title="Stop"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className={cn(
                    "copilot-send-btn",
                    input.trim() ? "copilot-send-btn-active" : "copilot-send-btn-disabled"
                  )}
                  title="Send"
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <p className="copilot-hint">
            Powered by Gemini · Press Enter to send, Shift+Enter for newline
          </p>
        </form>
      </div>

    </div>
  );
}
