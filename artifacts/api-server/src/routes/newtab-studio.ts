import { Router } from "express";
import { randomUUID } from "crypto";
import { Type } from "@google/genai";
import { setupSse, sseFlush } from "../lib/sse";
import { deriveWorkspaceIdentity } from "../lib/workspace";
import { streamNewTabModel } from "../lib/newtab-models";
import { createOrReuseChatProject, runProjectIntake } from "../lib/newtab-project-agent";

const router = Router();

// ── Config ─────────────────────────────────────────────────────────────────────

const MAX_HISTORY_TURNS = 60;
const MAX_TEXT_CHARS = 24_000;
const MAX_INLINE_TEXT_CHARS = 100_000;
const MAX_ATTACHMENTS = 6;
/** Body parser is capped at 10mb (app.ts), so keep decoded media well under it. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 8000;
const MAX_AGENT_ITERATIONS = 3;

const SYSTEM_PROMPT = `You are the real conversational AI inside New Tab Video Studio.

Talk naturally and help the user shape a complete video-production request. Understand the work across multiple turns. Ask only useful missing questions. Never create a project immediately from a greeting, question, idea, or first incomplete instruction.

Before creation, write a concise but complete PROJECT BRIEF containing every relevant detail you learned: source links/files, requested clips or discovery strategy, timestamps, target channel/profile, logo and branding, aspect ratio, captions and language, editing style, thumbnails, outputs, and assumptions. Then end with this exact standalone sentence:

Reply APPROVE to create this project.

Only after the user replies APPROVE and the create_project tool is available may you call it. Put every understood detail into the tool arguments. Do not omit information just because it is present earlier in chat. Do not claim work has started until the tool succeeds. After success, briefly confirm the project ID shown by the interface. Reply in the user's language, except keep the approval word APPROVE exactly as written.`;

const CREATE_PROJECT_TOOL = {
  name: "create_project",
  description: "Create or update the fully approved video project and hand the complete brief to Project AI. Call only after explicit APPROVE.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      goal: { type: Type.STRING },
      sourceUrls: { type: Type.ARRAY, items: { type: Type.STRING } },
      channelName: { type: Type.STRING },
      channelProfileId: { type: Type.STRING },
      editStyle: { type: Type.STRING },
      aspectRatio: { type: Type.STRING, enum: ["16:9", "9:16", "1:1", "original"] },
      burnCaptions: { type: Type.BOOLEAN },
      captionLanguage: { type: Type.STRING },
      requirements: { type: Type.STRING, description: "Complete self-contained handoff including clips, timestamps, branding, logo, thumbnail, output and assumptions." },
    },
    required: ["title", "goal", "sourceUrls", "requirements"],
  },
};

// ── Types ──────────────────────────────────────────────────────────────────────

type IncomingAttachment = {
  name?: unknown;
  type?: unknown;
  mimeType?: unknown;
  data?: unknown;
};

type PreparedAttachment =
  | { kind: "text"; name: string; text: string }
  | { kind: "media"; name: string; mimeType: string; data: string };

// ── Helpers ────────────────────────────────────────────────────────────────────

function send(res: any, payload: object): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
}

function normalizeAiError(err: any): string {
  const raw = String(err?.message ?? err ?? "The assistant failed to respond");
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const message = String(parsed?.error?.message ?? parsed?.message ?? "").trim();
      if (/internal error encountered/i.test(message)) {
        return "The AI provider hit a temporary internal error. Please retry.";
      }
      if (message) return message;
    } catch {
      // fall through
    }
  }
  if (/internal error encountered|status.+internal|code.+500/i.test(raw)) {
    return "The AI provider hit a temporary internal error. Please retry.";
  }
  return raw.trim() || "The assistant failed to respond";
}

/**
 * Text attachments become Project AI context. Media is represented by metadata here;
 * the project worker owns durable media ingestion and execution.
 */
function isTextLikeAttachment(mimeType: string, name: string): boolean {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/x-subrip") return true;
  return /\.(txt|srt|vtt|json|csv|md|log)$/i.test(name);
}

function prepareAttachments(raw: unknown): { attachments: PreparedAttachment[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { attachments: [], errors };

  const attachments: PreparedAttachment[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS) as IncomingAttachment[]) {
    const name = String(item?.name ?? "attachment").slice(0, 200);
    const mimeType = String(item?.mimeType ?? "").trim() || "application/octet-stream";
    const data = typeof item?.data === "string" ? item.data : "";
    if (!data) {
      errors.push(`${name}: empty file, skipped`);
      continue;
    }
    // base64 length -> decoded byte count, without allocating the buffer first.
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((data.length * 3) / 4) - padding;
    if (bytes > MAX_ATTACHMENT_BYTES) {
      errors.push(`${name}: larger than 5MB, skipped`);
      continue;
    }

    if (isTextLikeAttachment(mimeType, name)) {
      let text = "";
      try {
        text = Buffer.from(data, "base64").toString("utf8");
      } catch {
        errors.push(`${name}: could not be decoded, skipped`);
        continue;
      }
      attachments.push({ kind: "text", name, text: text.slice(0, MAX_INLINE_TEXT_CHARS) });
      continue;
    }

    attachments.push({ kind: "media", name, mimeType, data });
  }

  if (Array.isArray(raw) && raw.length > MAX_ATTACHMENTS) {
    errors.push(`Only the first ${MAX_ATTACHMENTS} attachments were used.`);
  }
  return { attachments, errors };
}

type NormalizedTurn = { role: "user" | "model"; text: string };

