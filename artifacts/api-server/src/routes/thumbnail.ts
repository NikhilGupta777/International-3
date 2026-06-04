/**
 * Thumbnail Studio Agent — standalone, self-contained.
 *
 * Completely independent from the Super Agent (/api/agent/chat). It does NOT
 * share that route's tools, system prompt, artifact schema, or helpers.
 *
 * POST /api/thumbnail/chat   — SSE conversational thumbnail designer
 *   • Chat model:  gemini-3.5-flash      (MEDIUM thinking)
 *   • Image model: gemini-3.1-flash-image-preview
 *
 * SSE events emitted by THIS route only:
 *   ready | think | thought | text | thumb_start | thumb_progress | thumb_done | error | done
 */

import { Router } from "express";
import { Modality, Type } from "@google/genai";
import { randomUUID } from "crypto";
import { setupSse, sseFlush } from "../lib/sse";
import {
  createS3PresignedUpload,
  getS3SignedDownloadUrl,
  isS3StorageEnabled,
} from "../lib/s3-storage";
import {
  createGeminiClient,
  isGeminiConfigured,
  ensureVertexCredentials,
} from "../lib/gemini-client";
import {
  isPresetStoreEnabled,
  listPresetsForOwner,
  upsertPreset,
  deletePresetForOwner,
  loadPresetImages,
  PRESET_MAX_IMAGES,
  PRESET_MIN_IMAGES,
  PRESET_STYLE_PROMPT_MAX_CHARS,
  SHARED_PRESET_OWNER,
  readPresetImageAt,
  type PresetImageInput,
} from "../lib/thumbnail-preset-store";

const router = Router();

// ── Models (independent env knobs so they never collide with the Super Agent) ──
const THUMB_CHAT_MODEL = process.env.THUMBNAIL_CHAT_MODEL ?? "gemini-3.5-flash";
const THUMB_IMAGE_MODEL = process.env.THUMBNAIL_IMAGE_MODEL ?? "gemini-3.1-flash-image-preview";
const THUMB_MAX_ITERATIONS = Number.parseInt(process.env.THUMBNAIL_MAX_ITERATIONS ?? "8", 10) || 8;
const THUMB_MAX_OUTPUT_TOKENS = Number.parseInt(process.env.THUMBNAIL_MAX_OUTPUT_TOKENS ?? "8192", 10) || 8192;
const MAX_HISTORY = 40;

const VALID_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const VALID_SIZES = new Set(["1K", "2K", "4K"]);

// ── SSE writer ────────────────────────────────────────────────────────────
function send(res: any, payload: object) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
}

// Strip any internal markers the chat model might leak.
function cleanText(text: string): string {
  return text
    .replace(/\[(?:REASONING|THOUGHT)\][\s\S]*?\[\/(?:REASONING|THOUGHT)\]/gi, "")
    .replace(/\[\/?RESPONSE\]/gi, "")
    .replace(/^\[(?:PLAN|EXECUTE|TOOL|SAY)\].*$/gim, "")
    .replace(/https?:\/\/[^\s"]*\.s3[^\s"]*(?:X-Amz-[^\s"]*)+/gi, "the image above")
    .replace(/\n{3,}/g, "\n\n");
}

// ── Image publishing (data URL fallback if S3 disabled) ─────────────────────
function imageExt(mimeType: string): string {
  return mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
}

async function publishThumbnail(data: string, mimeType: string): Promise<{ imageUrl: string; filename: string }> {
  const filename = `thumbnail-${Date.now()}.${imageExt(mimeType)}`;
  if (!isS3StorageEnabled()) {
    return { imageUrl: `data:${mimeType};base64,${data}`, filename };
  }
  const upload = await createS3PresignedUpload({
    jobId: randomUUID(),
    namespace: "thumbnail-studio",
    filename,
    contentType: mimeType,
  });
  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: Buffer.from(data, "base64"),
  });
  if (!put.ok) throw new Error(`Thumbnail upload failed: ${put.status}`);
  const imageUrl = await getS3SignedDownloadUrl({
    key: upload.key,
    filename: upload.filename,
    expiresInSec: 7 * 24 * 60 * 60,
  });
  return { imageUrl, filename: upload.filename };
}

// ── Image generation via gemini-3.1-flash-image-preview ─────────────────────
async function renderThumbnail(params: {
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  baseImages?: Array<{ data: string; mimeType: string }>;
}): Promise<{ imageUrl: string; filename: string; note: string; data: string; mimeType: string }> {
  const ai = createGeminiClient();
  const parts: any[] = [{ text: params.prompt }];
  for (const img of params.baseImages ?? []) {
    if (img?.data) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  const aspectRatio = params.aspectRatio && VALID_RATIOS.has(params.aspectRatio) ? params.aspectRatio : "16:9";
  const imageSize = params.imageSize && VALID_SIZES.has(params.imageSize) ? params.imageSize : "2K";

  const resp = await ai.models.generateContent({
    model: THUMB_IMAGE_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE] as any,
      responseFormat: { image: { aspectRatio, imageSize } },
    },
  } as any);

  let note = "";
  for (const part of resp.candidates?.[0]?.content?.parts ?? []) {
    if (part.text) note += part.text;
    const imageData = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType ?? "image/png";
    if (imageData) {
      const published = await publishThumbnail(imageData, mimeType);
      return { ...published, note: cleanText(note).trim(), data: imageData, mimeType };
    }
  }
  throw new Error("The image model returned no image. Try rephrasing the idea.");
}

