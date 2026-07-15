import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import katex from "katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Loader2, CheckCircle, ChevronRight, ChevronDown,
  Download, Scissors, Sparkles, Captions, AlarmClock,
  UploadCloud, Shield, ListVideo, X, Trash2, History, Square, Copy, Check, RotateCcw, Link,
  Pencil, Share2, SquarePen, Plus, Paperclip, AudioLines, Menu, ArrowUp,
  MoreVertical,
  ImagePlus, Music2, Terminal, Eye, Volume2, Film,
  FolderOpen, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspacePanel } from "./WorkspacePanel";
import { useToast, toast } from "@/hooks/use-toast";
import { saveActiveDownload, loadActiveDownload, saveCompletedDownload } from "@/lib/download-history";
import { inferCanvasLanguage, shouldPromoteFencedBlockToCanvas } from "@/lib/copilot-canvas-policy";
import { saveActiveJob, loadActiveJob, saveToHistory } from "@/lib/subtitle-history";
import { loadActiveClipJobs, saveActiveClipJobs, saveToClipHistory } from "@/lib/clip-history";
import { saveToMusicHistory } from "@/lib/music-history";
import { upsertActiveTranslatorJob } from "@/lib/translator-history";
import { getToolResultError } from "@/lib/copilot-tool-state";

const ULTRA_KEY = "studio-ultra-mode";
// Separate key persists the full reasoning mode (flash/pro/advanced).
// Without this, only `ultra` (advanced) was preserved across reloads — `pro`
// silently reverted to `flash` and `advanced` reverted to `pro` after refresh.
const REASONING_KEY = "studio-reasoning-mode";
function readUltraInitial(): boolean {
  try { return localStorage.getItem(ULTRA_KEY) === "1"; } catch { return false; }
}

type ReasoningMode = "gemini-3.1-flash-lite-low" | "gemini-3.1-flash-lite-high" | "gemma-4-31b-it";
const REASONING_OPTIONS: Array<{ id: ReasoningMode; label: string; description: string; ultra: boolean }> = [
  { id: "gemini-3.1-flash-lite-low",   label: "Fast",      description: "Low thinking, cheap & fast", ultra: false },
  { id: "gemini-3.1-flash-lite-high",  label: "Thinking",  description: "High thinking, deeper reasoning", ultra: false },
  { id: "gemma-4-31b-it",              label: "Ultra",  description: "Highest thinking, deepest reasoning", ultra: true },
];

function readReasoningInitial(): ReasoningMode {
  try {
    const stored = localStorage.getItem(REASONING_KEY);
    // New model IDs
    if (stored === "gemini-3.1-flash-lite-low" || stored === "gemini-3.1-flash-lite-high" || stored === "gemma-4-31b-it") return stored;
    // Backward compat: old keys map to new flash-lite modes
    if (stored === "flash" || stored === "gemini-3-flash-preview" || stored === "gemini-2.5-flash") return "gemini-3.1-flash-lite-low";
    if (stored === "pro" || stored === "advanced" || stored === "gemini-3.5-flash" || stored === "gemini-3.5-flash-high") return "gemma-4-31b-it";
    if (stored === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-low";
  } catch { /* localStorage unavailable */ }
  // Default is now gemma-4-31b-it (Ultra)!
  return "gemma-4-31b-it";
}

function getInputMaxHeight(): number {
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 520px)").matches) {
    return 76;
  }
  return 160;
}

const HISTORY_KEY = "copilot-sessions-v2";

type ChatSession = { id: string; title: string; updatedAt: Date; messages: Message[] };

function loadSessions(): ChatSession[] {
  let parsed: any[] = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    parsed = decoded;
  } catch {
    return [];
  }
  const sessions: ChatSession[] = [];
  for (const s of parsed) {
    // Per-session try/catch — a single corrupted session must NEVER discard
    // the rest of the user's history.
    try {
      if (!s || typeof s.id !== "string" || !Array.isArray(s.messages)) continue;
      sessions.push({
        ...s,
        title: typeof s.title === "string" && s.title.trim() ? s.title : "New Chat",
        updatedAt: new Date(s.updatedAt || Date.now()),
        messages: s.messages
          .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && Array.isArray(m.parts))
          .map((m: any) => ({ ...m, timestamp: new Date(m.timestamp || Date.now()) })),
      });
    } catch {
      // Skip just this session.
    }
  }
  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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

function revokeMessagePreviewUrls(messages: Message[]) {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "image" && part.previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(part.previewUrl);
      }
    }
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
  | { type: "artifact"; runId?: string; toolId?: string; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; imageUrl?: string; audioUrl?: string; content?: string; files?: Array<{ path: string; size: number; modifiedAt: number; contentType?: string }>; dir?: string; contentType?: string; size?: number }
  | { type: "canvas_start"; runId?: string; canvasId: string; label: string; language?: string }
  | { type: "canvas_delta"; runId?: string; canvasId: string; content: string }
  | { type: "canvas_done"; runId?: string; canvasId: string }
  | { type: "thought_delta"; content: string; runId?: string }
  | { type: "grounding_sources"; runId?: string; chunks: Array<{ title: string; uri: string }>; searchEntryPoint?: string | null }
  | { type: "error"; message: string }
  | { type: "done"; runId?: string; ts?: number };

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "image"; previewUrl: string; name: string }
  | { kind: "attachment"; type: string; name: string; mimeType: string; data?: string; url?: string }
  | { kind: "plan"; steps: Array<{ tool: string; args: Record<string, any> }>; iteration?: number }
  | { kind: "tool_start"; toolId?: string; name: string; args: Record<string, any>; done?: boolean; cancelled?: boolean; result?: any; progress?: number | null; progressMsg?: string; logs?: Array<{ ts: number; msg: string; level?: "info" | "warn" | "error" }>; error?: string; inlineArtifact?: { artifactType: string; label: string; content?: string; files?: Array<{ path: string; size: number; modifiedAt: number; contentType?: string }>; dir?: string; contentType?: string; size?: number; downloadUrl?: string } }
  | { kind: "artifact"; artifactType: string; label: string; tab?: string; jobId?: string; downloadUrl?: string; imageUrl?: string; audioUrl?: string; content?: string; language?: string; canvasId?: string; live?: boolean; files?: Array<{ path: string; size: number; modifiedAt: number; contentType?: string }>; dir?: string; contentType?: string; size?: number };

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
  list_workspace_files: { icon: <FolderOpen className="w-3.5 h-3.5" />, label: "Listing your files", color: "text-amber-300" },
  read_workspace_file: { icon: <FolderOpen className="w-3.5 h-3.5" />, label: "Reading from workspace", color: "text-amber-300" },
  write_workspace_file: { icon: <FolderOpen className="w-3.5 h-3.5" />, label: "Saving to workspace", color: "text-amber-300" },
  delete_workspace_file: { icon: <Trash2 className="w-3.5 h-3.5" />, label: "Removing from workspace", color: "text-red-300" },
  save_artifact_to_workspace: { icon: <FolderOpen className="w-3.5 h-3.5" />, label: "Saving artifact", color: "text-amber-300" },
  list_drive_files: { icon: <span className="text-[13px]">📁</span>, label: "Browsing Drive folder", color: "text-blue-300" },
  import_from_drive: { icon: <span className="text-[13px]">📥</span>, label: "Importing from Drive", color: "text-blue-300" },
};
const TAB_ICONS: Record<string, React.ReactNode> = {
  download: <Download className="w-3.5 h-3.5" />, clips: <Sparkles className="w-3.5 h-3.5" />,
  subtitles: <Captions className="w-3.5 h-3.5" />, clipcutter: <Scissors className="w-3.5 h-3.5" />,
  bhagwat: <Shield className="w-3.5 h-3.5" />, scenefinder: <ListVideo className="w-3.5 h-3.5" />,
  timestamps: <AlarmClock className="w-3.5 h-3.5" />, upload: <UploadCloud className="w-3.5 h-3.5" />,
};
const STARTERS = [
  { icon: <Scissors className="w-4 h-4" />, text: "Cut a clip from a YouTube video" },
  { icon: <Sparkles className="w-4 h-4" />, text: "Find the best moments in a long video" },
  { icon: <Captions className="w-4 h-4" />, text: "Transcribe and translate a video to English" },
  { icon: <FolderOpen className="w-4 h-4" />, text: "Show me my saved files" },
  { icon: <ImagePlus className="w-4 h-4" />, text: "Generate a thumbnail image for my video", capability: "createImage" as const },
  { icon: <Bot className="w-4 h-4" />, text: "What can you do?" },
];

function skillIconNode(icon: string) {
  if (icon === "Film") return <Film className="w-4 h-4" />;
  return <Sparkles className="w-4 h-4" />;
}

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


