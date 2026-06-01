import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Loader2, CheckCircle, ChevronRight, ChevronDown,
  Download, Scissors, Sparkles, Captions, AlarmClock,
  UploadCloud, Shield, ListVideo, X, Trash2, History, Square, Copy, Check, RotateCcw, Link,
  ArrowLeft, Pencil, Share2, SquarePen, Plus, Paperclip, AudioLines, Menu, ArrowUp,
  ImagePlus, Music2, Terminal, Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { saveActiveDownload, loadActiveDownload, saveCompletedDownload } from "@/lib/download-history";
import { saveActiveJob, loadActiveJob, saveToHistory } from "@/lib/subtitle-history";
import { loadActiveClipJobs, saveActiveClipJobs, saveToClipHistory } from "@/lib/clip-history";
import { saveToMusicHistory } from "@/lib/music-history";
import { upsertActiveTranslatorJob } from "@/lib/translator-history";

const ULTRA_KEY = "studio-ultra-mode";
function readUltraInitial(): boolean {
  try { return localStorage.getItem(ULTRA_KEY) === "1"; } catch { return false; }
}

type ReasoningMode = "flash" | "pro" | "advanced";
const REASONING_OPTIONS: Array<{ id: ReasoningMode; label: string; description: string; ultra: boolean }> = [
  { id: "flash", label: "3.5 Flash", description: "Fast everyday responses", ultra: false },
  { id: "pro", label: "3.1 Pro", description: "Deeper video and creative work", ultra: true },
  { id: "advanced", label: "Advanced reasoning tasks", description: "Use extended reasoning for complex requests", ultra: true },
];

function readReasoningInitial(): ReasoningMode {
  return readUltraInitial() ? "pro" : "flash";
}

const HISTORY_KEY = "copilot-sessions-v2";

type ChatSession = { id: string; title: string; updatedAt: Date; messages: Message[] };

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as any[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(s => s && typeof s.id === "string" && Array.isArray(s.messages))
      .map(s => ({
        ...s,
        title: typeof s.title === "string" && s.title.trim() ? s.title : "New Chat",
        updatedAt: new Date(s.updatedAt || Date.now()),
        messages: s.messages
          .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && Array.isArray(m.parts))
          .map((m: any) => ({ ...m, timestamp: new Date(m.timestamp || Date.now()) })),
      }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  } catch { return []; }
}
// Strip heavy/ephemeral fields before persisting. Base64 image bytes (`data`)
// blow the ~5MB localStorage quota with just a couple of images — a thrown
// QuotaExceededError would silently drop ALL chat history. Blob `previewUrl`s
// are also dead after a reload, so we drop them and render a filename chip instead.
function slimSessionsForStorage(sessions: ChatSession[]): ChatSession[] {
  return sessions.slice(0, 30).map(s => ({
    ...s,
    messages: s.messages.map(m => ({
      ...m,
      parts: m.parts.map(p => {
        if (p.kind === "image") return { ...p, previewUrl: "" };
        if (p.kind === "attachment" && p.type === "image") {
          const { data: _data, ...rest } = p as any;
          return rest;
        }
        return p;
      }),
    })),
  }));
}

function saveSessions(sessions: ChatSession[]) {
  const slim = slimSessionsForStorage(sessions);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
  } catch {
    // Quota still exceeded (e.g. large text artifacts) — retry with fewer sessions.
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(slim.slice(0, 10))); } catch { }
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────
type SseEvent =
  | { type: "run_start"; runId: string; ts?: number }
  | { type: "thinking"; runId?: string; stage?: string; iteration?: number; total?: number }
  | { type: "heartbeat"; runId?: string; ts?: number }
  | { type: "text"; content: string; runId?: string }
  | { type: "text_delta"; content: string; runId?: string }
  | { type: "plan"; runId?: string; iteration?: number; steps: Array<{ tool: string; args: Record<string, any> }> }
  | { type: "tool_start"; runId?: string; toolId?: string; name: string; args: Record<string, any>; ts?: number }
  | { type: "tool_log"; runId?: string; toolId?: string; name: string; message: string; level?: "info" | "error" | "warn" }
  | { type: "tool_progress"; runId?: string; toolId?: string; name: string; status?: string; percent?: number | null; message?: string; jobId?: string }
  | { type: "tool_done"; runId?: string; toolId?: string; name: string; result: any; ts?: number }
  | { type: "navigate"; tab: string }
  | { type: "artifact"; runId?: string; toolId?: string; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; imageUrl?: string; audioUrl?: string; content?: string }
  | { type: "canvas_start"; runId?: string; canvasId: string; label: string; language?: string }
  | { type: "canvas_delta"; runId?: string; canvasId: string; content: string }
  | { type: "canvas_done"; runId?: string; canvasId: string }
  | { type: "thought_delta"; content: string; runId?: string }
  | { type: "suggestions"; items: string[]; runId?: string }
  | { type: "grounding_sources"; runId?: string; chunks: Array<{ title: string; uri: string }>; searchEntryPoint?: string | null }
  | { type: "error"; message: string }
  | { type: "done"; runId?: string; ts?: number };

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "image"; previewUrl: string; name: string }
  | { kind: "attachment"; type: string; name: string; mimeType: string; data?: string; url?: string }
  | { kind: "plan"; steps: Array<{ tool: string; args: Record<string, any> }>; iteration?: number }
  | { kind: "tool_start"; toolId?: string; name: string; args: Record<string, any>; done?: boolean; cancelled?: boolean; result?: any; progress?: number | null; progressMsg?: string }
  | { kind: "artifact"; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; imageUrl?: string; audioUrl?: string; content?: string; language?: string; canvasId?: string; live?: boolean };

type GroundingSource = { title: string; uri: string };
type Message = { id: string; role: "user" | "assistant"; parts: MessagePart[]; timestamp: Date; groundingSources?: GroundingSource[]; searchEntryPoint?: string | null };

