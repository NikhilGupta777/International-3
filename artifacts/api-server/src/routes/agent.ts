/**
 * AI Studio Copilot Agent Route — Full Agentic Execution
 * POST /api/agent/chat
 *
 * SSE events: text | tool_start | tool_progress | tool_done | artifact | navigate | error | done
 */

import { Router, type Request, type Response } from "express";
import { Modality, Type } from "@google/genai";
import { randomUUID } from "crypto";
import { Sandbox } from "e2b";
import { setupSse } from "../lib/sse";
import { createS3PresignedUpload, getS3SignedDownloadUrl, isS3StorageEnabled, uploadTextToS3, readTextFromS3 } from "../lib/s3-storage";
import { createGeminiClient, isGeminiConfigured, ensureVertexCredentials } from "../lib/gemini-client";
import { getSkillsManifest, buildSkillPrompt } from "../skills/index";
import { logger } from "../lib/logger";

const router = Router();

const AGENT_MODEL = process.env.COPILOT_MODEL ?? "gemini-3.5-flash";
const ULTRA_MODEL = process.env.COPILOT_ULTRA_MODEL ?? "gemini-3.1-pro-preview";
const SEARCH_MODEL = process.env.COPILOT_SEARCH_MODEL ?? "gemini-3.5-flash";
const ALLOWED_MODELS = new Set([
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
]);
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const CLIP_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const MAX_ITERATIONS = Number.parseInt(process.env.COPILOT_MAX_ITERATIONS ?? "24", 10) || 24;
const AGENT_MAX_OUTPUT_TOKENS = Number.parseInt(process.env.COPILOT_MAX_OUTPUT_TOKENS ?? "16384", 10) || 16384;
const E2B_SANDBOX_TIMEOUT_MS = Number.parseInt(process.env.E2B_SANDBOX_TIMEOUT_MS ?? "3600000", 10) || 3600000;
const E2B_COMMAND_TIMEOUT_MS = Number.parseInt(process.env.E2B_COMMAND_TIMEOUT_MS ?? "120000", 10) || 120000;
const E2B_MAX_OUTPUT_CHARS = Number.parseInt(process.env.E2B_MAX_OUTPUT_CHARS ?? "24000", 10) || 24000;
const E2B_MAX_FILE_CHARS = Number.parseInt(process.env.E2B_MAX_FILE_CHARS ?? "120000", 10) || 120000;
const ENABLE_NATIVE_AGENT_SEARCH = !/^(0|false|no|off)$/i.test(
  String(process.env.COPILOT_NATIVE_GOOGLE_SEARCH ?? "true").trim(),
);
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
    case "read_web_page":
    case "check_job_status":
    case "check_active_jobs":
    case "repeat_last_artifact":
    case "read_uploaded_file":
    case "describe_image":
    case "extract_text_from_image":
    case "write_video_script":
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

// ── Resolve base URL for internal API calls ───────────────────────────────
function getApiBase(req: any): string {
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE + "/api";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
  return `${proto}://${host}/api`;
}

function rememberAgentJob(req: any, jobId: unknown): void {
  if (!jobId) return;
  const id = String(jobId).trim();
  if (!id) return;
  if (!(req as any).agentRunJobIds) (req as any).agentRunJobIds = new Set<string>();
  (req as any).agentRunJobIds.add(id);
}

async function cancelAgentRunJobs(req: any, reason: string): Promise<void> {
  const ids = Array.from(((req as any).agentRunJobIds ?? new Set<string>()) as Set<string>);
  if (ids.length === 0) return;
  const apiBase = getApiBase(req);
  const headers = buildInternalHeaders(req);
  await Promise.allSettled(ids.map(async (jobId) => {
    for (const endpoint of [`${apiBase}/youtube/cancel/${jobId}`, `${apiBase}/subtitles/cancel/${jobId}`, `${apiBase}/translator/cancel/${jobId}`]) {
      const res = await fetch(endpoint, { method: "POST", headers }).catch(() => null);
      if (res?.ok) {
        console.log(`[agent] cancelled ${jobId} after ${reason}`);
        return;
      }
    }
  }));
}