// ── Markdown table helpers ──────────────────────────────────────────────────────
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableRowLine(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function tableAlignClass(spec: string): string {
  const left = spec.startsWith(":");
  const right = spec.endsWith(":");
  if (left && right) return "text-center";
  if (right) return "text-right";
  return "text-left";
}

// ── List item helpers (shared by renderMd and renderStreamingMd) ───────────────
function listIndentStyle(indent: string): React.CSSProperties | undefined {
  const indentPx = Math.min(indent.length, 12) * 8;
  return indentPx ? { marginLeft: indentPx } : undefined;
}

function renderUlItem(
  key: string | number,
  indent: string,
  content: string,
  inline: (str: string, key: string) => React.ReactNode,
  inlineKeyPrefix: string
): React.ReactNode {
  const style = listIndentStyle(indent);
  const checkboxMatch = /^\[( |x|X)\]\s+(.*)/.exec(content);
  if (checkboxMatch) {
    const checked = checkboxMatch[1].toLowerCase() === "x";
    return (
      <div key={key} className="flex gap-2 ml-1 items-start" style={style}>
        <span className={`mt-0.5 shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[9px] leading-none ${checked ? "bg-sky-500/30 border-sky-400 text-sky-300" : "border-white/30"}`}>{checked ? "✓" : ""}</span>
        <span className={checked ? "text-white/50 line-through" : undefined}>{inline(checkboxMatch[2], inlineKeyPrefix)}</span>
      </div>
    );
  }
  return (
    <div key={key} className="flex gap-2 ml-1" style={style}>
      <span className="text-white/30 shrink-0">•</span>
      <span>{inline(content, inlineKeyPrefix)}</span>
    </div>
  );
}

function renderOlItem(
  key: string | number,
  indent: string,
  num: string,
  content: string,
  inline: (str: string, key: string) => React.ReactNode,
  inlineKeyPrefix: string
): React.ReactNode {
  const style = listIndentStyle(indent);
  return (
    <div key={key} className="flex gap-2 ml-1" style={style}>
      <span className="text-white/40 shrink-0">{num}.</span>
      <span>{inline(content, inlineKeyPrefix)}</span>
    </div>
  );
}

function renderMdTable(
  headerCells: string[],
  aligns: string[],
  bodyRows: string[][],
  keyPrefix: string,
  inline: (str: string, key: string) => React.ReactNode
): React.ReactNode {
  return (
    <div key={keyPrefix} className="overflow-x-auto my-2 rounded-md border border-white/10">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-white/5">
            {headerCells.map((c, ci) => (
              <th key={`${keyPrefix}-h${ci}`} className={`px-2 py-1 border border-white/10 font-semibold whitespace-nowrap ${tableAlignClass(aligns[ci] || "")}`}>
                {inline(c, `${keyPrefix}-h${ci}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={`${keyPrefix}-r${ri}`}>
              {row.map((c, ci) => (
                <td key={`${keyPrefix}-r${ri}-c${ci}`} className={`px-2 py-1 border border-white/10 align-top ${tableAlignClass(aligns[ci] || "")}`}>
                  {inline(c, `${keyPrefix}-r${ri}-c${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function safeExternalHref(href?: string): string | null {
  const value = String(href || "").trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) return null;
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(value)) return value;
  return null;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const canvasPanelRef = useRef<HTMLDivElement | null>(null);
  const label = normalizeCanvasLanguage(language, code);
  const filename = canvasFilename(label);

  useEffect(() => {
    if (!canvasOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCanvasOpen(false);
      if (event.key === "Tab" && canvasPanelRef.current) {
        const focusable = Array.from(
          canvasPanelRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [canvasOpen]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ title: "Copy failed", description: "Select the code and copy it manually." });
    }
  };

  const downloadCode = () => {
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-black/30">
      <div className="flex items-center justify-between border-b border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-white/35">
        <span className="normal-case tracking-normal">{filename}</span>
        <div className="flex items-center gap-0.5">
          <button type="button" className="gs-code-action" onClick={() => setWrapped(v => !v)} aria-pressed={wrapped} aria-label={wrapped ? "Disable code wrapping" : "Wrap code"} title={wrapped ? "Disable wrapping" : "Wrap code"}>
            <RotateCcw className="h-4 w-4" />
          </button>
          <button type="button" className="gs-code-action" onClick={() => setCanvasOpen(true)} aria-label="Open code in canvas" title="Open in canvas">
            <SquarePen className="h-4 w-4" />
          </button>
          <button type="button" className="gs-code-action" onClick={downloadCode} aria-label={`Download ${filename}`} title="Download">
            <Download className="h-4 w-4" />
          </button>
          <button type="button" className="gs-code-action" onClick={() => void copyCode()} aria-label={copied ? "Code copied" : "Copy code"} title="Copy code">
            {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <pre className={cn("max-h-80 overflow-auto px-3 py-2 text-[12px] leading-relaxed text-cyan-50/82 font-mono", wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
        <code>{code}</code>
      </pre>
      {canvasOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={`${filename} canvas`}>
          <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setCanvasOpen(false)} aria-label="Close canvas" />
          <div ref={canvasPanelRef} className="relative z-10 flex h-[min(88dvh,900px)] w-[min(96vw,1100px)] flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#111318] shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white/90">{filename}</div>
                <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="gs-code-action" onClick={downloadCode} aria-label={`Download ${filename}`}><Download className="h-4 w-4" /></button>
                <button type="button" className="gs-code-action" onClick={() => void copyCode()} aria-label="Copy canvas content"><Copy className="h-4 w-4" /></button>
                <button type="button" className="gs-code-action" onClick={() => setCanvasOpen(false)} aria-label="Close canvas" autoFocus><X className="h-4 w-4" /></button>
              </div>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-[13px] leading-relaxed text-cyan-50/90"><code>{code}</code></pre>
          </div>
        </div>
      )}
    </div>
  );
}

function renderCodeBlock(code: string, language: string | undefined, key: string): React.ReactNode {
  return <CodeBlock key={key} code={code} language={language} />;
}

// ── KaTeX math rendering ──────────────────────────────────────────────────────
function renderKatexNode(latex: string, displayMode: boolean, key: string): React.ReactNode {
  try {
    const html = katex.renderToString(latex.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
    return displayMode
      ? <div key={key} className="katex-block my-3 overflow-x-auto text-center"
             dangerouslySetInnerHTML={{ __html: html }} />
      : <span key={key} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <code key={key} className="text-orange-300 text-sm">{latex}</code>;
  }
}

const HTML_TAG_RE = /^<(sup|sub|ins|kbd|mark|s)>([^<]*)<\/(?:sup|sub|ins|kbd|mark|s)>$/;
const HEADING_SIZES: Record<number, string> = {
  1: "text-[22px] md:text-[25px] font-bold mt-5 mb-2.5 text-white tracking-tight leading-tight",
  2: "text-[19px] md:text-[21px] font-bold mt-4.5 mb-2 text-white tracking-tight leading-tight",
  3: "text-[17px] md:text-[18.5px] font-semibold mt-4 mb-1.5 text-white/95 tracking-tight leading-snug",
  4: "text-[15px] md:text-[16px] font-semibold mt-3.5 mb-1 text-white/90 leading-snug",
  5: "text-[13.5px] md:text-[14px] font-medium mt-3 mb-0.5 text-white/85",
  6: "text-[12px] md:text-[12.5px] font-medium mt-2.5 mb-0.5 text-white/75",
};

// ── Markdown renderer ──────────────────────────────────────────────────────────
function normalizeMarkdownForRender(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const originalLine of lines) {
    let line = originalLine;
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (!inFence) {
      line = line
        .replace(/^(\s*)•\s+/, "$1- ")
        .replace(/(^|[^\\])\$([0-9]+(?:\.[0-9]{1,2})?)/g, (_match, prefix: string, amount: string) => `${prefix}\\$${amount}`);

      const callout = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(line);
      if (callout) {
        const label = callout[1].toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
        const rest = callout[2]?.trim();
        line = `> **${label}:**${rest ? ` ${rest}` : ""}`;
      }

      // Model output often writes block math inline after labels or before the
      // next bullet; put $$ delimiters on their own lines so remark-math can
      // recover the block instead of swallowing following markdown as math.
      if (line.includes("$$")) {
        line = line
          .replace(/^(.+?\S)\s+\$\$/g, "$1\n\n$$")
          .replace(/\$\$\s+(\S)/g, "$$\n$1")
          .replace(/\$\$(?=\S)/g, "$$\n")
          .replace(/(\S)\s*\$\$/g, "$1\n$$");
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

function reactNodePlainText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodePlainText).join("");
  if (React.isValidElement(node)) {
    return reactNodePlainText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

function MarkdownContent({
  text,
  sources,
  streaming = false,
}: {
  text: string;
  sources?: Array<{ title: string; uri: string }>;
  streaming?: boolean;
}) {
  const normalizedText = useMemo(() => normalizeMarkdownForRender(text), [text]);
  const components = useMemo(() => ({
    a({ href, children, ...props }: any) {
      const safeHref = safeExternalHref(href);
      if (!safeHref) return <span>{children}</span>;
      const local = safeHref.startsWith("#") || safeHref.startsWith("/");
      return (
        <a
          {...props}
          href={safeHref}
          target={local ? undefined : "_blank"}
          rel={local ? undefined : "noopener noreferrer"}
          className="text-sky-400 hover:text-sky-300 underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
    img({ src, alt, title }: any) {
      const safeSrc = safeExternalHref(src);
      if (!safeSrc) return <span>{alt || "Image"}</span>;
      return (
        <img
          src={safeSrc}
          alt={alt || ""}
          title={title}
          loading="lazy"
          className="my-2 max-h-80 max-w-full rounded-lg border border-white/10 object-contain"
        />
      );
    },
    blockquote({ children }: any) {
      if (!reactNodePlainText(children).trim()) return null;
      return <blockquote>{children}</blockquote>;
    },
    pre({ children }: any) {
      const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
      if (React.isValidElement(child) && child.type === "code") {
        const props = child.props as { className?: string; children?: React.ReactNode };
        const language = /language-([a-zA-Z0-9+#.-]+)/.exec(props.className || "")?.[1];
        return renderCodeBlock(String(props.children ?? "").replace(/\n$/, ""), language, "md-code");
      }
      return <pre className="my-2 max-h-80 overflow-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[12px] leading-relaxed text-cyan-50/82 font-mono whitespace-pre-wrap">{children}</pre>;
    },
    code({ className, children }: any) {
      return <code className={className}>{children}</code>;
    },
    input({ type, checked, disabled, ...props }: any) {
      if (type === "checkbox") {
        return <input {...props} type="checkbox" checked={checked} readOnly disabled={disabled ?? true} className="mr-2 align-middle accent-sky-400" />;
      }
      return <input {...props} type={type} disabled={disabled} />;
    },
  }), []);

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeSanitize,
          [rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }],
        ]}
        components={components}
      >
        {normalizedText}
      </ReactMarkdown>
      {sources && sources.length > 0 ? (
        <span className="sr-only">
          {sources.map((source, index) => ` Source ${index + 1}: ${source.title || source.uri}.`).join("")}
        </span>
      ) : null}
      {streaming ? <span className="stream-cursor" /> : null}
    </>
  );
}

function renderMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  // Known issue #1 fix: removed early return to MarkdownContent so that
  // completed markdown uses the same custom parser as streaming markdown,
  // ensuring consistent rendering between streaming and final views.
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  const inline = (str: string, key: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\[\d+\]|\*[^*\n]+\*|_[^_\n]+_|\$[^$\n]+\$|<(?:sup|sub|ins|kbd|mark|s)>[^<]*<\/(?:sup|sub|ins|kbd|mark|s)>)/g;
    let last = 0; let m; let k = 0;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) parts.push(<span key={`${key}-t${k++}`}>{str.slice(last, m.index)}</span>);
      const tok = m[0];
      if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${k++}`}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("~~")) parts.push(<del key={`${key}-s${k++}`}>{tok.slice(2, -2)}</del>);
      else if (tok.startsWith("`")) parts.push(<code key={`${key}-c${k++}`}>{tok.slice(1, -1)}</code>);
      else if (tok.startsWith("$")) parts.push(renderKatexNode(tok.slice(1, -1), false, `${key}-m${k++}`));
      else if (tok.startsWith("<")) {
        const hm = HTML_TAG_RE.exec(tok);
        if (hm) {
          const Tag = hm[1] as keyof React.JSX.IntrinsicElements;
          const cls = hm[1] === "kbd" ? "font-mono text-[0.8em] bg-white/10 border border-white/20 rounded px-1 py-0.5"
            : hm[1] === "ins" ? "underline decoration-white/60"
            : hm[1] === "mark" ? "bg-yellow-400/30 text-yellow-100 px-0.5 rounded"
            : undefined;
          parts.push(React.createElement(Tag, { key: `${key}-h${k++}`, className: cls }, hm[2]));
        } else parts.push(<span key={`${key}-h${k++}`}>{tok}</span>);
      }
      else if (tok.startsWith("*") || tok.startsWith("_")) parts.push(<em key={`${key}-i${k++}`}>{tok.slice(1, -1)}</em>);
      else {
        const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
        if (linkMatch) {
          const href = safeExternalHref(linkMatch[2]);
          parts.push(href
            ? <a key={`${key}-a${k++}`} href={href} target="_blank" rel="noopener noreferrer"
                className="text-sky-400 hover:text-sky-300 underline underline-offset-2">{linkMatch[1]}</a>
            : <span key={`${key}-a${k++}`}>{linkMatch[1]}</span>
          );
        } else {
          const idx = parseInt(tok.slice(1, -1), 10) - 1;
          const src = sources?.[idx];
          parts.push(src
            ? <a key={`${key}-ref${k++}`} href={src.uri} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-4 h-4 text-[9px] font-semibold rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors align-super leading-none mx-0.5 no-underline"
                title={src.title}>{idx + 1}</a>
            : <span key={`${key}-ref${k++}`} className="text-white/40 text-[9px] align-super">{tok}</span>
          );
        }
      }
      last = m.index + tok.length;
    }
    if (last < str.length) parts.push(<span key={`${key}-e`}>{str.slice(last)}</span>);
    return parts.length > 0 ? parts : str;
  };

  let li = 0;
  while (li < lines.length) {
    const line = lines[li];

    const codeFenceMatch = /^```([a-zA-Z0-9+#.-]*)\s*$/.exec(line);
    if (codeFenceMatch) {
      const codeLines: string[] = [];
      let bi = li + 1;
      while (bi < lines.length && !/^```\s*$/.test(lines[bi])) {
        codeLines.push(lines[bi]);
        bi++;
      }
      result.push(renderCodeBlock(codeLines.join("\n"), codeFenceMatch?.[1], `code${li}`));
      li = bi < lines.length ? bi + 1 : bi;
      continue;
    }

    // Block math: $$ ... $$ (single or multi-line)
    const trimmed = line.trim();
    if (trimmed === "$$" || /^\$\$[^\s]/.test(trimmed)) {
      let mathContent: string;
      if (trimmed === "$$") {
        const mathLines: string[] = [];
        let bi = li + 1;
        while (bi < lines.length && lines[bi].trim() !== "$$") { mathLines.push(lines[bi]); bi++; }
        mathContent = mathLines.join("\n");
        li = bi < lines.length ? bi + 1 : bi;
      } else {
        const m = /^\$\$(.+)\$\$$/.exec(trimmed);
        mathContent = m?.[1] ?? trimmed.slice(2);
        li++;
      }
      result.push(renderKatexNode(mathContent, true, `math${li}`));
      continue;
    }

    // Table block: header row + separator row + body rows
    if (
      isTableRowLine(line) &&
      li + 1 < lines.length &&
      isTableRowLine(lines[li + 1]) &&
      TABLE_SEPARATOR_RE.test(lines[li + 1]) &&
      lines[li + 1].includes("-")
    ) {
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[li + 1]);
      const bodyRows: string[][] = [];
      let bi = li + 2;
      while (bi < lines.length && isTableRowLine(lines[bi]) && !TABLE_SEPARATOR_RE.test(lines[bi])) {
        bodyRows.push(splitTableRow(lines[bi]));
        bi++;
      }
      result.push(renderMdTable(headerCells, aligns, bodyRows, `tbl${li}`, inline));
      li = bi;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)/.exec(line);
    const hrMatch = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(line);
    const quoteMatch = /^(>+)\s?(.*)/.exec(line);
    const olMatch = /^(\s*)(\d+)\.\s+(.*)/.exec(line);
    const ulMatch = /^(\s*)[-*+]\s+(.*)/.exec(line);

    if (headingMatch) {
      const level = headingMatch?.[1]?.length ?? 3;
      const cls = HEADING_SIZES[level] ?? HEADING_SIZES[3];
      result.push(<div key={li} className={cls}>{inline(headingMatch?.[2] ?? "", `h${li}`)}</div>);
    }
    else if (hrMatch) result.push(<hr key={li} className="my-2 border-white/10" />);
    else if (quoteMatch) {
      const ql = quoteMatch?.[1]?.length ?? 1;
      result.push(
        <div key={li} style={{ marginLeft: (ql - 1) * 12 }}
             className="border-l-2 border-white/20 pl-2 ml-1 text-white/70 my-0.5">
          {inline(quoteMatch?.[2] ?? "", `q${li}`)}
        </div>
      );
    }
    else if (olMatch) result.push(renderOlItem(li, olMatch?.[1] ?? "", olMatch?.[2] ?? "1", olMatch?.[3] ?? "", inline, `ol${li}`));
    else if (ulMatch) result.push(renderUlItem(li, ulMatch?.[1] ?? "", ulMatch?.[2] ?? "", inline, `ul${li}`));
    else if (line.trim() === "") { if (li < lines.length - 1) result.push(<div key={li} className="h-5" />); }
    else result.push(<div key={li}>{inline(line, `ln${li}`)}</div>);

    li++;
  }
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
    const re = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\[\d+\]|\*[^*\n]+\*|_[^_\n]+_|\$[^$\n]+\$|<(?:sup|sub|ins|kbd|mark|s)>[^<]*<\/(?:sup|sub|ins|kbd|mark|s)>)/g;
    let last = 0; let m; let k = 0;
    // First pass: parse markdown into segments
    const segments: Array<{ text: string; type: "plain" | "bold" | "italic" | "strike" | "code" | "cite" | "link" | "math" | "html"; href?: string }> = [];
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) segments.push({ text: str.slice(last, m.index), type: "plain" });
      const tok = m[0];
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (tok.startsWith("**")) segments.push({ text: tok.slice(2, -2), type: "bold" });
      else if (tok.startsWith("~~")) segments.push({ text: tok.slice(2, -2), type: "strike" });
      else if (tok.startsWith("`")) segments.push({ text: tok.slice(1, -1), type: "code" });
      else if (tok.startsWith("$")) segments.push({ text: tok.slice(1, -1), type: "math" });
      else if (tok.startsWith("<")) segments.push({ text: tok, type: "html" });
      else if (linkMatch) segments.push({ text: linkMatch[1], type: "link", href: linkMatch[2] });
      else if (tok.startsWith("[")) segments.push({ text: tok, type: "cite" });
      else segments.push({ text: tok.slice(1, -1), type: "italic" });
      last = m.index + tok.length;
    }
    if (last < str.length) segments.push({ text: str.slice(last), type: "plain" });

    if (!animateTrailing) {
      // Static render — same as renderMd
      for (const seg of segments) {
        if (seg.type === "bold") parts.push(<strong key={`${key}-b${k++}`}>{seg.text}</strong>);
        else if (seg.type === "italic") parts.push(<em key={`${key}-i${k++}`}>{seg.text}</em>);
        else if (seg.type === "strike") parts.push(<del key={`${key}-s${k++}`}>{seg.text}</del>);
        else if (seg.type === "code") parts.push(<code key={`${key}-c${k++}`}>{seg.text}</code>);
        else if (seg.type === "math") parts.push(renderKatexNode(seg.text, false, `${key}-m${k++}`));
        else if (seg.type === "html") {
          const hm = HTML_TAG_RE.exec(seg.text);
          if (hm) {
            const Tag = hm[1] as keyof React.JSX.IntrinsicElements;
            const cls = hm[1] === "kbd" ? "font-mono text-[0.8em] bg-white/10 border border-white/20 rounded px-1 py-0.5"
              : hm[1] === "ins" ? "underline decoration-white/60"
              : hm[1] === "mark" ? "bg-yellow-400/30 text-yellow-100 px-0.5 rounded"
              : undefined;
            parts.push(React.createElement(Tag, { key: `${key}-h${k++}`, className: cls }, hm[2]));
          } else parts.push(<span key={`${key}-h${k++}`}>{seg.text}</span>);
        }
        else if (seg.type === "link") {
          const href = safeExternalHref(seg.href);
          parts.push(href
            ? <a key={`${key}-a${k++}`} href={href} target="_blank" rel="noopener noreferrer"
                className="text-sky-400 hover:text-sky-300 underline underline-offset-2">{seg.text}</a>
            : <span key={`${key}-a${k++}`}>{seg.text}</span>
          );
        }
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
    // cite/link/math/html segments are rendered as static nodes inline with the animated chars.
    const allChars: Array<{ char: string; type: "plain" | "bold" | "italic" | "strike" | "code" | "static_node"; node?: React.ReactNode }> = [];
    for (const seg of segments) {
      if (seg.type === "cite") {
        const idx = parseInt(seg.text.slice(1, -1), 10) - 1;
        const src = sources?.[idx];
        const node = src
          ? <a key={`cite-${k++}`} href={src.uri} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center justify-center w-4 h-4 text-[9px] font-semibold rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors align-super leading-none mx-0.5 no-underline"
               title={src.title}>{idx + 1}</a>
          : <span key={`cite-${k++}`} className="text-white/40 text-[9px] align-super">{seg.text}</span>;
        allChars.push({ char: "", type: "static_node", node });
        continue;
      }
      if (seg.type === "link") {
        const href = safeExternalHref(seg.href);
        const node = href
          ? <a key={`link-${k++}`} href={href} target="_blank" rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300 underline underline-offset-2">{seg.text}</a>
          : <span key={`link-${k++}`}>{seg.text}</span>;
        allChars.push({ char: "", type: "static_node", node });
        continue;
      }
      if (seg.type === "math") {
        allChars.push({ char: "", type: "static_node", node: renderKatexNode(seg.text, false, `math-${k++}`) });
        continue;
      }
      if (seg.type === "html") {
        const hm = HTML_TAG_RE.exec(seg.text);
        let node: React.ReactNode;
        if (hm) {
          const Tag = hm[1] as keyof React.JSX.IntrinsicElements;
          const cls = hm[1] === "kbd" ? "font-mono text-[0.8em] bg-white/10 border border-white/20 rounded px-1 py-0.5"
            : hm[1] === "ins" ? "underline decoration-white/60"
            : hm[1] === "mark" ? "bg-yellow-400/30 text-yellow-100 px-0.5 rounded"
            : undefined;
          node = React.createElement(Tag, { key: `html-${k++}`, className: cls }, hm[2]);
        } else {
          node = <span key={`html-${k++}`}>{seg.text}</span>;
        }
        allChars.push({ char: "", type: "static_node", node });
        continue;
      }
      const chars = splitGraphemes(seg.text);
      for (const ch of chars) {
        if (ch) allChars.push({ char: ch, type: seg.type as "plain" | "bold" | "italic" | "strike" | "code" });
      }
    }

    const animStart = Math.max(0, allChars.length - ANIMATE_WINDOW);
    for (let i = 0; i < allChars.length; i++) {
      const { char, type } = allChars[i];
      const shouldAnimate = i >= animStart;
      const cls = shouldAnimate ? "stream-token" : undefined;
      const delay = shouldAnimate ? { animationDelay: `${Math.min((i - animStart) * 8, 420)}ms` } : undefined;

      if (type === "static_node") {
        parts.push((allChars[i] as any).node as React.ReactNode);
      } else if (type === "bold") {
        parts.push(<strong key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</strong>);
      } else if (type === "italic") {
        parts.push(<em key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</em>);
      } else if (type === "strike") {
        parts.push(<del key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</del>);
      } else if (type === "code") {
        parts.push(<code key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</code>);
      } else {
        parts.push(<span key={`${key}-ch${k++}`} className={cls} style={delay}>{char}</span>);
      }
    }
    return parts;
  };

  const lastNonEmptyIdx = lines.length - 1 - [...lines].reverse().findIndex(l => l.trim() !== "");
  const tableInline = (str: string, key: string): React.ReactNode => inlineAnimated(str, key, false);

  const inlineAnimatedWithCursor = (str: string, key: string, isLast: boolean) => {
    const parts = inlineAnimated(str, key, isLast);
    if (isLast) {
      if (Array.isArray(parts)) {
        return [...parts, <span key="cursor" className="stream-cursor" />];
      }
      return (
        <>
          {parts}
          <span key="cursor" className="stream-cursor" />
        </>
      );
    }
    return parts;
  };

  let li = 0;
  while (li < lines.length) {
    const line = lines[li];

    const codeFenceMatch = /^```([a-zA-Z0-9+#.-]*)\s*$/.exec(line);
    if (codeFenceMatch) {
      const codeLines: string[] = [];
      let bi = li + 1;
      while (bi < lines.length && !/^```\s*$/.test(lines[bi])) {
        codeLines.push(lines[bi]);
        bi++;
      }
      result.push(renderCodeBlock(codeLines.join("\n"), codeFenceMatch?.[1], `code${li}`));
      li = bi < lines.length ? bi + 1 : bi;
      continue;
    }

    // Block math: $$ ... $$ (rendered statically — no animation inside formulas)
    const trimmedLine = line.trim();
    if (trimmedLine === "$$" || /^\$\$[^\s]/.test(trimmedLine)) {
      let mathContent: string;
      if (trimmedLine === "$$") {
        const mathLines: string[] = [];
        let bi = li + 1;
        while (bi < lines.length && lines[bi].trim() !== "$$") { mathLines.push(lines[bi]); bi++; }
        mathContent = mathLines.join("\n");
        li = bi < lines.length ? bi + 1 : bi;
      } else {
        const mm = /^\$\$(.+)\$\$$/.exec(trimmedLine);
        mathContent = mm?.[1] ?? trimmedLine.slice(2);
        li++;
      }
      result.push(renderKatexNode(mathContent, true, `math${li}`));
      continue;
    }

    // Table block: header row + separator row + body rows (rendered statically, no animation)
    if (
      isTableRowLine(line) &&
      li + 1 < lines.length &&
      isTableRowLine(lines[li + 1]) &&
      TABLE_SEPARATOR_RE.test(lines[li + 1]) &&
      lines[li + 1].includes("-")
    ) {
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[li + 1]);
      const bodyRows: string[][] = [];
      let bi = li + 2;
      while (bi < lines.length && isTableRowLine(lines[bi]) && !TABLE_SEPARATOR_RE.test(lines[bi])) {
        bodyRows.push(splitTableRow(lines[bi]));
        bi++;
      }
      result.push(renderMdTable(headerCells, aligns, bodyRows, `tbl${li}`, tableInline));
      li = bi;
      continue;
    }

    const isLastLine = li === lastNonEmptyIdx;
    const headingMatch = /^(#{1,6})\s+(.*)/.exec(line);
    const hrMatch = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(line);
    const quoteMatch = /^(>+)\s?(.*)/.exec(line);
    const olMatch = /^(\s*)(\d+)\.\s+(.*)/.exec(line);
    const ulMatch = /^(\s*)[-*+]\s+(.*)/.exec(line);
    const lineInline = (str: string, key: string) => inlineAnimatedWithCursor(str, key, isLastLine);

    if (headingMatch) {
      const level = headingMatch?.[1]?.length ?? 3;
      const cls = HEADING_SIZES[level] ?? HEADING_SIZES[3];
      result.push(<div key={li} className={cls}>{inlineAnimatedWithCursor(headingMatch?.[2] ?? "", `h${li}`, isLastLine)}</div>);
    } else if (hrMatch) {
      result.push(<hr key={li} className="my-2 border-white/10" />);
    } else if (quoteMatch) {
      const ql = quoteMatch?.[1]?.length ?? 1;
      result.push(
        <div key={li} style={{ marginLeft: (ql - 1) * 12 }}
             className="border-l-2 border-white/20 pl-2 ml-1 text-white/70 my-0.5">
          {inlineAnimatedWithCursor(quoteMatch?.[2] ?? "", `q${li}`, isLastLine)}
        </div>
      );
    } else if (olMatch) {
      result.push(renderOlItem(li, olMatch?.[1] ?? "", olMatch?.[2] ?? "1", olMatch?.[3] ?? "", lineInline, `ol${li}`));
    } else if (ulMatch) {
      result.push(renderUlItem(li, ulMatch?.[1] ?? "", ulMatch?.[2] ?? "", lineInline, `ul${li}`));
    } else if (line.trim() === "") {
      if (li < lines.length - 1) result.push(<div key={li} className="h-5" />);
    } else {
      result.push(<div key={li}>{inlineAnimatedWithCursor(line, `ln${li}`, isLastLine)}</div>);
    }

    li++;
  }

  // If the stream ends in a block-only element, avoid rendering a standalone
  // cursor row. Text lines already attach the cursor inline after the last char.

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
  return inferCanvasLanguage(language, content);
}

function canvasFilename(language: string): string {
  const ext = CANVAS_LANGUAGE_EXT[language] || "txt";
  return `agent-canvas.${ext}`;
}

function isMarkdownArtifact(language?: string, label?: string, contentType?: string): boolean {
  const lang = normalizeCanvasLanguage(language);
  return lang === "md"
    || lang === "markdown"
    || /\.(md|markdown)$/i.test(label || "")
    || /\b(markdown|x-markdown)\b/i.test(contentType || "");
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function isHtmlCanvas(language: string, content: string): boolean {
  const lang = normalizeCanvasLanguage(language, content);
  return lang === "html" || /<!doctype html|<html[\s>]/i.test(content);
}

function sanitizeSearchEntryPoint(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, iframe, object, embed, form, input, button, style, link, base, meta").forEach(el => el.remove());
  template.content.querySelectorAll("*").forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if ((name === "href" || name === "src") && (value.startsWith("javascript:") || value.startsWith("data:"))) {
        el.remove();
        return;
      }
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return template.innerHTML;
}

// SECURITY: Inject a restrictive CSP meta tag into canvas HTML to prevent
// model-generated scripts from exfiltrating data via fetch() or navigating
// the top window (CR-1 fix).
function injectContentSecurityPolicy(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none';">`;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch) {
    return html.slice(0, headMatch.index + headMatch[0].length) + csp + html.slice(headMatch.index + headMatch[0].length);
  }
  // No <head> — inject at the very beginning
  return csp + html;
}

function extractCanvasCandidate(text: string): CanvasCandidate | null {
  const closed = Array.from(text.matchAll(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*?)```/g));
  let match: RegExpMatchArray | null = null;
  let live = false;

  // Known issue #7 fix: Count total backtick-fence occurrences in the text.
  // If the count is odd, an unclosed (live) fence exists — prioritize it over
  // closed blocks so streaming code isn't hidden behind a previously-closed block.
  const fenceCount = (text.match(/```/g) || []).length;

  const open = text.match(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*)$/);
  if (open && shouldPromoteFencedBlockToCanvas(open[1] || "", open[2] || "")) {
    // If there's an unclosed fence (odd count) OR no closed blocks, use the live block
    if (fenceCount % 2 === 1 || closed.length === 0) {
      match = open;
      live = true;
    }
  }
  // Fall back to largest closed block only when no live canvas should take priority
  if (!match && closed.length > 0) {
    const canvasBlocks = closed.filter(item => shouldPromoteFencedBlockToCanvas(item[1] || "", item[2] || ""));
    if (canvasBlocks.length > 0) {
      match = canvasBlocks.reduce((best, item) => (item[2].length > best[2].length ? item : best), canvasBlocks[0]);
    }
  }

  if (!match) return null;
  const content = (match[2] || "").trim();
  if (!shouldPromoteFencedBlockToCanvas(match[1] || "", content)) return null;
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
// Convert snake_case tool name to a friendlier label as a fallback when TOOL_META is missing.
function prettifyToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Surface the one argument that best describes what this tool is doing in the header.
// Priority order matches what reads naturally to a human glancing at the card.
const PRIMARY_ARG_KEYS = ["path", "url", "driveFileId", "fileId", "jobId", "tab", "query", "topic", "question", "prompt", "command", "instructions", "filename", "dir", "folderId"];
function pickPrimaryArg(args: Record<string, any>): string {
  for (const key of PRIMARY_ARG_KEYS) {
    const v = args?.[key];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? v.slice(0, 57) + "…" : v;
    }
  }
  // Fall back to the first non-empty string-ish arg.
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    const s = String(v);
    if (!s) continue;
    return `${k}: ${s.length > 50 ? s.slice(0, 47) + "…" : s}`;
  }
  return "";
}

