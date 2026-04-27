/**
 * AI Studio Copilot Agent Route â€” Full Agentic Execution
 * POST /api/agent/chat
 *
 * SSE events: text | tool_start | tool_progress | tool_done | artifact | navigate | error | done
 */

import { Router } from "express";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";

const router = Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const AGENT_MODEL = process.env.COPILOT_MODEL ?? "gemini-3-flash-preview";
const _FAST_MODEL = process.env.COPILOT_FAST_MODEL; // reserved for future fast-path
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;
const MAX_ITERATIONS  = 12;  // Genspark-class: up to 12 agentic steps

// â”€â”€ Resolve base URL for internal API calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getApiBase(req: any): string {
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE + "/api";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host  = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
  return `${proto}://${host}/api`;
}

// â”€â”€ SSE helper â€” writes and flushes immediately â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function sseEvent(res: any, payload: object) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  // Node HTTP response buffers in some configurations; flush if available
  if (typeof (res as any).flush === "function") (res as any).flush();
}

// â”€â”€ Job poller â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function pollJobUntilDone(
  res: any,
  toolName: string,
  progressUrl: string,
  jobId: string,
  headers: Record<string, string>,
  isConnected: () => boolean,
  toolId?: string,
): Promise<{ status: string; filename?: string; filesize?: number }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline && isConnected()) {
    const r = await fetch(progressUrl, { headers });
    if (!r.ok) throw new Error(`Progress check failed: ${r.status}`);
    const data = await r.json() as any;
    const { status, percent, message, filename } = data;
    sseEvent(res, { type: "tool_progress", toolId, name: toolName, status, percent: percent ?? null, message: message ?? status, jobId });
    if (status === "done") return { status, filename };
    if (["error", "cancelled", "expired", "not_found"].includes(status))
      throw new Error(`Job ${status}: ${message ?? ""}`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!isConnected()) throw new Error("Client disconnected");
  throw new Error("Job timed out after 8 minutes");
}

// â”€â”€ Subtitle job poller â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const r = await fetch(statusUrl, { headers });
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

// â”€â”€ Timestamps job poller â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const r = await fetch(statusUrl, { headers });
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

// â”€â”€ Parse timestamps like "5:32" or "1:22:10" into seconds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// â”€â”€ Tool definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        url:       { type: Type.STRING, description: "YouTube video URL" },
        startTime: { type: Type.STRING, description: "Start time e.g. '5:32' or '01:22:10'" },
        endTime:   { type: Type.STRING, description: "End time e.g. '6:23' or '01:25:00'" },
        quality:   { type: Type.STRING, description: "Output quality: '1080p', '720p', '480p', '360p'. Default: 720p." },
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
        url:     { type: Type.STRING, description: "YouTube video URL" },
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
        url:         { type: Type.STRING, description: "YouTube video URL" },
        language:    { type: Type.STRING, description: "Source language code, e.g. 'hi' for Hindi. Default: auto-detect." },
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
        url:          { type: Type.STRING, description: "YouTube video URL" },
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
          description: "Tab name: 'download', 'clips', 'subtitles', 'clipcutter', 'bhagwat', 'scenefinder', 'timestamps', 'upload'",
        },
      },
      required: ["tab"],
    },
  },
];
const SYSTEM_PROMPT = `You are the VideoMaking Studio AI Copilot — an autonomous, action-first multi-phase agent.

## PHASE 1 — PLAN
When the user gives you a task, first decide which tools to call and in what order.
Announce each step concisely: "Cutting clip from 2:30 to 5:00..." then call the tool immediately.

## PHASE 2 — EXECUTE
Call tools immediately. You have REAL server-side tools that return actual download URLs.
NEVER say "I cannot access YouTube", "I need the transcript", or "I do not have tools".
You have tools — USE them without delay.

## PHASE 3 — VERIFY (JUDGE)
After each tool result, check if it succeeded. If an error occurred, analyze and retry with corrected arguments.
If you cannot fix it after 2 retries, explain exactly what failed and suggest an alternative.

## PHASE 4 — RESPOND
After all tools complete, synthesize a brief summary (1-3 sentences) and present download links.

## YOUR TOOLS
- cut_video_clip: Cut any time range from a YouTube video. Args: url, startTime (HH:MM:SS), endTime (HH:MM:SS)
- download_video: Download full video at any quality. Args: url, quality
- generate_subtitles: Generate SRT subtitles with optional translation. Args: url, language
- find_best_clips: AI highlight extraction from long videos. Args: url
- generate_timestamps: Generate chapter timestamps. Args: url
- get_video_info: Fetch video metadata. Args: url
- navigate_to_tab: Switch UI tab. Args: tab

## STRICT RULES — NEVER VIOLATE
1. URL + task = call the tool IMMEDIATELY. No questions, no explanations first.
2. Never refuse because you "cannot access the internet". Tools do the fetching server-side.
3. For clips: parse startTime/endTime from user message and call cut_video_clip immediately.
4. Be ultra-concise before calling tools. Say "On it!" then call.
5. Always present download links from tool results as prominent call-to-action.
6. Stay in Copilot chat unless user explicitly asks to switch tabs.`;

