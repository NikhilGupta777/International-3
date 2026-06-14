import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, Languages, Mic, MicOff, Play, Download, CheckCircle,
  Loader2, AlertCircle, X, ChevronDown, Subtitles, RefreshCw,
  Film, Wand2, Volume2, Eye, Share2, History, Trash2, Terminal, ChevronUp,
  Youtube, Scissors, Clock, Sparkles, ArrowRight, Send, Bot
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  loadActiveTranslatorJobs,
  upsertActiveTranslatorJob,
  removeActiveTranslatorJob,
  loadTranslatorHistory,
  saveTranslatorHistory,
  deleteTranslatorHistory,
  isTranslatorHistoryDeleted,
  type ActiveTranslatorJob,
  type TranslatorHistoryEntry,
} from "@/lib/translator-history";
import { translatorAuthHeaders } from "@/lib/translator-client-id";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api/translator`;

// ── Translation Assistant message shape ──────────────────────────────────────
type AiSource = { title: string; url: string };
type AiMsg = {
  role: "user" | "model";
  content: string;
  thoughts?: string;
  searches?: string[];
  sources?: AiSource[];
  status?: "thinking" | "searching" | "answering" | "done" | "error";
};

// ── Lightweight Markdown renderer for the Translation Assistant ───────────────
// Supports **bold**, *italic*, `code`, [links](url), fenced ```code``` blocks,
// #/## headings, -/* / numbered lists, > blockquotes and --- rules. Styled for
// the assistant's light (white) theme with Tailwind utility classes (no CSS).
function renderAssistantMarkdown(text: string): ReactNode {
  const inlineFormat = (str: string, key: string): ReactNode => {
    const parts: ReactNode[] = [];
    // Order matters: links first, then bold, code, italic.
    const re = /(\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
    let last = 0; let mm: RegExpExecArray | null; let k = 0;
    while ((mm = re.exec(str)) !== null) {
      if (mm.index > last) parts.push(<span key={`${key}-t${k++}`}>{str.slice(last, mm.index)}</span>);
      const tok = mm[0];
      if (tok.startsWith("[")) {
        const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
        if (lm) parts.push(<a key={`${key}-a${k++}`} href={lm[2]} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:text-orange-600 break-all">{lm[1]}</a>);
        else parts.push(<span key={`${key}-a${k++}`}>{tok}</span>);
      } else if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${k++}`} className="font-semibold text-slate-900">{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("`")) parts.push(<code key={`${key}-c${k++}`} className="px-1 py-0.5 rounded bg-slate-100 text-primary text-[12px] font-mono">{tok.slice(1, -1)}</code>);
      else parts.push(<em key={`${key}-i${k++}`}>{tok.slice(1, -1)}</em>);
      last = mm.index + tok.length;
    }
    if (last < str.length) parts.push(<span key={`${key}-e`}>{str.slice(last)}</span>);
    return parts.length > 0 ? parts : str;
  };

  const segments: Array<{ kind: "code" | "text"; body: string }> = [];
  const fence = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g;
  let lastIndex = 0; let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > lastIndex) segments.push({ kind: "text", body: text.slice(lastIndex, m.index) });
    segments.push({ kind: "code", body: m[1] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) segments.push({ kind: "text", body: text.slice(lastIndex) });
  if (segments.length === 0) segments.push({ kind: "text", body: text });

  const out: ReactNode[] = [];
  segments.forEach((seg, segIdx) => {
    if (seg.kind === "code") {
      out.push(
        <pre key={`pre-${segIdx}`} className="my-1.5 p-2.5 rounded-lg bg-slate-900 overflow-x-auto text-[12px] font-mono text-slate-100">
          <code>{seg.body.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    const lines = seg.body.split("\n");
    lines.forEach((line, li) => {
      const key = `s${segIdx}-${li}`;
      const heading = /^(#{1,4})\s+(.*)/.exec(line);
      const ul = /^\s*[-*+]\s+(.*)/.exec(line);
      const ol = /^\s*(\d+)[.)]\s+(.*)/.exec(line);
      const quote = /^>\s?(.*)/.exec(line);
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push(<hr key={key} className="my-2 border-slate-200" />);
      } else if (heading) {
        const big = heading[1].length <= 2;
        out.push(<div key={key} className={cn("font-bold text-slate-900", big ? "text-[15px] mt-2.5 mb-1" : "text-[13px] mt-2 mb-0.5")}>{inlineFormat(heading[2], `h${key}`)}</div>);
      } else if (quote) {
        out.push(<div key={key} className="border-l-2 border-primary/40 pl-2.5 my-1 text-slate-500 italic">{inlineFormat(quote[1], `q${key}`)}</div>);
      } else if (ul) {
        out.push(<div key={key} className="flex gap-1.5 pl-1"><span className="text-primary shrink-0 leading-relaxed">•</span><span className="flex-1">{inlineFormat(ul[1], `u${key}`)}</span></div>);
      } else if (ol) {
        out.push(<div key={key} className="flex gap-1.5 pl-1"><span className="text-primary shrink-0 font-medium leading-relaxed">{ol[1]}.</span><span className="flex-1">{inlineFormat(ol[2], `o${key}`)}</span></div>);
      } else if (line.trim() === "") {
        if (li < lines.length - 1) out.push(<div key={key} className="h-1.5" />);
      } else {
        out.push(<div key={key}>{inlineFormat(line, `l${key}`)}</div>);
      }
    });
  });
  return <>{out}</>;
}

// ── Live status pill shown while the assistant is working ─────────────────────
function AssistantStatusPill({ status }: { status?: AiMsg["status"] }) {
  if (status === "searching") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-blue-600"><Loader2 className="w-3 h-3 animate-spin" /> Searching the web…</span>;
  }
  if (status === "answering") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Writing…</span>;
  }
  if (status === "thinking") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Thinking…</span>;
  }
  return null;
}