// ── Tools the thumbnail agent can call ──────────────────────────────────────
const THUMB_TOOLS: any[] = [
  {
    name: "generate_thumbnail",
    description:
      "Render a brand-new thumbnail image from a fully-crafted visual prompt. " +
      "Before calling, deeply understand the user's video, audience, and the emotion the thumbnail must trigger. " +
      "Then write a rich, production-quality prompt yourself: subject & expression, composition, focal point, " +
      "background, lighting, color palette, depth, any large bold headline text (give exact words), and overall mood. " +
      "Thumbnails must be high-contrast, readable at small sizes, and scroll-stopping. Never pass the user's raw text as the prompt.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description:
            "A complete, detailed image-generation prompt YOU craft. Include subject/expression, composition, " +
            "focal point, background, lighting, color palette, and any on-image headline text with exact wording.",
        },
        aspectRatio: {
          type: Type.STRING,
          description:
            "One of: '16:9' (YouTube), '9:16' (Shorts/Reels), '1:1' (square), '4:3', '4:5'. Default '16:9'.",
        },
        imageSize: { type: Type.STRING, description: "'1K' or '2K'. Default '2K'." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_thumbnail",
    description:
      "Edit/refine the most recent reference image(s) the user attached (they may attach up to 10 — use them all, e.g. combine a face + a logo + a background), " +
      "OR iterate on a previously generated thumbnail. " +
      "Craft a precise editing instruction: what to change, what to preserve, the desired style/colors/mood. " +
      "Use this when the user says things like 'make the text bigger', 'change background to red', 'add my face here', 'combine these'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instructions: {
          type: Type.STRING,
          description:
            "A precise editing prompt YOU craft from the user's intent: exactly what to change, what to keep, and the target look.",
        },
        aspectRatio: {
          type: Type.STRING,
          description: "Optional output ratio override: '16:9', '9:16', '1:1', '4:3', '4:5'.",
        },
      },
      required: ["instructions"],
    },
  },
];

