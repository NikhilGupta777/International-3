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
    description: `Generate a brand-new, scroll-stopping video thumbnail from scratch.

BEFORE writing the prompt, think through these 5 questions in your reasoning:
1. EMOTION: What single emotion should hit the viewer in 0.3 seconds? (shock, curiosity, desire, FOMO, awe, humor)
2. SUBJECT: Who/what is the hero? What EXACT expression or pose? (be very specific — "jaw dropped, eyes wide, both hands on cheeks" not "surprised")
3. HEADLINE TEXT: What 2–4 bold words go on the image? (skip text entirely if a clean visual is stronger)
4. COMPOSITION: Where does the subject sit in the frame? What fills the negative space?
5. COLORS: What 2–3 saturated dominant colors create instant contrast?

PROMPT FORMAT — always structure like this:
"Photorealistic YouTube thumbnail. [Subject with hyper-specific expression and pose]. [Composition: e.g. 'extreme close-up centered', 'subject on left third facing right', 'split-screen left vs right']. [Background description — specific, not generic]. [Lighting: e.g. 'dramatic cold rim light from behind', 'vibrant neon glow', 'cinematic god rays from above', 'deep studio black with spotlight']. [Color palette: 2–3 dominant saturated colors]. [If text: Bold [color] text reading '[EXACT WORDS]' [position: top/bottom/right], large, thick stroke, drop shadow]. Ultra-high contrast. Hyper-detailed. Scroll-stopping at thumbnail size."

NEVER pass the user's raw sentence as the prompt — always rewrite into the format above.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description:
            "The full image prompt YOU write, following the format: photorealistic YouTube thumbnail → specific subject + expression → composition → background → lighting → color palette → optional bold text with exact words → quality closers (ultra-high contrast, hyper-detailed). " +
            "Example: \"Photorealistic YouTube thumbnail. Indian man in his 30s, mouth wide open in shock, pointing directly at camera with both hands, wearing a white kurta. Extreme close-up, centered, filling 70% of frame. Deep black background with subtle red vignette at edges. Dramatic cold blue rim light from behind, warm key light on face. Dominant colors: deep black, electric blue, crimson red. Bold white text at top: 'यह सच है?' in large Devanagari, thick black stroke, drop shadow. Ultra-high contrast. Hyper-detailed. Cinematic quality.\"",
        },
        aspectRatio: {
          type: Type.STRING,
          description: "Output ratio: '16:9' (YouTube standard, default), '9:16' (Shorts/Reels/TikTok), '1:1' (Instagram square), '4:5' (Instagram portrait). Default '16:9'.",
        },
        imageSize: { type: Type.STRING, description: "'2K' (default, best quality) or '1K'." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_thumbnail",
    description: `Edit, refine, or combine the user's attached reference images into a finished thumbnail.
The model receives ALL attached images (up to 10) and your instructions.

CRITICAL — describe the DESIRED FINAL OUTPUT STATE, not just the delta change:
❌ WEAK: "Make the background red and add text"
✅ STRONG: "YouTube thumbnail: same subject in center with exact same face and outfit, now on a solid deep crimson red background. Bold white text at top reading 'BIG NEWS', large, thick black stroke. High-contrast studio lighting. Scroll-stopping quality."

When combining multiple images (face photo + background + logo):
- Be explicit: "Take the face from image 1, place it on the left third against the background from image 2, add the logo from image 3 at top-right corner"
- Describe the final composition, lighting, colors, and any text

Always preserve faces/identities unless the user explicitly asks to change them.
Describe specific lighting for the final image — don't leave it implicit.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        instructions: {
          type: Type.STRING,
          description:
            "A full description of the desired final thumbnail state. Cover: what to preserve (faces, key elements), what to change, composition, background, lighting, colors, and any text with exact wording. Describe the output, not just the edit steps.",
        },
        aspectRatio: {
          type: Type.STRING,
          description: "Output ratio override if needed: '16:9', '9:16', '1:1', '4:5'.",
        },
      },
      required: ["instructions"],
    },
  },
];

