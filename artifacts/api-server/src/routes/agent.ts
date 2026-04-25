/**
 * AI Studio Copilot Agent Route
 * POST /api/agent/chat
 *
 * Accepts a conversation and streams SSE back with:
 *  - text tokens (real-time)
 *  - tool_start / tool_done cards (transparent tool use)
 *  - navigate directives (switch frontend tab)
 *  - artifact cards (download links, previews)
 *  - done sentinel
 */

import { Router } from "express";
import { GoogleGenAI, Type } from "@google/genai";

const router = Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const AGENT_MODEL = "gemini-2.0-flash";

// ── SSE helpers ──────────────────────────────────────────────────────────────
function sseEvent(res: any, payload: object) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ── Tool definitions for Gemini function calling ─────────────────────────────
const STUDIO_TOOLS = [
  {
    name: "get_video_info",
    description: "Fetch metadata about a YouTube video: title, duration, uploader, view count. Use this first before cutting or downloading.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "download_video",
    description: "Start a full video or audio download from a YouTube URL. Returns a jobId to track progress.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "YouTube video URL" },
        quality: { type: Type.STRING, description: "Quality like '1080p', '720p', '360p', 'audio_only'. Defaults to best." },
      },
      required: ["url"],
    },
  },
  {
    name: "cut_video_clip",
    description: "Cut an exact time range from a YouTube video and return a downloadable clip. startTime and endTime in HH:MM:SS or MM:SS format.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url:       { type: Type.STRING, description: "YouTube video URL" },
        startTime: { type: Type.STRING, description: "Clip start time, e.g. '5:32' or '01:22:10'" },
        endTime:   { type: Type.STRING, description: "Clip end time, e.g. '6:23' or '01:25:00'" },
        quality:   { type: Type.STRING, description: "Output quality, e.g. '720p' or '360p'. Default: 720p." },
      },
      required: ["url", "startTime", "endTime"],
    },
  },
  {
    name: "find_best_clips",
    description: "Use AI to find the most valuable/engaging segments from a long YouTube video.",
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
    name: "generate_subtitles",
    description: "Generate SRT subtitle file from a YouTube video. Can optionally translate to another language.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url:        { type: Type.STRING, description: "YouTube video URL" },
        language:   { type: Type.STRING, description: "Source language code, e.g. 'hi' for Hindi. Default: auto-detect." },
        translateTo: { type: Type.STRING, description: "Target translation language, e.g. 'en' for English. Optional." },
      },
      required: ["url"],
    },
  },
  {
    name: "generate_timestamps",
    description: "Generate YouTube chapter timestamps from a video transcript using AI.",
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
    description: "Switch the studio UI to a specific tab. Use when user asks to 'go to', 'open', or 'show' a tool.",
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

const SYSTEM_PROMPT = `You are VideoMaking Studio Copilot — a powerful AI agent that can perform any task in the VideoMaking Studio platform on behalf of the user.

You have access to these tools:
- get_video_info: Fetch video metadata (title, duration, uploader)
- download_video: Download full YouTube videos
- cut_video_clip: Cut a specific time range from a video
- find_best_clips: AI-powered best-segment detection for long videos
- generate_subtitles: Create SRT subtitle files, optionally translated
- generate_timestamps: Generate chapter timestamps for YouTube
- list_shared_files: Browse the public file gallery
- navigate_to_tab: Switch to any studio tool tab

Guidelines:
- Always be transparent about which tools you're using and why.
- If the user gives you a YouTube URL with a task, parse the timestamps correctly (e.g. "5:32 to 6:23" = startTime "5:32", endTime "6:23").
- After completing a task, summarize what was done and offer next steps.
- Be concise and action-oriented. This is a production tool, not a chatbot.
- If a task takes time (download, render), explain that it starts in the background.
- For devotional/Bhagwat content, be respectful and helpful.`;

// ── Tool executor: maps Gemini tool calls → real API calls ───────────────────
const BASE_URL = process.env.INTERNAL_API_BASE ?? "http://localhost:3000";

async function executeTool(name: string, args: Record<string, any>, req: any): Promise<{ result: any; artifact?: object }> {
  const apiBase = `${BASE_URL}/api`;

  switch (name) {
    case "get_video_info": {
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": req.headers.cookie ?? "" },
        body: JSON.stringify({ url: args.url }),
      });
      const data = await r.json().catch(() => ({ error: "Failed to fetch info" }));
      return { result: data };
    }

    case "download_video": {
      const r = await fetch(`${apiBase}/youtube/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": req.headers.cookie ?? "" },
        body: JSON.stringify({ url: args.url, formatId: args.quality ?? "best" }),
      });
      const data = await r.json().catch(() => ({ error: "Download failed" }));
      const artifact = data.jobId
        ? { artifactType: "job_link", label: `Download started (Job: ${data.jobId})`, tab: "download" }
        : undefined;
      return { result: data, artifact };
    }

    case "cut_video_clip": {
      const r = await fetch(`${apiBase}/youtube/clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": req.headers.cookie ?? "" },
        body: JSON.stringify({
          url: args.url,
          startTime: args.startTime,
          endTime: args.endTime,
          quality: args.quality ?? "720p",
        }),
      });
      const data = await r.json().catch(() => ({ error: "Clip failed" }));
      const artifact = data.jobId
        ? { artifactType: "job_link", label: `Clip job started (${args.startTime} → ${args.endTime})`, tab: "clipcutter", jobId: data.jobId }
        : undefined;
      return { result: data, artifact };
    }

    case "find_best_clips": {
      const r = await fetch(`${apiBase}/youtube/best-clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": req.headers.cookie ?? "" },
        body: JSON.stringify({
          url: args.url,
          durationMode: args.durationMode ?? "auto",
          instructions: args.instructions,
        }),
      });
      const data = await r.json().catch(() => ({ error: "Best clips failed" }));
      const artifact = data.id
        ? { artifactType: "job_link", label: "Best Clips analysis started", tab: "clips" }
        : undefined;
      return { result: data, artifact };
    }

    case "generate_subtitles": {
      const r = await fetch(`${apiBase}/subtitles/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": req.headers.cookie ?? "" },
        body: JSON.stringify({
          url: args.url,
          language: args.language ?? "auto",
          translateTo: args.translateTo,
        }),
      });
      const data = await r.json().catch(() => ({ error: "Subtitle gen failed" }));
      const artifact = data.id
        ? { artifactType: "job_link", label: "Subtitle generation started", tab: "subtitles" }
        : undefined;
      return { result: data, artifact };
    }

    case "generate_timestamps": {
      const r = await fetch(`${apiBase}/timestamps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": req.headers.cookie ?? "" },
        body: JSON.stringify({ url: args.url }),
      });
      const data = await r.json().catch(() => ({ error: "Timestamp gen failed" }));
      return { result: data };
    }

    case "list_shared_files": {
      const limit = args.limit ?? 12;
      const r = await fetch(`${apiBase}/uploads/public?limit=${limit}`, {
        headers: { "Cookie": req.headers.cookie ?? "" },
      });
      const data = await r.json().catch(() => ({ items: [] }));
      return { result: data };
    }

    case "navigate_to_tab": {
      return { result: { navigated: true, tab: args.tab } };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

// ── POST /api/agent/chat ─────────────────────────────────────────────────────
router.post("/agent/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    res.status(503).json({ error: "AI Copilot is not configured. Add GEMINI_API_KEY to environment." });
    return;
  }

  const { messages = [] } = req.body as {
    messages: Array<{ role: "user" | "model"; content: string }>;
  };

  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    // Convert our messages to Gemini format
    const geminiContents = messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    let continueLoop = true;
    let loopContents = [...geminiContents];

    // Agentic loop: keep going until no more tool calls
    while (continueLoop) {
      const response = await ai.models.generateContent({
        model: AGENT_MODEL,
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: STUDIO_TOOLS }],
        contents: loopContents,
      });

      const candidate = response.candidates?.[0];
      if (!candidate) {
        sseEvent(res, { type: "text", content: "I wasn't able to process that request. Please try again." });
        break;
      }

      const parts = candidate.content?.parts ?? [];
      let hasToolCall = false;
      const toolResults: any[] = [];

      for (const part of parts) {
        // Text token
        if (part.text) {
          sseEvent(res, { type: "text", content: part.text });
        }

        // Tool call
        if (part.functionCall) {
          hasToolCall = true;
          const { name, args } = part.functionCall;
          const toolArgs = (args ?? {}) as Record<string, any>;

          // Emit tool_start
          sseEvent(res, { type: "tool_start", name, args: toolArgs });

          // Special case: navigate doesn't need an API call
          if (name === "navigate_to_tab") {
            sseEvent(res, { type: "navigate", tab: toolArgs.tab });
          }

          // Execute tool
          const { result, artifact } = await executeTool(name!, toolArgs, req);

          // Emit tool_done
          sseEvent(res, { type: "tool_done", name, result });

          // Emit artifact if present
          if (artifact) {
            sseEvent(res, { type: "artifact", ...artifact });
          }

          toolResults.push({
            functionResponse: {
              name,
              response: { result },
            },
          });
        }
      }

      if (hasToolCall) {
        // Add model response + tool results back to context for next loop
        loopContents = [
          ...loopContents,
          { role: "model" as const, parts },
          { role: "user" as const, parts: toolResults },
        ];
      } else {
        // No more tool calls — done
        continueLoop = false;
      }
    }

    sseEvent(res, { type: "done" });
    res.end();
  } catch (err: any) {
    sseEvent(res, { type: "error", message: err?.message ?? "Unknown error in copilot" });
    res.end();
  }
});

export default router;
