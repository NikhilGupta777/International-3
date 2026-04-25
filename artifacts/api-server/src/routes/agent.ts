/**
 * AI Studio Copilot Agent Route — Full Agentic Execution
 * POST /api/agent/chat
 *
 * Each tool call WAITS for job completion and returns real download links.
 * SSE events: text | tool_start | tool_progress | tool_done | artifact | navigate | error | done
 */

import { Router } from "express";
import { GoogleGenAI, Type } from "@google/genai";

const router = Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const AGENT_MODEL = "gemini-2.0-flash";
// Max time to wait for a job to complete (8 min)
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

// ── Resolve base URL for internal API calls ───────────────────────────────────
function getApiBase(req: any): string {
  // Use env override first (for Lambda / container environments)
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE + "/api";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host  = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
  return `${proto}://${host}/api`;
}

// ── SSE helper ────────────────────────────────────────────────────────────────
function sseEvent(res: any, payload: object) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ── Job poller: wait for a download/clip job to finish ───────────────────────
async function pollJobUntilDone(
  res: any,
  toolName: string,
  progressUrl: string,
  jobId: string,
): Promise<{ status: string; filename?: string; filesize?: number; s3Key?: string }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const r = await fetch(progressUrl);
    if (!r.ok) throw new Error(`Progress check failed: ${r.status}`);
    const data = await r.json() as any;

    const { status, percent, message, filename, filesize } = data;

    // Stream progress back
    sseEvent(res, {
      type: "tool_progress",
      name: toolName,
      status,
      percent: percent ?? null,
      message: message ?? status,
      jobId,
    });

    if (status === "done") return { status, filename, filesize };
    if (["error", "cancelled", "expired", "not_found"].includes(status)) {
      throw new Error(`Job ${status}: ${message ?? ""}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Job timed out after 8 minutes");
}

// ── Subtitle job poller ───────────────────────────────────────────────────────
async function pollSubtitleUntilDone(
  res: any,
  statusUrl: string,
  jobId: string,
): Promise<{ status: string; srtFilename?: string; vttFilename?: string }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const r = await fetch(statusUrl);
    if (!r.ok) throw new Error(`Subtitle status check failed: ${r.status}`);
    const data = await r.json() as any;

    const { status, progressPct, message, srtFilename, vttFilename } = data;

    sseEvent(res, {
      type: "tool_progress",
      name: "generate_subtitles",
      status,
      percent: progressPct ?? null,
      message: message ?? status,
      jobId,
    });

    if (status === "done") return { status, srtFilename, vttFilename };
    if (["error", "cancelled"].includes(status)) {
      throw new Error(`Subtitle job ${status}: ${message ?? ""}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Subtitle job timed out after 8 minutes");
}

// ── Parse timestamps like "5:32" or "1:22:10" into seconds ───────────────────
function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const STUDIO_TOOLS = [
  {
    name: "get_video_info",
    description: "Fetch metadata about a YouTube video (title, duration, uploader, view count). Always call this first if you don't already have the title.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
      },
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
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "list_shared_files",
    description: "List files in the public share gallery.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.NUMBER, description: "Max files to return. Default: 12." },
      },
      required: [],
    },
  },
  {
    name: "navigate_to_tab",
    description: "Switch the studio UI to a specific tool tab. Use when user asks to open a specific tab.",
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

const SYSTEM_PROMPT = `You are VideoMaking Studio Copilot — a powerful AI agent embedded inside VideoMaking Studio.

You have access to studio tools that actually execute and wait for completion — not just start jobs.
When you call cut_video_clip, download_video, or generate_subtitles, the tool WAITS for the job to finish and gives you a real download URL.
Always tell the user what you're doing and present the download link when done.

**Rules:**
1. For cut/download/subtitle tasks: call the tool, it will complete end-to-end, then present the download link as a clickable URL.
2. Always parse timestamps correctly: "5:32 to 6:23" means startTime="5:32", endTime="6:23".
3. If user gives a YouTube URL with a task, extract the URL and immediately execute it.
4. After completing a task, summarize what was done, present the download link clearly, and offer related next steps.
5. Be concise, action-oriented, and use professional language.
6. For devotional/Bhagwat content, be respectful.
7. If a task will take a while (large video), let the user know it may take a few minutes.

**Download link format:** Always present download links as: "✅ Done! [Download your file](/api/youtube/file/JOBID)"`;

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(
  name: string,
  args: Record<string, any>,
  req: any,
  res: any,
): Promise<{ result: any; artifact?: object }> {
  const apiBase = getApiBase(req);
  const cookieHeader = req.headers.cookie ?? "";

  switch (name) {

    case "get_video_info": {
      sseEvent(res, { type: "tool_progress", name, message: "Fetching video metadata..." });
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ url: args.url }),
      });
      const data = await r.json().catch(() => ({ error: "Failed to fetch info" }));
      return { result: data };
    }

    case "cut_video_clip": {
      const startSecs = parseTimestamp(String(args.startTime));
      const endSecs   = parseTimestamp(String(args.endTime));
      const quality   = args.quality ?? "720p";

      sseEvent(res, { type: "tool_progress", name, message: `Starting clip cut (${args.startTime} → ${args.endTime})...` });

      const r = await fetch(`${apiBase}/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ url: args.url, startTime: startSecs, endTime: endSecs, quality }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Clip cut failed: ${r.status}`);
      }

      const { jobId } = await r.json() as any;

      // Poll until done
      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId);

      const downloadUrl = `/api/youtube/file/${jobId}`;
      return {
        result: { jobId, downloadUrl, startTime: args.startTime, endTime: args.endTime },
        artifact: {
          artifactType: "download",
          label: `Clip ready: ${args.startTime} → ${args.endTime}`,
          downloadUrl,
          jobId,
        },
      };
    }

    case "download_video": {
      const quality = args.quality ?? "best";

      sseEvent(res, { type: "tool_progress", name, message: `Starting download (${quality})...` });

      // Get info first to pick best format
      let formatId = quality === "audio_only" ? "audio:bestaudio" : "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best";
      if (quality === "1080p") formatId = "bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080]";
      if (quality === "720p")  formatId = "bestvideo[height<=720][ext=mp4]+bestaudio/best[height<=720]";
      if (quality === "480p")  formatId = "bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]";
      if (quality === "360p")  formatId = "bestvideo[height<=360][ext=mp4]+bestaudio/best[height<=360]";

      const r = await fetch(`${apiBase}/youtube/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ url: args.url, formatId }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Download failed: ${r.status}`);
      }

      const { jobId } = await r.json() as any;

      // Poll until done
      const final = await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId);
      const downloadUrl = `/api/youtube/file/${jobId}`;

      return {
        result: { jobId, downloadUrl, filename: final.filename },
        artifact: {
          artifactType: "download",
          label: `Video ready: ${final.filename ?? "video.mp4"}`,
          downloadUrl,
          jobId,
        },
      };
    }

    case "generate_subtitles": {
      sseEvent(res, { type: "tool_progress", name, message: "Starting subtitle generation..." });

      const r = await fetch(`${apiBase}/subtitles/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({
          url: args.url,
          language: args.language ?? "auto",
          translateTo: args.translateTo ?? null,
          source: "url",
        }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Subtitle job failed: ${r.status}`);
      }

      const { id: jobId } = await r.json() as any;

      // Poll until done
      const final = await pollSubtitleUntilDone(res, `${apiBase}/subtitles/status/${jobId}`, jobId);
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
      sseEvent(res, { type: "tool_progress", name, message: "Starting best clips analysis..." });

      const r = await fetch(`${apiBase}/youtube/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({
          url: args.url,
          durationMode: args.durationMode ?? "auto",
          instructions: args.instructions ?? "",
        }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Best clips job failed: ${r.status}`);
      }

      const { jobId } = await r.json() as any;

      return {
        result: { jobId, message: "Best clips analysis started. Check the Best Clips tab for results." },
        artifact: {
          artifactType: "tab_link",
          label: "Best Clips analysis started — open tab to see results",
          tab: "clips",
          jobId,
        },
      };
    }

    case "generate_timestamps": {
      sseEvent(res, { type: "tool_progress", name, message: "Generating timestamps..." });

      const r = await fetch(`${apiBase}/timestamps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ url: args.url }),
      });

      const data = await r.json().catch(() => ({ error: "Timestamp generation failed" })) as any;

      if (!r.ok) throw new Error(data.error ?? `Timestamps failed: ${r.status}`);

      return {
        result: data,
        artifact: data.timestamps ? {
          artifactType: "text",
          label: "Timestamps generated",
          content: typeof data.timestamps === "string" ? data.timestamps : JSON.stringify(data.timestamps, null, 2),
        } : undefined,
      };
    }

    case "list_shared_files": {
      const limit = args.limit ?? 12;
      const r = await fetch(`${apiBase}/uploads/public?limit=${limit}`, {
        headers: { Cookie: cookieHeader },
      });
      const data = await r.json().catch(() => ({ items: [] }));
      return { result: data };
    }

    case "navigate_to_tab": {
      // Handled in the loop — just return ok
      return { result: { navigated: true, tab: args.tab } };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

// ── POST /api/agent/chat ──────────────────────────────────────────────────────
router.post("/agent/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    res.status(503).json({ error: "AI Copilot not configured — add GEMINI_API_KEY to environment." });
    return;
  }

  const { messages = [] } = req.body as {
    messages: Array<{ role: "user" | "model"; content: string }>;
  };

  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  // Setup SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const geminiContents = messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    let continueLoop = true;
    let loopContents = [...geminiContents];
    let iterations = 0;
    const MAX_ITERATIONS = 6;

    while (continueLoop && iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await ai.models.generateContent({
        model: AGENT_MODEL,
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: STUDIO_TOOLS }],
        contents: loopContents,
      });

      const candidate = response.candidates?.[0];
      if (!candidate) {
        sseEvent(res, { type: "text", content: "I wasn't able to process that. Please try again." });
        break;
      }

      const parts = candidate.content?.parts ?? [];
      let hasToolCall = false;
      const toolResults: any[] = [];

      for (const part of parts) {
        if (part.text) {
          sseEvent(res, { type: "text", content: part.text });
        }

        if (part.functionCall) {
          hasToolCall = true;
          const { name, args } = part.functionCall;
          const toolArgs = (args ?? {}) as Record<string, any>;

          sseEvent(res, { type: "tool_start", name, args: toolArgs });

          // Navigate directive (frontend handles immediately)
          if (name === "navigate_to_tab") {
            sseEvent(res, { type: "navigate", tab: toolArgs.tab });
          }

          let toolResult: any;
          let toolArtifact: object | undefined;

          try {
            const { result, artifact } = await executeTool(name!, toolArgs, req, res);
            toolResult = result;
            toolArtifact = artifact;
          } catch (toolErr: any) {
            toolResult = { error: toolErr?.message ?? "Tool execution failed" };
            sseEvent(res, { type: "tool_progress", name, status: "error", message: toolErr?.message ?? "Failed" });
          }

          sseEvent(res, { type: "tool_done", name, result: toolResult });

          if (toolArtifact) {
            sseEvent(res, { type: "artifact", ...toolArtifact });
          }

          toolResults.push({
            functionResponse: {
              name,
              response: { result: toolResult },
            },
          });
        }
      }

      if (hasToolCall) {
        loopContents = [
          ...loopContents,
          { role: "model" as const, parts },
          { role: "user" as const, parts: toolResults },
        ];
      } else {
        continueLoop = false;
      }
    }

    sseEvent(res, { type: "done" });
    res.end();
  } catch (err: any) {
    sseEvent(res, { type: "error", message: err?.message ?? "Unknown copilot error" });
    res.end();
  }
});

export default router;