// â”€â”€ Build internal headers from request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Tool executor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      if (data.title)    infoLines.push(`📹 ${data.title}`);
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
      const endSecs   = parseTimestamp(String(args.endTime));
      const quality   = args.quality ?? "720p";
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/clip-cut" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: `Starting clip cut (${args.startTime} â†’ ${args.endTime})...` });
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
      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      const downloadUrl = `/api/youtube/file/${jobId}`;
      return {
        result: { jobId, downloadUrl, startTime: args.startTime, endTime: args.endTime },
        artifact: { artifactType: "download", label: `Clip ready: ${args.startTime} â†’ ${args.endTime}`, downloadUrl, jobId },
      };
    }

    case "download_video": {
      const quality = args.quality ?? "best";
      logTool("Calling internal API", { method: "POST", endpoint: "/api/youtube/download" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: `Starting download (${quality})...` });
      let formatId = "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best";
      if (quality === "audio_only") formatId = "audio:bestaudio";
      if (quality === "1080p") formatId = "bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080]";
      if (quality === "720p")  formatId = "bestvideo[height<=720][ext=mp4]+bestaudio/best[height<=720]";
      if (quality === "480p")  formatId = "bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]";
      if (quality === "360p")  formatId = "bestvideo[height<=360][ext=mp4]+bestaudio/best[height<=360]";
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
      const final = await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      const downloadUrl = `/api/youtube/file/${jobId}`;
      return {
        result: { jobId, downloadUrl, filename: final.filename },
        artifact: { artifactType: "download", label: `Video ready: ${final.filename ?? "video.mp4"}`, downloadUrl, jobId },
      };
    }

    case "generate_subtitles": {
      logTool("Calling internal API", { method: "POST", endpoint: "/api/subtitles/generate" });
      sseEvent(res, { type: "tool_progress", toolId, name, message: "Starting subtitle generation..." });
      const r = await fetch(`${apiBase}/subtitles/generate`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url, language: args.language ?? "auto", translateTo: args.translateTo ?? null, source: "url" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Subtitle job failed: ${r.status}`);
      }
      const { id: jobId } = await r.json() as any;
      logTool("Subtitles job accepted", { jobId });
      const final = await pollSubtitleUntilDone(res, `${apiBase}/subtitles/status/${jobId}`, jobId, internalHeaders, isConnected, toolId);
      const srtUrl = `/api/subtitles/status/${jobId}/download?format=srt`;
      return {
        result: { jobId, srtFilename: final.srtFilename },
        artifact: {
          artifactType: "download",
          label: `Subtitles ready${args.translateTo ? ` (${args.translateTo})` : ""}: ${final.srtFilename ?? "subtitles.srt"}`,
          downloadUrl: srtUrl,
          jobId,
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

  const { messages = [] } = req.body as {
    messages: Array<{ role: "user" | "model"; content: string }>;
  };

  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  // â”€â”€ Setup SSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  res.flushHeaders();

  let clientConnected = true;
  req.on("close", () => { clientConnected = false; });
  const isConnected = () => clientConnected;

  const runId = randomUUID();
  sseEvent(res, { type: "run_start", runId, ts: Date.now() });

  // Send heartbeat event every 12s to keep proxy / ALB from closing idle connections
  const keepAlive = setInterval(() => {
    if (clientConnected) sseEvent(res, { type: "heartbeat", runId, ts: Date.now() });
  }, 12000);

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    // Build Gemini contents â€” only text parts to avoid confusing the model
    let loopContents: any[] = messages
      .filter(m => m.content.trim())
      .map(m => ({ role: m.role, parts: [{ text: m.content }] }));

    let iterations = 0;

    while (iterations < MAX_ITERATIONS && isConnected()) {
      iterations++;
      const stage = iterations === 1 ? "planning" : "executing";
      sseEvent(res, { type: "thinking", runId, stage, iteration: iterations, total: MAX_ITERATIONS });

      // ── 1. Stream the AI response ─────────────────────────────────────────
      const stream = await ai.models.generateContentStream({
        model: AGENT_MODEL,
        contents: loopContents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: STUDIO_TOOLS as any }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
          temperature: 0.15,
          maxOutputTokens: 4096,
          // thinkingConfig: only supported on flash-thinking variants; omit for standard models
          ...(AGENT_MODEL.includes("thinking") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });

      let fullText = "";
      const functionCalls: Array<{ name: string; args: Record<string, any> }> = [];
      // ⚠️ rawFcParts preserves thought_signature — Gemini API REQUIRES this
      // to be passed back in history when thinking is active. Dropping it
      // causes INVALID_ARGUMENT: "Function call is missing a thought_signature".
      const rawFcParts: any[] = [];

      for await (const chunk of stream) {
        if (!isConnected()) break;
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (p.text) {
            fullText += p.text;
            sseEvent(res, { type: "text", content: p.text, runId });
          }
          if (p.functionCall) {
            functionCalls.push({ name: p.functionCall.name!, args: (p.functionCall.args ?? {}) as Record<string, any> });
            // Store the FULL functionCall object — includes thought_signature if present
            rawFcParts.push({ functionCall: p.functionCall });
          }
        }
      }

      if (!isConnected()) break;

      // ── 2. No function calls → final answer, done ─────────────────────────
      if (functionCalls.length === 0) break;

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

      for (const fc of functionCalls) {
        if (!isConnected()) break;
        const toolId = randomUUID().slice(0, 8);

        sseEvent(res, { type: "tool_start", runId, toolId, name: fc.name, args: fc.args, ts: Date.now() });
        sseEvent(res, { type: "tool_log",   runId, toolId, name: fc.name, message: "Tool execution started", level: "info" });

        let toolResult: any;
        let toolArtifact: object | undefined;

        try {
          const { result, artifact } = await executeTool(fc.name, fc.args, req, res, isConnected, toolId);
          toolResult   = result;
          toolArtifact = artifact;
          if (toolResult?.error) iterationHadError = true;
        } catch (toolErr: any) {
          iterationHadError = true;
          toolResult = { error: toolErr?.message ?? "Tool execution failed" };
          sseEvent(res, { type: "tool_progress", runId, toolId, name: fc.name, status: "error", message: toolErr?.message ?? "Failed" });
          sseEvent(res, { type: "tool_log",      runId, toolId, name: fc.name, message: toolErr?.message ?? "Tool failed", level: "error" });
        }

        sseEvent(res, { type: "tool_done", runId, toolId, name: fc.name, result: toolResult, ts: Date.now() });
        if (toolArtifact) sseEvent(res, { type: "artifact", runId, toolId, ...(toolArtifact as object) });

        toolResults.push({
          functionResponse: { name: fc.name, response: { result: toolResult } },
        });
      }

      // ── 5. JUDGE — verify results, emit stage, surface errors ────────────
      sseEvent(res, { type: "thinking", runId, stage: "verifying", iteration: iterations, total: MAX_ITERATIONS });
      if (iterationHadError) {
        const failedTools = toolResults
          .filter(tr => tr.functionResponse?.response?.result?.error)
          .map(tr => `${tr.functionResponse.name}: ${tr.functionResponse.response.result.error}`)
          .join("; ");
        // Surface judge warning as visible text so user sees it (tool_log with no toolId is dropped by UI)
        sseEvent(res, { type: "text", content: `\n🔍 **Judge:** Detected errors — ${failedTools}. Retrying…\n`, runId });
        toolResults.push({ text: `[JUDGE] Tools failed: ${failedTools}. Correct arguments and retry, or explain clearly why it cannot be done.` });
      }

      // ── 6. Build history for next iteration ───────────────────────────────
      // Use rawFcParts (not reconstructed) to preserve thought_signature
      const modelParts: any[] = [];
      if (fullText) modelParts.push({ text: fullText });
      for (const rawFc of rawFcParts) modelParts.push(rawFc);

      loopContents = [
        ...loopContents,
        { role: "model" as const, parts: modelParts },
        { role: "user"  as const, parts: toolResults },
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
      // Parse Gemini API JSON error messages to show clean human-readable text
      let errMsg: string = err?.message ?? "Unknown copilot error";
      try {
        const parsed = JSON.parse(errMsg);
        const inner = parsed?.error?.message ?? parsed?.message ?? errMsg;
        // Strip the long docs URL reference
        errMsg = String(inner).split(/\.?\s*Please refer to https?:\/\//).shift()!.trim();
      } catch { /* not JSON, use as-is */ }
      sseEvent(res, { type: "error", message: errMsg });
    }
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
});

export default router;
