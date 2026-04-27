import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Bot, User, Loader2, CheckCircle, ChevronRight,
  Download, Scissors, Sparkles, Captions, AlarmClock,
  UploadCloud, Shield, ListVideo, X, Mic, MicOff, Trash2, Clock, History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { loadSessions, saveSession, deleteSession, createSession, type AgentSession } from "@/lib/session-history";

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

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type SseEvent =
  | { type: "run_start"; runId: string; ts?: number }
  | { type: "thinking"; runId?: string; stage?: string; iteration?: number }
  | { type: "heartbeat"; runId?: string; ts?: number }
  | { type: "text"; content: string; runId?: string }
  | { type: "tool_start"; runId?: string; toolId?: string; name: string; args: Record<string, any>; ts?: number }
  | { type: "tool_log"; runId?: string; toolId?: string; name: string; message: string; details?: Record<string, any>; level?: "info" | "error" | "warn" }
  | { type: "tool_progress"; runId?: string; toolId?: string; name: string; status?: string; percent?: number | null; message?: string; jobId?: string }
  | { type: "tool_done"; runId?: string; toolId?: string; name: string; result: any; ts?: number }
  | { type: "navigate"; tab: string }
  | { type: "artifact"; runId?: string; toolId?: string; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; content?: string }
  | { type: "error"; message: string }
  | { type: "done"; runId?: string; ts?: number };

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "tool_start"; toolId?: string; runId?: string; name: string; args: Record<string, any>; done?: boolean; result?: any; progress?: number | null; progressMsg?: string }
  | { kind: "artifact"; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; content?: string };

type Message = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: Date;
};

type ToolTraceLog = {
  ts: number;
  message: string;
  details?: Record<string, any>;
  level?: "info" | "error" | "warn";
};

type ToolTrace = {
  toolId: string;
  runId?: string;
  name: string;
  args: Record<string, any>;
  startedAt: number;
  completedAt?: number;
  status: "running" | "done" | "error";
  progress?: number | null;
  progressMsg?: string;
  result?: any;
  logs: ToolTraceLog[];
};

// â”€â”€ Tool icon/label mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Starter prompts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STARTERS = [
  { icon: <Scissors className="w-4 h-4" />, text: "Cut a clip from 5:32 to 6:23" },
  { icon: <Sparkles className="w-4 h-4" />, text: "Find the best clips from this video" },
  { icon: <Captions className="w-4 h-4" />, text: "Generate Hindi subtitles for a video" },
  { icon: <AlarmClock className="w-4 h-4" />, text: "Create chapter timestamps" },
  { icon: <Download className="w-4 h-4" />, text: "Download this YouTube video in 1080p" },
  { icon: <Bot className="w-4 h-4" />, text: "What can you do?" },
];

// â”€â”€ Simple inline Markdown renderer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/30 shrink-0">â€¢</span><span>{inlineRender(ulMatch[1], `ul${li}`)}</span></div>);
    } else if (line.trim() === "") {
      if (li < lines.length - 1) result.push(<div key={li} className="h-2" />);
    } else {
      result.push(<div key={li}>{inlineRender(line, `ln${li}`)}</div>);
    }
  });

  return result;
}