// Renders the informational artifact produced by a tool, inline inside the
// tool card's expanded panel. No nested chevron / no card chrome — just the data.
function InlineToolArtifact({ artifact }: { artifact: NonNullable<(MessagePart & { kind: "tool_start" })["inlineArtifact"]> }) {
  const { toast } = useToast();
  if (artifact.artifactType === "workspace_listing") {
    const files = artifact.files ?? [];
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5 font-medium">{artifact.label}</div>
        {files.length === 0 ? (
          <div className="text-[12px] text-white/45 py-3">No files saved here yet.</div>
        ) : (
          <div className="rounded-lg border border-white/5 bg-black/20 divide-y divide-white/5">
            {files.slice(0, 12).map((f) => (
              <div key={f.path} className="flex items-center gap-2.5 px-3 py-1.5">
                <FolderOpen className="w-3 h-3 text-amber-200/70 shrink-0" />
                <span className="flex-1 min-w-0 text-[11.5px] text-white/80 font-mono truncate">{f.path}</span>
                <span className="text-[10px] text-white/35 shrink-0">{formatBytesShort(f.size)}</span>
              </div>
            ))}
            {files.length > 12 && (
              <div className="px-3 py-1.5 text-[10px] text-white/40 text-center">+ {files.length - 12} more</div>
            )}
          </div>
        )}
      </div>
    );
  }
  if (artifact.artifactType === "workspace_file") {
    const content = artifact.content ?? "";
    const copyContent = async () => {
      try { await navigator.clipboard.writeText(content); toast({ title: "Copied" }); } catch { /* ignore */ }
    };
    return (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-wider text-white/35 font-medium font-mono">{artifact.label}</div>
          <div className="flex items-center gap-1">
            <button onClick={copyContent} className="p-1 rounded text-white/45 hover:text-white" title="Copy"><Copy className="w-3 h-3" /></button>
            {artifact.downloadUrl && <a href={artifact.downloadUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded text-white/45 hover:text-white" title="Download"><Download className="w-3 h-3" /></a>}
          </div>
        </div>
        <pre className="text-[11px] text-white/72 font-mono p-2 rounded-lg overflow-x-auto max-h-56 whitespace-pre-wrap bg-black/30 border border-white/5">{content}</pre>
      </div>
    );
  }
  // text — render the result content inline as a clean preformatted block
  const content = artifact.content ?? "";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5 font-medium">{artifact.label}</div>
      <pre className="text-[11.5px] text-white/80 font-mono p-2 rounded-lg overflow-x-auto max-h-56 whitespace-pre-wrap bg-black/30 border border-white/5">{content}</pre>
    </div>
  );
}

