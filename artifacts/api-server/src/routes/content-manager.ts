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
  isGeminiConfigured,
} from "../lib/gemini-client";
import { isTavilyConfigured, searchWithTavily } from "../lib/tavily-search";

const router = Router();
const MAX_TOPIC_CHARS = 4000;
const MAX_AGENT_ITERATIONS = 6;
const MAX_SEARCHES_PER_RUN = 4;

type ContentPack = {
  titles: Array<{ title: string; rationale: string }>;
  description: string;
  tagsCsv: string;
  bestUploadTime: { day: string; time: string; timezone: string; rationale: string };
  mustDo: string[];
  channelSignals: string[];
  sources?: Array<{ title: string; url: string }>;
};

function send(res: any, payload: object): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
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
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "AI generation is not configured. Add Gemini API keys first." });
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
  send(res, { type: "ready", runId, model: CONTENT_MANAGER_MODEL });
  try {
    const record = await getContentProfile(profileId);
    if (!record) throw new Error("Channel profile not found. Add or refresh the channel first.");
    send(res, { type: "status", runId, message: "Analyzing saved channel data..." });

    const context = buildContentManagerModelContext({ profile: record.profile, topic });
    const client = createGeminiClient({ caller: "content-manager" });

    // ── PHASE 1: converse, optionally search, decide intent ──────────────────
    // The model chats like a person. For a real content request it may search,
    // then calls request_content_pack to signal it's ready to build the pack.
    const contents: any[] = [{ role: "user", parts: [{ text: context }] }];
    const collectedSources: Array<{ title: string; url: string }> = [];
    const researchNotes: string[] = [];
    let summary = "";
    let wantsPack = false;
    let packAngle = "";
    let searchCount = 0;

    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS && !wantsPack; iteration += 1) {
      send(res, { type: "thinking", runId, stage: iteration === 0 ? "analyzing" : "refining" });
      const stream = await client.models.generateContentStream({
        model: CONTENT_MANAGER_MODEL,
        contents,
        config: {
          systemInstruction: CONTENT_MANAGER_SYSTEM_PROMPT,
          maxOutputTokens: 8192,
          thinkingConfig: {
            ...buildThinkingConfig(CONTENT_MANAGER_MODEL, "HIGH"),
            includeThoughts: true,
          },
          tools: [{ functionDeclarations: CONTENT_MANAGER_TOOLS }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
        },
      });

      const modelParts: any[] = [];
      const functionCalls: Array<{ name: string; args: Record<string, any> }> = [];
      let turnText = "";
      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought && part.text) {
            send(res, { type: "thought_delta", runId, content: part.text });
          } else if (part.functionCall?.name) {
            modelParts.push({ functionCall: part.functionCall });
            functionCalls.push({
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
          responseParts.push({ functionResponse: { name: call.name, response: { result: { ok: true } } } });
          continue;
        }
        if (call.name === "web_search") {
          const query = String(call.args?.query ?? "").trim();
          if (!query) {
            responseParts.push({ functionResponse: { name: call.name, response: { result: { error: "query is required" } } } });
            continue;
          }
          if (searchCount >= MAX_SEARCHES_PER_RUN) {
            responseParts.push({ functionResponse: { name: call.name, response: { result: { error: "Search budget reached. Use the notes you already have." } } } });
            continue;
          }
          if (!isTavilyConfigured()) {
            responseParts.push({ functionResponse: { name: call.name, response: { result: { error: "Web search is unavailable. Rely on the saved channel data." } } } });
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
            responseParts.push({ functionResponse: { name: call.name, response: { result: { notes: search.notes, sources: search.sources } } } });
          } catch (searchErr: any) {
            send(res, { type: "search_done", runId, query, count: 0 });
            responseParts.push({ functionResponse: { name: call.name, response: { result: { error: searchErr?.message ?? "Search failed" } } } });
          }
          continue;
        }
        responseParts.push({ functionResponse: { name: call.name, response: { result: { error: `Unknown tool: ${call.name}` } } } });
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
    const phase2Prompt = [
      context,
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
      const packStream = await client.models.generateContentStream({
        model: CONTENT_MANAGER_MODEL,
        contents: [{ role: "user", parts: [{ text: phase2Prompt }] }],
        config: {
          systemInstruction: CONTENT_MANAGER_SYSTEM_PROMPT,
          maxOutputTokens: 8192,
          thinkingConfig: {
            ...buildThinkingConfig(CONTENT_MANAGER_MODEL, "HIGH"),
            includeThoughts: true,
          },
          responseMimeType: "application/json",
          responseSchema: CONTENT_PACK_SCHEMA,
        },
      });
      for await (const chunk of packStream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought && part.text) {
            send(res, { type: "thought_delta", runId, content: part.text });
          } else if (part.text) {
            builtText += part.text;
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    let pack: ContentPack;
    try {
      pack = coerceContentPack(parseJson(builtText));
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
2. web_search(query) ONLY if the topic is time-sensitive (breaking news, a current event, "today"/"latest", a trending angle) or you are unsure of a fact. Skip it for evergreen/generic topics.
3. Write a SHORT (2-4 sentence) plain-language summary of your recommendation as normal text.
4. Then call request_content_pack() to hand off — the app builds the full structured pack for you. Do NOT write the titles/description/tags yourself in your text.

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

export default router;