// ── A single assistant message: live thinking trace, search chips, the Markdown
//    answer, and grounding sources. Light (white) theme. ───────────────────────
function AssistantBubble({ m }: { m: AiMsg }) {
  const [showThoughts, setShowThoughts] = useState(false);
  const live = m.status === "thinking" || m.status === "searching" || m.status === "answering";
  const hasThoughts = !!(m.thoughts && m.thoughts.trim());
  return (
    <div className="max-w-[88%] rounded-2xl rounded-tl-sm px-3 py-2.5 text-sm break-words bg-white border border-slate-200 text-slate-800 leading-relaxed shadow-sm">
      {!!m.searches?.length && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {m.searches.map((s, idx) => (
            <span key={idx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 text-[11px] max-w-full truncate">
              <Sparkles className="w-3 h-3 shrink-0" /> <span className="truncate">{s}</span>
            </span>
          ))}
        </div>
      )}

      {hasThoughts && (
        <div className="mb-1.5">
          <button
            onClick={() => setShowThoughts((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
          >
            {(showThoughts || live) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {live ? "Thinking…" : "Thought process"}
          </button>
          {(showThoughts || live) && (
            <div className="mt-1 pl-2 border-l-2 border-slate-200 text-[12px] text-slate-500 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {m.thoughts}
            </div>
          )}
        </div>
      )}

      {m.content
        ? renderAssistantMarkdown(m.content)
        : (live && !hasThoughts ? <AssistantStatusPill status={m.status} /> : null)}

      {live && m.content ? <div className="mt-1"><AssistantStatusPill status={m.status} /></div> : null}

      {!!m.sources?.length && (
        <div className="mt-2 pt-2 border-t border-slate-100">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Sources</p>
          <div className="flex flex-col gap-0.5">
            {m.sources.map((s, idx) => (
              <a key={idx} href={s.url} target="_blank" rel="noreferrer" className="text-[12px] text-primary hover:underline truncate">
                {idx + 1}. {s.title}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// â”€â”€ Language options â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LANGS = [
  { code: "auto", name: "Auto-detect" },
  { code: "en", name: "English" }, { code: "es", name: "Spanish" }, { code: "fr", name: "French" },
  { code: "de", name: "German" }, { code: "pt", name: "Portuguese" }, { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" }, { code: "ko", name: "Korean" }, { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" }, { code: "ru", name: "Russian" }, { code: "hi", name: "Hindi" },
  { code: "nl", name: "Dutch" }, { code: "pl", name: "Polish" }, { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" }, { code: "vi", name: "Vietnamese" }, { code: "id", name: "Indonesian" },
  { code: "fil", name: "Filipino" }, { code: "fi", name: "Finnish" },
];
const TARGET_LANGS = LANGS.filter(l => l.code !== "auto" && l.code !== "hi");
const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const NO_STORE: RequestCache = "no-store";
// YouTube endpoints live under /api/youtube/* (same battle-tested yt-dlp +
// clip-cut path used by the Studio copilot and Clip Cutter).
const YT_BASE = `${BASE}/api/youtube`;
type TranslatorStep = {
  name: string;
  label: string;
  status: "completed" | "running" | "failed" | "skipped" | "pending";
  progress?: number;
  message?: string;
};

async function responseError(res: Response, fallback: string): Promise<Error> {
  try {
    const data = await readJsonResponse<{ error?: string }>(res);
    if (typeof data?.error === "string" && data.error.trim()) {
      return new Error(data.error);
    }
  } catch { }
  return new Error(fallback);
}

async function readJsonResponse<T = any>(res: Response, fallback?: T): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Server returned an empty response (${res.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error(`Server returned invalid JSON (${res.status})`);
  }
}

function toEpoch(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function translatorShareUrl(jobId: string): string {
  const path = `${BASE}/api/translator/share/${encodeURIComponent(jobId)}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

// Build a descriptive download filename: "my_video_translated_hi.mp4"
// Falls back to "translated_video.mp4" when filename is missing.
function translatedVideoFilename(filename?: string, langCode?: string): string {
  const base = filename
    ? filename.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 60)
    : "video";
  const lang = langCode ? `_${langCode}` : "";
  return `${base}_translated${lang}.mp4`;
}

// Parse "MM:SS", "HH:MM:SS", or a plain seconds string into total seconds.
// Returns null when the input is empty or malformed.
function parseTimeToSeconds(value: string): number | null {
  const t = (value ?? "").trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const parts = t.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (parts.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

// Format seconds back to a friendly clock label (used for the clip duration hint).
function secondsToClock(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

const YOUTUBE_URL_RE = /(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;

function isLikelyYouTubeUrl(url: string): boolean {
  return YOUTUBE_URL_RE.test((url ?? "").trim());
}

// Derive a tidy filename from a YouTube URL: "youtube_<id>.mp4".
function youtubeFilename(url: string): string {
  const m = (url ?? "").match(YOUTUBE_URL_RE);
  return m ? `youtube_${m[1]}.mp4` : "youtube-video.mp4";
}

// ── Step config ─────────────────────────────────────────────────────────────
const STEP_ICONS: Record<string, React.ReactNode> = {
  download: <Download className="w-4 h-4" />,
  audio_extraction: <Volume2 className="w-4 h-4" />,
  transcription: <Subtitles className="w-4 h-4" />,
  translation: <Languages className="w-4 h-4" />,
  voice_generation: <Mic className="w-4 h-4" />,
  lip_sync: <Film className="w-4 h-4" />,
  video_merge: <Wand2 className="w-4 h-4" />,
  upload: <Upload className="w-4 h-4" />,
};
const STEP_COLORS: Record<string, string> = {
  completed: "text-green-400 border-green-500/30 bg-green-500/8",
  running: "text-blue-400 border-blue-500/30 bg-blue-500/8",
  failed: "text-red-400 border-red-500/30 bg-red-500/8",
  skipped: "text-white/30 border-white/10 bg-white/[0.03]",
  pending: "text-white/40 border-white/10 bg-white/[0.03]",
};

// â”€â”€ Select component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function LangSelect({ value, onChange, options, label, id }: {
  value: string; onChange: (v: string) => void;
  options: typeof LANGS; label: string; id: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-white/40 font-medium uppercase tracking-wider">{label}</label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-white/[0.06] border border-white/[0.1] rounded-xl
                     px-4 py-2.5 pr-8 text-sm text-white/90 focus:outline-none focus:border-primary/60
                     cursor-pointer transition-colors"
        >
          {options.map(l => (
            <option key={l.code} value={l.code} className="bg-[#1a1a1a] text-white">{l.name}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
      </div>
    </div>
  );
}

// â”€â”€ Step card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function StepCard({ step }: { step: TranslatorStep }) {
  const colorClass = STEP_COLORS[step.status] ?? STEP_COLORS.pending;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-center gap-3 px-4 py-3 rounded-xl border transition-all", colorClass)}
    >
      <span className="shrink-0">{STEP_ICONS[step.name] ?? <Wand2 className="w-4 h-4" />}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{step.label}</span>
          {step.status === "running" && step.progress != null && (
            <span className="text-xs font-mono opacity-70">{step.progress}%</span>
          )}
        </div>
        {step.message && (
          <p className="text-xs opacity-60 truncate mt-0.5">{step.message}</p>
        )}
        {step.status === "running" && step.progress != null && (
          <div className="mt-2 h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-blue-400 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${step.progress}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        )}
      </div>
      <span className="shrink-0">
        {step.status === "completed" && <CheckCircle className="w-4 h-4 text-green-400" />}
        {step.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
        {step.status === "failed" && <AlertCircle className="w-4 h-4 text-red-400" />}
      </span>
    </motion.div>
  );
}

// â”€â”€ Transcript panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function TranscriptPanel({ segments }: { segments: any[] }) {
  if (!segments.length) return null;
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <Subtitles className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-white/80">Transcript</span>
        <span className="text-xs text-white/30 ml-auto">{segments.length} segments</span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {segments.map((s, i) => {
          // Worker transcript: { start (seconds), originalText, translatedText }
          // Lambda-fast transcript: { startMs (ms), text (original), translatedText }
          // Normalise both shapes so the panel always shows correct data.
          const startSec: number =
            typeof s.start === "number" ? s.start : (s.startMs ?? 0) / 1000;
          const originalText: string = s.originalText ?? s.text ?? "";
          const translatedText: string = s.translatedText ?? "";
          return (
            <div key={i} className="px-4 py-2 border-b border-white/[0.04] last:border-0">
              <div className="flex items-start gap-3">
                <span className="text-[10px] text-white/30 font-mono shrink-0 mt-0.5">
                  {String(Math.floor(startSec / 60)).padStart(2, "0")}:{String(Math.floor(startSec % 60)).padStart(2, "0")}
                </span>
                <div className="flex-1 min-w-0 space-y-0.5">
                  {originalText && (
                    <p className="text-xs text-white/50 line-through">{originalText}</p>
                  )}
                  <p className="text-sm text-white/90">{translatedText || originalText}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// â”€â”€ Drop zone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault(); setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
      }}
      className={cn(
        "relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed",
        "cursor-pointer transition-all duration-200 py-16 px-8",
        dragging ? "border-primary/70 bg-primary/8 scale-[1.01]"
          : "border-white/[0.12] hover:border-white/25 bg-white/[0.02] hover:bg-white/[0.04]",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <div className="w-16 h-16 rounded-2xl bg-white/[0.06] border border-white/[0.1] flex items-center justify-center">
        <Upload className="w-7 h-7 text-white/50" />
      </div>
      <div className="text-center">
        <p className="text-base font-semibold text-white/80">Drop your video here</p>
        <p className="text-sm text-white/40 mt-1">MP4, MOV, MKV, AVI, WebM · Max 2GB</p>
      </div>
      <input ref={inputRef} type="file" accept=".mp4,.mov,.mkv,.avi,.webm" className="hidden"
        onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

// â”€â”€ Main component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function VideoTranslator({ lipSyncAvailable = false }: { lipSyncAvailable?: boolean }) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [sourceMode, setSourceMode] = useState<"upload" | "youtube">("upload");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [useClip, setUseClip] = useState(false);
  const [clipStart, setClipStart] = useState("");
  const [clipEnd, setClipEnd] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [prepareMsg, setPrepareMsg] = useState("");
  const [srcLang, setSrcLang] = useState("hi");
  const [tgtLang, setTgtLang] = useState("en");
  const [voiceStyle, setVoiceStyle] = useState<"original" | "female">("original");
  const [lipSync, setLipSync] = useState(false);
  const [translationMode, setTranslationMode] = useState<"full" | "subtitle-only">("full");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keepBackgroundMusic, setKeepBackgroundMusic] = useState(false);
  const [multiSpeaker, setMultiSpeaker] = useState(false);
  const [dynamicVideoLength, setDynamicVideoLength] = useState(false);
  const [preserveChants, setPreserveChants] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  // When the user clicks "Translate another video" we show the upload form again
  // while existing jobs keep running in the background. This flag stops the
  // reconcile effect from auto-re-opening the running job over the fresh form.
  const [composingNew, setComposingNew] = useState(false);
  const [transcript, setTranscript] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveTranslatorJob[]>(() => loadActiveTranslatorJobs());
  const [history, setHistory] = useState<TranslatorHistoryEntry[]>(() => loadTranslatorHistory());
  const [debugLog, setDebugLog] = useState<{ ts: number; level: "info" | "warn" | "error"; msg: string }[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  // ── Temporary in-tab AI status assistant ──────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMessages, setAiMessages] = useState<AiMsg[]>([]);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const aiScrollRef = useRef<HTMLDivElement | null>(null);
  const [stuckWarning, setStuckWarning] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ytPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef<number>(0);
  const lastProgressRef = useRef<{ progress: number; status: string; ts: number }>({ progress: 0, status: "", ts: 0 });

  const appendLog = (level: "info" | "warn" | "error", msg: string) =>
    setDebugLog(prev => {
      // Dedup: suppress if the identical level+msg was logged within the last 30s.
      // The previous check only looked at the last entry, so the same message
      // could re-appear if any other message came in between (common during
      // polling when status is unchanged for several polls).
      const now = Date.now();
      const DEDUP_WINDOW_MS = 30_000;
      const isDuplicate = prev.some(
        e => e.level === level && e.msg === msg && now - e.ts < DEDUP_WINDOW_MS
      );
      if (isDuplicate) return prev;
      return [...prev.slice(-199), { ts: now, level, msg }];
    });

  const refreshHistory = useCallback(() => {
    setActiveJobs(loadActiveTranslatorJobs());
    setHistory(loadTranslatorHistory());
  }, []);

  // Ask the in-tab AI assistant via the streaming endpoint. The backend streams
  // the model's live thinking, any web searches, and the answer as Markdown,
  // backed by a read-only snapshot of ALL the user's translation jobs + logs.
  const askAi = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || aiBusy) return;
    const history: AiMsg[] = [...aiMessages, { role: "user", content: q }];
    // Append the user turn + an empty assistant turn we'll fill as events arrive.
    setAiMessages([...history, { role: "model", content: "", status: "thinking", thoughts: "", searches: [], sources: [] }]);
    setAiInput("");
    setAiBusy(true);

    // Mutate only the trailing (assistant) message.
    const patchLast = (fn: (m: AiMsg) => AiMsg) =>
      setAiMessages((prev) => {
        if (!prev.length) return prev;
        const next = prev.slice();
        const i = next.length - 1;
        if (next[i]?.role === "model") next[i] = fn(next[i]);
        return next;
      });

    try {
      const res = await fetch(`${API}/assistant/stream`, {
        method: "POST",
        headers: { ...translatorAuthHeaders(), "Content-Type": "application/json" },
        cache: NO_STORE,
        body: JSON.stringify({
          messages: history,
          focusJobId: jobId ?? undefined,
          clientLogs: debugLog.slice(-120),
        }),
      });
      if (!res.ok || !res.body) throw await responseError(res, `Assistant error (${res.status})`);

      const handle = (e: any) => {
        if (!e || typeof e.type !== "string") return;
        if (e.type === "thought" && e.content) {
          patchLast((m) => ({ ...m, thoughts: (m.thoughts ?? "") + e.content, status: m.content ? m.status : "thinking" }));
        } else if (e.type === "search" && Array.isArray(e.queries)) {
          patchLast((m) => ({ ...m, searches: [...(m.searches ?? []), ...e.queries], status: m.content ? m.status : "searching" }));
        } else if (e.type === "text" && e.content) {
          patchLast((m) => ({ ...m, content: (m.content ?? "") + e.content, status: "answering" }));
        } else if (e.type === "sources" && Array.isArray(e.items)) {
          patchLast((m) => ({ ...m, sources: e.items }));
        } else if (e.type === "done") {
          patchLast((m) => ({ ...m, status: "done" }));
        } else if (e.type === "error") {
          patchLast((m) => ({ ...m, content: m.content || `⚠️ ${e.message || "The assistant couldn't respond. Try again."}`, status: "error" }));
        }
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const drain = (chunk: string) => {
        const raw = chunk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n").trim();
        if (raw) { try { handle(JSON.parse(raw)); } catch { /* ignore partial */ } }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() ?? "";
        for (const frame of frames) drain(frame);
      }
      if (buf.trim()) drain(buf);
      patchLast((m) => ({ ...m, status: m.status === "error" ? "error" : "done" }));
    } catch (e: any) {
      patchLast((m) => ({ ...m, content: m.content || `⚠️ ${e?.message || "The assistant couldn't respond. Try again."}`, status: "error" }));
    } finally {
      setAiBusy(false);
    }
  }, [aiBusy, aiMessages, jobId, debugLog]);

  // Keep the assistant chat scrolled to the newest message.
  useEffect(() => {
    if (aiOpen && aiScrollRef.current) {
      aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
    }
  }, [aiMessages, aiOpen, aiBusy]);

  const fetchResultUrls = useCallback(async (id: string) => {
    const tr = await fetch(`${API}/result/${id}`, { headers: translatorAuthHeaders(), cache: NO_STORE });
    if (!tr.ok) return null;
    const result = await readJsonResponse(tr);
    return {
      ...(result as {
        videoUrl?: string;
        shareUrl?: string;
        srtUrl?: string;
        transcriptUrl?: string;
        voiceCloneApplied?: boolean;
        lipSyncApplied?: boolean;
        runtime?: string;
      }),
      shareUrl: result.shareUrl ?? translatorShareUrl(id),
    };
  }, []);

  const fetchResult = useCallback(async (id: string) => {
    const result = await fetchResultUrls(id);
    if (!result) return null;
    if (result.transcriptUrl) {
      const tj = await fetch(result.transcriptUrl, { cache: NO_STORE });
      if (tj.ok) {
        const parsed = await readJsonResponse(tj, { segments: [] });
        setTranscript(parsed.segments ?? []);
      }
    }
    setJob((prev: any) => ({ ...prev, ...result }));
    return result;
  }, [fetchResultUrls]);

  // Poll job status from DynamoDB via API
  const pollStatus = useCallback(async (id: string) => {
    try {
      const r = await fetch(`${API}/status/${id}`, { headers: translatorAuthHeaders(), cache: NO_STORE });
      if (!r.ok) {
        if (r.status === 404 || r.status === 410) {
          removeActiveTranslatorJob(id);
          refreshHistory();
          if (pollRef.current) clearTimeout(pollRef.current);
          if (jobId === id) {
            setJob(null);
            setJobId(null);
            // Surface to the user instead of silently dropping the job.
            toast({
              title: "Translation no longer available",
              description: "This job was removed or expired on the server.",
              variant: "destructive",
            });
          }
          return false;
        }
        return true;
      }
      const data = await readJsonResponse(r);
      setJob(data);
      // Stuck-job detector — surface a warning if status+progress haven't
      // moved for more than 5 minutes.  Helps users notice when a Batch
      // worker has hung instead of just sitting on a stale "QUEUED 0%".
      const progressNow = Number(data.progress ?? 0);
      const statusNow = String(data.status ?? "");
      const isTerminal = ["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(statusNow);
      if (isTerminal) {
        lastProgressRef.current = { progress: progressNow, status: statusNow, ts: Date.now() };
        setStuckWarning(null);
      } else if (
        lastProgressRef.current.progress === progressNow &&
        lastProgressRef.current.status === statusNow &&
        lastProgressRef.current.ts > 0
      ) {
        const stalledMs = Date.now() - lastProgressRef.current.ts;
        if (stalledMs > 5 * 60_000) {
          setStuckWarning(
            `No progress in ${Math.round(stalledMs / 60_000)} min — the worker may be stuck. ` +
            "You can wait, or cancel and retry.",
          );
        }
      } else {
        lastProgressRef.current = { progress: progressNow, status: statusNow, ts: Date.now() };
        setStuckWarning(null);
      }
      // Append real step/warning/error messages to debug log
      if (data.step) appendLog(data.status === "FAILED" ? "error" : "info", `[${data.status}] ${data.step}`);
      if (data.lipsyncWarning) appendLog("warn", `[LIPSYNC] ${data.lipsyncWarning}`);
      if (data.voiceCloneWarning) appendLog("warn", `[VOICE CLONE] ${data.voiceCloneWarning}`);
      if (data.error) appendLog("error", `[ERROR] ${data.error}`);
      const activeMeta = loadActiveTranslatorJobs().find((j) => j.jobId === id);
      if (!["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(data.status)) {
        upsertActiveTranslatorJob({
          jobId: id,
          filename: data.filename ?? activeMeta?.filename ?? file?.name ?? "video.mp4",
          targetLang: data.targetLang ?? activeMeta?.targetLang ?? TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: data.targetLangCode ?? activeMeta?.targetLangCode ?? tgtLang,
          sourceLang: data.sourceLang ?? activeMeta?.sourceLang ?? srcLang,
          startedAt: activeMeta?.startedAt ?? toEpoch(data.createdAt),
          progress: data.progress ?? activeMeta?.progress ?? 0,
          step: data.step ?? activeMeta?.step ?? "",
          status: data.status ?? activeMeta?.status ?? "QUEUED",
          // Persist voiceClone/lipSync so re-opening the job shows the correct badge.
          voiceClone: data.voiceClone ?? activeMeta?.voiceClone,
          lipSync: data.lipSync ?? activeMeta?.lipSync,
        });
        refreshHistory();
      }
      if (data.status === "DONE") {
        if (pollRef.current) clearTimeout(pollRef.current);
        const result = await fetchResult(id);
        removeActiveTranslatorJob(id);
        saveTranslatorHistory({
          jobId: id,
          createdAt: toEpoch(data.createdAt, activeMeta?.startedAt ?? Date.now()),
          updatedAt: toEpoch(data.updatedAt, Date.now()),
          filename: data.filename ?? activeMeta?.filename ?? file?.name ?? "video.mp4",
          targetLang: data.targetLang ?? activeMeta?.targetLang ?? TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: data.targetLangCode ?? activeMeta?.targetLangCode ?? tgtLang,
          sourceLang: data.sourceLang ?? activeMeta?.sourceLang ?? srcLang,
          progress: 100,
          segmentCount: data.segmentCount,
          videoUrl: result?.videoUrl,
          shareUrl: result?.shareUrl ?? translatorShareUrl(id),
          srtUrl: result?.srtUrl,
          transcriptUrl: result?.transcriptUrl,
        });
        refreshHistory();
        return false;
      } else if (data.status === "FAILED") {
        if (pollRef.current) clearTimeout(pollRef.current);
        removeActiveTranslatorJob(id);
        refreshHistory();
        setError(data.error ?? "Translation failed");
        return false;
      } else if (data.status === "CANCELLED" || data.status === "EXPIRED") {
        if (pollRef.current) clearTimeout(pollRef.current);
        removeActiveTranslatorJob(id);
        refreshHistory();
        return false;
      }
      return true;
    } catch (e: any) {
      setError(e?.message);
      return true;
    }
  }, [fetchResult, file?.name, jobId, refreshHistory, srcLang, tgtLang]);

  useEffect(() => {
    if (!jobId) return;
    pollStartRef.current = Date.now();
    lastProgressRef.current = { progress: 0, status: "", ts: 0 };
    setStuckWarning(null);
    let isActive = true;

    // P2-9: Progressive poll backoff — 2s for first 60s, 5s until 3min, 10s after.
    const schedulePoll = () => {
      if (!isActive) return;
      const elapsed = Date.now() - pollStartRef.current;
      let interval: number;
      if (elapsed < 60_000) interval = 2000;
      else if (elapsed < 180_000) interval = 5000;
      else interval = 10_000;
      pollRef.current = setTimeout(async () => {
        const shouldContinue = await pollStatus(jobId);
        if (isActive && shouldContinue) {
          schedulePoll();
        }
      }, interval);
    };

    const startPolling = async () => {
      const shouldContinue = await pollStatus(jobId);
      if (isActive && shouldContinue) {
        schedulePoll();
      }
    };
    void startPolling();
    return () => {
      isActive = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [jobId, pollStatus]);

  // Clear the YouTube-prep poll timer if the component unmounts mid-fetch.
  useEffect(() => () => {
    if (ytPollRef.current) { clearTimeout(ytPollRef.current); ytPollRef.current = null; }
  }, []);

  useEffect(() => {
    let closed = false;
    const reconcileTranslatorJobs = async () => {
      try {
        const activeJobs = loadActiveTranslatorJobs();
        for (const activeJob of activeJobs) {
          if (isTranslatorHistoryDeleted(activeJob.jobId)) {
            removeActiveTranslatorJob(activeJob.jobId);
            continue;
          }

          try {
            const statusRes = await fetch(`${API}/status/${encodeURIComponent(activeJob.jobId)}`, {
              headers: translatorAuthHeaders(),
              cache: NO_STORE,
            });
            if (!statusRes.ok) {
              if (statusRes.status === 404 || statusRes.status === 410) {
                removeActiveTranslatorJob(activeJob.jobId);
              }
              continue;
            }
            const statusItem = await readJsonResponse<any>(statusRes, { status: "UNKNOWN" });
            if (statusItem.status === "DONE") {
              const urls = await fetchResultUrls(activeJob.jobId);
              saveTranslatorHistory({
                jobId: activeJob.jobId,
                createdAt: toEpoch(statusItem.createdAt, activeJob.startedAt),
                updatedAt: toEpoch(statusItem.updatedAt, Date.now()),
                filename: statusItem.filename ?? activeJob.filename,
                targetLang: statusItem.targetLang ?? activeJob.targetLang,
                targetLangCode: statusItem.targetLangCode ?? activeJob.targetLangCode,
                sourceLang: statusItem.sourceLang ?? activeJob.sourceLang,
                progress: 100,
                segmentCount: statusItem.segmentCount,
                videoUrl: urls?.videoUrl,
                shareUrl: urls?.shareUrl ?? translatorShareUrl(activeJob.jobId),
                srtUrl: urls?.srtUrl,
                transcriptUrl: urls?.transcriptUrl,
              });
              removeActiveTranslatorJob(activeJob.jobId);
            } else if (statusItem.status === "FAILED" || statusItem.status === "CANCELLED" || statusItem.status === "EXPIRED") {
              removeActiveTranslatorJob(activeJob.jobId);
            } else {
              upsertActiveTranslatorJob({
                ...activeJob,
                filename: statusItem.filename ?? activeJob.filename,
                targetLang: statusItem.targetLang ?? activeJob.targetLang,
                targetLangCode: statusItem.targetLangCode ?? activeJob.targetLangCode,
                sourceLang: statusItem.sourceLang ?? activeJob.sourceLang,
                progress: statusItem.progress ?? activeJob.progress,
                step: statusItem.step ?? activeJob.step,
                status: statusItem.status ?? activeJob.status,
              });
            }
          } catch { }
        }

        const res = await fetch(`${API}/history?limit=20`, { headers: translatorAuthHeaders(), cache: NO_STORE });
        if (!res.ok) return;
        const data = await readJsonResponse<any>(res, { jobs: [] });
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        for (const item of jobs) {
          if (!item?.jobId) continue;
          if (isTranslatorHistoryDeleted(item.jobId)) {
            removeActiveTranslatorJob(item.jobId);
            continue;
          }

          const existingActive = loadActiveTranslatorJobs().find((entry) => entry.jobId === item.jobId);
          if (item.status === "DONE") {
            const existing = loadTranslatorHistory().find((entry) => entry.jobId === item.jobId);
            let urls: { videoUrl?: string; shareUrl?: string; srtUrl?: string; transcriptUrl?: string } | null = null;
            try {
              urls = await fetchResultUrls(item.jobId);
            } catch { }
            saveTranslatorHistory({
              jobId: item.jobId,
              createdAt: toEpoch(item.createdAt, existingActive?.startedAt ?? Date.now()),
              updatedAt: toEpoch(item.updatedAt, toEpoch(item.createdAt)),
              filename: item.filename ?? existing?.filename ?? "video.mp4",
              targetLang: item.targetLang ?? existing?.targetLang ?? "Unknown",
              targetLangCode: item.targetLangCode ?? existing?.targetLangCode,
              sourceLang: item.sourceLang ?? existing?.sourceLang,
              progress: 100,
              segmentCount: item.segmentCount,
              videoUrl: urls?.videoUrl ?? existing?.videoUrl,
              shareUrl: urls?.shareUrl ?? translatorShareUrl(item.jobId),
              srtUrl: urls?.srtUrl ?? existing?.srtUrl,
              transcriptUrl: urls?.transcriptUrl ?? existing?.transcriptUrl,
            });
            removeActiveTranslatorJob(item.jobId);
          } else if (item.status === "FAILED" || item.status === "CANCELLED" || item.status === "EXPIRED") {
            removeActiveTranslatorJob(item.jobId);
          } else if (existingActive) {
            upsertActiveTranslatorJob({
              ...existingActive,
              filename: item.filename ?? existingActive.filename,
              targetLang: item.targetLang ?? existingActive.targetLang,
              targetLangCode: item.targetLangCode ?? existingActive.targetLangCode,
              sourceLang: item.sourceLang ?? existingActive.sourceLang,
              progress: item.progress ?? existingActive.progress,
              step: item.step ?? existingActive.step,
              status: item.status ?? existingActive.status,
            });
          }
        }
        if (!closed) {
          refreshHistory();
          // Auto-open the newest running job on load — but NOT while the user is
          // composing a new translation, or we'd hijack their fresh form.
          if (!jobId && !composingNew) {
            const active = loadActiveTranslatorJobs();
            const newest = active.sort((a, b) => b.startedAt - a.startedAt)[0];
            if (newest) {
              setJobId(newest.jobId);
              setJob({
                jobId: newest.jobId,
                status: newest.status,
                progress: newest.progress,
                step: newest.step,
                filename: newest.filename,
                targetLang: newest.targetLang,
              });
            }
          }
        }
      } catch { }
    };

    void reconcileTranslatorJobs();
    return () => {
      closed = true;
    };
  }, [fetchResultUrls, jobId, refreshHistory, composingNew]);

  // Shared translator options for both the file-upload and YouTube paths.
  const buildSubmitOptions = useCallback(() => {
    const isVoiceClone = voiceStyle === "original" && translationMode === "full";
    return {
      targetLang: TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
      targetLangCode: tgtLang,
      sourceLang: srcLang,
      voiceClone: isVoiceClone,
      lipSync: lipSyncAvailable && lipSync && translationMode === "full",
      lipSyncQuality: "latentsync",
      translationMode: translationMode === "subtitle-only" ? "subtitle-only" : "default",
      multiSpeaker: isVoiceClone ? multiSpeaker : false,
      useDemucs: keepBackgroundMusic && translationMode === "full",
      dynamicVideoLength: translationMode === "full" && dynamicVideoLength,
      preserveChants: translationMode === "full" && preserveChants,
    };
  }, [voiceStyle, translationMode, tgtLang, srcLang, lipSyncAvailable, lipSync, multiSpeaker, keepBackgroundMusic, dynamicVideoLength, preserveChants]);

  // Poll a YouTube download/clip-cut job until it produces an S3 object.
  const pollYoutubeUntilReady = useCallback((ytJobId: string, mode: "clip" | "full") =>
    new Promise<string | null>((resolve, reject) => {
      const startedAt = Date.now();
      const verb = mode === "clip" ? "Cutting" : "Downloading";
      const tick = async () => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        try {
          const res = await fetch(`${YT_BASE}/progress/${ytJobId}`, { cache: NO_STORE });
          if (res.ok) {
            const data = await readJsonResponse<any>(res);
            const status = String(data.status ?? "");
            // Always show movement: percent when known, else an elapsed timer,
            // so a legitimate multi-minute fetch never looks frozen.
            const pct = typeof data.percent === "number" ? ` ${Math.round(data.percent)}%` : ` ${elapsed}s`;
            setPrepareMsg(`${verb} from YouTube…${pct}`);
            if (["done", "complete", "finished"].includes(status)) {
              resolve(data.s3Key ?? data.queue?.s3Key ?? null);
              return;
            }
            if (["error", "failed", "cancelled", "expired", "not_found"].includes(status)) {
              reject(new Error(data.message || `YouTube ${mode === "clip" ? "clip" : "download"} ${status}.`));
              return;
            }
          } else {
            setPrepareMsg(`${verb} from YouTube… ${elapsed}s`);
          }
        } catch {
          setPrepareMsg(`${verb} from YouTube… ${elapsed}s`);
        }
        if (Date.now() - startedAt > 20 * 60_000) {
          reject(new Error("YouTube fetch timed out. Try a shorter clip."));
          return;
        }
        ytPollRef.current = setTimeout(tick, 2500);
      };
      void tick();
    }), []);

  const handleYoutubeTranslate = useCallback(async () => {
    setError(null);
    const url = youtubeUrl.trim();
    if (!url) { setError("Paste a YouTube link first."); return; }
    if (!isLikelyYouTubeUrl(url)) { setError("That doesn't look like a valid YouTube link."); return; }

    let clipBody: { startTime: number; endTime: number } | null = null;
    if (useClip) {
      const s = parseTimeToSeconds(clipStart);
      const e = parseTimeToSeconds(clipEnd);
      if (s == null || e == null) { setError("Enter a valid start and end time (e.g. 1:30 and 2:45)."); return; }
      if (e <= s) { setError("The end time must be after the start time."); return; }
      if (e - s > 3600) { setError("A clip can be at most 60 minutes long."); return; }
      clipBody = { startTime: s, endTime: e };
    }

    setPreparing(true);
    setJob(null); setTranscript([]);
    setPrepareMsg(clipBody ? "Cutting the selected part from YouTube…" : "Fetching the video from YouTube…");
    try {
      const endpoint = clipBody ? `${YT_BASE}/clip-cut` : `${YT_BASE}/download`;
      const body = clipBody ? { url, ...clipBody, quality: "best" } : { url };
      const startRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!startRes.ok) throw await responseError(startRes, "Failed to fetch the video from YouTube.");
      const startData = await readJsonResponse<any>(startRes);
      const ytJobId = String(startData.jobId ?? "");
      if (!ytJobId) throw new Error("YouTube did not return a job id.");

      const sourceS3Key = await pollYoutubeUntilReady(ytJobId, clipBody ? "clip" : "full");
      if (!sourceS3Key) {
        throw new Error("The YouTube video could not be prepared for translation (no cloud file produced).");
      }

      setPrepareMsg("Starting translation…");
      const filename = youtubeFilename(url);
      const submitRes = await fetch(`${API}/submit-from-s3`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...translatorAuthHeaders() },
        body: JSON.stringify({ sourceS3Key, filename, ...buildSubmitOptions() }),
      });
      if (!submitRes.ok) throw await responseError(submitRes, "Failed to start translation.");
      const submitData = await readJsonResponse<any>(submitRes);
      const newJobId = String(submitData?.jobId ?? "");
      if (!newJobId) throw new Error("Translation submit response was incomplete.");

      const opts = buildSubmitOptions();
      upsertActiveTranslatorJob({
        jobId: newJobId,
        filename,
        targetLang: opts.targetLang,
        targetLangCode: tgtLang,
        sourceLang: srcLang,
        startedAt: Date.now(),
        progress: 0,
        step: "Job queued, waiting for worker...",
        status: "QUEUED",
        voiceClone: opts.voiceClone,
        lipSync: opts.lipSync,
      });
      setComposingNew(false);
      setJobId(newJobId);
      refreshHistory();
    } catch (e: any) {
      setError(e?.message ?? "YouTube translation failed.");
    } finally {
      setPreparing(false);
      setPrepareMsg("");
      if (ytPollRef.current) { clearTimeout(ytPollRef.current); ytPollRef.current = null; }
    }
  }, [youtubeUrl, useClip, clipStart, clipEnd, buildSubmitOptions, pollYoutubeUntilReady, tgtLang, srcLang, refreshHistory]);

  const handleUpload = async () => {
    if (!file) return;
    setError(null); setUploading(true); setJob(null); setTranscript([]);
    try {
      if (file.size > MAX_VIDEO_SIZE_BYTES) {
        throw new Error("Video is larger than the 2GB upload limit.");
      }

      // P2-13: Client-side idempotency — detect duplicate uploads.
      // Hash the first 1MB + file size as a fingerprint. If a recent active
      // job has the same hash, warn the user instead of creating a duplicate.
      let fileFingerprint: string | undefined;
      if (globalThis.crypto?.subtle) {
        const hashSlice = file.slice(0, 1024 * 1024);
        const hashBuffer = await hashSlice.arrayBuffer();
        const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", hashBuffer);
        const digestHex = Array.from(new Uint8Array(digestBuffer))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        fileFingerprint = `${digestHex}-${file.size}`;
        const existingDuplicate = loadActiveTranslatorJobs().find(
          j => j.fileFingerprint === fileFingerprint && Date.now() - j.startedAt < 3600_000
        );
        if (existingDuplicate) {
          const confirmDuplicate = window.confirm(
            `You already submitted this video ${Math.round((Date.now() - existingDuplicate.startedAt) / 60000)} minutes ago (Job: ${existingDuplicate.jobId.slice(0, 8)}…). Submit again anyway?`
          );
          if (!confirmDuplicate) {
            setUploading(false);
            return;
          }
        }
      }

      // Step 1: Get S3 presigned PUT URL
      const presignRes = await fetch(
        `${API}/presign?filename=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type || "video/mp4")}`,
        { headers: translatorAuthHeaders() },
      );
      if (!presignRes.ok) throw await responseError(presignRes, "Failed to get upload URL");
      const { jobId: newJobId, presignedUrl, s3Key } = await readJsonResponse(presignRes);
      if (!newJobId || !presignedUrl || !s3Key) {
        throw new Error("Upload URL response was incomplete.");
      }

      // Step 2: Upload directly to S3
      const uploadRes = await fetch(presignedUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "video/mp4" },
      });
      if (!uploadRes.ok) throw new Error("S3 upload failed");

      // Step 3: Submit Batch job
      const isVoiceClone = voiceStyle === "original" && translationMode === "full";
      const submitRes = await fetch(`${API}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...translatorAuthHeaders() },
        body: JSON.stringify({
          jobId: newJobId,
          s3Key,
          filename: file.name,
          targetLang: TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: tgtLang,
          sourceLang: srcLang,
          voiceClone: isVoiceClone,
          lipSync: lipSyncAvailable && lipSync && translationMode === "full",
          lipSyncQuality: "latentsync",
          translationMode: translationMode === "subtitle-only" ? "subtitle-only" : "default",
          // P2-8: multiSpeaker controlled by user toggle (defaults to true
          // when voice cloning).  Single-speaker vlogs can disable this to
          // skip diarization and save ~1-2 min.
          multiSpeaker: isVoiceClone ? multiSpeaker : false,
          // P2-7: background music separation (Demucs).  When disabled,
          // the dubbed audio is voice-only with no background music mix.
          useDemucs: keepBackgroundMusic && translationMode === "full",
          // Dynamic Video Length: keep the dubbed voice at natural speed and
          // let the output video grow (frozen-frame holds in the pauses)
          // rather than speeding the voice up to fit the original length.
          dynamicVideoLength: translationMode === "full" && dynamicVideoLength,
          // Keep devotional content (bhajans/kirtan/shlokas) in the original
          // audio instead of translating/dubbing it.
          preserveChants: translationMode === "full" && preserveChants,
        }),
      });
      if (!submitRes.ok) throw await responseError(submitRes, "Submit failed");
      const submitData = await readJsonResponse(submitRes);
      if (!submitData?.jobId) {
        throw new Error("Submit response was incomplete.");
      }

      upsertActiveTranslatorJob({
        jobId: newJobId,
        filename: file.name,
        targetLang: TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
        targetLangCode: tgtLang,
        sourceLang: srcLang,
        startedAt: Date.now(),
        progress: 0,
        step: "Job queued, waiting for worker...",
        status: "QUEUED",
        fileFingerprint,
        voiceClone: isVoiceClone,
        lipSync: lipSyncAvailable && lipSync && translationMode === "full",
      });
      setComposingNew(false);
      setJobId(newJobId);
      refreshHistory();
    } catch (e: any) {
      setError(e?.message);
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (ytPollRef.current) { clearTimeout(ytPollRef.current); ytPollRef.current = null; }
    setFile(null); setJobId(null); setJob(null);
    setTranscript([]); setError(null); setShowTranscript(false);
    setStuckWarning(null);
    setPreparing(false); setPrepareMsg("");
    lastProgressRef.current = { progress: 0, status: "", ts: 0 };
  };

  // Return to the upload form to start an additional translation WITHOUT
  // cancelling the running one — it keeps processing and stays visible in the
  // "Active translations" list. `composingNew` blocks the reconcile effect from
  // snapping the foreground back to the running job.
  const startAnother = () => {
    setComposingNew(true);
    reset();
  };

  const openActiveEntry = (entry: ActiveTranslatorJob) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setComposingNew(false);
    setFile(null);
    setError(null);
    setTranscript([]);
    setJobId(entry.jobId);
    setJob({
      jobId: entry.jobId,
      status: entry.status,
      progress: entry.progress,
      step: entry.step,
      filename: entry.filename,
      targetLang: entry.targetLang,
      targetLangCode: entry.targetLangCode,
      sourceLang: entry.sourceLang,
      createdAt: entry.startedAt,
      // Include voiceClone/lipSync so the result badge (Voice cloned vs Neural
      // fallback) renders correctly when re-opening an active job. Without these
      // the badge always shows "Neural fallback" because job.voiceClone===undefined.
      voiceClone: entry.voiceClone,
      lipSync: entry.lipSync,
    });
  };

  const cancelTranslation = async (id: string) => {
    try {
      const res = await fetch(`${API}/cancel/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: translatorAuthHeaders(),
        cache: NO_STORE,
      });
      if (!res.ok) throw await responseError(res, "Cancel failed");
      removeActiveTranslatorJob(id);
      refreshHistory();
      if (jobId === id) {
        if (pollRef.current) clearTimeout(pollRef.current);
        setJob((prev: any) => ({ ...(prev ?? { jobId: id }), status: "CANCELLED", step: "Cancelled by user." }));
        setError(null);
      }
      toast({ title: "Translation cancelled" });
    } catch (e: any) {
      setError(e?.message ?? "Cancel failed");
    }
  };

  const openHistoryEntry = async (entry: TranslatorHistoryEntry) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setComposingNew(false);
    setFile(null);
    setError(null);
    setTranscript([]);
    setJobId(entry.jobId);
    setJob({
      jobId: entry.jobId,
      status: "DONE",
      progress: 100,
      step: "Translation complete!",
      filename: entry.filename,
      targetLang: entry.targetLang,
      segmentCount: entry.segmentCount,
      videoUrl: entry.videoUrl,
      srtUrl: entry.srtUrl,
      transcriptUrl: entry.transcriptUrl,
      shareUrl: entry.shareUrl ?? translatorShareUrl(entry.jobId),
    });
    const result = await fetchResult(entry.jobId);
    if (result) {
      const updated = { ...entry, ...result, shareUrl: result?.shareUrl ?? translatorShareUrl(entry.jobId) };
      saveTranslatorHistory(updated);
      refreshHistory();
    }
  };

  const deleteHistoryEntry = (id: string) => {
    deleteTranslatorHistory(id);
    refreshHistory();
    if (jobId === id) reset();
  };

  const shareUrl = async (url?: string) => {
    if (!url) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Translated video", url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: "Link copied" });
      }
    } catch { }
  };

  const isProcessing = job && !["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(job.status);
  const isDone = job?.status === "DONE";
  const overallPct = job?.progress ?? 0;

  // Derive step-by-step breakdown from real DynamoDB status + progress
  // Worker status flow: QUEUED → STARTING → EXTRACTING → TRANSCRIBING →
  //   TRANSLATING → CLONING → LIPSYNC → MERGING → UPLOADING → DONE
  const PIPELINE_STEPS = [
    { name: "download", label: "Downloading video", thresholdPct: 3, status_keys: ["STARTING"] },
    { name: "audio_extraction", label: "Extracting audio", thresholdPct: 12, status_keys: ["EXTRACTING"] },
    { name: "transcription", label: "Transcribing speech", thresholdPct: 28, status_keys: ["TRANSCRIBING"] },
    { name: "translation", label: "Translating text", thresholdPct: 48, status_keys: ["TRANSLATING"] },
    { name: "voice_generation", label: "Cloning voice", thresholdPct: 65, status_keys: ["CLONING"] },
    { name: "lip_sync", label: "Running lip sync", thresholdPct: 82, status_keys: ["LIPSYNC"] },
    { name: "video_merge", label: "Merging & generating SRT", thresholdPct: 88, status_keys: ["MERGING"] },
    { name: "upload", label: "Uploading to cloud", thresholdPct: 100, status_keys: ["UPLOADING", "DONE"] },
  ];

  const backendSteps: TranslatorStep[] | null = Array.isArray(job?.steps) && job.steps.length > 0 ? job.steps : null;
  const derivedSteps: TranslatorStep[] | null = backendSteps ?? (isProcessing || isDone
    ? PIPELINE_STEPS.map((s) => {
      // Mark steps as skipped when the job was not configured to run them.
      // lip_sync: skipped when job.lipSync is explicitly false (user didn't enable it).
      // voice_generation: skipped when voiceClone=false (Neural Voice or subtitle-only).
      // We rely on job.lipSync / job.voiceClone from the API status response
      // (set during submit). Fall back gracefully when the fields are absent
      // (e.g. older jobs that predate these fields).
      if (s.name === "lip_sync" && job?.lipSync === false) {
        return {
          name: s.name,
          label: s.label,
          status: "skipped" as const,
          message: "Lip sync disabled for this job.",
        };
      }
      if (s.name === "voice_generation" && job?.voiceClone === false) {
        return {
          name: s.name,
          label: "Generating neural voice",
          status: isDone ? "completed" as const : (overallPct >= s.thresholdPct ? "completed" as const : overallPct >= PIPELINE_STEPS.find(p => p.name === "translation")!.thresholdPct ? "running" as const : "pending" as const),
          message: undefined,
        };
      }
      const isCurrentStatus = s.status_keys.includes(job?.status ?? "");
      const isPastThreshold = overallPct >= s.thresholdPct;
      const isBeforeThreshold = overallPct < s.thresholdPct && !isCurrentStatus;
      let stepStatus: TranslatorStep["status"];
      if (isDone || isPastThreshold) stepStatus = "completed";
      else if (isCurrentStatus) stepStatus = "running";
      else if (isBeforeThreshold) stepStatus = "pending";
      else stepStatus = "completed";
      return {
        name: s.name,
        label: s.label,
        status: stepStatus,
        // Show real step message from DynamoDB on the currently running step
        message: isCurrentStatus ? (job?.step ?? "") : undefined,
        // Show real sub-progress on the running step
        progress: isCurrentStatus ? overallPct : undefined,
      };
    })
    : null);


  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Header */}
        <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-br from-primary/15 via-purple-500/5 to-transparent p-5">
          <div className="absolute -top-10 -right-8 w-40 h-40 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
          <div className="relative flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-orange-400 flex items-center justify-center shadow-lg shadow-primary/30 shrink-0">
              <Languages className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2 flex-wrap">
                Video Translator
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30">AI Dub</span>
              </h1>
              <p className="text-sm text-white/50 mt-0.5">Clone the speaker's voice into 18+ languages — upload a file or paste a YouTube link.</p>
            </div>
            {jobId && (
              <button onClick={reset} className="shrink-0 p-2.5 rounded-xl bg-white/6 hover:bg-white/12 text-white/50 hover:text-white transition-colors" title="Start over">
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="flex flex-col gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300 text-sm">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="flex-1">{error}</span>
                <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
              </div>
              {/* Quick-fix actions */}
              <div className="flex gap-2 pl-7">
                {error.toLowerCase().includes("cosyvoice") || error.toLowerCase().includes("voice clon") ? (
                  <button
                    onClick={() => { setVoiceStyle("female"); setError(null); setJobId(null); setJob(null); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/10 hover:bg-white/15 text-white/80 transition-colors border border-white/12"
                  >
                    👩 Switch to Neural Voice &amp; Retry
                  </button>
                ) : null}
                <button
                  onClick={() => { setError(null); setJobId(null); setJob(null); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/06 hover:bg-white/10 text-white/50 transition-colors border border-white/08"
                >
                  Start Over
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {activeJobs.length > 0 && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-amber-300 animate-spin" />
              <span className="text-sm font-semibold text-white/85">Active translations</span>
              <span className="text-xs text-white/35">{activeJobs.length}</span>
              {(isProcessing || (!composingNew && !preparing)) && (
                <button
                  onClick={startAnother}
                  className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 transition-colors"
                >
                  + Translate another
                </button>
              )}
            </div>
            <div className="divide-y divide-white/[0.05]">
              {activeJobs.map((entry) => (
                <div key={entry.jobId} className={cn(
                  "px-4 py-3 flex items-center gap-3 transition-colors",
                  jobId === entry.jobId ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                )}>
                  <button
                    onClick={() => openActiveEntry(entry)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-sm text-white/85 font-medium truncate">{entry.filename}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-white/40">
                      <span>{entry.status}</span>
                      <span>{entry.progress}%</span>
                      <span>{formatRelative(entry.startedAt)}</span>
                    </div>
                    <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.max(2, entry.progress)}%` }} />
                    </div>
                  </button>
                  <button
                    onClick={() => void cancelTranslation(entry.jobId)}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {preparing && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-5 flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white/85">Preparing your video…</p>
              <p className="text-xs text-white/45 mt-0.5 truncate">{prepareMsg || "Working…"}</p>
            </div>
          </motion.div>
        )}

        <>
          {!isProcessing && !preparing && <>
            {/* Source selector */}
            <div className="grid grid-cols-2 gap-2 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.08]">
              <button
                onClick={() => setSourceMode("upload")}
                className={cn("flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all",
                  sourceMode === "upload" ? "bg-primary text-white shadow-lg shadow-primary/25" : "text-white/50 hover:text-white/80")}
              >
                <Upload className="w-4 h-4" /> Upload file
              </button>
              <button
                onClick={() => setSourceMode("youtube")}
                className={cn("flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all",
                  sourceMode === "youtube" ? "bg-primary text-white shadow-lg shadow-primary/25" : "text-white/50 hover:text-white/80")}
              >
                <Youtube className="w-4 h-4" /> YouTube link
              </button>
            </div>

            {sourceMode === "upload" ? (
              <>
                {/* Drop zone */}
                <DropZone onFile={setFile} disabled={uploading} />
                {file && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08]">
                    <Film className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-sm text-white/80 flex-1 truncate">{file.name}</span>
                    <span className="text-xs text-white/40">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    <button onClick={() => setFile(null)} className="text-white/30 hover:text-white/70 transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-3">
                {/* YouTube URL */}
                <div className="relative">
                  <Youtube className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-red-400/80 pointer-events-none" />
                  <input
                    type="url"
                    inputMode="url"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://youtube.com/watch?v=…"
                    className="w-full bg-white/[0.06] border border-white/[0.1] rounded-2xl pl-12 pr-4 py-4 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-primary/60 transition-colors"
                  />
                </div>
                {youtubeUrl.trim() && !isLikelyYouTubeUrl(youtubeUrl) && (
                  <p className="text-[11px] text-amber-300/70 flex items-center gap-1.5 pl-1">
                    <AlertCircle className="w-3 h-3" /> This doesn't look like a YouTube link.
                  </p>
                )}

                {/* Clip a specific part */}
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 flex flex-col gap-3">
                  <label className="flex items-center gap-3 select-none cursor-pointer">
                    <div onClick={() => setUseClip(!useClip)}
                      className={cn("w-10 h-6 rounded-full transition-all relative cursor-pointer shrink-0", useClip ? "bg-primary" : "bg-white/20")}>
                      <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all", useClip ? "left-[18px]" : "left-0.5")} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Scissors className="w-4 h-4 text-primary/80 shrink-0" />
                      <div>
                        <p className="text-sm text-white/80 font-medium">Translate only a part</p>
                        <p className="text-xs text-white/40">Cut a specific time range and translate just that clip.</p>
                      </div>
                    </div>
                  </label>
                  {useClip && (
                    <div className="flex flex-col gap-2 pl-1">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-white/40 font-medium uppercase tracking-wider flex items-center gap-1"><Clock className="w-3 h-3" /> Start</label>
                          <input value={clipStart} onChange={(e) => setClipStart(e.target.value)} placeholder="0:00"
                            className="w-full bg-white/[0.06] border border-white/[0.1] rounded-xl px-3 py-2.5 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-primary/60 font-mono" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-white/40 font-medium uppercase tracking-wider flex items-center gap-1"><Clock className="w-3 h-3" /> End</label>
                          <input value={clipEnd} onChange={(e) => setClipEnd(e.target.value)} placeholder="2:30"
                            className="w-full bg-white/[0.06] border border-white/[0.1] rounded-xl px-3 py-2.5 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-primary/60 font-mono" />
                        </div>
                      </div>
                      {(() => {
                        const s = parseTimeToSeconds(clipStart);
                        const e = parseTimeToSeconds(clipEnd);
                        if (s == null || e == null) return <p className="text-[11px] text-white/35 pl-1">Use mm:ss (e.g. 1:30) or h:mm:ss.</p>;
                        if (e <= s) return <p className="text-[11px] text-red-300/70 pl-1">End time must be after start time.</p>;
                        if (e - s > 3600) return <p className="text-[11px] text-red-300/70 pl-1">Maximum clip length is 60 minutes.</p>;
                        return <p className="text-[11px] text-emerald-300/70 pl-1">Clip length: {secondsToClock(e - s)}</p>;
                      })()}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Settings */}
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 vt-options-grid">
                <LangSelect id="src-lang" label="Source Language" value={srcLang}
                  onChange={setSrcLang} options={LANGS} />
                <LangSelect id="tgt-lang" label="Target Language" value={tgtLang}
                  onChange={setTgtLang} options={TARGET_LANGS} />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-white/40 font-medium uppercase tracking-wider">Voice Style</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setVoiceStyle("original")}
                    disabled={translationMode === "subtitle-only"}
                    className={cn("flex-1 py-3 rounded-xl text-sm font-medium border transition-all flex flex-col items-center gap-1",
                      translationMode === "subtitle-only" ? "bg-white/[0.04] border-white/[0.06] text-white/30 cursor-not-allowed" :
                      voiceStyle === "original" ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}
                  >
                    <span>🎤 Clone Voice</span>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300/80 border border-amber-400/20">GPU Required</span>
                  </button>
                  <button
                    onClick={() => setVoiceStyle("female")}
                    disabled={translationMode === "subtitle-only"}
                    className={cn("flex-1 py-3 rounded-xl text-sm font-medium border transition-all flex flex-col items-center gap-1",
                      translationMode === "subtitle-only" ? "bg-white/[0.04] border-white/[0.06] text-white/30 cursor-not-allowed" :
                      voiceStyle === "female" ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}
                  >
                    <span>👩 Neural Voice</span>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300/80 border border-emerald-400/20">Always Available</span>
                  </button>
                </div>
                {translationMode === "subtitle-only" ? (
                  <p className="text-[11px] text-blue-300/60 flex items-center gap-1.5">
                    <span>ℹ️</span>
                    Voice style is unused in Subtitles Only mode — only the SRT is generated.
                  </p>
                ) : voiceStyle === "original" ? (
                  <p className="text-[11px] text-amber-300/60 flex items-center gap-1.5">
                    <span>⚠️</span>
                    Requires GPU worker. Auto-falls back to Neural Voice if unavailable.
                  </p>
                ) : null}
              </div>

              {/* P2-1: Translation Mode — explicit choice between full dubbing and subtitles only */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-white/40 font-medium uppercase tracking-wider">Translation Mode</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTranslationMode("full")}
                    className={cn("flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all",
                      translationMode === "full" ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}
                  >
                    🎬 Full Dubbing
                  </button>
                  <button
                    onClick={() => setTranslationMode("subtitle-only")}
                    className={cn("flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all",
                      translationMode === "subtitle-only" ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}
                  >
                    📝 Subtitles Only
                  </button>
                </div>
                {translationMode === "subtitle-only" && (
                  <p className="text-[11px] text-blue-300/60 flex items-center gap-1.5">
                    <span>ℹ️</span>
                    Fast mode: generates translated SRT subtitles without voice dubbing.
                  </p>
                )}
              </div>

              {/* P2-7: Advanced Settings — collapsible */}
              {translationMode === "full" && (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setShowAdvanced(v => !v)}
                    className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 transition-colors font-medium uppercase tracking-wider"
                  >
                    <span>{showAdvanced ? "▾" : "▸"} Advanced Settings</span>
                  </button>
                  {showAdvanced && (
                    <div className="flex flex-col gap-3 pl-2 border-l-2 border-white/[0.06] ml-1">
                      {/* Background music toggle */}
                      <label className="flex items-center gap-3 select-none cursor-pointer">
                        <div onClick={() => setKeepBackgroundMusic(!keepBackgroundMusic)}
                          className={cn("w-10 h-6 rounded-full transition-all relative cursor-pointer",
                            keepBackgroundMusic ? "bg-primary" : "bg-white/20")}>
                          <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                            keepBackgroundMusic ? "left-[18px]" : "left-0.5")} />
                        </div>
                        <div>
                          <p className="text-sm text-white/80 font-medium">Keep Background Music</p>
                          <p className="text-xs text-white/40">Separates and re-mixes original background audio with dubbed voice</p>
                        </div>
                      </label>

                      {/* P2-8: Multi-speaker toggle */}
                      {voiceStyle === "original" && (
                        <label className="flex items-center gap-3 select-none cursor-pointer">
                          <div onClick={() => setMultiSpeaker(!multiSpeaker)}
                            className={cn("w-10 h-6 rounded-full transition-all relative cursor-pointer",
                              multiSpeaker ? "bg-primary" : "bg-white/20")}>
                            <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                              multiSpeaker ? "left-[18px]" : "left-0.5")} />
                          </div>
                          <div>
                            <p className="text-sm text-white/80 font-medium">Multi-Speaker Detection</p>
                            <p className="text-xs text-white/40">Disable for single-speaker vlogs to save ~1-2 min processing time</p>
                          </div>
                        </label>
                      )}

                      {/* Dynamic Video Length toggle */}
                      <label className="flex items-center gap-3 select-none cursor-pointer">
                        <div onClick={() => setDynamicVideoLength(!dynamicVideoLength)}
                          className={cn("w-10 h-6 rounded-full transition-all relative cursor-pointer",
                            dynamicVideoLength ? "bg-primary" : "bg-white/20")}>
                          <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                            dynamicVideoLength ? "left-[18px]" : "left-0.5")} />
                        </div>
                        <div>
                          <p className="text-sm text-white/80 font-medium">Dynamic Video Length</p>
                          <p className="text-xs text-white/40">Keeps the dubbed voice at its natural speed (no speed-up). The video may get a few seconds longer, holding the frame during pauses.</p>
                        </div>
                      </label>

                      {/* Preserve bhajans/shlokas toggle */}
                      <label className="flex items-center gap-3 select-none cursor-pointer">
                        <div onClick={() => setPreserveChants(!preserveChants)}
                          className={cn("w-10 h-6 rounded-full transition-all relative cursor-pointer",
                            preserveChants ? "bg-primary" : "bg-white/20")}>
                          <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                            preserveChants ? "left-[18px]" : "left-0.5")} />
                        </div>
                        <div>
                          <p className="text-sm text-white/80 font-medium">Keep bhajans &amp; shlokas original</p>
                          <p className="text-xs text-white/40">Detects sung bhajans/kirtan and Sanskrit/Odia shlokas and leaves them in the original audio — only the spoken parts are dubbed.</p>
                        </div>
                      </label>
                    </div>
                  )}
                </div>
              )}

              <label className={cn("flex items-center gap-3 select-none", lipSyncAvailable && translationMode === "full" ? "cursor-pointer" : "cursor-not-allowed opacity-60")}>
                <div onClick={() => lipSyncAvailable && translationMode === "full" && setLipSync(!lipSync)}
                  className={cn("w-10 h-6 rounded-full transition-all relative", lipSyncAvailable && translationMode === "full" ? "cursor-pointer" : "cursor-not-allowed",
                    lipSyncAvailable && lipSync && translationMode === "full" ? "bg-primary" : "bg-white/20")}>
                  <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                    lipSyncAvailable && lipSync && translationMode === "full" ? "left-[18px]" : "left-0.5")} />
                </div>
                <div>
                  <p className="text-sm text-white/80 font-medium">Lip Sync (LatentSync)</p>
                  <p className="text-xs text-white/40">
                    {!lipSyncAvailable ? "Limited to selected approved users" : translationMode !== "full" ? "Only available in Full Dubbing mode" : "Enabled for your account; uses the fast GPU queue"}
                  </p>
                </div>
              </label>
            </div>

            {/* Submit */}
            {(() => {
              const canSubmit = sourceMode === "upload" ? !!file : youtubeUrl.trim().length > 0;
              const busy = uploading || preparing;
              return (
                <button
                  onClick={() => (sourceMode === "youtube" ? void handleYoutubeTranslate() : void handleUpload())}
                  disabled={!canSubmit || busy}
                  className={cn(
                    "w-full py-3.5 rounded-2xl font-bold text-base flex items-center justify-center gap-2 transition-all",
                    canSubmit && !busy
                      ? "bg-gradient-to-r from-primary to-orange-400 hover:opacity-95 text-white shadow-lg shadow-primary/25"
                      : "bg-white/10 text-white/30 cursor-not-allowed"
                  )}
                >
                  {uploading ? <><Loader2 className="w-5 h-5 animate-spin" /> Uploading…</>
                    : preparing ? <><Loader2 className="w-5 h-5 animate-spin" /> Preparing…</>
                    : <><Sparkles className="w-5 h-5" /> {sourceMode === "youtube" ? (useClip ? "Cut & Translate Clip" : "Translate from YouTube") : "Translate Video"} <ArrowRight className="w-4 h-4" /></>}
                </button>
              );
            })()}
          </>}
        </>

        {jobId && (
          <>
            {/* Overall progress */}
            {isProcessing && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-white/88">Translating video...</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-white/50">{overallPct.toFixed(0)}%</span>
                    <button
                      onClick={startAnother}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 transition-colors"
                    >
                      + New
                    </button>
                    <button
                      onClick={() => jobId && void cancelTranslation(jobId)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {job?.step && (
                  <p className="text-xs text-white/45 mb-3 flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0 text-primary/60" />
                    {job.step}
                  </p>
                )}
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <motion.div className="h-full bg-gradient-to-r from-primary to-orange-400 rounded-full"
                    animate={{ width: `${Math.max(2, overallPct)}%` }} transition={{ duration: 0.6 }} />
                </div>
                {stuckWarning && (
                  <div className="mt-3 flex items-start gap-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-200 text-xs">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="flex-1">{stuckWarning}</span>
                  </div>
                )}
              </>
            )}
            {/* Steps + Debug log */}
            {derivedSteps && (
              <div className="flex flex-col gap-2 mt-3">
                {derivedSteps.map((s) => <StepCard key={s.name} step={s} />)}
              </div>
            )}

            {/* Debug Log — collapsible, always available during/after processing */}
            {debugLog.length > 0 && (
              <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/30 overflow-hidden">
                <button
                  onClick={() => setShowDebug(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs text-white/50 hover:text-white/70 hover:bg-white/5 transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <Terminal className="w-3 h-3" />
                    Debug log
                    {debugLog.some(l => l.level === "error") && (
                      <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-mono">
                        {debugLog.filter(l => l.level === "error").length} error{debugLog.filter(l => l.level === "error").length > 1 ? "s" : ""}
                      </span>
                    )}
                    {debugLog.some(l => l.level === "warn") && (
                      <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">
                        {debugLog.filter(l => l.level === "warn").length} warning{debugLog.filter(l => l.level === "warn").length > 1 ? "s" : ""}
                      </span>
                    )}
                  </span>
                  {showDebug ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {showDebug && (
                  <div className="px-3 pb-3 flex flex-col gap-0.5 max-h-52 overflow-y-auto font-mono text-[11px]">
                    {debugLog.map((entry, i) => (
                      <div key={i} className={cn(
                        "flex gap-2 leading-5",
                        entry.level === "error" ? "text-red-400" :
                          entry.level === "warn" ? "text-yellow-400" :
                            "text-white/40"
                      )}>
                        <span className="shrink-0 text-white/20">
                          {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                        <span className="break-all">{entry.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Done */}
            {isDone && (
              <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                className="rounded-2xl border border-green-500/25 bg-green-500/8 p-5 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-6 h-6 text-green-400" />
                  <div>
                    <p className="font-bold text-green-300">Translation Complete!</p>
                    <p className="text-xs text-white/40 mt-0.5">{job?.filename ?? file?.name ?? "Translated video"}</p>
                  </div>
                </div>
                {(job?.voiceClone || job?.lipSync || job?.runtime || job?.segmentCount != null) && (
                  <div className="flex flex-wrap gap-2 text-[11px] text-white/50">
                    <span className={cn(
                      "px-2 py-0.5 rounded-full border",
                      job?.voiceClone
                        ? (job?.voiceCloneApplied ? "border-emerald-400/40 text-emerald-300/80" : "border-amber-400/40 text-amber-300/80")
                        : "border-white/15 text-white/40",
                    )}>
                      {job?.voiceClone
                        ? (job?.voiceCloneApplied ? "Voice cloned" : "Neural fallback")
                        : "Neural voice"}
                    </span>
                    <span className={cn(
                      "px-2 py-0.5 rounded-full border",
                      job?.lipSync
                        ? (job?.lipSyncApplied ? "border-emerald-400/40 text-emerald-300/80" : "border-amber-400/40 text-amber-300/80")
                        : "border-white/15 text-white/40",
                    )}>
                      {job?.lipSync
                        ? (job?.lipSyncApplied ? "Lip sync applied" : "Lip sync skipped")
                        : "Lip sync off"}
                    </span>
                    {job?.runtime && (
                      <span className="px-2 py-0.5 rounded-full border border-white/15 text-white/40">
                        Runtime: {job.runtime}
                      </span>
                    )}
                    {job?.segmentCount != null && (
                      <span className="px-2 py-0.5 rounded-full border border-white/15 text-white/40">
                        {job.segmentCount} segments
                      </span>
                    )}
                    {job?.dynamicExtraSeconds != null && job.dynamicExtraSeconds > 0.05 && (
                      <span className="px-2 py-0.5 rounded-full border border-sky-400/40 text-sky-300/80">
                        Dynamic length +{job.dynamicExtraSeconds.toFixed(1)}s
                      </span>
                    )}
                  </div>
                )}
                {job?.voiceClone && job?.voiceCloneApplied === false && (
                  <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/80">
                    Voice cloning fell back to a neural voice. Check the debug log for the CosyVoice error.
                  </div>
                )}
                {job?.runtime === "lambda-fast" && (
                  <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/80">
                    Fast subtitle-only mode was used (no dubbed audio). Submit with full dubbing to clone voices.
                  </div>
                )}
                {job?.videoUrl && (
                  <video
                    src={job.videoUrl}
                    controls
                    className="w-full rounded-xl bg-black aspect-video"
                  />
                )}
                <div className="flex gap-3">
                  {job?.videoUrl && (
                    <a href={job.videoUrl} download={translatedVideoFilename(job?.filename, job?.targetLangCode)}
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-white text-sm transition-all"
                      style={{ background: "linear-gradient(135deg,#16a34a,#15803d)", boxShadow: "0 4px 16px rgba(22,163,74,0.3)" }}>
                      <Download className="w-4 h-4" /> Download Video
                    </a>
                  )}
                  {job?.srtUrl && (
                    <a href={job.srtUrl} download="subtitles.srt"
                      className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                      <Subtitles className="w-4 h-4" /> SRT
                    </a>
                  )}
                  <button onClick={() => setShowTranscript(!showTranscript)}
                    className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                    <Eye className="w-4 h-4" /> Transcript
                  </button>
                  {job?.videoUrl && (
                    <button onClick={() => shareUrl(job.shareUrl ?? (job.jobId ? translatorShareUrl(job.jobId) : job.videoUrl))}
                      className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                      <Share2 className="w-4 h-4" /> Share
                    </button>
                  )}
                </div>
              </motion.div>
            )}

            {(job?.status === "CANCELLED" || job?.status === "EXPIRED") && (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-sm text-white/60">
                {job.status === "CANCELLED" ? "Translation cancelled." : "Translation expired."}
              </div>
            )}

            {/* Transcript */}
            {showTranscript && transcript.length > 0 && (
              <TranscriptPanel segments={transcript} />
            )}
          </>
        )}

        {history.length > 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <History className="w-4 h-4 text-white/50" />
              <span className="text-sm font-semibold text-white/80">Translation History</span>
              <span className="text-xs text-white/30 ml-auto">{history.length}</span>
            </div>
            <div className="divide-y divide-white/[0.05]">
              {history.slice(0, 8).map((entry) => (
                <div key={entry.jobId} className="px-4 py-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Languages className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white/85 font-medium truncate">{entry.filename}</p>
                    <div className="flex items-center gap-1.5 text-xs text-white/35 mt-0.5">
                      <span>{entry.targetLang}</span>
                      {entry.segmentCount != null && <><span>{"\u00b7"}</span><span>{entry.segmentCount} segments</span></>}
                      <span>{"\u00b7"}</span>
                      <span>{formatRelative(entry.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => void openHistoryEntry(entry)}
                      className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                      title="Preview"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    {entry.videoUrl && (
                      <a
                        href={entry.videoUrl}
                        download={translatedVideoFilename(entry.filename, entry.targetLangCode)}
                        className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                        title="Download"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                    <button
                      onClick={() => shareUrl(entry.shareUrl ?? translatorShareUrl(entry.jobId))}
                      disabled={!entry.jobId}
                      className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                      title="Share"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => deleteHistoryEntry(entry.jobId)}
                      className="p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Temporary in-tab AI status assistant ───────────────────────────── */}
      <button
        onClick={() => setAiOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-gradient-to-br from-primary to-orange-400 text-white shadow-lg shadow-primary/30 hover:scale-105 active:scale-95 transition-transform"
        title="Ask AI about your translations"
      >
        <Sparkles className="w-5 h-5" />
        <span className="text-sm font-bold hidden sm:inline">Ask AI</span>
      </button>

      {aiOpen && (
        <div className="fixed bottom-20 right-5 z-40 w-[min(94vw,400px)] h-[min(76vh,580px)] flex flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-200 bg-white">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-orange-400 flex items-center justify-center shrink-0 shadow-sm shadow-primary/30">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-900 leading-none">Translation Assistant</p>
              <p className="text-[11px] text-slate-500 mt-1">Senior debugger · reads all jobs &amp; logs (read-only)</p>
            </div>
            <button
              onClick={() => setAiOpen(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div ref={aiScrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
            {aiMessages.length === 0 && (
              <div className="text-center text-slate-500 text-xs px-4 py-6 space-y-2">
                <div className="w-10 h-10 mx-auto rounded-xl bg-gradient-to-br from-primary to-orange-400 flex items-center justify-center shadow-sm shadow-primary/30">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <p className="text-slate-600">I'm your translation debugger. I can read every job's status, steps, warnings and errors — ask me anything.</p>
                <div className="flex flex-wrap gap-1.5 justify-center pt-1">
                  {["What's the status?", "Why did my last job fail?", "Did anything fail today?", "How do I fix the lip-sync error?"].map((s) => (
                    <button
                      key={s}
                      onClick={() => void askAi(s)}
                      className="px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:border-primary/40 hover:text-primary text-slate-600 text-[11px] transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {aiMessages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-3 py-2 text-sm break-words whitespace-pre-wrap bg-primary text-white shadow-sm">
                    {m.content}
                  </div>
                ) : (
                  <AssistantBubble m={m} />
                )}
              </div>
            ))}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); void askAi(aiInput); }}
            className="flex items-center gap-2 p-2.5 border-t border-slate-200 bg-white"
          >
            <input
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              placeholder="Ask about status, logs, errors…"
              className="flex-1 bg-slate-100 rounded-xl px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-primary/40 focus:bg-white transition-colors"
            />
            <button
              type="submit"
              disabled={aiBusy || !aiInput.trim()}
              className="p-2 rounded-xl bg-primary text-white disabled:opacity-40 transition-opacity hover:bg-orange-500"
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