const THUMB_SYSTEM_PROMPT = `You are Thumbnail Studio — a focused, expert AI thumbnail designer living in its own tab inside a video-production app.

Your ONLY job is to help the user design and generate stunning video thumbnails (YouTube, Shorts, Reels, podcasts, courses). You do not download videos, cut clips, transcribe, or translate — if asked, briefly say that lives in another tab and steer back to thumbnails.

HOW YOU WORK:
- Be warm, fast, and concise. Talk like a sharp creative director, not a form.
- If the user's idea is already clear enough, generate immediately — do not interrogate them.
- If something essential is genuinely missing (e.g. the topic is very vague), ask ONE short clarifying question, then proceed.
- YOU are the prompt engineer. Never feed the user's raw words to the image tool. Translate intent into a rich, concrete visual prompt: subject & facial expression, composition, focal point, background, lighting, color palette, depth, and any large bold headline text (give the exact words — keep them short, 2–5 punchy words max).
- Thumbnails must be high-contrast, emotionally charged, and instantly readable at small sizes.
- Default to 16:9 unless the user mentions Shorts/Reels (9:16) or a square/post (1:1).

TOOL SELECTION — CRITICAL:
- If the user attaches one or more reference images (face, logo, background, etc.) → always use edit_thumbnail.
- If the user asks to tweak/change/adjust a result from THIS conversation → use edit_thumbnail.
- If the user is requesting a fresh thumbnail without attached images and no prior result to edit → use generate_thumbnail.
- If the conversation has NO prior generated thumbnail and the user says "make it bigger / change the color / etc." → use generate_thumbnail and fully incorporate all requested changes into the new prompt — do NOT call edit_thumbnail without a reference.
- You may generate 1–2 strong options when it genuinely helps (e.g. "I'll show you two color directions"); never spam near-identical images.

PACING & VISIBLE TEXT:
- Your private reasoning (the "thinking" you do before acting) is shown to the user in a separate, collapsible thinking panel — so think freely and naturally there about the concept, composition, mood, and headline.
- In your VISIBLE reply, do NOT narrate before a tool call ("Sure, let me create..."). Just think, then call the tool. The UI shows a live generation animation.
- AFTER the image is delivered, reply with ONE short, friendly line only (max ~14 words), e.g. "Bold take — want a punchier headline or a different color scheme?"
- Only write a longer visible message when you are genuinely asking a clarifying question and NOT generating in the same turn.
- Never paste raw image URLs — the image appears as a card automatically.

Always reply in the user's language.`;

// ── Collect all images attached in the most recent user message (up to 10) ──
function latestAttachedImages(messages: any[]): Array<{ data: string; mimeType: string }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const atts = Array.isArray(messages[i]?.attachments) ? messages[i].attachments : [];
    const imgs = atts
      .filter((a: any) => a?.type === "image" && a?.data && a?.mimeType)
      .slice(0, 10)
      .map((a: any) => ({ data: String(a.data), mimeType: String(a.mimeType) }));
    if (imgs.length > 0) return imgs;
  }
  return [];
}