// ── Strip model-internal tags before sending to client ─────────────────────
// Gemini 3 Flash / Pro can emit reasoning, thought, response wrappers, and our
// own [SUGGESTIONS:] marker. None of these should reach the browser as raw text.
function stripReasoningTags(text: string, isDelta = false): string {
  let result = text
    // Paired tags with content
    .replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, "")
    .replace(/\[reasoning\][\s\S]*?\[\/reasoning\]/gi, "")
    .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, "")
    .replace(/\[\/?RESPONSE\]/gi, "")
    .replace(/^\[JUDGE\].*$/gim, "")
    .replace(/^\[PLAN\].*$/gim, "")
    .replace(/^\[EXECUTE\].*$/gim, "")
    .replace(/^\[SAY\].*$/gim, "")
    .replace(/^\[WAIT\].*$/gim, "")
    .replace(/^\[TOOL\].*$/gim, "")
    // [SUGGESTIONS: "a" | "b" | "c"] — parsed separately, must not render
    .replace(/\[SUGGESTIONS:[^\]]*\]/gi, "")
    .replace(/\[SUGOESTIONS:[^\]]*\]/gi, "") // typo variant the model emits
    // Strip leaked tool result markers the model may echo from history
    .replace(/\[Tool:\s*\w+\s*\|[^\]]*\]/gi, "")
    .replace(/\[TextArtifact:[^\]]*\][^\[]*/gi, "")
    .replace(/\[Artifact:[^\]]*\]/gi, "")
    // Strip raw S3 presigned URLs (long AWS URLs with signatures)
    .replace(/https?:\/\/[^\s"]*\.s3[^\s"]*(?:X-Amz-[^\s"]*)+/gi, "")
    // Strip leaked tool result JSON — e.g. "| Result: {"audioUrl":"","imageUrl":""}"
    .replace(/\|\s*Result:\s*\{[^}]*\}/gi, "")
    // Strip leaked URL-field JSON objects (any value, including empty strings)
    .replace(/\{(?:\s*"\w+(?:Url|url)"\s*:\s*"[^"]*"\s*,?\s*)+\}/g, "")
    // Collapse excess blank lines left by stripping
    .replace(/\n{3,}/g, "\n\n");
  // Only trim final/complete text — NOT streaming deltas, which may be
  // whitespace-only chunks (spaces between words). Trimming deltas drops
  // spaces and causes words to concatenate ("willwrite", "leveragesstandard").
  if (!isDelta) result = result.trim();
  return result;
}

// ── SSE helper — writes and flushes immediately ───────────────────────────
function sseEvent(res: any, payload: object) {
  const type = (payload as any).type;
  const isTextEvent = type === "text" || type === "text_delta";
  const isDelta = type === "text_delta";
  // Strip reasoning traces from text events — preserve whitespace in deltas
  const safePayload = isTextEvent && (payload as any).content
    ? { ...(payload as any), content: stripReasoningTags((payload as any).content, isDelta) }
    : payload;
  // Skip empty text events (after stripping) — but never skip whitespace-only
  // deltas, which are spaces between words that must be preserved
  if (isTextEvent && !(safePayload as any).content) return;
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
  runId?: string,
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
    sseEvent(res, { type: "tool_progress", runId, toolId, name: toolName, status, percent: percent ?? null, message: liveMessage, jobId });
    if (toolName === "cut_video_clip") {
      sseEvent(res, { type: "tool_log", runId, toolId, name: toolName, message: liveMessage, level: "info" });
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
  runId?: string,
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
    sseEvent(res, { type: "tool_progress", runId, toolId, name: "generate_subtitles", status, percent: progressPct ?? null, message: subtitleMsg, jobId });
    sseEvent(res, { type: "tool_log", runId, toolId, name: "generate_subtitles", message: subtitleMsg, level: "info" });
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
  runId?: string,
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
    sseEvent(res, { type: "tool_progress", runId, toolId, name: "generate_timestamps", status, percent: progressPct ?? null, message: tsMsg, jobId });
    sseEvent(res, { type: "tool_log", runId, toolId, name: "generate_timestamps", message: tsMsg, level: "info" });
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
  let result: number;
  if (parts.length === 3) result = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) result = parts[0] * 60 + parts[1];
  else result = parts[0];
  if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid timestamp: "${ts}"`);
  return result;
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
    description: "Find the most valuable segments from a long YouTube video. Polls until analysis is complete and returns a Best Clips tab artifact. Use for highlights, shorts, viral moments, best clips, or content segment discovery.",
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
    description: "Start a video translation/dubbing job and return a jobId plus Translator tab artifact. The final translated video is produced asynchronously; do not claim the file is ready unless the result endpoint returns a videoUrl.",
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
    description: "Fallback structured web search. Prefer the model's native Google Search grounding for ordinary current-info questions; use this only when the user explicitly asks for raw/source-list search diagnostics, broad research results, or native grounding was insufficient. Returns a grounded synthesized answer plus source URLs. Use maxResults up to 10-20 when broad research is required.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Detailed search query with names, dates, product/version, location, and exact fact needed." },
        maxResults: { type: Type.NUMBER, description: "Max results to return (1-20). Default: 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_web_page",
    description: "Fetch and read the text content of a specific public web page URL. Use after web_search when snippets are not enough, when the user asks to inspect a page/article/docs, or when exact page content matters.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "Public http/https URL to read." },
        task: { type: Type.STRING, description: "What to extract or focus on from the page, e.g. pricing, docs steps, article facts, exact quote context." },
        maxChars: { type: Type.NUMBER, description: "Maximum text characters to return to the model. Default: 20000, max: 60000." },
      },
      required: ["url"],
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
    description: "Cancel known active processing jobs from conversation memory. Use when the user asks to stop/cancel all running downloads, clips, subtitles, timestamps, best-clips, or translation jobs.",
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
    description: "Create a new image from a text prompt. If the user attached an existing image and asks to modify/edit it, use edit_image instead. Use create_image only for generating new images from scratch. IMPORTANT: Before calling this tool, deeply understand what the user actually wants — their intent, mood, use case, and visual style. Then craft a rich, detailed prompt yourself (scene composition, lighting, color palette, style, camera angle, mood, key elements) that will produce the best possible image. Never pass the user's raw text as the prompt — always rewrite it into a production-quality image generation prompt. Choose the best aspectRatio automatically based on the use case.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: "A rich, detailed image generation prompt YOU craft. Include: subject, scene composition, lighting, color palette, art style, camera angle, mood, and key visual elements. Never pass user's raw text — always enhance it into a professional prompt." },
        aspectRatio: { type: Type.STRING, description: "Aspect ratio: '16:9' (YouTube thumbnails, banners, desktop wallpapers), '9:16' (Instagram/YouTube stories, reels, phone wallpapers), '4:3' (presentations, classic photos), '3:2' (DSLR-style photos), '1:1' (profile pictures, social media posts, icons), '4:5' (Instagram portrait posts), '21:9' (ultrawide cinematic banners). Pick the best fit for the content and use case." },
        imageSize: { type: Type.STRING, description: "Resolution: '1K' (standard), '2K' (high quality). Default: 1K." },
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
    description: "Edit the latest attached image according to user instructions while preserving the important parts of the original image. IMPORTANT: Understand what the user actually wants changed, then craft a precise, detailed editing prompt — specify exactly what to change, what to preserve, the desired visual style/mood, and any constraints. Never pass vague instructions like 'make it better'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instructions: { type: Type.STRING, description: "A detailed editing prompt YOU craft from the user's intent. Specify: what exactly to change, what to keep untouched, desired style/mood/colors, and constraints. Be specific about visual outcomes." },
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
    description: "Write a production-ready video script, narration, hook, shot list, or storyboard. IMPORTANT: Before calling, deeply understand the user's vision — their target audience, platform (YouTube/Shorts/Reels/TikTok), tone, and goal. Then craft a rich topic brief with context, not just the raw topic.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "A detailed brief YOU craft from the user's idea. Include: core topic, target audience, platform context, key points to cover, desired emotional arc, and any specific requirements the user mentioned." },
        duration: { type: Type.STRING, description: "Target duration, e.g. 30 seconds, 3 minutes, 8 minutes." },
        language: { type: Type.STRING, description: "Output language. Default follows the user." },
        style: { type: Type.STRING, description: "Tone/style, e.g. cinematic, devotional, news, documentary, shorts, motivational, educational, storytelling." },
      },
      required: ["topic"],
    },
  },
  {
    name: "generate_seo_pack",
    description: "Generate a YouTube SEO package: title options, description, tags, hashtags, pinned comment, and thumbnail text. IMPORTANT: Before calling, understand the video's content, niche, and target audience. Craft a detailed topic brief with context — include video title, key themes, competitor context, trending angles, and the creator's goals. Never pass a bare topic like 'cooking video'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "A detailed brief YOU craft. Include: video title/topic, key themes and talking points, target niche/audience, content style, and any competitive or trending context that would help generate better SEO." },
        language: { type: Type.STRING, description: "Output language. Default follows the user." },
        audience: { type: Type.STRING, description: "Target audience, niche, and platform context." },
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
    description: "Convert subtitle content between SRT, VTT, and plain TXT formats. This only converts existing timing — it does not generate real timings from plain text without timing data.",
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
    description: "Run sandboxed Python for CSV/JSON/text calculations, tables, charts, statistics, and data analysis. Prefer this over mental math when execution is useful. For precise tasks, provide pythonCode that reads /home/user/input.txt and /home/user/task.txt and prints the final answer. Do not use this tool just to write code for the user.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: { type: Type.STRING, description: "Analysis question or calculation to run." },
        data: { type: Type.STRING, description: "CSV/JSON/text data. If omitted, use latest uploaded text file or context." },
        pythonCode: { type: Type.STRING, description: "Optional Python code to run in the sandbox. It should read /home/user/input.txt and /home/user/task.txt, perform the requested analysis, print clear results, and write any useful files under /home/user." },
      },
      required: ["task"],
    },
  },
  {
    name: "run_sandbox_command",
    description: "Run an unrestricted Linux shell command inside this chat's isolated E2B sandbox. Use for real code execution, package installs, filesystem work, public internet fetches, scripts, data processing, and inspecting files created in earlier sandbox calls. This cannot access the production server filesystem.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: "Shell command to execute inside the sandbox, e.g. python3 script.py, pip install pandas, ls -la, curl https://example.com." },
        cwd: { type: Type.STRING, description: "Working directory inside the sandbox. Default: /home/user." },
        timeoutMs: { type: Type.NUMBER, description: "Command timeout in milliseconds. Default is server configured; max 10 minutes." },
        writeFiles: {
          type: Type.ARRAY,
          description: "Optional files to write before running the command.",
          items: {
            type: Type.OBJECT,
            properties: {
              path: { type: Type.STRING, description: "Absolute sandbox path, e.g. /home/user/input.csv." },
              content: { type: Type.STRING, description: "Text content to write." },
            },
            required: ["path", "content"],
          },
        },
        readFiles: {
          type: Type.ARRAY,
          description: "Optional text files to read after the command finishes.",
          items: { type: Type.STRING },
        },
      },
      required: ["command"],
    },
  },
  {
    name: "sandbox_status",
    description: "Report whether E2B is configured and whether this chat currently has a connected sandbox. Use when the user asks what sandbox the agent has, whether it is active, or what environment is available.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "reset_sandbox",
    description: "Destroy this chat's current E2B sandbox and start fresh on the next sandbox command. Use only when the user asks to reset/clear/restart the sandbox.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "generate_music",
    description: "Generate original music using Google Lyria AI. Use for any request to create, compose, or make music/songs/soundtracks/jingles. Craft the best possible Lyria prompt based on the user's intent — describe mood, genre, instruments, tempo, energy, structure, and duration. If duration not specified ask naturally: short (~30s) or full song (~2-3 min)? Also generates matching cover art automatically.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: "Detailed Lyria music generation prompt. Include: genre, mood, tempo/BPM, instruments, energy level, structure (e.g. [0:00-0:10] soft intro...), language if vocals, and any restrictions (e.g. 'no vocals, instrumental only'). Be specific and vivid." },
        duration: { type: Type.STRING, description: "'clip' for a polished 30-second piece (default), or 'full' for a complete song up to ~3 minutes with full song structure (intro, verse, chorus, bridge, outro)." },
        coverArtPrompt: { type: Type.STRING, description: "Optional: describe the cover art visual. If omitted, one is auto-crafted from the music prompt. Example: 'Ancient Indian temple at sunset, cinematic lighting, mystical atmosphere'" },
        aspectRatio: { type: Type.STRING, description: "Cover art aspect ratio: '16:9' (landscape, YouTube/desktop), '9:16' (portrait, Reels/Shorts), '1:1' (square, default). Pick based on where the music will be used." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "analyze_youtube_video",
    description: "Directly analyze a YouTube video by having Gemini watch and listen to it. Can answer ANY question about the video: summarize content, find specific moments, extract quotes, analyze emotions, describe scenes, review quality, translate what is being said, identify speakers, get key points, etc. Works on any public YouTube video. Much more powerful than just reading captions — the model actually sees and hears the video. IMPORTANT: Craft a detailed, specific analytical question — not just 'summarize'. Include what aspects to focus on, what format the answer should be in, and any context from the conversation that would help produce the most useful analysis.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL (must be public)" },
        question: { type: Type.STRING, description: "A detailed analytical question YOU craft. Be specific: what aspects to analyze, what format to return (bullet points, timestamps, quotes, etc.), what context matters, and what would be most useful for the user's actual goal." },
      },
      required: ["url", "question"],
    },
  },
];

function buildAgentTools(includeNativeSearch: boolean): any[] {
  const tools: any[] = [];
  if (includeNativeSearch && ENABLE_NATIVE_AGENT_SEARCH) {
    // Keep Google Search in the main model turn so ordinary searches avoid an
    // extra web_search function-call round trip.
    tools.push({ googleSearch: {} });
  }
  tools.push({ functionDeclarations: STUDIO_TOOLS as any });
  return tools;
}

function isNativeToolConfigError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return /googleSearch|google_search|functionDeclarations|function_declarations|tools?|INVALID_ARGUMENT|400/i.test(message);
}

const SYSTEM_PROMPT = `You are VideoMaking Studio Copilot, an action-focused assistant inside a YouTube/video production web app.

Your job is to help the user create, edit, analyze, download, subtitle, translate, package, and publish video/media content.

# CORE BEHAVIOR

Be direct, practical, and friendly. Talk like a skilled senior production assistant, not a corporate bot.

User can ask anything and you should be ready for any thing any task that user gives - you have all the tools and capabilities (full power of AI + your tools and APIs).

Before using a user-visible tool, briefly tell the user what you're about to do in their language. Keep it one natural sentence. Do not reveal tool names/internal APIs. Do not claim completion before the tool returns.

Examples:
- translate video to English with voice clone:
  "Got it — I'll translate this video to English with voice clone "
- cut 40–57 seconds:
  "Okay — I'll cut the 40–57 second section for you right now ... ()."
- check status:
  "I'll check the latest job status now."

Answer at the length the task deserves:
- Completed tool tasks (download, clip, subtitle, translate queued): short final confirmation.
- Audits, debugging, strategy, scripts, SEO, research, comparisons, or planning: detailed answer.
- No emojis unless the user uses them first.

Match the user's language:
- If the user writes in Hindi or Hinglish, respond in simple Hinglish.
- If the user writes in English, respond in English.
- Keep devotional/religious content respectful.

# INTELLIGENCE FIRST — NO TOOL SPAM

Use your own intelligence first. Do NOT call tools for:
- Normal writing, rewriting, brainstorming, script drafts, hooks, thumbnail text, titles, descriptions, hashtags
- Code generation, HTML/CSS/JS/Python snippets, document drafting, or canvas-style writing when the user only wants content shown in chat/canvas
- SEO ideas, content strategy, video improvement suggestions
- Explaining what you can do, answering general questions
- Simple pasted text/SRT/CSV/JSON analysis
- Visible chat context that already has the answer
- Image description or visible text reading from an attached image (unless the user needs an export/card)

Call tools only when the user needs a real app action or unavailable information:
- YouTube metadata, captions, video analysis, download, clip, subtitles, timestamps, best clips, translation/dubbing
- Image generation/edit/enhancement that must produce an output image file
- File reading, export, format conversion
- Web research or current information
- Job status, cancel, repeat artifact, tab navigation
- Code or data calculation

Always use the smallest, cheapest correct tool. Do not call a more expensive or slower tool when a simpler one solves the task.

# CANVAS AND CODE OUTPUT

USE canvas for: a full HTML page, a complete script/program, a full document, any artifact the user will edit or download, or any code block longer than ~20 lines.
DO NOT use canvas for: short inline snippets shown as examples, brief config lines, a single function quoted in an explanation, or any code that is part of a conversational answer rather than a deliverable.

When canvas IS appropriate:
- Write the artifact directly into canvas using this exact hidden protocol:
  <canvas title="Descriptive Filename.html" language="html">
  ...complete artifact content only, no markdown fences inside...
  </canvas>
- Use the right language value: html, css, javascript, typescript, python, json, markdown, text, srt, or vtt.
- NEVER use markdown triple-backtick fences in chat for code — always use the canvas protocol above. Triple backticks break the UI.
- Keep the chat text outside canvas brief: one sentence before ("Creating this in canvas…") and one sentence after.

When canvas is NOT appropriate (short explanatory snippet):
- Use plain text or a single inline backtick — never triple-backtick fences.
- Do not call run_code_analysis or run_sandbox_command just to generate code or text.
- Use run_code_analysis for supplied data calculations/statistics. For exact calculations, include task-specific pythonCode instead of relying on generic inspection.
- Use run_sandbox_command when the user wants a ChatGPT-like sandbox: execute code, install packages, create/read files, inspect outputs, fetch public internet resources, or run shell commands in an isolated Linux environment.
- The sandbox is persistent per chat session and isolated from the production server. You may be broad inside the sandbox, but never claim it can access local app files unless the user uploaded/provided them.
- Sandbox working directory convention: use /home/user. If you create files, mention filenames in the final answer and use readFiles when the file content matters.
- Do not place app/server secrets into the sandbox. User-provided secrets may be used only for the user's requested task.
- If the user asks to export, download, save, or create a file, call export_text_file with the same complete artifact content.
- For previewable web artifacts, prefer a single complete HTML file with inline CSS/JS unless the user explicitly asks for multiple files.

# AVOID BAD AUTOMATION

Do not run a heavy tool just because a URL exists in context:
- User asks for title/metadata only → get_video_info only, not analyze_youtube_video
- User asks for summary/quotes/moments → analyze_youtube_video, not download + transcribe
- User asks for existing YouTube captions → get_youtube_captions first, not generate_subtitles
- User gives exact clip times → cut_video_clip directly, not web_search first
- User asks for SEO/title/script from their own idea → answer directly unless they ask for export/download
- User asks for visible text from image in chat → answer directly unless they need the text extracted as a file

# CONTEXT AND MEMORY

Treat the visible chat history, prior tool results, artifacts, uploads, job IDs, URLs, filenames, timestamps, and selected options as active memory.

When the user says "do it", "same video", "that file", "previous result", "continue", "fix this", "again", or "send/open it":
- Resolve the reference from the most recent matching context.
- If multiple references are possible, pick the most recent reasonable one and briefly state the assumption only if it affects the result.
- Ask one short clarification only when no reasonable assumption exists or choosing wrong would produce the wrong file.

Never ignore user constraints already given: quality, language, start/end time, "do not edit", "do not revert", "only title", "send now".

# TOOL ARGUMENT QUALITY

Every tool call must have complete, specific arguments. Preserve the user's important details:
- Exact URL or file URL
- Exact timestamps as written ("1:12:03", "40-57 seconds")
- Desired quality, defaulting only when absent
- Target language and language code when known
- Voice cloning / lip sync preference
- Number of clips, duration preference, style, topic focus

For tools with prompt/question/instructions fields, write a production-quality instruction with: user goal, source/context, output format, language, quality bar, constraints, and what to avoid. Never pass vague prompts like "summarize", "fix this", or "make SEO".

Native Google Search grounding is available in your normal answer path. For ordinary current-information or web-search questions, answer directly with native grounding instead of calling web_search first. Use web_search only when the user explicitly asks for raw search diagnostics/source lists, broad result collection, or the native grounded answer is insufficient. Use read_web_page only for exact URLs or after choosing a high-value deep page; avoid reading bare homepages unless the homepage itself is the target.

# WHEN TO ACT VS ASK

Act immediately when the user gave a clear action and required inputs are available.

Ask one short clarification only when:
- A required URL/file/timestamp/language is genuinely missing
- Multiple references exist and the wrong choice would produce the wrong artifact
- The operation is impossible without a missing input

Do not ask "should I continue?" after partial work if the user clearly asked for the full task.

# VIDEO TOOL SELECTION

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
| "translate this video / dub in Hindi/Spanish" | translate_video only |
| "what's trending / latest news / who is X" | web_search first, then maybe a video tool |
| "read this article/page/source" | read_web_page |
| "create/generate an image" | create_image — understand user intent deeply, craft a rich detailed prompt (composition, lighting, style, mood, colors), and pick the right aspect ratio for the use case (16:9 for thumbnails, 9:16 for stories/reels, 1:1 for social posts, etc.) |
| "make this attached image clearer / enhance / restore" | enhance_image |
| "edit this attached image" | edit_image — craft a precise editing prompt from user intent (what to change, what to preserve, style, constraints) |
| "what is in this image" | describe_image only when user needs structured artifact/card; otherwise answer directly |
| "read text from this image" | extract_text_from_image only when user needs artifact/export; otherwise answer directly |
| "make music / generate a song / compose / create soundtrack / background music" | MANDATORY: call generate_music — you MUST call this tool, never describe or write about the music instead. Ask duration naturally if unclear ("short ~30s or a full song ~2-3 min?"). Craft a vivid Lyria prompt with genre, mood, instruments, tempo, structure. FORBIDDEN: saying "Done", "I have generated", "use the download button", or describing the result in ANY way before the tool has actually run and returned. If the tool fails, say it failed — never pretend success. |
| "write script / storyboard / shot list" | write_video_script — craft a detailed topic brief (audience, platform, tone, key points, emotional arc) before calling; only when user needs downloadable file, otherwise answer directly |
| "SEO title/description/tags/thumbnail text" | generate_seo_pack — craft a detailed context brief (video content, niche, trends, goals) before calling; only when user needs structured artifact export, otherwise answer directly |
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
| "run code / use sandbox / install package / execute shell / create files in sandbox" | run_sandbox_command |
| "what sandbox do you have / sandbox status" | sandbox_status |
| "reset/clear/restart sandbox" | reset_sandbox |
| "stop the job / cancel" | cancel_job with the jobId from context |
| "is my job done / progress" | check_job_status |
| User explicitly says "open the X tab" | navigate_to_tab |

Do not double-call tools. If get_video_info already returned title and duration, do not call it again in the same turn.
Use artifact memory: if the user asks for a previous result/link/file again, call repeat_last_artifact instead of printing raw URLs.

# CAPTION VS TRANSCRIPTION

- Existing YouTube captions → get_youtube_captions (instant, uses YouTube's own captions)
- New transcription from audio / translated SRT / no captions available → generate_subtitles
- Fix pasted SRT/VTT/text → fix_subtitles (only when subtitle content is provided or uploaded)

Do not run generate_subtitles if YouTube captions would suffice.

# MULTI-STEP REASONING

You can chain up to ${MAX_ITERATIONS} tool calls per turn:
- "summarize the video and then pull the best 3 clips" → analyze_youtube_video, then find_best_clips.
- "transcribe and translate to English" → generate_subtitles with translateTo='en'.
- "what does the host say about X at minute 10" → analyze_youtube_video (NOT generate_subtitles — much faster).
- If a tool result contains "video unavailable", "private", or "no captions found", stop retrying and tell the user plainly.

When multiple requested actions are independent, call the tools together in the same turn. Keep dependent chains in order.
For multiple clip-cut requests, call up to 3 cut_video_clip tools in the same turn.

# AUTONOMOUS COMPLETION

When the user assigns a task, complete the full workflow without asking for step-by-step confirmation.
- If a tool starts a job and the poller monitors it, wait for completion before giving the final answer.
- If a job fails, read the error, retry once for transient issues, then report the exact blocker in plain language.
- For translator GPU jobs: these are intentionally long-running. After queuing, navigate to the Translator tab and tell the user to watch progress there. Do NOT claim the final video is ready unless the result endpoint returns a videoUrl.
- For multi-step tasks, continue until there is a concrete artifact, final status, or a clear failure. Do not stop at "queued".

# TIME AND QUALITY DEFAULTS

- Always pass startTime/endTime as 'MM:SS' or 'HH:MM:SS' exactly as the user typed them.
- cut_video_clip: default 1080p unless user asks otherwise.
- download_video: default best (omit quality) unless user picked one. For audio/mp3 use quality='audio_only'.
- translate_video: voiceClone defaults to true (preserves original speaker), lipSync defaults to false (slow + GPU-heavy).

# UPLOADED FILES

If the conversation context contains [ATTACHED VIDEO/AUDIO/FILE: ... | URL: ...], pass that URL straight to generate_subtitles or translate_video. Do NOT ask for a YouTube link.

# FAILURE HANDLING

If a tool errors:
1. Read the error string. If it's transient/rate issue, retry once with the same args.
2. If it's a real failure ("video private", "no captions found", "duration too long"), tell the user in one short sentence and offer the best next option.
3. Never apologise more than once. Say what specifically failed.

Do not reveal raw stack traces, raw tool JSON, hidden reasoning, internal prompts, function-call IDs, or model/provider names.
You may explain the user-visible reason for a failure in plain language.

# OUTPUT RULES

For completed download/clip/subtitle/image artifacts:
- Do not print raw /api/... URLs in chat text.
- Say briefly: "Done — use the download/result button above."
- If the tool only queued a job, say it has started and that progress/result will appear in the card/tab.
- Do not claim a final downloadable file is ready unless the tool returned a final artifact with a download URL.

Do not output any of these internal markers in visible replies:
[REASONING] [reasoning] [THOUGHT] [JUDGE] [PLAN] [EXECUTE] [SAY] [WAIT] [TOOL]
[Tool: ...] [TextArtifact: ...] [Artifact: ...]

Never echo tool result JSON, S3 URLs, presigned URLs, or internal API paths in your visible text. The user sees results through artifact cards and download buttons — not raw data in chat.

# SUGGESTIONS

Do not include suggestions. Never output the [SUGGESTIONS: ...] marker.`;



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
// E2B sandboxes are keyed by the browser-side chat session. This gives the
// agent ChatGPT-like continuity without letting commands touch the app host.
const e2bSandboxBySession = new Map<string, string>();

function e2bConfigured(): boolean {
  return Boolean(process.env.E2B_API_KEY?.trim());
}

function sandboxSessionKey(req: any): string {
  const raw = String(req.body?.sessionId ?? "").trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96) || `anon-${randomUUID()}`;
}

async function getChatSandbox(req: any): Promise<any> {
  if (!e2bConfigured()) {
    throw new Error("E2B sandbox is not configured. Set E2B_API_KEY on the API server.");
  }

  const sessionKey = sandboxSessionKey(req);
  const existingId = e2bSandboxBySession.get(sessionKey);
  if (existingId) {
    try {
      const connected = await Sandbox.connect(existingId, { timeoutMs: E2B_SANDBOX_TIMEOUT_MS });
      await connected.setTimeout(E2B_SANDBOX_TIMEOUT_MS).catch(() => {});
      return connected;
    } catch (err) {
      logger.warn({ err, sessionKey, existingId }, "Could not reconnect E2B sandbox; creating a new one");
      e2bSandboxBySession.delete(sessionKey);
    }
  }

  const sandbox = await Sandbox.create({
    timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
    metadata: {
      app: "videomaking-superagent",
      sessionId: sessionKey,
    },
  });
  e2bSandboxBySession.set(sessionKey, sandbox.sandboxId);
  return sandbox;
}

async function resetChatSandbox(req: any): Promise<{ reset: boolean; sandboxId?: string }> {
  const sessionKey = sandboxSessionKey(req);
  const sandboxId = e2bSandboxBySession.get(sessionKey);
  e2bSandboxBySession.delete(sessionKey);
  if (sandboxId && e2bConfigured()) {
    await Sandbox.kill(sandboxId).catch(err => logger.warn({ err, sandboxId }, "Could not kill E2B sandbox"));
  }
  return { reset: true, sandboxId };
}

async function chatSandboxStatus(req: any): Promise<{ configured: boolean; sessionKey: string; sandboxId?: string; running?: boolean; timeoutMs: number }> {
  const configured = e2bConfigured();
  const sessionKey = sandboxSessionKey(req);
  const sandboxId = e2bSandboxBySession.get(sessionKey);
  let running: boolean | undefined;
  if (configured && sandboxId) {
    try {
      const sandbox = await Sandbox.connect(sandboxId, { timeoutMs: E2B_SANDBOX_TIMEOUT_MS });
      running = await sandbox.isRunning();
    } catch {
      running = false;
      e2bSandboxBySession.delete(sessionKey);
    }
  }
  return { configured, sessionKey, sandboxId, running, timeoutMs: E2B_SANDBOX_TIMEOUT_MS };
}

function truncateToolText(value: string, limit = E2B_MAX_OUTPUT_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`;
}

function normalizeSandboxPath(value: unknown, fallback = "/home/user"): string {
  const path = String(value ?? fallback).trim() || fallback;
  if (!path.startsWith("/")) throw new Error(`Sandbox paths must be absolute: ${path}`);
  return path.replace(/\0/g, "");
}

async function runE2BSandboxCommand(req: any, args: Record<string, any>, res: any, runId?: string, toolId?: string, name = "run_sandbox_command") {
  const command = String(args.command ?? "").trim();
  if (!command) throw new Error("command is required.");

  const sandbox = await getChatSandbox(req);
  const cwd = normalizeSandboxPath(args.cwd, "/home/user");
  const timeoutMsRaw = Number(args.timeoutMs ?? E2B_COMMAND_TIMEOUT_MS);
  const timeoutMs = Math.max(1000, Math.min(Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : E2B_COMMAND_TIMEOUT_MS, 10 * 60 * 1000));
  await sandbox.files.makeDir(cwd).catch(() => {});

  const writeFiles = Array.isArray(args.writeFiles) ? args.writeFiles : [];
  for (const file of writeFiles.slice(0, 12)) {
    const path = normalizeSandboxPath(file?.path);
    const content = String(file?.content ?? "");
    if (content.length > E2B_MAX_FILE_CHARS) throw new Error(`Sandbox file too large: ${path}`);
    await sandbox.files.write(path, content);
  }

  let liveOut = "";
  let liveErr = "";
  sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Running in sandbox: ${command.slice(0, 120)}` });
  const result = await sandbox.commands.run(command, {
    cwd,
    timeoutMs,
    onStdout: (data: string) => { liveOut += data; },
    onStderr: (data: string) => { liveErr += data; },
  });

  const readFiles = Array.isArray(args.readFiles) ? args.readFiles : [];
  const files: Array<{ path: string; content: string }> = [];
  for (const rawPath of readFiles.slice(0, 8)) {
    const path = normalizeSandboxPath(rawPath);
    try {
      const content = await sandbox.files.read(path, { format: "text" });
      files.push({ path, content: truncateToolText(String(content), E2B_MAX_FILE_CHARS) });
    } catch (err: any) {
      files.push({ path, content: `[could not read file: ${String(err?.message ?? err)}]` });
    }
  }

  const stdout = truncateToolText(String(result.stdout || liveOut || ""));
  const stderr = truncateToolText(String(result.stderr || liveErr || ""));
  const summary = [
    `$ ${command}`,
    `exitCode: ${result.exitCode}`,
    stdout ? `\nstdout:\n${stdout}` : "",
    stderr ? `\nstderr:\n${stderr}` : "",
    files.length ? `\nfiles:\n${files.map(f => `--- ${f.path} ---\n${f.content}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  return {
    result: {
      sandbox: "e2b",
      sandboxId: sandbox.sandboxId,
      cwd,
      exitCode: result.exitCode,
      error: result.error,
      stdout,
      stderr,
      files,
    },
    artifact: { artifactType: "text", label: "Sandbox Output", content: summary },
  };
}

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
  aspectRatio?: string;
  imageSize?: string;
}): Promise<{ imageUrl: string; filename: string; text: string }> {
  const ai = createGeminiClient();
  const parts: any[] = [{ text: params.prompt }];
  if (params.inputImage) {
    parts.push({ inlineData: { mimeType: params.inputImage.mimeType, data: params.inputImage.data } });
  }
  const VALID_RATIOS = new Set(["1:1","1:4","1:8","2:3","3:2","3:4","4:1","4:3","4:5","5:4","8:1","9:16","16:9","21:9"]);
  const VALID_SIZES = new Set(["512","1K","2K","4K"]);
  const aspectRatio = params.aspectRatio && VALID_RATIOS.has(params.aspectRatio) ? params.aspectRatio : undefined;
  const imageSize = params.imageSize && VALID_SIZES.has(params.imageSize) ? params.imageSize : undefined;
  const resp = await ai.models.generateContent({
    model: process.env.COPILOT_IMAGE_MODEL ?? "gemini-3.1-flash-image-preview",
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE] as any,
      ...(aspectRatio || imageSize ? { responseFormat: { image: { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) } } } : {}),
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

// ── Lyria music generation ────────────────────────────────────────────────────

async function generateLyriaMusic(params: {
  prompt: string;
  durationMode: "clip" | "full";
}): Promise<{ audioUrl: string; filename: string; mimeType: string }> {
  const model = params.durationMode === "full"
    ? (process.env.LYRIA_FULL_MODEL ?? "lyria-3-pro-preview")
    : (process.env.LYRIA_CLIP_MODEL ?? "lyria-3-clip-preview");

  // Official Google notebook: use models.generateContent with responseModalities=["AUDIO","TEXT"]
  // This works with the existing Vertex AI client — no REST workaround needed.
  // Ref: https://github.com/GoogleCloudPlatform/generative-ai/blob/main/audio/music/getting-started/lyria3_music_generation.ipynb
  const ai = createGeminiClient();
  const resp = await ai.models.generateContent({
    model,
    contents: params.prompt,
    config: { responseModalities: ["AUDIO", "TEXT"] } as any,
  } as any);

  // Response: candidates[0].content.parts — audio in part.inlineData.data
  for (const part of (resp as any).candidates?.[0]?.content?.parts ?? []) {
    const audioData: string | undefined = part.inlineData?.data;
    const mimeType: string = part.inlineData?.mimeType ?? "audio/mpeg";
    if (audioData) {
      const ext = mimeType.includes("wav") ? "wav" : "mp3";
      const filename = `lyria-${Date.now()}.${ext}`;
      if (!isS3StorageEnabled()) {
        return { audioUrl: `data:${mimeType};base64,${audioData}`, filename, mimeType };
      }
      const upload = await createS3PresignedUpload({
        jobId: randomUUID(), namespace: "agent-music", filename, contentType: mimeType,
      });
      const put = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: Buffer.from(audioData, "base64"),
      });
      if (!put.ok) throw new Error(`Audio upload failed: ${put.status}`);
      const audioUrl = await getS3SignedDownloadUrl({
        key: upload.key, filename: upload.filename, expiresInSec: 7 * 24 * 60 * 60,
      });
      return { audioUrl, filename: upload.filename, mimeType };
    }
  }
  throw new Error("Lyria returned no audio. Try a different prompt or check that your Vertex AI project has Lyria 3 access.");
}

async function textModelArtifact(label: string, prompt: string): Promise<{ result: any; artifact: object }> {
  const ai = createGeminiClient();
  const resp = await ai.models.generateContent({
    model: ULTRA_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    const r = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer));
    if (!r.ok) throw new Error(`Could not read uploaded file: ${r.status}`);
    const contentType = r.headers.get("content-type") ?? attachment.mimeType;
    if (contentType.includes("pdf")) {
      return { content: `[PDF attachment: ${url}]`, name: attachment.name, mimeType: contentType };
    }
    return { content: await r.text(), name: attachment.name, mimeType: contentType };
  }
  return null;
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
      artifactType: "text",
      label: filename,
      content: content.slice(0, 120000),
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
  return {
    artifactType: "text",
    label: uploaded.filename,
    content: content.slice(0, 120000),
    downloadUrl,
  };
}

function scanKnownJobIds(req: any): string[] {
  const ids = new Set<string>();
  const text = conversationText(req);
  for (const match of text.matchAll(/\bjob(?:Id)?:?\s*([a-f0-9-]{8,})\b/gi)) ids.add(match[1]);
  for (const match of text.matchAll(/\/api\/(?:youtube\/file|subtitles\/status|translator\/status|translator\/result)\/([a-f0-9-]{8,})/gi)) ids.add(match[1]);
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

function htmlToReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|header|footer|main|li|ul|ol|h[1-6]|tr|table|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function isInternalHost(hostname: string): boolean {
  // Block AWS metadata, loopback, and private RFC-1918 ranges
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every(n => n >= 0 && n <= 255)) {
    if (parts[0] === 127) return true;                              // 127.x.x.x
    if (parts[0] === 10) return true;                               // 10.x.x.x
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16-31.x.x
    if (parts[0] === 192 && parts[1] === 168) return true;         // 192.168.x.x
    if (parts[0] === 169 && parts[1] === 254) return true;         // 169.254.x.x (AWS metadata)
    if (parts[0] === 0) return true;                                // 0.x.x.x
  }
  return false;
}

async function fetchReadableWebPage(url: string, maxChars: number): Promise<{ title?: string; finalUrl: string; contentType: string; text: string }> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https URLs can be read.");
  if (isInternalHost(parsed.hostname)) throw new Error("Cannot read internal/private network URLs.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "VideoMakingStudioAgent/1.0 (+https://videomaking.in)",
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
      },
    });
    if (!r.ok) throw new Error(`Page fetch failed: HTTP ${r.status}`);
    const contentType = r.headers.get("content-type") ?? "";
    const raw = await r.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g, " ").trim();
    const text = contentType.includes("html") ? htmlToReadableText(raw) : raw.trim();
    return {
      title,
      finalUrl: r.url || parsed.toString(),
      contentType,
      text: text.slice(0, Math.max(1000, Math.min(60000, maxChars))),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeTool(
  name: string,
  args: Record<string, any>,
  req: any,
  res: any,
  isConnected: () => boolean,
  toolId?: string,
  runId?: string,
): Promise<{ result: any; artifact?: object }> {
  const apiBase = getApiBase(req);
  const internalHeaders = buildInternalHeaders(req);
  const logTool = (message: string, details?: Record<string, any>) => {
    sseEvent(res, { type: "tool_log", runId, toolId, name, message, ...(details ? { details } : {}) } as any);
  };

  switch (name) {

    case "get_video_info": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/info" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Fetching video metadata..." });
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw new Error(err.error ?? `Info fetch failed: ${r.status}`); }
      const data = await r.json().catch(() => ({ error: "Failed to fetch info" })) as any;
      // Build a readable summary for the artifact card
      const infoLines: string[] = [];
      if (data.title) infoLines.push(data.title);
      if (data.duration) infoLines.push(`Duration: ${data.duration}`);
      if (data.uploader) infoLines.push(`Channel: ${data.uploader}`);
      if (data.view_count != null) infoLines.push(`${Number(data.view_count).toLocaleString()} views`);
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Starting clip cut (${args.startTime} → ${args.endTime})...` });
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
      rememberAgentJob(req, jobId);
      logTool("Clip cut job accepted", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, {
        type: "tool_progress",
        runId,
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

      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId, runId);
      const downloadUrl = `/api/youtube/file/${jobId}`;
      return {
        result: { jobId, downloadUrl, startTime: args.startTime, endTime: args.endTime, url: args.url, quality },
        artifact: { artifactType: "download", label: `Clip ready: ${args.startTime} → ${args.endTime}`, downloadUrl, jobId },
      };
    }

    case "download_video": {
      const quality = args.quality ?? "best";
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/download" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Starting download (${quality})...` });
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
      rememberAgentJob(req, jobId);
      logTool("Download job accepted", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", runId, toolId, name, status: "processing", message: "Starting download...", jobId, url: args.url } as any);

      const final = await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId, runId);
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
      const isUploadedFile = !!inputUrl && !inputUrl.includes("youtube.com") && !inputUrl.includes("youtu.be") && !inputUrl.includes("youtube-nocookie.com");
      logTool("Starting subtitle generation", { url: inputUrl, mode: isUploadedFile ? "uploaded-file" : "youtube" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: isUploadedFile ? "Transcribing uploaded file..." : "Starting subtitle generation..." });

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
      rememberAgentJob(req, subtitleJobId);
      logTool("Subtitles job accepted", { jobId: subtitleJobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", runId, toolId, name: "generate_subtitles", status: "processing", message: "Starting subtitle generation...", jobId: subtitleJobId, url: args.url } as any);

      const final = await pollSubtitleUntilDone(res, `${apiBase}/subtitles/status/${subtitleJobId}`, subtitleJobId, internalHeaders, isConnected, toolId, runId);
      return {
        result: { jobId: subtitleJobId, srtFilename: final.srtFilename, url: args.url, language: args.language, translateTo: args.translateTo },
        artifact: {
          artifactType: "tab",
          label: `Subtitles ready${args.translateTo ? ` (${args.translateTo})` : ""}: ${final.srtFilename ?? "subtitles.srt"}`,
          tab: "subtitles",
          jobId: subtitleJobId,
        },
      };
    }

    case "find_best_clips": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/clips" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Starting best clips AI analysis..." });
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
      rememberAgentJob(req, jobId);
      logTool("Best clips job accepted — polling for results...", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", runId, toolId, name: "find_best_clips", status: "processing", message: "Starting best clips analysis...", jobId, url: args.url } as any);

      // Poll until analysis is done (same pattern as clip/download)
      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId, runId);
      return {
        result: { jobId, message: "Best clips analysis complete. View results in the Best Clips tab." },
        artifact: { artifactType: "tab_link", label: "Best Clips ready — open tab to download", tab: "clips", jobId },
      };
    }

    case "generate_timestamps": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/timestamps" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Generating timestamps..." });
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
      rememberAgentJob(req, jobId);
      logTool("Timestamps job accepted", { jobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", runId, toolId, name: "generate_timestamps", status: "processing", message: "Starting timestamp generation...", jobId, url: args.url } as any);

      const final = await pollTimestampsUntilDone(res, `${apiBase}/youtube/timestamps/status/${jobId}`, jobId, internalHeaders, isConnected, toolId, runId);
      // Format timestamps as readable text
      let tsContent = "";
      if (final.timestamps) {
        if (typeof final.timestamps === "string") {
          tsContent = final.timestamps;
        } else if (Array.isArray(final.timestamps)) {
          tsContent = final.timestamps.map((t: any) => `${t.time ?? t.timestamp ?? ""} ${t.title ?? t.label ?? t.text ?? ""}`).join("\n");
        } else {
          tsContent = JSON.stringify(final.timestamps, null, 2);
        }
      }
      return {
        result: { jobId, timestamps: final.timestamps },
        artifact: tsContent ? {
          artifactType: "text",
          label: "Timestamps generated",
          content: tsContent,
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
      sseEvent(res, { type: "navigate", runId, tab: args.tab });
      return { result: { navigated: true, tab: args.tab } };
    }

    case "translate_video": {
      // Detect uploaded file URL (S3/CDN) vs YouTube URL.
      // Uploaded files: POST to /translator/submit-from-url — no YouTube download needed.
      // YouTube URLs: download via youtube/stream → S3 → submit.
      const videoUrl = (args.url ?? args.fileUrl ?? "") as string;
      const isUploadedFile = !!videoUrl && !videoUrl.includes("youtube.com") && !videoUrl.includes("youtu.be") && !videoUrl.includes("youtube-nocookie.com");
      logTool("Starting video translation job", { url: videoUrl, mode: isUploadedFile ? "uploaded-file" : "youtube" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: isUploadedFile ? "Registering uploaded file for GPU translation..." : "Downloading video for translation..." });

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
        sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Uploading video to GPU worker queue..." });
        const ytStreamR = await fetch(`${apiBase}/youtube/stream?url=${encodeURIComponent(videoUrl)}`, { headers: internalHeaders });
        if (!ytStreamR.ok) throw new Error(`YouTube stream failed: ${ytStreamR.status}`);
        const uploadR = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: ytStreamR.body, duplex: "half" } as any);
        if (!uploadR.ok) throw new Error(`S3 upload failed: ${uploadR.status}`);
        sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Submitting GPU translation job (${args.targetLang ?? "Hindi"})...` });
        const submitR = await fetch(`${apiBase}/translator/submit`, {
          method: "POST", headers: internalHeaders,
          body: JSON.stringify({ jobId: tvJobId, s3Key, targetLang: args.targetLang ?? "Hindi", targetLangCode: args.targetLangCode ?? "hi", voiceClone: args.voiceClone ?? true, lipSync: args.lipSync ?? false, filename: "input.mp4" }),
        });
        if (!submitR.ok) { const err = await submitR.json().catch(() => ({})) as any; throw new Error(err.error ?? `Translation submit failed: ${submitR.status}`); }
      }
      rememberAgentJob(req, tvJobId);
      logTool("Translation job submitted", { jobId: tvJobId });
      // Emit initial progress so frontend can track in Activity Panel
      sseEvent(res, { type: "tool_progress", runId, toolId, name: "translate_video", status: "processing", message: "Job submitted to GPU worker...", jobId: tvJobId, url: videoUrl, targetLang: args.targetLang ?? "Hindi" } as any);

      sseEvent(res, { type: "navigate", runId, tab: "translator" });
      return {
        result: { jobId: tvJobId, message: "Translation job queued on GPU worker. Track progress in the Translator tab." },
        artifact: { artifactType: "tab_link", label: `Translating to ${args.targetLang ?? "Hindi"} — open Translator tab`, tab: "translator", jobId: tvJobId },
      };
    }

    case "get_youtube_captions": {
      logTool("Fetching YouTube captions", { url: args.url });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Fetching captions from YouTube..." });
      const language = args.language ?? "en";
      const downloadUrl = `/api/youtube/subtitles?url=${encodeURIComponent(args.url)}&lang=${encodeURIComponent(language)}&format=srt`;
      const r = await fetch(`${apiBase}/youtube/subtitles?url=${encodeURIComponent(args.url)}&lang=${encodeURIComponent(language)}&format=srt`, { headers: internalHeaders });
      const content = await r.text();
      if (!r.ok) {
        let message = content || `Captions fetch failed: ${r.status}`;
        try {
          const parsed = JSON.parse(content) as { error?: string };
          message = parsed.error ?? message;
        } catch { }
        throw new Error(message);
      }
      return {
        result: { filename: "subtitles.srt", language, bytes: Buffer.byteLength(content, "utf8") },
        artifact: { artifactType: "download", label: "YouTube captions: subtitles.srt", downloadUrl },
      };
    }

    case "fix_subtitles": {
      logTool("Fixing subtitle content");
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Fixing subtitles..." });
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
      let data: any = { error: "not_found" };
      for (const endpoint of [`${apiBase}/youtube/cancel/${args.jobId}`, `${apiBase}/subtitles/cancel/${args.jobId}`, `${apiBase}/translator/cancel/${args.jobId}`]) {
        const r = await fetch(endpoint, { method: "POST", headers: internalHeaders }).catch(() => null);
        if (r?.ok) { data = await r.json().catch(() => ({ ok: true })); break; }
      }
      return { result: data };
    }

    case "check_job_status": {
      logTool("Checking job status", { jobId: args.jobId });
      let data: any = { status: "not_found" };
      for (const endpoint of [`${apiBase}/youtube/progress/${args.jobId}`, `${apiBase}/subtitles/status/${args.jobId}`, `${apiBase}/translator/status/${args.jobId}`]) {
        const r = await fetch(endpoint, { headers: internalHeaders }).catch(() => null);
        if (r?.ok) { const parsed = await r.json().catch(() => null); if (parsed) { data = parsed; break; } }
      }
      return { result: data };
    }

    case "web_search": {
      const query = String(args.query ?? "").trim();
      const requestedMax = Number(args.maxResults ?? 10);
      const maxResults = Math.max(1, Math.min(20, Number.isFinite(requestedMax) ? requestedMax : 10));
      const startedAt = Date.now();
      if (!query) throw new Error("Search query is required.");
      logTool("Searching the web", { query, maxResults });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Searching: "${query}"...` });

      // Strategy: Use Gemini's native Google Search grounding tool.
      // Uses Vertex Gemini when configured, otherwise falls back to the API key provider.
      // If that fails, fall back to Tavily / Serper if keys are set.
      const TAVILY_KEY = process.env.TAVILY_API_KEY;
      const SERPER_KEY = process.env.SERPER_API_KEY;

      try {
        // Fallback structured search path. The main agent turn also receives
        // native Google Search; this tool is for explicit source-list/debug use
        // or when the model needs a structured search artifact.
        const searchAi = createGeminiClient();
        const searchResp = await searchAi.models.generateContent({
          model: SEARCH_MODEL,
          contents: [{
            role: "user", parts: [{
              text: [
                `Search the web for: ${query}`,
                `Use broad coverage, compare multiple sources, and include up to ${maxResults} useful source URLs if available.`,
                "Give enough detail to answer accurately. Do not limit yourself to three sites when more are relevant.",
              ].join("\n")
            }]
          }],
          config: {
            tools: [{ googleSearch: {} }] as any,
            maxOutputTokens: Math.min(4096, AGENT_MAX_OUTPUT_TOKENS),
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
        const uniqueSources = [...new Set(sources)].slice(0, maxResults);
        const sourcesText = uniqueSources.length > 0 ? `\n\nSources:\n${uniqueSources.map((s, i) => `[${i + 1}] ${s}`).join("\n")}` : "";
        return {
          result: {
            query,
            answer: groundedAnswer + sourcesText,
            grounded: true,
            sources: uniqueSources,
            sourceCount: uniqueSources.length,
            elapsedMs: Date.now() - startedAt,
            note: "This is a synthesized grounded-search result, not raw SERP HTML. Use read_web_page on selected deep URLs when exact page text matters.",
          },
        };
      } catch (groundingErr: any) {
        logTool(`Grounding failed (${groundingErr?.message}), trying fallbacks`, {});
        // Fallback 1: Tavily
        if (TAVILY_KEY) {
          const r = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
            body: JSON.stringify({ query, max_results: maxResults, search_depth: "advanced", include_answer: true, include_raw_content: true }),
          });
          if (r.ok) {
            const data = await r.json() as any;
            const results = (data.results ?? []).slice(0, maxResults).map((item: any, i: number) =>
              `[${i + 1}] ${item.title}\n${item.content ?? item.snippet ?? ""}\n${item.raw_content ? `Page content excerpt: ${String(item.raw_content).slice(0, 4000)}\n` : ""}Source: ${item.url}`
            ).join("\n\n");
            return {
              result: {
                query,
                answer: (data.answer ? `${data.answer}\n\n` : "") + results,
                results: data.results?.slice(0, maxResults) ?? [],
                elapsedMs: Date.now() - startedAt,
              },
            };
          }
        }
        // Fallback 2: Serper
        if (SERPER_KEY) {
          const r = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_KEY },
            body: JSON.stringify({ q: query, num: maxResults }),
          });
          if (r.ok) {
            const data = await r.json() as any;
            const organic = ((data.organic ?? []) as any[]).slice(0, maxResults);
            const results = organic.map((item: any, i: number) =>
              `[${i + 1}] ${item.title}\n${item.snippet ?? ""}\nSource: ${item.link}`
            ).join("\n\n");
            return { result: { query, answer: results, results: organic, elapsedMs: Date.now() - startedAt } };
          }
        }
        // All methods failed
        throw new Error(`Search unavailable: ${groundingErr?.message}`);
      }
    }

    case "read_web_page": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("URL is required.");
      const task = String(args.task ?? "").trim();
      const maxChars = Number(args.maxChars ?? 20000);
      logTool("Reading web page", { url, task, maxChars });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Reading page: ${url}` });
      const page = await fetchReadableWebPage(url, Number.isFinite(maxChars) ? maxChars : 20000);
      return {
        result: {
          url,
          task,
          title: page.title,
          finalUrl: page.finalUrl,
          contentType: page.contentType,
          text: page.text,
        },
      };
    }

    case "do_full_package": {
      const url = String(args.url ?? "").trim();
      if (!url) throw new Error("YouTube URL is required.");
      const language = String(args.language ?? "en");
      const quality = args.quality ?? "best";
      const results: Record<string, any> = {};
      const artifacts: object[] = [];

      const runStep = async (stepName: string, stepArgs: Record<string, any>) => {
        sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Full package: ${stepName.replace(/_/g, " ")}...` });
        const sub = await executeTool(stepName, stepArgs, req, res, isConnected, toolId, runId);
        results[stepName] = sub.result;
        if (sub.artifact) {
          artifacts.push(sub.artifact);
          sseEvent(res, { type: "artifact", runId, toolId, ...(sub.artifact as object) });
        }
        return sub;
      };

      // Phase 1: metadata first (needed by SEO pack)
      await runStep("get_video_info", { url });

      // Phase 2: run independent heavy tasks in parallel
      const phase2 = await Promise.allSettled([
        runStep("download_video", { url, quality }),
        runStep("analyze_youtube_video", {
          url,
          question: `Summarize this video for a creator. Include key points, emotional hooks, reusable quotes, and content opportunities.${args.instructions ? ` Focus: ${args.instructions}` : ""}`,
        }),
        runStep("generate_timestamps", { url }),
        runStep("generate_seo_pack", {
          topic: results.get_video_info?.title ?? url,
          audience: args.instructions ?? "YouTube audience",
        }),
        (async () => {
          try {
            await runStep("get_youtube_captions", { url, language });
          } catch (err: any) {
            results.get_youtube_captions = { error: err?.message ?? "Direct captions unavailable" };
            await runStep("generate_subtitles", { url, language });
          }
        })(),
        runStep("find_best_clips", { url, instructions: args.instructions ?? "" }),
      ]);
      for (const r of phase2) {
        if (r.status === "rejected") console.warn(`[agent] full_package step failed: ${r.reason?.message ?? r.reason}`);
      }

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
      // Format as human-readable summary instead of raw JSON
      const summaryLines = jobs.map((j, i) => {
        const s = j.status;
        if (s === "not_found") return `${i + 1}. Job ${j.jobId.slice(0, 8)}... — not found`;
        const pct = s?.percent != null ? ` (${s.percent}%)` : "";
        const step = s?.step ?? s?.status ?? "unknown";
        return `${i + 1}. Job ${j.jobId.slice(0, 8)}... — ${step}${pct}`;
      });
      return {
        result: { jobs },
        artifact: { artifactType: "text", label: "Active Jobs", content: summaryLines.join("\n") },
      };
    }

    case "cancel_active_jobs": {
      const ids = Array.isArray(args.jobIds) && args.jobIds.length ? args.jobIds.map(String) : scanKnownJobIds(req);
      if (ids.length === 0) return { result: { cancelled: [], message: "No known active job IDs in this chat." } };
      const cancelled: any[] = [];
      for (const jobId of ids) {
        let data: any = null;
        for (const endpoint of [`${apiBase}/youtube/cancel/${jobId}`, `${apiBase}/subtitles/cancel/${jobId}`, `${apiBase}/translator/cancel/${jobId}`]) {
          const r = await fetch(endpoint, { method: "POST", headers: internalHeaders }).catch(() => null);
          if (r?.ok) { data = await r.json().catch(() => ({ ok: true })); break; }
        }
        cancelled.push({ jobId, result: data ?? "not_found_or_not_cancellable" });
      }
      // Format as human-readable summary instead of raw JSON
      const cancelLines = cancelled.map((c, i) => {
        const outcome = c.result === "not_found_or_not_cancellable" ? "not found or already done" : "cancelled";
        return `${i + 1}. Job ${c.jobId.slice(0, 8)}... — ${outcome}`;
      });
      return {
        result: { cancelled },
        artifact: { artifactType: "text", label: "Cancelled Jobs", content: cancelLines.join("\n") },
      };
    }

    case "send_result_to_tab": {
      const tab = String(args.tab ?? "").trim();
      if (!tab) throw new Error("Tab is required.");
      sseEvent(res, { type: "navigate", runId, tab });
      return { result: { navigated: true, tab }, artifact: { artifactType: "tab_link", label: `Open ${tab}`, tab } };
    }

    case "create_image": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) throw new Error("Image prompt is required.");
      const aspectRatio = String(args.aspectRatio ?? "").trim() || undefined;
      const imageSize = String(args.imageSize ?? "").trim() || undefined;
      logTool("Creating image", { prompt, aspectRatio, imageSize });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Creating image..." });
      const image = await generateImageArtifact({
        prompt,
        filenamePrefix: "created-image",
        aspectRatio,
        imageSize,
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Enhancing image clarity..." });
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Editing image..." });
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Inspecting image..." });
      const ai = createGeminiClient();
      const resp = await ai.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [
            { text: "Describe this image in detail for a video/content creator. Include scene, subjects, visible text, style, quality issues, and practical improvement ideas. Do not identify real people." },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
          ],
        }],
        config: { maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
      });
      const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
      return { result: { content }, artifact: { artifactType: "text", label: "Image Description", content } };
    }

    case "extract_text_from_image": {
      const image = latestImageAttachment(req);
      if (!image) throw new Error("Attach an image first, then ask me to read its text.");
      logTool("Reading text from attached image", { image: image.name });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Reading image text..." });
      const ai = createGeminiClient();
      const resp = await ai.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [
            { text: "Transcribe all visible text from this image. Preserve line breaks and indicate uncertain words with [?]. Return only the extracted text unless there is no readable text." },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
          ],
        }],
        config: { maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Writing script..." });
      return textModelArtifact("Video Script", prompt);
    }

    case "generate_music": {
      const musicPrompt = String(args.prompt ?? "").trim();
      if (!musicPrompt) throw new Error("Music prompt is required.");
      const durationMode = String(args.duration ?? "clip") === "full" ? "full" : "clip";
      const aspect = String(args.aspectRatio ?? "1:1");
      const rawCoverPrompt = String(args.coverArtPrompt ?? "").trim();
      const coverArtPrompt = rawCoverPrompt ||
        `Music album cover art for: ${musicPrompt.slice(0, 100)}. Cinematic, professional, moody lighting, high quality digital art.`;

      logTool("Generating music + cover art", { durationMode, model: durationMode === "full" ? "lyria-3-pro-preview" : "lyria-3-clip-preview" });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Composing ${durationMode === "full" ? "full song (~2-3 min)" : "30-second clip"} with Lyria AI…` });

      // Send progress ticks every 10s so the SSE connection stays active during
      // the Lyria generation (which can take 30-90 seconds for full songs).
      const musicProgress = setInterval(() => {
        if (isConnected()) sseEvent(res, { type: "tool_progress", runId, toolId, name, message: durationMode === "full" ? "Composing full song… (this can take up to 90s)" : "Composing 30-second clip…" });
      }, 10_000);

      // Run music + cover art in parallel. Cover art failure is non-fatal —
      // the audio has already been uploaded to S3 so we deliver it regardless.
      let audio: Awaited<ReturnType<typeof generateLyriaMusic>>;
      let cover: { imageUrl: string; filename: string; text: string } | null = null;
      try {
        const results = await Promise.allSettled([
          generateLyriaMusic({ prompt: musicPrompt, durationMode }),
          generateImageArtifact({ prompt: coverArtPrompt, filenamePrefix: "music-cover", aspectRatio: aspect }),
        ]);
        clearInterval(musicProgress);

        if (results[0].status === "rejected") throw results[0].reason;
        audio = results[0].value;
        if (results[1].status === "fulfilled") cover = results[1].value;
        else logger.warn({ err: results[1].reason }, "Cover art generation failed — delivering audio without cover");
      } catch (err) {
        clearInterval(musicProgress);
        throw err;
      }

      const label = `${durationMode === "full" ? "Full Song" : "30s Clip"} — ${musicPrompt.slice(0, 60)}${musicPrompt.length > 60 ? "…" : ""}`;
      return {
        result: { audioUrl: audio.audioUrl, imageUrl: cover?.imageUrl ?? null, filename: audio.filename, duration: durationMode },
        artifact: {
          artifactType: "audio",
          label,
          audioUrl: audio.audioUrl,
          downloadUrl: audio.audioUrl,
          imageUrl: cover?.imageUrl,
          content: cover?.text || musicPrompt.slice(0, 120),
        },
      };
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Generating SEO pack..." });
      return textModelArtifact("YouTube SEO Pack", prompt);
    }

    case "read_uploaded_file": {
      const attachment = latestNonImageAttachment(req);
      if (!attachment) throw new Error("Attach an SRT, TXT, CSV, JSON, PDF, or document first.");
      const task = String(args.task ?? "Summarize and inspect this file.").trim();
      logTool("Reading uploaded file", { filename: attachment.name, mimeType: attachment.mimeType });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Reading ${attachment.name}...` });

      if ((attachment.mimeType.includes("pdf") || /\.pdf$/i.test(attachment.name)) && attachment.url && !attachment.url.startsWith("data:")) {
        const ai = createGeminiClient();
        const resp = await ai.models.generateContent({
          model: ULTRA_MODEL,
          contents: [{
            role: "user",
            parts: [
              { text: `${task}\nReturn practical, concise results for a creator/editor.` },
              { fileData: { fileUri: attachment.url, mimeType: "application/pdf" } } as any,
            ],
          }],
          config: { maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192) },
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
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Comparing subtitle files..." });
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
      const customPython = String(args.pythonCode ?? "").trim();
      logTool("Running code analysis", { task });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: e2bConfigured() ? "Running analysis in sandbox..." : "Running code analysis..." });
      if (e2bConfigured()) {
        const script = customPython || `from pathlib import Path
import json

data = Path('/home/user/input.txt').read_text(errors='replace')
task = Path('/home/user/task.txt').read_text(errors='replace').strip()
print('Task:', task)
print('\\nData preview:')
print(data[:2000])
print('\\nAnalysis:')
lines = [line for line in data.splitlines() if line.strip()]
print(f'Characters: {len(data)}')
print(f'Non-empty lines: {len(lines)}')
try:
    import pandas as pd
    from io import StringIO
    df = pd.read_csv(StringIO(data))
    print(f'CSV rows: {len(df)}, columns: {len(df.columns)}')
    print('Columns:', ', '.join(map(str, df.columns)))
    numeric = df.select_dtypes(include='number')
    if not numeric.empty:
        print('\\nNumeric summary:')
        print(numeric.describe().to_string())
    else:
        print('No numeric columns detected by pandas.')
except Exception as exc:
    try:
        obj = json.loads(data)
        print('JSON parsed successfully.')
        if isinstance(obj, list):
            print(f'JSON list length: {len(obj)}')
        elif isinstance(obj, dict):
            print(f'JSON keys: {list(obj.keys())[:40]}')
    except Exception:
        print('Could not auto-parse as CSV/JSON:', exc)
`;
        return await runE2BSandboxCommand(req, {
          command: "python3 /home/user/analysis.py",
          cwd: "/home/user",
          timeoutMs: Math.min(E2B_COMMAND_TIMEOUT_MS, 180000),
          writeFiles: [
            { path: "/home/user/input.txt", content: data.slice(0, E2B_MAX_FILE_CHARS) },
            { path: "/home/user/task.txt", content: task },
            { path: "/home/user/analysis.py", content: script },
          ],
          readFiles: ["/home/user/result.txt", "/home/user/output.txt", "/home/user/summary.txt"],
        }, res, runId, toolId, name);
      }
      const ai = createGeminiClient();
      const resp = await ai.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [{ text: `${task}\n\nUse code execution when useful. Return the result, formulas, tables, and any caveats.\n\nDATA:\n${data.slice(0, 120000)}` }],
        }],
        config: {
          tools: [{ codeExecution: {} }] as any,
          maxOutputTokens: Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192),
        },
      } as any);
      const content = stripReasoningTags((resp.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim());
      return { result: { content }, artifact: { artifactType: "text", label: "Code Analysis", content } };
    }

    case "run_sandbox_command": {
      return await runE2BSandboxCommand(req, args, res, runId, toolId, name);
    }

    case "sandbox_status": {
      const result = await chatSandboxStatus(req);
      const content = [
        `E2B configured: ${result.configured ? "yes" : "no"}`,
        result.sandboxId ? `Sandbox ID: ${result.sandboxId}` : "Sandbox ID: none yet",
        typeof result.running === "boolean" ? `Running: ${result.running ? "yes" : "no"}` : "",
        `Session key: ${result.sessionKey}`,
        `Timeout: ${Math.round(result.timeoutMs / 1000)}s`,
        "Environment: isolated E2B Linux sandbox, persistent for this chat while alive, separate from the app server filesystem.",
      ].filter(Boolean).join("\n");
      return { result, artifact: { artifactType: "text", label: "Sandbox Status", content } };
    }

    case "reset_sandbox": {
      const result = await resetChatSandbox(req);
      return {
        result,
        artifact: { artifactType: "text", label: "Sandbox Reset", content: "Sandbox reset. The next sandbox command will start a fresh isolated environment." },
      };
    }

    case "analyze_youtube_video": {
      const videoUrl = String(args.url ?? "").trim();
      const question = String(args.question ?? "Summarize this video comprehensively.").trim();

      // Validate it's a YouTube URL (watch, shorts, live, embed, youtu.be, mobile/music subdomains, nocookie)
      const isYouTubeUrl = /(?:^https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch(?:\?|\/)|shorts\/|live\/|embed\/|v\/)|youtu\.be\/|youtube-nocookie\.com\/(?:embed\/|v\/))/i.test(videoUrl);
      if (!isYouTubeUrl) throw new Error("URL must be a public YouTube video link.");
      logTool("Analyzing YouTube video with Gemini Vision+Audio", { videoUrl, question });
      sseEvent(res, { type: "tool_progress", runId, toolId, name, message: "Loading video... Gemini is watching and listening" });

      // Use Gemini's native YouTube video understanding via file_data.
      // The model receives the actual video frames + audio — it truly watches the video.
      const videoAi = createGeminiClient();
      const videoResp = await videoAi.models.generateContent({
        model: ULTRA_MODEL,
        contents: [{
          role: "user",
          parts: [
            { text: question },
            { fileData: { fileUri: videoUrl, mimeType: "video/mp4" } } as any,
          ],
        }],
        config: {
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


// ── GET /api/agent/skills — list available skills ────────────────────────
router.get("/agent/skills", (_req, res) => {
  res.json({ skills: getSkillsManifest() });
});

// ── POST /api/agent/chat ──────────────────────────────────────────────────
router.post("/agent/chat", async (req, res) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "AI Copilot not configured - add Vertex Gemini env or GEMINI_API_KEY." });
    return;
  }
  // Ensure Vertex AI credentials are loaded before any model call.
  // fetchCredentialsFromS3 runs async at cold start — awaiting here guarantees
  // credentials are ready even if the first request races with the cold-start fetch.
  try { await ensureVertexCredentials(); } catch { /* non-fatal — key may be env-based */ }
  (req as any).agentRunJobIds = new Set<string>();

  const { messages = [], model: requestedModel, skills: activeSkills = [] } = req.body as {
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
    skills?: string[];
  };

  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  // Guard: limit incoming history to prevent excessively large payloads
  const MAX_HISTORY_MESSAGES = 80;
  const truncatedMessages = messages.length > MAX_HISTORY_MESSAGES
    ? messages.slice(-MAX_HISTORY_MESSAGES)
    : messages;

  const normalizedMessages = truncatedMessages.map((message) => {
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

  // Resolve model:
  //   "flash" / "default" / undefined → AGENT_MODEL (gemini-3.5-flash), MEDIUM thinking
  //   "pro"                           → AGENT_MODEL (gemini-3.5-flash), HIGH thinking
  //   "advanced" / "ultra"            → ULTRA_MODEL (gemini-3.1-pro-preview), HIGH thinking
  let activeModel = AGENT_MODEL;
  if (requestedModel === "advanced" || requestedModel === "ultra") {
    activeModel = ULTRA_MODEL;
  } else if (requestedModel && requestedModel !== "default" && requestedModel !== "flash" && requestedModel !== "pro" && ALLOWED_MODELS.has(requestedModel)) {
    activeModel = requestedModel;
  }

  // ── Setup SSE — see lib/sse.ts for streaming-buffer fix details ─────────
  setupSse(res);

  // ⚠️ Use res.on("close") — req.on("close") fires when the request body
  // finishes being consumed (Node http behaviour), which for a normal POST
  // happens immediately after Express reads the body. That would falsely
  // mark the client as disconnected before any streaming starts.
  let clientConnected = true;
  let runCompleted = false;
  res.on("close", () => { clientConnected = false; });
  const isConnected = () => clientConnected && !res.writableEnded;

  const runId = randomUUID();
  sseEvent(res, { type: "run_start", runId, ts: Date.now(), model: activeModel, ultra: requestedModel === "ultra" });
  const skillPromptAddendum = buildSkillPrompt(activeSkills);
  console.log(`[agent] run ${runId} model=${activeModel} requested=${requestedModel ?? "default"} msgs=${normalizedMessages.length} skills=[${activeSkills.join(",")}] skillPromptLen=${skillPromptAddendum.length}`);

  // Heartbeat every 8s — below ALB (60s), nginx (75s), Cloudflare (100s) idle timeouts
  const keepAlive = setInterval(() => {
    if (clientConnected) sseEvent(res, { type: "heartbeat", runId, ts: Date.now() });
  }, 8000);

  try {
    const ai = createGeminiClient();

    // Build Gemini contents with multimodal awareness.
    // Images: inlineData bytes (Gemini Vision sees actual pixels, same as Claude/ChatGPT).
    // Video/audio/docs: structured [ATTACHED ...] context injected into text so tools use URL.
    let loopContents: any[] = normalizedMessages
      .filter(m => m.content.trim() || (m.attachments && m.attachments.length > 0))
      .map(m => {
        const parts: any[] = [];
        const textContent = m.content.trim();
        const attachments = (m as any).attachments ?? [];
        const mediaAttachments = attachments.filter((a: any) => a.type !== 'image');
        const imageAttachments = attachments.filter((a: any) => a.type === 'image');

        if (mediaAttachments.length > 0) {
          const ctxLines = mediaAttachments.map((a: any) => {
            const typeLabel = a.type === 'video' ? 'VIDEO' : a.type === 'audio' ? 'AUDIO' : 'FILE';
            return `[ATTACHED ${typeLabel}: "${a.name}" | URL: ${a.url} | MIME: ${a.mimeType}]\nThe user uploaded this file. Use its URL directly with tools (generate_subtitles, translate_video, etc.) - do NOT ask for a YouTube link.`;
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
    let useNativeSearchTools = ENABLE_NATIVE_AGENT_SEARCH;

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
              systemInstruction: SYSTEM_PROMPT + skillPromptAddendum,
              tools: buildAgentTools(useNativeSearchTools),
              toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
              maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
              thinkingConfig: {
                thinkingLevel: (requestedModel === "pro" || requestedModel === "advanced" || requestedModel === "ultra" ? "HIGH" : "MEDIUM") as any,
                includeThoughts: true,
              },
            },
          });
          streamErr = null;
          break; // success
        } catch (e: any) {
          streamErr = e;
          if (useNativeSearchTools && isNativeToolConfigError(e)) {
            console.warn(`[agent] native Google Search tool config failed; retrying function-only tools: ${e?.message ?? e}`);
            useNativeSearchTools = false;
            attempt--;
            continue;
          }
          const isEmptyOutputErr = /model output must contain|both be empty/i.test(e?.message ?? "");
          if (!isEmptyOutputErr || attempt === 2) break; // non-retryable or max attempts
        }
      }
      if (streamErr) throw streamErr;

      let fullText = "";
      const functionCalls: Array<{ id?: string; name: string; args: Record<string, any> }> = [];
      // ⚠️ rawFcParts preserves thought_signature — Gemini API REQUIRES this
      // to be passed back in history when thinking is active. Dropping it
      // causes INVALID_ARGUMENT: "Function call is missing a thought_signature".
      const rawFcParts: any[] = [];

      let streamedTextLive = false;
      let pendingTextBuf = "";
      let canvasRouteBuf = "";
      let activeCanvas: { id: string; label: string; language: string } | null = null;
      const parseCanvasAttrs = (raw: string): { label: string; language: string } => {
        const attrs: Record<string, string> = {};
        raw.replace(/([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g, (_m, key, value) => {
          attrs[String(key).toLowerCase()] = String(value);
          return "";
        });
        const language = (attrs.language || attrs.lang || "text").replace(/[^a-zA-Z0-9+#.-]/g, "").toLowerCase() || "text";
        const defaultExt = language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "markdown" ? "md" : language;
        const label = (attrs.title || attrs.filename || `agent-canvas.${defaultExt || "txt"}`).slice(0, 120);
        return { label, language };
      };
      const emitCanvasRoutedText = (text: string, final = false) => {
        canvasRouteBuf += text;
        // Strip markdown code fences that wrap a canvas tag (model sometimes does this)
        canvasRouteBuf = canvasRouteBuf.replace(/```[a-zA-Z]*\s*\n(\s*<canvas\b)/gi, "$1");
        canvasRouteBuf = canvasRouteBuf.replace(/<\/canvas>\s*\n```/gi, "</canvas>");
        // Convert standalone ```lang blocks → canvas protocol so the model's
        // markdown fallback is silently promoted into a canvas artifact instead
        // of appearing as raw code text in the chat.
        const FENCE_LANG_MAP: Record<string, string> = {
          js: "javascript", ts: "typescript", py: "python", md: "markdown",
        };
        canvasRouteBuf = canvasRouteBuf.replace(
          /```(html|css|javascript|js|typescript|ts|python|py|json|markdown|md|text|srt|vtt)\r?\n/gi,
          (_m, lang) => {
            const norm = FENCE_LANG_MAP[lang.toLowerCase()] ?? lang.toLowerCase();
            const ext = norm === "javascript" ? "js" : norm === "typescript" ? "ts" : norm === "python" ? "py" : norm === "markdown" ? "md" : norm;
            return `<canvas language="${norm}" title="code.${ext}">\n`;
          },
        );
        // Convert bare closing fence that follows converted canvas content
        canvasRouteBuf = canvasRouteBuf.replace(/\n```[ \t]*(\r?\n|$)/g, "\n</canvas>\n");
        const openRe = /<canvas\b([^>]*)>/i;
        const closeTag = "</canvas>";
        while (canvasRouteBuf) {
          if (activeCanvas) {
            const lower = canvasRouteBuf.toLowerCase();
            const closeIdx = lower.indexOf(closeTag);
            if (closeIdx === -1) {
              const keep = final ? 0 : closeTag.length - 1;
              const emit = canvasRouteBuf.slice(0, Math.max(0, canvasRouteBuf.length - keep));
              if (emit) {
                sseEvent(res, { type: "canvas_delta", runId, canvasId: activeCanvas.id, content: emit });
                streamedTextLive = true;
              }
              canvasRouteBuf = keep ? canvasRouteBuf.slice(-keep) : "";
              if (final) {
                sseEvent(res, { type: "canvas_done", runId, canvasId: activeCanvas.id });
                streamedTextLive = true;
                activeCanvas = null;
              }
              return;
            }
            const body = canvasRouteBuf.slice(0, closeIdx);
            if (body) {
              sseEvent(res, { type: "canvas_delta", runId, canvasId: activeCanvas.id, content: body });
              streamedTextLive = true;
            }
            sseEvent(res, { type: "canvas_done", runId, canvasId: activeCanvas.id });
            streamedTextLive = true;
            activeCanvas = null;
            canvasRouteBuf = canvasRouteBuf.slice(closeIdx + closeTag.length);
            continue;
          }

          const open = openRe.exec(canvasRouteBuf);
          if (!open) {
            const lower = canvasRouteBuf.toLowerCase();
            const partialIdx = lower.lastIndexOf("<canvas");
            if (!final && partialIdx !== -1 && !canvasRouteBuf.slice(partialIdx).includes(">")) {
              const chat = canvasRouteBuf.slice(0, partialIdx);
              if (chat) {
                sseEvent(res, { type: "text_delta", content: chat, runId });
                streamedTextLive = true;
              }
              canvasRouteBuf = canvasRouteBuf.slice(partialIdx);
              return;
            }
            sseEvent(res, { type: "text_delta", content: canvasRouteBuf, runId });
            streamedTextLive = true;
            canvasRouteBuf = "";
            return;
          }

          const before = canvasRouteBuf.slice(0, open.index);
          if (before) {
            sseEvent(res, { type: "text_delta", content: before, runId });
            streamedTextLive = true;
          }
          const attrs = parseCanvasAttrs(open[1] || "");
          activeCanvas = { id: randomUUID().slice(0, 12), label: attrs.label, language: attrs.language };
          sseEvent(res, {
            type: "canvas_start",
            runId,
            canvasId: activeCanvas.id,
            label: activeCanvas.label,
            language: activeCanvas.language,
          });
          streamedTextLive = true;
          canvasRouteBuf = canvasRouteBuf.slice((open.index || 0) + open[0].length);
        }
      };
      let lastGroundingMeta: any = null;
      for await (const chunk of stream!) {
        if (!isConnected()) break;

        // ── Extract thought summaries from Gemini's thinking mode ────────
        // When includeThoughts is true, parts with thought===true contain
        // the model's reasoning summary. Stream these to the client so
        // users can see what the agent is thinking in real time.
        const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const tp of chunkParts) {
          if (tp.thought && tp.text) {
            sseEvent(res, { type: "thought_delta", runId, content: tp.text });
          }
        }

        // ── Track grounding metadata from native Google Search grounding ─
        const gm = chunk.candidates?.[0]?.groundingMetadata as any;
        if (gm) lastGroundingMeta = gm;

        const chunkText = chunk.text;
        if (chunkText) {
          fullText += chunkText;
          pendingTextBuf += chunkText;
          // Hold back text that might be a partial internal marker.
          // Check for any marker pattern that should not reach the client:
          // [SUGGEST..., [Tool:..., [TextArtifact:..., [Artifact:...
          const markerPatterns = ["[SUGGEST", "[Tool:", "[TextArtifact:", "[Artifact:"];
          let holdIdx = -1;
          for (const pat of markerPatterns) {
            // Check for full pattern start or partial match at the end of buffer
            const idx = pendingTextBuf.lastIndexOf(pat);
            if (idx !== -1 && (holdIdx === -1 || idx < holdIdx)) {
              holdIdx = idx;
            }
            // Also check for partial pattern at the very end (e.g. "[Too" or "[Tex")
            for (let pLen = 1; pLen < pat.length; pLen++) {
              if (pendingTextBuf.endsWith(pat.slice(0, pLen))) {
                const partialIdx = pendingTextBuf.length - pLen;
                if (holdIdx === -1 || partialIdx < holdIdx) {
                  holdIdx = partialIdx;
                }
              }
            }
          }
          // Also hold back partial <canvas tags at the end of buffer
          const canvasTag = "<canvas";
          for (let pLen = 1; pLen <= canvasTag.length; pLen++) {
            if (pendingTextBuf.toLowerCase().endsWith(canvasTag.slice(0, pLen))) {
              const partialIdx = pendingTextBuf.length - pLen;
              if (holdIdx === -1 || partialIdx < holdIdx) {
                holdIdx = partialIdx;
              }
              break;
            }
          }
          if (holdIdx === -1) {
            emitCanvasRoutedText(pendingTextBuf);
            pendingTextBuf = "";
          } else {
            const safe = pendingTextBuf.slice(0, holdIdx);
            if (safe) {
              emitCanvasRoutedText(safe);
            }
            pendingTextBuf = pendingTextBuf.slice(holdIdx);
          }
        }

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (p.functionCall) {
            functionCalls.push({ id: p.functionCall.id, name: p.functionCall.name!, args: (p.functionCall.args ?? {}) as Record<string, any> });
            rawFcParts.push(p);
          }
        }
      }
      // Flush remaining buffered text (strip internal markers if present)
      if (pendingTextBuf) {
        const cleaned = pendingTextBuf
          .replace(/\[SUGGEST(?:IONS|OESTIONS):[^\]]*\]\s*$/gi, "")
          .replace(/\[Tool:\s*\w+\s*\|[^\]]*\]/gi, "")
          .replace(/\[TextArtifact:[^\]]*\][^\[]*/gi, "")
          .replace(/\[Artifact:[^\]]*\]/gi, "")
          .replace(/https?:\/\/[^\s"]*\.s3[^\s"]*(?:X-Amz-[^\s"]*)+/gi, "")
          .replace(/\{"\w+(?:Url|url)":\s*"https?:\/\/[^"]*"[^}]*\}/g, "")
          .trimEnd();
        if (cleaned) {
          emitCanvasRoutedText(cleaned, true);
        }
      }
      if (canvasRouteBuf || activeCanvas) emitCanvasRoutedText("", true);

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

      emptyResponseRetries = 0;

      // ── 2b. No function calls → final answer, parse suggestions, done ─────
      if (functionCalls.length === 0) {
        // Extract [SUGGESTIONS: "a" | "b" | "c"] from the final text
        const sugMatch = fullText.match(/\[SUGGESTIONS:\s*(.+?)\]\s*$/s);
        if (sugMatch) {
          const items = sugMatch[1].split("|").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
          if (items.length > 0) sseEvent(res, { type: "suggestions", items, runId } as any);
        }
        // Only send full text event if we didn't already stream it via text_delta
        if (!streamedTextLive) {
          sseEvent(res, { type: "text", content: fullText, runId });
        }
        // Emit grounding sources if native Google Search grounding was used.
        // Sends source URLs (for [1][2] citations) + the required Google Search
        // suggestions widget HTML.
        if (lastGroundingMeta) {
          const chunks = (lastGroundingMeta.groundingChunks ?? []).map((c: any) => ({
            title: c.web?.title ?? "",
            uri: c.web?.uri ?? "",
          })).filter((c: any) => c.uri);
          const searchEntryPoint = lastGroundingMeta.searchEntryPoint?.renderedContent ?? null;
          if (chunks.length > 0 || searchEntryPoint) {
            sseEvent(res, { type: "grounding_sources", runId, chunks, searchEntryPoint } as any);
          }
        }
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
      // Only emit pre-tool text if it wasn't already streamed live
      if (!streamedTextLive) {
        const preToolText = stripReasoningTags(fullText);
        if (preToolText) {
          sseEvent(res, {
            type: "text_delta",
            runId,
            content: preToolText + "\n\n"
          });
        }
      }

      const runToolCall = async (
        fcIndex: number,
        fc: { id?: string; name: string; args: Record<string, any> },
      ): Promise<{ index: number; response: any; hadError: boolean }> => {
        const toolId = randomUUID().slice(0, 8);

        sseEvent(res, { type: "tool_start", runId, toolId, name: fc.name, args: fc.args, ts: Date.now() });
        sseEvent(res, { type: "tool_log", runId, toolId, name: fc.name, message: "Tool execution started", level: "info" });

        let toolResult: any;
        let toolArtifact: object | undefined;
        let hadError = false;

        try {
          const { result, artifact } = await executeTool(fc.name, fc.args, req, res, isConnected, toolId, runId);
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
          response: { functionResponse: { id: fc.id, name: fc.name, response: { result: toolResult } } },
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

      // ── 5. JUDGE — verify results, feed correction context to model (hidden) ──
      // Do NOT emit visible text — the tool card already shows error state.
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
      runCompleted = true;
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
    if (!runCompleted) {
      void cancelAgentRunJobs(req, clientConnected ? "agent_error" : "client_abort");
    }
    if (!res.writableEnded) res.end();
  }
});

// ── Music Share ───────────────────────────────────────────────────────────────
// POST /api/agent/music-share  — saves share metadata to S3, returns shareId
// GET  /api/agent/music-share/:shareId  — public HTML share page (no auth)

const MUSIC_SHARE_SITE_URL = (
  process.env.PUBLIC_SITE_URL || "https://videomaking.in"
).replace(/\/+$/, "");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

router.post("/agent/music-share", async (req: Request, res: Response) => {
  try {
    const { audioUrl, imageUrl, title } = req.body as { audioUrl?: string; imageUrl?: string; title?: string };
    if (typeof audioUrl !== "string" || !audioUrl) return void res.status(400).json({ error: "audioUrl is required" });
    // Only allow HTTPS URLs — blocks javascript: / data: XSS vectors in the share HTML
    if (!audioUrl.startsWith("https://")) return void res.status(400).json({ error: "audioUrl must be an HTTPS URL" });
    if (imageUrl != null && typeof imageUrl !== "string") return void res.status(400).json({ error: "imageUrl must be an HTTPS URL" });
    if (imageUrl && !imageUrl.startsWith("https://")) return void res.status(400).json({ error: "imageUrl must be an HTTPS URL" });
    const shareId = randomUUID().replace(/-/g, "").slice(0, 16);
    const payload = JSON.stringify({ audioUrl, imageUrl: imageUrl ?? null, title: title ?? "Generated Music", createdAt: Date.now() });
    const upload = await uploadTextToS3({ body: payload, jobId: shareId, namespace: "music-shares", filename: "share.json", contentType: "application/json" });
    const token = Buffer.from(upload.key).toString("base64url");
    const shareUrl = `${MUSIC_SHARE_SITE_URL}/api/agent/music-share/${token}`;
    res.json({ shareId: token, shareUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/agent/music-share/:shareId", async (req: Request, res: Response) => {
  try {
    const token = String(req.params.shareId).replace(/[^a-zA-Z0-9_\-]/g, "");
    if (!token) return void res.status(400).json({ error: "Invalid share ID" });
    // Decode the base64url token back to the S3 key
    let key: string;
    try { key = Buffer.from(token, "base64url").toString("utf8"); } catch { return void res.status(400).json({ error: "Invalid share ID" }); }
    if (!key.includes("/music-shares/")) return void res.status(400).json({ error: "Invalid share ID" });
    let payload: { audioUrl: string; imageUrl?: string | null; title: string; createdAt: number };
    try {
      payload = JSON.parse(await readTextFromS3(key));
    } catch {
      return void res.status(404).send("Music track not found or has expired.");
    }
    const { audioUrl, imageUrl, title } = payload;
    const safeTitle = escapeHtml(title ?? "Generated Music");
    // Filesystem-safe filename for download: alphanum + hyphen/underscore only
    const safeFilename = (title ?? "Generated Music").replace(/[^a-zA-Z0-9\s\-_]/g, "").replace(/\s+/g, "_").slice(0, 80) + ".mp3";
    const appUrl = MUSIC_SHARE_SITE_URL;
    const sharePageUrl = escapeHtml(`${appUrl}/api/agent/music-share/${token}`);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} — VideoMaking Studio</title>
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="🎵 AI-generated music. Listen and create your own at VideoMaking Studio.">
  <meta property="og:url" content="${sharePageUrl}">
  <meta property="og:site_name" content="VideoMaking Studio">
  <meta property="og:type" content="music.song">
  ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="1024">` : ""}
  <meta name="twitter:card" content="${imageUrl ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="🎵 AI-generated music. Listen and create your own at VideoMaking Studio.">
  ${imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : ""}
  <style>
    body { margin: 0; background: #0a0a0a; color: white; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; overflow: hidden; }
    .bg-grid { position: absolute; inset: 0; background-size: 40px 40px; background-image: linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px); z-index: -1; }
    .bg-glow { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 600px; height: 600px; background: radial-gradient(circle, rgba(168,85,247,0.05) 0%, transparent 70%); z-index: -1; }
    .card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); border-radius: 1.25rem; overflow: hidden; max-width: 420px; width: 90%; backdrop-filter: blur(10px); }
    .cover { width: 100%; aspect-ratio: 1/1; object-fit: cover; display: block; background: #111; }
    .cover-ph { width: 100%; aspect-ratio: 1/1; background: linear-gradient(135deg,#1a1228,#0d0a18); display: flex; align-items: center; justify-content: center; font-size: 64px; }
    .body { padding: 1.5rem; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.35rem 0; line-height: 1.4; word-break: break-word; color: rgba(255,255,255,0.9); }
    p.meta { color: rgba(255,255,255,0.4); font-size: 0.82rem; margin: 0 0 1.1rem 0; }
    p.meta a { color: rgba(255,255,255,0.55); text-decoration: none; font-weight: 500; }
    p.meta a:hover { color: rgba(255,255,255,0.8); }
    audio { width: 100%; height: 40px; border-radius: 8px; accent-color: #a855f7; margin-bottom: 1rem; display: block; }
    .actions { display: flex; gap: 8px; }
    .btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.75rem 1rem; border-radius: 0.65rem; font-weight: 600; font-size: 0.875rem; text-decoration: none; transition: all 0.2s; }
    .btn-dl { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }
    .btn-dl:hover { background: rgba(255,255,255,0.1); }
    .btn-cta { background: white; color: #0a0a0a; box-shadow: 0 4px 12px rgba(255,255,255,0.1); flex: 1.3; }
    .btn-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(255,255,255,0.15); }
    .btn svg { width: 16px; height: 16px; }
    .footer { margin-top: 1rem; font-size: 0.75rem; color: rgba(255,255,255,0.25); text-align: center; }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="bg-glow"></div>
  <div class="card">
    ${imageUrl ? `<img class="cover" src="${escapeHtml(imageUrl)}" alt="Cover art" loading="lazy">` : `<div class="cover-ph">🎵</div>`}
    <div class="body">
      <h1>${safeTitle}</h1>
      <p class="meta">AI-generated music • Shared from <a href="${escapeHtml(appUrl)}">VideoMaking</a> Studio</p>
      <audio controls src="${escapeHtml(audioUrl)}" preload="metadata"></audio>
      <div class="actions">
        <a href="${escapeHtml(audioUrl)}" onclick="event.preventDefault();dlTrack(this.href,'${safeFilename}')" class="btn btn-dl">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </a>
        <a href="${escapeHtml(appUrl)}" class="btn btn-cta">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          Make Your Music
        </a>
      </div>
      <div class="footer">Powered by VideoMaking</div>
    </div>
  </div>
  <script>
    function dlTrack(url,fname){fetch(url).then(function(r){if(!r.ok)throw new Error('download failed');return r.blob();}).then(function(b){var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=fname;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},5000);}).catch(function(){window.open(url,'_blank');});}
  </script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