// ── Meta ──────────────────────────────────────────────────────────────────────
const TOOL_META: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  get_video_info: { icon: <Bot className="w-3.5 h-3.5" />, label: "Fetching info", color: "text-blue-400" },
  download_video: { icon: <Download className="w-3.5 h-3.5" />, label: "Downloading video", color: "text-green-400" },
  cut_video_clip: { icon: <Scissors className="w-3.5 h-3.5" />, label: "Cutting clip", color: "text-yellow-400" },
  find_best_clips: { icon: <Sparkles className="w-3.5 h-3.5" />, label: "Finding best clips", color: "text-purple-400" },
  generate_subtitles: { icon: <Captions className="w-3.5 h-3.5" />, label: "Generating subtitles", color: "text-teal-400" },
  generate_timestamps: { icon: <AlarmClock className="w-3.5 h-3.5" />, label: "Timestamps", color: "text-orange-400" },
  list_shared_files: { icon: <UploadCloud className="w-3.5 h-3.5" />, label: "Shared files", color: "text-pink-400" },
  navigate_to_tab: { icon: <ChevronRight className="w-3.5 h-3.5" />, label: "Navigating", color: "text-white/60" },
  web_search: { icon: <span className="text-[13px]">🔍</span>, label: "Searching the web", color: "text-sky-400" },
  translate_video: { icon: <span className="text-[13px]">🎙️</span>, label: "Translating video", color: "text-violet-400" },
  create_image: { icon: <ImagePlus className="w-3.5 h-3.5" />, label: "Creating image", color: "text-pink-400" },
  enhance_image: { icon: <Sparkles className="w-3.5 h-3.5" />, label: "Enhancing image", color: "text-cyan-400" },
  edit_image: { icon: <Pencil className="w-3.5 h-3.5" />, label: "Editing image", color: "text-fuchsia-400" },
  describe_image: { icon: <Bot className="w-3.5 h-3.5" />, label: "Inspecting image", color: "text-indigo-400" },
  extract_text_from_image: { icon: <Captions className="w-3.5 h-3.5" />, label: "Reading image text", color: "text-teal-400" },
  write_video_script: { icon: <SquarePen className="w-3.5 h-3.5" />, label: "Writing script", color: "text-amber-400" },
  generate_seo_pack: { icon: <Sparkles className="w-3.5 h-3.5" />, label: "SEO pack", color: "text-lime-400" },
  generate_music: { icon: <Music2 className="w-3.5 h-3.5" />, label: "Composing music", color: "text-purple-400" },
  do_full_package: { icon: <Sparkles className="w-3.5 h-3.5" />, label: "Full package", color: "text-purple-300" },
  repeat_last_artifact: { icon: <Download className="w-3.5 h-3.5" />, label: "Restoring result", color: "text-green-400" },
  check_active_jobs: { icon: <Loader2 className="w-3.5 h-3.5" />, label: "Checking jobs", color: "text-blue-300" },
  cancel_active_jobs: { icon: <X className="w-3.5 h-3.5" />, label: "Cancelling jobs", color: "text-red-400" },
  send_result_to_tab: { icon: <ChevronRight className="w-3.5 h-3.5" />, label: "Opening tab", color: "text-white/60" },
  read_uploaded_file: { icon: <Paperclip className="w-3.5 h-3.5" />, label: "Reading file", color: "text-sky-300" },
  convert_subtitles: { icon: <Captions className="w-3.5 h-3.5" />, label: "Converting subtitles", color: "text-teal-300" },
  compare_subtitles: { icon: <Captions className="w-3.5 h-3.5" />, label: "Comparing subtitles", color: "text-cyan-300" },
  export_text_file: { icon: <Download className="w-3.5 h-3.5" />, label: "Exporting file", color: "text-emerald-300" },
  run_code_analysis: { icon: <Terminal className="w-3.5 h-3.5" />, label: "Code analysis", color: "text-orange-300" },
  run_sandbox_command: { icon: <Terminal className="w-3.5 h-3.5" />, label: "Sandbox", color: "text-emerald-300" },
  sandbox_status: { icon: <Terminal className="w-3.5 h-3.5" />, label: "Sandbox status", color: "text-sky-300" },
  reset_sandbox: { icon: <X className="w-3.5 h-3.5" />, label: "Resetting sandbox", color: "text-red-300" },
  get_youtube_captions: { icon: <Captions className="w-3.5 h-3.5" />, label: "Getting captions", color: "text-teal-400" },
  fix_subtitles: { icon: <Captions className="w-3.5 h-3.5" />, label: "Fixing subtitles", color: "text-amber-400" },
  cancel_job: { icon: <X className="w-3.5 h-3.5" />, label: "Cancelling job", color: "text-red-400" },
  check_job_status: { icon: <Loader2 className="w-3.5 h-3.5" />, label: "Checking status", color: "text-white/60" },
  analyze_youtube_video: { icon: <span className="text-[13px]">👁️</span>, label: "Watching video", color: "text-fuchsia-400" },
};
const TAB_ICONS: Record<string, React.ReactNode> = {
  download: <Download className="w-3.5 h-3.5" />, clips: <Sparkles className="w-3.5 h-3.5" />,
  subtitles: <Captions className="w-3.5 h-3.5" />, clipcutter: <Scissors className="w-3.5 h-3.5" />,
  bhagwat: <Shield className="w-3.5 h-3.5" />, scenefinder: <ListVideo className="w-3.5 h-3.5" />,
  timestamps: <AlarmClock className="w-3.5 h-3.5" />, upload: <UploadCloud className="w-3.5 h-3.5" />,
};
const STARTERS = [
  { icon: <Scissors className="w-4 h-4" />, text: "Cut a clip from a YouTube video" },
  { icon: <Sparkles className="w-4 h-4" />, text: "Find the best clips from a YouTube video" },
  { icon: <Captions className="w-4 h-4" />, text: "Generate subtitles for a YouTube video" },
  { icon: <AlarmClock className="w-4 h-4" />, text: "Create chapter timestamps for a video" },
  { icon: <Download className="w-4 h-4" />, text: "Download a YouTube video in 1080p" },
  { icon: <Bot className="w-4 h-4" />, text: "What can you do?" },
];

// ── Client-side tag stripper ──────────────────────────────────────────────────
function clientStripTags(text: string): string {
  return text
    .replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, "")
    .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, "")
    .replace(/\[\/?RESPONSE\]/gi, "")
    .replace(/^\[JUDGE\].*$/gim, "")
    .replace(/^\[PLAN\].*$/gim, "")
    .replace(/^\[EXECUTE\].*$/gim, "")
    .replace(/^\[SAY\].*$/gim, "")
    .replace(/^\[WAIT\].*$/gim, "")
    .replace(/^\[TOOL\].*$/gim, "")
    .replace(/\[SUGGESTIONS:[^\]]*\]/gi, "")
    .replace(/\[SUGOESTIONS:[^\]]*\]/gi, "")
    // Strip leaked tool result markers [Tool: name | Args: ... | Result: ...]
    .replace(/\[Tool:\s*\w+\s*\|[^\]]*\]/gi, "")
    // Strip leaked artifact markers [TextArtifact: ...] and [Artifact: ...]
    .replace(/\[TextArtifact:[^\]]*\][^\[]*/gi, "")
    .replace(/\[Artifact:[^\]]*\]/gi, "")
    // Strip leaked tool result JSON — "| Result: {...}"
    .replace(/\|\s*Result:\s*\{[^}]*\}/gi, "")
    // Strip leaked URL-field JSON objects (covers empty and non-empty values)
    .replace(/\{(?:\s*"\w+(?:Url|url)"\s*:\s*"[^"]*"\s*,?\s*)+\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


// ── Markdown renderer ──────────────────────────────────────────────────────────
function renderMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  lines.forEach((line, li) => {
    const olMatch = /^(\d+)\.\s+(.*)/.exec(line);
    const ulMatch = /^[-*]\s+(.*)/.exec(line);
    const inline = (str: string, key: string): React.ReactNode => {
      const parts: React.ReactNode[] = [];
      // Match bold, code, and citation [N] patterns
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g;
      let last = 0; let m; let k = 0;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) parts.push(<span key={`${key}-t${k++}`}>{str.slice(last, m.index)}</span>);
        const tok = m[0];
        if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${k++}`}>{tok.slice(2, -2)}</strong>);
        else if (tok.startsWith("`")) parts.push(<code key={`${key}-c${k++}`}>{tok.slice(1, -1)}</code>);
        else {
          // Citation [N]
          const idx = parseInt(tok.slice(1, -1), 10) - 1;
          const src = sources?.[idx];
          parts.push(src
            ? <a key={`${key}-ref${k++}`} href={src.uri} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-4 h-4 text-[9px] font-semibold rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors align-super leading-none mx-0.5 no-underline"
                title={src.title}>{idx + 1}</a>
            : <span key={`${key}-ref${k++}`} className="text-white/40 text-[9px] align-super">{tok}</span>
          );
        }
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

// ── Streaming markdown renderer — keeps markdown formatting, animates trailing words ──
function renderStreamingMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  const ANIMATE_WINDOW = 80; // animate last N graphemes of the final line

  const splitGraphemes = (value: string): string[] => {
    try {
      const SegmenterCtor = (Intl as any).Segmenter;
      if (SegmenterCtor) {
        const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" });
        return Array.from(segmenter.segment(value), (entry: any) => entry.segment);
      }
    } catch { /* fallback below */ }
    return Array.from(value);
  };

  // Inline parser that can optionally animate trailing tokens
  const inlineAnimated = (str: string, key: string, animateTrailing: boolean): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g;
    let last = 0; let m; let k = 0;
    // First pass: parse markdown into segments
    const segments: Array<{ text: string; type: "plain" | "bold" | "code" | "cite" }> = [];
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) segments.push({ text: str.slice(last, m.index), type: "plain" });
      const tok = m[0];
      if (tok.startsWith("**")) segments.push({ text: tok.slice(2, -2), type: "bold" });
      else if (tok.startsWith("`")) segments.push({ text: tok.slice(1, -1), type: "code" });
      else segments.push({ text: tok, type: "cite" });
      last = m.index + tok.length;
    }
    if (last < str.length) segments.push({ text: str.slice(last), type: "plain" });

    if (!animateTrailing) {
      // Static render — same as renderMd
      for (const seg of segments) {
        if (seg.type === "bold") parts.push(<strong key={`${key}-b${k++}`}>{seg.text}</strong>);
        else if (seg.type === "code") parts.push(<code key={`${key}-c${k++}`}>{seg.text}</code>);
        else if (seg.type === "cite") {
          const idx = parseInt(seg.text.slice(1, -1), 10) - 1;
          const src = sources?.[idx];
          parts.push(src
            ? <a key={`${key}-ref${k++}`} href={src.uri} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-4 h-4 text-[9px] font-semibold rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors align-super leading-none mx-0.5 no-underline"
                title={src.title}>{idx + 1}</a>
            : <span key={`${key}-ref${k++}`} className="text-white/40 text-[9px] align-super">{seg.text}</span>
          );
        } else parts.push(<span key={`${key}-t${k++}`}>{seg.text}</span>);
      }
      return parts;
    }

    // Animated render — split all text into graphemes for a smoother typewriter feel.
    // cite segments are rendered as static superscripts inline with the animated chars.
    const allChars: Array<{ char: string; type: "plain" | "bold" | "code" | "cite_node"; node?: React.ReactNode }> = [];
    for (const seg of segments) {
      if (seg.type === "cite") {
        // Render citation as a single non-animated node entry
        const idx = parseInt(seg.text.slice(1, -1), 10) - 1;
        const src = sources?.[idx];
        const node = src
          ? <a key={`cite-${k++}`} href={src.uri} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center justify-center w-4 h-4 text-[9px] font-semibold rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors align-super leading-none mx-0.5 no-underline"
               title={src.title}>{idx + 1}</a>
          : <span key={`cite-${k++}`} className="text-white/40 text-[9px] align-super">{seg.text}</span>;
        allChars.push({ char: "", type: "cite_node", node });
        continue;
      }
      const chars = splitGraphemes(seg.text);
      for (const ch of chars) {
        if (ch) allChars.push({ char: ch, type: seg.type as "plain" | "bold" | "code" });
      }
    }

    const animStart = Math.max(0, allChars.length - ANIMATE_WINDOW);
    for (let i = 0; i < allChars.length; i++) {
      const { char, type } = allChars[i];
      const shouldAnimate = i >= animStart;
      const cls = shouldAnimate ? "stream-token" : undefined;
      const delay = shouldAnimate ? { animationDelay: `${Math.min((i - animStart) * 8, 420)}ms` } : undefined;

      if (type === "cite_node") {
        parts.push((allChars[i] as any).node as React.ReactNode);
      } else if (type === "bold") {
        parts.push(<strong key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</strong>);
      } else if (type === "code") {
        parts.push(<code key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</code>);
      } else {
        parts.push(<span key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</span>);
      }
    }
    return parts;
  };

  const lastNonEmptyIdx = lines.length - 1 - [...lines].reverse().findIndex(l => l.trim() !== "");

  lines.forEach((line, li) => {
    const isLastLine = li === lastNonEmptyIdx;
    const olMatch = /^(\d+)\.\s+(.*)/.exec(line);
    const ulMatch = /^[-*]\s+(.*)/.exec(line);

    if (olMatch) {
      result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/40 shrink-0">{olMatch[1]}.</span><span>{inlineAnimated(olMatch[2], `ol${li}`, isLastLine)}</span></div>);
    } else if (ulMatch) {
      result.push(<div key={li} className="flex gap-2 ml-1"><span className="text-white/30 shrink-0">•</span><span>{inlineAnimated(ulMatch[1], `ul${li}`, isLastLine)}</span></div>);
    } else if (line.trim() === "") {
      if (li < lines.length - 1) result.push(<div key={li} className="h-2" />);
    } else {
      result.push(<div key={li}>{inlineAnimated(line, `ln${li}`, isLastLine)}</div>);
    }
  });

  // Blinking cursor at the end
  result.push(<span key="cursor" className="stream-cursor" />);

  return result;
}