// ── POST /api/thumbnail/chat ────────────────────────────────────────────────
router.post("/thumbnail/chat", async (req, res) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "Thumbnail Studio is not configured — add Vertex Gemini env or GEMINI_API_KEY." });
    return;
  }
  try { await ensureVertexCredentials(); } catch { /* env-key based — non-fatal */ }

  const { messages = [], presetId } = req.body as {
    messages: Array<{
      role: "user" | "model";
      content?: string;
      attachments?: Array<{ type: string; name?: string; mimeType?: string; data?: string }>;
    }>;
    // Optional brand preset id — server loads the channel's style prompt and
    // reference images from the preset store and applies them this turn.
    presetId?: string;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  // Resolve the brand preset (if any) — presets are shared/global.
  let activePreset: { name: string; stylePrompt: string; images: Array<{ data: string; mimeType: string }> } | null = null;
  if (presetId) {
    try {
      activePreset = await loadPresetImages(String(presetId), SHARED_PRESET_OWNER);
    } catch { activePreset = null; }
  }

  const history = messages.slice(-MAX_HISTORY);

  setupSse(res);
  let connected = true;
  let completed = false;
  res.on("close", () => { connected = false; });
  const isConnected = () => connected && !res.writableEnded;

  const runId = randomUUID();
  send(res, { type: "ready", runId, model: THUMB_CHAT_MODEL });

  const keepAlive = setInterval(() => {
    if (isConnected()) send(res, { type: "think", runId, beat: true });
  }, 8000);

  // Track the most recently generated thumbnail so edit_thumbnail can iterate on it.
  let lastGenerated: { data: string; mimeType: string } | null = null;

  // Execute a single tool call.
  async function execTool(name: string, args: Record<string, any>): Promise<any> {
    if (name === "generate_thumbnail") {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { error: "Empty prompt" };
      const toolId = randomUUID().slice(0, 8);
      send(res, { type: "thumb_start", runId, toolId, mode: "generate" });
      send(res, { type: "thumb_progress", runId, toolId, message: "Designing your thumbnail…" });
      try {
        // Brand preset: prepend the channel style brief and feed reference
        // images to the image model so output matches the channel's look.
        const presetImgs = activePreset?.images ?? [];
        const styledPrompt = activePreset
          ? `${prompt}\n\nBRAND STYLE — match the channel "${activePreset.name}". ` +
            `${activePreset.stylePrompt ? activePreset.stylePrompt + " " : ""}` +
            `Use the ${presetImgs.length} attached reference thumbnails ONLY as a style guide ` +
            `(layout, color grading, font feel, mood, framing) — do NOT copy their exact subjects unless asked.`
          : prompt;
        const out = await renderThumbnail({
          prompt: styledPrompt,
          aspectRatio: args.aspectRatio,
          imageSize: args.imageSize,
          baseImages: presetImgs.length > 0 ? presetImgs : undefined,
        });
        lastGenerated = { data: out.data, mimeType: out.mimeType };
        send(res, { type: "thumb_done", runId, toolId, imageUrl: out.imageUrl, filename: out.filename, note: out.note });
        return { ok: true, filename: out.filename, note: out.note || "Thumbnail generated." };
      } catch (err: any) {
        send(res, { type: "thumb_progress", runId, toolId, status: "error", message: err?.message ?? "Failed" });
        return { error: err?.message ?? "Generation failed" };
      }
    }

    if (name === "edit_thumbnail") {
      const instructions = String(args.instructions ?? "").trim();
      if (!instructions) return { error: "Empty instructions" };
      const attached = latestAttachedImages(history);
      const base = attached.length > 0 ? attached : (lastGenerated ? [lastGenerated] : []);
      // When there's nothing to edit (multi-turn conversation where the prior
      // generated image isn't stored client-side), fall back to generate_thumbnail
      // so the model gets a real result instead of a confusing error card.
      if (base.length === 0) {
        return execTool("generate_thumbnail", {
          prompt: instructions,
          aspectRatio: args.aspectRatio,
        });
      }
      const toolId = randomUUID().slice(0, 8);
      send(res, { type: "thumb_start", runId, toolId, mode: "edit" });
      send(res, { type: "thumb_progress", runId, toolId, message: "Editing the image…" });
      try {
        // Reference images = the image(s) being edited first, then any preset
        // style references appended after them.
        const presetImgs = activePreset?.images ?? [];
        const styleNote = activePreset
          ? ` Match the channel "${activePreset.name}" brand style.` +
            `${activePreset.stylePrompt ? " " + activePreset.stylePrompt : ""}` +
            (presetImgs.length ? ` The last ${presetImgs.length} attached images are brand style references, not edit targets.` : "")
          : "";
        const out = await renderThumbnail({
          prompt:
            (base.length > 1
              ? `Combine/use the ${base.length} provided images to create one video thumbnail. ${instructions}. `
              : `Edit this image as a video thumbnail. ${instructions}. `) +
            `Preserve the important subjects and any faces. Keep it high-contrast and readable at small sizes.` +
            styleNote,
          aspectRatio: args.aspectRatio,
          baseImages: [...base, ...presetImgs],
        });
        lastGenerated = { data: out.data, mimeType: out.mimeType };
        send(res, { type: "thumb_done", runId, toolId, imageUrl: out.imageUrl, filename: out.filename, note: out.note });
        return { ok: true, filename: out.filename, note: out.note || "Thumbnail edited." };
      } catch (err: any) {
        send(res, { type: "thumb_progress", runId, toolId, status: "error", message: err?.message ?? "Failed" });
        return { error: err?.message ?? "Edit failed" };
      }
    }

    return { error: `Unknown tool: ${name}` };
  }

  try {
    const ai = createGeminiClient();

    // When a brand preset is active, tell the chat model so it always routes
    // through the image tools (which inject the reference images + style).
    const presetSystemAddendum = activePreset
      ? `\n\nACTIVE BRAND PRESET: "${activePreset.name}".\n` +
        `The user has selected this channel preset. Every thumbnail you generate or edit this turn must follow its brand style. ` +
        `${activePreset.stylePrompt ? `Channel style brief: ${activePreset.stylePrompt}\n` : ""}` +
        `The image tool automatically receives this channel's reference thumbnails — you do NOT need to describe them. ` +
        `Just craft the concept prompt; the brand look is applied for you.`
      : "";

    // Build multimodal contents — images go in as inlineData so the model sees them.
    let contents: any[] = history
      .filter((m) => (m.content ?? "").trim() || (m.attachments && m.attachments.length > 0))
      .map((m) => {
        const parts: any[] = [];
        const text = (m.content ?? "").trim();
        if (text) parts.push({ text });
        for (const a of m.attachments ?? []) {
          if (a?.type === "image" && a?.data && a?.mimeType) {
            parts.push({ inlineData: { mimeType: a.mimeType, data: a.data } });
          }
        }
        if (parts.length === 0) parts.push({ text: "(image attached)" });
        return { role: m.role === "model" ? "model" : "user", parts };
      });

    let iterations = 0;
    while (iterations < THUMB_MAX_ITERATIONS && isConnected()) {
      iterations++;
      send(res, { type: "think", runId, stage: iterations === 1 ? "thinking" : "refining" });

      let stream: AsyncIterable<any> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 800));
          stream = await ai.models.generateContentStream({
            model: THUMB_CHAT_MODEL,
            contents,
            config: {
              systemInstruction: THUMB_SYSTEM_PROMPT + presetSystemAddendum,
              tools: [{ functionDeclarations: THUMB_TOOLS as any }],
              toolConfig: { functionCallingConfig: { mode: "AUTO" as any } },
              maxOutputTokens: THUMB_MAX_OUTPUT_TOKENS,
              thinkingConfig: { thinkingLevel: "MEDIUM" as any, includeThoughts: true },
            },
          });
          break;
        } catch (err: any) {
          if (attempt === 2) throw err;
        }
      }
      if (!stream || !isConnected()) break;

      let fullText = "";
      let streamed = false;
      const functionCalls: Array<{ id?: string; name: string; args: Record<string, any> }> = [];
      const rawFcParts: any[] = [];

      for await (const chunk of stream) {
        if (!isConnected()) break;
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          // Thought summaries (includeThoughts) — stream to the live thinking panel.
          if (p.thought && p.text) {
            send(res, { type: "thought", runId, content: p.text });
            continue;
          }
          if (p.text) {
            fullText += p.text;
            const delta = cleanText(p.text);
            if (delta) { send(res, { type: "text", runId, content: delta }); streamed = true; }
          }
          if (p.functionCall) {
            functionCalls.push({
              id: p.functionCall.id,
              name: p.functionCall.name!,
              args: (p.functionCall.args ?? {}) as Record<string, any>,
            });
            rawFcParts.push(p);
          }
        }
      }

      if (!isConnected()) break;

      // No tool calls → final answer, finish.
      if (functionCalls.length === 0) {
        if (!streamed && fullText.trim()) {
          send(res, { type: "text", runId, content: cleanText(fullText) });
        }
        break;
      }

      // Announce which tool is about to run so the UI can switch the live card
      // from "thinking" to the generation animation immediately.
      send(res, { type: "plan", runId, steps: functionCalls.map(fc => ({ tool: fc.name })) });

      // Execute tools (serially — image gen is heavy) and feed results back.
      const toolResponses: any[] = [];
      for (const fc of functionCalls) {
        if (!isConnected()) break;
        const result = await execTool(fc.name, fc.args);
        toolResponses.push({
          functionResponse: { id: fc.id, name: fc.name, response: { result } },
        });
      }

      const modelParts: any[] = [];
      if (fullText) modelParts.push({ text: fullText });
      for (const raw of rawFcParts) modelParts.push(raw);

      contents = [
        ...contents,
        { role: "model", parts: modelParts },
        { role: "user", parts: toolResponses },
      ];
    }

    if (iterations >= THUMB_MAX_ITERATIONS && isConnected()) {
      send(res, { type: "text", runId, content: "\n\n(Reached the step limit — ask me to continue if you need more tweaks.)" });
    }

    if (isConnected()) {
      completed = true;
      send(res, { type: "done", runId });
    }
  } catch (err: any) {
    if (isConnected()) {
      let msg = err?.message ?? "Thumbnail Studio hit an error.";
      try {
        const parsed = JSON.parse(msg);
        msg = String(parsed?.error?.message ?? parsed?.message ?? msg)
          .split(/\.?\s*Please refer to https?:\/\//)
          .shift()!
          .trim();
      } catch { /* not JSON */ }
      send(res, { type: "error", runId, message: msg || "Something went wrong — please try again." });
    }
  } finally {
    clearInterval(keepAlive);
    if (!completed && isConnected()) {
      try { send(res, { type: "done", runId }); } catch { /* ignore */ }
    }
    if (!res.writableEnded) res.end();
  }
});

