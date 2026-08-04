import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  ArrowUp, Scissors, Sparkles, Plus, Globe, Captions, Film, ArrowLeft,
  Square, Copy, Check, RotateCcw, ChevronDown, X, Paperclip,
  AlertTriangle, Loader2, ArrowDown, Download, FileText, Image as ImageIcon,
  FolderKanban, ArrowRight, CircleCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ProjectsSection } from "@/components/newtab/ProjectsSection";
import { ProjectDetail } from "@/components/newtab/ProjectDetail";

// ── Types ──────────────────────────────────────────────────────────────────────

type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "error"; content: string }
  | { kind: "tool_start"; toolId?: string; name: string; args: Record<string, unknown>; done?: boolean; result?: unknown }
  | { kind: "artifact"; artifactType: string; label: string; downloadUrl?: string; content?: string }
  | { kind: "project"; projectId: string; title: string; status: string; created: boolean };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: Date;
  thinkingContent?: string;
  /** Display-only record of what the user attached to this turn. */
  attachments?: Array<{ name: string; type: string }>;
};

type SseEvent =
  | { type: "run_start"; runId: string; model?: string; mode?: string }
  | { type: "model"; model: string }
  | { type: "thinking"; stage?: string }
  | { type: "thought_delta"; content: string }
  | { type: "text_delta"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; toolId?: string }
  | { type: "tool_done"; name: string; result: unknown; toolId?: string }
  | { type: "tool_progress"; name: string; message?: string }
  | { type: "artifact"; artifactType: string; label: string; downloadUrl?: string; content?: string }
  | { type: "project_created"; projectId: string; title: string; status: string; created: boolean }
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

/**
 * The rotating pronoun in the launchpad heading. `code` drives `lang`/`dir` so the
 * browser picks a script-appropriate font and lays RTL text out correctly — without
 * it Odia/Manipuri fall back to tofu and the Urdu/Kashmiri "؟" lands on the wrong side.
 */
const INDIAN_LANGUAGES: Array<{ lang: string; code: string; text: string; rtl?: boolean }> = [
  { lang: "English", code: "en", text: "you?" },
  { lang: "Hindi", code: "hi", text: "आप?" },
  { lang: "Bengali", code: "bn", text: "আপনি?" },
  { lang: "Telugu", code: "te", text: "మీరు?" },
  { lang: "Marathi", code: "mr", text: "तुम्ही?" },
  { lang: "Tamil", code: "ta", text: "நீங்கள்?" },
  { lang: "Gujarati", code: "gu", text: "તમે?" },
  { lang: "Kannada", code: "kn", text: "ನೀವು?" },
  { lang: "Malayalam", code: "ml", text: "നിങ്ങൾ?" },
  { lang: "Odia", code: "or", text: "ଆପଣ?" },
  { lang: "Punjabi", code: "pa", text: "ਤੁਸੀਂ?" },
  { lang: "Assamese", code: "as", text: "আপুনি?" },
  { lang: "Urdu", code: "ur", text: "آپ؟", rtl: true },
  { lang: "Maithili", code: "mai", text: "अहाँ?" },
  { lang: "Sanskrit", code: "sa", text: "भवान्?" },
  // Meitei written in Bengali script (Meetei Mayek ꯅꯍꯥꯛ has almost no default font coverage).
  { lang: "Manipuri", code: "mni", text: "নহাক্?" },
  { lang: "Kashmiri", code: "ks", text: "تُہہِ؟", rtl: true },
];

const CHIPS = [
  { id: "edit", label: "Edit Videos", prompt: "Edit video with AI cuts, transitions, and audio sync.", icon: Film },
  { id: "clips", label: "Create Clips", prompt: "Extract top viral clips and short moments from this video.", icon: Scissors },
  { id: "subtitles", label: "Auto Subtitles", prompt: "Generate auto subtitles and multi-language captions for this video.", icon: Captions },
];

const BASE = typeof import.meta !== "undefined" ? import.meta.env.BASE_URL.replace(/\/$/, "") : "";

