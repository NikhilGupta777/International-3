import { Router } from "express";
import { randomUUID } from "crypto";
import { Type } from "@google/genai";
import { setupSse, sseFlush } from "../lib/sse";
import {
  buildContentManagerModelContext,
  CONTENT_MANAGER_MODEL,
} from "../lib/youtube-content-profile";
import {
  deleteContentProfile,
  getContentProfile,
  isContentProfileStoreEnabled,
  listContentProfiles,
  upsertContentProfile,
} from "../lib/youtube-content-profile-store";
import { scrapeYouTubeChannelProfile } from "../lib/youtube-content-scraper";
import {
  buildThinkingConfig,
  createGeminiClient,
  ensureVertexCredentials,
  getGeminiApiKeyForAttempt,
  getPersonalKeysForCaller,
  isGeminiConfigured,
} from "../lib/gemini-client";
import {
  COPILOT_FAST_MODEL,
  getCopilotFallbackModels,
  isExternalCopilotConfigured,
  isExternalProviderRetryableError,
  streamExternalCopilot,
} from "../lib/copilot-external-provider";
import { isTavilyConfigured, searchWithTavily } from "../lib/tavily-search";

const router = Router();
const MAX_TOPIC_CHARS = 4000;
const MAX_AGENT_ITERATIONS = 6;
const MAX_SEARCHES_PER_RUN = 4;
const MAX_VIDEO_CAPTION_CHARS = 220_000;
const DEFAULT_CAPTION_LANGUAGE = "hi";
const CONTENT_MANAGER_AI_TIMEOUT_MS = Math.min(
  60_000,
  Math.max(10_000, Number(process.env.CONTENT_MANAGER_AI_TIMEOUT_MS) || 30_000),
);
const CONTENT_MANAGER_PROVIDER_RETRIES = 2;

type ContentPack = {
  titles: Array<{ title: string; rationale: string }>;
  description: string;
  tagsCsv: string;
  bestUploadTime: { day: string; time: string; timezone: string; rationale: string };
  mustDo: string[];
  channelSignals: string[];
  sources?: Array<{ title: string; url: string }>;
};

type VideoSourceContext = {
  url: string;
  info?: Record<string, any>;
  captions?: {
    language: string;
    content: string;
    contentBytes: number;
    fullContentInContext: boolean;
    subtitleSource?: string;
    videoDurationSec?: number;
  };
  errors: string[];
};

function send(res: any, payload: object): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
}

type ContentManagerStreamParams = {
  contents: any[];
  config: Record<string, any>;
  tools?: any[];
  runId: string;
  res: any;
  validate?: (chunks: any[]) => void;
};

async function collectStream(stream: AsyncIterable<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  if (chunks.length === 0) throw new Error("AI provider returned an empty response");
  return chunks;
}

function textFromChunks(chunks: any[]): string {
  let text = "";
  for (const chunk of chunks) {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (!part.thought && part.text) text += part.text;
    }
  }
  return text;
}

/**
 * Content Manager uses the same public-provider ladder and per-provider key
 * rotation as Super Agent, then falls back through every configured Gemini key.
 * A full attempt is buffered before it is exposed to the route so a provider
 * that fails halfway through a stream cannot leave duplicate partial text in
 * the user's conversation when the next provider takes over.
 */
