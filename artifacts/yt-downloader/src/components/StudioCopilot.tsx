import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Bot, User, Loader2, CheckCircle, ChevronRight,
  Download, Scissors, Sparkles, Captions, AlarmClock,
  UploadCloud, Shield, ListVideo, X, Trash2, History, Square, Copy, Check, RotateCcw, Link,
  ArrowLeft, Pencil, Share2, MoreHorizontal, SquarePen, Plus, Paperclip, AudioLines, Menu, ArrowUp,
  ImagePlus, Music2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const ULTRA_KEY = "studio-ultra-mode";
function readUltraInitial(): boolean {
  try { return localStorage.getItem(ULTRA_KEY) === "1"; } catch { return false; }
}

const HISTORY_KEY = "copilot-sessions-v2";

type ChatSession = { id: string; title: string; updatedAt: Date; messages: Message[] };

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as any[];
    return parsed.map(s => ({ ...s, updatedAt: new Date(s.updatedAt), messages: s.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })) })).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  } catch { return []; }
}
function saveSessions(sessions: ChatSession[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.slice(0, 30))); } catch {}
}

// ── Types ──────────────────────────────────────────────────────────────────────
type SseEvent =
  | { type: "run_start"; runId: string; ts?: number }
  | { type: "thinking"; runId?: string; stage?: string; iteration?: number; total?: number }
  | { type: "heartbeat"; runId?: string; ts?: number }
  | { type: "text"; content: string; runId?: string }
  | { type: "plan"; runId?: string; iteration?: number; steps: Array<{ tool: string; args: Record<string, any> }> }
  | { type: "tool_start"; runId?: string; toolId?: string; name: string; args: Record<string, any>; ts?: number }
  | { type: "tool_log"; runId?: string; toolId?: string; name: string; message: string; level?: "info"|"error"|"warn" }
  | { type: "tool_progress"; runId?: string; toolId?: string; name: string; status?: string; percent?: number|null; message?: string; jobId?: string }
  | { type: "tool_done"; runId?: string; toolId?: string; name: string; result: any; ts?: number }
  | { type: "navigate"; tab: string }
  | { type: "artifact"; runId?: string; toolId?: string; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; content?: string }
  | { type: "suggestions"; items: string[]; runId?: string }
  | { type: "error"; message: string }
  | { type: "done"; runId?: string; ts?: number };

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "image"; previewUrl: string; name: string }
  | { kind: "plan"; steps: Array<{ tool: string; args: Record<string, any> }>; iteration?: number }
  | { kind: "tool_start"; toolId?: string; name: string; args: Record<string, any>; done?: boolean; result?: any; progress?: number|null; progressMsg?: string }
  | { kind: "artifact"; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; content?: string };

type Message = { id: string; role: "user"|"assistant"; parts: MessagePart[]; timestamp: Date };

// ── Meta ──────────────────────────────────────────────────────────────────────
const TOOL_META: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  get_video_info:      { icon: <Bot className="w-3.5 h-3.5" />,        label: "Fetching info",        color: "text-blue-400"   },
  download_video:      { icon: <Download className="w-3.5 h-3.5" />,   label: "Downloading video",    color: "text-green-400"  },
  cut_video_clip:      { icon: <Scissors className="w-3.5 h-3.5" />,   label: "Cutting clip",         color: "text-yellow-400" },
  find_best_clips:     { icon: <Sparkles className="w-3.5 h-3.5" />,   label: "Finding best clips",   color: "text-purple-400" },
  generate_subtitles:  { icon: <Captions className="w-3.5 h-3.5" />,   label: "Generating subtitles", color: "text-teal-400"   },
  generate_timestamps: { icon: <AlarmClock className="w-3.5 h-3.5" />, label: "Timestamps",           color: "text-orange-400" },
  list_shared_files:   { icon: <UploadCloud className="w-3.5 h-3.5" />,label: "Shared files",         color: "text-pink-400"   },
  navigate_to_tab:     { icon: <ChevronRight className="w-3.5 h-3.5" />,label: "Navigating",          color: "text-white/60"   },
  web_search:          { icon: <span className="text-[13px]">🔍</span>,  label: "Searching the web",   color: "text-sky-400"    },
  translate_video:     { icon: <span className="text-[13px]">🎙️</span>,  label: "Translating video",   color: "text-violet-400" },
  get_youtube_captions:{ icon: <Captions className="w-3.5 h-3.5" />,   label: "Getting captions",     color: "text-teal-400"   },
  fix_subtitles:       { icon: <Captions className="w-3.5 h-3.5" />,   label: "Fixing subtitles",     color: "text-amber-400"  },
  cancel_job:          { icon: <X className="w-3.5 h-3.5" />,           label: "Cancelling job",       color: "text-red-400"    },
  check_job_status:    { icon: <Loader2 className="w-3.5 h-3.5" />,    label: "Checking status",      color: "text-white/60"   },
  analyze_youtube_video: { icon: <span className="text-[13px]">👁️</span>, label: "Watching video",    color: "text-fuchsia-400" },
};
const TAB_ICONS: Record<string, React.ReactNode> = {
  download: <Download className="w-3.5 h-3.5" />, clips: <Sparkles className="w-3.5 h-3.5" />,
  subtitles: <Captions className="w-3.5 h-3.5" />, clipcutter: <Scissors className="w-3.5 h-3.5" />,
  bhagwat: <Shield className="w-3.5 h-3.5" />, scenefinder: <ListVideo className="w-3.5 h-3.5" />,
  timestamps: <AlarmClock className="w-3.5 h-3.5" />, upload: <UploadCloud className="w-3.5 h-3.5" />,
};
const STARTERS = [
  { icon: <Scissors className="w-4 h-4" />, text: "Cut a clip from 5:32 to 6:23" },
  { icon: <Sparkles className="w-4 h-4" />, text: "Find the best clips from this video" },
  { icon: <Captions className="w-4 h-4" />, text: "Generate Hindi subtitles for a video" },
  { icon: <AlarmClock className="w-4 h-4" />, text: "Create chapter timestamps" },
  { icon: <Download className="w-4 h-4" />, text: "Download this YouTube video in 1080p" },
  { icon: <Bot className="w-4 h-4" />, text: "What can you do?" },
];