// â”€â”€ Genspark-style ToolCard (inline row) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ToolCard({
  part,
  onInspect,
}: {
  part: MessagePart & { kind: "tool_start" };
  onInspect?: (toolId?: string) => void;
}) {
  const meta = TOOL_META[part.name] ?? { icon: <Bot className="w-3.5 h-3.5" />, label: part.name, color: "text-white/60" };
  const pct = part.progress;
  const hasProgress = pct !== null && pct !== undefined;
  const liveMsg = part.progressMsg;

  const argStr = Object.entries(part.args)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).length > 48 ? String(v).slice(0, 45) + "..." : v}`)
    .join("  ·  ");

  return (
    <div className={cn("agent-tool-card", part.done && "agent-tool-card-done")}>
      {/* Top row: icon + name + args + status */}
      <div className="agent-tool-card-top">
        <span className="agent-tool-using">Using</span>
        <span className="agent-tool-divider" />
        <span className={cn("agent-tool-icon shrink-0", meta.color)}>{meta.icon}</span>
        <span className={cn("agent-tool-name", meta.color)}>{meta.label}</span>
        {argStr && (
          <>
            <span className="agent-tool-divider" />
            <span className="agent-tool-args">{argStr}</span>
          </>
        )}
        <span className="agent-tool-status-wrap">
          {part.done
            ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
            : hasProgress
              ? <span className="agent-tool-pct">{pct}%</span>
              : <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />
          }
          {onInspect && (
            <button type="button" onClick={() => onInspect(part.toolId)} className="agent-tool-trace-btn">
              Trace
            </button>
          )}
        </span>
      </div>

      {/* Live status message — streams in real time from tool_progress events */}
      {!part.done && liveMsg && (
        <div className="agent-tool-live-msg">
          <span className="agent-tool-live-dot" />
          <span className="agent-tool-live-text">{liveMsg}</span>
        </div>
      )}

      {/* Progress bar — always visible when percent known */}
      {!part.done && (
        <div className="agent-tool-progress-track">
          <div
            className="agent-tool-progress-fill"
            style={{ width: hasProgress ? `${Math.max(3, pct!)}%` : "0%", transition: hasProgress ? "width 0.6s ease" : "none" }}
          />
          {/* Indeterminate shimmer when no % known */}
          {!hasProgress && <div className="agent-tool-progress-shimmer" />}
        </div>
      )}
    </div>
  );
}

// â”€â”€ ArtifactCard sub-component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Download artifact â€” real file link
  if (part.artifactType === "download" && part.downloadUrl) {
    return (
      <div className="rounded-2xl border border-green-500/25 bg-green-500/8 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="p-2 rounded-xl bg-green-500/15 shrink-0">
            <CheckCircle className="w-5 h-5 text-green-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-green-300">âœ… Ready to download</p>
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
            {copied ? "âœ“ Copied" : "Copy"}
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
          Open â†’
        </button>
      )}
    </div>
  );
}

// Plan card — shows upcoming tool execution plan
function PlanCard({ part }: { part: MessagePart & { kind: "plan" } }) {
  return (
    <div className="agent-plan-card">
      <div className="agent-plan-header">
        <span className="agent-plan-icon">⚡</span>
        <span className="agent-plan-title">
          {part.iteration ? `Step ${part.iteration} — ` : ""}Executing plan
        </span>
      </div>
      <div className="agent-plan-steps">
        {part.steps.map((s, i) => {
          const meta = (TOOL_META as any)[s.tool];
          return (
            <div key={i} className="agent-plan-step">
              <span className={meta?.color ?? "text-white/50"}>{meta?.icon}</span>
              <span className="agent-plan-step-name">{meta?.label ?? s.tool}</span>
              {s.args.url && (
                <span className="agent-plan-step-arg">
                  {String(s.args.url).length > 42 ? String(s.args.url).slice(0, 39) + "..." : s.args.url}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// â”€â”€ MessageBubble â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function MessageBubble({
  message,
  onNavigate,
  onInspectTool,
}: {
  message: Message;
  onNavigate?: (tab: string) => void;
  onInspectTool?: (toolId?: string) => void;
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
        <div className="agent-avatar shrink-0 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
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
            return <ToolCard key={i} part={part} onInspect={onInspectTool} />;
          }

          if (part.kind === "plan") {
            return <PlanCard key={i} part={part} />;
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

// â”€â”€ Main StudioCopilot component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function StudioCopilot({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [agentStage, setAgentStage] = useState<"idle" | "planning" | "executing" | "verifying">("idle");
  const [agentIteration, setAgentIteration] = useState(0);
  const [toolTraces, setToolTraces] = useState<Record<string, ToolTrace>>({});
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<any>(null);
  // Stable ref to avoid stale closure captures during streaming
  const currentSessionIdRef = useRef<string | null>(null);
  const currentMessagesRef = useRef<Message[]>([]);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  // Load sessions on mount
  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    if (loaded.length > 0) {
      setCurrentSessionId(loaded[0].id);
      currentSessionIdRef.current = loaded[0].id;
    }
  }, []);

  const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages ?? [];

  // Keep refs in sync
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  useEffect(() => {
    currentMessagesRef.current = currentMessages;
  }, [currentMessages]);

  // Save sessions to localStorage whenever they change
  useEffect(() => {
    if (!streaming && sessions.length > 0) {
      saveSessions(sessions);
    }
  }, [sessions, streaming]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentMessages]);

  // Always uses the latest sessionId from ref â€” no stale closure
  const updateSession = useCallback((sessionId: string, updater: (msgs: Message[]) => Message[]) => {
    setSessions(prev => {
      const existing = prev.find(s => s.id === sessionId);
      const oldMsgs = existing?.messages ?? [];
      const newMsgs = updater(oldMsgs);
      let title = existing?.title ?? "New Chat";
      if (!existing || existing.title === "New Chat") {
        const firstUser = newMsgs.find(m => m.role === "user")?.parts[0];
        if (firstUser?.kind === "text") {
          title = firstUser.content.slice(0, 40) + (firstUser.content.length > 40 ? "..." : "");
        }
      }
      const updated: ChatSession = { id: sessionId, title, updatedAt: new Date(), messages: newMsgs };
      return [updated, ...prev.filter(s => s.id !== sessionId)];
    });
  }, []);

  // Creates a new session if needed and returns its id
  const ensureSession = useCallback((): string => {
    const sid = currentSessionIdRef.current ?? crypto.randomUUID();
    if (!currentSessionIdRef.current) {
      currentSessionIdRef.current = sid;
      setCurrentSessionId(sid);
    }
    return sid;
  }, []);

  const upsertToolTrace = useCallback((toolId: string, updater: (prev?: ToolTrace) => ToolTrace) => {
    setToolTraces(prev => {
      const next = updater(prev[toolId]);
      return { ...prev, [toolId]: next };
    });
  }, []);

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
    if (inputRef.current) inputRef.current.style.height = "auto";

    const sessionId = ensureSession();

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", content: trimmed }],
      timestamp: new Date(),
    };
    updateSession(sessionId, prev => [...prev, userMsg]);
    setStreaming(true);
    setCurrentRunId(null);
    setThinking(true);
    setToolTraces({});
    setActiveToolId(null);

    // Build history from the ref (not stale closure)
    const history = [...currentMessagesRef.current, userMsg].map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      content: m.parts.filter(p => p.kind === "text").map(p => (p as any).content).join("\n"),
    })).filter(m => m.content.trim());

    const assistantId = crypto.randomUUID();
    updateSession(sessionId, prev => [...prev, {
      id: assistantId, role: "assistant", parts: [], timestamp: new Date(),
    }]);

    abortRef.current = new AbortController();

    // Helper: patch the assistant message in place
    const patchAssistant = (updater: (msg: Message) => Message) => {
      updateSession(sessionId, msgs => msgs.map(m => m.id === assistantId ? updater(m) : m));
    };

    const appendAssistantText = (content: string) => {
      patchAssistant(m => {
        const parts = [...m.parts];
        const last = parts[parts.length - 1];
        if (last?.kind === "text") {
          return { ...m, parts: [...parts.slice(0, -1), { kind: "text", content: last.content + content }] };
        }
        return { ...m, parts: [...parts, { kind: "text", content }] };
      });
    };

    const handleEvent = (evt: SseEvent) => {
      if (evt.type === "run_start") {
        setCurrentRunId(evt.runId);
        return;
      }

      if (evt.type === "heartbeat") return;

      if (evt.type === "thinking") {
        setThinking(true);
        return;
      }

      if (evt.type === "text") {
        setThinking(false);
        appendAssistantText(evt.content);
        return;
      }

      if (evt.type === "tool_start") {
        setThinking(false);
        patchAssistant(m => {
          const exists = m.parts.some(
            p => p.kind === "tool_start" &&
              ((evt.toolId && p.toolId === evt.toolId) || (!evt.toolId && p.name === evt.name && !p.done)),
          );
          if (exists) return m;
          return {
            ...m,
            parts: [...m.parts, {
              kind: "tool_start",
              toolId: evt.toolId,
              runId: evt.runId,
              name: evt.name,
              args: evt.args,
              done: false,
              progress: null,
            }],
          };
        });

        if (evt.toolId) {
          upsertToolTrace(evt.toolId, prev => ({
            toolId: evt.toolId!,
            runId: evt.runId,
            name: evt.name,
            args: evt.args ?? {},
            startedAt: evt.ts ?? Date.now(),
            completedAt: prev?.completedAt,
            status: prev?.status === "error" ? "error" : "running",
            progress: prev?.progress,
            progressMsg: prev?.progressMsg,
            result: prev?.result,
            logs: prev?.logs ?? [{ ts: Date.now(), message: "Tool execution started" }],
          }));
          setActiveToolId(current => current ?? evt.toolId!);
        }
        return;
      }

      if (evt.type === "tool_log") {
        if (!evt.toolId) return;
        upsertToolTrace(evt.toolId, prev => ({
          toolId: evt.toolId!,
          runId: evt.runId ?? prev?.runId,
          name: evt.name ?? prev?.name ?? "tool",
          args: prev?.args ?? {},
          startedAt: prev?.startedAt ?? Date.now(),
          completedAt: prev?.completedAt,
          status: prev?.status ?? "running",
          progress: prev?.progress,
          progressMsg: prev?.progressMsg,
          result: prev?.result,
          logs: [...(prev?.logs ?? []), {
            ts: Date.now(),
            message: evt.message,
            details: evt.details,
            level: evt.level ?? "info",
          }],
        }));
        return;
      }

      if (evt.type === "tool_progress") {
        patchAssistant(m => ({
          ...m,
          parts: m.parts.map(p =>
            p.kind === "tool_start" &&
            ((evt.toolId && p.toolId === evt.toolId) || (!evt.toolId && p.name === evt.name && !p.done))
              ? { ...p, progress: evt.percent ?? p.progress ?? null, progressMsg: evt.message ?? evt.status }
              : p,
          ),
        }));

        if (evt.toolId) {
          upsertToolTrace(evt.toolId, prev => ({
            toolId: evt.toolId!,
            runId: evt.runId ?? prev?.runId,
            name: evt.name ?? prev?.name ?? "tool",
            args: prev?.args ?? {},
            startedAt: prev?.startedAt ?? Date.now(),
            completedAt: prev?.completedAt,
            status: evt.status === "error" ? "error" : (prev?.status ?? "running"),
            progress: evt.percent ?? prev?.progress,
            progressMsg: evt.message ?? evt.status ?? prev?.progressMsg,
            result: prev?.result,
            logs: evt.message ? [...(prev?.logs ?? []), { ts: Date.now(), message: evt.message }] : (prev?.logs ?? []),
          }));
        }
        return;
      }

      if (evt.type === "tool_done") {
        setThinking(false);
        patchAssistant(m => ({
          ...m,
          parts: m.parts.map(p =>
            p.kind === "tool_start" &&
            ((evt.toolId && p.toolId === evt.toolId) || (!evt.toolId && p.name === evt.name && !p.done))
              ? { ...p, done: true, result: evt.result, progress: 100 }
              : p,
          ),
        }));

        if (evt.toolId) {
          upsertToolTrace(evt.toolId, prev => ({
            toolId: evt.toolId!,
            runId: evt.runId ?? prev?.runId,
            name: evt.name ?? prev?.name ?? "tool",
            args: prev?.args ?? {},
            startedAt: prev?.startedAt ?? Date.now(),
            completedAt: evt.ts ?? Date.now(),
            status: evt.result?.error ? "error" : "done",
            progress: 100,
            progressMsg: evt.result?.error ? "Failed" : "Completed",
            result: evt.result,
            logs: [...(prev?.logs ?? []), {
              ts: Date.now(),
              message: evt.result?.error ? "Tool finished with error" : "Tool completed",
            }],
          }));
          setActiveToolId(evt.toolId);
        }
        return;
      }

      if (evt.type === "navigate") {
        if (onNavigate) onNavigate(evt.tab);
        return;
      }

      if (evt.type === "artifact") {
        patchAssistant(m => ({
          ...m,
          parts: [...m.parts, {
            kind: "artifact",
            artifactType: evt.artifactType,
            label: evt.label,
            tab: evt.tab,
            jobId: evt.jobId,
            downloadUrl: evt.downloadUrl,
            content: evt.content,
          }],
        }));

        if (evt.toolId) {
          upsertToolTrace(evt.toolId, prev => ({
            toolId: evt.toolId!,
            runId: evt.runId ?? prev?.runId,
            name: prev?.name ?? "tool",
            args: prev?.args ?? {},
            startedAt: prev?.startedAt ?? Date.now(),
            completedAt: prev?.completedAt,
            status: prev?.status ?? "running",
            progress: prev?.progress,
            progressMsg: prev?.progressMsg,
            result: prev?.result,
            logs: [...(prev?.logs ?? []), { ts: Date.now(), message: `Artifact ready: ${evt.label}` }],
          }));
        }
        return;
      }

      if (evt.type === "error") {
        setThinking(false);
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: `[Warning] ${evt.message}` }] }));
        return;
      }

      if (evt.type === "done") {
        setThinking(false);
      }
    };

    try {
      const resp = await fetch(`${BASE}/api/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) throw new Error(`Server error: ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse complete SSE frames separated by blank lines.
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLines = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart());
          if (!dataLines.length) continue;

          const raw = dataLines.join("\n").trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as SseEvent;
            handleEvent(evt);
            continue;
          } catch {
            // malformed SSE frame - skip
          }
        }
      }

      // Parse any trailing complete "data:" lines left in the buffer.
      const trailingLines = buffer
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart());
      if (trailingLines.length) {
        const raw = trailingLines.join("\n").trim();
        if (raw) {
          try {
            const evt = JSON.parse(raw) as SseEvent;
            handleEvent(evt);
          } catch {
            // Ignore malformed trailing payload
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: "[Warning] Connection interrupted. The job may still be running in Activity." }] }));
      }
    } finally {
      setStreaming(false);
      setThinking(false);
    }
  }, [streaming, BASE, onNavigate, updateSession, ensureSession, upsertToolTrace]);

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
    setThinking(false);
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
  const toolTraceList = Object.values(toolTraces).sort((a, b) => b.startedAt - a.startedAt);
  const activeToolTrace = activeToolId ? toolTraces[activeToolId] : (toolTraceList[0] ?? null);
  const showInspector = !isEmpty && (streaming || toolTraceList.length > 0);

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
      {/* â”€â”€ Genspark-style top header â”€â”€ */}
      <div className="agent-header">
        <div className="agent-header-brand">
          <div className="agent-header-orb">
            <Bot className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="agent-header-title">Studio Agent</span>
          {currentRunId && (
            <span className="agent-header-run">runÂ {currentRunId.slice(0, 6)}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={cn("agent-hdr-btn", showHistory && "agent-hdr-btn-active")}
            title="Chat History"
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={handleNewChat}
            disabled={streaming}
            className="agent-hdr-btn disabled:opacity-40"
            title="New Chat"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* â”€â”€ History Panel Overlay â”€â”€ */}
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

      {/* â”€â”€ Empty state / Genspark Hero â”€â”€ */}
      {isEmpty && (
        <div className="agent-hero">
          <div className="agent-hero-inner">
            <div className="agent-orb">
              <Bot className="w-6 h-6 text-primary" />
            </div>
            <h1 className="agent-hero-title">
              <span className="agent-hero-gradient">Ask anything,</span>
              <span className="text-white"> create anything</span>
            </h1>
            <p className="agent-hero-sub">
              Autonomous AI agent &middot; Full studio access &middot; Real-time execution
            </p>
            <div className="agent-bubbles">
              {STARTERS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => void sendMessage(s.text)}
                  className="agent-bubble"
                >
                  <span className="agent-bubble-icon">{s.icon}</span>
                  <span className="agent-bubble-label">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Messages â”€â”€ */}
      {!isEmpty && (
        <div className="copilot-conversation-shell">
          <div className="copilot-messages">
            <div className="agent-msg-col">
              <AnimatePresence initial={false}>
                {currentMessages.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onNavigate={onNavigate}
                    onInspectTool={(toolId) => toolId && setActiveToolId(toolId)}
                  />
                ))}
              </AnimatePresence>

              {streaming && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex gap-3 items-start"
                >
                  <div className="agent-avatar shrink-0">
                    <Bot className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div className="agent-thinking-pill">
                    <span className="agent-thinking-dot" />
                    <span className="agent-thinking-text">
                      {thinking ? "Thinking" : "Working"}
                    </span>
                    <span className="agent-thinking-cursor" />
                  </div>
                </motion.div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {showInspector && (
            <aside className="copilot-inspector">
              <div className="copilot-inspector-header">
                <div className="copilot-inspector-title-wrap">
                  <span className="copilot-inspector-title">Agent Trace</span>
                  {currentRunId && <span className="copilot-inspector-run">Run {currentRunId.slice(0, 8)}</span>}
                </div>
              </div>

              <div className="copilot-inspector-tools">
                {toolTraceList.map(trace => (
                  <button
                    key={trace.toolId}
                    type="button"
                    onClick={() => setActiveToolId(trace.toolId)}
                    className={cn(
                      "copilot-inspector-tool",
                      activeToolTrace?.toolId === trace.toolId && "copilot-inspector-tool-active",
                    )}
                  >
                    <span className="copilot-inspector-tool-name">{TOOL_META[trace.name]?.label ?? trace.name}</span>
                    <span
                      className={cn(
                        "copilot-inspector-tool-status",
                        trace.status === "done" && "copilot-inspector-tool-status-done",
                        trace.status === "error" && "copilot-inspector-tool-status-error",
                      )}
                    >
                      {trace.status}
                    </span>
                  </button>
                ))}
              </div>

              {activeToolTrace && (
                <div className="copilot-inspector-body">
                  <div className="copilot-inspector-section">
                    <div className="copilot-inspector-section-title">Arguments</div>
                    <pre className="copilot-inspector-code">{JSON.stringify(activeToolTrace.args ?? {}, null, 2)}</pre>
                  </div>

                  <div className="copilot-inspector-section">
                    <div className="copilot-inspector-section-title">Live Logs</div>
                    <div className="copilot-inspector-logs">
                      {activeToolTrace.logs.length === 0 && (
                        <div className="copilot-inspector-empty">Waiting for logs...</div>
                      )}
                      {activeToolTrace.logs.map((log, idx) => (
                        <div key={`${activeToolTrace.toolId}-${idx}`} className="copilot-inspector-log-row">
                          <span className="copilot-inspector-log-time">
                            {new Date(log.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </span>
                          <span
                            className={cn(
                              "copilot-inspector-log-msg",
                              log.level === "error" && "copilot-inspector-log-msg-error",
                            )}
                          >
                            {log.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {/* â”€â”€ Input area â€” Genspark style â”€â”€ */}
      <div className="agent-input-wrap">
        <form onSubmit={handleSubmit} className="agent-input-form">
          <div className="agent-input-box">
            {/* Left actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="agent-model-badge">Gemini</span>
            </div>

            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything â€” cut a clip, best moments, download, subtitlesâ€¦"
              rows={1}
              className="agent-textarea"
              disabled={streaming}
            />

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {speechSupported && (
                <button
                  type="button"
                  onClick={toggleVoice}
                  className={cn("agent-icon-btn", listening && "text-red-400")}
                  title={listening ? "Stop listening" : "Voice input"}
                >
                  {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              )}
              {streaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="agent-stop-btn"
                  title="Stop"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className={cn("agent-send-btn", input.trim() ? "agent-send-active" : "agent-send-disabled")}
                  title="Send"
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          <p className="agent-hint">
            Powered by Gemini Â· Enter to sendÂ Â·Â Shift+Enter for newline
          </p>
        </form>
      </div>

    </div>
  );
}