// ── Brand preset CRUD ───────────────────────────────────────────────────────
// Presets are shared brand assets: everyone (signed in) can list + use them,
// signed-in users can create / edit / delete.
function ownerEmail(res: any): string {
  return (res.locals?.authSession as { email?: string } | undefined)?.email ?? "";
}
function canEditPresetsReq(res: any): boolean {
  const s = res.locals?.authSession as { authenticated?: boolean; role?: string } | undefined;
  return Boolean(s?.authenticated && ownerEmail(res));
}

// GET /api/thumbnail/presets — list shared presets (any signed-in user)
router.get("/thumbnail/presets", async (_req, res) => {
  const canEdit = canEditPresetsReq(res);
  if (!isPresetStoreEnabled()) {
    // Return empty list but still tell the frontend whether the user is an
    // admin (so the create UI is accessible — they can attempt to save and
    // get a clear "not configured" error then).
    res.json({ presets: [], enabled: false, canEdit });
    return;
  }
  try {
    const presets = await listPresetsForOwner(SHARED_PRESET_OWNER);
    res.json({ presets, enabled: true, canEdit });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to list presets" });
  }
});

// GET /api/thumbnail/presets/:id/images/:index - render a preset reference image.
router.get("/thumbnail/presets/:id/images/:index", async (req, res) => {
  if (!isPresetStoreEnabled()) { res.status(404).end(); return; }
  const index = Number.parseInt(String(req.params.index), 10);
  if (!Number.isInteger(index) || index < 0 || index >= PRESET_MAX_IMAGES) {
    res.status(400).json({ error: "Invalid image index." });
    return;
  }
  try {
    const image = await readPresetImageAt(String(req.params.id), SHARED_PRESET_OWNER, index);
    if (!image) { res.status(404).end(); return; }
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(image.filename)}"`);
    res.end(image.bytes);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to load preset image" });
  }
});