async function generateContentManagerChunks(params: ContentManagerStreamParams): Promise<any[]> {
  const externalModels = [COPILOT_FAST_MODEL, ...getCopilotFallbackModels(COPILOT_FAST_MODEL)]
    .filter((model) => isExternalCopilotConfigured(model))
    .filter((model, index, models) => models.indexOf(model) === index);
  const geminiKeys = getPersonalKeysForCaller("content-manager");
  const totalAttempts = externalModels.length * CONTENT_MANAGER_PROVIDER_RETRIES
    + (isGeminiConfigured() ? Math.max(1, geminiKeys.length) : 0);
  let attemptNumber = 0;
  let lastError: any = null;

  const announceFallback = () => {
    if (attemptNumber <= 1) return;
    send(params.res, {
      type: "status",
      runId: params.runId,
      message: "The primary AI is busy. Trying another available model...",
    });
  };

  // CloudFront closes an otherwise healthy streaming response when a model
  // takes too long without producing bytes. Attempts are intentionally
  // buffered for safe failover, so keep the client stream alive separately.
  const heartbeat = setInterval(() => {
    if (params.res.writableEnded || (params.res as any).closed) return;
    send(params.res, { type: "heartbeat", runId: params.runId });
  }, 8_000);

  try {
    for (const model of externalModels) {
    for (let providerAttempt = 0; providerAttempt < CONTENT_MANAGER_PROVIDER_RETRIES; providerAttempt += 1) {
      attemptNumber += 1;
      announceFallback();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONTENT_MANAGER_AI_TIMEOUT_MS);
      try {
        const chunks = await collectStream(streamExternalCopilot({
          model,
          contents: params.contents,
          systemInstruction: CONTENT_MANAGER_SYSTEM_PROMPT,
          tools: params.tools ?? [],
          signal: controller.signal,
        }));
        params.validate?.(chunks);
        return chunks;
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[content-manager] external attempt ${attemptNumber}/${totalAttempts} failed: ${String(err?.message ?? err)}`,
        );
        if (!isExternalProviderRetryableError(err)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(err?.retryAfterMs) || 250, 2_000)));
      } finally {
        clearTimeout(timeout);
      }
    }
    }

    if (isGeminiConfigured()) {
      const geminiAttempts = Math.max(1, geminiKeys.length);
      for (let keyAttempt = 0; keyAttempt < geminiAttempts; keyAttempt += 1) {
      attemptNumber += 1;
      announceFallback();
      try {
        const apiKey = getGeminiApiKeyForAttempt("content-manager", keyAttempt);
        const client = createGeminiClient({
          caller: "content-manager",
          apiKey: apiKey || undefined,
          httpOptions: { timeout: CONTENT_MANAGER_AI_TIMEOUT_MS },
        });
        const chunks = await collectStream(await client.models.generateContentStream({
          model: CONTENT_MANAGER_MODEL,
          contents: params.contents,
          config: params.config,
        }));
        params.validate?.(chunks);
        return chunks;
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[content-manager] Gemini attempt ${keyAttempt + 1}/${geminiAttempts} failed: ${String(err?.message ?? err)}`,
        );
      }
      }
    }

    throw new Error("All configured AI models are temporarily unavailable. Please retry in a moment.", {
      cause: lastError,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

function normalizeAiErrorMessage(err: any): string {
  const raw = String(err?.message ?? err ?? "Content generation failed");
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const message = String(parsed?.error?.message ?? parsed?.message ?? "").trim();
      if (/internal error encountered/i.test(message)) {
        return "The AI provider hit a temporary internal error. Please retry.";
      }
      if (message) return message;
    } catch {
      // Fall through to text cleanup.
    }
  }
  if (/internal error encountered|status.+internal|code.+500/i.test(raw)) {
    return "The AI provider hit a temporary internal error. Please retry.";
  }
  return raw.trim() || "Content generation failed";
}

function getApiBase(): string {
  if (process.env.INTERNAL_API_BASE) return `${process.env.INTERNAL_API_BASE}/api`;
  return `http://127.0.0.1:${process.env.PORT ?? 8080}/api`;
}

function buildInternalHeaders(req: any): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: req.headers.cookie ?? "",
    "x-internal-agent": process.env.INTERNAL_AGENT_SECRET || "dev-internal-agent-secret",
  };
  if (req.headers["x-forwarded-for"]) headers["x-forwarded-for"] = String(req.headers["x-forwarded-for"]);
  else if (req.ip) headers["x-forwarded-for"] = req.ip;
  if (req.headers["x-notify-client"]) headers["x-notify-client"] = String(req.headers["x-notify-client"]);
  if (req.headers["x-client-id"]) headers["x-client-id"] = String(req.headers["x-client-id"]);
  if (req.headers["x-device-id"]) headers["x-device-id"] = String(req.headers["x-device-id"]);
  return headers;
}