// ── Client-side tag stripper ──────────────────────────────────────────────────
function clientStripTags(text: string): string {
  return text
    .replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, "")
    .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, "")
    .replace(/\[RESPONSE\][\s\S]*?\[\/RESPONSE\]/gi, "")
    .replace(/\[JUDGE\][\s\S]*?\[\/JUDGE\]/gi, "")
    .replace(/^\[THOUGHT\].*$/gim, "")
    .replace(/^\[RESPONSE\].*$/gim, "")
    .replace(/^\[JUDGE\].*$/gim, "")
    .replace(/^\[PLAN\].*$/gim, "")
    .replace(/^\[EXECUTE\].*$/gim, "")
    .replace(/^\[SAY\].*$/gim, "")
    .replace(/^\[WAIT\].*$/gim, "")
    .replace(/^\[TOOL\].*$/gim, "")
    .replace(/\[SUGGESTIONS:[^\]]*\]/gi, "")
    .replace(/\[SUGOESTIONS:[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Markdown renderer ──────────────────────────────────────────────────────────
function renderMd(text: string): React.ReactNode {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  lines.forEach((line, li) => {
    const olMatch = /^(\d+)\.\s+(.*)/.exec(line);
    const ulMatch = /^[-*]\s+(.*)/.exec(line);
    const inline = (str: string, key: string): React.ReactNode => {
      const parts: React.ReactNode[] = [];
      const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0; let m; let k = 0;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) parts.push(<span key={`${key}-t${k++}`}>{str.slice(last, m.index)}</span>);
        const tok = m[0];
        if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${k++}`}>{tok.slice(2,-2)}</strong>);
        else parts.push(<code key={`${key}-c${k++}`}>{tok.slice(1,-1)}</code>);
        last = m.index + tok.length;
      }
      if (last < str.length) parts.push(<span key={`${key}-e`}>{str.slice(last)}</span>);
      return parts.length > 0 ? parts : str;
    };
    if (olMatch) result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/40 shrink-0">{olMatch[1]}.</span><span>{inline(olMatch[2], `ol${li}`)}</span></div>);
    else if (ulMatch) result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/30 shrink-0">•</span><span>{inline(ulMatch[1], `ul${li}`)}</span></div>);
    else if (line.trim() === "") { if (li < lines.length - 1) result.push(<div key={li} className="h-2" />); }
    else result.push(<div key={li}>{inline(line, `ln${li}`)}</div>);
  });
  return result;
}

// ── ToolCard ──────────────────────────────────────────────────────────────────
function ToolCard({ part }: { part: MessagePart & { kind: "tool_start" } }) {
  const meta = TOOL_META[part.name] ?? { icon: <Bot className="w-3.5 h-3.5" />, label: part.name, color: "text-white/60" };
  const pct = part.progress;
  const hasProgress = pct !== null && pct !== undefined;
  const argStr = Object.entries(part.args).filter(([,v]) => v !== undefined && v !== "")
    .map(([k,v]) => `${k}: ${String(v).length > 40 ? String(v).slice(0,37)+"..." : v}`).join("  ·  ");
  return (
    <div className={cn("agent-tool-card", part.done && "agent-tool-card-done")}>
      <div className="agent-tool-card-top">
        <span className="agent-tool-using">Using</span>
        <span className="agent-tool-divider" />
        <span className={cn("agent-tool-icon shrink-0", meta.color)}>{meta.icon}</span>
        <span className={cn("agent-tool-name", meta.color)}>{meta.label}</span>
        {argStr && <><span className="agent-tool-divider" /><span className="agent-tool-args">{argStr}</span></>}
        <span className="agent-tool-status-wrap">
          {part.done
            ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
            : hasProgress
              ? <span className="agent-tool-pct">{pct}%</span>
              : <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />}
        </span>
      </div>
      {!part.done && part.progressMsg && (
        <div className="agent-tool-live-msg">
          <span className="agent-tool-live-dot" />
          <span className="agent-tool-live-text">{part.progressMsg}</span>
        </div>
      )}
      {!part.done && (
        <div className="agent-tool-progress-track">
          <div className="agent-tool-progress-fill" style={{ width: hasProgress ? `${Math.max(3,pct!)}%` : "0%", transition: hasProgress ? "width 0.6s ease" : "none" }} />
          {!hasProgress && <div className="agent-tool-progress-shimmer" />}
        </div>
      )}
    </div>
  );
}

// ── PlanCard ──────────────────────────────────────────────────────────────────
function PlanCard({ part }: { part: MessagePart & { kind: "plan" } }) {
  return (
    <div className="agent-plan-card">
      <div className="agent-plan-header">
        <span className="agent-plan-icon">⚡</span>
        <span className="agent-plan-title">{part.iteration ? `Step ${part.iteration} — ` : ""}Executing plan</span>
      </div>
      <div className="agent-plan-steps">
        {part.steps.map((s, i) => {
          const meta = (TOOL_META as any)[s.tool];
          return (
            <div key={i} className="agent-plan-step">
              <span className={meta?.color ?? "text-white/50"}>{meta?.icon}</span>
              <span className="agent-plan-step-name">{meta?.label ?? s.tool}</span>
              {s.args.url && <span className="agent-plan-step-arg">{String(s.args.url).length > 42 ? String(s.args.url).slice(0,39)+"..." : s.args.url}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TextArtifact (own component so useState is always at top level) ───────────
function TextArtifact({ label, content }: { label: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const copyText = () => { void navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div className="rounded-xl border border-white/12 bg-white/[0.04] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/8">
        <span className="text-xs font-semibold text-white/70">{label}</span>
        <button onClick={copyText} className="text-[10px] text-white/40 hover:text-white/80 px-2 py-0.5 rounded bg-white/6">{copied ? "✓ Copied" : "Copy"}</button>
      </div>
      <pre className="text-xs text-white/70 font-mono p-3 overflow-x-auto max-h-48 whitespace-pre-wrap">{content}</pre>
    </div>
  );
}

// ── ArtifactCard ──────────────────────────────────────────────────────────────
function ArtifactCard({ part, onNavigate }: { part: MessagePart & { kind: "artifact" }; onNavigate?: (tab: string) => void }) {
  if (part.artifactType === "download" && part.downloadUrl) {
    return (
      <div className="rounded-2xl border border-green-500/25 bg-green-500/8 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="p-2 rounded-xl bg-green-500/15 shrink-0"><CheckCircle className="w-5 h-5 text-green-400" /></div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-green-300">✅ Ready to download</p>
            <p className="text-xs text-white/50 truncate mt-0.5">{part.label}</p>
          </div>
        </div>
        <div className="px-4 pb-3 flex gap-2">
          <a href={part.downloadUrl} download className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-sm text-white"
            style={{ background: "linear-gradient(135deg,#16a34a,#15803d)", boxShadow: "0 4px 16px rgba(22,163,74,0.35)" }}>
            <Download className="w-4 h-4" /> Download File
          </a>
          {part.tab && onNavigate && (
            <button onClick={() => onNavigate(part.tab!)} className="px-3 py-2.5 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-xs font-medium transition-colors">Open Tab</button>
          )}
        </div>
      </div>
    );
  }
  if (part.artifactType === "text" && part.content) {
    return <TextArtifact label={part.label} content={part.content} />;
  }
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/8 px-3 py-2.5 flex items-center gap-3">
      <div className="p-1.5 rounded-lg bg-primary/15">{part.tab ? (TAB_ICONS[part.tab] ?? <Bot className="w-4 h-4" />) : <CheckCircle className="w-4 h-4" />}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white/90 truncate">{part.label}</p>
        {part.tab && <p className="text-[10px] text-white/40 mt-0.5">View in <span className="capitalize">{part.tab}</span> tab</p>}
      </div>
      {part.tab && onNavigate && (
        <button onClick={() => onNavigate(part.tab!)} className="shrink-0 px-2.5 py-1 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary text-xs font-semibold transition-colors">Open →</button>
      )}
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────
// ── CopyBubble — copy button for assistant text bubbles ─────────────────────
function CopyBubble({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <button onClick={copy} title="Copy" className="shrink-0 opacity-0 group-hover/bubble:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10 text-white/30 hover:text-white/70">
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function MessageBubble({ message, onNavigate, onRetry }: { message: Message; onNavigate?: (tab: string) => void; onRetry?: () => void }) {
  const isUser = message.role === "user";
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
      className={cn("flex gap-3 w-full", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="agent-avatar shrink-0 mt-0.5"><img src="/agent-logo.png" className="w-4 h-4 object-contain" alt="" /></div>
      )}
      <div className={cn("flex flex-col gap-2 max-w-[88%] sm:max-w-[80%]", isUser && "items-end")}>
        {message.parts.map((part, i) => {
          // Image thumbnail in user message
          if (part.kind === "image") {
            return (
              <div key={i} className="rounded-xl overflow-hidden border border-white/10 max-w-[200px]">
                <img src={(part as any).previewUrl} alt={(part as any).name} className="w-full h-auto object-cover max-h-[180px]" />
              </div>
            );
          }
          if (part.kind === "text" && part.content.trim()) {
            // Strip internal model tags on the client side as a safety net
            const cleanContent = clientStripTags(part.content);
            if (!cleanContent.trim()) return null;
            const isErrorMsg = !isUser && cleanContent.startsWith("⚠️");
            return (
              <div key={i} className={cn("group/bubble relative rounded-2xl px-4 py-3 text-sm leading-relaxed",
                isUser ? "bg-[#dc2626] text-white rounded-tr-sm" : "bg-white/[0.05] text-white/90 rounded-tl-sm border border-white/[0.07] copilot-md")}>
                {isUser ? cleanContent : renderMd(cleanContent)}
                {/* Copy button — assistant messages only, hover-reveal */}
                {!isUser && (
                  <div className="absolute top-2 right-2 flex gap-1">
                    <CopyBubble text={part.content} />
                    {/* Retry button on error messages */}
                    {isErrorMsg && onRetry && (
                      <button onClick={onRetry} title="Retry" className="opacity-0 group-hover/bubble:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10 text-white/30 hover:text-white/70">
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          }
          if (part.kind === "tool_start") return <ToolCard key={i} part={part} />;
          if (part.kind === "plan") return null; // Plan is internal — tool cards already show what's executing
          if (part.kind === "artifact") return <ArtifactCard key={i} part={part} onNavigate={onNavigate} />;
          return null;
        })}
        {message.parts.some(p => p.kind === "text" ? (p as any).content?.trim() : true) && (
          <span className="text-[10px] text-white/25 px-1">{message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        )}
      </div>
      {isUser && (
        <div className="shrink-0 w-7 h-7 rounded-full bg-white/10 border border-white/15 flex items-center justify-center mt-0.5">
          <User className="w-3.5 h-3.5 text-white/60" />
        </div>
      )}
    </motion.div>
  );
}

// ── Main StudioCopilot ────────────────────────────────────────────────────────
export function StudioCopilot({
  onNavigate,
  pendingPrompt,
  onPromptConsumed,
  onBackToHome,
}: {
  onNavigate?: (tab: string) => void;
  pendingPrompt?: string | null;
  onPromptConsumed?: () => void;
  onBackToHome?: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [agentStage, setAgentStage] = useState<"idle"|"planning"|"executing"|"verifying">("idle");
  const [agentIteration, setAgentIteration] = useState(0);
  const [pasteUrl, setPasteUrl] = useState<string | null>(null);
  const [ultra, setUltra] = useState<boolean>(readUltraInitial);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const { toast } = useToast();
  useEffect(() => {
    try { localStorage.setItem(ULTRA_KEY, ultra ? "1" : "0"); } catch {}
  }, [ultra]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);

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
  const [pendingAttachments, setPendingAttachments] = useState<Array<{
    type: "image" | "video" | "audio" | "document";
    name: string;
    mimeType: string;
    data?: string;   // base64 for images (no data: prefix)
    url?: string;    // S3 URL for video/audio/docs
    previewUrl?: string; // object URL for image preview chip
  }>>([]);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    const MAX_MB = 50;
    if (file.size > MAX_MB * 1024 * 1024) {
      toast({ title: "File too large", description: `Max ${MAX_MB} MB for agent attachments.`, variant: "destructive" });
      return;
    }

    // Classify file type
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    const isText = file.type.startsWith("text/") || /\.(srt|vtt|txt|md|csv|json)$/i.test(file.name);
    const attachType: "image" | "video" | "audio" | "document" =
      isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "document";

    if (isImage) {
      // Images: read locally with FileReader — instant, no network, goes to Gemini Vision
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        const previewUrl = URL.createObjectURL(file);
        setPendingAttachments(prev => [...prev, {
          type: "image", name: file.name, mimeType: file.type,
          data: base64, previewUrl,
        }]);
        toast({ title: "Image attached", description: `${file.name} — agent can see it` });
      };
      reader.onerror = () => toast({ title: "Could not read image", variant: "destructive" });
      reader.readAsDataURL(file);
      return;
    }

    if (isText) {
      // Text/SRT/TXT: read content locally and inject as document attachment — instant, no upload
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        // Inject directly as a text attachment so agent can read the full content
        setPendingAttachments(prev => [...prev, {
          type: "document", name: file.name, mimeType: "text/plain",
          url: `data:text/plain,${encodeURIComponent(content.slice(0, 32000))}`,
        }]);
        toast({ title: "File attached", description: `${file.name} — agent will read the content` });
      };
      reader.onerror = () => toast({ title: "Could not read file", variant: "destructive" });
      reader.readAsText(file);
      return;
    }

    // Video / audio / docs: upload to S3 so agent tools can use the URL
    try {
      setUploading(true);
      const presignRes = await fetch(`${BASE}/api/uploads/presign`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size, mimeType: file.type, visibility: "public" }),
      });
      if (!presignRes.ok) {
        const e = await presignRes.json().catch(() => ({})) as any;
        const errMsg = e?.error ?? `Server error ${presignRes.status}`;
        // Give a more helpful error message when S3 isn't configured locally
        const friendlyMsg = errMsg.includes("credentials") || errMsg.includes("bucket") || errMsg.includes("S3")
          ? "File upload requires cloud storage (not available in local dev). Use a YouTube URL instead."
          : errMsg;
        throw new Error(friendlyMsg);
      }
      const { fileId, uploadType, presignedUrl } = await presignRes.json() as any;
      if (uploadType !== "single") throw new Error(`File too large for quick attach (max ${MAX_MB} MB).`);

      const putRes = await fetch(presignedUrl, {
        method: "PUT", body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error(`S3 upload failed (${putRes.status})`);

      const compRes = await fetch(`${BASE}/api/uploads/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, parts: [] }),
      });
      if (!compRes.ok) throw new Error("Could not finalize upload");
      const comp = await compRes.json() as any;

      setPendingAttachments(prev => [...prev, {
        type: attachType, name: file.name, mimeType: file.type, url: comp.shareUrl,
      }]);
      toast({ title: `${isVideo ? "Video" : isAudio ? "Audio" : "File"} attached ✓`, description: `${file.name} — agent tools can use this` });
    } catch (err: any) {
      toast({ title: "Attachment failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (idx: number) => {
    setPendingAttachments(prev => {
      const a = prev[idx];
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  };

  // inputRef removed — textarea is uncontrolled height, no programmatic focus needed
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<any>(null);
  const sessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const lastUserTextRef = useRef<string>("");


  // Load sessions on mount
  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    if (loaded.length > 0) { setCurrentSessionId(loaded[0].id); sessionIdRef.current = loaded[0].id; }
  }, []);

  const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages ?? [];

  useEffect(() => { sessionIdRef.current = currentSessionId; }, [currentSessionId]);
  useEffect(() => { messagesRef.current = currentMessages; }, [currentMessages]);
  useEffect(() => { if (!streaming && sessions.length > 0) saveSessions(sessions); }, [sessions, streaming]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [currentMessages]);
  // Editable session title state
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const updateSession = useCallback((sessionId: string, updater: (msgs: Message[]) => Message[]) => {
    setSessions(prev => {
      const existing = prev.find(s => s.id === sessionId);
      const oldMsgs = existing?.messages ?? [];
      const newMsgs = updater(oldMsgs);
      let title = existing?.title ?? "New Chat";
      if (!existing || existing.title === "New Chat") {
        const first = newMsgs.find(m => m.role === "user")?.parts.find(p => p.kind === "text") as any;
        if (first?.content) title = first.content.slice(0, 50);
      }
      const updated: ChatSession = { id: sessionId, title, updatedAt: new Date(), messages: newMsgs };
      return existing ? prev.map(s => s.id === sessionId ? updated : s) : [updated, ...prev];
    });
  }, []);

  const ensureSession = useCallback((): string => {
    const existing = sessionIdRef.current;
    if (existing) return existing;
    const newId = crypto.randomUUID();
    sessionIdRef.current = newId;
    setCurrentSessionId(newId);
    return newId;
  }, []);

  const upsertMsg = useCallback((sessionId: string, msgId: string, updater: (m: Message) => Message) => {
    updateSession(sessionId, msgs => {
      const exists = msgs.some(m => m.id === msgId);
      if (!exists) return [...msgs, updater({ id: msgId, role: "assistant", parts: [], timestamp: new Date() })];
      return msgs.map(m => m.id === msgId ? updater(m) : m);
    });
  }, [updateSession]);

  const sendMessage = useCallback(async (text: string, attachmentsArg?: Array<{ type: string; name: string; mimeType: string; data?: string; url?: string }>) => {
    const snapshotAttachments = attachmentsArg ?? pendingAttachments;
    if ((!text.trim() && snapshotAttachments.length === 0) || streaming) return;
    const sessionId = ensureSession();
    setInput("");
    setPendingAttachments([]);
    setSuggestions([]); // clear suggestions on new send
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    // Build user message parts — include image previews so they show in the bubble
    const userParts: MessagePart[] = [{ kind: "text", content: text }];
    for (const att of snapshotAttachments) {
      if (att.type === "image" && att.previewUrl) {
        userParts.push({ kind: "image", previewUrl: att.previewUrl, name: att.name });
      }
    }
    updateSession(sessionId, msgs => [...msgs, {
      id: userMsgId, role: "user",
      parts: userParts,
      timestamp: new Date(),
    }]);

    upsertMsg(sessionId, assistantMsgId, m => m);
    setStreaming(true);
    setThinking(true);
    setAgentStage("planning");
    setPasteUrl(null); // dismiss paste pill when message is sent
    lastUserTextRef.current = text; // track for retry
    abortRef.current = new AbortController();

    // Build history — include completed tool results as text so the agent
    // has full multi-turn memory of what tools ran and what they returned.
    const history = [...(messagesRef.current), { id: userMsgId, role: "user" as const, parts: [{ kind: "text" as const, content: text }], timestamp: new Date() }]
      .map(m => {
        const textParts = m.parts
          .filter((p: any) => p.kind === "text")
          .map((p: any) => p.content)
          .join("");
        // For assistant messages: append a compact summary of completed tools
        const toolSummary = m.role === "assistant"
          ? m.parts
              .filter((p: any) => p.kind === "tool_start" && p.done)
              .map((p: any) => {
                const resultStr = p.result?.error
                  ? `ERROR: ${p.result.error}`
                  : p.result?.message ?? p.result?.filename ?? p.result?.jobId ?? JSON.stringify(p.result ?? {}).slice(0, 120);
                return `[Tool: ${p.name} | Result: ${resultStr}]`;
              })
              .join("\n")
          : "";
        const content = [textParts, toolSummary].filter(Boolean).join("\n").trim();
        const isNewUserMsg = m.role === "user" && m.id === userMsgId;
        const msgAttachments = isNewUserMsg && snapshotAttachments.length > 0
          ? snapshotAttachments.map(a => ({ type: a.type, name: a.name, mimeType: a.mimeType, data: a.data, url: a.url }))
          : undefined;
        return { role: m.role === "user" ? "user" as const : "model" as const, content, ...(msgAttachments ? { attachments: msgAttachments } : {}) };
      })
      .filter(m => m.content.trim() || (m as any).attachments?.length > 0);

    const patchAssistant = (updater: (m: Message) => Message) => {
      upsertMsg(sessionId, assistantMsgId, updater);
    };
    const appendText = (content: string) => {
      patchAssistant(m => {
        const parts = [...m.parts];
        const last = parts[parts.length - 1];
        if (last?.kind === "text") return { ...m, parts: [...parts.slice(0,-1), { kind: "text", content: last.content + content }] };
        return { ...m, parts: [...parts, { kind: "text", content }] };
      });
    };

    const handleEvent = (evt: SseEvent) => {
      if (evt.type === "run_start") { setCurrentRunId(evt.runId); return; }
      if (evt.type === "heartbeat") return;
      if (evt.type === "thinking") {
        setThinking(true);
        if (evt.stage) setAgentStage(evt.stage as "idle"|"planning"|"executing"|"verifying");
        if (evt.iteration !== undefined) setAgentIteration(evt.iteration);
        return;
      }
      if (evt.type === "text") { setThinking(false); appendText(evt.content); return; }
      if (evt.type === "plan") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "plan", steps: evt.steps, iteration: evt.iteration }] }));
        return;
      }
      if (evt.type === "tool_start") {
        setThinking(false);
        patchAssistant(m => {
          const exists = m.parts.some(p => p.kind === "tool_start" && (p as any).toolId === evt.toolId);
          if (exists) return m;
          return { ...m, parts: [...m.parts, { kind: "tool_start", toolId: evt.toolId, name: evt.name, args: evt.args, done: false, progress: null }] };
        });
        return;
      }
      if (evt.type === "tool_log") {
        if (!evt.toolId) return;
        patchAssistant(m => ({
          ...m, parts: m.parts.map(p =>
            p.kind === "tool_start" && (p as any).toolId === evt.toolId && !(p as any).done
              ? { ...p, progressMsg: evt.message } : p),
        }));
        return;
      }
      if (evt.type === "tool_progress") {
        patchAssistant(m => ({
          ...m, parts: m.parts.map(p =>
            p.kind === "tool_start" && ((evt.toolId && (p as any).toolId === evt.toolId) || (!evt.toolId && (p as any).name === evt.name && !(p as any).done))
              ? { ...p, progress: evt.percent ?? (p as any).progress ?? null, progressMsg: evt.message ?? evt.status } : p),
        }));
        return;
      }
      if (evt.type === "tool_done") {
        setThinking(false);
        patchAssistant(m => ({
          ...m, parts: m.parts.map(p =>
            p.kind === "tool_start" && ((evt.toolId && (p as any).toolId === evt.toolId) || (!evt.toolId && (p as any).name === evt.name && !(p as any).done))
              ? { ...p, done: true, result: evt.result, progress: 100 } : p),
        }));
        return;
      }
      if (evt.type === "navigate") { if (onNavigate) onNavigate(evt.tab); return; }
      if (evt.type === "artifact") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "artifact", artifactType: evt.artifactType, label: evt.label, tab: evt.tab, jobId: evt.jobId, downloadUrl: evt.downloadUrl, content: evt.content }] }));
        return;
      }
      if (evt.type === "error") {
        setThinking(false); setAgentStage("idle");
        // Clean the error message — parse JSON if server forwarded raw API error
        let cleanMsg = evt.message ?? "Something went wrong";
        try {
          const p = JSON.parse(cleanMsg);
          const inner = p?.error?.message ?? p?.message ?? cleanMsg;
          cleanMsg = String(inner).split(/\.?\s*Please refer to https?:\/\//).shift()!.trim();
        } catch { /* not JSON */ }
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: `⚠️ ${cleanMsg}` }] }));
        return;
      }
      if (evt.type === "done") { setThinking(false); setAgentStage("idle"); setAgentIteration(0); }
      if (evt.type === "suggestions") { setSuggestions((evt as any).items ?? []); }
    };

    try {
      const resp = await fetch(`${BASE}/api/agent/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model: ultra ? "ultra" : "default" }),
        signal: abortRef.current.signal,
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
          const raw = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
          if (!raw) continue;
          try { handleEvent(JSON.parse(raw) as SseEvent); } catch {}
        }
      }
      // trailing buffer
      const raw = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (raw) { try { handleEvent(JSON.parse(raw) as SseEvent); } catch {} }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        // Distinguish common failure modes for better user feedback
        let msg = "⚠️ Connection interrupted. The job may still be running — try asking again.";
        if (err?.message?.includes("401") || err?.message?.includes("403")) {
          msg = "⚠️ Authentication error — please refresh the page and try again.";
        } else if (err?.message?.includes("503") || err?.message?.includes("502")) {
          msg = "⚠️ Server is starting up — please wait a moment and try again.";
        } else if (err?.message?.includes("Server error:")) {
          msg = `⚠️ ${err.message}`;
        }
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: msg }] }));
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      setAgentStage("idle");
    }
  }, [streaming, ultra, BASE, onNavigate, updateSession, ensureSession, upsertMsg, pendingAttachments]);

  // Consume incoming pendingPrompt (sent from home screen)
  const consumedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingPrompt && pendingPrompt !== consumedPromptRef.current && !streaming) {
      consumedPromptRef.current = pendingPrompt;
      const prompt = pendingPrompt;
      onPromptConsumed?.();
      // Defer to next tick so state settles
      setTimeout(() => { void sendMessage(prompt); }, 0);
    }
  }, [pendingPrompt, streaming, sendMessage, onPromptConsumed]);

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false); setThinking(false); setAgentStage("idle"); setAgentIteration(0);
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const r = new SR();
    recognitionRef.current = r;
    r.continuous = false; r.interimResults = false; r.lang = "en-US";
    r.onresult = (ev: any) => { setInput(p => p + (p ? " " : "") + (ev.results[0]?.[0]?.transcript ?? "")); setListening(false); };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    r.start(); setListening(true);
  };

  const isEmpty = currentMessages.length === 0;
  const speechSupported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const canSend = (input.trim().length > 0 || pendingAttachments.length > 0) && !streaming;

  const currentSession = sessions.find(s => s.id === currentSessionId);
  const sessionTitle = currentSession?.title ?? "New chat";

  const commitTitle = () => {
    const t = draftTitle.trim();
    if (currentSessionId && t && t !== sessionTitle) {
      setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title: t.slice(0, 80) } : s));
    }
    setEditingTitle(false);
  };

  const handleShare = () => {
    const url = window.location.href;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url);
    }
  };

  const handleNewChat = () => { if (streaming) return; setCurrentSessionId(null); sessionIdRef.current = null; setShowHistory(false); };
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) { setCurrentSessionId(null); sessionIdRef.current = null; }
  };

  return (
    <div className="copilot-wrap">
      {/* ── Genspark Header ── */}
      <div className="gs-chat-header">
        <div className="gs-chat-header-left">
          <button
            onClick={() => onBackToHome?.()}
            className="gs-chat-icon-btn"
            title="Back"
            aria-label="Back to home"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowHistory(h => !h)}
            className={cn(
              "gs-chat-icon-btn gs-chat-history-toggle",
              showHistory && "gs-chat-icon-btn-active",
            )}
            title="Chat history"
            aria-label="Toggle history"
          >
            <Menu className="w-4 h-4" />
          </button>
        </div>

        <div className="gs-chat-header-title">
          {!isEmpty && (
            editingTitle ? (
              <input
                autoFocus
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={e => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="gs-chat-title-input"
                maxLength={80}
              />
            ) : (
              <button
                type="button"
                onClick={() => { setDraftTitle(sessionTitle); setEditingTitle(true); }}
                className="gs-chat-title-btn"
                title="Rename chat"
              >
                <span className="gs-chat-title-text">{sessionTitle}</span>
                <Pencil className="w-3 h-3 text-white/30 group-hover:text-white/60" />
              </button>
            )
          )}
        </div>

        <div className="gs-chat-header-right">
          {!isEmpty && (
            <button onClick={handleShare} className="gs-chat-share-btn" title="Share chat">
              <Share2 className="w-3.5 h-3.5" />
              <span>Share</span>
            </button>
          )}
          <button
            onClick={handleNewChat}
            disabled={streaming}
            className="gs-chat-icon-btn disabled:opacity-40"
            title="New chat"
            aria-label="New chat"
          >
            <SquarePen className="w-4 h-4" />
          </button>
          <button className="gs-chat-icon-btn" title="More" aria-label="More options">
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── History panel ── */}
      <AnimatePresence>
        {showHistory && (
          <motion.div initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
            className="absolute inset-y-[45px] left-0 right-0 z-20 flex flex-col agent-history-panel">
            <div className="agent-history-header">
              <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Chat History</span>
              <button onClick={() => setShowHistory(false)} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="agent-history-list">
              {sessions.length === 0 ? (
                <div className="agent-history-empty">No previous chats</div>
              ) : sessions.map(s => (
                <div key={s.id} role="button" tabIndex={0}
                  onClick={() => { setCurrentSessionId(s.id); sessionIdRef.current = s.id; setShowHistory(false); }}
                  onKeyDown={e => { if (e.key === "Enter") { setCurrentSessionId(s.id); sessionIdRef.current = s.id; setShowHistory(false); } }}
                  className={cn("agent-history-item group cursor-pointer", currentSessionId === s.id && "agent-history-item-active")}>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="agent-history-title">{s.title}</p>
                    <p className="agent-history-time">{s.updatedAt.toLocaleDateString([], { month:"short", day:"numeric" })}</p>
                  </div>
                  <button onClick={e => handleDeleteSession(s.id, e)} className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-white/70 p-1 rounded transition-all">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Genspark welcome (empty state) ── */}
      {isEmpty && (
        <div className="gs-welcome">
          <h1 className="gs-welcome-title">
            Super Agent
            <span className="gs-welcome-dot" aria-hidden="true" />
          </h1>
          <p className="gs-welcome-sub">Ask anything — I can plan, run tools, and build for you.</p>
          <div className="gs-welcome-starters">
            {STARTERS.map((s, i) => (
              <button
                key={i}
                onClick={() => void sendMessage(s.text)}
                className="gs-starter"
              >
                <span className="gs-starter-icon">{s.icon}</span>
                <span className="gs-starter-text">{s.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      {!isEmpty && (
        <div className="flex-1 overflow-y-auto px-4 py-4 copilot-messages">
          <div className="agent-msg-col">
            <AnimatePresence initial={false}>
              {currentMessages.map((msg, idx) => {
                const isLastAssistant = msg.role === "assistant" && idx === currentMessages.length - 1;
                const handleRetry = isLastAssistant && lastUserTextRef.current
                  ? () => void sendMessage(lastUserTextRef.current)
                  : undefined;
                return <MessageBubble key={msg.id} message={msg} onNavigate={onNavigate} onRetry={handleRetry} />;
              })}
            </AnimatePresence>

            {/* Thinking indicator — shows live agent stage from SSE events */}
            {thinking && (() => {
              const stageLabel: Record<string, string> = {
                planning:  "Thinking",
                executing: "Working",
                verifying: "Checking",
                idle:      "Thinking",
              };
              const label = stageLabel[agentStage] ?? "Thinking";
              return (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="gs-thinking">
                  <span className="gs-thinking-text">{label}</span>
                  <span className="gs-thinking-dots">
                    <span>.</span><span>.</span><span>.</span>
                  </span>
                  <span className="gs-thinking-cursor" />
                  <span className="gs-thinking-pulse" />
                </motion.div>
              );
            })()}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* ── Suggestions chips ── */}
      {suggestions.length > 0 && !streaming && (
        <div className="w-full max-w-[720px] mx-auto px-[14px] pb-2 flex flex-wrap gap-2">
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { setSuggestions([]); void sendMessage(s); }}
              className="gs-suggestion-chip"
            >
              <span className="text-[11px] text-white/50 mr-1">↗</span>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* ── Genspark input bar ── */}
      <div className="gs-input-wrap">
        {/* Bottom tab: Super Agent only — removed 'AI works for you 75% off' */}
        <div className="gs-mode-tabs">
          <button type="button" className="gs-mode-tab gs-mode-tab-active">
            <span className="gs-mode-tab-icon" aria-hidden="true">
              <img src="/agent-logo.png" alt="" className="w-3.5 h-3.5 object-contain" />
            </span>
            Super Agent
          </button>
        </div>

        {/* URL paste pill */}
        {pasteUrl && !streaming && (
          <div className="gs-paste-pill-row">
            <button
              type="button"
              onClick={() => { setInput(`What can you do with ${pasteUrl}?`); setPasteUrl(null); }}
              className="gs-paste-pill"
            >
              <Link className="w-3 h-3" />
              <span className="truncate max-w-[220px]">Use {pasteUrl.slice(0, 40)}{pasteUrl.length > 40 ? '…' : ''}</span>
              <X className="w-3 h-3 ml-0.5 opacity-60" onClick={e => { e.stopPropagation(); setPasteUrl(null); }} />
            </button>
          </div>
        )}

        <form
          onSubmit={e => { e.preventDefault(); void sendMessage(input, pendingAttachments); }}
          className="gs-input-card"
        >
          {/* Attachment preview chips */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {pendingAttachments.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-white/10 border border-white/15 rounded-lg px-2 py-1 text-xs text-white/80">
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} className="w-6 h-6 rounded object-cover" />
                  ) : (
                    <span className="text-white/50">{a.type === "video" ? "🎬" : a.type === "audio" ? "🎵" : "📎"}</span>
                  )}
                  <span className="max-w-[120px] truncate">{a.name}</span>
                  <button type="button" onClick={() => removeAttachment(i)} className="ml-0.5 text-white/40 hover:text-white/80 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="gs-input-textarea"
            value={input}
            onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
            onFocus={() => {
              if (!input && navigator.clipboard?.readText) {
                navigator.clipboard.readText().then(text => {
                  if (/(?:youtube\.com\/watch|youtu\.be\/)/i.test(text)) setPasteUrl(text.trim());
                }).catch(() => {});
              }
            }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(input, pendingAttachments); } }}
            onPaste={async e => {
              // Support pasting images from clipboard (Ctrl+V)
              const items = Array.from(e.clipboardData?.items ?? []);
              const imgItem = items.find(it => it.type.startsWith("image/"));
              if (imgItem) {
                e.preventDefault();
                const file = imgItem.getAsFile();
                if (file) await handleFileUpload({ target: { files: [file] } } as any);
              }
            }}
            placeholder="Ask anything, create anything"
            rows={1}
            style={{ resize: "none", overflow: "hidden", minHeight: 28 }}
          />

          <div className="gs-input-row">
            <div className="gs-input-row-left">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*,video/*,audio/*,.srt,.vtt,.txt,.md,.csv,.json,.pdf,.doc,.docx"
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
                      className="gs-plus-menu-item"
                      disabled={uploading}
                      onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); }}
                    >
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      <span>Upload Files</span>
                    </button>
                    <button className="gs-plus-menu-item gs-plus-menu-item-soon" disabled>
                      <ImagePlus className="w-4 h-4" />
                      <span>Create Images</span>
                      <span className="gs-plus-menu-badge">Soon</span>
                    </button>
                    <button className="gs-plus-menu-item gs-plus-menu-item-soon" disabled>
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
                onClick={() => setUltra(u => !u)}
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
                onClick={toggleVoice}
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
              >
                <AudioLines className="w-3.5 h-3.5" />
                <span>{listening ? "Listening…" : "Speak"}</span>
              </button>
              {streaming ? (
                <button type="button" onClick={handleStop} className="gs-stop-btn" title="Stop">
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  className={cn("gs-send-btn", canSend ? "gs-send-active" : "gs-send-disabled")}
                  title="Send"
                  aria-label="Send"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
