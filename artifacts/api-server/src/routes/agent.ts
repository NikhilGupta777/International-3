/**
 * AI Studio Copilot Agent Route â€” Full Agentic Execution
 * POST /api/agent/chat
 *
 * SSE events: text | tool_start | tool_progress | tool_done | artifact | navigate | error | done
 */

import { Router } from "express";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { randomUUID } from "crypto";
import { setupSse } from "../lib/sse";
import { createS3PresignedUpload, getS3SignedDownloadUrl, isS3StorageEnabled, uploadTextToS3 } from "../lib/s3-storage";

const router = Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const AGENT_MODEL = process.env.COPILOT_MODEL ?? "gemini-3-flash-preview";
const ULTRA_MODEL = process.env.COPILOT_ULTRA_MODEL ?? "gemini-2.5-pro";
const SEARCH_MODEL = process.env.COPILOT_SEARCH_MODEL ?? "gemini-2.5-flash"; // for grounded web search
const _FAST_MODEL = process.env.COPILOT_FAST_MODEL; // reserved for future fast-path
const ALLOWED_MODELS = new Set([
  "gemini-3-flash-preview", "gemini-2.5-flash",
  "gemini-2.5-pro", "gemini-2.5-flash-lite",
]);
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const CLIP_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 300;
const MAX_ITERATIONS = Number.parseInt(process.env.COPILOT_MAX_ITERATIONS ?? "24", 10) || 24;
const AGENT_MAX_OUTPUT_TOKENS = Number.parseInt(process.env.COPILOT_MAX_OUTPUT_TOKENS ?? "16384", 10) || 16384;
const DEFAULT_VIDEO_FORMAT_SELECTOR =
  "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/" +
  "bestvideo[ext=mp4]+bestaudio[ext=m4a]/" +
  "bestvideo[vcodec!=none]+bestaudio[acodec!=none]/" +
  "best[ext=mp4][vcodec!=none][acodec!=none]/" +
  "best[vcodec!=none][acodec!=none]";
const TOOL_PARALLEL_LIMITS = {
  light: 3,
  youtube_processing: 3,
} as const;

type ToolParallelGroup = keyof typeof TOOL_PARALLEL_LIMITS | "serial";

function getToolParallelGroup(name: string): ToolParallelGroup {
  switch (name) {
    case "get_video_info":
    case "get_youtube_captions":
    case "web_search":
    case "check_job_status":
    case "check_all_active_jobs":
    case "repeat_last_artifact":
    case "read_uploaded_file":
    case "inspect_image":
    case "ocr_image":
    case "generate_script":
    case "generate_seo_pack":
      return "light";

    case "cut_video_clip":
    case "download_video":
    case "generate_subtitles":
    case "find_best_clips":
    case "generate_timestamps":
      return "youtube_processing";

    default:
      return "serial";
  }
}

// â”€â”€ Resolve base URL for internal API calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getApiBase(req: any): string {
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE + "/api";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
  return `${proto}://${host}/api`;
}

// ── Strip model-internal tags before sending to client ─────────────────────
// Gemini 3 Flash / Pro can emit reasoning, thought, response wrappers, and our
// own [SUGGESTIONS:] marker. None of these should reach the browser as raw text.
function stripReasoningTags(text: string): string {
  return text
    // Paired tags with content
    .replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, "")
    .replace(/\[reasoning\][\s\S]*?\[\/reasoning\]/gi, "")
    .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, "")
    .replace(/\[RESPONSE\][\s\S]*?\[\/RESPONSE\]/gi, "")
    .replace(/\[JUDGE\][\s\S]*?\[\/JUDGE\]/gi, "")
    // Single-line opaque tags (model leaks these as raw text sometimes)
    .replace(/^\[THOUGHT\].*$/gim, "")
    .replace(/^\[RESPONSE\].*$/gim, "")
    .replace(/^\[JUDGE\].*$/gim, "")
    .replace(/^\[PLAN\].*$/gim, "")
    .replace(/^\[EXECUTE\].*$/gim, "")
    .replace(/^\[SAY\].*$/gim, "")
    .replace(/^\[WAIT\].*$/gim, "")
    .replace(/^\[TOOL\].*$/gim, "")
    // [SUGGESTIONS: "a" | "b" | "c"] — parsed separately, must not render
    .replace(/\[SUGGESTIONS:[^\]]*\]/gi, "")
    .replace(/\[SUGOESTIONS:[^\]]*\]/gi, "") // typo variant the model emits
    // Collapse excess blank lines left by stripping
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── SSE helper — writes and flushes immediately ───────────────────────────
function sseEvent(res: any, payload: object) {
  // Strip reasoning traces from text events
  const safePayload = (payload as any).type === "text" && (payload as any).content
    ? { ...(payload as any), content: stripReasoningTags((payload as any).content) }
    : payload;
  // Skip empty text events (after stripping)
  if ((safePayload as any).type === "text" && !(safePayload as any).content) return;
  res.write(`data: ${JSON.stringify(safePayload)}\n\n`);
  // Triple-layer flush to guarantee real-time delivery:
  // 1. Express compression middleware (if present)
  if (typeof res.flush === "function") res.flush();
  // 2. socket.write("") flushes the OS TCP send buffer past Nagle algorithm
  if (res.socket && !res.socket.destroyed) res.socket.write("");
}

