import {
  COPILOT_ULTRA_MODEL,
  COPILOT_FAST_MODEL,
  COPILOT_ULTRA_FALLBACK_MODEL,
  NVIDIA_NEMOTRON_ULTRA_MODEL,
  NVIDIA_NEMOTRON_SUPER_MODEL,
  isExternalCopilotConfigured,
  isExternalProviderRetryableError,
  streamExternalCopilot,
} from "./copilot-external-provider";

/**
 * Model stack for New Tab Studio — the chat *and* the project runner use this,
 * so both sides of the handoff run on the same models.
 *
 * One ladder, no user-facing modes. The first model that produces a token wins;
 * every other entry is a fallback. Two rules order and gate the ladder:
 *
 *   1. Models with an input limit above MIN_INPUT_LIMIT sort to the front, so a
 *      long transcript never lands on a small-context model.
 *   2. A model that hasn't produced its first token within FIRST_TOKEN_TIMEOUT_MS
 *      is abandoned and the next one is tried.
 *
 * These are text models: image/av attachments still route to Gemini (see
 * NEWTAB_VISION_MODEL) because the provider bridge stringifies inlineData.
 */

function envTrim(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(envTrim(name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Anything at or below this input limit gets pushed behind the big-context models. */
export const MIN_INPUT_LIMIT = envInt("NEWTAB_MIN_INPUT_LIMIT", 50_000);

/** A model gets this long to produce its first token before we move on. */
export const FIRST_TOKEN_TIMEOUT_MS = envInt("NEWTAB_FIRST_TOKEN_TIMEOUT_MS", 10_000);

export const NEWTAB_VISION_MODEL = envTrim("NEWTAB_STUDIO_VISION_MODEL") || "gemini-3.5-flash";

type ModelSpec = {
  model: string;
  /** Declared context window in tokens. Used only for ordering, never sent upstream. */
  inputLimit: number;
};

/**
 * Preference order within the large-context group. Override the head of the
 * ladder with NEWTAB_STUDIO_MODEL if you want a different primary.
 */
const MODEL_SPECS: ModelSpec[] = [
  { model: COPILOT_ULTRA_MODEL, inputLimit: 128_000 },          // mistral-small-latest (Mistral)
  { model: COPILOT_ULTRA_FALLBACK_MODEL, inputLimit: 128_000 }, // gpt-oss:120b (Ollama)
  { model: COPILOT_FAST_MODEL, inputLimit: 128_000 },           // mistral-small-latest (Mistral)
  { model: NVIDIA_NEMOTRON_ULTRA_MODEL, inputLimit: 128_000 },
  { model: NVIDIA_NEMOTRON_SUPER_MODEL, inputLimit: 128_000 },
  { model: "llama-3.1-8b-instant", inputLimit: 128_000 },       // Groq — last resort
];

/**
 * The ladder: configured models only, large-context first, primary override on top.
 * Sort is stable, so the hand-written preference order survives within each group.
 */
export function buildModelLadder(): string[] {
  const override = envTrim("NEWTAB_STUDIO_MODEL");
  const specs = [...MODEL_SPECS];

  if (override) {
    const existing = specs.findIndex((spec) => spec.model === override);
    const spec = existing >= 0 ? specs.splice(existing, 1)[0]! : { model: override, inputLimit: Number.MAX_SAFE_INTEGER };
    specs.unshift(spec);
  }

  const ordered = specs
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => {
      const aBig = a.spec.inputLimit > MIN_INPUT_LIMIT ? 0 : 1;
      const bBig = b.spec.inputLimit > MIN_INPUT_LIMIT ? 0 : 1;
      if (aBig !== bBig) return aBig - bBig;
      return a.index - b.index;
    })
    .map((entry) => entry.spec.model);

  const seen = new Set<string>();
  const usable: string[] = [];
  for (const model of ordered) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    if (isExternalCopilotConfigured(model)) usable.push(model);
  }
  // If nothing reports configured we still try the head, so the caller gets a
  // real provider error rather than a silent "not configured".
  return usable.length > 0 ? usable : [ordered[0]!];
}

export function isNewTabModelConfigured(): boolean {
  return isExternalCopilotConfigured();
}

export type NewTabStreamParams = {
  contents: any[];
  systemInstruction: string;
  tools?: any[];
  signal?: AbortSignal;
  /** Fires once, with the model that actually produced the stream. */
  onModel?: (model: string, attempt: number) => void;
  /** Fires when a model fails or times out and the next one is tried. */
  onFallback?: (from: string, to: string, reason: string) => void;
};

class FirstTokenTimeout extends Error {
  constructor(model: string, ms: number) {
    super(`${model} produced no token within ${Math.round(ms / 1000)}s`);
    this.name = "FirstTokenTimeout";
  }
}

/**
 * Streams Gemini-shaped chunks from the first model on the ladder that answers
 * within the first-token budget.
 *
 * The timeout gates the *first* token only — once output is flowing a long
 * generation is never cut off. Likewise, a mid-stream failure propagates rather
 * than restarting on another model, which would duplicate text already shown.
 */
export async function* streamNewTabModel(params: NewTabStreamParams): AsyncIterable<any> {
  const ladder = buildModelLadder();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < ladder.length; attempt += 1) {
    const model = ladder[attempt]!;
    const attemptController = new AbortController();
    const onParentAbort = () => attemptController.abort();
    params.signal?.addEventListener("abort", onParentAbort, { once: true });

    let timer: NodeJS.Timeout | null = null;
    let iterator: AsyncIterator<any> | null = null;

    try {
      const stream = streamExternalCopilot({
        model,
        contents: params.contents,
        systemInstruction: params.systemInstruction,
        tools: params.tools ?? [],
        signal: attemptController.signal,
      });
      iterator = stream[Symbol.asyncIterator]();

      const first = await new Promise<IteratorResult<any>>((resolve, reject) => {
        timer = setTimeout(() => {
          attemptController.abort();
          reject(new FirstTokenTimeout(model, FIRST_TOKEN_TIMEOUT_MS));
        }, FIRST_TOKEN_TIMEOUT_MS);
        iterator!.next().then(resolve, reject);
      });
      if (timer) { clearTimeout(timer); timer = null; }
      if (first.done) throw new Error("Provider returned an empty stream");

      params.onModel?.(model, attempt);
      yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
      return;
    } catch (err) {
      if (timer) clearTimeout(timer);
      await iterator?.return?.(undefined).catch(() => {});
      if (params.signal?.aborted) throw err;

      lastError = err;
      const timedOut = err instanceof FirstTokenTimeout;
      const isLast = attempt === ladder.length - 1;
      if (isLast || (!timedOut && !isExternalProviderRetryableError(err))) throw err;

      params.onFallback?.(
        model,
        ladder[attempt + 1]!,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      params.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  throw lastError ?? new Error("No model available");
}

/**
 * Non-streaming convenience for background work (the project runner's clip
 * discovery and verification passes) — same ladder, collected to a string.
 */
export async function runNewTabCompletion(params: {
  systemInstruction: string;
  userText: string;
  signal?: AbortSignal;
  onModel?: (model: string) => void;
  onFallback?: (from: string, to: string, reason: string) => void;
}): Promise<{ text: string; model: string }> {
  let usedModel = "";
  let text = "";

  const stream = streamNewTabModel({
    contents: [{ role: "user", parts: [{ text: params.userText }] }],
    systemInstruction: params.systemInstruction,
    signal: params.signal,
    onModel: (model) => { usedModel = model; params.onModel?.(model); },
    onFallback: params.onFallback,
  });

  for await (const chunk of stream) {
    for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
      // Reasoning tokens arrive as thought parts — never part of the answer.
      if (part?.thought) continue;
      if (typeof part?.text === "string") text += part.text;
    }
  }

  return { text: text.trim(), model: usedModel };
}

/** Strips ```json fences that the OSS models like to wrap structured output in. */
export function extractJsonBlock(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return body;
  const openChar = body[start];
  const closeChar = openChar === "[" ? "]" : "}";
  const end = body.lastIndexOf(closeChar);
  return end > start ? body.slice(start, end + 1) : body.slice(start);
}