function normalizeHistory(raw: unknown): NormalizedTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: NormalizedTurn[] = [];
  for (const message of raw) {
    const role = (message as any)?.role === "assistant" || (message as any)?.role === "model" ? "model" : "user";
    const parts = Array.isArray((message as any)?.parts) ? (message as any).parts : [];
    const text = parts
      .map((part: any) => String(part?.text ?? ""))
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) continue;
    turns.push({ role, text });
  }
  // Gemini rejects a leading model turn; drop any until the first user message.
  while (turns.length > 0 && turns[0]!.role === "model") turns.shift();
  return turns.slice(-MAX_HISTORY_TURNS);
}

// ── Route ──────────────────────────────────────────────────────────────────────

router.post("/newtab-studio/chat", async (req, res) => {
  const runId = randomUUID();

  const history = normalizeHistory((req.body ?? {})?.messages);
  if (history.length === 0) {
    res.status(400).json({ error: "messages is required and must contain at least one user message." });
    return;
  }
  if (history[history.length - 1]!.role !== "user") {
    res.status(400).json({ error: "The last message must be from the user." });
    return;
  }
  const sessionId = String((req.body ?? {})?.sessionId ?? "").trim().slice(0, 128) || `newtab-${runId}`;
  const requestText = history[history.length - 1]!.text;
  const { attachments, errors: attachmentErrors } = prepareAttachments((req.body ?? {})?.attachments);
  const attachmentContext = attachments.map((attachment) => attachment.kind === "text"
    ? `Attached file (${attachment.name}):\n${attachment.text}`
    : `Attached media: ${attachment.name} (${attachment.mimeType})`).join("\n\n");
  const fullContext = [
    history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`).join("\n\n"),
    attachmentContext,
    attachmentErrors.length ? `Attachment notices: ${attachmentErrors.join("; ")}` : "",
  ].filter(Boolean).join("\n\n");
  let heartbeat: NodeJS.Timeout | null = null;

  const finish = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (!res.writableEnded) res.end();
  };

  setupSse(res);
  // res.on("close") — not req.on("close"), which fires as soon as the body is read.
  res.on("close", () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });
  heartbeat = setInterval(() => send(res, { type: "heartbeat" }), HEARTBEAT_MS);

  try {
    const previousAssistant = [...history].reverse().find((turn) => turn.role === "model")?.text ?? "";
    const approvalGranted = /^\s*APPROVE\s*[.!]?\s*$/i.test(requestText)
      && /Reply APPROVE to create this project\./i.test(previousAssistant);
    const contents: any[] = history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }));
    if (attachmentContext) contents[contents.length - 1]!.parts.push({ text: `\n\n${attachmentContext}` });

    send(res, { type: "run_start", runId });
    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
      send(res, { type: "thinking", stage: iteration === 0 ? "understanding" : "continuing" });
      const stream = streamNewTabModel({
        contents,
        systemInstruction: SYSTEM_PROMPT,
        tools: approvalGranted ? [{ functionDeclarations: [CREATE_PROJECT_TOOL] }] : [],
      });
      const modelParts: any[] = [];
      const calls: Array<{ id: string; name: string; args: Record<string, any> }> = [];

      for await (const chunk of stream) {
        for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
          if (part?.thought && part?.text) {
            send(res, { type: "thought_delta", content: part.text });
          } else if (part?.functionCall?.name) {
            const id = `${runId}-${iteration}-${calls.length}`;
            modelParts.push({ functionCall: part.functionCall });
            calls.push({ id, name: part.functionCall.name, args: part.functionCall.args ?? {} });
          } else if (part?.text) {
            modelParts.push({ text: part.text });
            send(res, { type: "text_delta", content: part.text });
          }
        }
      }

      if (calls.length === 0) break;
      contents.push({ role: "model", parts: modelParts });
      const responseParts: any[] = [];

      for (const call of calls) {
        send(res, { type: "tool_start", toolId: call.id, name: call.name, args: call.args });
        if (call.name !== "create_project" || !approvalGranted) {
          const result = { error: "Project creation requires the explicit approval step." };
          send(res, { type: "tool_done", toolId: call.id, name: call.name, result });
          responseParts.push({ functionResponse: { name: call.name, response: { result } } });
          continue;
        }

        const owner = deriveWorkspaceIdentity(req).workspaceId;
        const args = call.args as {
          title?: string; goal?: string; sourceUrls?: string[]; channelName?: string;
          channelProfileId?: string; editStyle?: string; aspectRatio?: "16:9" | "9:16" | "1:1" | "original";
          burnCaptions?: boolean; captionLanguage?: string; requirements?: string;
        };
        const handoff = await createOrReuseChatProject({
          owner,
          sessionId,
          requestText,
          fullContext,
          approvedBrief: args,
        });
        const result = { ok: true, projectId: handoff.project.projectId, title: handoff.project.title, created: handoff.created };
        send(res, { type: "tool_done", toolId: call.id, name: call.name, result });
        send(res, {
          type: "project_created",
          projectId: handoff.project.projectId,
          title: handoff.project.title,
          status: "planning",
          created: handoff.created,
        });
        responseParts.push({ functionResponse: { name: call.name, response: { result } } });
        setImmediate(() => { void runProjectIntake(handoff.project.projectId, owner); });
      }

      contents.push({ role: "user", parts: responseParts });
    }

    send(res, { type: "done" });
    finish();
  } catch (error) {
    send(res, { type: "error", message: normalizeAiError(error) });
    finish();
    return;
  }

});

export default router;