type CanvasCandidate = {
  label: string;
  language: string;
  content: string;
  displayText: string;
  live: boolean;
};

const CANVAS_LANGUAGE_EXT: Record<string, string> = {
  html: "html",
  css: "css",
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  json: "json",
  markdown: "md",
  md: "md",
  text: "txt",
  txt: "txt",
  srt: "srt",
  vtt: "vtt",
};

function normalizeCanvasLanguage(language?: string, content?: string): string {
  const clean = String(language || "").trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, "");
  if (clean) return clean;
  const sample = String(content || "").slice(0, 500).toLowerCase();
  if (sample.includes("<!doctype html") || sample.includes("<html")) return "html";
  if (/^\s*[{[]/.test(sample)) return "json";
  return "text";
}

function canvasFilename(language: string): string {
  const ext = CANVAS_LANGUAGE_EXT[language] || "txt";
  return `agent-canvas.${ext}`;
}

function isHtmlCanvas(language: string, content: string): boolean {
  const lang = normalizeCanvasLanguage(language, content);
  return lang === "html" || /<!doctype html|<html[\s>]/i.test(content);
}

function extractCanvasCandidate(text: string): CanvasCandidate | null {
  const closed = Array.from(text.matchAll(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*?)```/g));
  let match: RegExpMatchArray | null = null;
  let live = false;

  if (closed.length > 0) {
    match = closed.reduce((best, item) => (item[2].length > best[2].length ? item : best), closed[0]);
  } else {
    const open = text.match(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*)$/);
    if (open) {
      match = open;
      live = true;
    }
  }

  if (!match) return null;
  const content = (match[2] || "").trim();
  if (content.length < 40 && !isHtmlCanvas(match[1] || "", content)) return null;
  const language = normalizeCanvasLanguage(match[1], content);
  const displayText = text
    .replace(match[0], live ? "\n\nWriting in canvas..." : "\n\nCanvas created below.")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    label: canvasFilename(language),
    language,
    content,
    displayText,
    live,
  };
}
// ── ToolCard ──────────────────────────────────────────────────────────────────
function ToolCard({ part }: { part: MessagePart & { kind: "tool_start" } }) {
  const meta = TOOL_META[part.name] ?? { icon: <Bot className="w-3.5 h-3.5" />, label: part.name, color: "text-white/60" };
  const pct = part.progress;
  const hasProgress = pct !== null && pct !== undefined;
  const argStr = Object.entries(part.args).filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).length > 40 ? String(v).slice(0, 37) + "..." : v}`).join("  ·  ");
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
            ? (part.cancelled
                ? <X className="w-3.5 h-3.5 text-white/40" />
                : <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />)
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
      {part.done && part.cancelled && (
        <div className="agent-tool-live-msg">
          <span className="agent-tool-live-text text-white/40">Stopped</span>
        </div>
      )}
      {!part.done && (
        <div className="agent-tool-progress-track">
          <div className="agent-tool-progress-fill" style={{ width: hasProgress ? `${Math.max(3, pct!)}%` : "0%", transition: hasProgress ? "width 0.6s ease" : "none" }} />
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
              {s.args.url && <span className="agent-plan-step-arg">{String(s.args.url).length > 42 ? String(s.args.url).slice(0, 39) + "..." : s.args.url}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TextArtifact (own component so useState is always at top level) ───────────
function TextArtifact({ label, content, downloadUrl, language, live }: { label: string; content: string; downloadUrl?: string; language?: string; live?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"code" | "preview">("code");
  const normalizedLanguage = normalizeCanvasLanguage(language, content);
  const canPreview = isHtmlCanvas(normalizedLanguage, content);
  const copyText = () => { void navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const downloadName = label || canvasFilename(normalizedLanguage);
  const artifactUrl = React.useMemo(
    () => downloadUrl || `data:${canPreview ? "text/html" : "text/plain"};charset=utf-8,${encodeURIComponent(content)}`,
    [canPreview, content, downloadUrl],
  );
  const preview = content.length > 3200 ? `${content.slice(0, 3200)}\n\n...` : content;
  return (
    <>
      <div className="agent-artifact-card agent-artifact-text rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/10 via-white/[0.045] to-emerald-400/8 overflow-hidden shadow-[0_16px_60px_rgba(8,145,178,0.10)]">
        <div className="flex items-start gap-3 px-3 py-3 border-b border-white/8">
          <div className="mt-0.5 p-2 rounded-xl bg-cyan-400/12 border border-cyan-300/15">
            <SquarePen className="w-4 h-4 text-cyan-200" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-cyan-100 truncate">{label}</p>
            <p className="text-[11px] text-white/40 mt-0.5">{content.length.toLocaleString()} chars - {live ? "writing live" : "canvas ready"}{canPreview ? " - preview supported" : ""}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {canPreview && (
              <button onClick={() => { setView("preview"); setOpen(true); }} className="hidden sm:inline-flex text-[11px] text-emerald-100 hover:text-white px-2.5 py-1.5 rounded-lg bg-emerald-500/14 hover:bg-emerald-500/22 border border-emerald-300/15 font-semibold">Preview</button>
            )}
            <button onClick={() => setOpen(true)} className="text-[11px] text-cyan-100 hover:text-white px-2.5 py-1.5 rounded-lg bg-cyan-400/14 hover:bg-cyan-400/22 border border-cyan-300/15 font-semibold">Open canvas</button>
            <button onClick={copyText} title="Copy" className="p-1.5 rounded-lg bg-white/6 hover:bg-white/10 text-white/55 hover:text-white">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <a href={artifactUrl} download={downloadName} title="Download" className="p-1.5 rounded-lg bg-white/6 hover:bg-white/10 text-white/55 hover:text-white">
              <Download className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
        <pre className="text-xs text-white/70 font-mono p-3 overflow-x-auto max-h-56 whitespace-pre-wrap bg-black/20">{preview}</pre>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-black/72 backdrop-blur-md flex items-center justify-center p-3 sm:p-6"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              className="w-full max-w-6xl h-[86vh] rounded-3xl border border-white/12 bg-[#080d10] shadow-2xl overflow-hidden flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-white/[0.035]">
                <div className="p-2 rounded-xl bg-cyan-400/12 border border-cyan-300/15">
                  <SquarePen className="w-4 h-4 text-cyan-200" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-white truncate">{label}</p>
                  <p className="text-[11px] text-white/40">Agent canvas - {live ? "live writing, " : ""}preview, copy, download</p>
                </div>
                {canPreview && (
                  <div className="hidden sm:flex items-center gap-1 p-1 rounded-xl bg-white/6 border border-white/8">
                    <button onClick={() => setView("code")} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold", view === "code" ? "bg-cyan-400/18 text-cyan-100" : "text-white/55 hover:text-white")}>
                      <Terminal className="w-3.5 h-3.5" /> Code
                    </button>
                    <button onClick={() => setView("preview")} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold", view === "preview" ? "bg-emerald-500/18 text-emerald-100" : "text-white/55 hover:text-white")}>
                      <Eye className="w-3.5 h-3.5" /> Preview
                    </button>
                  </div>
                )}
                <button onClick={copyText} className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl bg-white/7 hover:bg-white/12 text-xs font-semibold text-white/75">
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />} {copied ? "Copied" : "Copy"}
                </button>
                <a href={artifactUrl} download={downloadName} className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/18 hover:bg-emerald-500/25 text-xs font-semibold text-emerald-100 border border-emerald-300/15">
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
                <button onClick={() => setOpen(false)} className="p-2 rounded-xl bg-white/7 hover:bg-white/12 text-white/60 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {canPreview && view === "preview" ? (
                <iframe
                  title={downloadName}
                  sandbox="allow-scripts allow-forms allow-popups allow-modals"
                  srcDoc={content}
                  className="flex-1 w-full bg-white"
                />
              ) : (
                <pre className="flex-1 overflow-auto p-4 sm:p-5 text-[12px] leading-relaxed text-cyan-50/82 font-mono whitespace-pre-wrap bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.10),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.025),rgba(0,0,0,0.18))]">{content}</pre>
              )}
              <div className="sm:hidden grid grid-cols-2 gap-2 p-3 border-t border-white/10 bg-white/[0.035]">
                <button onClick={copyText} className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-white/8 text-xs font-semibold text-white/75">
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />} {copied ? "Copied" : "Copy"}
                </button>
                <a href={artifactUrl} download={downloadName} className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/20 text-xs font-semibold text-emerald-100">
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ── Music share helper ────────────────────────────────────────────────────────
const BASE_URL = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

function MusicArtifactCard({ part }: { part: MessagePart & { kind: "artifact" } }) {
  const [shareState, setShareState] = useState<"idle" | "loading" | "copied">("idle");
  const { toast } = useToast();

  const handleDownload = async () => {
    const url = part.downloadUrl ?? part.audioUrl ?? "";
    const filename = (part.label ?? "music").replace(/[^a-zA-Z0-9\s\-_]/g, "").replace(/\s+/g, "_").slice(0, 80) + ".mp3";
    if (!url) return;
    // data: URLs work with <a download> directly; HTTPS S3 URLs are cross-origin
    // so the download attribute is silently ignored — use fetch→blob instead.
    if (url.startsWith("data:")) {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      return;
    }
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Download failed: ${r.status}`);
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 5000);
    } catch {
      window.open(url, "_blank");
    }
  };

  const handleShare = async () => {
    setShareState("loading");
    try {
      const res = await fetch(`${BASE_URL}/api/agent/music-share`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioUrl: part.audioUrl, imageUrl: part.imageUrl, title: part.label }),
      });
      if (!res.ok) throw new Error("Share failed");
      const { shareUrl } = await res.json() as { shareUrl: string };
      await navigator.clipboard.writeText(shareUrl);
      setShareState("copied");
      toast({ title: "Share link copied!", description: "Anyone with the link can listen." });
      setTimeout(() => setShareState("idle"), 3000);
    } catch {
      setShareState("idle");
      toast({ title: "Share failed", description: "Could not create share link.", variant: "destructive" });
    }
  };

  return (
    <div className="agent-artifact-card agent-artifact-music rounded-2xl border border-purple-500/25 bg-purple-500/8 overflow-hidden">
      {part.imageUrl && (
        <div className="p-3 pb-0">
          <img src={part.imageUrl} alt={part.label}
            className="w-full max-h-[220px] object-cover rounded-xl border border-white/10 bg-black/20" />
        </div>
      )}
      <div className="px-3 pt-3 pb-1">
        <audio controls src={part.audioUrl} className="w-full h-9 rounded-lg accent-purple-400" style={{ colorScheme: "dark" }} />
      </div>
      <div className="px-4 pb-3 flex items-center gap-2 mt-1">
        <div className="p-1.5 rounded-lg bg-purple-500/15 shrink-0"><Music2 className="w-4 h-4 text-purple-300" /></div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-purple-200 truncate">{part.label}</p>
          {part.content && <p className="text-xs text-white/45 truncate mt-0.5">{part.content}</p>}
        </div>
        <button
          onClick={handleShare}
          disabled={shareState === "loading"}
          className="shrink-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl font-bold text-xs text-white/70 bg-white/8 hover:bg-white/12 border border-white/10 transition-colors disabled:opacity-50"
          title="Copy share link"
        >
          {shareState === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
           shareState === "copied" ? <Check className="w-3.5 h-3.5 text-emerald-400" /> :
           <Share2 className="w-3.5 h-3.5" />}
          {shareState === "copied" ? "Copied!" : "Share"}
        </button>
        <button
          onClick={handleDownload}
          className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 rounded-xl font-bold text-xs text-white bg-purple-600 hover:bg-purple-500 transition-colors">
          <Download className="w-4 h-4" /> Download
        </button>
      </div>
    </div>
  );
}

// ── ArtifactCard ──────────────────────────────────────────────────────────────
function ArtifactCard({ part, onNavigate }: { part: MessagePart & { kind: "artifact" }; onNavigate?: (tab: string) => void }) {
  if (part.artifactType === "image" && part.imageUrl) {
    return (
      <div className="agent-artifact-card agent-artifact-image rounded-2xl border border-pink-500/25 bg-pink-500/8 overflow-hidden">
        <div className="p-3">
          <img src={part.imageUrl} alt={part.label} className="w-full max-h-[360px] object-contain rounded-xl border border-white/10 bg-black/20" />
        </div>
        <div className="px-4 pb-3 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-pink-200 truncate">{part.label}</p>
            {part.content && <p className="text-xs text-white/45 truncate mt-0.5">{part.content}</p>}
          </div>
          <a href={part.downloadUrl ?? part.imageUrl} download className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 rounded-xl font-bold text-xs text-white bg-pink-600 hover:bg-pink-500 transition-colors">
            <Download className="w-4 h-4" /> Download
          </a>
        </div>
      </div>
    );
  }
  if (part.artifactType === "download" && part.downloadUrl) {
    return (
      <div className="agent-artifact-card agent-artifact-download rounded-2xl border border-green-500/25 bg-green-500/8 overflow-hidden">
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
  if (part.artifactType === "audio" && part.audioUrl) {
    return <MusicArtifactCard part={part} />;
  }
  if (part.artifactType === "text" && (part.content || part.live)) {
    return <TextArtifact label={part.label} content={part.content ?? ""} downloadUrl={part.downloadUrl} language={part.language} live={part.live} />;
  }
  return (
    <div className="agent-artifact-card rounded-xl border border-primary/30 bg-primary/8 px-3 py-2.5 flex items-center gap-3">
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
    <button onClick={copy} title="Copy" className="gs-message-action-btn">
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function MessageBubble({ message, onNavigate, onRetry, isStreaming }: { message: Message; onNavigate?: (tab: string) => void; onRetry?: () => void; isStreaming?: boolean }) {
  const isUser = message.role === "user";
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
      className={cn("gs-message-row", isUser ? "gs-message-row-user" : "gs-message-row-assistant")}>
      <div className={cn("gs-message-stack", isUser ? "gs-message-stack-user" : "gs-message-stack-assistant")}>
        {message.parts.map((part, i) => {
          // Image thumbnail in user message
          if (part.kind === "image") {
            const previewUrl = (part as any).previewUrl as string | undefined;
            const name = (part as any).name as string | undefined;
            // After a reload the blob: previewUrl is gone — show a filename chip instead of a broken image
            if (!previewUrl) {
              return (
                <div key={i} className="flex items-center gap-1.5 bg-white/10 border border-white/15 rounded-lg px-2 py-1 text-xs text-white/70 max-w-[200px]">
                  <ImagePlus className="w-3.5 h-3.5 text-white/40 shrink-0" />
                  <span className="truncate">{name || "image"}</span>
                </div>
              );
            }
            return (
              <div key={i} className="gs-message-image">
                <img src={previewUrl} alt={name} />
              </div>
            );
          }
          if (part.kind === "text" && part.content.trim()) {
            // Strip internal model tags on the client side as a safety net
            const cleanContent = clientStripTags(part.content);
            if (!cleanContent.trim()) return null;
            const isErrorMsg = !isUser && cleanContent.startsWith("⚠️");
            // Determine if this is the last text part being actively streamed
            const textPartIndexes = message.parts.map((p, idx) => p.kind === "text" ? idx : -1).filter(idx => idx >= 0);
            const isLastTextPart = !isUser && isStreaming && i === textPartIndexes[textPartIndexes.length - 1];
            const canvas = !isUser ? extractCanvasCandidate(cleanContent) : null;
            const visibleText = canvas?.displayText || cleanContent;
            return (
              <React.Fragment key={i}>
                {visibleText.trim() && (
                  <div className={cn(
                    "gs-message-text",
                    isUser ? "gs-message-text-user" : "gs-message-text-assistant copilot-md",
                    isErrorMsg && "gs-message-text-error",
                  )}>
                    {isUser ? cleanContent : (isLastTextPart ? renderStreamingMd(visibleText, message.groundingSources) : renderMd(visibleText, message.groundingSources))}
                    {/* Copy button — assistant messages only, hover-reveal */}
                    {!isUser && (
                      <div className="gs-message-actions">
                        <CopyBubble text={part.content} />
                        {/* Retry button on error messages */}
                        {isErrorMsg && onRetry && (
                          <button onClick={onRetry} title="Retry" className="gs-message-action-btn">
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {canvas && (
                  <TextArtifact
                    label={canvas.label}
                    content={canvas.content}
                    language={canvas.language}
                    live={isLastTextPart && canvas.live}
                  />
                )}
              </React.Fragment>
            );
          }
          if (part.kind === "tool_start") return <ToolCard key={i} part={part} />;
          if (part.kind === "plan") return null; // Plan is internal — tool cards already show what's executing
          if (part.kind === "artifact") return <ArtifactCard key={i} part={part} onNavigate={onNavigate} />;
          return null;
        })}
        {/* Grounding sources — shown when Gemini native Google Search grounding was used */}
        {!isUser && message.groundingSources && message.groundingSources.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-1">
            {message.searchEntryPoint && (
              <div className="text-[10px] text-white/30 px-1" dangerouslySetInnerHTML={{ __html: message.searchEntryPoint }} />
            )}
            <div className="flex flex-wrap gap-1.5">
              {message.groundingSources.map((src, si) => (
                <a key={si} href={src.uri} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.08] hover:border-white/[0.12] transition-colors text-[10px] text-white/50 hover:text-white/80 no-underline max-w-[200px]">
                  <span className="shrink-0 text-white/30 font-medium">[{si + 1}]</span>
                  <span className="truncate">{src.title || (() => { try { return new URL(src.uri).hostname; } catch { return src.uri.slice(0, 40); } })()}</span>
                </a>
              ))}
            </div>
          </div>
        )}
        {message.parts.some(p => p.kind === "text" ? (p as any).content?.trim() : true) && (
          <span className="sr-only">{message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        )}
      </div>
    </motion.div>
  );
}

// ── Error Boundary ───────────────────────────────────────────────────────────
class CopilotErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset?: () => void },
  { hasError: boolean; error?: Error }
> {
  state = { hasError: false, error: undefined as Error | undefined };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="copilot-wrap flex items-center justify-center">
          <div className="text-center px-6 py-8 max-w-sm">
            <p className="text-white/80 text-sm font-semibold mb-2">Something went wrong</p>
            <p className="text-white/40 text-xs mb-4">{this.state.error?.message ?? "An unexpected error occurred"}</p>
            <button
              onClick={() => { this.setState({ hasError: false, error: undefined }); this.props.onReset?.(); }}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-xs font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
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
  const [agentStage, setAgentStage] = useState<"idle" | "planning" | "executing" | "verifying">("idle");
  const [agentIteration, setAgentIteration] = useState(0);
  const [thoughtText, setThoughtText] = useState("");
  const [showThoughts, setShowThoughts] = useState(false);
  const [activeToolLabel, setActiveToolLabel] = useState<string | null>(null);
  const [thoughtLabel, setThoughtLabel] = useState<string | null>(null);
  const [pasteUrl, setPasteUrl] = useState<string | null>(null);
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>(readReasoningInitial);
  const activeReasoning = REASONING_OPTIONS.find(option => option.id === reasoningMode) ?? REASONING_OPTIONS[0];
  const ultra = activeReasoning.ultra;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // ── Skills ──
  type SkillMeta = { id: string; name: string; description: string; icon: string; category: string; starters?: string[]; tags?: string[] };
  const [availableSkills, setAvailableSkills] = useState<SkillMeta[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const activeSkillsRef = useRef<string[]>([]);
  useEffect(() => {
    activeSkillsRef.current = activeSkills;
  }, [activeSkills]);
  // Slash command state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const [showReasoningMenu, setShowReasoningMenu] = useState(false);
  const reasoningMenuRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  useEffect(() => {
    try { localStorage.setItem(ULTRA_KEY, ultra ? "1" : "0"); } catch { }
  }, [ultra]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userIsNearBottom = useRef(true);
  const thoughtContentRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!showReasoningMenu) return;
    const handler = (e: MouseEvent) => {
      if (reasoningMenuRef.current && !reasoningMenuRef.current.contains(e.target as Node)) {
        setShowReasoningMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showReasoningMenu]);

  // Fetch available skills on mount
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/agent/skills`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.skills) setAvailableSkills(d.skills); })
      .catch(() => {});
  }, []);
  // Click-outside for slash menu
  useEffect(() => {
    if (!showSlashMenu) return;
    const handler = (e: MouseEvent) => {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) setShowSlashMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSlashMenu]);

  // Filtered skills for slash menu
  const slashFilteredSkills = availableSkills.filter(s =>
    !slashQuery || s.name.toLowerCase().includes(slashQuery.toLowerCase()) || s.id.toLowerCase().includes(slashQuery.toLowerCase())
  );

  // Handle slash command detection in input
  const handleSlashInput = useCallback((value: string) => {
    // Check if input starts with / (slash command trigger)
    const slashMatch = value.match(/^\/(\S*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setShowSlashMenu(true);
      setSlashMenuIndex(0);
    } else {
      setShowSlashMenu(false);
      setSlashQuery("");
    }
  }, []);

  // Select a skill from the slash menu
  const selectSlashSkill = useCallback((skill: SkillMeta) => {
    const current = activeSkillsRef.current;
    const next = current.includes(skill.id) ? current.filter(s => s !== skill.id) : [...current, skill.id];
    activeSkillsRef.current = next;
    setActiveSkills(next);
    setInput("");
    setShowSlashMenu(false);
    setSlashQuery("");
  }, []);

  // Remove an active skill chip
  const removeActiveSkill = useCallback((skillId: string) => {
    const next = activeSkillsRef.current.filter(s => s !== skillId);
    activeSkillsRef.current = next;
    setActiveSkills(next);
  }, []);

  const [pendingAttachments, setPendingAttachments] = useState<Array<{
    type: "image" | "video" | "audio" | "document";
    name: string;
    mimeType: string;
    data?: string;   // base64 for images (no data: prefix)
    url?: string;    // S3 URL for video/audio/docs
    previewUrl?: string; // object URL for image preview chip
  }>>([]);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
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
  const streamingAssistantIdRef = useRef<string | null>(null);
  const lastUserTextRef = useRef<string>("");
  const lastUserAttachmentsRef = useRef<Array<{ type: string; name: string; mimeType: string; data?: string; url?: string; previewUrl?: string }>>([]);


  // Load sessions on mount
  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    if (loaded.length > 0) { setCurrentSessionId(loaded[0].id); sessionIdRef.current = loaded[0].id; }
  }, []);

  const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages ?? [];

  useEffect(() => { sessionIdRef.current = currentSessionId; }, [currentSessionId]);
  useEffect(() => { messagesRef.current = currentMessages; }, [currentMessages]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sessions.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveSessions(sessions), 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [sessions]);
  useEffect(() => {
    if (!userIsNearBottom.current) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [currentMessages]);
  // Auto-scroll thought content to bottom as new thoughts stream in
  useEffect(() => {
    const el = thoughtContentRef.current;
    if (el && showThoughts) el.scrollTop = el.scrollHeight;
  }, [thoughtText, showThoughts]);
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

  const sendMessage = useCallback(async (text: string, attachmentsArg?: Array<{ type: string; name: string; mimeType: string; data?: string; url?: string; previewUrl?: string }>) => {
    const snapshotAttachments = attachmentsArg ?? pendingAttachmentsRef.current;
    const snapshotSkills = activeSkillsRef.current;
    if ((!text.trim() && snapshotAttachments.length === 0) || streaming) return;
    const sessionId = ensureSession();
    setInput("");
    // Keep preview object URLs alive here because persisted message bubbles and retry flows
    // may still reference `previewUrl` after send. Revoke them only when those consumers are removed.
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
      userParts.push({
        kind: "attachment",
        type: att.type,
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
        url: att.url,
      });
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
    setThoughtText("");
    setShowThoughts(false);
    setActiveToolLabel(null);
    setThoughtLabel(null);
    setPasteUrl(null); // dismiss paste pill when message is sent
    lastUserTextRef.current = text; // track for retry
    lastUserAttachmentsRef.current = snapshotAttachments;
    streamingAssistantIdRef.current = assistantMsgId; // track for Stop
    abortRef.current = new AbortController();

    // Build history — include completed tool results as text so the agent
    // has full multi-turn memory of what tools ran and what they returned.
    const allMsgs = [...(messagesRef.current), { id: userMsgId, role: "user" as const, parts: userParts, timestamp: new Date() }];
    const history = allMsgs
      .map((m, idx) => {
        const isLatestUserMsg = idx === allMsgs.length - 1;
        const textParts = m.parts
          .filter((p: any) => p.kind === "text")
          .map((p: any) => p.content)
          .join("");
        // For assistant messages: append a compact summary of completed tools
        const toolSummary = m.role === "assistant"
          ? m.parts
            .filter((p: any) => p.kind === "tool_start" && p.done)
            .map((p: any) => {
              const compactArgs = JSON.stringify(p.args ?? {}).slice(0, 1200);
              const resultStr = p.result?.error
                ? `ERROR: ${p.result.error}`
                : JSON.stringify(p.result ?? {}).slice(0, 2000);
              return `[Tool: ${p.name} | Args: ${compactArgs} | Result: ${resultStr}]`;
            })
            .join("\n")
          : "";
        const artifactSummary = m.role === "assistant"
          ? m.parts
            .filter((p: any) => p.kind === "artifact")
            .map((p: any) => {
              if (p.artifactType === "text" && p.content) return `[TextArtifact: ${p.label}] ${String(p.content).slice(0, 4000)}`;
              const fields = [
                `Artifact: ${p.artifactType}`,
                `Label: ${p.label}`,
                p.downloadUrl ? `URL: ${p.downloadUrl}` : "",
                p.imageUrl ? `Image: ${p.imageUrl}` : "",
                p.tab ? `Tab: ${p.tab}` : "",
                p.jobId ? `Job: ${p.jobId}` : "",
              ].filter(Boolean).join(" | ");
              return `[${fields}]`;
            })
            .join("\n")
          : "";
        const content = [textParts, toolSummary, artifactSummary].filter(Boolean).join("\n").trim();
        // Only include full attachment data (base64 images) for the latest user message.
        // Older messages get a lightweight reference to avoid huge payloads.
        const msgAttachments = m.role === "user"
          ? m.parts
            .filter((p: any) => p.kind === "attachment")
            .map((p: any) => {
              if (!isLatestUserMsg && p.type === "image") {
                return { type: p.type, name: p.name, mimeType: p.mimeType };
              }
              return { type: p.type, name: p.name, mimeType: p.mimeType, data: p.data, url: p.url };
            })
          : undefined;
        return { role: m.role === "user" ? "user" as const : "model" as const, content, ...(msgAttachments ? { attachments: msgAttachments } : {}) };
      })
      .filter(m => m.content.trim() || (m as any).attachments?.length > 0);

    const patchAssistant = (updater: (m: Message) => Message) => {
      upsertMsg(sessionId, assistantMsgId, updater);
    };
    const cleanAssistantText = (content: string) =>
      content
        .replace(
          /\[?\/api\/(?:youtube\/file|subtitles\/status|translator\/share)\/[^\]\s)]+(?:\]\(\/api\/(?:youtube\/file|subtitles\/status|translator\/share)\/[^)]+\))?/g,
          "the button above",
        )
        // Strip S3 presigned URLs (long AWS URLs with signatures)
        .replace(/https?:\/\/[^\s"]*\.s3[^\s"]*(?:X-Amz-[^\s"]*)+/gi, "the download button above")
        // Strip leaked [Tool: ...] markers from model output
        .replace(/\[Tool:\s*\w+\s*\|[^\]]*\]/gi, "")
        // Strip leaked Result JSON objects
        .replace(/\{"\w+(?:Url|url)":\s*"https?:\/\/[^"]*"[^}]*\}/g, "");

    const appendText = (content: string) => {
      const cleaned = cleanAssistantText(content);
      // Allow whitespace-only deltas (spaces between words) — only skip truly empty
      if (!cleaned) return;
      patchAssistant(m => {
        const parts = [...m.parts];
        const last = parts[parts.length - 1];
        if (last?.kind === "text") return { ...m, parts: [...parts.slice(0, -1), { kind: "text", content: last.content + cleaned }] };
        // Don't start a new text part with just whitespace — wait for real content
        if (!cleaned.trim()) return m;
        return { ...m, parts: [...parts, { kind: "text", content: cleaned }] };
      });
    };

    const handleEvent = (evt: SseEvent) => {
      if (evt.type === "run_start") { setCurrentRunId(evt.runId); return; }
      if (evt.type === "heartbeat") return;
      if (evt.type === "thinking") {
        setThinking(true);
        if (evt.stage) setAgentStage(evt.stage as "idle" | "planning" | "executing" | "verifying");
        if (evt.iteration !== undefined) {
          setAgentIteration(evt.iteration);
          // Add separator between iteration thoughts (skip first)
          if (evt.iteration > 1) setThoughtText(prev => prev ? prev + "\n\n" : prev);
        }
        return;
      }
      if (evt.type === "thought_delta") {
        setThoughtText(prev => {
          const updated = prev + evt.content;
          // Extract the latest **bold title** from thought text to use as dynamic label
          const boldMatches = updated.match(/\*\*([^*]+)\*\*/g);
          if (boldMatches && boldMatches.length > 0) {
            const latest = boldMatches[boldMatches.length - 1].replace(/\*\*/g, "").trim();
            if (latest.length > 3 && latest.length < 80) setThoughtLabel(latest);
          }
          return updated;
        });
        return;
      }
      if (evt.type === "text" || evt.type === "text_delta") { setThinking(false); setActiveToolLabel(null); appendText(evt.content); return; }
      if (evt.type === "grounding_sources") {
        patchAssistant(m => ({
          ...m,
          groundingSources: evt.chunks,
          searchEntryPoint: evt.searchEntryPoint ?? null,
        }));
        return;
      }
      if (evt.type === "plan") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "plan", steps: evt.steps, iteration: evt.iteration }] }));
        return;
      }
      if (evt.type === "tool_start") {
        // Show tool name in thinking indicator while tool runs
        const meta = TOOL_META[evt.name];
        setActiveToolLabel(meta?.label ?? evt.name.replace(/_/g, " "));
        setThinking(true);
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

        // Register active job in global history tracking
        if (evt.jobId) {
          const url = (evt as any).url || "";
          if (evt.name === "cut_video_clip" || evt.name === "find_best_clips") {
            const active = loadActiveClipJobs();
            if (!active.some(j => j.jobId === evt.jobId)) {
              const startSecs = typeof (evt as any).startSecs === "number" ? (evt as any).startSecs : 0;
              const endSecs = typeof (evt as any).endSecs === "number" ? (evt as any).endSecs : 0;
              saveActiveClipJobs([...active, {
                jobId: evt.jobId!,
                url: url,
                label: evt.name === "cut_video_clip" && endSecs > startSecs ? `${startSecs}s -> ${endSecs}s` : "AI Analysis",
                startSecs,
                endSecs,
                quality: String((evt as any).quality ?? "best"),
                startedAt: Date.now()
              }]);
            }
          } else if (evt.name === "download_video") {
            if (loadActiveDownload()?.jobId !== evt.jobId) {
              saveActiveDownload({
                jobId: evt.jobId!,
                url: url,
                savedAt: Date.now()
              });
            }
          } else if (evt.name === "generate_subtitles") {
            if (loadActiveJob()?.jobId !== evt.jobId) {
              saveActiveJob({
                jobId: evt.jobId!,
                mode: "url",
                url: url,
                language: "auto",
                translateTo: "",
                startedAt: Date.now()
              });
            }
          } else if (evt.name === "translate_video") {
            upsertActiveTranslatorJob({
              jobId: evt.jobId!,
              filename: "input.mp4",
              targetLang: (evt as any).targetLang || "Hindi",
              startedAt: Date.now(),
              progress: 0,
              step: "Starting",
              status: "processing"
            });
          }
        }
        return;
      }
      if (evt.type === "tool_done") {
        setActiveToolLabel(null);
        patchAssistant(m => ({
          ...m, parts: m.parts.map(p =>
            p.kind === "tool_start" && ((evt.toolId && (p as any).toolId === evt.toolId) || (!evt.toolId && (p as any).name === evt.name && !(p as any).done))
              ? { ...p, done: true, result: evt.result, progress: 100 } : p),
        }));

        // Sync to Activity History
        if (evt.name === "cut_video_clip" && evt.result?.jobId) {
          saveToClipHistory({
            jobId: evt.result.jobId,
            createdAt: Date.now(),
            label: `AI Clip: ${evt.result.startTime || ""} to ${evt.result.endTime || ""}`,
            url: evt.result.url || "",
            quality: evt.result.quality || "720p",
            filename: "clip.mp4",
            filesize: null,
            durationSecs: 0,
          });
        } else if (evt.name === "download_video" && evt.result?.jobId) {
          saveCompletedDownload({
            jobId: evt.result.jobId,
            url: evt.result.url || "",
            filename: evt.result.filename || "video.mp4",
            filesize: null,
            createdAt: Date.now(),
          });
        } else if (evt.name === "generate_subtitles" && evt.result?.jobId) {
          saveToHistory({
            id: evt.result.jobId,
            createdAt: Date.now(),
            mode: "url",
            url: evt.result.url || "",
            srtFilename: evt.result.srtFilename || "subtitles.srt",
            language: evt.result.language || "auto",
            translateTo: evt.result.translateTo || "",
            srt: "",
            entryCount: 0,
          });
        }

        return;
      }
      if (evt.type === "navigate") { if (onNavigate) onNavigate(evt.tab); return; }
      if (evt.type === "artifact") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "artifact", artifactType: evt.artifactType, label: evt.label, tab: evt.tab, jobId: evt.jobId, downloadUrl: evt.downloadUrl, imageUrl: evt.imageUrl, audioUrl: evt.audioUrl, content: evt.content }] }));
        // Auto-save generated music to activity feed
        if (evt.artifactType === "audio" && evt.audioUrl) {
          saveToMusicHistory({
            id: `music-${Date.now()}`,
            createdAt: Date.now(),
            label: evt.label,
            audioUrl: evt.audioUrl,
            imageUrl: evt.imageUrl,
            mimeType: "audio/mpeg",
            filename: evt.label.replace(/[^a-zA-Z0-9\s-]/g, "").trim().slice(0, 60) + ".mp3",
          });
        }
        return;
      }
      if (evt.type === "canvas_start") {
        setThinking(false);
        patchAssistant(m => {
          const exists = m.parts.some(p => p.kind === "artifact" && (p as any).canvasId === evt.canvasId);
          if (exists) return m;
          return {
            ...m,
            parts: [
              ...m.parts,
              {
                kind: "artifact",
                artifactType: "text",
                label: evt.label,
                content: "",
                language: evt.language,
                canvasId: evt.canvasId,
                live: true,
              },
            ],
          };
        });
        return;
      }
      if (evt.type === "canvas_delta") {
        setThinking(false);
        patchAssistant(m => ({
          ...m,
          parts: m.parts.map(p =>
            p.kind === "artifact" && (p as any).canvasId === evt.canvasId
              ? { ...p, content: `${(p as any).content ?? ""}${evt.content}`, live: true }
              : p),
        }));
        return;
      }
      if (evt.type === "canvas_done") {
        patchAssistant(m => ({
          ...m,
          parts: m.parts.map(p =>
            p.kind === "artifact" && (p as any).canvasId === evt.canvasId
              ? { ...p, live: false }
              : p),
        }));
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
        body: JSON.stringify({ sessionId, messages: history, model: ultra ? "ultra" : "default", skills: snapshotSkills }),
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
          try { handleEvent(JSON.parse(raw) as SseEvent); } catch { }
        }
      }
      // trailing buffer
      const raw = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (raw) { try { handleEvent(JSON.parse(raw) as SseEvent); } catch { } }
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
      streamingAssistantIdRef.current = null;
    }
  }, [streaming, ultra, BASE, onNavigate, updateSession, ensureSession, upsertMsg]);

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
    // Mark any in-flight tool cards as cancelled so they don't spin forever (and persist a dead spinner)
    const aId = streamingAssistantIdRef.current;
    const sId = sessionIdRef.current;
    if (aId && sId) {
      upsertMsg(sId, aId, m => ({
        ...m,
        parts: m.parts.map(p =>
          p.kind === "tool_start" && !(p as any).done
            ? { ...p, done: true, cancelled: true, progress: null, progressMsg: "Stopped", result: { error: "Stopped by user" } }
            : p),
      }));
    }
    streamingAssistantIdRef.current = null;
    setStreaming(false); setThinking(false); setAgentStage("idle"); setAgentIteration(0);
  };

  // Cleanup: abort any in-flight stream and stop speech recognition on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recognitionRef.current?.stop();
    };
  }, []);

  const detectVoiceLang = (): string => {
    const recentText = currentMessages.slice(-6)
      .filter(m => m.role === "user")
      .flatMap(m => m.parts.filter(p => p.kind === "text").map(p => (p as any).content as string))
      .join(" ");
    // Detect Devanagari script or common Hindi/Hinglish patterns
    if (/[ऀ-ॿ]/.test(recentText) || /\b(kya|hai|ka|ke|ki|mein|ko|bhi|nahi|yeh|woh|karo|haan|nahi|video|bhai)\b/i.test(recentText)) {
      return "hi-IN";
    }
    return "en-US";
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const r = new SR();
    recognitionRef.current = r;
    r.continuous = false; r.interimResults = false; r.lang = detectVoiceLang();
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
    const textParts = currentMessages
      .filter(m => m.role === "user")
      .flatMap(m => m.parts.filter(p => p.kind === "text").map(p => (p as any).content as string))
      .slice(0, 5);
    const summary = textParts.length > 0 ? textParts.join("\n") : window.location.href;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(summary);
      toast({ title: "Copied to clipboard", description: "Chat summary copied" });
    }
  };

  const handleNewChat = () => { if (streaming) return; setCurrentSessionId(null); sessionIdRef.current = null; setShowHistory(false); };
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) { setCurrentSessionId(null); sessionIdRef.current = null; }
  };

  return (
    <CopilotErrorBoundary onReset={handleNewChat}>
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
                    <p className="agent-history-time">{s.updatedAt.toLocaleDateString([], { month: "short", day: "numeric" })}</p>
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
          <p className="gs-welcome-sub">Download, clip, subtitle, translate, and analyze YouTube videos — or ask anything.</p>
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
        <div className="flex-1 overflow-y-auto px-4 py-4 copilot-messages" ref={messagesContainerRef}
          onScroll={() => {
            const el = messagesContainerRef.current;
            if (el) userIsNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}>
          <div className="agent-msg-col">
            <AnimatePresence initial={false}>
              {currentMessages.map((msg, idx) => {
                const isLastAssistant = msg.role === "assistant" && idx === currentMessages.length - 1;
                const handleRetry = isLastAssistant && lastUserTextRef.current
                  ? () => void sendMessage(lastUserTextRef.current, lastUserAttachmentsRef.current.length > 0 ? lastUserAttachmentsRef.current : undefined)
                  : undefined;
                const hasThoughts = thoughtText.trim().length > 0;
                const showThinkingForMessage = isLastAssistant && (thinking || hasThoughts);
                const stageLabel: Record<string, string> = {
                  planning: "Thinking",
                  executing: "Working",
                  verifying: "Checking",
                  idle: "Thinking",
                };
                const thinkingLabel = hasThoughts && !thinking
                  ? "Thought for a second"
                  : thoughtLabel ?? activeToolLabel ?? stageLabel[agentStage] ?? "Thinking";
                return (
                  <React.Fragment key={msg.id}>
                    {showThinkingForMessage && (
                      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="gs-thinking-block">
                        <button
                          type="button"
                          className={cn("gs-thinking-header", hasThoughts && "gs-thinking-header-clickable")}
                          onClick={() => hasThoughts && setShowThoughts(prev => !prev)}
                          disabled={!hasThoughts}
                        >
                          <span className="gs-thinking-text">{thinkingLabel}</span>
                          {thinking && !hasThoughts && (
                            <span className="gs-thinking-dots" aria-hidden="true">
                              <span>.</span><span>.</span><span>.</span>
                            </span>
                          )}
                          {hasThoughts && (
                            <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", showThoughts && "rotate-90")} />
                          )}
                        </button>
                        <AnimatePresence>
                          {showThoughts && hasThoughts && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: "easeInOut" }}
                              className="gs-thinking-content"
                            >
                              <div ref={thoughtContentRef} className="gs-thinking-content-inner">
                                {thoughtText}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}
                    <MessageBubble message={msg} onNavigate={onNavigate} onRetry={handleRetry} isStreaming={isLastAssistant && streaming} />
                  </React.Fragment>
                );
              })}
            </AnimatePresence>

            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* ── Genspark input bar ── */}
      <div className="gs-input-wrap">
        {/* ── Suggestions chips ── */}
        {suggestions.length > 0 && !streaming && (
          <div className="gs-suggestions-row">
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
          {/* Active skill inline prefix inside textarea area */}
          {/* Slash command menu */}
          {showSlashMenu && slashFilteredSkills.length > 0 && (
            <div className="gs-slash-menu" ref={slashMenuRef}>
              <div className="gs-slash-menu-header">Skills</div>
              {slashFilteredSkills.map((skill, i) => {
                const isActive = activeSkills.includes(skill.id);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    className={cn("gs-slash-menu-item", i === slashMenuIndex && "gs-slash-menu-item-focused", isActive && "gs-slash-menu-item-active")}
                    onMouseEnter={() => setSlashMenuIndex(i)}
                    onClick={() => selectSlashSkill(skill)}
                  >
                    <div className="gs-slash-menu-item-left">
                      <div className="gs-slash-menu-item-icon">
                        <Sparkles className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="gs-slash-menu-item-name">
                          /{skill.id}
                          {isActive && <span className="gs-slash-menu-item-badge">Active</span>}
                        </div>
                        <div className="gs-slash-menu-item-desc">{skill.description}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="gs-input-textarea-wrap">
            {activeSkills.length > 0 && (
              <span className="gs-inline-skill-prefix" onClick={() => removeActiveSkill(activeSkills[activeSkills.length - 1])}>
                {activeSkills.map(sid => {
                  const skill = availableSkills.find(s => s.id === sid);
                  return `/${skill?.id ?? sid}`;
                }).join(" ")}
              </span>
            )}
          <textarea
            className="gs-input-textarea gs-input-textarea-inline"
            value={input}
            onChange={e => {
              const val = e.target.value;
              setInput(val);
              handleSlashInput(val);
              // Surface the quick-action pill when the whole input is just a pasted/typed link
              const trimmed = val.trim();
              setPasteUrl(/^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            onKeyDown={e => {
              if (showSlashMenu && slashFilteredSkills.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashMenuIndex(i => (i + 1) % slashFilteredSkills.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashMenuIndex(i => (i - 1 + slashFilteredSkills.length) % slashFilteredSkills.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  selectSlashSkill(slashFilteredSkills[slashMenuIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowSlashMenu(false);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(input, pendingAttachments); }
              if (e.key === "Backspace" && !input && activeSkills.length > 0) { removeActiveSkill(activeSkills[activeSkills.length - 1]); }
            }}
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
            placeholder={activeSkills.length > 0 ? "" : "Ask anything, create anything"}
            rows={1}
            style={{ resize: "none", overflow: "hidden", minHeight: 28 }}
          />
          </div>

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
                      type="button"
                      className="gs-plus-menu-item"
                      disabled={uploading}
                      onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); }}
                    >
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      <span>Upload Files</span>
                    </button>
                    <button type="button" className="gs-plus-menu-item"
                      onClick={() => { setInput("Create an image: "); setShowPlusMenu(false); }}>
                      <ImagePlus className="w-4 h-4" />
                      <span>Create Image</span>
                    </button>
                    <button type="button" className="gs-plus-menu-item"
                      onClick={() => { setInput("Make music: "); setShowPlusMenu(false); }}>
                      <Music2 className="w-4 h-4" />
                      <span>Create Music</span>
                      <span className="gs-plus-menu-badge gs-plus-menu-badge-new">New</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="gs-input-row-right">
              <div className="gs-reasoning-control" ref={reasoningMenuRef}>
                <button
                  type="button"
                  className="gs-reasoning-button"
                  aria-haspopup="menu"
                  aria-expanded={showReasoningMenu}
                  title={activeReasoning.description}
                  onClick={() => setShowReasoningMenu(v => !v)}
                >
                  <span>{activeReasoning.label}</span>
                  <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showReasoningMenu && "rotate-180")} />
                </button>
                {showReasoningMenu && (
                  <div className="gs-reasoning-menu" role="menu">
                    {REASONING_OPTIONS.map(option => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={reasoningMode === option.id}
                        className={cn("gs-reasoning-menu-item", reasoningMode === option.id && "gs-reasoning-menu-item-active")}
                        onClick={() => {
                          setReasoningMode(option.id);
                          setShowReasoningMenu(false);
                        }}
                      >
                        <span className="gs-reasoning-menu-copy">
                          <span className="gs-reasoning-menu-label">{option.label}</span>
                          <span className="gs-reasoning-menu-desc">{option.description}</span>
                        </span>
                        {reasoningMode === option.id && <Check className="w-4 h-4" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
    </CopilotErrorBoundary>
  );
}
