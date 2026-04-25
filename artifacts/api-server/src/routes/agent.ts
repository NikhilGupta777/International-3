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
// Use most capable model for the agentic loop (function calling + reasoning)
const AGENT_MODEL = process.env.COPILOT_MODEL ?? "gemini-3.1-pro-preview";
// Fast model for single-turn / lightweight tasks
const _FAST_MODEL = process.env.COPILOT_FAST_MODEL ?? "gemini-3-flash-preview";
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
  headers: Record<string, string>,
): Promise<{ status: string; filename?: string; filesize?: number; s3Key?: string }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const r = await fetch(progressUrl, { headers });
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
  headers: Record<string, string>,
): Promise<{ status: string; srtFilename?: string; vttFilename?: string }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const r = await fetch(statusUrl, { headers });
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

// ── Timestamps job poller ─────────────────────────────────────────────────────
async function pollTimestampsUntilDone(
  res: any,
  statusUrl: string,
  jobId: string,
  headers: Record<string, string>,
): Promise<{ status: string; timestamps?: any }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const r = await fetch(statusUrl, { headers });
    if (!r.ok) throw new Error(`Timestamp status check failed: ${r.status}`);
    const data = await r.json() as any;

    const { status, progressPct, message, timestamps } = data;

    sseEvent(res, {
      type: "tool_progress",
      name: "generate_timestamps",
      status,
      percent: progressPct ?? null,
      message: message ?? status,
      jobId,
    });

    if (status === "done") return { status, timestamps };
    if (["error", "cancelled"].includes(status)) {
      throw new Error(`Timestamps job ${status}: ${message ?? ""}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Timestamp job timed out after 8 minutes");
}

// ── Parse timestamps like "5:32" or "1:22:10" into seconds ───────────────────
function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const STUDIO_TOOLS: any[] = [
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

const SYSTEM_PROMPT = `You are the VideoMaking Studio AI Copilot — an autonomous, action-first agent with DIRECT access to powerful studio tools.

YOU HAVE REAL TOOLS. When the user gives you a YouTube URL and a task, you MUST immediately call the appropriate tool. You do NOT need to ask for more information or explain limitations.

YOUR CAPABILITIES (via tools that actually execute server-side):
- cut_video_clip: Cut any time range from a YouTube video. Returns a real download link.
- download_video: Download a full YouTube video at any quality. Returns a real download link.
- generate_subtitles: Generate SRT subtitles from any YouTube video, with optional translation.
- find_best_clips: AI-powered best clip extraction from long videos.
- generate_timestamps: Generate YouTube chapter timestamps for any video.
- get_video_info: Fetch video metadata (title, duration, etc).
- navigate_to_tab: Switch the studio UI to a specific tool.

STRICT RULES — NEVER VIOLATE:
1. ALWAYS call a tool immediately when the user gives a URL + task. Never say you "can't" access YouTube or use tools.
2. NEVER say "I don't have access to tools", "I cannot click links", or "I need the transcript". You have tools — USE THEM.
3. For clip cutting: extract startTime and endTime from the user's message (e.g. "5:32 to 6:23" → startTime="5:32", endTime="6:23") and call cut_video_clip immediately.
4. For subtitle requests: call generate_subtitles immediately. Do NOT ask for a transcript.
5. Tools wait for completion and return real download URLs. Present the download button to the user.
6. Be ultra-concise before calling tools. Say "On it!" or "Cutting clip now..." then call the tool.
7. After a tool completes, summarize what was done in 1-2 sentences and offer follow-up actions.
8. For Bhagwat/devotional content, be respectful.
9. If a tool fails, explain the error clearly and suggest alternatives.

WHEN YOU SEE: [YouTube URL] + [task] → IMMEDIATELY call the right tool. No questions, no explanations, just execute.

Download link format after tool completion: Present the link from the artifact card — the user gets a green download button automatically.`;

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(
  name: string,
  args: Record<string, any>,
  req: any,
  res: any,
): Promise<{ result: any; artifact?: object }> {
  const apiBase = getApiBase(req);
  const INTERNAL_SECRET = process.env.INTERNAL_AGENT_SECRET ?? "internal-agent-bypass-key";

  const internalHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: req.headers.cookie ?? "",
    "x-internal-agent": INTERNAL_SECRET,
  };

  // Forward client identity so jobs created by the agent appear in the user's Activity panel
  if (req.headers["x-forwarded-for"]) internalHeaders["x-forwarded-for"] = String(req.headers["x-forwarded-for"]);
  else if (req.ip) internalHeaders["x-forwarded-for"] = req.ip;

  if (req.headers["x-notify-client"]) internalHeaders["x-notify-client"] = String(req.headers["x-notify-client"]);
  if (req.headers["x-client-id"]) internalHeaders["x-client-id"] = String(req.headers["x-client-id"]);
  if (req.headers["x-device-id"]) internalHeaders["x-device-id"] = String(req.headers["x-device-id"]);

  switch (name) {

    case "get_video_info": {
      sseEvent(res, { type: "tool_progress", name, message: "Fetching video metadata..." });
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST",
        headers: internalHeaders,
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
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url, startTime: startSecs, endTime: endSecs, quality }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Clip cut failed: ${r.status}`);
      }

      const { jobId } = await r.json() as any;

      // Poll until done
      await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders);

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
        headers: internalHeaders,
        body: JSON.stringify({ url: args.url, formatId }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as any;
        throw new Error(err.error ?? `Download failed: ${r.status}`);
      }

      const { jobId } = await r.json() as any;

      // Poll until done
      const final = await pollJobUntilDone(res, name, `${apiBase}/youtube/progress/${jobId}`, jobId, internalHeaders);
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
        headers: internalHeaders,
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
      const final = await pollSubtitleUntilDone(res, `${apiBase}/subtitles/status/${jobId}`, jobId, internalHeaders);
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
        headers: internalHeaders,
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

      // Poll until done
      const final = await pollTimestampsUntilDone(res, `${apiBase}/youtube/timestamps/status/${jobId}`, jobId, internalHeaders);

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
      const r = await fetch(`${apiBase}/uploads/public?limit=${limit}`, {
        headers: { ...internalHeaders },
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

  let isClientConnected = true;
  req.on("close", () => {
    isClientConnected = false;
  });

  // Keep connection alive against ALB/proxy idle timeouts (send SSE comment every 15s)
  const keepAlive = setInterval(() => {
    if (isClientConnected) res.write(":\n\n");
  }, 15000);

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const geminiContents = messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    let continueLoop = true;
    let loopContents: any[] = [...geminiContents];
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (continueLoop && iterations < MAX_ITERATIONS && isClientConnected) {
      iterations++;

      const stream = await ai.models.generateContentStream({
        model: AGENT_MODEL,
        contents: loopContents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: STUDIO_TOOLS as any }],
          toolConfig: {
            functionCallingConfig: {
              mode: "AUTO" as any,
            },
          },
          temperature: 0.15,
          maxOutputTokens: 2048,
        }
      });

      const allParts: any[] = [];
      let hasToolCall = false;

      for await (const chunk of stream) {
        if (!isClientConnected) break;
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (p.text) {
            sseEvent(res, { type: "text", content: p.text });
          }
          if (p.functionCall) {
            hasToolCall = true;
            const { name, args } = p.functionCall;
            const toolArgs = (args ?? {}) as Record<string, any>;
            
            sseEvent(res, { type: "tool_start", name, args: toolArgs });
            if (name === "navigate_to_tab") {
              sseEvent(res, { type: "navigate", tab: toolArgs.tab });
            }
          }
          allParts.push(p);
        }
      }

      // Reconstruct final parts array, grouping text to avoid API errors
      const finalParts: any[] = [];
      let currentText = "";
      for (const p of allParts) {
        if (p.text) currentText += p.text;
        else if (p.functionCall) {
          if (currentText) {
            finalParts.push({ text: currentText });
            currentText = "";
          }
          finalParts.push(p);
        }
      }
      if (currentText) {
        finalParts.push({ text: currentText });
      }

      const toolResults: any[] = [];

      for (const part of finalParts) {
        if (!isClientConnected) break;
        if (part.functionCall) {
          const { name, args } = part.functionCall;
          const toolArgs = (args ?? {}) as Record<string, any>;

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
          { role: "model" as const, parts: finalParts },
          { role: "user" as const, parts: toolResults },
        ];
      } else {
        continueLoop = false;
      }
    }

    if (isClientConnected) {
      sseEvent(res, { type: "done" });
    }
  } catch (err: any) {
    if (isClientConnected) {
      sseEvent(res, { type: "error", message: err?.message ?? "Unknown copilot error" });
    }
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
});

export default router;