// ── Job poller ────────────────────────────────────────────────────────────
async function pollJobUntilDone(
  res: any,
  toolName: string,
  progressUrl: string,
  jobId: string,
  headers: Record<string, string>,
  isConnected: () => boolean,
  toolId?: string,
): Promise<{ status: string; filename?: string; filesize?: number }> {
  const startedAt = Date.now();
  const timeoutMs = toolName === "cut_video_clip" ? CLIP_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS;
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline && isConnected()) {
    const r = await fetch(progressUrl, {
      headers: { ...headers, "Cache-Control": "no-cache" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Progress check failed: ${r.status}`);
    const data = await r.json() as any;
    const { status, percent, message, filename } = data;
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    let liveMessage = message ?? status;
    if (toolName === "cut_video_clip" && !["done", "error", "cancelled", "expired", "not_found"].includes(status)) {
      const base = message && message !== status ? message : "Cutting selected section";
      liveMessage = `${base}... ${elapsedSeconds}s`;
    }
    sseEvent(res, { type: "tool_progress", toolId, name: toolName, status, percent: percent ?? null, message: liveMessage, jobId });
    if (toolName === "cut_video_clip") {
      sseEvent(res, { type: "tool_log", toolId, name: toolName, message: liveMessage, level: "info" });
    }
    if (status === "done") return { status, filename };
    if (["error", "cancelled", "expired", "not_found"].includes(status))
      throw new Error(`Job ${status}: ${message ?? ""}`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!isConnected()) throw new Error("Client disconnected");
  throw new Error(`Job timed out after ${Math.round(timeoutMs / 60000)} minutes`);
}

// ── Subtitle job poller ───────────────────────────────────────────────────
async function pollSubtitleUntilDone(
  res: any,
  statusUrl: string,
  jobId: string,
  headers: Record<string, string>,
  isConnected: () => boolean,
  toolId?: string,
): Promise<{ status: string; srtFilename?: string }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline && isConnected()) {
    const r = await fetch(statusUrl, {
      headers: { ...headers, "Cache-Control": "no-cache" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Subtitle status check failed: ${r.status}`);
    const data = await r.json() as any;
    const { status, progressPct, message, srtFilename } = data;
    const subtitleMsg = progressPct != null ? `${message ?? status} (${progressPct}%)` : (message ?? status);
    sseEvent(res, { type: "tool_progress", toolId, name: "generate_subtitles", status, percent: progressPct ?? null, message: subtitleMsg, jobId });
    sseEvent(res, { type: "tool_log", toolId, name: "generate_subtitles", message: subtitleMsg, level: "info" });
    if (status === "done") return { status, srtFilename };
    if (["error", "cancelled"].includes(status)) throw new Error(`Subtitle job ${status}: ${message ?? ""}`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!isConnected()) throw new Error("Client disconnected");
  throw new Error("Subtitle job timed out after 8 minutes");
}

// ── Timestamps job poller ─────────────────────────────────────────────────
async function pollTimestampsUntilDone(
  res: any,
  statusUrl: string,
  jobId: string,
  headers: Record<string, string>,
  isConnected: () => boolean,
  toolId?: string,
): Promise<{ status: string; timestamps?: any }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline && isConnected()) {
    const r = await fetch(statusUrl, {
      headers: { ...headers, "Cache-Control": "no-cache" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Timestamp status check failed: ${r.status}`);
    const data = await r.json() as any;
    const { status, progressPct, message, timestamps } = data;
    const tsMsg = progressPct != null ? `${message ?? status} (${progressPct}%)` : (message ?? status);
    sseEvent(res, { type: "tool_progress", toolId, name: "generate_timestamps", status, percent: progressPct ?? null, message: tsMsg, jobId });
    sseEvent(res, { type: "tool_log", toolId, name: "generate_timestamps", message: tsMsg, level: "info" });
    if (status === "done") return { status, timestamps };
    if (["error", "cancelled"].includes(status)) throw new Error(`Timestamps job ${status}: ${message ?? ""}`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!isConnected()) throw new Error("Client disconnected");
  throw new Error("Timestamp job timed out after 8 minutes");
}

// ── Parse timestamps like "5:32" or "1:22:10" into seconds ───────────────
function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// ── Tool definitions ──────────────────────────────────────────────────────
const STUDIO_TOOLS: any[] = [
  {
    name: "get_video_info",
    description: "Fetch metadata about a YouTube video (title, duration, uploader, view count). Always call this first if you don't already have the title.",
    parameters: {
      type: Type.OBJECT,
      properties: { url: { type: Type.STRING, description: "YouTube video URL" } },
      required: ["url"],
    },
  },
  {
    name: "cut_video_clip",
    description: "Cut an exact time range from a YouTube video and deliver a download link. Provide startTime and endTime as 'MM:SS' or 'HH:MM:SS'. WAITS for completion and returns a download link.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        startTime: { type: Type.STRING, description: "Start time e.g. '5:32' or '01:22:10'" },
        endTime: { type: Type.STRING, description: "End time e.g. '6:23' or '01:25:00'" },
        quality: { type: Type.STRING, description: "Output quality: '1080p', '720p', '480p', '360p'. Default: 1080p." },
      },
      required: ["url", "startTime", "endTime"],
    },
  },
  {
    name: "download_video",
    description: "Download a full YouTube video and deliver a download link. WAITS for completion and returns a download link.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        quality: { type: Type.STRING, description: "Quality: '1080p', '720p', '480p', '360p', 'audio_only'. Default: best video." },
      },
      required: ["url"],
    },
  },
  {
    name: "generate_subtitles",
    description: "Generate SRT subtitle file from a YouTube video, optionally translated. WAITS for completion and returns a download link.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        language: { type: Type.STRING, description: "Source language code, e.g. 'hi' for Hindi. Default: auto-detect." },
        translateTo: { type: Type.STRING, description: "Target translation language code, e.g. 'en'. Optional." },
      },
      required: ["url"],
    },
  },
  {
    name: "find_best_clips",
    description: "Use AI to find the most valuable segments from a long YouTube video. Starts the analysis job.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        durationMode: { type: Type.STRING, description: "Preferred clip length: 'auto', '1m', '3m', '8m'. Default: auto." },
        instructions: { type: Type.STRING, description: "Optional topic focus, e.g. 'focus on spiritual stories'" },
      },
      required: ["url"],
    },
  },
  {
    name: "generate_timestamps",
    description: "Generate YouTube chapter timestamps from a video using AI. Returns the timestamps text directly.",
    parameters: {
      type: Type.OBJECT,
      properties: { url: { type: Type.STRING, description: "YouTube video URL" } },
      required: ["url"],
    },
  },
  {
    name: "list_shared_files",
    description: "List files in the public share gallery.",
    parameters: {
      type: Type.OBJECT,
      properties: { limit: { type: Type.NUMBER, description: "Max files to return. Default: 12." } },
      required: [],
    },
  },
  {
    name: "navigate_to_tab",
    description: "Switch the studio UI to a specific tool tab. Use only when the user explicitly asks to open/switch tabs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tab: {
          type: Type.STRING,
          description: "Tab name: 'download', 'clips', 'subtitles', 'clipcutter', 'bhagwat', 'scenefinder', 'timestamps', 'upload', 'translator'",
        },
      },
      required: ["tab"],
    },
  },
  {
    name: "translate_video",
    description: "Translate a YouTube video into another language with AI voice cloning. Downloads the video, transcribes, translates, clones the voice, and delivers the result. Use when the user wants to dub or translate a video.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL to translate" },
        targetLang: { type: Type.STRING, description: "Target language name, e.g. 'Hindi', 'Spanish', 'French'. Default: Hindi." },
        targetLangCode: { type: Type.STRING, description: "BCP-47 language code, e.g. 'hi', 'es', 'fr'. Default: hi." },
        voiceClone: { type: Type.BOOLEAN, description: "Clone the original speaker voice (true) or use neural TTS (false). Default: true." },
        lipSync: { type: Type.BOOLEAN, description: "Apply lip sync. Default: false." },
      },
      required: ["url"],
    },
  },
  {
    name: "get_youtube_captions",
    description: "Fetch existing auto-generated or manual captions directly from YouTube. Faster than transcribing — use this first if the user just wants the original-language subtitles.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        language: { type: Type.STRING, description: "Language code to prefer, e.g. 'en', 'hi'. Default: auto." },
      },
      required: ["url"],
    },
  },
  {
    name: "fix_subtitles",
    description: "Fix and clean up garbled or mistimed SRT subtitle content. Pass the raw SRT as a string.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        srtContent: { type: Type.STRING, description: "Raw SRT subtitle content to fix" },
        language: { type: Type.STRING, description: "Language of the subtitles, e.g. 'en'." },
      },
      required: ["srtContent"],
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a running or queued job. Use if the user asks to stop a download, clip cut, or subtitle job.",
    parameters: {
      type: Type.OBJECT,
      properties: { jobId: { type: Type.STRING, description: "Job ID to cancel" } },
      required: ["jobId"],
    },
  },
  {
    name: "check_job_status",
    description: "Check status and progress of any background job by ID. Returns status, percent complete, and messages.",
    parameters: {
      type: Type.OBJECT,
      properties: { jobId: { type: Type.STRING, description: "Job ID to check" } },
      required: ["jobId"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for real-time information. Use when the user asks about current events, video details not in metadata, trends, or anything requiring up-to-date knowledge. Returns top search results with titles, snippets, and URLs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search query string" },
        maxResults: { type: Type.NUMBER, description: "Max results to return (1-5). Default: 3." },
      },
      required: ["query"],
    },
  },
  {
    name: "do_full_package",
    description: "Run a complete production package for a YouTube video: metadata, download, summary, timestamps, SEO, subtitles/captions, and best clips.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        language: { type: Type.STRING, description: "Subtitle/caption language to prefer. Default: en." },
        quality: { type: Type.STRING, description: "Download quality. Default: best." },
        instructions: { type: Type.STRING, description: "Optional content focus for summary/clips/SEO." },
      },
      required: ["url"],
    },
  },
  {
    name: "repeat_last_artifact",
    description: "Render the last download/image/tab result from conversation memory again, so the user can click it.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "check_active_jobs",
    description: "Check active jobs from IDs remembered in the conversation. Use when the user asks what is running or to continue jobs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Known job IDs. If omitted, the tool scans conversation memory." },
      },
      required: [],
    },
  },
  {
    name: "cancel_active_jobs",
    description: "Cancel all known active YouTube jobs from IDs remembered in the conversation. Use when the user asks to stop/cancel all running jobs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Known job IDs. If omitted, the tool scans conversation memory." },
      },
      required: [],
    },
  },
  {
    name: "send_result_to_tab",
    description: "Open the relevant tab for a result or workflow: download, clips, subtitles, clipcutter, translator, timestamps, upload.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tab: { type: Type.STRING, description: "Target tab name." },
      },
      required: ["tab"],
    },
  },
  {
    name: "create_image",
    description: "Create a new image from a prompt using Gemini image generation. Use when the user asks to make, generate, design, or create an image.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: "Detailed visual prompt for the image to create." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "enhance_image",
    description: "Enhance the latest attached image so it looks crystal clear and newly restored, preserving composition and identity. This is clarity enhancement, not simple pixel upscaling.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instructions: { type: Type.STRING, description: "Optional user intent, e.g. restore face details, sharpen text, improve lighting." },
      },
      required: [],
    },
  },
  {
    name: "edit_image",
    description: "Edit the latest attached image according to user instructions while preserving the important parts of the original image.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instructions: { type: Type.STRING, description: "Precise edit instructions." },
      },
      required: ["instructions"],
    },
  },
  {
    name: "describe_image",
    description: "Analyze the latest attached image and describe subjects, scene, visible text, composition, quality issues, and practical edit suggestions.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "extract_text_from_image",
    description: "Read visible text from the latest attached image using vision OCR, preserving line breaks when possible.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "write_video_script",
    description: "Write a production-ready video script, narration, hook, shot list, or storyboard for a requested topic, style, duration, and language.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "Video topic or idea." },
        duration: { type: Type.STRING, description: "Target duration, e.g. 30 seconds, 3 minutes, 8 minutes." },
        language: { type: Type.STRING, description: "Output language. Default follows the user." },
        style: { type: Type.STRING, description: "Tone/style, e.g. cinematic, devotional, news, documentary, shorts." },
      },
      required: ["topic"],
    },
  },
  {
    name: "generate_seo_pack",
    description: "Generate a YouTube SEO package: title options, description, tags, hashtags, pinned comment, and thumbnail text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "Video topic, URL title, transcript summary, or idea." },
        language: { type: Type.STRING, description: "Output language. Default follows the user." },
        audience: { type: Type.STRING, description: "Target audience or niche." },
      },
      required: ["topic"],
    },
  },
  {
    name: "read_uploaded_file",
    description: "Read the latest uploaded SRT/TXT/CSV/JSON/PDF/document attachment and summarize or extract its contents.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: { type: Type.STRING, description: "What to do with the file: summarize, inspect, extract, analyze, etc." },
      },
      required: [],
    },
  },
  {
    name: "convert_subtitles",
    description: "Convert subtitle content between SRT, VTT, and plain TXT.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        content: { type: Type.STRING, description: "Subtitle content. If omitted, use latest uploaded text file." },
        inputFormat: { type: Type.STRING, description: "srt, vtt, or txt. Default: auto." },
        outputFormat: { type: Type.STRING, description: "srt, vtt, or txt." },
        filename: { type: Type.STRING, description: "Output filename." },
      },
      required: ["outputFormat"],
    },
  },
  {
    name: "compare_subtitles",
    description: "Compare two SRT/VTT/TXT subtitle files or blocks for missing lines, timing drift, text differences, and quality issues.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        first: { type: Type.STRING, description: "First subtitle text. If omitted, use uploaded/context content." },
        second: { type: Type.STRING, description: "Second subtitle text. If omitted, use uploaded/context content." },
      },
      required: [],
    },
  },
  {
    name: "export_text_file",
    description: "Export script, SEO, subtitles, notes, or any generated text as a downloadable file.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: "Output filename, e.g. script.txt or subtitles.srt." },
        content: { type: Type.STRING, description: "File content. If omitted, export latest text artifact from memory." },
      },
      required: ["filename"],
    },
  },
  {
    name: "run_code_analysis",
    description: "Use Gemini code execution for CSV/JSON/text calculations, tables, simple charts, statistics, and data analysis.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: { type: Type.STRING, description: "Analysis question or calculation to run." },
        data: { type: Type.STRING, description: "CSV/JSON/text data. If omitted, use latest uploaded text file or context." },
      },
      required: ["task"],
    },
  },
  {
    name: "analyze_youtube_video",
    description: "Directly analyze a YouTube video by having Gemini watch and listen to it. Can answer ANY question about the video: summarize content, find specific moments, extract quotes, analyze emotions, describe scenes, review quality, translate what is being said, identify speakers, get key points, etc. Works on any public YouTube video. Much more powerful than just reading captions — the model actually sees and hears the video.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL (must be public)" },
        question: { type: Type.STRING, description: "What you want to know about the video. Be specific for best results." },
      },
      required: ["url", "question"],
    },
  },
];
const SYSTEM_PROMPT = `You are the VideoMaking Studio Copilot — a sharp, fast, action-first assistant for a YouTube/video production app.

# VOICE
Talk like a competent friend, not a corporate bot. Tool cards already show live action, so do not repeat "I am downloading/cutting/generating..." in the final answer. After a tool returns, one or two sentences max: what completed and what to do next. No bullet lists unless the user asks for one. No emojis unless the user uses them first.

# INTELLIGENCE FIRST
Use your own intelligence before tools. Do not call a tool for normal thinking, writing, rewriting, brainstorming, planning, explaining, prompt improvement, simple translation, short pasted text/SRT/CSV/JSON, visible chat context, or basic image understanding from an attached image already in context. Answer directly when you can.

Call tools only when you need a real app action or missing capability: downloading/cutting videos, fetching YouTube data/captions, reading file URLs/PDFs, generating/editing/enhancing actual image files, exporting downloadable files, checking/cancelling jobs, searching current web info, running code/data analysis, opening tabs, or restoring a previous result button.

Always choose the best user outcome, not the most tools. If a direct answer is enough, be direct. If a tool will produce a better real result, use the smallest correct tool.

# IRON RULES
1. NEVER refuse a video task that maps to a tool. You have tools — use them. Don't say "I can't access YouTube"; call get_video_info.
2. NEVER ask for permission before running a tool. If the user gave you a URL and a clear intent, just go.
3. NEVER reveal internals: no "planning", "phase 1", "executing", "judging", "thought", "tool_call", "function call", JSON of args, raw error stacks, [JUDGE], [REASONING], or model names.
4. NEVER invent timestamps, durations, or video facts. If you need them, call get_video_info or analyze_youtube_video first.
5. NEVER fabricate a download URL — only quote URLs the tools returned.
6. If a YouTube URL is missing and clearly required, ask for it in one sentence. Otherwise infer.
7. Respect what the user already gave you. If they pasted SRT text, use fix_subtitles directly — don't re-ask for the file.

# DOWNLOAD OUTPUTS
For download_video, cut_video_clip, generate_subtitles, get_youtube_captions, create_image, enhance_image, and edit_image, never print raw internal /api/... file URLs in final chat text. The UI renders download buttons automatically; say only "Done - use the download button above."

# TOOL SELECTION HEURISTICS
Pick the cheapest tool that solves the request:

| User wants | Use |
|---|---|
| "what's this video about / who made it" | get_video_info (metadata only — fast) |
| "summarize / explain / find the moment when / quote what they said" | analyze_youtube_video (AI watches + listens) |
| "give me the captions / subtitles already on YouTube" | get_youtube_captions (instant, no transcription) |
| "transcribe / generate subtitles / translate subtitles" | generate_subtitles |
| "fix / clean my .srt" (user provided text) | fix_subtitles |
| "cut from X to Y / make a clip" | cut_video_clip |
| "download the whole video / get the audio" | download_video (use quality='audio_only' for audio) |
| "find best moments / highlights / shorts" | find_best_clips |
| "make chapter timestamps" | generate_timestamps |
| "translate this video / dub in Hindi/Spanish" | translate_video THEN navigate_to_tab('translator') |
| "what's trending / latest news / who is X" | web_search first, then maybe a video tool |
| "create/generate an image" | create_image |
| "make this attached image clearer / enhance / restore" | enhance_image |
| "edit this attached image" | edit_image |
| "what is in this image / inspect image" | describe_image |
| "read text from this image" | extract_text_from_image |
| "write script / storyboard / shot list" | write_video_script |
| "SEO title/description/tags/thumbnail text" | generate_seo_pack |
| "full package / do everything / complete package" | do_full_package |
| "give link again / show result again / where is file" | repeat_last_artifact |
| "continue/check running jobs / active jobs" | check_active_jobs |
| "cancel all / stop all running jobs" | cancel_active_jobs |
| "send/open result in tab" | send_result_to_tab |
| "read this uploaded file / summarize PDF/CSV/JSON/SRT/TXT" | read_uploaded_file |
| "convert srt/vtt/txt" | convert_subtitles |
| "compare two subtitle files" | compare_subtitles |
| "export this as file / download this text" | export_text_file |
| "calculate/analyze CSV/JSON/table/chart" | run_code_analysis |
| "stop the job / cancel" | cancel_job with the jobId from context |
| "is my job done / progress" | check_job_status |
| User explicitly says "open the X tab" | navigate_to_tab |

Don't double-call tools. If get_video_info already gave you the title and duration, don't call it again in the same conversation.
Use artifact memory: if the user asks for a previous result/link/file again, call repeat_last_artifact instead of writing raw URLs.

# MULTI-STEP REASONING
You can chain up to ${MAX_ITERATIONS} tool calls per turn. Use that:
- "summarize the video and then pull the best 3 clips" → analyze_youtube_video, then find_best_clips.
- "transcribe and translate to English" → generate_subtitles with translateTo='en'.
- "what does the host say about X at minute 10" → analyze_youtube_video (NOT generate_subtitles — much faster).
- If a tool result contains a clear error message like "video unavailable" or "private", stop retrying and tell the user plainly.

When multiple requested actions are independent, call the tools together in the same turn. The backend can run safe independent work in parallel. Keep dependent chains in order.
For multiple clip-cut requests, call up to 3 cut_video_clip tools in the same turn. Do not cut one clip, wait, then cut the next unless the next clip depends on the previous result.

# TIME ARGUMENTS
Always pass startTime/endTime as 'MM:SS' or 'HH:MM:SS' strings exactly as the user typed them. Don't convert to seconds, don't pad zeros unnecessarily. The backend parses both formats.

# QUALITY DEFAULTS
- cut_video_clip: default 1080p unless user asks otherwise. Do not use 2K/4K for clips unless the user explicitly asks.
- download_video: default best (omit quality) unless user picked one. For "audio" / "mp3" requests use quality='audio_only'.
- translate_video: voiceClone defaults to true (preserves original speaker), lipSync defaults to false (slow + GPU-heavy).

# UPLOADED FILES
If the conversation context contains [ATTACHED VIDEO/AUDIO/FILE: ... | URL: ...], pass that URL straight to generate_subtitles or translate_video — do NOT ask for a YouTube link.

# FAILURE HANDLING
If a tool errors:
1. Read the error string. If it's a transient/rate issue, retry once with the same args.
2. If it's a real failure ("video private", "no captions found", "duration too long for clip"), tell the user in one short sentence and offer the next-best option ("the captions tool didn't find any — want me to transcribe it instead?").
3. Never apologise more than once. Never blame "the system" — say what specifically failed.

# FINAL ANSWER FORMAT
When the work is complete, end your reply with the suggestions line on its OWN final line, exactly:
[SUGGESTIONS: "suggestion one" | "suggestion two" | "suggestion three"]
Suggestions must be concrete next actions on this same video/topic (e.g. "Translate this clip to Spanish", "Generate timestamps", "Download in 1080p"), not generic prompts. 2–3 items.`;

// ── Build internal headers from request ───────────────────────────────────
function buildInternalHeaders(req: any): Record<string, string> {
  const INTERNAL_SECRET = process.env.INTERNAL_AGENT_SECRET ?? "internal-agent-bypass-key";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: req.headers.cookie ?? "",
    "x-internal-agent": INTERNAL_SECRET,
  };
  if (req.headers["x-forwarded-for"]) headers["x-forwarded-for"] = String(req.headers["x-forwarded-for"]);
  else if (req.ip) headers["x-forwarded-for"] = req.ip;
  if (req.headers["x-notify-client"]) headers["x-notify-client"] = String(req.headers["x-notify-client"]);
  if (req.headers["x-client-id"]) headers["x-client-id"] = String(req.headers["x-client-id"]);
  if (req.headers["x-device-id"]) headers["x-device-id"] = String(req.headers["x-device-id"]);
  return headers;
}

// ── Tool executor ─────────────────────────────────────────────────────────
function latestImageAttachment(req: any): { data: string; mimeType: string; name: string } | null {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const attachments = Array.isArray(messages[i]?.attachments) ? messages[i].attachments : [];
    for (let j = attachments.length - 1; j >= 0; j--) {
      const attachment = attachments[j];
      if (attachment?.type === "image" && attachment?.data && attachment?.mimeType) {
        return {
          data: String(attachment.data),
          mimeType: String(attachment.mimeType),
          name: String(attachment.name ?? "image"),
        };
      }
    }
  }
  return null;
}

function imageFilename(mimeType: string, prefix: string): string {
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  return `${prefix}-${Date.now()}.${ext}`;
}

async function publishGeneratedImage(params: {
  data: string;
  mimeType: string;
  filenamePrefix: string;
}): Promise<{ imageUrl: string; filename: string }> {
  const filename = imageFilename(params.mimeType, params.filenamePrefix);
  if (!isS3StorageEnabled()) {
    return { imageUrl: `data:${params.mimeType};base64,${params.data}`, filename };
  }

  const upload = await createS3PresignedUpload({
    jobId: randomUUID(),
    namespace: "agent-images",
    filename,
    contentType: params.mimeType,
  });
  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": params.mimeType },
    body: Buffer.from(params.data, "base64"),
  });
  if (!put.ok) throw new Error(`Image upload failed: ${put.status}`);
  const imageUrl = await getS3SignedDownloadUrl({
    key: upload.key,
    filename: upload.filename,
    expiresInSec: 7 * 24 * 60 * 60,
  });
  return { imageUrl, filename: upload.filename };
}

async function generateImageArtifact(params: {
  prompt: string;
  inputImage?: { data: string; mimeType: string };
  filenamePrefix: string;
}): Promise<{ imageUrl: string; filename: string; text: string }> {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const parts: any[] = [{ text: params.prompt }];
  if (params.inputImage) {
    parts.push({ inlineData: { mimeType: params.inputImage.mimeType, data: params.inputImage.data } });
  }
  const resp = await ai.models.generateContent({
    model: process.env.COPILOT_IMAGE_MODEL ?? "gemini-2.5-flash-image",
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE] as any,
      temperature: 0.25,
    },
  } as any);

  let text = "";
  for (const part of resp.candidates?.[0]?.content?.parts ?? []) {
    if (part.text) text += part.text;
    const imageData = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType ?? "image/png";
    if (imageData) {
      const published = await publishGeneratedImage({
        data: imageData,
        mimeType,
        filenamePrefix: params.filenamePrefix,
      });
      return { ...published, text: stripReasoningTags(text).trim() };
    }
  }
  throw new Error("Image model returned no image. Try a clearer prompt or attach an image.");
}

async function textModelArtifact(label: string, prompt: string): Promise<{ result: any; artifact: object }> {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const resp = await ai.models.generateContent({
    model: ULTRA_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature: 0.25, maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
  });
  const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
  if (!content) throw new Error(`${label} returned no content`);
  return {
    result: { content },
    artifact: { artifactType: "text", label, content },
  };
}

function latestNonImageAttachment(req: any): { url?: string; data?: string; mimeType: string; name: string; type?: string } | null {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const attachments = Array.isArray(messages[i]?.attachments) ? messages[i].attachments : [];
    for (let j = attachments.length - 1; j >= 0; j--) {
      const attachment = attachments[j];
      if (attachment?.type !== "image" && (attachment?.url || attachment?.data)) {
        return {
          url: attachment.url ? String(attachment.url) : undefined,
          data: attachment.data ? String(attachment.data) : undefined,
          mimeType: String(attachment.mimeType ?? "text/plain"),
          name: String(attachment.name ?? "attachment.txt"),
          type: attachment.type ? String(attachment.type) : undefined,
        };
      }
    }
  }
  return null;
}

function conversationText(req: any): string {
  return (Array.isArray(req.body?.messages) ? req.body.messages : [])
    .map((m: any) => String(m?.content ?? ""))
    .join("\n\n");
}

async function readAttachmentText(req: any): Promise<{ content: string; name: string; mimeType: string } | null> {
  const attachment = latestNonImageAttachment(req);
  if (!attachment) return null;
  if (attachment.data) {
    return { content: Buffer.from(attachment.data, "base64").toString("utf8"), name: attachment.name, mimeType: attachment.mimeType };
  }
  const url = attachment.url ?? "";
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(0, comma);
    const body = url.slice(comma + 1);
    const content = meta.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    return { content, name: attachment.name, mimeType: attachment.mimeType };
  }
  if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not read uploaded file: ${r.status}`);
    const contentType = r.headers.get("content-type") ?? attachment.mimeType;
    if (contentType.includes("pdf")) {
      return { content: `[PDF attachment: ${url}]`, name: attachment.name, mimeType: contentType };
    }
    return { content: await r.text(), name: attachment.name, mimeType: contentType };
  }
  return null;
}

function srtTimeToVtt(time: string): string {
  return time.replace(",", ".");
}

function vttTimeToSrt(time: string): string {
  return time.replace(".", ",");
}

function convertSubtitleText(content: string, inputFormat: string, outputFormat: string): string {
  const out = outputFormat.toLowerCase();
  const inferred = inputFormat === "auto"
    ? content.trimStart().startsWith("WEBVTT") ? "vtt" : /-->\s*\d\d:\d\d:\d\d,\d\d\d/.test(content) ? "srt" : "txt"
    : inputFormat.toLowerCase();
  if (inferred === out) return content;
  if (out === "txt") {
    return content
      .replace(/^WEBVTT.*$/gim, "")
      .replace(/^\d+\s*$/gm, "")
      .replace(/\d\d:\d\d:\d\d[,.]\d\d\d\s*-->\s*\d\d:\d\d:\d\d[,.]\d\d\d.*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (inferred === "srt" && out === "vtt") {
    return "WEBVTT\n\n" + content
      .replace(/\r/g, "")
      .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")
      .trim() + "\n";
  }
  if (inferred === "vtt" && out === "srt") {
    let index = 1;
    return content
      .replace(/\r/g, "")
      .replace(/^WEBVTT.*\n+/i, "")
      .split(/\n\n+/)
      .map(block => block.trim())
      .filter(Boolean)
      .map(block => {
        const lines = block.split("\n").filter(line => !/^NOTE\b/i.test(line.trim()));
        const timeIdx = lines.findIndex(line => line.includes("-->"));
        if (timeIdx < 0) return "";
        const time = lines[timeIdx].replace(/(\d\d:\d\d:\d\d)\.(\d\d\d)/g, "$1,$2");
        return `${index++}\n${time}\n${lines.slice(timeIdx + 1).join("\n")}`;
      })
      .filter(Boolean)
      .join("\n\n") + "\n";
  }
  if (out === "srt") {
    return `1\n00:00:00,000 --> 00:00:05,000\n${content.trim()}\n`;
  }
  if (out === "vtt") {
    return `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n${content.trim()}\n`;
  }
  return content;
}

async function downloadableTextArtifact(filename: string, content: string): Promise<object> {
  if (!isS3StorageEnabled()) {
    return {
      artifactType: "download",
      label: filename,
      downloadUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`,
    };
  }
  const uploaded = await uploadTextToS3({
    body: content,
    jobId: randomUUID(),
    namespace: "agent-exports",
    filename,
  });
  const downloadUrl = await getS3SignedDownloadUrl({
    key: uploaded.key,
    filename: uploaded.filename,
    expiresInSec: 7 * 24 * 60 * 60,
  });
  return { artifactType: "download", label: uploaded.filename, downloadUrl };
}

function scanKnownJobIds(req: any): string[] {
  const ids = new Set<string>();
  const text = conversationText(req);
  for (const match of text.matchAll(/\bjob(?:Id)?:?\s*([a-f0-9-]{8,})\b/gi)) ids.add(match[1]);
  for (const match of text.matchAll(/\/api\/(?:youtube\/file|subtitles\/status)\/([a-f0-9-]{8,})/gi)) ids.add(match[1]);
  return [...ids].slice(-20);
}

function latestArtifactFromMemory(req: any): { artifactType: string; label: string; downloadUrl?: string; imageUrl?: string; tab?: string; jobId?: string } | null {
  const text = conversationText(req);
  const artifactLines = text.split("\n").filter(line => line.startsWith("[Artifact:"));
  const line = artifactLines.at(-1);
  if (!line) return null;
  const pick = (key: string) => new RegExp(`${key}: ([^|\\]]+)`, "i").exec(line)?.[1]?.trim();
  return {
    artifactType: pick("Artifact") ?? pick("Type") ?? "download",
    label: pick("Label") ?? "Previous result",
    downloadUrl: pick("URL"),
    imageUrl: pick("Image"),
    tab: pick("Tab"),
    jobId: pick("Job"),
  };
}

async function executeTool(
  name: string,
  args: Record<string, any>,
  req: any,
  res: any,
  isConnected: () => boolean,
  toolId?: string,
): Promise<{ result: any; artifact?: object }> {
  const apiBase = getApiBase(req);
  const internalHeaders = buildInternalHeaders(req);
  const logTool = (message: string, details?: Record<string, any>) => {
    sseEvent(res, { type: "tool_log", toolId, name, message, ...(details ? { details } : {}) });
  };

  switch (name) {

    case "get_video_info": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/info" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Fetching video metadata..." });
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url }),
      });
      const data = await r.json().catch(() => ({ error: "Failed to fetch info" })) as any;
      // Build a readable summary for the artifact card
      const infoLines: string[] = [];
      if (data.title) infoLines.push(`📹 ${data.title}`);
      if (data.duration) infoLines.push(`⏱ Duration: ${data.duration}`);
      if (data.uploader) infoLines.push(`👤 ${data.uploader}`);
      if (data.view_count != null) infoLines.push(`👁 ${Number(data.view_count).toLocaleString()} views`);
      return {
        result: data,
        ...(infoLines.length > 0 ? {
          artifact: {
            artifactType: "text",
            label: "Video Info",
            content: infoLines.join("\n"),
          },
        } : {}),
      };
    }

    case "cut_video_clip": {
      const startSecs = parseTimestamp(String(args.startTime));
      const endSecs = parseTimestamp(String(args.endTime));
      const quality = args.quality ?? "1080p";
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/clip-cut" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: `Starting clip cut (${args.startTime} → ${args.endTime})...` });
      const r = await fetch(`${apiBase}/youtube/clip-cut`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url, startTime: startSecs, endTime: endSecs, quality }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Clip cut failed: ${r.status}`);
      }
      const { jobId } = await r.json() as any;
      logTool("Clip cut job accepted", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, {
        type: "tool_progress",
        toolId,
        name,
        status: "processing",
        message: "Starting clip cut...",
        jobId,
        url: args.url,
        startSecs,
        endSecs,
        quality,
      } as any);

      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      const downloadUrl = `/api/youtube/file/${jobId}`;
      return {
        result: { jobId, downloadUrl, startTime: args.startTime, endTime: args.endTime, url: args.url, quality },
        artifact: { artifactType: "download", label: `Clip ready: ${args.startTime} → ${args.endTime}`, downloadUrl, jobId },
      };
    }

    case "download_video": {
      const quality = args.quality ?? "best";
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/download" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: `Starting download (${quality})...` });
      let formatId = DEFAULT_VIDEO_FORMAT_SELECTOR;
      if (quality === "audio_only") formatId = "audio:bestaudio";
      if (quality === "1080p") formatId = "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][vcodec!=none]+bestaudio[acodec!=none]/best[height<=1080][ext=mp4][vcodec!=none][acodec!=none]";
      if (quality === "720p") formatId = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][vcodec!=none]+bestaudio[acodec!=none]/best[height<=720][ext=mp4][vcodec!=none][acodec!=none]";
      if (quality === "480p") formatId = "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480][vcodec!=none]+bestaudio[acodec!=none]/best[height<=480][ext=mp4][vcodec!=none][acodec!=none]";
      if (quality === "360p") formatId = "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360][vcodec!=none]+bestaudio[acodec!=none]/best[height<=360][ext=mp4][vcodec!=none][acodec!=none]";
      const r = await fetch(`${apiBase}/youtube/download`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url, formatId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Download failed: ${r.status}`);
      }
      const { jobId } = await r.json() as any;
      logTool("Download job accepted", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", toolId, name, status: "processing", message: "Starting download...", jobId, url: args.url } as any);

      const final = await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      const downloadUrl = `/api/youtube/file/${jobId}`;
      return {
        result: { jobId, downloadUrl, filename: final.filename, url: args.url, quality },
        artifact: { artifactType: "download", label: `Video ready: ${final.filename ?? "video.mp4"}`, downloadUrl, jobId },
      };
    }

    case "generate_subtitles": {
      // Detect uploaded file URL (S3/CDN) vs YouTube URL.
      // Uploaded files: POST to /subtitles/generate-from-url (direct media URL → transcription).
      // YouTube URLs: POST to /subtitles/generate (yt-dlp download path).
      const inputUrl = (args.url ?? args.fileUrl ?? "") as string;
      const isUploadedFile = !!inputUrl && !inputUrl.includes("youtube.com") && !inputUrl.includes("youtu.be");
      logTool("Starting subtitle generation", { url: inputUrl, mode: isUploadedFile ? "uploaded-file" : "youtube" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: isUploadedFile ? "Transcribing uploaded file..." : "Starting subtitle generation..." });

      let subtitleJobId: string;
      if (isUploadedFile) {
        const r = await fetch(`${apiBase}/subtitles/generate-from-url`, {
          method: "POST", headers: internalHeaders,
          body: JSON.stringify({ fileUrl: inputUrl, language: args.language ?? "auto", translateTo: args.translateTo ?? null }),
        });
        if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Subtitle job failed: ${r.status}`); }
        const d = await r.json() as any; subtitleJobId = d.id ?? d.jobId;
      } else {
        const r = await fetch(`${apiBase}/subtitles/generate`, {
          method: "POST", headers: internalHeaders,
          body: JSON.stringify({ url: inputUrl, language: args.language ?? "auto", translateTo: args.translateTo ?? null, source: "url" }),
        });
        if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Subtitle job failed: ${r.status}`); }
        const d = await r.json() as any; subtitleJobId = d.id ?? d.jobId;
      }
      logTool("Subtitles job accepted", { jobId: subtitleJobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", toolId, name: "generate_subtitles", status: "processing", message: "Starting subtitle generation...", jobId: subtitleJobId, url: args.url } as any);

      const final = await pollSubtitleUntilDone(res, `${apiBase}/subtitles/status/${subtitleJobId}`, subtitleJobId, internalHeaders, isConnected, toolId);
      const srtUrl = `/api/subtitles/status/${subtitleJobId}/download?format=srt`;
      return {
        result: { jobId: subtitleJobId, srtFilename: final.srtFilename, url: args.url, language: args.language, translateTo: args.translateTo },
        artifact: {
          artifactType: "download",
          label: `Subtitles ready${args.translateTo ? ` (${args.translateTo})` : ""}: ${final.srtFilename ?? "subtitles.srt"}`,
          downloadUrl: srtUrl,
          jobId: subtitleJobId,
        },
      };
    }

    case "find_best_clips": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/clips" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Starting best clips AI analysis..." });
      const r = await fetch(`${apiBase}/youtube/clips`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url, durationMode: args.durationMode ?? "auto", instructions: args.instructions ?? "" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Best clips job failed: ${r.status}`);
      }
      const { jobId } = await r.json() as any;
      logTool("Best clips job accepted — polling for results...", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", toolId, name: "find_best_clips", status: "processing", message: "Starting best clips analysis...", jobId, url: args.url } as any);

      // Poll until analysis is done (same pattern as clip/download)
      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      return {
        result: { jobId, message: "Best clips analysis complete. View results in the Best Clips tab." },
        artifact: { artifactType: "tab_link", label: "✅ Best Clips ready — open tab to download", tab: "clips", jobId },
      };
    }

    case "generate_timestamps": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/timestamps" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Generating timestamps..." });
      const r = await fetch(`${apiBase}/youtube/timestamps`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Timestamps failed: ${r.status}`);
      }
      const { jobId } = await r.json() as any;
      logTool("Timestamps job accepted", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", toolId, name: "generate_timestamps", status: "processing", message: "Starting timestamp generation...", jobId, url: args.url } as any);

      const final = await pollTimestampsUntilDone(res, `${apiBase}/youtube/timestamps/status/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      return {
        result: { jobId, timestamps: final.timestamps },
        artifact: final.timestamps ? {
          artifactType: "text",
          label: "Timestamps generated",
          content: typeof final.timestamps === "string" ? final.timestamps : JSON.stringify(final.timestamps, null, 2),
        } : undefined,
      };
    }

    case "list_shared_files": {
      const limit = args.limit ?? 12;
      logTool("Calling internal API", { method: "GET", endpoint: `/api/uploads/public?limit=${limit}` });
      const r = await fetch(`${apiBase}/uploads/public?limit=${limit}`, { headers: internalHeaders });
      const data = await r.json().catch(() => ({ items: [] }));
      return { result: data };
    }

    case "navigate_to_tab": {
      sseEvent(res, { type: "navigate", tab: args.tab });
      return { result: { navigated: true, tab: args.tab } };
    }

    case "translate_video": {
      // Detect uploaded file URL (S3/CDN) vs YouTube URL.
      // Uploaded files: POST to /translator/submit-from-url — no YouTube download needed.
      // YouTube URLs: download via youtube/stream → S3 → submit.
      const videoUrl = (args.url ?? args.fileUrl ?? "") as string;
      const isUploadedFile = !!videoUrl && !videoUrl.includes("youtube.com") && !videoUrl.includes("youtu.be");
      logTool("Starting video translation job", { url: videoUrl, mode: isUploadedFile ? "uploaded-file" : "youtube" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: isUploadedFile ? "Registering uploaded file for GPU translation..." : "Downloading video for translation..." });

      let tvJobId: string;
      if (isUploadedFile) {
        const submitR = await fetch(`${apiBase}/translator/submit-from-url`, {
          method: "POST", headers: internalHeaders,
          body: JSON.stringify({
            fileUrl: videoUrl,
            targetLang: args.targetLang ?? "Hindi",
            targetLangCode: args.targetLangCode ?? "hi",
            voiceClone: args.voiceClone ?? true,
            lipSync: args.lipSync ?? false,
            filename: videoUrl.split("/").pop()?.split("?")[0] ?? "uploaded-video.mp4",
          }),
        });
        if (!submitR.ok) { const err = await submitR.json().catch(() => ({})) as any; throw new Error(err.error ?? `Translation submit failed: ${submitR.status}`); }
        const d = await submitR.json() as any; tvJobId = d.jobId;
      } else {
        const presignR = await fetch(`${apiBase}/translator/presign?filename=input.mp4&contentType=video/mp4`, { headers: internalHeaders });
        if (!presignR.ok) throw new Error(`Failed to get upload URL: ${presignR.status}`);
        const { jobId: pJobId, presignedUrl, s3Key } = await presignR.json() as any;
        tvJobId = pJobId;
        sseEvent(res, { type: "tool_progress", toolId, name, message: "Uploading video to GPU worker queue..." });
        const ytStreamR = await fetch(`${apiBase}/youtube/stream?url=${encodeURIComponent(videoUrl)}`, { headers: internalHeaders });
        if (!ytStreamR.ok) throw new Error(`YouTube stream failed: ${ytStreamR.status}`);
        const videoBuffer = Buffer.from(await ytStreamR.arrayBuffer());
        const uploadR = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: videoBuffer });
        if (!uploadR.ok) throw new Error(`S3 upload failed: ${uploadR.status}`);
        sseEvent(res, { type: "tool_progress", toolId, name, message: `Submitting GPU translation job (${args.targetLang ?? "Hindi"})...` });
        const submitR = await fetch(`${apiBase}/translator/submit`, {
          method: "POST", headers: internalHeaders,
          body: JSON.stringify({ jobId: tvJobId, s3Key, targetLang: args.targetLang ?? "Hindi", targetLangCode: args.targetLangCode ?? "hi", voiceClone: args.voiceClone ?? true, lipSync: args.lipSync ?? false, filename: "input.mp4" }),
        });
        if (!submitR.ok) { const err = await submitR.json().catch(() => ({})) as any; throw new Error(err.error ?? `Translation submit failed: ${submitR.status}`); }
      }
      logTool("Translation job submitted", { jobId: tvJobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", toolId, name: "translate_video", status: "processing", message: "Job submitted to GPU worker...", jobId: tvJobId, url: videoUrl } as any);

      sseEvent(res, { type: "navigate", tab: "translator" });
      return {
        result: { jobId: tvJobId, message: "Translation job queued on GPU worker. Track progress in the Translator tab." },
        artifact: { artifactType: "tab_link", label: `Translating to ${args.targetLang ?? "Hindi"} — open Translator tab`, tab: "translator", jobId: tvJobId },
      };
    }

    case "get_youtube_captions": {
      logTool("Fetching YouTube captions", { url: args.url });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Fetching captions from YouTube..." });
      const language = args.language ?? "en";
      const downloadUrl = `/api/youtube/subtitles?url=${encodeURIComponent(args.url)}&lang=${encodeURIComponent(language)}&format=srt`;
      const r = await fetch(`${apiBase}/youtube/subtitles?url=${encodeURIComponent(args.url)}&lang=${encodeURIComponent(language)}&format=srt`, { headers: internalHeaders });
      const content = await r.text();
      if (!r.ok) {
        let message = content || `Captions fetch failed: ${r.status}`;
        try {
          const parsed = JSON.parse(content) as { error?: string };
          message = parsed.error ?? message;
        } catch {}
        throw new Error(message);
      }
      return {
        result: { filename: "subtitles.srt", language, bytes: Buffer.byteLength(content, "utf8") },
        artifact: { artifactType: "download", label: "YouTube captions: subtitles.srt", downloadUrl },
      };
    }

    case "fix_subtitles": {
      logTool("Fixing subtitle content");
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Fixing subtitles..." });
      const r = await fetch(`${apiBase}/youtube/subtitles/fix`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ srtContent: args.srtContent, language: args.language ?? "en" }),
      });
      if (!r.ok) throw new Error(`Subtitle fix failed: ${r.status}`);
      const data = await r.json() as any;
      return {
        result: data,
        ...(data.fixed ? {
          artifact: { artifactType: "text", label: "Fixed Subtitles (.srt)", content: data.fixed },
        } : {}),
      };
    }

    case "cancel_job": {
      logTool("Cancelling job", { jobId: args.jobId });
      const r = await fetch(`${apiBase}/youtube/cancel/${args.jobId}`, { method: "POST", headers: internalHeaders });
      const data = await r.json().catch(() => ({})) as any;
      return { result: data };
    }

    case "check_job_status": {
      logTool("Checking job status", { jobId: args.jobId });
      const r = await fetch(`${apiBase}/youtube/progress/${args.jobId}`, { headers: internalHeaders });
      if (!r.ok) throw new Error(`Status check failed: ${r.status}`);
      const data = await r.json() as any;
      return { result: data };
    }

    case "web_search": {
      const query = String(args.query ?? "").trim();
      logTool("Searching the web via Gemini grounding", { query });
      sseEvent(res, { type: "tool_progress", toolId, name, message: `Searching: "${query}"...` });

      // Strategy: Use Gemini's native Google Search grounding tool.
      // This works with the existing GEMINI_API_KEY — no extra keys required.
      // If that fails, fall back to Tavily / Serper if keys are set.
      const TAVILY_KEY = process.env.TAVILY_API_KEY;
      const SERPER_KEY = process.env.SERPER_API_KEY;

      try {
        // Primary: Gemini 2.0 Flash with googleSearch grounding
        // Note: googleSearch grounding cannot be mixed with functionDeclarations
        // in the same request, so we use a separate AI client call here.
        const searchAi = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const searchResp = await searchAi.models.generateContent({
          model: SEARCH_MODEL, // gemini-2.5-flash — supports grounding + is free tier
          contents: [{ role: "user", parts: [{ text: `Search the web and answer this query concisely with facts and sources: ${query}` }] }],
          config: {
            tools: [{ googleSearch: {} }] as any,
            temperature: 0.1,
            maxOutputTokens: 1024,
          },
        });
        const groundedAnswer = (searchResp.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text ?? "").join("").trim();
        // Extract grounding metadata citations if present
        const groundingMeta = searchResp.candidates?.[0]?.groundingMetadata as any;
        const sources: string[] = [];
        (groundingMeta?.groundingChunks ?? []).forEach((chunk: any) => {
          const uri = chunk?.web?.uri;
          const title = chunk?.web?.title;
          if (uri) sources.push(title ? `${title} — ${uri}` : uri);
        });
        const sourcesText = sources.length > 0 ? `\n\nSources:\n${sources.map((s, i) => `[${i+1}] ${s}`).join("\n")}` : "";
        return { result: { query, answer: groundedAnswer + sourcesText, grounded: true } };
      } catch (groundingErr: any) {
        logTool(`Grounding failed (${groundingErr?.message}), trying fallbacks`, {});
        // Fallback 1: Tavily
        if (TAVILY_KEY) {
          const r = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
            body: JSON.stringify({ query, max_results: 3, search_depth: "basic", include_answer: true }),
          });
          if (r.ok) {
            const data = await r.json() as any;
            const results = (data.results ?? []).map((item: any, i: number) =>
              `[${i + 1}] ${item.title}\n${item.content ?? item.snippet ?? ""}\nSource: ${item.url}`
            ).join("\n\n");
            return { result: { query, answer: (data.answer ? `${data.answer}\n\n` : "") + results } };
          }
        }
        // Fallback 2: Serper
        if (SERPER_KEY) {
          const r = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_KEY },
            body: JSON.stringify({ q: query, num: 3 }),
          });
          if (r.ok) {
            const data = await r.json() as any;
            const results = ((data.organic ?? []) as any[]).slice(0, 3).map((item: any, i: number) =>
              `[${i + 1}] ${item.title}\n${item.snippet ?? ""}\nSource: ${item.link}`
            ).join("\n\n");
            return { result: { query, answer: results } };
          }
        }
        // All methods failed
        throw new Error(`Search unavailable: ${groundingErr?.message}`);
      }
    }

    case "do_full_package": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("YouTube URL is required.");
      const language = String(args.language ?? "en");
      const quality = args.quality ?? "best";
      const results: Record<string, any> = {};
      const artifacts: object[] = [];

      const runStep = async (stepName: string, stepArgs: Record<string, any>) => {
        sseEvent(res, { type: "tool_progress", toolId, name, message: `Full package: ${stepName.replace(/_/g, " ")}...` });
        const sub = await executeTool(stepName, stepArgs, req, res, isConnected, toolId);
        results[stepName] = sub.result;
        if (sub.artifact) {
          artifacts.push(sub.artifact);
          sseEvent(res, { type: "artifact", toolId, ...(sub.artifact as object) });
        }
        return sub;
      };

      await runStep("get_video_info", { url });
      await runStep("download_video", { url, quality });
      await runStep("analyze_youtube_video", {
        url,
        question: `Summarize this video for a creator. Include key points, emotional hooks, reusable quotes, and content opportunities.${args.instructions ? ` Focus: ${args.instructions}` : ""}`,
      });
      await runStep("generate_timestamps", { url });
      await runStep("generate_seo_pack", {
        topic: results.get_video_info?.title ?? url,
        audience: args.instructions ?? "YouTube audience",
      });
      try {
        await runStep("get_youtube_captions", { url, language });
      } catch (err: any) {
        results.get_youtube_captions = { error: err?.message ?? "Direct captions unavailable" };
        await runStep("generate_subtitles", { url, language });
      }
      await runStep("find_best_clips", { url, instructions: args.instructions ?? "" });

      return {
        result: { completed: true, results, artifactCount: artifacts.length },
        artifact: {
          artifactType: "text",
          label: "Full Package Summary",
          content: "Full package completed: metadata, download, summary, timestamps, SEO, subtitles/captions, and best-clips analysis.",
        },
      };
    }

    case "repeat_last_artifact": {
      const artifact = latestArtifactFromMemory(req);
      if (!artifact) throw new Error("I do not have a previous downloadable result in this chat yet.");
      return { result: artifact, artifact };
    }

    case "check_active_jobs": {
      const ids = Array.isArray(args.jobIds) && args.jobIds.length ? args.jobIds.map(String) : scanKnownJobIds(req);
      if (ids.length === 0) return { result: { jobs: [], message: "No known active job IDs in this chat." } };
      const jobs: any[] = [];
      for (const jobId of ids) {
        let status: any = null;
        for (const endpoint of [`${apiBase}/youtube/progress/${jobId}`, `${apiBase}/subtitles/status/${jobId}`, `${apiBase}/translator/status/${jobId}`]) {
          const r = await fetch(endpoint, { headers: internalHeaders }).catch(() => null);
          if (r?.ok) { status = await r.json().catch(() => null); break; }
        }
        jobs.push({ jobId, status: status ?? "not_found" });
      }
      return {
        result: { jobs },
        artifact: { artifactType: "text", label: "Active Jobs", content: JSON.stringify(jobs, null, 2) },
      };
    }

    case "cancel_active_jobs": {
      const ids = Array.isArray(args.jobIds) && args.jobIds.length ? args.jobIds.map(String) : scanKnownJobIds(req);
      if (ids.length === 0) return { result: { cancelled: [], message: "No known active job IDs in this chat." } };
      const cancelled: any[] = [];
      for (const jobId of ids) {
        let data: any = null;
        for (const endpoint of [`${apiBase}/youtube/cancel/${jobId}`, `${apiBase}/subtitles/cancel/${jobId}`]) {
          const r = await fetch(endpoint, { method: "POST", headers: internalHeaders }).catch(() => null);
          if (r?.ok) { data = await r.json().catch(() => ({ ok: true })); break; }
        }
        cancelled.push({ jobId, result: data ?? "not_found_or_not_cancellable" });
      }
      return {
        result: { cancelled },
        artifact: { artifactType: "text", label: "Cancelled Jobs", content: JSON.stringify(cancelled, null, 2) },
      };
    }

    case "send_result_to_tab": {
      const tab = String(args.tab ?? "").trim();
      if (!tab) throw new Error("Tab is required.");
      sseEvent(res, { type: "navigate", tab });
      return { result: { navigated: true, tab }, artifact: { artifactType: "tab_link", label: `Open ${tab}`, tab } };
    }

    case "create_image": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) throw new Error("Image prompt is required.");
      logTool("Creating image", { prompt });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Creating image..." });
      const image = await generateImageArtifact({
        prompt: `Create a high-quality production-ready image for this request:\n${prompt}`,
        filenamePrefix: "created-image",
      });
      return {
        result: image,
        artifact: {
          artifactType: "image",
          label: image.filename,
          imageUrl: image.imageUrl,
          downloadUrl: image.imageUrl,
          content: image.text,
        },
      };
    }

    case "enhance_image": {
      const image = latestImageAttachment(req);
      if (!image) throw new Error("Attach an image first, then ask me to enhance it.");
      const instructions = String(args.instructions ?? "").trim();
      logTool("Enhancing attached image", { image: image.name });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Enhancing image clarity..." });
      const enhanced = await generateImageArtifact({
        inputImage: image,
        filenamePrefix: "enhanced-image",
        prompt:
          "Enhance this image so it looks crystal clear and newly restored. Preserve the same composition, person/object identity, text meaning, and important details. Remove noise and compression artifacts, recover fine detail naturally, improve lighting/color balance, and sharpen edges without making it look artificial. Do not crop, do not change the scene, and do not invent unrelated objects." +
          (instructions ? `\nExtra user instructions: ${instructions}` : ""),
      });
      return {
        result: enhanced,
        artifact: {
          artifactType: "image",
          label: enhanced.filename,
          imageUrl: enhanced.imageUrl,
          downloadUrl: enhanced.imageUrl,
          content: enhanced.text,
        },
      };
    }

    case "edit_image": {
      const image = latestImageAttachment(req);
      if (!image) throw new Error("Attach an image first, then describe the edit.");
      const instructions = String(args.instructions ?? "").trim();
      if (!instructions) throw new Error("Image edit instructions are required.");
      logTool("Editing attached image", { image: image.name });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Editing image..." });
      const edited = await generateImageArtifact({
        inputImage: image,
        filenamePrefix: "edited-image",
        prompt: `Edit the attached image according to these instructions while preserving unchanged areas carefully:\n${instructions}`,
      });
      return {
        result: edited,
        artifact: {
          artifactType: "image",
          label: edited.filename,
          imageUrl: edited.imageUrl,
          downloadUrl: edited.imageUrl,
          content: edited.text,
        },
      };
    }

    case "describe_image": {
      const image = latestImageAttachment(req);
      if (!image) throw new Error("Attach an image first, then ask me to inspect it.");
      logTool("Describing attached image", { image: image.name });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Inspecting image..." });
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const resp = await ai.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [
            { text: "Describe this image in detail for a video/content creator. Include scene, subjects, visible text, style, quality issues, and practical improvement ideas. Do not identify real people." },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
          ],
        }],
        config: { temperature: 0.2, maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
      });
      const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
      return { result: { content }, artifact: { artifactType: "text", label: "Image Description", content } };
    }

    case "extract_text_from_image": {
      const image = latestImageAttachment(req);
      if (!image) throw new Error("Attach an image first, then ask me to read its text.");
      logTool("Reading text from attached image", { image: image.name });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Reading image text..." });
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const resp = await ai.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [
            { text: "Transcribe all visible text from this image. Preserve line breaks and indicate uncertain words with [?]. Return only the extracted text unless there is no readable text." },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
          ],
        }],
        config: { temperature: 0.1, maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
      });
      const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
      return { result: { content }, artifact: { artifactType: "text", label: "Extracted Text", content } };
    }

    case "write_video_script": {
      const topic = String(args.topic ?? "").trim();
      if (!topic) throw new Error("Script topic is required.");
      const prompt = `Write a production-ready video script.
Topic: ${topic}
Duration: ${args.duration ?? "as appropriate"}
Language: ${args.language ?? "match the user"}
Style: ${args.style ?? "strong hook, clear structure, practical shot direction"}

Include: hook, narration, scene/shot directions, on-screen text, pacing notes, and CTA.`;
      logTool("Writing video script", { topic });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Writing script..." });
      return textModelArtifact("Video Script", prompt);
    }

    case "generate_seo_pack": {
      const topic = String(args.topic ?? "").trim();
      if (!topic) throw new Error("SEO topic is required.");
      const prompt = `Create a YouTube SEO package.
Topic/video: ${topic}
Language: ${args.language ?? "match the user"}
Audience: ${args.audience ?? "general YouTube audience"}

Return: 8 title options, one optimized description, tags, hashtags, thumbnail text options, and a pinned comment.`;
      logTool("Generating SEO pack", { topic });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Generating SEO pack..." });
      return textModelArtifact("YouTube SEO Pack", prompt);
    }

    case "read_uploaded_file": {
      const attachment = latestNonImageAttachment(req);
      if (!attachment) throw new Error("Attach an SRT, TXT, CSV, JSON, PDF, or document first.");
      const task = String(args.task ?? "Summarize and inspect this file.").trim();
      logTool("Reading uploaded file", { filename: attachment.name, mimeType: attachment.mimeType });
      sseEvent(res, { type: "tool_progress", toolId, name, message: `Reading ${attachment.name}...` });

      if ((attachment.mimeType.includes("pdf") || /\.pdf$/i.test(attachment.name)) && attachment.url && !attachment.url.startsWith("data:")) {
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const resp = await ai.models.generateContent({
          model: ULTRA_MODEL,
          contents: [{
            role: "user",
            parts: [
              { text: `${task}\nReturn practical, concise results for a creator/editor.` },
              { fileData: { fileUri: attachment.url } } as any,
            ],
          }],
          config: { temperature: 0.2, maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
        });
        const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
        return { result: { filename: attachment.name, content }, artifact: { artifactType: "text", label: `Read ${attachment.name}`, content } };
      }

      const file = await readAttachmentText(req);
      if (!file) throw new Error("Could not read the latest uploaded file.");
      const content = file.content.slice(0, 120000);
      if (/\.csv$/i.test(file.name) || file.mimeType.includes("csv") || /\.json$/i.test(file.name) || file.mimeType.includes("json")) {
        const analysis = await textModelArtifact(`Read ${file.name}`, `${task}\n\nFile: ${file.name}\nContent:\n${content}`);
        return analysis;
      }
      return {
        result: { filename: file.name, bytes: Buffer.byteLength(file.content, "utf8"), preview: file.content.slice(0, 4000) },
        artifact: { artifactType: "text", label: `Read ${file.name}`, content: file.content.slice(0, 32000) },
      };
    }

    case "convert_subtitles": {
      const outputFormat = String(args.outputFormat ?? "").toLowerCase();
      if (!["srt", "vtt", "txt"].includes(outputFormat)) throw new Error("outputFormat must be srt, vtt, or txt.");
      let content = String(args.content ?? "");
      if (!content.trim()) {
        const file = await readAttachmentText(req);
        content = file?.content ?? "";
      }
      if (!content.trim()) throw new Error("Subtitle content is required.");
      const converted = convertSubtitleText(content, String(args.inputFormat ?? "auto"), outputFormat);
      const filename = String(args.filename ?? `converted-subtitles.${outputFormat}`);
      return {
        result: { filename, bytes: Buffer.byteLength(converted, "utf8") },
        artifact: await downloadableTextArtifact(filename, converted),
      };
    }

    case "compare_subtitles": {
      const first = String(args.first ?? "").trim();
      const second = String(args.second ?? "").trim();
      let prompt: string;
      if (first && second) {
        prompt = `Compare these two subtitle files for timing drift, missing lines, translation/text changes, formatting issues, and quality risks.\n\nFIRST:\n${first.slice(0, 60000)}\n\nSECOND:\n${second.slice(0, 60000)}`;
      } else {
        const file = await readAttachmentText(req);
        const ctx = conversationText(req);
        prompt = `Compare subtitle content available in this conversation/upload. If only one file is available, audit it for timing/text/format issues.\n\nUploaded file:\n${file?.content.slice(0, 60000) ?? "none"}\n\nConversation context:\n${ctx.slice(-60000)}`;
      }
      logTool("Comparing subtitles");
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Comparing subtitle files..." });
      return textModelArtifact("Subtitle Comparison", prompt);
    }

    case "export_text_file": {
      const filename = String(args.filename ?? "export.txt").trim();
      let content = String(args.content ?? "").trim();
      if (!content) {
        const textArtifacts = conversationText(req)
          .split("\n")
          .filter(line => line.startsWith("[TextArtifact:"));
        content = textArtifacts.at(-1)?.replace(/^\[TextArtifact:[^\]]+\]\s*/i, "") ?? "";
      }
      if (!content) throw new Error("No text content found to export.");
      return {
        result: { filename, bytes: Buffer.byteLength(content, "utf8") },
        artifact: await downloadableTextArtifact(filename, content),
      };
    }

    case "run_code_analysis": {
      let data = String(args.data ?? "").trim();
      if (!data) {
        const file = await readAttachmentText(req);
        data = file?.content ?? "";
      }
      if (!data) throw new Error("Provide data or attach a CSV/JSON/text file first.");
      const task = String(args.task ?? "Analyze this data.").trim();
      logTool("Running code analysis", { task });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Running code analysis..." });
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const resp = await ai.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [{ text: `${task}\n\nUse code execution when useful. Return the result, formulas, tables, and any caveats.\n\nDATA:\n${data.slice(0, 120000)}` }],
        }],
        config: {
          tools: [{ codeExecution: {} }] as any,
          temperature: 0.15,
          maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192),
        },
      } as any);
      const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
      return { result: { content }, artifact: { artifactType: "text", label: "Code Analysis", content } };
    }

    case "analyze_youtube_video": {
      const videoUrl = String(args.url ?? "").trim();
      const question = String(args.question ?? "Summarize this video comprehensively.").trim();

      // Validate it's a YouTube URL
      const isYouTubeUrl = /(?:youtube\.com\/watch|youtu\.be\/)/i.test(videoUrl);
      if (!isYouTubeUrl) throw new Error("URL must be a public YouTube video link.");

      logTool("Analyzing YouTube video with Gemini Vision+Audio", { videoUrl, question });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Loading video... Gemini is watching and listening" });

      // Use Gemini's native YouTube video understanding via file_data.
      // The model receives the actual video frames + audio — it truly watches the video.
      const videoAi = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const videoResp = await videoAi.models.generateContent({
        model: ULTRA_MODEL, // Use Pro/Ultra for best video understanding
        contents: [{
          role: "user",
          parts: [
            { text: question },
            { fileData: { fileUri: videoUrl } } as any,
          ],
        }],
        config: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      });

      const analysis = (videoResp.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? "").join("").trim();

      if (!analysis) throw new Error("Model returned no analysis. The video may be private or age-restricted.");

      return {
        result: { url: videoUrl, question, analysis },
        artifact: {
          artifactType: "text",
          label: "Video Analysis",
          content: analysis,
        },
      };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}