// POST /api/thumbnail/presets — create or update a preset (ADMIN ONLY)
router.post("/thumbnail/presets", async (req, res) => {
  if (!isPresetStoreEnabled()) {
    res.status(503).json({ error: "Preset storage is not configured (needs S3 + jobs table)." });
    return;
  }
  if (!ownerEmail(res)) { res.status(401).json({ error: "Sign in required." }); return; }

  const { id, name, stylePrompt = "", images = [] } = req.body as {
    id?: string;
    name?: string;
    stylePrompt?: string;
    images?: Array<{ mimeType?: string; data?: string; key?: string; filename?: string }>;
  };
  const cleanName = typeof name === "string" ? name : "";
  const cleanStylePrompt = typeof stylePrompt === "string" ? stylePrompt : "";

  const cleanImages: PresetImageInput[] = (Array.isArray(images) ? images : [])
    .filter((im) => (im?.data || im?.key) && typeof im?.mimeType === "string" && im.mimeType.startsWith("image/"))
    .slice(0, PRESET_MAX_IMAGES)
    .map((im) => ({
      data: im.data ? String(im.data) : undefined,
      key: im.key ? String(im.key) : undefined,
      mimeType: String(im.mimeType),
      filename: typeof im.filename === "string" ? im.filename : undefined,
    }));

  if (!cleanName.trim()) { res.status(400).json({ error: "Channel name is required." }); return; }
  if (cleanImages.length < PRESET_MIN_IMAGES) { res.status(400).json({ error: `Add at least ${PRESET_MIN_IMAGES} reference images.` }); return; }
  if (cleanStylePrompt.trim().length > PRESET_STYLE_PROMPT_MAX_CHARS) {
    res.status(400).json({ error: `Style brief must be ${PRESET_STYLE_PROMPT_MAX_CHARS} characters or less.` });
    return;
  }

  try {
    const rec = await upsertPreset({ id, owner: SHARED_PRESET_OWNER, name: cleanName, stylePrompt: cleanStylePrompt, images: cleanImages });
    res.json({ ok: true, id: rec.jobId, name: rec.name, imageCount: rec.images.length });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to save preset" });
  }
});

// DELETE /api/thumbnail/presets/:id — delete a preset (ADMIN ONLY)
router.delete("/thumbnail/presets/:id", async (req, res) => {
  if (!isPresetStoreEnabled()) { res.status(503).json({ error: "Preset storage is not configured." }); return; }
  if (!ownerEmail(res)) { res.status(401).json({ error: "Sign in required." }); return; }
  try {
    const ok = await deletePresetForOwner(String(req.params.id), SHARED_PRESET_OWNER);
    res.json({ ok });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to delete preset" });
  }
});

export default router;