/** Server body parser caps requests at 10MB and base64 inflates by ~4/3. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 7 * 1024 * 1024;

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

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map(p => p.content)
    .join("\n");
}

function revokeAttachmentPreviews(list: Attachment[]): void {
  for (const attachment of list) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

function safeHref(href?: string): string | null {
  if (!href) return null;
  if (/^(https?:|mailto:|#|\/)/i.test(href)) return href;
  return null;
}

function attachmentIcon(type: string) {
  if (type === "image") return ImageIcon;
  if (type === "video") return Film;
  if (type === "audio") return Captions;
  return FileText;
}

// ── Markdown ───────────────────────────────────────────────────────────────────
// Assistant replies are markdown; rendering them as raw text (the old behaviour)
// left `**bold**`, list markers and code fences visible in the transcript.

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-3 rounded-xl border border-white/10 bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/8 bg-white/[0.03]">
        <span className="text-[10px] uppercase tracking-wider text-white/35 font-medium">{language || "code"}</span>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="px-3 py-2.5 overflow-x-auto text-[12.5px] leading-relaxed font-mono text-cyan-50/85">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  p: ({ children }: any) => <p className="mb-3 last:mb-0 leading-[1.7]">{children}</p>,
  h1: ({ children }: any) => <h1 className="text-[20px] font-bold text-white mt-5 first:mt-0 mb-2 tracking-tight">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-[17px] font-bold text-white mt-5 first:mt-0 mb-2 tracking-tight">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-[15px] font-semibold text-white/95 mt-4 first:mt-0 mb-1.5">{children}</h3>,
  h4: ({ children }: any) => <h4 className="text-[14px] font-semibold text-white/90 mt-3.5 first:mt-0 mb-1">{children}</h4>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-3 space-y-1.5 marker:text-white/30">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-3 space-y-1.5 marker:text-white/30">{children}</ol>,
  li: ({ children }: any) => <li className="leading-[1.65] pl-0.5">{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }: any) => <em className="italic text-white/80">{children}</em>,
  hr: () => <hr className="my-4 border-white/10" />,
  blockquote: ({ children }: any) => (
    <blockquote className="my-3 pl-3 border-l-2 border-purple-400/30 text-white/65 italic">{children}</blockquote>
  ),
  a: ({ href, children }: any) => {
    const url = safeHref(href);
    if (!url) return <span>{children}</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300 underline underline-offset-2">
        {children}
      </a>
    );
  },
  table: ({ children }: any) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-[13px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-white/[0.04]">{children}</thead>,
  th: ({ children }: any) => <th className="text-left px-3 py-2 font-semibold text-white/80 border-b border-white/10">{children}</th>,
  td: ({ children }: any) => <td className="px-3 py-2 text-white/70 border-b border-white/5 align-top">{children}</td>,
  pre: ({ children }: any) => {
    const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
    if (React.isValidElement(child) && (child.type === "code" || (child.props as any)?.className)) {
      const props = child.props as { className?: string; children?: React.ReactNode };
      const language = /language-([a-zA-Z0-9+#.-]+)/.exec(props.className || "")?.[1];
      return <CodeBlock code={String(props.children ?? "").replace(/\n$/, "")} language={language} />;
    }
    return <CodeBlock code={String(children ?? "")} />;
  },
  code: ({ className, children }: any) => {
    // Fenced blocks arrive wrapped in <pre> and are handled above; this is inline code.
    if (className?.includes("language-")) return <code className={className}>{children}</code>;
    return <code className="px-1.5 py-0.5 rounded bg-white/10 text-[12.5px] font-mono text-cyan-100/90">{children}</code>;
  },
};

function Markdown({ content, streaming }: { content: string; streaming?: boolean }) {
  const normalized = useMemo(() => content.replace(/\r\n/g, "\n").replace(/^(\s*)•\s+/gm, "$1- "), [content]);
  return (
    <div className="text-[14.5px] text-white/85" dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={MARKDOWN_COMPONENTS}>
        {normalized}
      </ReactMarkdown>
      {streaming && <span className="stream-cursor" />}
    </div>
  );
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
        className="flex items-center gap-2 text-xs text-white/45 hover:text-white/75 transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5 text-purple-400/70" />
        <span className="font-medium">{isStreaming ? "Thinking" : "Thought process"}</span>
        {isStreaming && <span className="flex gap-0.5">{[0, 1, 2].map(i => (
          <span key={i} className="w-1 h-1 rounded-full bg-purple-400/60 animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}</span>}
        <ChevronDown className={cn("w-3 h-3 transition-transform", expanded && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 pl-3 border-l-2 border-purple-500/25 text-[12.5px] text-white/40 leading-relaxed whitespace-pre-wrap font-light max-h-[280px] overflow-y-auto" dir="auto">
              {content}
              {isStreaming && <span className="stream-cursor" />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── ToolChip / ArtifactCard / ErrorCard ────────────────────────────────────────

function ToolChip({ name, done }: { name: string; done?: boolean }) {
  return (
    <div className={cn(
      "mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors",
      done ? "bg-white/[0.03] border-white/8 text-white/45" : "bg-cyan-500/[0.07] border-cyan-400/20 text-cyan-100/70",
    )}>
      {done
        ? <Check className="w-3.5 h-3.5 text-emerald-400/70" />
        : <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400/70" />}
      <span className="font-medium capitalize">{name.replace(/_/g, " ")}</span>
    </div>
  );
}

function ArtifactCard({ label, downloadUrl }: { label: string; downloadUrl?: string }) {
  return (
    <div className="mb-2 flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-cyan-500/[0.06] border border-cyan-400/15">
      <Film className="w-4 h-4 text-cyan-300/80 shrink-0" />
      <span className="text-[13px] font-medium text-cyan-100/85 flex-1 min-w-0 truncate">{label}</span>
      {downloadUrl && (
        <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/8 hover:bg-white/15 text-[11px] text-white/75 transition-colors">
          <Download className="w-3 h-3" /> Open
        </a>
      )}
    </div>
  );
}

function ProjectHandoffCard({ project, onOpen }: {
  project: Extract<MessagePart, { kind: "project" }>;
  onOpen?: (projectId: string) => void;
}) {
  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-emerald-400/20 bg-[#151a18] shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
          <FolderKanban className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-white/95">{project.created ? "Project created" : "Project updated"}</p>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-200">
              <CircleCheck className="h-3 w-3" aria-hidden="true" /> Context handed off
            </span>
          </div>
          <p className="mt-1 truncate text-[13px] font-medium text-white/80" dir="auto">{project.title}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/55">
            <span className="font-mono text-white/65">{project.projectId}</span>
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Project AI is starting
            </span>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpen?.(project.projectId)}
        className="flex min-h-11 w-full cursor-pointer items-center justify-between border-t border-white/[0.07] px-4 text-sm font-medium text-white/75 transition-colors duration-200 hover:bg-white/[0.04] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 sm:px-5"
      >
        Open project
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mb-2 flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-rose-500/[0.07] border border-rose-400/20">
      <AlertTriangle className="w-4 h-4 text-rose-300/80 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-rose-100/85 leading-relaxed break-words">{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/8 hover:bg-white/15 text-[11px] font-medium text-white/80 transition-colors">
            <RotateCcw className="w-3 h-3" /> Try again
          </button>
        )}
      </div>
    </div>
  );
}

// ── ChatMessageBubble ──────────────────────────────────────────────────────────

function ChatMessageBubble({ message, streaming, onRegenerate, onOpenProject }: {
  message: ChatMessage;
  streaming?: boolean;
  onRegenerate?: () => void;
  onOpenProject?: (projectId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const textContent = textOf(message);
  const errorParts = message.parts.filter((p): p is Extract<MessagePart, { kind: "error" }> => p.kind === "error");
  const toolParts = message.parts.filter((p): p is Extract<MessagePart, { kind: "tool_start" }> => p.kind === "tool_start");
  const artifactParts = message.parts.filter((p): p is Extract<MessagePart, { kind: "artifact" }> => p.kind === "artifact");
  const projectParts = message.parts.filter((p): p is Extract<MessagePart, { kind: "project" }> => p.kind === "project");

  const handleCopy = () => {
    void navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1.5 mb-7 group">
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            {message.attachments.map((att, i) => {
              const Icon = attachmentIcon(att.type);
              return (
                <span key={i} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] text-white/55">
                  <Icon className="w-3 h-3" />
                  <span className="truncate max-w-[140px]">{att.name}</span>
                </span>
              );
            })}
          </div>
        )}
        <div className="max-w-[85%] bg-white/[0.09] rounded-2xl rounded-tr-md px-4 py-2.5 text-[14.5px] text-white/90 leading-[1.65] whitespace-pre-wrap break-words" dir="auto">
          {textContent}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 mb-7 group">
      <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-purple-500/70 via-fuchsia-500/60 to-cyan-400/60 flex items-center justify-center mt-0.5">
        <Sparkles className="w-3.5 h-3.5 text-white/90" />
      </div>
      <div className="flex-1 min-w-0">
        {message.thinkingContent && (
          <ThinkingBlock content={message.thinkingContent} isStreaming={Boolean(streaming) && !textContent} />
        )}
        {toolParts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {toolParts.map((tool, i) => <ToolChip key={tool.toolId ?? i} name={tool.name} done={tool.done} />)}
          </div>
        )}
        {artifactParts.map((art, i) => (
          <ArtifactCard key={i} label={art.label} downloadUrl={art.downloadUrl} />
        ))}
        {projectParts.map((project) => (
          <ProjectHandoffCard key={project.projectId} project={project} onOpen={onOpenProject} />
        ))}
        {textContent && <Markdown content={textContent} streaming={streaming} />}
        {errorParts.map((err, i) => (
          <ErrorCard key={i} message={err.content} onRetry={onRegenerate} />
        ))}
        {textContent && !streaming && (
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button type="button" onClick={handleCopy} className="p-1.5 rounded-lg hover:bg-white/8 text-white/35 hover:text-white/75 transition-colors" title="Copy">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            {onRegenerate && (
              <button type="button" onClick={onRegenerate} className="p-1.5 rounded-lg hover:bg-white/8 text-white/35 hover:text-white/75 transition-colors" title="Regenerate">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AttachmentsStrip ───────────────────────────────────────────────────────────
// Declared at module scope, not inside NewTabStudio — a component defined in a render
// body is a fresh type on every render, so React would unmount/remount this subtree
// (and the file input, and the Deep Think dropdown) on every keystroke.

function AttachmentsStrip({ attachments, onRemove }: {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex gap-2 flex-wrap px-1 pb-2">
      {attachments.map((att, i) => {
        const Icon = attachmentIcon(att.type);
        return (
          <div key={`${att.name}-${i}`} className="group/att flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] text-white/65">
            {att.previewUrl
              ? <img src={att.previewUrl} alt="" className="w-5 h-5 rounded object-cover" />
              : <Icon className="w-3.5 h-3.5 text-white/40" />}
            <span className="truncate max-w-[120px]">{att.name}</span>
            <button type="button" onClick={() => onRemove(i)} className="p-0.5 rounded text-white/30 hover:text-white/80 hover:bg-white/10 transition-colors" title="Remove">
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── ConsoleToolbar ─────────────────────────────────────────────────────────────

function ConsoleToolbar({
  webSearchEnabled, onToggleWebSearch,
  onAttach, onSubmit, onStop, streaming, canSubmit,
}: {
  webSearchEnabled: boolean;
  onToggleWebSearch: () => void;
  onAttach: () => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  canSubmit: boolean;
}) {
  return (
    <div className="flex items-center justify-between pt-2 border-t border-white/5 mt-1">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onAttach} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/5 transition-colors" title="Attach file">
          <Plus className="w-4 h-4" />
        </button>
        <button type="button" onClick={onToggleWebSearch} className={cn("h-8 px-2 rounded-lg flex items-center gap-1.5 transition-colors", webSearchEnabled ? "text-cyan-300 bg-cyan-500/15 hover:bg-cyan-500/25" : "text-white/50 hover:text-white hover:bg-white/5")} title={webSearchEnabled ? "Web search on" : "Web search off"}>
          <Globe className="w-4 h-4" />
          {webSearchEnabled && <span className="text-[10px] font-medium pr-0.5">Search</span>}
        </button>
      </div>
      <div className="flex items-center gap-2">
        {streaming ? (
          <button type="button" onClick={onStop} className="w-8 h-8 rounded-xl flex items-center justify-center bg-white/10 hover:bg-white/20 text-white transition-colors" title="Stop">
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        ) : (
          <button type="button" onClick={onSubmit} disabled={!canSubmit} title="Send" className={cn("w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-300", canSubmit ? "bg-white hover:bg-white/90 text-black shadow-lg scale-100" : "bg-white/10 text-white/30 cursor-not-allowed scale-95")}>
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function NewTabStudio() {
  // ── Phase ──
  const [phase, setPhase] = useState<"launchpad" | "chatting" | "project">("launchpad");
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  // ── Launchpad ──
  const [prompt, setPrompt] = useState("");
  const [langIndex, setLangIndex] = useState(0);
  const [activeChip, setActiveChip] = useState<string | null>(null);

  // ── Toolbar ──
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // ── Chat ──
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [currentThinkingText, setCurrentThinkingText] = useState("");
  const [sessionId, setSessionId] = useState(() => `newtab-${generateId()}`);
  const [atBottom, setAtBottom] = useState(true);
  const [activeModel, setActiveModel] = useState<string | null>(null);

  const { toast } = useToast();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const attachmentsRef = useRef<Attachment[]>([]);

  // Keep a ref in sync so unmount cleanup sees the latest list.
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    revokeAttachmentPreviews(attachmentsRef.current);
    abortRef.current?.abort();
  }, []);

  // ── Language animation (launchpad only — it re-renders the tree every tick) ──
  useEffect(() => {
    if (phase !== "launchpad") return;
    const timer = setInterval(() => setLangIndex(prev => (prev + 1) % INDIAN_LANGUAGES.length), 2500);
    return () => clearInterval(timer);
  }, [phase]);

  // ── Auto-scroll, but only when the user hasn't scrolled up to read ──
  useEffect(() => {
    if (!atBottom) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentThinkingText, isThinking, atBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);

  const scrollToBottom = useCallback(() => {
    setAtBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // ── Auto-grow composers ──
  const autoGrow = (el: HTMLTextAreaElement | null, max: number) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  };
  useEffect(() => { autoGrow(chatInputRef.current, 160); }, [chatInput, phase]);
  useEffect(() => { autoGrow(inputRef.current, 200); }, [prompt, phase]);

  // ── File attachment ──
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    e.target.value = "";

    const accepted: Attachment[] = [];
    let total = attachmentsRef.current.reduce((sum, a) => sum + (a.data ? (a.data.length * 3) / 4 : 0), 0);

    for (const file of picked) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast({ title: "File too large", description: `${file.name} exceeds the 5MB limit`, variant: "destructive" });
        continue;
      }
      if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        toast({ title: "Attachment limit reached", description: `${file.name} would exceed the 7MB total limit`, variant: "destructive" });
        continue;
      }
      total += file.size;
      const data = await fileToBase64(file);
      const typeCategory = file.type.startsWith("image/") ? "image"
        : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("audio/") ? "audio" : "document";
      accepted.push({
        name: file.name, type: typeCategory, mimeType: file.type, data,
        previewUrl: typeCategory === "image" ? URL.createObjectURL(file) : undefined,
      });
    }
    if (accepted.length) setAttachments(prev => [...prev, ...accepted]);
  };

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments(prev => {
      revokeAttachmentPreviews(prev);
      return [];
    });
  }, []);

  // ── Send message ──
  // `baseMessages` is passed explicitly rather than read from state so regenerate can
  // rewind the transcript without racing the async setMessages update.
  const sendMessage = useCallback(async (
    text: string,
    baseMessages: ChatMessage[],
    outgoingAttachments: Attachment[],
  ) => {
    if (streamingRef.current || !text.trim()) return;

    const userMsg: ChatMessage = {
      id: generateId(), role: "user",
      parts: [{ kind: "text", content: text.trim() }],
      timestamp: new Date(),
      attachments: outgoingAttachments.map(a => ({ name: a.name, type: a.type })),
    };
    const assistantId = generateId();
    streamingMsgIdRef.current = assistantId;
    setMessages([...baseMessages, userMsg, {
      id: assistantId, role: "assistant", parts: [], timestamp: new Date(), thinkingContent: "",
    }]);
    setAtBottom(true);

    streamingRef.current = true;
    setStreaming(true);
    setIsThinking(true);
    setCurrentThinkingText("");

    const controller = new AbortController();
    abortRef.current = controller;

    const history = [...baseMessages, userMsg].map(m => ({
      role: m.role,
      parts: [{ text: textOf(m) }],
    }));

    let accText = "";
    let accThinking = "";

    const patchAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
      setMessages(prev => prev.map(m => m.id === assistantId ? updater(m) : m));
    };
    const setAssistantText = (value: string) => {
      accText = value;
      patchAssistant(m => ({
        ...m,
        parts: [...m.parts.filter(p => p.kind !== "text"), { kind: "text", content: accText }],
      }));
    };

    try {
      const resp = await fetch(`${BASE}/api/newtab-studio/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          messages: history,
          webSearch: webSearchEnabled,
          attachments: outgoingAttachments.map(a => ({
            name: a.name, type: a.type, mimeType: a.mimeType, data: a.data,
          })),
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        const detail = await resp.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `Server error: ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const handleEvent = (evt: SseEvent): "stop" | undefined => {
        if (evt.type === "thought_delta") {
          accThinking += evt.content;
          setCurrentThinkingText(accThinking);
          patchAssistant(m => ({ ...m, thinkingContent: accThinking }));
        }
        if (evt.type === "run_start" && evt.model) setActiveModel(evt.model);
        if (evt.type === "model") setActiveModel(evt.model);
        if (evt.type === "thinking") setIsThinking(true);
        if (evt.type === "text_delta") {
          setIsThinking(false);
          setAssistantText(accText + evt.content);
        }
        // `text` carries the complete message, not a delta — replace, don't append.
        if (evt.type === "text") {
          setIsThinking(false);
          setAssistantText(evt.content);
        }
        if (evt.type === "tool_progress" && evt.message) {
          toast({ title: evt.name.replace(/_/g, " "), description: evt.message });
        }
        if (evt.type === "tool_start") {
          patchAssistant(m => ({
            ...m,
            parts: [...m.parts, { kind: "tool_start", toolId: evt.toolId, name: evt.name, args: evt.args }],
          }));
        }
        if (evt.type === "tool_done") {
          patchAssistant(m => ({
            ...m,
            parts: m.parts.map(p => {
              if (p.kind !== "tool_start" || p.done) return p;
              // Prefer toolId; fall back to name only when the server didn't send one.
              const matches = evt.toolId ? p.toolId === evt.toolId : !p.toolId && p.name === evt.name;
              return matches ? { ...p, done: true, result: evt.result } : p;
            }),
          }));
        }
        if (evt.type === "artifact") {
          patchAssistant(m => ({
            ...m, parts: [...m.parts, { kind: "artifact", artifactType: evt.artifactType, label: evt.label, downloadUrl: evt.downloadUrl, content: evt.content }],
          }));
        }
        if (evt.type === "project_created") {
          patchAssistant(m => ({
            ...m,
            parts: [...m.parts, {
              kind: "project",
              projectId: evt.projectId,
              title: evt.title,
              status: evt.status,
              created: evt.created,
            }],
          }));
          window.dispatchEvent(new CustomEvent("newtab-project-changed", { detail: { projectId: evt.projectId } }));
        }
        if (evt.type === "error") {
          let cleanMsg = evt.message ?? "Something went wrong";
          try { const p = JSON.parse(cleanMsg); cleanMsg = String(p?.error?.message ?? p?.message ?? cleanMsg).split(/\.?\s*Please refer to https?:\/\//).shift()!.trim(); } catch { /* ok */ }
          patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "error", content: cleanMsg }] }));
          return "stop";
        }
        if (evt.type === "done") return "stop";
        return undefined;
      };

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() ?? "";

        for (const frame of frames) {
          const evt = parseSseFrame(frame);
          if (!evt) continue;
          if (handleEvent(evt) === "stop") break streamLoop;
        }
      }
      if (buf.trim()) {
        const evt = parseSseFrame(buf);
        if (evt) handleEvent(evt);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        patchAssistant(m => ({ ...m, parts: [...m.parts, { kind: "error", content: err.message }] }));
      }
    } finally {
      streamingRef.current = false;
      setStreaming(false); setIsThinking(false); setCurrentThinkingText("");
      streamingMsgIdRef.current = null; abortRef.current = null;
    }
  }, [sessionId, webSearchEnabled, toast]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    setStreaming(false); setIsThinking(false); setCurrentThinkingText("");
  }, []);

  const handleLaunchpadSubmit = () => {
    const text = prompt.trim();
    if (!text || streaming) return;
    const outgoing = attachments;
    setPhase("chatting");
    setPrompt("");
    setChatInput("");
    setAttachments([]);   // ownership moves to `outgoing`; previews are revoked after send
    void sendMessage(text, [], outgoing).finally(() => revokeAttachmentPreviews(outgoing));
  };

  const handleChatSubmit = () => {
    const text = chatInput.trim();
    if (!text || streaming) return;
    const outgoing = attachments;
    setChatInput("");
    setAttachments([]);
    void sendMessage(text, messages, outgoing).finally(() => revokeAttachmentPreviews(outgoing));
  };

  /** Rewinds to the user turn that produced `messageIndex` and re-asks it. */
  const handleRegenerate = (messageIndex: number) => {
    if (streaming) return;
    let userIndex = -1;
    for (let i = messageIndex - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") { userIndex = i; break; }
    }
    if (userIndex < 0) return;
    const base = messages.slice(0, userIndex);
    void sendMessage(textOf(messages[userIndex]!), base, []);
  };

  const startNewChat = () => {
    stopStreaming();
    setMessages([]);
    setChatInput("");
    setSessionId(`newtab-${generateId()}`);
    clearAttachments();
    setPhase("launchpad");
  };

  const handleLaunchpadKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleLaunchpadSubmit(); }
  };
  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSubmit(); }
  };
  const handleChipClick = (chipPrompt: string, chipId: string) => {
    setActiveChip(chipId);
    setPrompt(chipPrompt);
    inputRef.current?.focus();
  };
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const openProject = useCallback((projectId: string) => {
    setOpenProjectId(projectId);
    setPhase("project");
  }, []);
  const closeProject = useCallback(() => {
    setOpenProjectId(null);
    setPhase("launchpad");
  }, []);
  const useExamplePrompt = useCallback((example: string) => {
    setPrompt(example);
    inputRef.current?.focus();
  }, []);

  // A single file input for both views, rendered from the component body so it is
  // never remounted mid-picker (which would silently drop the user's selection).
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      className="hidden"
      multiple
      accept="image/*,video/*,audio/*,.txt,.srt,.vtt,.json,.csv,.pdf"
      onChange={handleFileSelect}
    />
  );

  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === "assistant") return i;
    return -1;
  })();

  // ── PROJECT DETAIL VIEW ──────────────────────────────────────────────────────
  if (phase === "project" && openProjectId) {
    return (
      <ProjectDetail
        projectId={openProjectId}
        onBack={closeProject}
        onDeleted={closeProject}
      />
    );
  }

  // ── CHAT VIEW ────────────────────────────────────────────────────────────────
  if (phase === "chatting") {
    return (
      <div className="relative w-full h-full flex-1 flex flex-col bg-transparent text-white">
        {fileInput}

        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-white/[0.06]">
          <button type="button" onClick={startNewChat} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 border border-white/8 flex items-center justify-center text-white/60 hover:text-white transition-colors" title="New chat">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white/85 truncate">New Tab Studio</h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              {webSearchEnabled && (
                <span className="px-1.5 py-[1px] rounded text-[9px] font-bold uppercase tracking-wider bg-cyan-500/15 text-cyan-300/90">Web</span>
              )}
              {activeModel && (
                <span className="text-[10px] text-white/30 font-mono truncate max-w-[160px]" title={activeModel}>
                  {activeModel}
                </span>
              )}
              {streaming && (
                <span className="flex items-center gap-1 text-[10px] text-white/35">
                  <Loader2 className="w-2.5 h-2.5 animate-spin motion-reduce:animate-none" /> Understanding request
                </span>
              )}
            </div>
          </div>
          <button type="button" onClick={startNewChat} className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-[11px] font-medium text-white/60 hover:text-white/90 transition-colors">
            <Plus className="w-3 h-3" /> New chat
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} onScroll={handleScroll} className="relative flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-6">
          <div className="max-w-[780px] mx-auto">
            {messages.map((msg, i) => (
              <ChatMessageBubble
                key={msg.id}
                message={msg}
                streaming={streaming && msg.id === streamingMsgIdRef.current}
                onRegenerate={i === lastAssistantIndex && !streaming ? () => handleRegenerate(i) : undefined}
                onOpenProject={openProject}
              />
            ))}
            {streaming && isThinking && !currentThinkingText && (
              <div className="flex gap-3 mb-7">
                <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-purple-500/70 via-fuchsia-500/60 to-cyan-400/60 flex items-center justify-center mt-0.5">
                  <Sparkles className="w-3.5 h-3.5 text-white/90" />
                </div>
                <div className="flex items-center gap-1.5 h-7">
                  {[0, 1, 2].map(i => (
                    <span key={i} className="w-1.5 h-1.5 rounded-full bg-white/35 animate-pulse" style={{ animationDelay: `${i * 0.18}s` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Jump to latest */}
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              onClick={scrollToBottom}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="absolute left-1/2 -translate-x-1/2 bottom-[132px] z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#1c1c21] border border-white/12 shadow-xl text-[11px] font-medium text-white/70 hover:text-white transition-colors"
            >
              <ArrowDown className="w-3 h-3" /> Latest
            </motion.button>
          )}
        </AnimatePresence>

        {/* Composer */}
        <div className="shrink-0 px-4 sm:px-8 pb-4 pt-2">
          <div className="max-w-[780px] mx-auto">
            <div className="relative rounded-2xl border border-white/10 bg-[#161619] p-3 shadow-xl focus-within:border-white/20 transition-colors">
              <AttachmentsStrip attachments={attachments} onRemove={removeAttachment} />
              <textarea
                ref={chatInputRef}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={handleChatKeyDown}
                disabled={streaming}
                dir="auto"
                placeholder={streaming ? "Responding…" : "Send a message"}
                className="w-full bg-transparent text-white placeholder-white/35 border-none outline-none resize-none py-1 min-h-[40px] max-h-[160px] text-[14.5px] leading-relaxed disabled:opacity-50"
                rows={1}
              />
              <ConsoleToolbar
                webSearchEnabled={webSearchEnabled}
                onToggleWebSearch={() => setWebSearchEnabled(v => !v)}
                onAttach={openFilePicker}
                onSubmit={handleChatSubmit}
                onStop={stopStreaming}
                streaming={streaming}
                canSubmit={Boolean(chatInput.trim()) && !streaming}
              />
            </div>
            <p className="text-center text-[10px] text-white/25 mt-2">
              Enter to send · Shift + Enter for a new line
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── LAUNCHPAD VIEW ───────────────────────────────────────────────────────────
  const activeLanguage = INDIAN_LANGUAGES[langIndex]!;

  return (
    <div className="newtab-studio-wrapper w-full min-h-full flex-1 flex flex-col items-center pt-[6vh] overflow-y-auto px-4 pb-20 select-none bg-transparent text-white">
      {fileInput}

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
            <motion.span
              key={langIndex}
              lang={activeLanguage.code}
              dir={activeLanguage.rtl ? "rtl" : "ltr"}
              title={activeLanguage.lang}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.35, ease: "easeInOut" }}
              // Serif only for Latin — the serif stack has no Indic coverage, so forcing
              // it on the other 16 just triggers an unstyled system-font fallback.
              className={cn(
                "text-3xl sm:text-5xl text-white tracking-tight font-normal leading-normal py-0.5",
                activeLanguage.code === "en" ? "font-serif" : "font-sans",
              )}
            >
              {activeLanguage.text}
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
            <AttachmentsStrip attachments={attachments} onRemove={removeAttachment} />
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={handleLaunchpadKeyDown}
              dir="auto"
              placeholder="How can I help you today?"
              className="w-full bg-transparent text-white placeholder-white/35 border-none outline-none resize-none py-1 min-h-[60px] max-h-[200px] text-[16px] leading-relaxed"
              rows={2}
            />
            <ConsoleToolbar
              webSearchEnabled={webSearchEnabled}
              onToggleWebSearch={() => setWebSearchEnabled(v => !v)}
              onAttach={openFilePicker}
              onSubmit={handleLaunchpadSubmit}
              onStop={stopStreaming}
              streaming={streaming}
              canSubmit={Boolean(prompt.trim()) && !streaming}
            />
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

      {/* Projects */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="w-full max-w-[760px] select-text"
      >
        <ProjectsSection onOpenProject={openProject} onUseExample={useExamplePrompt} />
      </motion.div>
    </div>
  );
}