function extractYouTubeUrl(text: string): string | null {
  const match = String(text ?? "").match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s<>"']*v=[\w-]{11}[^\s<>"']*|youtu\.be\/[\w-]{11}[^\s<>"']*|youtube\.com\/shorts\/[\w-]{11}[^\s<>"']*)/i);
  return match?.[0] ?? null;
}

function buildEffectiveTopic(topic: string, sourceUrl: string | null): string {
  if (!sourceUrl) return topic;
  const withoutUrls = topic
    .replace(sourceUrl, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutUrls.length >= 4
    ? withoutUrls
    : "Create the best title suggestions and SEO pack from this source video for the selected channel.";
}

function formatDuration(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

async function readResponseTextWithLimit(res: Response, maxChars: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  if (text.length >= maxChars) {
    try { await reader.cancel(); } catch {}
  } else {
    text += decoder.decode();
  }
  return text.slice(0, maxChars);
}

async function fetchVideoSourceContext(req: any, res: any, runId: string, url: string): Promise<VideoSourceContext> {
  const apiBase = getApiBase();
  const headers = buildInternalHeaders(req);
  const language = DEFAULT_CAPTION_LANGUAGE;
  const result: VideoSourceContext = { url, errors: [] };

  send(res, { type: "video_tool_start", runId, name: "get_video_info", label: "Fetching video info" });
  send(res, { type: "video_tool_start", runId, name: "get_youtube_captions", label: "Getting captions" });

  const [infoOutcome, captionsOutcome] = await Promise.allSettled([
    (async () => {
      const r = await fetch(`${apiBase}/youtube/info`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({})) as Record<string, any>;
      if (!r.ok) throw new Error(data?.error ?? `Info fetch failed: ${r.status}`);
      return data;
    })(),
    (async () => {
      const r = await fetch(`${apiBase}/youtube/subtitles?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(language)}&format=srt`, {
        headers,
      });
      const rawText = await readResponseTextWithLimit(r, MAX_VIDEO_CAPTION_CHARS + 1);
      if (!r.ok) {
        let message = rawText || `Captions fetch failed: ${r.status}`;
        try {
          const parsed = JSON.parse(rawText) as { error?: string };
          message = parsed.error ?? message;
        } catch {}
        throw new Error(message);
      }
      return {
        language,
        content: rawText.slice(0, MAX_VIDEO_CAPTION_CHARS),
        contentBytes: Buffer.byteLength(rawText.slice(0, MAX_VIDEO_CAPTION_CHARS), "utf8"),
        fullContentInContext: rawText.length <= MAX_VIDEO_CAPTION_CHARS,
        subtitleSource: r.headers.get("x-subtitle-source") ?? undefined,
        videoDurationSec: Number(r.headers.get("x-video-duration") ?? "") || undefined,
      };
    })(),
  ]);

  if (infoOutcome.status === "fulfilled") {
    result.info = infoOutcome.value;
    send(res, { type: "video_tool_done", runId, name: "get_video_info", label: "Video info fetched" });
  } else {
    const message = infoOutcome.reason?.message ?? "Video info failed";
    result.errors.push(`get_video_info: ${message}`);
    send(res, { type: "video_tool_done", runId, name: "get_video_info", label: "Video info failed", error: message });
  }

  if (captionsOutcome.status === "fulfilled") {
    result.captions = captionsOutcome.value;
    send(res, { type: "video_tool_done", runId, name: "get_youtube_captions", label: "Captions fetched" });
  } else {
    const message = captionsOutcome.reason?.message ?? "Captions failed";
    result.errors.push(`get_youtube_captions: ${message}`);
    send(res, { type: "video_tool_done", runId, name: "get_youtube_captions", label: "Captions failed", error: message });
  }

  return result.info || result.captions ? result : { ...result, errors: result.errors.length ? result.errors : ["No video information or captions could be fetched."] };
}

function buildVideoSourcePrompt(source: VideoSourceContext | null, maxCaptionChars = MAX_VIDEO_CAPTION_CHARS): string {
  if (!source) return "";
  const info = source.info ?? {};
  const captionContent = source.captions?.content.slice(0, maxCaptionChars);
  const lines = [
    "YOUTUBE SOURCE VIDEO PROVIDED BY USER",
    `URL: ${source.url}`,
    info.title ? `Existing title: ${info.title}` : "",
    info.uploader ? `Source channel: ${info.uploader}` : "",
    info.duration ? `Duration: ${formatDuration(info.duration)} (${info.duration}s)` : "",
    info.viewCount != null ? `Views: ${Number(info.viewCount).toLocaleString("en-US")}` : "",
    info.uploadDate ? `Upload date: ${info.uploadDate}` : "",
    info.description ? `Existing description excerpt: ${String(info.description).slice(0, 500)}` : "",
    source.captions
      ? `Available captions (${source.captions.language}, source ${source.captions.subtitleSource ?? "unknown"}${source.captions.fullContentInContext && source.captions.content.length <= maxCaptionChars ? "" : ", truncated for prompt safety"}):\n${captionContent}`
      : "",
    source.errors.length ? `Tool notes:\n${source.errors.join("\n")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

router.get("/content-manager/profiles", async (_req, res) => {
  if (!isContentProfileStoreEnabled()) {
    res.json({ profiles: [], enabled: false });
    return;
  }
  try {
    res.json({ profiles: await listContentProfiles(), enabled: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to list channel profiles" });
  }
});

router.get("/content-manager/profiles/:id", async (req, res) => {
  try {
    const record = await getContentProfile(String(req.params.id));
    if (!record) {
      res.status(404).json({ error: "Channel profile not found" });
      return;
    }
    res.json({ profile: record.profile, id: record.jobId, updatedAt: record.updatedAt });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to load channel profile" });
  }
});

router.delete("/content-manager/profiles/:id", async (req, res) => {
  try {
    res.json({ ok: await deleteContentProfile(String(req.params.id)) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to delete channel profile" });
  }
});

router.post("/content-manager/channels/scrape", async (req, res) => {
  const channelInput = String(req.body?.channelInput ?? "").trim();
  const profileId = String(req.body?.profileId ?? "").trim();
  if (!channelInput) {
    res.status(400).json({ error: "channelInput is required" });
    return;
  }
  setupSse(res);
  const runId = randomUUID();
  send(res, { type: "ready", runId });
  try {
    send(res, { type: "status", runId, message: "Starting one-time channel scan..." });
    const profile = await scrapeYouTubeChannelProfile({
      channelInput,
      progress: (message) => send(res, { type: "status", runId, message }),
    });
    const saved = await upsertContentProfile({ id: profileId || undefined, profile });
    send(res, {
      type: "profile",
      runId,
      profileId: saved.jobId,
      summary: {
        id: saved.jobId,
        name: saved.name,
        channelInput: saved.channelInput,
        channelUrl: saved.profile.channelUrl,
        videoCount: saved.profile.recentVideos.length,
        scrapedAt: saved.profile.scrapedAt,
        updatedAt: saved.updatedAt,
      },
    });
    send(res, { type: "done", runId });
  } catch (err: any) {
    send(res, { type: "error", runId, message: err?.message ?? "Channel scrape failed" });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

router.post("/content-manager/generate", async (req, res) => {
  const hasExternalAi = [COPILOT_FAST_MODEL, ...getCopilotFallbackModels(COPILOT_FAST_MODEL)]
    .some((model) => isExternalCopilotConfigured(model));
  if (!hasExternalAi && !isGeminiConfigured()) {
    res.status(503).json({ error: "AI generation is not configured. Add an AI provider key first." });
    return;
  }
  try { await ensureVertexCredentials(); } catch { /* API-key mode */ }

  const profileId = String(req.body?.profileId ?? "").trim();
  const topic = String(req.body?.topic ?? "").trim().slice(0, MAX_TOPIC_CHARS);
  if (!profileId) {
    res.status(400).json({ error: "profileId is required" });
    return;
  }
  if (!topic) {
    res.status(400).json({ error: "topic is required" });
    return;
  }

  setupSse(res);
  const runId = randomUUID();
  send(res, { type: "ready", runId, model: "auto" });
  try {
    const record = await getContentProfile(profileId);
    if (!record) throw new Error("Channel profile not found. Add or refresh the channel first.");
    send(res, { type: "status", runId, message: "Analyzing saved channel data..." });

    const sourceUrl = extractYouTubeUrl(topic);
    const effectiveTopic = buildEffectiveTopic(topic, sourceUrl);
    const videoSource = sourceUrl ? await fetchVideoSourceContext(req, res, runId, sourceUrl) : null;
    const context = buildContentManagerModelContext({ profile: record.profile, topic: effectiveTopic });
    const videoContext = buildVideoSourcePrompt(videoSource);
    const isVideoSourceRequest = Boolean(videoSource);

    // ── PHASE 1: converse, optionally search, decide intent ──────────────────
    // The model chats like a person. For a real content request it may search,
    // then calls request_content_pack to signal it's ready to build the pack.
    const contents: any[] = [{ role: "user", parts: [{ text: [context, videoContext].filter(Boolean).join("\n\n") }] }];
    const collectedSources: Array<{ title: string; url: string }> = [];
    const researchNotes: string[] = [];
    let summary = "";
    let wantsPack = false;
    let packAngle = "";
    let searchCount = 0;

    if (isVideoSourceRequest) {
      wantsPack = true;
      packAngle = "Create title and SEO suggestions from the fetched source-video captions for the selected channel style.";
      summary = "I fetched the source video info and captions. Now I am turning the transcript into title options and an SEO pack for the selected channel style.";
      send(res, { type: "summary_delta", runId, content: summary });
    }

    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS && !wantsPack; iteration += 1) {
      send(res, { type: "thinking", runId, stage: iteration === 0 ? "analyzing" : "refining" });
      const chunks = await generateContentManagerChunks({
        contents,
        config: {
          systemInstruction: CONTENT_MANAGER_SYSTEM_PROMPT,
          maxOutputTokens: 50000,
          thinkingConfig: {
            ...buildThinkingConfig(CONTENT_MANAGER_MODEL, "HIGH"),
            includeThoughts: true,
          },
          tools: [{ functionDeclarations: CONTENT_MANAGER_TOOLS }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
        },
        tools: [{ functionDeclarations: CONTENT_MANAGER_TOOLS }],
        runId,
        res,
      });

      const modelParts: any[] = [];
      const functionCalls: Array<{ id?: string; name: string; args: Record<string, any> }> = [];
      let turnText = "";
      for (const chunk of chunks) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought && part.text) {
            send(res, { type: "thought_delta", runId, content: part.text });
          } else if (part.functionCall?.name) {
            modelParts.push({ functionCall: part.functionCall });
            functionCalls.push({
              id: part.functionCall.id,
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, any>,
            });
          } else if (part.text) {
            summary += part.text;
            turnText += part.text;
            modelParts.push({ text: part.text });
            send(res, { type: "summary_delta", runId, content: part.text });
          }
        }
      }

      if (functionCalls.length === 0) {
        // A real conversational reply (visible text) means we're done.
        if (turnText.trim()) break;
        // Otherwise the model spent the whole turn thinking and emitted nothing —
        // don't stop dead. Nudge it to actually respond, up to the iteration cap.
        if (iteration >= MAX_AGENT_ITERATIONS - 1) break;
        if (modelParts.length) contents.push({ role: "model", parts: modelParts });
        contents.push({
          role: "user",
          parts: [{ text: "Continue. If the user wants video content, call request_content_pack now. Otherwise reply in 1-3 short sentences." }],
        });
        continue;
      }
      contents.push({ role: "model", parts: modelParts });

      const responseParts: any[] = [];
      for (const call of functionCalls) {
        if (call.name === "request_content_pack") {
          wantsPack = true;
          packAngle = String(call.args?.angle ?? "").trim();
          responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { ok: true } } } });
          continue;
        }
        if (call.name === "web_search") {
          const query = String(call.args?.query ?? "").trim();
          if (!query) {
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { error: "query is required" } } } });
            continue;
          }
          if (searchCount >= MAX_SEARCHES_PER_RUN) {
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { error: "Search budget reached. Use the notes you already have." } } } });
            continue;
          }
          if (!isTavilyConfigured()) {
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { error: "Web search is unavailable. Rely on the saved channel data." } } } });
            continue;
          }
          searchCount += 1;
          send(res, { type: "search_start", runId, query });
          try {
            const search = await searchWithTavily({ query, maxResults: 5 });
            for (const source of search.sources) {
              if (!collectedSources.some((item) => item.url === source.url)) collectedSources.push(source);
            }
            if (search.notes) researchNotes.push(`Search "${query}":\n${search.notes}`);
            send(res, { type: "search_done", runId, query, count: search.sources.length });
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { notes: search.notes, sources: search.sources } } } });
          } catch (searchErr: any) {
            send(res, { type: "search_done", runId, query, count: 0 });
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { error: searchErr?.message ?? "Search failed" } } } });
          }
          continue;
        }
        responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: { error: `Unknown tool: ${call.name}` } } } });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    const cleanSummary = stripMarkup(summary);

    // A greeting / general question stays a plain conversational reply.
    if (!wantsPack) {
      send(res, { type: "result", runId, pack: null, summary: cleanSummary });
      send(res, { type: "done", runId });
      return;
    }

    // ── PHASE 2: build the structured pack (visible "generating" window) ──────
    // Use a CLEAN text-only prompt — reusing the phase-1 conversation (which holds
    // functionCall/functionResponse parts) with responseSchema + no tools makes the
    // Gemini API reject the request, which killed the pack after the blue card showed.
    send(res, { type: "pack_start", runId });
    const buildPhase2Prompt = (sourcePrompt: string) => [
      context,
      sourcePrompt ? `\nSOURCE VIDEO TRANSCRIPT AND METADATA:\n${sourcePrompt}` : "",
      packAngle ? `\nRECOMMENDED DIRECTION: ${packAngle}` : "",
      summary.trim() ? `\nYOUR SUMMARY ALREADY SHOWN TO THE USER:\n${stripMarkup(summary)}` : "",
      researchNotes.length ? `\nLIVE RESEARCH NOTES:\n${researchNotes.join("\n\n")}` : "",
      "\nNow produce the final content pack as JSON matching the required schema. Return JSON only.",
    ].filter(Boolean).join("\n");
    // Keep the SSE stream warm while the pack build runs.
    const heartbeat = setInterval(() => {
      if (res.writableEnded || (res as any).closed || req.destroyed) {
        clearInterval(heartbeat);
        return;
      }
      send(res, { type: "heartbeat", runId });
    }, 8000);
    let builtText = "";
    try {
      const sourcePrompts = videoSource
        ? [videoContext, buildVideoSourcePrompt(videoSource, 80_000)]
        : [videoContext];
      let lastErr: any = null;
      for (let attempt = 0; attempt < sourcePrompts.length; attempt += 1) {
        builtText = "";
        try {
          const packChunks = await generateContentManagerChunks({
            contents: [{ role: "user", parts: [{ text: buildPhase2Prompt(sourcePrompts[attempt]) }] }],
            config: {
              systemInstruction: CONTENT_MANAGER_SYSTEM_PROMPT,
              maxOutputTokens: 50000,
              thinkingConfig: {
                ...buildThinkingConfig(CONTENT_MANAGER_MODEL, "HIGH"),
                includeThoughts: true,
              },
              responseMimeType: "application/json",
              responseSchema: CONTENT_PACK_SCHEMA,
            },
            tools: [],
            runId,
            res,
            validate: (chunks) => {
              requireCompleteContentPack(parseJson(textFromChunks(chunks)));
            },
          });
          for (const chunk of packChunks) {
            const parts = chunk.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
              if (part.thought && part.text) {
                send(res, { type: "thought_delta", runId, content: part.text });
              } else if (part.text) {
                builtText += part.text;
              }
            }
          }
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          const canRetry = attempt < sourcePrompts.length - 1 && /internal error|status.+internal|code.+500|temporar/i.test(String(err?.message ?? err));
          if (!canRetry) throw err;
          send(res, { type: "status", runId, message: "Retrying with a compact transcript excerpt..." });
          continue;
        }
      }
      if (lastErr) throw lastErr;
    } finally {
      clearInterval(heartbeat);
    }
    let pack: ContentPack;
    try {
      pack = requireCompleteContentPack(parseJson(builtText));
    } catch {
      throw new Error("The AI returned an unreadable content pack. Please try again.");
    }
    if (collectedSources.length > 0) pack.sources = collectedSources;
    send(res, { type: "result", runId, pack, summary: cleanSummary });
    send(res, { type: "done", runId });
  } catch (err: any) {
    send(res, { type: "error", runId, message: normalizeAiErrorMessage(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

const CONTENT_MANAGER_SYSTEM_PROMPT = `You are the Content Manager — a friendly, senior YouTube strategist chatting inside a video production app. You have the user's scraped public channel profile in memory.

Talk like a real person, not a form. Match the user's energy and keep it natural.

# WHEN TO JUST CHAT (no tools, no pack)
If the user is greeting you, making small talk, thanking you, or asking a general/vague question ("hi", "hello", "what can you do", "how are you"), simply reply in 1-3 warm, natural sentences. Do NOT call any tool. Do NOT invent a video. You can briefly offer to plan their next upload, then stop.

# WHEN TO BUILD A CONTENT PACK
Only when the user actually asks for video help — a title, titles, an SEO description, tags, the best upload time, a "next upload" idea, or a plan for a specific topic — do the real work:
1. Think through the channel's proven wording, tags, cadence, and upload windows.
2. If the user pasted a YouTube URL, the app has already fetched get_video_info and get_youtube_captions in parallel. Use the source video's title/metadata only as supporting context, and analyze the captions as the main source of what the video is actually about.
3. For pasted source videos, create the pack for the SELECTED CHANNEL'S audience and style, using the caption substance and channel signals together. Do not simply copy the source video's existing title.
4. web_search(query) ONLY if the topic is time-sensitive (breaking news, a current event, "today"/"latest", a trending angle) or you are unsure of a fact. Skip it for evergreen/generic topics and for source-video-only title generation unless facts need checking.
5. Write a SHORT (2-4 sentence) plain-language summary of your recommendation as normal text.
6. Then call request_content_pack() to hand off — the app builds the full structured pack for you. Do NOT write the titles/description/tags yourself in your text.

# TOOLS
- web_search(query): live web search. Use sparingly, only when genuinely needed.
- request_content_pack(): call once, only for real content requests, after your short summary. Signals the app to generate the pack.

# OUTPUT STYLE — IMPORTANT
- Your visible text must be clean, plain prose. NEVER output HTML, tags, hidden <div>s, HTML comments (<!-- -->), markdown code fences, or JSON in your text. The pack goes ONLY through request_content_pack.

# CONTENT RULES (for the pack)
- Exactly 5 title options, each with a one-line rationale.
- One complete SEO description, ready to paste into YouTube.
- Tags must be a single comma-separated string.
- Best upload time must be based on the saved public upload/performance patterns.
- 1-3 must-do recommendations only.
- Use the channel's proven wording, tags, and topic patterns, but never copy old titles verbatim.
- Never claim private analytics (CTR, retention, impressions, returning viewers, audience demographics, or YouTube Studio-only data) unless those exact fields are present in the input.
- Only cite facts you actually found via web_search. Never invent sources.`;

const CONTENT_MANAGER_TOOLS: any[] = [
  {
    name: "web_search",
    description:
      "Search the live web for current facts, breaking news, or trending context about the topic. Only use for time-sensitive or uncertain topics.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Focused search query." },
        reason: { type: Type.STRING, description: "Why this search is needed (one short phrase)." },
      },
      required: ["query"],
    },
  },
  {
    name: "request_content_pack",
    description:
      "Signal that the user genuinely wants a YouTube content pack and you are ready to build it. Call this AFTER writing your short plain-text summary and doing any needed search. The app then generates the full pack (titles, SEO description, tags, upload time, must-dos). Call it once. Do NOT call it for greetings or general chat.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        angle: { type: Type.STRING, description: "One-line description of the video direction you recommend." },
      },
      required: [],
    },
  },
];

const CONTENT_PACK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    titles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          rationale: { type: Type.STRING },
        },
        required: ["title", "rationale"],
      },
    },
    description: { type: Type.STRING },
    tagsCsv: { type: Type.STRING },
    bestUploadTime: {
      type: Type.OBJECT,
      properties: {
        day: { type: Type.STRING },
        time: { type: Type.STRING },
        timezone: { type: Type.STRING },
        rationale: { type: Type.STRING },
      },
      required: ["day", "time", "timezone", "rationale"],
    },
    mustDo: { type: Type.ARRAY, items: { type: Type.STRING } },
    channelSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["titles", "description", "tagsCsv", "bestUploadTime", "mustDo", "channelSignals"],
};

function parseJson(text: string): unknown {
  const clean = String(text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(clean);
}

// The model sometimes leaks hidden HTML/comments ("<div style=display:none>",
// "<!-- internal logic -->") or code fences into its prose. Strip them so the
// user only ever sees clean sentences.
function stripMarkup(text: string): string {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function coerceContentPack(value: unknown): ContentPack {
  const obj = value && typeof value === "object" ? value as any : {};
  const titles = Array.isArray(obj.titles) ? obj.titles.slice(0, 5).map((item: any) => ({
    title: String(item?.title ?? "").trim(),
    rationale: String(item?.rationale ?? "").trim(),
  })).filter((item: any) => item.title) : [];
  while (titles.length < 5) {
    titles.push({ title: `Title option ${titles.length + 1}`, rationale: "The model returned fewer than five options." });
  }
  const best = obj.bestUploadTime && typeof obj.bestUploadTime === "object" ? obj.bestUploadTime : {};
  return {
    titles: titles.slice(0, 5),
    description: String(obj.description ?? "").trim(),
    tagsCsv: Array.isArray(obj.tagsCsv)
      ? obj.tagsCsv.map((t: unknown) => String(t).trim()).filter(Boolean).join(", ")
      : String(obj.tagsCsv ?? "").trim(),
    bestUploadTime: {
      day: String(best.day ?? "Best observed day").trim(),
      time: String(best.time ?? "Best observed time").trim(),
      timezone: String(best.timezone ?? "IST").trim(),
      rationale: String(best.rationale ?? "").trim(),
    },
    mustDo: (Array.isArray(obj.mustDo) ? obj.mustDo : []).map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 3),
    channelSignals: (Array.isArray(obj.channelSignals) ? obj.channelSignals : []).map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 8),
  };
}

function requireCompleteContentPack(value: unknown): ContentPack {
  const raw = value && typeof value === "object" ? value as any : {};
  const rawTitles = Array.isArray(raw.titles) ? raw.titles : [];
  const pack = coerceContentPack(value);
  const hasFiveRealTitles = rawTitles.length >= 5
    && pack.titles.length === 5
    && pack.titles.every((item) => item.title.length > 0 && item.rationale.length > 0);
  const hasUploadTime = [
    pack.bestUploadTime.day,
    pack.bestUploadTime.time,
    pack.bestUploadTime.timezone,
    pack.bestUploadTime.rationale,
  ].every((item) => item.length > 0);
  if (
    !hasFiveRealTitles
    || pack.description.length === 0
    || pack.tagsCsv.length === 0
    || !hasUploadTime
    || pack.mustDo.length === 0
    || pack.channelSignals.length === 0
  ) {
    throw new Error("AI provider returned an incomplete content pack");
  }
  return pack;
}

export default router;