// ── ToolCard ──────────────────────────────────────────────────────────────────
function ToolCard({ part }: { part: MessagePart & { kind: "tool_start" } }) {
  const meta = TOOL_META[part.name] ?? { icon: <Bot className="w-3.5 h-3.5" />, label: prettifyToolName(part.name), color: "text-white/60" };
  const pct = part.progress !== null && part.progress !== undefined ? clampPercent(Number(part.progress)) : null;
  const hasProgress = pct !== null;
  const argSummary = pickPrimaryArg(part.args);
  const argEntries = Object.entries(part.args ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const logs = part.logs ?? [];
  const hasResult = part.done && part.result !== undefined && part.result !== null;
  const inline = part.inlineArtifact;
  const hasInline = !!inline;
  const hasExpandable = argEntries.length > 0 || logs.length > 0 || hasResult || hasInline;
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // Status accent — drives the orb / pill / progress bar color. Tailwind only
  // sees literal class names, so the colors must be enumerated, not interpolated.
  type Accent = "running" | "progress" | "done" | "cancelled" | "error";
  const resultError = getToolResultError(part.result);
  const displayError = part.error ?? resultError;
  const accent: Accent = part.done
    ? (part.cancelled ? "cancelled" : displayError ? "error" : "done")
    : (hasProgress ? "progress" : "running");
  const ACCENT: Record<Accent, { orbBg: string; orbBorder: string; pingBg: string; pillBg: string; pillText: string; bar: string; dot: string }> = {
    running:   { orbBg: "bg-amber-300/12", orbBorder: "border-amber-300/30", pingBg: "bg-amber-300/30", pillBg: "bg-amber-300/14", pillText: "text-amber-300", bar: "bg-amber-300/60", dot: "bg-amber-300" },
    progress:  { orbBg: "bg-sky-400/12",   orbBorder: "border-sky-400/30",   pingBg: "bg-sky-400/30",   pillBg: "bg-sky-400/14",   pillText: "text-sky-300",   bar: "bg-sky-400",     dot: "bg-sky-400" },
    done:      { orbBg: "bg-emerald-400/12", orbBorder: "border-emerald-400/30", pingBg: "bg-emerald-400/30", pillBg: "bg-emerald-400/14", pillText: "text-emerald-200", bar: "bg-emerald-400", dot: "bg-emerald-400" },
    cancelled: { orbBg: "bg-white/8", orbBorder: "border-white/15", pingBg: "bg-white/15", pillBg: "bg-white/8", pillText: "text-white/55", bar: "bg-white/30", dot: "bg-white/40" },
    error:     { orbBg: "bg-rose-400/12", orbBorder: "border-rose-400/30", pingBg: "bg-rose-400/30", pillBg: "bg-rose-400/14", pillText: "text-rose-200", bar: "bg-rose-400", dot: "bg-rose-400" },
  };
  const A = ACCENT[accent];

  // Pretty-print the result for the raw view (avoid showing internal URLs in the summary preview).
  const resultJson = React.useMemo(() => {
    if (!hasResult) return "";
    try { return JSON.stringify(part.result, null, 2); } catch { return String(part.result); }
  }, [hasResult, part.result]);

  return (
    <div className={cn(
      "group agent-tool-v2 rounded-2xl border bg-gradient-to-br overflow-hidden transition-all",
      part.done
        ? (part.cancelled
            ? "border-white/8 from-white/[0.02] to-white/[0.01]"
            : part.error
              ? "border-rose-400/25 from-rose-500/6 to-white/[0.02]"
              : "border-emerald-400/15 from-emerald-400/4 to-white/[0.02]")
        : "border-white/10 from-white/[0.045] to-white/[0.015] shadow-[0_8px_28px_rgba(0,0,0,0.18)]",
    )}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => hasExpandable && setExpanded(v => !v)}
        className={cn(
          "w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left",
          hasExpandable ? "cursor-pointer hover:bg-white/[0.025]" : "cursor-default",
        )}
      >
        {/* Status orb */}
        <span className="relative flex items-center justify-center w-6 h-6 shrink-0">
          {!part.done && (
            <span className={cn("absolute inset-0 rounded-full animate-ping opacity-50", A.pingBg)} style={{ animationDuration: "1.8s" }} />
          )}
          <span className={cn("relative w-6 h-6 rounded-full flex items-center justify-center border", A.orbBg, A.orbBorder, meta.color)}>
            {meta.icon}
          </span>
        </span>

        {/* Label + arg pill */}
        <div className="flex-1 min-w-0 flex items-baseline gap-2 overflow-hidden">
          <span className={cn("text-[12.5px] font-semibold tracking-tight truncate min-w-0", meta.color)}>{meta.label}</span>
          {argSummary && (
            <span className="hidden sm:inline-block text-[11px] font-mono text-white/45 truncate min-w-0">
              {argSummary}
            </span>
          )}
        </div>

        {/* Status badge */}
        <span className="flex items-center gap-1.5 shrink-0 justify-end">
          {part.done ? (
            part.cancelled ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/8 text-[10px] font-medium text-white/55">
                <X className="w-3 h-3" /> Stopped
              </span>
            ) : displayError ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-400/14 text-[10px] font-medium text-rose-200">
                Failed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-400/14 text-[10px] font-medium text-emerald-200">
                <CheckCircle className="w-3 h-3" /> Done
              </span>
            )
          ) : (
            <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium", A.pillBg, A.pillText)}>
              {hasProgress
                ? <span className="tabular-nums">{pct}%</span>
                : <><Loader2 className="w-3 h-3 animate-spin" /> Running</>}
            </span>
          )}
          {hasExpandable && (
            <ChevronDown className={cn("w-3.5 h-3.5 text-white/35 transition-transform shrink-0", expanded && "rotate-180")} />
          )}
        </span>
      </button>

      {/* Mobile-only arg line so the header stays compact on narrow viewports */}
      {argSummary && (
        <div className="sm:hidden px-3.5 -mt-1.5 pb-2 text-[11px] font-mono text-white/45 truncate">
          {argSummary}
        </div>
      )}

      {/* Live progress strip — only while running */}
      {!part.done && (
        <div className="relative h-[2px] bg-white/4 overflow-hidden">
          {hasProgress ? (
            <div
              className={cn("h-full transition-[width] duration-700 ease-out", A.bar)}
              style={{ width: `${Math.max(3, pct ?? 0)}%` }}
            />
          ) : (
            <div className={cn("absolute inset-y-0 w-1/3 animate-[shimmer_1.6s_ease-in-out_infinite]", A.bar, "opacity-60")} />
          )}
        </div>
      )}

      {/* Live message — single line when running */}
      {!part.done && part.progressMsg && !expanded && (
        <div className="flex items-center gap-2 px-3.5 py-2 border-t border-white/5 text-[11px] text-white/55">
          <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse", A.dot)} />
          <span className="truncate">{part.progressMsg}</span>
        </div>
      )}

      {/* Expanded detail panel */}
      <AnimatePresence initial={false}>
        {expanded && hasExpandable && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden border-t border-white/5"
          >
            <div className="p-3 space-y-3 bg-black/15">
              {hasInline && inline && (
                <InlineToolArtifact artifact={inline} />
              )}
              {argEntries.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5 font-medium">Arguments</div>
                  <div className="space-y-1">
                    {argEntries.map(([k, v]) => {
                      const display = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
                      return (
                        <div key={k} className="flex items-start gap-2 text-[11.5px] leading-relaxed">
                          <span className="font-mono text-amber-200/70 shrink-0 min-w-[90px]">{k}</span>
                          <span className="font-mono text-white/75 break-all">{display}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {logs.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5 font-medium">Activity</div>
                  <div className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
                    {logs.map((l, i) => (
                      <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                        <span className={cn(
                          "shrink-0 w-1 h-1 rounded-full mt-1.5",
                          l.level === "error" ? "bg-rose-400" : l.level === "warn" ? "bg-amber-300" : "bg-emerald-400/70",
                        )} />
                        <span className="font-mono text-white/55">{l.msg}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {hasResult && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-[10px] uppercase tracking-wider text-white/35 font-medium">Result</div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowRaw(v => !v); }}
                      className="text-[10px] text-white/40 hover:text-white/80 underline-offset-2 hover:underline"
                    >
                      {showRaw ? "Hide raw" : "Show raw"}
                    </button>
                  </div>
                  {showRaw && (
                    <pre className="text-[10.5px] font-mono text-white/55 bg-black/30 rounded-lg p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{resultJson}</pre>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
// Tight collapsible card used when the artifact is too small to deserve a canvas modal.
function CompactTextArtifact({ label, content, downloadUrl }: { label: string; content: string; downloadUrl?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const canRenderMarkdown = isMarkdownArtifact(undefined, label);
  const copyText = async () => {
    try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <ArtifactShell
      accent="cyan"
      icon={<SquarePen className="w-3.5 h-3.5 text-cyan-200" />}
      title={label}
      subtitle={`${content.length.toLocaleString()} chars`}
      actions={
        <>
          <ShellIconButton icon={copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />} onClick={copyText} title="Copy" />
          {downloadUrl && <ShellIconButton icon={<Download className="w-3.5 h-3.5" />} href={downloadUrl} title="Download" />}
          <SaveTextToWorkspaceBtn content={content} suggestedName={label} className="!p-1.5" />
        </>
      }
    >
      {canRenderMarkdown ? (
        <div className="agent-canvas-markdown copilot-md px-4 py-3 max-h-72 overflow-auto">
          <MarkdownContent text={content} />
        </div>
      ) : (
        <pre className="text-[12px] text-white/75 font-mono px-4 py-3 whitespace-pre-wrap break-words">{content}</pre>
      )}
    </ArtifactShell>
  );
}

function TextArtifact({ label, content, downloadUrl, language, live }: { label: string; content: string; downloadUrl?: string; language?: string; live?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"code" | "preview">("preview");
  const normalizedLanguage = normalizeCanvasLanguage(language, content);
  const canPreview = isHtmlCanvas(normalizedLanguage, content);
  const canRenderMarkdown = isMarkdownArtifact(normalizedLanguage, label);
  const downloadName = label || canvasFilename(normalizedLanguage);
  const artifactUrl = React.useMemo(
    () => downloadUrl || `data:${canPreview ? "text/html" : "text/plain"};charset=utf-8,${encodeURIComponent(content)}`,
    [canPreview, content, downloadUrl],
  );
  // For short non-live, non-previewable content, drop the heavy "canvas" UI and
  // show a tight inline card. Canvas is for real artifacts the user will edit/download.
  if (!live && !canPreview && content.length <= 500) {
    return <CompactTextArtifact label={label} content={content} downloadUrl={downloadUrl} />;
  }
  const copyText = () => { void navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const preview = content.length > 3200 ? `${content.slice(0, 3200)}\n\n...` : content;
  return (
    <>
      <ArtifactShell
        accent="cyan"
        defaultOpen={!!live}
        icon={<SquarePen className="w-4 h-4 text-cyan-200" />}
        title={label}
        subtitle={`${content.length.toLocaleString()} chars${live ? " · writing live" : ""}${canPreview ? " · HTML preview" : ""}`}
        actions={
          <>
            {canPreview && (
              <button onClick={() => { setView("preview"); setOpen(true); }} className="hidden sm:inline-flex items-center text-[11px] text-emerald-100 hover:text-white px-2.5 py-1.5 rounded-lg bg-emerald-500/14 hover:bg-emerald-500/22 border border-emerald-300/15 font-semibold">Preview</button>
            )}
            <button onClick={() => setOpen(true)} className="inline-flex items-center text-[11px] text-cyan-100 hover:text-white px-2.5 py-1.5 rounded-lg bg-cyan-400/14 hover:bg-cyan-400/22 border border-cyan-300/15 font-semibold">Canvas</button>
            <ShellIconButton icon={copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />} onClick={copyText} title="Copy" />
            <ShellIconButton icon={<Download className="w-3.5 h-3.5" />} href={artifactUrl} download={downloadName} title="Download" />
            <SaveTextToWorkspaceBtn content={content} suggestedName={downloadName} className="!p-1.5" />
          </>
        }
      >
        {canRenderMarkdown ? (
          <div className="agent-canvas-markdown copilot-md p-3 max-h-72 overflow-auto">
            <MarkdownContent text={preview} />
          </div>
        ) : (
          <pre className="text-[12px] text-white/72 font-mono p-3 overflow-x-auto max-h-72 whitespace-pre-wrap bg-black/20">{preview}</pre>
        )}
      </ArtifactShell>
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
              <div className="relative z-10 flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-white/[0.035] shrink-0">
                <div className="p-2 rounded-xl bg-cyan-400/12 border border-cyan-300/15">
                  <SquarePen className="w-4 h-4 text-cyan-200" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-white truncate">{label}</p>
                  <p className="text-[11px] text-white/40">Agent canvas - {live ? "live writing, " : ""}preview, copy, download</p>
                </div>
                {(canPreview || canRenderMarkdown) && (
                  <div className="hidden sm:flex items-center gap-1 p-1 rounded-xl bg-white/6 border border-white/8">
                    <button onClick={() => setView("code")} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold", view === "code" ? "bg-cyan-400/18 text-cyan-100" : "text-white/55 hover:text-white")}>
                      <Terminal className="w-3.5 h-3.5" /> Raw
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
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  srcDoc={injectContentSecurityPolicy(content)}
                  className="flex-1 w-full bg-white"
                />
              ) : canRenderMarkdown && view === "preview" ? (
                <div className="agent-canvas-markdown agent-canvas-markdown-full copilot-md flex-1 min-h-0 overflow-auto p-4 sm:p-6">
                  <MarkdownContent text={content} />
                </div>
              ) : (
                <pre className="flex-1 min-h-0 overflow-auto p-4 sm:p-5 text-[12px] leading-relaxed text-cyan-50/82 font-mono whitespace-pre-wrap bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.10),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.025),rgba(0,0,0,0.18))]">{content}</pre>
              )}
              <div className="relative z-10 sm:hidden grid grid-cols-2 gap-2 p-3 border-t border-white/10 bg-white/[0.035] shrink-0">
                {(canPreview || canRenderMarkdown) && (
                  <>
                    <button onClick={() => setView("code")} className={cn("flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold", view === "code" ? "bg-cyan-400/18 text-cyan-100" : "bg-white/8 text-white/75")}>
                      <Terminal className="w-3.5 h-3.5" /> Raw
                    </button>
                    <button onClick={() => setView("preview")} className={cn("flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold", view === "preview" ? "bg-emerald-500/20 text-emerald-100" : "bg-white/8 text-white/75")}>
                      <Eye className="w-3.5 h-3.5" /> Preview
                    </button>
                  </>
                )}
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
  const canShare = typeof part.audioUrl === "string" && part.audioUrl.startsWith("https://");

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
        {canShare && (
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
        )}
        <button
          onClick={handleDownload}
          className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 rounded-xl font-bold text-xs text-white bg-purple-600 hover:bg-purple-500 transition-colors">
          <Download className="w-4 h-4" /> Download
        </button>
      </div>
    </div>
  );
}

// ── SaveTextToWorkspaceBtn ────────────────────────────────────────────────────
// Save inline text content (scripts, SEO packs, subtitles) directly via writeText.
function SaveTextToWorkspaceBtn({ content, suggestedName, contentType, className }: { content: string; suggestedName?: string; contentType?: string; className?: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const onSave = async () => {
    setState("saving");
    try {
      const fallback = (suggestedName || "note.txt").replace(/[^\w.\-() ]/g, "_").slice(0, 160) || "note.txt";
      const path = `notes/${fallback}`;
      const { workspaceApi } = await import("@/lib/workspace-api");
      await workspaceApi.writeText(path, content, contentType);
      setState("done");
      toast({ title: "Saved to workspace", description: path });
      setTimeout(() => setState("idle"), 2500);
    } catch (err) {
      setState("idle");
      toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" });
    }
  };
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={state !== "idle"}
      className={cn("p-1.5 rounded-lg bg-white/6 hover:bg-white/10 text-white/55 hover:text-white disabled:opacity-60", className)}
      title="Save to my workspace"
    >
      {state === "saving" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : state === "done" ? <CheckCircle className="w-3.5 h-3.5 text-green-400" /> : <FolderOpen className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── SaveToWorkspaceBtn ────────────────────────────────────────────────────────
// Imports an artifact's downloadUrl/imageUrl into the user's workspace under
// uploads/ via the workspace API. Falls back gracefully when the URL is empty.
function SaveToWorkspaceBtn({ sourceUrl, suggestedName, className }: { sourceUrl?: string; suggestedName?: string; className?: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  if (!sourceUrl) return null;
  const onSave = async () => {
    setState("saving");
    try {
      const r = await fetch(sourceUrl, { credentials: "include" });
      if (!r.ok) throw new Error(`source fetch failed: ${r.status}`);
      const blob = await r.blob();
      const inferredFromUrl = sourceUrl.split("?")[0].split("/").pop() ?? "file";
      const fallback = suggestedName || inferredFromUrl;
      const safe = fallback.replace(/[^\w.\-() ]/g, "_").slice(0, 160) || "file";
      const path = `uploads/${safe}`;
      const { workspaceApi } = await import("@/lib/workspace-api");
      const { uploadUrl } = await workspaceApi.presignPut(path, blob.size, blob.type || undefined);
      const put = await fetch(uploadUrl, { method: "PUT", body: blob, headers: blob.type ? { "Content-Type": blob.type } : undefined });
      if (!put.ok) throw new Error(`workspace upload failed: ${put.status}`);
      setState("done");
      toast({ title: "Saved to workspace", description: path });
      setTimeout(() => setState("idle"), 2500);
    } catch (err) {
      setState("idle");
      toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" });
    }
  };
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={state !== "idle"}
      className={cn("shrink-0 inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/70 text-[11px] font-medium transition-colors disabled:opacity-60", className)}
      title="Save to my workspace"
    >
      {state === "saving" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : state === "done" ? <CheckCircle className="w-3.5 h-3.5 text-green-400" /> : <FolderOpen className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">{state === "saving" ? "Saving…" : state === "done" ? "Saved" : "Save"}</span>
    </button>
  );
}

// ── ArtifactShell ────────────────────────────────────────────────────────────
// Unified collapsible card used by every artifact type. Header stays compact
// with primary actions always visible; chevron expands to reveal the body.
type ShellAccent = "emerald" | "amber" | "cyan" | "pink" | "violet" | "sky";
const SHELL_ACCENT: Record<ShellAccent, { border: string; from: string; to: string; iconBg: string; iconBorder: string; title: string }> = {
  emerald: { border: "border-emerald-400/20", from: "from-emerald-400/8",  to: "to-white/[0.02]",   iconBg: "bg-emerald-400/12", iconBorder: "border-emerald-300/15", title: "text-emerald-100" },
  amber:   { border: "border-amber-400/20",   from: "from-amber-400/8",    to: "to-orange-300/5",   iconBg: "bg-amber-400/12",   iconBorder: "border-amber-300/15",   title: "text-amber-100" },
  cyan:    { border: "border-cyan-400/20",    from: "from-cyan-400/8",     to: "to-emerald-400/4",  iconBg: "bg-cyan-400/12",    iconBorder: "border-cyan-300/15",    title: "text-cyan-100" },
  pink:    { border: "border-pink-500/25",    from: "from-pink-500/8",     to: "to-white/[0.02]",   iconBg: "bg-pink-500/15",    iconBorder: "border-pink-300/15",    title: "text-pink-100" },
  violet:  { border: "border-violet-400/20",  from: "from-violet-500/8",   to: "to-white/[0.02]",   iconBg: "bg-violet-500/15",  iconBorder: "border-violet-300/15",  title: "text-violet-100" },
  sky:     { border: "border-sky-400/20",     from: "from-sky-400/8",      to: "to-white/[0.02]",   iconBg: "bg-sky-400/12",     iconBorder: "border-sky-300/15",     title: "text-sky-100" },
};

function ArtifactShell({
  accent = "cyan",
  icon,
  title,
  subtitle,
  actions,
  defaultOpen = false,
  hideToggle = false,
  children,
}: {
  accent?: ShellAccent;
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  hideToggle?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const A = SHELL_ACCENT[accent];
  return (
    <div className={cn("agent-artifact-card rounded-2xl border bg-gradient-to-br overflow-hidden", A.border, A.from, A.to)}>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => !hideToggle && setOpen(v => !v)}
          className={cn("flex items-center gap-2.5 flex-1 min-w-0 text-left", !hideToggle && "cursor-pointer")}
        >
          <span className={cn("p-1.5 rounded-lg border shrink-0", A.iconBg, A.iconBorder)}>{icon}</span>
          <span className="flex-1 min-w-0">
            <span className={cn("block text-[12.5px] font-semibold truncate", A.title)}>{title}</span>
            {subtitle && <span className="block text-[10.5px] text-white/40 truncate mt-0.5">{subtitle}</span>}
          </span>
        </button>
        <div className="flex items-center justify-end gap-1 shrink-0 flex-wrap max-w-[48%] sm:max-w-none" onClick={(e) => e.stopPropagation()}>
          {actions}
          {!hideToggle && children !== undefined && children !== null && (
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              className="p-1.5 rounded-lg text-white/45 hover:text-white hover:bg-white/8 transition-colors"
              title={open ? "Collapse" : "Expand"}
              aria-label={open ? "Collapse" : "Expand"}
            >
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
            </button>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden border-t border-white/5"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Small icon-only action button used in artifact shell headers.
function ShellIconButton({ icon, onClick, href, download, title, accent = "white" }: { icon: React.ReactNode; onClick?: () => void; href?: string; download?: boolean | string; title: string; accent?: "white" | "emerald" }) {
  const cls = cn(
    "p-1.5 rounded-lg transition-colors",
    accent === "emerald"
      ? "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-100"
      : "text-white/55 hover:text-white hover:bg-white/8",
  );
  if (href) {
    return <a href={href} download={download as any} target={href.startsWith("blob:") || href.startsWith("data:") ? undefined : "_blank"} rel="noopener noreferrer" className={cls} title={title}>{icon}</a>;
  }
  return <button type="button" onClick={onClick} className={cls} title={title}>{icon}</button>;
}

// ── WorkspaceListingCard ─────────────────────────────────────────────────────
// Renders the result of list_workspace_files as a real interactive file list
// instead of dumping the paths as a text canvas.
function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function pickWorkspaceIcon(path: string) {
  const lower = path.toLowerCase();
  const cls = "w-3.5 h-3.5 text-amber-200/70 shrink-0";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return <ImagePlus className={cls} />;
  if (/\.(mp4|mov|webm|mkv)$/.test(lower)) return <Film className={cls} />;
  if (/\.(mp3|wav|m4a|flac|ogg)$/.test(lower)) return <Music2 className={cls} />;
  if (/\.(srt|vtt)$/.test(lower)) return <Captions className={cls} />;
  return <FolderOpen className={cls} />;
}

function WorkspaceListingCard({ part, onOpenWorkspace }: { part: MessagePart & { kind: "artifact" }; onOpenWorkspace?: () => void }) {
  const files = part.files ?? [];
  const { toast } = useToast();
  const dirLabel = part.dir ? part.dir : "/";
  const copyPath = async (path: string) => {
    try { await navigator.clipboard.writeText(path); toast({ title: "Path copied", description: path }); } catch { /* ignore */ }
  };
  const downloadOne = async (path: string) => {
    try {
      const { workspaceApi } = await import("@/lib/workspace-api");
      const { url } = await workspaceApi.getFile(path);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast({ title: "Download failed", description: (err as Error).message, variant: "destructive" });
    }
  };
  return (
    <ArtifactShell
      accent="amber"
      icon={<FolderOpen className="w-4 h-4 text-amber-200" />}
      title={part.label}
      subtitle={`${files.length} file${files.length === 1 ? "" : "s"} in ${dirLabel}`}
      actions={onOpenWorkspace ? (
        <button onClick={onOpenWorkspace} className="px-2.5 py-1.5 rounded-lg bg-amber-400/12 hover:bg-amber-400/20 border border-amber-300/15 text-[11px] font-medium text-amber-100">
          Open
        </button>
      ) : undefined}
    >
      {files.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-white/40">No files saved here yet.</div>
      ) : (
        <div className="divide-y divide-white/5">
          {files.slice(0, 12).map((f) => (
            <div key={f.path} className="group flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.025] transition-colors">
              {pickWorkspaceIcon(f.path)}
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-white/85 font-mono truncate">{f.path}</div>
                <div className="text-[10px] text-white/35">{formatBytesShort(f.size)} · {new Date(f.modifiedAt).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                <button onClick={() => copyPath(f.path)} className="p-1.5 rounded text-white/50 hover:text-white" title="Copy path">
                  <Copy className="w-3 h-3" />
                </button>
                <button onClick={() => downloadOne(f.path)} className="p-1.5 rounded text-white/50 hover:text-white" title="Download">
                  <Download className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
          {files.length > 12 && (
            <div className="px-4 py-2 text-[11px] text-white/40 text-center">+ {files.length - 12} more · open workspace to see all</div>
          )}
        </div>
      )}
    </ArtifactShell>
  );
}

// ── WorkspaceFileCard ────────────────────────────────────────────────────────
// Renders the result of read_workspace_file as a clean file preview with
// proper metadata, content preview, and download — not a "canvas" modal.
function WorkspaceFileCard({ part }: { part: MessagePart & { kind: "artifact" } }) {
  const { toast } = useToast();
  const content = part.content ?? "";
  const canRenderMarkdown = isMarkdownArtifact(undefined, part.label, part.contentType);
  const copyContent = async () => {
    try { await navigator.clipboard.writeText(content); toast({ title: "Copied to clipboard" }); } catch { /* ignore */ }
  };
  return (
    <ArtifactShell
      accent="amber"
      icon={pickWorkspaceIcon(part.label)}
      title={<span className="font-mono">{part.label}</span>}
      subtitle={[
        part.size != null ? formatBytesShort(part.size) : null,
        part.contentType ? part.contentType.split(";")[0] : null,
        `${content.length.toLocaleString()} chars`,
      ].filter(Boolean).join(" · ")}
      actions={
        <>
          <ShellIconButton icon={<Copy className="w-3.5 h-3.5" />} onClick={copyContent} title="Copy content" />
          {part.downloadUrl && <ShellIconButton icon={<Download className="w-3.5 h-3.5" />} href={part.downloadUrl} title="Download" />}
        </>
      }
    >
      {canRenderMarkdown ? (
        <div className="agent-canvas-markdown copilot-md p-3 max-h-72 overflow-auto">
          <MarkdownContent text={content} />
        </div>
      ) : (
        <pre className="text-[11.5px] text-white/75 font-mono p-3 overflow-x-auto max-h-72 whitespace-pre-wrap bg-black/20">{content}</pre>
      )}
    </ArtifactShell>
  );
}

// ── ArtifactCard ──────────────────────────────────────────────────────────────
function ArtifactCard({ part, onNavigate, onOpenWorkspace }: { part: MessagePart & { kind: "artifact" }; onNavigate?: (tab: string) => void; onOpenWorkspace?: () => void }) {
  if (part.artifactType === "workspace_listing") {
    return <WorkspaceListingCard part={part} onOpenWorkspace={onOpenWorkspace} />;
  }
  if (part.artifactType === "workspace_file") {
    return <WorkspaceFileCard part={part} />;
  }
  if (part.artifactType === "image" && part.imageUrl) {
    const dlUrl = part.downloadUrl ?? part.imageUrl;
    return (
      <ArtifactShell
        accent="pink"
        defaultOpen
        icon={<ImagePlus className="w-3.5 h-3.5 text-pink-200" />}
        title={part.label}
        subtitle={part.content || "Generated image"}
        actions={
          <>
            <ShellIconButton icon={<Download className="w-3.5 h-3.5" />} href={dlUrl} download title="Download" accent="emerald" />
            <SaveToWorkspaceBtn sourceUrl={dlUrl} suggestedName={part.label} className="!gap-1 !px-2 !py-1.5 !text-[10px]" />
          </>
        }
      >
        <div className="p-3">
          <img src={part.imageUrl} alt={part.label} className="w-full max-h-[360px] object-contain rounded-xl border border-white/10 bg-black/20" />
        </div>
      </ArtifactShell>
    );
  }
  if (part.artifactType === "download" && part.downloadUrl) {
    return (
      <ArtifactShell
        accent="emerald"
        icon={<CheckCircle className="w-3.5 h-3.5 text-emerald-300" />}
        title="Ready to download"
        subtitle={part.label}
        actions={
          <>
            <a href={part.downloadUrl} download className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white" style={{ background: "linear-gradient(135deg,#16a34a,#15803d)", boxShadow: "0 4px 16px rgba(22,163,74,0.35)" }}>
              <Download className="w-3.5 h-3.5" /> Download
            </a>
            <SaveToWorkspaceBtn sourceUrl={part.downloadUrl} suggestedName={part.label} className="!gap-1 !px-2 !py-1.5 !text-[10px]" />
            {part.tab && onNavigate && (
              <button onClick={() => onNavigate(part.tab!)} className="px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-[11px] font-medium transition-colors">Open Tab</button>
            )}
          </>
        }
      >
        <div className="px-4 py-3 text-[12px] text-white/55">
          File ready in your downloads. Click the green button above, or save a permanent copy to your workspace.
        </div>
      </ArtifactShell>
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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select the message and copy it manually." });
    }
  };
  return (
    <button type="button" onClick={() => void copy()} title="Copy" aria-label={copied ? "Message copied" : "Copy message"} className="gs-message-action-btn">
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function ReadAloudButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);
  const read = () => {
    if (!("speechSynthesis" in window)) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(clientStripTags(text));
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };
  return (
    <button type="button" onClick={read} title={speaking ? "Stop reading" : "Read aloud"} aria-label={speaking ? "Stop reading message" : "Read message aloud"} className="gs-message-action-btn">
      <Volume2 className="w-3 h-3" />
    </button>
  );
}

// ── HistoryDrawer ────────────────────────────────────────────────────────────
// Slim left-side slide-in drawer for chat history. Replaces the old full-width
// panel: groups by date, has search, modern hover states, ~340px wide so it
// previews the conversation behind it instead of covering everything.
type HistorySession = { id: string; title: string; updatedAt: Date; messages: any[] };
function groupSessionsByDate(sessions: HistorySession[]): Array<{ label: string; items: HistorySession[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400_000;
  const startOf7d = startOfToday - 6 * 86400_000;
  const startOf30d = startOfToday - 29 * 86400_000;
  const groups: Record<string, HistorySession[]> = { Today: [], Yesterday: [], "Previous 7 days": [], "Previous 30 days": [], Older: [] };
  for (const s of sessions) {
    const t = s.updatedAt.getTime();
    if (t >= startOfToday) groups.Today.push(s);
    else if (t >= startOfYesterday) groups.Yesterday.push(s);
    else if (t >= startOf7d) groups["Previous 7 days"].push(s);
    else if (t >= startOf30d) groups["Previous 30 days"].push(s);
    else groups.Older.push(s);
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

function HistoryDrawer({
  open,
  sessions,
  currentSessionId,
  onClose,
  onPickSession,
  onDeleteSession,
  onNewChat,
}: {
  open: boolean;
  sessions: HistorySession[];
  currentSessionId: string | null;
  onClose: () => void;
  onPickSession: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
  onNewChat: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s => s.title.toLowerCase().includes(q));
  }, [sessions, query]);
  const groups = useMemo(() => groupSessionsByDate(filtered), [filtered]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="agent-history-backdrop-v2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            className="agent-history-drawer"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 320 }}
            role="dialog"
            aria-label="Chat history"
          >
            <div className="agent-history-drawer-header">
              <div className="agent-history-drawer-title">
                <History className="w-3.5 h-3.5 text-white/55" />
                <span>History</span>
                <span className="agent-history-drawer-count">{sessions.length}</span>
              </div>
              <button onClick={onClose} className="agent-history-drawer-close" aria-label="Close history">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="agent-history-drawer-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-white/35">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search chats"
                className="agent-history-drawer-search-input"
              />
              {query && (
                <button onClick={() => setQuery("")} className="text-white/35 hover:text-white" aria-label="Clear search">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              onClick={onNewChat}
              className="agent-history-drawer-newchat"
            >
              <SquarePen className="w-3.5 h-3.5" />
              <span>New chat</span>
            </button>
            <div className="agent-history-drawer-list">
              {sessions.length === 0 ? (
                <div className="agent-history-drawer-empty">
                  <History className="w-6 h-6 text-white/20 mb-2" />
                  <p>No previous chats yet.</p>
                  <p className="text-[10px] text-white/30 mt-1">Your conversations will appear here.</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="agent-history-drawer-empty">
                  <p>No chats match "{query}".</p>
                </div>
              ) : (
                groups.map(group => (
                  <div key={group.label} className="agent-history-drawer-group">
                    <div className="agent-history-drawer-group-label">{group.label}</div>
                    {group.items.map(s => {
                      const active = currentSessionId === s.id;
                      const messageCount = Array.isArray(s.messages) ? s.messages.length : 0;
                      return (
                        <div
                          key={s.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open chat ${s.title || "Untitled"}`}
                          onClick={() => onPickSession(s.id)}
                          onKeyDown={e => { if (e.key === "Enter") onPickSession(s.id); }}
                          className={cn("agent-history-drawer-item group", active && "agent-history-drawer-item-active")}
                        >
                          <div className="agent-history-drawer-item-dot" />
                          <div className="flex-1 min-w-0">
                            <p className="agent-history-drawer-item-title">{s.title || "Untitled"}</p>
                            <p className="agent-history-drawer-item-meta">
                              {s.updatedAt.toLocaleString([], { hour: "2-digit", minute: "2-digit" })}
                              {messageCount > 0 && <> · {messageCount} msg{messageCount === 1 ? "" : "s"}</>}
                            </p>
                          </div>
                          <button
                            onClick={e => onDeleteSession(s.id, e)}
                            className="agent-history-drawer-item-delete"
                            aria-label="Delete chat"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ── ChatMoreMenu ─────────────────────────────────────────────────────────────
// Compact dropdown menu attached to the header "⋮" button. Houses workspace
// access + chat-level actions (share) so we don't sprout standalone icons.
function ChatMoreMenu({ isEmpty, onOpenWorkspace, onShare, onOpenHistory }: { isEmpty: boolean; onOpenWorkspace: () => void; onShare: () => void; onOpenHistory?: () => void }) {
  return (
    <div className="gs-chat-more-menu" role="menu">
      {onOpenHistory && (
        <button type="button" role="menuitem" className="gs-chat-more-menu-item" onClick={onOpenHistory}>
          <History className="w-3.5 h-3.5 text-white/70" />
          <span className="flex-1 text-left">Chat history</span>
        </button>
      )}
      <button type="button" role="menuitem" className="gs-chat-more-menu-item" onClick={onOpenWorkspace}>
        <FolderOpen className="w-3.5 h-3.5 text-amber-200" />
        <span className="flex-1 text-left">Workspace</span>
        <span className="gs-chat-more-menu-hint">Files</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="gs-chat-more-menu-item disabled:opacity-40"
        onClick={onShare}
        disabled={isEmpty}
      >
        <Share2 className="w-3.5 h-3.5 text-white/70" />
        <span className="flex-1 text-left">Copy chat</span>
      </button>
    </div>
  );
}

const MessageBubble = React.memo(function MessageBubble({ message, onNavigate, onRetry, onEdit, isStreaming, onOpenWorkspace }: { message: Message; onNavigate?: (tab: string) => void; onRetry?: () => void; onEdit?: () => void; isStreaming?: boolean; onOpenWorkspace?: () => void }) {
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
            const isErrorMsg = !isUser && (cleanContent.startsWith("Error:") || cleanContent.startsWith("Note:"));
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
          if (part.kind === "artifact") return <ArtifactCard key={i} part={part} onNavigate={onNavigate} onOpenWorkspace={onOpenWorkspace} />;
          return null;
        })}
        {isUser && onEdit && (
          <div className="gs-message-actions gs-message-actions-user">
            <button type="button" onClick={onEdit} title="Edit message" aria-label="Edit and resend message" className="gs-message-action-btn">
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
        {/* Message-level actions — render once after all parts when the assistant message is finished. */}
        {!isUser && !isStreaming && (() => {
          const allText = message.parts.filter(p => p.kind === "text").map(p => (p as any).content as string).join("\n").trim();
          if (!allText) return null;
          return (
            <div className="gs-message-actions">
              <CopyBubble text={allText} />
              <ReadAloudButton text={allText} />
              {onRetry && (
                <button type="button" onClick={onRetry} title="Regenerate" aria-label="Regenerate response from here" className="gs-message-action-btn">
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })()}
        {/* Grounding sources — shown when Gemini native Google Search grounding was used */}
        {!isUser && message.groundingSources && message.groundingSources.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-1">
            {message.searchEntryPoint && (
              <div className="text-[10px] text-white/30 px-1" dangerouslySetInnerHTML={{ __html: sanitizeSearchEntryPoint(message.searchEntryPoint) }} />
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
});

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
  const sessionsRef = useRef<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (showHistory) {
      document.body.classList.add("history-open");
    } else {
      document.body.classList.remove("history-open");
    }
    return () => document.body.classList.remove("history-open");
  }, [showHistory]);

  const [showWorkspace, setShowWorkspace] = useState(false);
  const openWorkspace = useCallback(() => setShowWorkspace(true), []);

  useEffect(() => {
    if (showWorkspace) setShowHistory(false);
  }, [showWorkspace]);

  useEffect(() => {
    if (showHistory) setShowWorkspace(false);
  }, [showHistory]);


  useEffect(() => {
    if (showWorkspace) {
      document.body.classList.add("workspace-open");
    } else {
      document.body.classList.remove("workspace-open");
    }
    return () => document.body.classList.remove("workspace-open");
  }, [showWorkspace]);

  const [showMoreMenu, setShowMoreMenu] = useState(false);
  // ChatMoreMenu is mounted twice (mobile pill + desktop header). A single
  // moreMenuRef pointed at only one wrapper, so clicking inside the OTHER
  // tripped click-outside and unmounted the menu before the menu item's
  // onClick could fire (mousedown happens before click). Track both wrappers
  // and check membership.
  const moreMenuRefs = useRef<Set<HTMLDivElement>>(new Set());
  const registerMoreMenuRef = useCallback((el: HTMLDivElement | null) => {
    const set = moreMenuRefs.current;
    if (el) set.add(el);
    // Note: we deliberately don't remove on unmount — React calls this with
    // null on unmount and the set is cleaned up by the next mount cycle.
  }, []);
  const [input, setInput] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const branchFromMessageIdRef = useRef<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [reconnectBanner, setReconnectBanner] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
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
  // ── Skills ──
  type SkillMeta = { id: string; name: string; description: string; icon: string; category: string; starters?: string[]; tags?: string[] };
  const [availableSkills, setAvailableSkills] = useState<SkillMeta[]>([]);
  const [agentCapabilities, setAgentCapabilities] = useState({ createImage: false, createMusic: false });
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
  // Persist the full reasoning mode so flash/pro/advanced all survive a reload.
  useEffect(() => {
    try { localStorage.setItem(REASONING_KEY, reasoningMode); } catch { }
  }, [reasoningMode]);
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

  useEffect(() => {
    if (!showMoreMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Only close when the click is outside ALL wrappers currently mounted.
      let inside = false;
      for (const el of moreMenuRefs.current) {
        if (el.isConnected && el.contains(target)) { inside = true; break; }
      }
      if (!inside) setShowMoreMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMoreMenu]);

  // ── Esc key closes any open drawers/menus — keyboard parity with click-out ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Closing in priority order: top-most overlay first.
      if (showSlashMenu) { setShowSlashMenu(false); return; }
      if (showPlusMenu) { setShowPlusMenu(false); return; }
      if (showMoreMenu) { setShowMoreMenu(false); return; }
      if (showReasoningMenu) { setShowReasoningMenu(false); return; }
      if (showWorkspace) { setShowWorkspace(false); return; }
      if (showHistory) { setShowHistory(false); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSlashMenu, showPlusMenu, showMoreMenu, showReasoningMenu, showWorkspace, showHistory]);

  // Fetch available skills on mount
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/agent/skills`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.skills) setAvailableSkills(d.skills);
        if (d?.capabilities) {
          setAgentCapabilities({
            createImage: d.capabilities.createImage === true,
            createMusic: d.capabilities.createMusic === true,
          });
        }
      })
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

  // Filtered skills for slash menu — memoized so we can clamp the active
  // index on the same render the filter changes.
  const slashFilteredSkills = useMemo(() => availableSkills.filter(s =>
    !slashQuery || s.name.toLowerCase().includes(slashQuery.toLowerCase()) || s.id.toLowerCase().includes(slashQuery.toLowerCase())
  ), [availableSkills, slashQuery]);

  useEffect(() => {
    // If the filtered list shrinks past the current selected index, clamp it.
    // Without this, pressing Enter could index off the array end.
    if (slashFilteredSkills.length === 0) { setSlashMenuIndex(0); return; }
    setSlashMenuIndex(i => Math.min(Math.max(0, i), slashFilteredSkills.length - 1));
  }, [slashFilteredSkills.length]);

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

  const applyComposerValue = useCallback((value: string) => {
    setInput(value);
    handleSlashInput(value);
    const trimmed = value.trim();
    setPasteUrl(/^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null);
  }, [handleSlashInput]);

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

  const consumeLeadingSkillCommand = useCallback((rawText: string) => {
    const match = rawText.trimStart().match(/^\/([a-z0-9-]+)(?:\s+|$)/i);
    if (!match) return { text: rawText, skills: activeSkillsRef.current, consumed: false };

    const skillId = match[1].toLowerCase();
    const skill = availableSkills.find(s => s.id.toLowerCase() === skillId);
    if (!skill) return { text: rawText, skills: activeSkillsRef.current, consumed: false };

    const nextSkills = activeSkillsRef.current.includes(skill.id)
      ? activeSkillsRef.current
      : [...activeSkillsRef.current, skill.id];
    const text = rawText.trimStart().slice(match[0].length).trimStart();
    return { text, skills: nextSkills, consumed: true };
  }, [availableSkills]);

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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === " ") return;
      if (isEditableTarget(event.target)) return;

      const textarea = textareaRef.current;
      if (!textarea) return;

      event.preventDefault();
      textarea.focus();
      applyComposerValue(`${textarea.value}${event.key}`);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        const length = el.value.length;
        el.setSelectionRange(length, length);
      });
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [applyComposerValue]);

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

    if (isVideo || isAudio) {
      toast({ title: "Unsupported file type", description: "Video and audio files are not allowed.", variant: "destructive" });
      return;
    }

    const attachType: "image" | "video" | "audio" | "document" =
      isImage ? "image" : "document";

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
  const activeRequestIdRef = useRef<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const sessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const streamingRef = useRef(false); // Synchronous guard for concurrent send prevention (H2 fix)
  const streamingAssistantIdRef = useRef<string | null>(null);
  const lastUserTextRef = useRef<string>("");
  const lastUserAttachmentsRef = useRef<Array<{ type: string; name: string; mimeType: string; data?: string; url?: string; previewUrl?: string }>>([]);


  const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages ?? [];

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { sessionIdRef.current = currentSessionId; }, [currentSessionId]);
  useEffect(() => { messagesRef.current = currentMessages; }, [currentMessages]);

  // Load sessions on mount; runs AFTER the ref-sync effects above so
  // sessionIdRef.current isn't overwritten with null from the initial state.
  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    if (loaded.length > 0) {
      setCurrentSessionId(null);
      sessionIdRef.current = null;
    }
    try {
      const stale = sessionStorage.getItem("vm-agent-last-send");
      if (stale) {
        sessionStorage.removeItem("vm-agent-last-send");
        const parsed = JSON.parse(stale) as { text?: string };
        if (parsed?.text) setReconnectBanner(parsed.text);
      }
    } catch { /* ignore storage errors */ }
  }, []);

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
      // Use instant scroll during live streaming to prevent visual jumps from
      // smooth-scroll competing with content reflow (H19 fix).
      if (streaming) {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    });
  }, [currentMessages, streaming]);
  // Auto-scroll thought content to bottom as new thoughts stream in
  useEffect(() => {
    const el = thoughtContentRef.current;
    if (el && showThoughts) el.scrollTop = el.scrollHeight;
  }, [thoughtText, showThoughts]);
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

  const resetComposerInput = useCallback(() => {
    setInput("");
    setPasteUrl(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.overflowY = "hidden";
    });
  }, []);

  const sendMessage = useCallback(async (text: string, attachmentsArg?: Array<{ type: string; name: string; mimeType: string; data?: string; url?: string; previewUrl?: string }>) => {
    const snapshotAttachments = attachmentsArg ?? pendingAttachmentsRef.current;
    const parsedCommand = consumeLeadingSkillCommand(text);
    const messageText = parsedCommand.text;
    const snapshotSkills = parsedCommand.skills;
    if (streaming || streamingRef.current) return;
    if (!messageText.trim() && snapshotAttachments.length === 0) {
      if (parsedCommand.consumed) {
        activeSkillsRef.current = snapshotSkills;
        setActiveSkills(snapshotSkills);
        resetComposerInput();
        setShowSlashMenu(false);
        setSlashQuery("");
      }
      return;
    }
    const sessionId = ensureSession();
    const branchFromMessageId = branchFromMessageIdRef.current;
    branchFromMessageIdRef.current = null;
    setEditingMessageId(null);
    const branchIndex = branchFromMessageId
      ? messagesRef.current.findIndex(message => message.id === branchFromMessageId)
      : -1;
    const baseMessages = branchIndex >= 0
      ? messagesRef.current.slice(0, branchIndex)
      : messagesRef.current;
    resetComposerInput();
    activeSkillsRef.current = snapshotSkills;
    setActiveSkills(snapshotSkills);
    setShowSlashMenu(false);
    setSlashQuery("");
    // Keep preview object URLs alive here because persisted message bubbles and retry flows
    // may still reference `previewUrl` after send. Revoke them only when those consumers are removed.
    setPendingAttachments([]);
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    // Build user message parts — include image previews so they show in the bubble
    const userParts: MessagePart[] = [{ kind: "text", content: messageText }];
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
    updateSession(sessionId, () => [...baseMessages, {
      id: userMsgId, role: "user",
      parts: userParts,
      timestamp: new Date(),
    }]);

    upsertMsg(sessionId, assistantMsgId, m => m);
    streamingRef.current = true;
    setStreaming(true);
    setReconnectBanner(null);
    setThinking(true);
    setAgentStage("planning");
    setThoughtText("");
    setShowThoughts(false);
    setActiveToolLabel(null);
    setThoughtLabel(null);
    setPasteUrl(null); // dismiss paste pill when message is sent
    lastUserTextRef.current = messageText; // track for retry
    lastUserAttachmentsRef.current = snapshotAttachments;
    try { sessionStorage.setItem("vm-agent-last-send", JSON.stringify({ text: messageText })); } catch { /* ignore */ }
    streamingAssistantIdRef.current = assistantMsgId; // track for Stop
    const requestId = crypto.randomUUID();
    const requestController = new AbortController();
    activeRequestIdRef.current = requestId;
    abortRef.current = requestController;

    // Build history — include completed tool results as text so the agent
    // has full multi-turn memory of what tools ran and what they returned.
    const allMsgs = [...baseMessages, { id: userMsgId, role: "user" as const, parts: userParts, timestamp: new Date() }];
    
    // Find the index of the latest user message that has an image attachment with data
    let latestImageMsgIdx = -1;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
      if (allMsgs[i].role === "user" && allMsgs[i].parts.some((p: any) => p.kind === "attachment" && p.type === "image" && p.data)) {
        latestImageMsgIdx = i;
        break;
      }
    }

    const history = allMsgs
      .map((m, idx) => {
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
        // Include full attachment data (base64 images) for the latest image in the conversation.
        // Older images get lightweight reference to avoid huge payloads.
        const msgAttachments = m.role === "user"
          ? m.parts
            .filter((p: any) => p.kind === "attachment")
            .map((p: any) => {
              const isLatestImage = idx === latestImageMsgIdx;
              if (!isLatestImage && p.type === "image") {
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
        // Strip leaked tool-result residue JSON. Scoped to S3/CloudFront/empty
        // values so a model legitimately quoting `{ "url": "https://docs..." }`
        // in an answer is preserved.
        .replace(/\{"\w*[Uu]rl":\s*"(?:|https?:\/\/[^"]*\.(?:s3|amazonaws|cloudfront)[^"]*)"[^}]*\}/g, "");

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

    const surfaceStreamParseError = (err: unknown, raw: string) => {
      console.warn("[agent] Ignored malformed SSE frame", {
        error: err instanceof Error ? err.message : String(err),
        preview: raw.slice(0, 240),
      });
    };
    let sawDoneEvent = false;

    const parseSseFrame = (frame: string, isTrailing = false): boolean => {
      const raw = frame
        .split(/\r?\n/)
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!raw) return true;
      try {
        const evt = JSON.parse(raw) as SseEvent;
        if (evt.type === "done") sawDoneEvent = true;
        handleEvent(evt);
        return true;
      } catch (err) {
        surfaceStreamParseError(err, raw);
        if (isTrailing && !sawDoneEvent && activeRequestIdRef.current === requestId && !requestController.signal.aborted) {
          patchAssistant(m => ({
            ...m,
            parts: [
              ...m.parts,
              {
                kind: "text",
                content: "Note: the response stream ended with a partial update. If anything looks missing, send the request again.",
              },
            ],
          }));
        }
        return false;
      }
    };

    const handleEvent = (evt: SseEvent) => {
      // A stopped request may still flush buffered frames while a replacement
      // request is starting. Only the request that currently owns the UI may
      // update run state, messages, tools, or artifacts.
      if (activeRequestIdRef.current !== requestId) return;
      // SECURITY: Gate by runId to prevent stale stream events from corrupting
      // the active message after abort + new send (H1 fix).
      if (evt.type === "run_start") {
        setCurrentRunId(evt.runId);
        currentRunIdRef.current = evt.runId;
        return;
      }
      // Drop events from a previous run (aborted stream trailing frames)
      if ((evt as any).runId && currentRunIdRef.current && (evt as any).runId !== currentRunIdRef.current) return;
      // Drop events after the user aborted
      if (abortRef.current?.signal.aborted && evt.type !== "done") return;
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
          return { ...m, parts: [...m.parts, { kind: "tool_start", toolId: evt.toolId, name: evt.name, args: evt.args, done: false, progress: null, logs: [] }] };
        });
        return;
      }
      if (evt.type === "tool_log") {
        if (!evt.toolId) return;
        patchAssistant(m => ({
          ...m, parts: m.parts.map(p => {
            if (!(p.kind === "tool_start" && (p as any).toolId === evt.toolId && !(p as any).done)) return p;
            const prev = (p as any).logs ?? [];
            const next = [...prev, { ts: Date.now(), msg: evt.message, level: evt.level }].slice(-30);
            return { ...p, progressMsg: evt.message, logs: next };
          }),
        }));
        return;
      }
      if (evt.type === "tool_progress") {
        patchAssistant(m => {
          // When the event carries a toolId, scope the update to that
          // exact card. Otherwise, fall back to the LAST still-running tool
          // of the same name — using the *last* match means parallel calls
          // each receive their own initial progress (the first message
          // arrives before the second tool_start finishes processing
          // anyway, so this avoids stomping all updates onto card #1).
          let targetIdx = -1;
          if (evt.toolId) {
            targetIdx = m.parts.findIndex(p => p.kind === "tool_start" && (p as any).toolId === evt.toolId);
          } else {
            for (let i = m.parts.length - 1; i >= 0; i--) {
              const p = m.parts[i];
              if (p.kind === "tool_start" && (p as any).name === evt.name && !(p as any).done) {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx === -1) return m;
          const target = m.parts[targetIdx] as any;
          const msg = evt.message ?? evt.status;
          const prev = target.logs ?? [];
          const next = msg && prev[prev.length - 1]?.msg !== msg
            ? [...prev, { ts: Date.now(), msg, level: "info" as const }].slice(-30)
            : prev;
          const updated = { ...target, progress: evt.percent ?? target.progress ?? null, progressMsg: msg, logs: next };
          const parts = [...m.parts];
          parts[targetIdx] = updated;
          return { ...m, parts };
        });

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
        patchAssistant(m => {
          let matchedTool = false;
          let matchedFallbackTool = false;
          const parts = m.parts.map(p => {
            if (p.kind !== "tool_start") return p;
            const toolPart = p as any;
            const exactMatch = Boolean(evt.toolId && toolPart.toolId === evt.toolId);
            const fallbackMatch = !evt.toolId && !matchedFallbackTool && toolPart.name === evt.name && !toolPart.done;
            if (!exactMatch && !fallbackMatch) return p;
            if (fallbackMatch) matchedFallbackTool = true;
            matchedTool = true;
            const error = getToolResultError(evt.result);
            return {
              ...p,
              done: true,
              result: evt.result,
              error,
              progress: error ? toolPart.progress ?? null : 100,
            };
          });
          if (!matchedTool) {
            const error = getToolResultError(evt.result);
            parts.push({
              kind: "tool_start",
              toolId: evt.toolId,
              name: evt.name,
              args: {},
              done: true,
              result: evt.result,
              error,
              progress: error ? null : 100,
              logs: [{ ts: Date.now(), msg: "Tool completed", level: "info" as const }],
            });
          }
          return { ...m, parts };
        });

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
        {
          // Informational artifacts (text result, workspace listing, file preview, etc.) belong
          // INSIDE the tool card that produced them. Only "deliverable" artifacts
          // (download, image, audio, tab_link) render as their own prominent card.
          const informationalTypes = new Set(["text", "workspace_listing", "workspace_file"]);
          const isInformational = informationalTypes.has(evt.artifactType);
          const evtToolId = (evt as any).toolId as string | undefined;
          if (isInformational && evtToolId) {
            patchAssistant(m => {
              let matchedTool = false;
              const parts = m.parts.map(p => {
                if (!(p.kind === "tool_start" && (p as any).toolId === evtToolId)) return p;
                matchedTool = true;
                return {
                  ...p,
                  inlineArtifact: {
                    artifactType: evt.artifactType,
                    label: evt.label,
                    content: evt.content,
                    files: evt.files,
                    dir: evt.dir,
                    contentType: evt.contentType,
                    size: evt.size,
                    downloadUrl: evt.downloadUrl,
                  },
                } as MessagePart;
              });
              if (!matchedTool) {
                parts.push({ kind: "artifact", artifactType: evt.artifactType, label: evt.label, tab: evt.tab, jobId: evt.jobId, downloadUrl: evt.downloadUrl, imageUrl: evt.imageUrl, audioUrl: evt.audioUrl, content: evt.content, files: evt.files, dir: evt.dir, contentType: evt.contentType, size: evt.size });
              }
              return { ...m, parts };
            });
          } else {
            patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "artifact", artifactType: evt.artifactType, label: evt.label, tab: evt.tab, jobId: evt.jobId, downloadUrl: evt.downloadUrl, imageUrl: evt.imageUrl, audioUrl: evt.audioUrl, content: evt.content, files: evt.files, dir: evt.dir, contentType: evt.contentType, size: evt.size }] }));
          }
        }
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
        // ED-1 fix: Mark any in-flight tool cards as done/cancelled so they
        // don't show "Running..." forever after the agent errors out.
        patchAssistant(m => ({
          ...m,
          parts: m.parts.map(p =>
            p.kind === "tool_start" && !(p as any).done
              ? { ...p, done: true, cancelled: true, progress: null, progressMsg: "Agent error", result: { error: "Run encountered an error" } }
              : p),
        }));
        // Clean the error message — parse JSON if server forwarded raw API error
        let cleanMsg = evt.message ?? "Something went wrong";
        try {
          const p = JSON.parse(cleanMsg);
          const inner = p?.error?.message ?? p?.message ?? cleanMsg;
          cleanMsg = String(inner).split(/\.?\s*Please refer to https?:\/\//).shift()!.trim();
        } catch { /* not JSON */ }
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: `Error: ${cleanMsg}` }] }));
        return;
      }
      if (evt.type === "done") { setThinking(false); setAgentStage("idle"); setAgentIteration(0); try { sessionStorage.removeItem("vm-agent-last-send"); } catch { /* ignore */ } return; }
    };

    try {
      const resp = await fetch(`${BASE}/api/agent/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messages: history, model: reasoningMode, skills: snapshotSkills }),
        signal: requestController.signal,
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
          parseSseFrame(frame);
        }
      }
      // trailing buffer
      parseSseFrame(buf, true);
    } catch (err: any) {
      if (activeRequestIdRef.current === requestId && err?.name !== "AbortError") {
        if (err?.message?.includes("401") || err?.message?.includes("403")) {
          patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: "Authentication error — please refresh the page and try again." }] }));
        } else if (err?.message?.includes("503") || err?.message?.includes("502")) {
          patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: "Server is starting up — please wait a moment and try again." }] }));
        } else if (err?.message?.includes("Server error:")) {
          patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "text", content: `Error: ${err.message}` }] }));
        } else {
          // Generic connection drop (network, mobile OS suspend, etc.).
          // The server cancels all jobs on disconnect, so "job may still be running"
          // is wrong. Show a retry banner above the input instead of cluttering the chat.
          setReconnectBanner(lastUserTextRef.current);
        }
      }
      if (activeRequestIdRef.current === requestId) {
        try { sessionStorage.removeItem("vm-agent-last-send"); } catch { /* ignore */ }
      }
    } finally {
      if (activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        setThinking(false);
        setAgentStage("idle");
        streamingAssistantIdRef.current = null;
      }
    }
  }, [streaming, reasoningMode, BASE, onNavigate, updateSession, ensureSession, upsertMsg, consumeLeadingSkillCommand, resetComposerInput]);

  const messageText = useCallback((message: Message): string =>
    message.parts
      .filter((part): part is MessagePart & { kind: "text" } => part.kind === "text")
      .map(part => part.content)
      .join("\n")
      .trim(), []);

  const messageAttachments = useCallback((message: Message) => {
    const previewByName = new Map(
      message.parts
        .filter((part): part is MessagePart & { kind: "image" } => part.kind === "image")
        .map(part => [part.name, part.previewUrl]),
    );
    return message.parts
      .filter((part): part is MessagePart & { kind: "attachment" } => part.kind === "attachment")
      .map(part => ({
        type: (["image", "video", "audio", "document"].includes(part.type)
          ? part.type
          : "document") as "image" | "video" | "audio" | "document",
        name: part.name,
        mimeType: part.mimeType,
        data: part.data,
        url: part.url,
        previewUrl: previewByName.get(part.name),
      }));
  }, []);

  const editUserMessage = useCallback((message: Message) => {
    if (streamingRef.current) return;
    branchFromMessageIdRef.current = message.id;
    setEditingMessageId(message.id);
    setInput(messageText(message));
    setPendingAttachments(messageAttachments(message));
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.style.height = "auto";
      const maxHeight = getInputMaxHeight();
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    });
  }, [messageAttachments, messageText]);

  const regenerateFromAssistant = useCallback((assistantIndex: number) => {
    if (streamingRef.current) return;
    for (let index = assistantIndex - 1; index >= 0; index--) {
      const candidate = currentMessages[index];
      if (candidate?.role !== "user") continue;
      const text = messageText(candidate);
      const attachments = messageAttachments(candidate);
      branchFromMessageIdRef.current = candidate.id;
      void sendMessage(text, attachments);
      return;
    }
  }, [currentMessages, messageAttachments, messageText, sendMessage]);

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
    activeRequestIdRef.current = null;
    abortRef.current = null;
    streamingRef.current = false;
    currentRunIdRef.current = null;
    setCurrentRunId(null);
    try { sessionStorage.removeItem("vm-agent-last-send"); } catch { /* ignore */ }
    // Mark any in-flight tool cards as cancelled so they don't spin forever (and persist a dead spinner)
    const aId = streamingAssistantIdRef.current;
    const sId = sessionIdRef.current;
    if (aId && sId) {
      upsertMsg(sId, aId, m => ({
        ...m,
        parts: [
          ...m.parts.map(p =>
          p.kind === "tool_start" && !(p as any).done
            ? { ...p, done: true, cancelled: true, progress: null, progressMsg: "Stopped", result: { error: "Stopped by user" } }
            : p),
          // Append a system note so the user has a visible record they stopped the response
          { kind: "text", content: "⏹ _Response stopped by you._" },
        ],
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
      pendingAttachmentsRef.current.forEach(attachment => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
      sessionsRef.current.forEach(session => revokeMessagePreviewUrls(session.messages));
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
    if (!SR) {
      toast({ title: "Voice input not supported", description: "Try Chrome, Edge, or Safari." });
      return;
    }
    if (listening) {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
      setListening(false);
      return;
    }
    const r = new SR();
    recognitionRef.current = r;
    r.continuous = false; r.interimResults = false; r.lang = detectVoiceLang();
    r.onresult = (ev: any) => { setInput(p => p + (p ? " " : "") + (ev.results[0]?.[0]?.transcript ?? "")); setListening(false); };
    r.onend = () => { setListening(false); recognitionRef.current = null; };
    r.onerror = () => { setListening(false); recognitionRef.current = null; };
    // start() can throw synchronously when the user denies the mic prompt
    // — without a guard, the unhandled exception leaks into the click handler.
    try {
      r.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  };

  const isEmpty = currentMessages.length === 0;
  const speechSupported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const canSend = (input.trim().length > 0 || pendingAttachments.length > 0) && !streaming;

  const handleShare = async () => {
    const transcript = currentMessages.map(message => {
      const role = message.role === "user" ? "You" : "Super Agent";
      const content = message.parts.map(part => {
        if (part.kind === "text") return clientStripTags(part.content);
        if (part.kind === "attachment") return `[Attachment: ${part.name}]`;
        if (part.kind === "artifact") {
          const location = part.downloadUrl || part.imageUrl || part.audioUrl || part.tab || "";
          return `[Artifact: ${part.label}${location ? ` — ${location}` : ""}]`;
        }
        if (part.kind === "tool_start") return `[Action: ${prettifyToolName(part.name)}${part.done ? " completed" : ""}]`;
        return "";
      }).filter(Boolean).join("\n");
      return `## ${role}\n\n${content}`;
    }).filter(Boolean).join("\n\n");

    try {
      await navigator.clipboard.writeText(transcript);
      toast({ title: "Chat copied", description: "The complete conversation was copied as Markdown." });
      setShowMoreMenu(false);
    } catch {
      toast({ title: "Copy failed", description: "Your browser blocked clipboard access." });
    }
  };

  const handleNewChat = () => {
    if (streaming) return;
    branchFromMessageIdRef.current = null;
    setEditingMessageId(null);
    resetComposerInput();
    setPendingAttachments([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setShowHistory(false);
  };
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => {
      const removed = prev.find(s => s.id === id);
      if (removed) revokeMessagePreviewUrls(removed.messages);
      return prev.filter(s => s.id !== id);
    });
    if (currentSessionId === id) {
      branchFromMessageIdRef.current = null;
      setEditingMessageId(null);
      resetComposerInput();
      setPendingAttachments([]);
      setCurrentSessionId(null);
      sessionIdRef.current = null;
    }
  };

  return (
    <CopilotErrorBoundary onReset={handleNewChat}>
    <div className="copilot-wrap">
      <div className="gs-mobile-chat-topbar" aria-label="Chat actions">
        <div className={cn("gs-mobile-actions-pill gs-mobile-actions-pill-left", showHistory && "gs-mobile-actions-pill-hidden")}>
          <button
            type="button"
            onClick={() => setShowHistory(h => !h)}
            className="gs-mobile-action-btn"
            title="Chat history"
            aria-label="Toggle history"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
        <div className="gs-mobile-actions-pill">
          <button
            type="button"
            onClick={handleNewChat}
            disabled={streaming}
            className="gs-mobile-action-btn"
            title="New chat"
            aria-label="New chat"
          >
            <SquarePen className="w-5 h-5" />
          </button>
          <div ref={registerMoreMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setShowMoreMenu(v => !v)}
              className={cn("gs-mobile-action-btn", showMoreMenu && "gs-mobile-action-btn-active")}
              title="More"
              aria-label="More chat actions"
              aria-haspopup="menu"
              aria-expanded={showMoreMenu}
            >
              <MoreVertical className="w-5 h-5" />
            </button>
            {showMoreMenu && (
              <ChatMoreMenu
                isEmpty={isEmpty}
                onOpenWorkspace={() => { setShowWorkspace(true); setShowMoreMenu(false); }}
                onShare={() => { handleShare(); setShowMoreMenu(false); }}
                onOpenHistory={() => { setShowHistory(true); setShowMoreMenu(false); }}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Workspace drawer ── */}
      <WorkspacePanel open={showWorkspace} onClose={() => setShowWorkspace(false)} />

      {/* ── History drawer (slide-in from left, not full-screen) ── */}
      <HistoryDrawer
        open={showHistory}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onClose={() => setShowHistory(false)}
        onPickSession={(id) => {
          if (editingMessageId) {
            branchFromMessageIdRef.current = null;
            setEditingMessageId(null);
            resetComposerInput();
            setPendingAttachments([]);
          }
          setCurrentSessionId(id);
          sessionIdRef.current = id;
          setShowHistory(false);
        }}
        onDeleteSession={(id, e) => handleDeleteSession(id, e)}
        onNewChat={() => { handleNewChat(); setShowHistory(false); }}
      />

      {/* ── Genspark welcome (empty state) ── */}
      {isEmpty && (
        <div className="gs-welcome">
          <h1 className="gs-welcome-title">
            Super Agent
            <span className="gs-welcome-dot" aria-hidden="true" />
          </h1>
          <p className="gs-welcome-sub">Download, clip, subtitle, translate, and analyze YouTube videos — or ask anything.</p>
          <div className="gs-welcome-starters">
            {STARTERS.filter(s => !("capability" in s) || s.capability === "createImage" && agentCapabilities.createImage).map((s, i) => (
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
                const handleRetry = msg.role === "assistant" && !streaming
                  ? () => regenerateFromAssistant(idx)
                  : undefined;
                const handleEdit = msg.role === "user" && !streaming
                  ? () => editUserMessage(msg)
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
                    <MessageBubble message={msg} onNavigate={onNavigate} onRetry={handleRetry} onEdit={handleEdit} isStreaming={isLastAssistant && streaming} onOpenWorkspace={openWorkspace} />
                  </React.Fragment>
                );
              })}
            </AnimatePresence>

            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* ── Reconnect banner — shown after involuntary connection drop ── */}
      {reconnectBanner !== null && !streaming && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-amber-400/20 bg-amber-500/8">
          <span className="text-[13px] text-amber-200/80 flex-1 min-w-0 truncate">Connection dropped — retry your last message?</span>
          <button
            type="button"
            onClick={() => { void sendMessage(reconnectBanner, lastUserAttachmentsRef.current); }}
            className="shrink-0 text-[12px] font-semibold text-amber-100 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 transition-colors"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setReconnectBanner(null)}
            className="shrink-0 text-white/35 hover:text-white/70 transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Genspark input bar ── */}
      <div className="gs-input-wrap">
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
          onSubmit={e => {
            e.preventDefault();
            if (streaming) return;
            if (!input.trim() && pendingAttachments.length === 0) return;
            void sendMessage(input, pendingAttachments);
          }}
          className={cn(
            "gs-input-card",
            editingMessageId && "gs-input-card-editing",
            pendingAttachments.length > 0 && "gs-input-card-has-attachments",
          )}
        >
          {/* Attachment preview chips */}
          {pendingAttachments.length > 0 && (
            <div className="gs-input-attachments flex flex-wrap gap-1.5 px-3 pt-2">
              {pendingAttachments.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-white/10 border border-white/15 rounded-lg px-2 py-1 text-xs text-white/80">
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} className="w-6 h-6 rounded object-cover" />
                  ) : (
                    <span className="text-white/50" aria-hidden="true">
                      {a.type === "video" ? <Film className="h-3.5 w-3.5" /> : a.type === "audio" ? <Music2 className="h-3.5 w-3.5" /> : <Paperclip className="h-3.5 w-3.5" />}
                    </span>
                  )}
                  <span className="max-w-[120px] truncate">{a.name}</span>
                  <button type="button" onClick={() => removeAttachment(i)} className="ml-0.5 text-white/40 hover:text-white/80 transition-colors" aria-label={`Remove ${a.name}`}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {editingMessageId && (
            <div className="gs-editing-banner" role="status" aria-live="polite">
              <span className="gs-editing-banner-icon" aria-hidden="true"><Pencil className="h-3.5 w-3.5" /></span>
              <span className="gs-editing-banner-copy">
                <strong>Editing your message</strong>
                <span>Sending will replace the replies after it.</span>
              </span>
              <button
                type="button"
                className="gs-editing-cancel"
                aria-label="Cancel editing message"
                onClick={() => {
                  branchFromMessageIdRef.current = null;
                  setEditingMessageId(null);
                  resetComposerInput();
                  setPendingAttachments([]);
                }}
              >
                <X className="h-3.5 w-3.5" />
                <span>Cancel</span>
              </button>
            </div>
          )}
          {/* Active skill inline prefix inside textarea area */}
          {/* Slash command menu */}
          {showSlashMenu && slashFilteredSkills.length > 0 && (
            <div className="gs-slash-menu" ref={slashMenuRef} role="menu" aria-label="Slash commands">
              <div className="gs-slash-menu-header">Skills</div>
              {slashFilteredSkills.map((skill, i) => {
                const isActive = activeSkills.includes(skill.id);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    role="menuitem"
                    aria-current={i === slashMenuIndex || undefined}
                    className={cn("gs-slash-menu-item", i === slashMenuIndex && "gs-slash-menu-item-focused", isActive && "gs-slash-menu-item-active")}
                    onMouseEnter={() => setSlashMenuIndex(i)}
                    onClick={() => selectSlashSkill(skill)}
                  >
                    <div className="gs-slash-menu-item-left">
                      <div className="gs-slash-menu-item-icon">
                        {skillIconNode(skill.icon)}
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
              <button type="button" className="gs-inline-skill-prefix" onClick={() => removeActiveSkill(activeSkills[activeSkills.length - 1])} aria-label="Remove active skill">
                {activeSkills.map(sid => {
                  const skill = availableSkills.find(s => s.id === sid);
                  return `/${skill?.id ?? sid}`;
                }).join(" ")}
              </button>
            )}
          <textarea
            ref={textareaRef}
            className="gs-input-textarea gs-input-textarea-inline"
            value={input}
            aria-label="Message Super Agent"
            onChange={e => {
              const val = e.target.value;
              applyComposerValue(val);
              const target = e.currentTarget;
              requestAnimationFrame(() => {
                const maxH = getInputMaxHeight();
                target.style.height = "auto";
                const desired = target.scrollHeight;
                target.style.height = Math.min(desired, maxH) + "px";
                target.style.overflowY = desired > maxH ? "auto" : "hidden";
              });
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
                  // Defensive: stale index after rapid filter shrinking.
                  const target = slashFilteredSkills[slashMenuIndex] ?? slashFilteredSkills[0];
                  if (target) selectSlashSkill(target);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowSlashMenu(false);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Guard: do not fire send if streaming or input is effectively empty.
                // Without this, hitting Enter mid-stream queued an empty/stale request.
                if (streaming) return;
                if (!input.trim() && pendingAttachments.length === 0) return;
                void sendMessage(input, pendingAttachments);
              }
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
            placeholder={activeSkills.length > 0 ? "" : "Ask anything"}
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
                accept="image/*,.srt,.vtt,.txt,.md,.csv,.json,.pdf,.doc,.docx"
                onChange={handleFileUpload}
              />
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  className={cn("gs-input-circle-btn", showPlusMenu && "gs-input-circle-btn-active")}
                  title="More options"
                  aria-label="More options"
                  aria-haspopup="menu"
                  aria-expanded={showPlusMenu}
                  onClick={() => setShowPlusMenu(v => !v)}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {showPlusMenu && (
                  <div className="gs-plus-menu" role="menu" aria-label="Attachment options">
                    <button
                      type="button"
                      role="menuitem"
                      className="gs-plus-menu-item"
                      disabled={uploading}
                      onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); }}
                    >
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      <span>Upload Files</span>
                    </button>
                    {agentCapabilities.createImage && (
                      <button type="button" role="menuitem" className="gs-plus-menu-item"
                        onClick={() => {
                          setInput(prev => prev ? `${prev}${prev.endsWith("\n") ? "" : "\n"}Create an image: ` : "Create an image: ");
                          setShowPlusMenu(false);
                        }}>
                        <ImagePlus className="w-4 h-4" />
                        <span>Create Image</span>
                      </button>
                    )}
                    {agentCapabilities.createMusic && (
                      <button type="button" role="menuitem" className="gs-plus-menu-item"
                        onClick={() => {
                          setInput(prev => prev ? `${prev}${prev.endsWith("\n") ? "" : "\n"}Make music: ` : "Make music: ");
                          setShowPlusMenu(false);
                        }}>
                        <Music2 className="w-4 h-4" />
                        <span>Create Music</span>
                      </button>
                    )}
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
                <button type="button" onClick={handleStop} className="gs-stop-btn" title="Stop" aria-label="Stop generating response">
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