// â”€â”€ POST /api/agent/chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/agent/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    res.status(503).json({ error: "AI Copilot not configured â€” add GEMINI_API_KEY to environment." });
    return;
  }

  const { messages = [], model: requestedModel } = req.body as {
    messages: Array<{
      role: "user" | "model";
      content?: string;
      parts?: Array<{
        kind?: string;
        content?: string;
        text?: string;
      }>;
      // Optional structured attachments — set by the frontend when user attaches a file
      attachments?: Array<{
        type: "image" | "video" | "audio" | "document";
        name: string;
        mimeType: string;
        // For images: base64-encoded bytes (no data: prefix) — sent as Gemini inlineData
        data?: string;
        // For video/audio/docs: public URL (S3 presigned or CDN)
        url?: string;
      }>;
    }>;
    model?: string;
  };

  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const normalizedMessages = messages.map((message) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.parts)
          ? message.parts
              .filter((part) => part?.kind === "text" || typeof part?.content === "string" || typeof part?.text === "string")
              .map((part) => part?.content ?? part?.text ?? "")
              .join("")
          : "";
    return {
      ...message,
      content,
      attachments: message.attachments ?? [],
    };
  });

  // Resolve model: "ultra" → ULTRA_MODEL, "default"/undefined → AGENT_MODEL,
  // explicit Gemini model id → use only if allow-listed.
  let activeModel = AGENT_MODEL;
  if (requestedModel === "ultra") {
    activeModel = ULTRA_MODEL;
  } else if (requestedModel && requestedModel !== "default" && ALLOWED_MODELS.has(requestedModel)) {
    activeModel = requestedModel;
  }

  // ── Setup SSE — see lib/sse.ts for streaming-buffer fix details ─────────
  setupSse(res);

  // ⚠️ Use res.on("close") — req.on("close") fires when the request body
  // finishes being consumed (Node http behaviour), which for a normal POST
  // happens immediately after Express reads the body. That would falsely
  // mark the client as disconnected before any streaming starts.
  let clientConnected = true;
  res.on("close", () => { clientConnected = false; });
  const isConnected = () => clientConnected && !res.writableEnded;

  const runId = randomUUID();
  sseEvent(res, { type: "run_start", runId, ts: Date.now(), model: activeModel, ultra: requestedModel === "ultra" });
  console.log(`[agent] run ${runId} model=${activeModel} requested=${requestedModel ?? "default"} msgs=${normalizedMessages.length}`);

  // Heartbeat every 8s — below ALB (60s), nginx (75s), Cloudflare (100s) idle timeouts
  const keepAlive = setInterval(() => {
    if (clientConnected) sseEvent(res, { type: "heartbeat", runId, ts: Date.now() });
  }, 8000);

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    // Build Gemini contents � multimodal aware.
    // Images ? inlineData bytes (Gemini Vision sees actual pixels, same as Claude/ChatGPT).
    // Video/audio/docs ? structured [ATTACHED ...] context injected into text so tools use URL.
    let loopContents: any[] = normalizedMessages
      .filter(m => m.content.trim() || (m.attachments && m.attachments.length > 0))
      .map(m => {
        const parts: any[] = [];
        const textContent = m.content.trim();
        const attachments = (m as any).attachments ?? [];
        const mediaAttachments = attachments.filter((a: any) => a.type !== 'image');
        const imageAttachments  = attachments.filter((a: any) => a.type === 'image');

        if (mediaAttachments.length > 0) {
          const ctxLines = mediaAttachments.map((a: any) => {
            const typeLabel = a.type === 'video' ? 'VIDEO' : a.type === 'audio' ? 'AUDIO' : 'FILE';
            return `[ATTACHED ${typeLabel}: "${a.name}" | URL: ${a.url} | MIME: ${a.mimeType}]\nThe user uploaded this file. Use its URL directly with tools (generate_subtitles, translate_video, etc.) � do NOT ask for a YouTube link.`;
          }).join('\n');
          parts.push({ text: ctxLines + (textContent ? '\n\nUser message: ' + textContent : '') });
        } else if (textContent) {
          parts.push({ text: textContent });
        }

        for (const img of imageAttachments) {
          if ((img as any).data) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: (img as any).data } });
          }
        }
        if (imageAttachments.length > 0 && !textContent && !mediaAttachments.length) {
          parts.unshift({ text: 'The user attached the following image(s):' });
        }
        return { role: m.role, parts };
      });

    let iterations = 0;
    let emptyResponseRetries = 0;

    while (iterations < MAX_ITERATIONS && isConnected()) {
      iterations++;
      const stage = iterations === 1 ? "planning" : "executing";
      sseEvent(res, { type: "thinking", runId, stage, iteration: iterations, total: MAX_ITERATIONS });

      // ── 1. Call Gemini API — with retry on transient empty-output errors ───
      // The error 'model output must contain either output text or tool calls'
      // is a Gemini transient condition. We retry up to 3x before giving up.
      let stream: AsyncIterable<any> | undefined;
      let streamErr: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1000));
          if (isConnected()) sseEvent(res, { type: "heartbeat", runId, ts: Date.now() });
          stream = await ai.models.generateContentStream({
            model: activeModel,
            contents: loopContents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              tools: [{ functionDeclarations: STUDIO_TOOLS as any }],
              toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
              temperature: 0.2,
              maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
              ...(activeModel.includes("thinking") ? {
                thinkingConfig: {
                  thinkingBudget: Number.parseInt(process.env.COPILOT_THINKING_BUDGET ?? "4096", 10) || 4096,
                },
              } : {}),
            },
          });
          streamErr = null;
          break; // success
        } catch (e: any) {
          streamErr = e;
          const isEmptyOutputErr = /model output must contain|both be empty/i.test(e?.message ?? "");
          if (!isEmptyOutputErr || attempt === 2) break; // non-retryable or max attempts
        }
      }
      if (streamErr) throw streamErr;

      let fullText = "";
      const functionCalls: Array<{ name: string; args: Record<string, any> }> = [];
      // ⚠️ rawFcParts preserves thought_signature — Gemini API REQUIRES this
      // to be passed back in history when thinking is active. Dropping it
      // causes INVALID_ARGUMENT: "Function call is missing a thought_signature".
      const rawFcParts: any[] = [];

      for await (const chunk of stream!) {
        if (!isConnected()) break;

        // ── @google/genai v1.x: chunk.text is the incremental text token ───────
        // This is the CORRECT way to get real-time per-token streaming.
        // chunk.candidates[0].content.parts is the OLD v0 API and may batch tokens.
        const chunkText = chunk.text;           // string | undefined
        if (chunkText) {
          fullText += chunkText;
        }

        // Function calls are in candidates[0].content.parts (no change needed here)
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (p.functionCall) {
            functionCalls.push({ name: p.functionCall.name!, args: (p.functionCall.args ?? {}) as Record<string, any> });
            rawFcParts.push(p);
          }
        }
      }

      if (!isConnected()) break;

      // ── 2a. Empty response guard — retry up to 3 times silently ──────────
      // Gemini occasionally returns no text AND no function calls (e.g. quota
      // edge cases, mid-stream interruptions, or the 'model output must contain
      // either output text or tool calls' condition). Retry silently.
      if (fullText.trim() === "" && functionCalls.length === 0) {
        if (emptyResponseRetries < 3) {
          emptyResponseRetries++;
          iterations--; // don't count against MAX_ITERATIONS
          await new Promise(r => setTimeout(r, emptyResponseRetries * 800));
          continue;
        }
        // Three empty responses — give graceful message and stop
        sseEvent(res, { type: "text", content: "Hmm, I'm having trouble responding right now. Please try again in a moment.", runId });
        break;
      }

      // ── 2b. No function calls → final answer, parse suggestions, done ─────
      if (functionCalls.length === 0) {
        // Extract [SUGGESTIONS: "a" | "b" | "c"] from the final text
        const sugMatch = fullText.match(/\[SUGGESTIONS:\s*(.+?)\]\s*$/s);
        if (sugMatch) {
          const items = sugMatch[1].split("|").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
          if (items.length > 0) sseEvent(res, { type: "suggestions", items, runId } as any);
        }
        sseEvent(res, { type: "text", content: fullText, runId });
        break;
      }

      // ── 3. Emit plan event — what tools are about to run ──────────────────
      sseEvent(res, {
        type: "plan",
        runId,
        iteration: iterations,
        steps: functionCalls.map(fc => ({ tool: fc.name, args: fc.args })),
      });

      // ── 4. Execute tools sequentially ─────────────────────────────────────
      const toolResults: any[] = [];
      let iterationHadError = false;
      const preToolText = stripReasoningTags(fullText);

      const runToolCall = async (
        fcIndex: number,
        fc: { name: string; args: Record<string, any> },
      ): Promise<{ index: number; response: any; hadError: boolean }> => {
        const toolId = randomUUID().slice(0, 8);

        sseEvent(res, { type: "tool_start", runId, toolId, name: fc.name, args: fc.args, ts: Date.now() });
        sseEvent(res, { type: "tool_log", runId, toolId, name: fc.name, message: "Tool execution started", level: "info" });
        if (fcIndex === 0 && preToolText) {
          sseEvent(res, { type: "tool_progress", runId, toolId, name: fc.name, message: preToolText });
        }

        let toolResult: any;
        let toolArtifact: object | undefined;
        let hadError = false;

        try {
          const { result, artifact } = await executeTool(fc.name, fc.args, req, res, isConnected, toolId);
          toolResult = result;
          toolArtifact = artifact;
          hadError = Boolean(toolResult?.error);
        } catch (toolErr: any) {
          hadError = true;
          toolResult = { error: toolErr?.message ?? "Tool execution failed" };
          sseEvent(res, { type: "tool_progress", runId, toolId, name: fc.name, status: "error", message: toolErr?.message ?? "Failed" });
          sseEvent(res, { type: "tool_log", runId, toolId, name: fc.name, message: toolErr?.message ?? "Tool failed", level: "error" });
        }

        sseEvent(res, { type: "tool_done", runId, toolId, name: fc.name, result: toolResult, ts: Date.now() });
        if (toolArtifact) sseEvent(res, { type: "artifact", runId, toolId, ...(toolArtifact as object) });

        return {
          index: fcIndex,
          response: { functionResponse: { name: fc.name, response: { result: toolResult } } },
          hadError,
        };
      };

      for (let fcIndex = 0; fcIndex < functionCalls.length && isConnected();) {
        const group = getToolParallelGroup(functionCalls[fcIndex].name);
        if (group === "serial") {
          const completed = await runToolCall(fcIndex, functionCalls[fcIndex]);
          toolResults[completed.index] = completed.response;
          iterationHadError ||= completed.hadError;
          fcIndex += 1;
          continue;
        }

        const limit = TOOL_PARALLEL_LIMITS[group];
        const batch: Array<{ index: number; fc: { name: string; args: Record<string, any> } }> = [];
        while (
          fcIndex < functionCalls.length &&
          batch.length < limit &&
          getToolParallelGroup(functionCalls[fcIndex].name) === group
        ) {
          batch.push({ index: fcIndex, fc: functionCalls[fcIndex] });
          fcIndex += 1;
        }

        const completed = await Promise.all(batch.map(({ index, fc }) => runToolCall(index, fc)));
        for (const item of completed) {
          toolResults[item.index] = item.response;
          iterationHadError ||= item.hadError;
        }
      }

      const orderedToolResults = toolResults.filter(Boolean);

      // \u2500\u2500 5. JUDGE \u2014 verify results, feed correction context to model (hidden) \u2500\u2500
      // Do NOT emit visible text \u2014 the tool card already shows error state.
      // Just push a hidden correction turn so the model self-heals.
      sseEvent(res, { type: "thinking", runId, stage: "verifying", iteration: iterations, total: MAX_ITERATIONS });
      if (iterationHadError) {
        const failedTools = orderedToolResults
          .filter(tr => tr.functionResponse?.response?.result?.error)
          .map(tr => `${tr.functionResponse.name}: ${tr.functionResponse.response.result.error}`)
          .join("; ");
        orderedToolResults.push({ text: `[JUDGE] Tools failed: ${failedTools}. Correct arguments and retry, or explain clearly why it cannot be done.` });
      }


      // ── 6. Build history for next iteration ───────────────────────────────
      // Use rawFcParts (not reconstructed) to preserve thought_signature
      const modelParts: any[] = [];
      if (fullText) modelParts.push({ text: fullText });
      for (const rawFc of rawFcParts) modelParts.push(rawFc);

      loopContents = [
        ...loopContents,
        { role: "model" as const, parts: modelParts },
        { role: "user" as const, parts: orderedToolResults },
      ];

      if (!isConnected()) break;
    }

    // ── Graceful MAX_ITERATIONS exit ──────────────────────────────────────
    if (iterations >= MAX_ITERATIONS && isConnected()) {
      sseEvent(res, { type: "text", content: `\n⚠️ **Note:** Reached the maximum of ${MAX_ITERATIONS} steps. The task may be partially complete — check the results above and ask me to continue if needed.\n`, runId });
    }

    if (isConnected()) {
      sseEvent(res, { type: "done", runId, ts: Date.now() });
    }
  } catch (err: any) {
    if (isConnected()) {
      let errMsg: string = err?.message ?? "Unknown copilot error";
      // Specific: Gemini 'empty output' transient error — always show clean message
      if (/model output must contain|both be empty/i.test(errMsg)) {
        sseEvent(res, { type: "text", content: "I hit a brief connection issue — just send that again and I'll be right on it.", runId });
        sseEvent(res, { type: "done", runId, ts: Date.now() });
        return;
      }
      try {
        const parsed = JSON.parse(errMsg);
        const inner = parsed?.error?.message ?? parsed?.message ?? errMsg;
        // Strip the long docs URL reference
        errMsg = String(inner).split(/\.?\s*Please refer to https?:\/\//).shift()!.trim();
      } catch { /* not JSON, use as-is */ }
      // Also sanitize other known internal Gemini error patterns
      errMsg = errMsg
        .replace(/\[JUDGE\][^\]]*\]/gi, "")
        .replace(/thought_signature/gi, "")
        .trim();
      sseEvent(res, { type: "error", message: errMsg || "Something went wrong — please try again." });
    }
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
});

export default router;