const THUMB_SYSTEM_PROMPT = `You are Thumbnail Studio — a dedicated AI thumbnail designer built into a video-production app. You are world-class at this one job.

YOUR ONLY JOB: Help users create stunning, scroll-stopping video thumbnails for YouTube, Shorts, Reels, podcasts, and courses. You do not download videos, cut clips, transcribe, or translate — if asked, tell them that feature lives in another tab.

━━━ HOW TO THINK ABOUT THUMBNAILS ━━━
The best thumbnails work because of psychology, not just looks:
• PATTERN INTERRUPT: Something unexpected that stops the scroll in 0.3 seconds
• EMOTION FIRST: A face with an extreme, readable expression beats any graphic
• CURIOSITY GAP: The thumbnail raises a question the video answers
• CONTRAST: One bold color against a contrasting background, not a busy mix
• SIMPLICITY: One hero, one headline, one message — complexity kills at small size

━━━ WRITING THE IMAGE PROMPT ━━━
YOU are the prompt engineer — the image model needs a precise visual spec, not a concept.

Always structure your prompt in this order:
1. "Photorealistic YouTube thumbnail." (sets the model's output mode)
2. Subject: who/what, with hyper-specific expression ("jaw dropped, hands on cheeks, eyes wide" — NOT "shocked")
3. Composition: camera angle + subject placement ("extreme close-up", "subject left third facing right", "split-screen")
4. Background: specific, not generic ("deep charcoal with red vignette" not "dark background")
5. Lighting: name it explicitly ("cold blue rim light", "neon glow from below", "cinematic god rays", "warm golden spotlight")
6. Color palette: 2–3 dominant saturated colors
7. Text (only if it adds punch): Bold [color] text reading '[EXACT WORDS IN QUOTES]' [position], large, thick stroke, drop shadow
8. Close with: "Ultra-high contrast. Hyper-detailed. Scroll-stopping at thumbnail size."

For EDITING: Describe the DESIRED FINAL STATE of the image, not just the change. "YouTube thumbnail with the same person, now against a deep red background, bold white text 'SHOCKING' at top" beats "change background to red and add text".

━━━ TOOL SELECTION ━━━
• User attached image(s) → edit_thumbnail (always, even for minor tweaks)
• User wants to adjust a result from this conversation → edit_thumbnail
• Fresh generation, no reference image → generate_thumbnail
• Second turn, no prior result, user says "change X" → generate_thumbnail, incorporate the change into a new full prompt
• Showing 2 strong options (different color directions, different text) → call generate_thumbnail twice; never generate near-identical variants

━━━ RESPONSE STYLE ━━━
• Think freely in the reasoning panel — explore the concept, composition, headline options, color ideas
• In your VISIBLE reply: NO narration before tool calls ("Sure, creating it now..." = banned)
• After the image is delivered: ONE short line max (~14 words) offering the most useful next direction, e.g. "Bold take — want darker colors or a Hindi headline instead?"
• Only write more when asking a genuine clarifying question (and NOT generating in the same turn)
• Never paste raw S3/image URLs — the image renders as a card automatically

━━━ PLATFORM RATIOS ━━━
• YouTube standard → 16:9 (default)
• YouTube Shorts / Instagram Reels / TikTok → 9:16
• Instagram square / podcast cover → 1:1
• Instagram portrait → 4:5

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
        // Brand preset: build a rich style directive and embed it in the text
        // prompt. We intentionally do NOT pass the preset reference images to
        // the image model here — gemini-3.1-flash-image-preview interprets
        // images in the input as "images to edit/transform", so passing 5-12
        // reference thumbnails would cause it to blend/composite those images
        // instead of generating something fresh in their visual style.
        // The style brief text is the reliable channel for style guidance.
        // Append quality closers if the prompt doesn't already have them,
        // and inject any active brand preset style as a text directive.
        const qualityCloser = "Ultra-high contrast. Hyper-detailed, cinematic quality. Scroll-stopping at small thumbnail size. No watermarks, no borders.";
        const presetDirective = activePreset
          ? `\n\nBRAND CHANNEL STYLE — apply the visual identity of "${activePreset.name}": ` +
            `${activePreset.stylePrompt ? activePreset.stylePrompt.trim() + " " : ""}` +
            `Match the channel's color grading, layout rhythm, font feel, and overall mood. Generate a fresh, original image — do NOT reproduce existing subjects.`
          : "";
        const styledPrompt = `${prompt}\n\n${qualityCloser}${presetDirective}`;
        const out = await renderThumbnail({
          prompt: styledPrompt,
          aspectRatio: args.aspectRatio,
          imageSize: args.imageSize,
          // No baseImages for fresh generation — style is in the text prompt.
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
        // Pass only the actual edit target image(s) — NOT the preset reference
        // images. The image model interprets every image it receives as a
        // candidate to edit, so mixing edit targets with style references
        // (12+ thumbnails) causes blending artifacts and unpredictable results.
        // The channel style is communicated reliably via text in styleNote.
        const presetStyleNote = activePreset
          ? ` Apply the brand identity of "${activePreset.name}": ` +
            `${activePreset.stylePrompt ? activePreset.stylePrompt.trim() + " " : ""}` +
            `Match that channel's color grading, layout feel, and mood in the output.`
          : "";
        const editPrefix = base.length > 1
          ? `Create a YouTube thumbnail by combining the ${base.length} provided reference images. `
          : `Create a YouTube thumbnail based on this image. `;
        const out = await renderThumbnail({
          prompt:
            editPrefix +
            instructions +
            `. Preserve all faces and identities exactly — do not alter facial features or skin tone.` +
            ` Output must be high-contrast and instantly readable at small thumbnail sizes.` +
            presetStyleNote +
            ` No watermarks, no borders, no image artifacts.`,
          aspectRatio: args.aspectRatio,
          baseImages: base,   // edit targets only; style via text above
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
        `The user has selected this channel's brand preset. Every thumbnail you generate or edit this turn MUST follow its visual identity. ` +
        `${activePreset.stylePrompt ? `Channel style brief: ${activePreset.stylePrompt}\n` : ""}` +
        `When you call generate_thumbnail or edit_thumbnail, the brand style brief is automatically injected into the image prompt for you. ` +
        `You still need to craft a strong concept/composition prompt — the brand layer is added on top. ` +
        `Do not mention the preset or brand by name in your visible reply unless the user asks.`
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
