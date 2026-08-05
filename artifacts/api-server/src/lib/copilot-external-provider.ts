import { randomUUID } from "crypto";
import {
  getLadderOrder,
  getLadderPrimary,
  getLadderReasoning,
  type CopilotMode,
} from "./copilot-ladder-store";

// Both public modes lead with Mistral Small; Ollama GPT-OSS now sits further down
// the shared ladder. Keep these two equal — agent.ts treats `FAST_MODEL !== ULTRA_MODEL`
// as the switch that turns on separate Fast prompting and a reduced tool set.
export const COPILOT_ULTRA_MODEL =
  process.env.COPILOT_ULTRA_MODEL?.trim() || "mistral:mistral-small-latest";
export const COPILOT_FAST_MODEL =
  process.env.COPILOT_FAST_MODEL?.trim() || "mistral:mistral-small-latest";
export const COPILOT_ULTRA_FALLBACK_MODEL = "gpt-oss:120b";
export const NVIDIA_NEMOTRON_ULTRA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const NVIDIA_NEMOTRON_SUPER_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export type ExternalProvider =
  | "nvidia" | "ollama" | "groq" | "mistral" | "sambanova"
  | "openrouter" | "aion" | "kilo" | "agentrouter";

// AgentRouter relays this behind an OpenAI-compatible surface. Measured 2026-08-03:
// tool calls 3/3 exact, streaming never downgrades under reasoning_effort, and cost
// stayed flat at ~0.0006-0.0064 CNY with no phantom cache reads. Reasoning text is
// not streamed back — only the trailing reasoning_tokens count.
export const AGENTROUTER_GPT_MODEL = "agentrouter:gpt-5.6-sol";

const LONG_CONTEXT_MODELS = [
  "ollama:gpt-oss:120b",
  "mistral:mistral-small-latest",
  // Mistral's reasoning model. Unlike the rest of the Mistral line it actually
  // thinks, and it only accepts reasoning_effort "high" — see
  // getRouteReasoningSupport. Streams typed content blocks (emitDeltaContent).
  "mistral:magistral-small-latest",
  "mistral:mistral-medium-latest",
  "mistral:devstral-latest",
  "mistral:mistral-large-latest",
  "sambanova:gpt-oss-120b",
  "nvidia:nvidia/nemotron-3-super-120b-a12b",
  "nvidia:openai/gpt-oss-120b",
] as const;

const SHORT_CONTEXT_MODELS = [
  "groq:llama-3.3-70b-versatile",
  "groq:qwen/qwen3.6-27b",
  "groq:openai/gpt-oss-120b",
  "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
  "kilo:kilo-auto/free",
  "openrouter:qwen/qwen3.6-27b",
  "openrouter:moonshotai/kimi-k2.6",
  "aion:aion-labs/aion-2.5",
  "sambanova:DeepSeek-V3.2",
  "nvidia:nvidia/nemotron-3-ultra-550b-a55b",
] as const;

export const COPILOT_FALLBACK_MODELS = [
  ...LONG_CONTEXT_MODELS,
  ...SHORT_CONTEXT_MODELS,
] as const;

// Preferred head of the ladder. Kept separate from the catalog so the admin
// panel can reorder without losing the documented default.
//
// Order: the two routes that actually reason, then the measured-best
// non-thinking routes, and AgentRouter below both. Sol sits low deliberately —
// it 400s "content-blocked" on any message containing a YouTube URL, which is
// most of this app's traffic, so it can only usefully serve link-free turns.
const PREFERRED_LADDER_HEAD = [
  "mistral:magistral-small-latest",
  "nvidia:openai/gpt-oss-120b",
  "mistral:mistral-small-latest",
  "mistral:mistral-medium-latest",
  "ollama:gpt-oss:120b",
  AGENTROUTER_GPT_MODEL,
] as const;

/** Every route the ladder may contain — the admin panel validates against this. */
export const COPILOT_ROUTE_CATALOG: string[] = [
  ...new Set<string>([
    COPILOT_ULTRA_MODEL,
    COPILOT_FAST_MODEL,
    ...PREFERRED_LADDER_HEAD,
    ...COPILOT_FALLBACK_MODELS,
  ]),
];

/**
 * The built-in ladder, primary included. The admin editor seeds from this
 * rather than from getCopilotFallbackModels(), which drops the current primary
 * — saving that filtered list as an explicit order would silently remove the
 * primary route from the ladder for good.
 */
export function getDefaultLadderOrder(): string[] {
  return [...new Set<string>([...PREFERRED_LADDER_HEAD, ...COPILOT_FALLBACK_MODELS])];
}

/**
 * The reasoning_effort body field for a route, or {} when it takes none.
 * An admin override wins, but only if the route actually accepts that value —
 * sending an unsupported one is a hard 4xx on Mistral and would knock the route
 * out of the ladder on every request.
 */
function resolveReasoningEffort(
  route: string,
  provider: ExternalProvider,
  model: string,
): Record<string, string> {
  const supported = getRouteReasoningSupport(route);
  if (supported.length === 0) return {};
  const override = getLadderReasoning(route);
  if (override && supported.includes(override)) return { reasoning_effort: override };
  // Code default: the two routes that have always sent an effort value.
  if (provider === "agentrouter" || model === "openai/gpt-oss-120b") {
    return { reasoning_effort: supported.includes("medium") ? "medium" : supported[0] };
  }
  return { reasoning_effort: supported[0] };
}

/**
 * reasoning_effort values a route accepts. Verified against the live APIs:
 * Magistral rejects anything but "high", and Mistral's non-reasoning models
 * accept the field but ignore it entirely, so they are reported as unsupported.
 */
export function getRouteReasoningSupport(route: string): string[] {
  const provider = getCopilotProvider(route);
  const model = provider ? providerModel(provider, route) : route;
  if (provider === "agentrouter") return ["low", "medium", "high"];
  // Scoped to NVIDIA on purpose: groq also serves openai/gpt-oss-120b, and it
  // has never been sent a reasoning_effort field. Widening this by model name
  // alone would change that route's request body on every call.
  if (provider === "nvidia" && model === "openai/gpt-oss-120b") {
    return ["low", "medium", "high"];
  }
  if (provider === "mistral" && model.startsWith("magistral")) return ["high"];
  return [];
}

const PROVIDER_KEY_SLOTS = 4;
const keyCooldowns = new Map<string, number>();

const providerLabel = (provider: ExternalProvider): string => ({
  nvidia: "NVIDIA NIM", ollama: "Ollama Cloud", groq: "Groq",
  mistral: "Mistral", sambanova: "SambaNova", openrouter: "OpenRouter",
  aion: "AionLabs", kilo: "Kilo Gateway", agentrouter: "AgentRouter",
})[provider];

const providerModel = (provider: ExternalProvider, route: string): string =>
  route.startsWith(`${provider}:`) ? route.slice(provider.length + 1) : route;

const providerUrl = (provider: Exclude<ExternalProvider, "ollama">): string => ({
  nvidia: process.env.NVIDIA_API_URL?.trim() || "https://integrate.api.nvidia.com/v1/chat/completions",
  groq: process.env.GROQ_API_URL?.trim() || "https://api.groq.com/openai/v1/chat/completions",
  mistral: process.env.MISTRAL_API_URL?.trim() || "https://api.mistral.ai/v1/chat/completions",
  sambanova: process.env.SAMBANOVA_API_URL?.trim() || "https://api.sambanova.ai/v1/chat/completions",
  openrouter: process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
  aion: process.env.AION_API_URL?.trim() || "https://api.aionlabs.ai/v1/chat/completions",
  kilo: process.env.KILO_API_URL?.trim() || "https://api.kilo.ai/api/gateway/v1/chat/completions",
  agentrouter: process.env.AGENTROUTER_API_URL?.trim() || "https://agentrouter.org/v1/chat/completions",
})[provider];

type StreamExternalCopilotParams = {
  model: string;
  contents: any[];
  systemInstruction: string;
  tools: any[];
  signal?: AbortSignal;
};

export class ExternalCopilotError extends Error {
  readonly provider: ExternalProvider;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly keysExhausted: boolean;

  constructor(
    message: string,
    options: {
      provider: ExternalProvider;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      keysExhausted?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ExternalCopilotError";
    this.provider = options.provider;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.keysExhausted = options.keysExhausted ?? false;
  }
}

export function getCopilotProvider(model: string): ExternalProvider | null {
  for (const provider of ["mistral", "sambanova", "openrouter", "aion", "kilo", "groq", "nvidia", "ollama", "agentrouter"] as const) {
    if (model.startsWith(`${provider}:`)) return provider;
  }
  if (
    model === COPILOT_ULTRA_MODEL ||
    model === COPILOT_FAST_MODEL ||
    model === "openai/gpt-oss-120b" ||
    model.startsWith("nvidia/")
  ) {
    return "nvidia";
  }
  if (model === COPILOT_ULTRA_FALLBACK_MODEL || model.startsWith("gpt-oss:")) {
    return "ollama";
  }
  if (model === "llama-3.1-8b-instant") {
    return "groq";
  }
  return null;
}

/**
 * The route a mode starts on: the admin override when set, otherwise the
 * env/code default. Callers must refresh the ladder store first (the agent
 * route does) so a change made on one container is seen by the others.
 */
export function getCopilotPrimaryModel(mode: CopilotMode): string {
  return (
    getLadderPrimary(mode) ??
    (mode === "fast" ? COPILOT_FAST_MODEL : COPILOT_ULTRA_MODEL)
  );
}

function isPrimaryRoute(model: string): boolean {
  return (
    model === COPILOT_ULTRA_MODEL ||
    model === COPILOT_FAST_MODEL ||
    model === getLadderPrimary("ultra") ||
    model === getLadderPrimary("fast")
  );
}

export function getCopilotFallbackModels(model: string): string[] {
  // Only a primary route gets a ladder; a specifically requested model does not.
  // An admin-selected primary counts, otherwise one failure would end the run.
  if (!isPrimaryRoute(model)) return [];
  // An admin order sets the *priority*, not the membership: the panel can only
  // reorder, never remove, so any catalog route missing from a saved order was
  // dropped by accident (older builds seeded the editor from a list that
  // excluded the primary). Append the strays at the tail rather than lose them.
  // Revisit if the panel ever grows an explicit remove control.
  const override = getLadderOrder();
  const base = override
    ? [...override, ...getDefaultLadderOrder().filter((route) => !override.includes(route))]
    : getDefaultLadderOrder();
  return [...new Set(base)].filter((candidate) => candidate !== model);
}

export function isExternalCopilotModel(model: string): boolean {
  return getCopilotProvider(model) !== null;
}

export function isExternalCopilotConfigured(model?: string): boolean {
  if (!model) {
    return (["mistral", "sambanova", "ollama", "nvidia", "groq", "openrouter", "kilo", "aion", "agentrouter"] as ExternalProvider[])
      .some((provider) => getProviderKeys(provider).length > 0);
  }
  const provider = getCopilotProvider(model);
  if (provider) return getProviderKeys(provider).length > 0;
  return false;
}

function getProviderKeys(provider: ExternalProvider): string[] {
  const prefix = `${provider.toUpperCase()}_API_KEY`;
  const pooled = process.env[`${prefix}S`]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [
    ...new Set(
      [
        ...(pooled ?? []),
        ...Array.from({ length: PROVIDER_KEY_SLOTS }, (_, index) =>
          process.env[index === 0 ? prefix : `${prefix}_${index + 1}`]?.trim(),
        ),
      ].filter(
        (value): value is string =>
          Boolean(value) && value !== "-" && value !== "***",
      ),
    ),
  ];
}

export function getExternalCopilotKeyCount(
  provider: ExternalProvider,
): number {
  return getProviderKeys(provider).length;
}

function shouldRotateKey(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (!(error instanceof ExternalCopilotError)) return true;
  return error.retryable || error.status === 401 || error.status === 403;
}

function cooldownMs(error: unknown): number {
  if (!(error instanceof ExternalCopilotError)) return 30_000;
  if (error.retryAfterMs !== undefined) {
    return Math.min(Math.max(error.retryAfterMs, 1_000), 15 * 60_000);
  }
  if (error.status === 401 || error.status === 403) return 5 * 60_000;
  return 30_000;
}

async function* streamWithKeyRotation(
  provider: ExternalProvider,
  params: StreamExternalCopilotParams,
  run: (apiKey: string) => AsyncIterable<any>,
): AsyncGenerator<any> {
  const keys = getProviderKeys(provider);
  if (!keys.length) {
    throw new ExternalCopilotError(
      `${providerLabel(provider)} is not configured`,
      { provider, status: 503 },
    );
  }

  const now = Date.now();
  const candidates = keys
    .map((apiKey, index) => {
      const globalSlot = `${provider}:${index}:global`;
      const modelSlot = `${provider}:${index}:${params.model}`;
      return {
        apiKey,
        globalSlot,
        modelSlot,
        availableAt: Math.max(
          keyCooldowns.get(globalSlot) ?? 0,
          keyCooldowns.get(modelSlot) ?? 0,
        ),
      };
    })
    .sort((a, b) => {
      const aReady = a.availableAt <= now ? 0 : 1;
      const bReady = b.availableAt <= now ? 0 : 1;
      return aReady - bReady || a.availableAt - b.availableAt;
    });
  const readyCandidates = candidates.filter(
    (candidate) => candidate.availableAt <= now,
  );
  if (!readyCandidates.length) {
    const retryAfterMs = Math.max(1_000, candidates[0].availableAt - now);
    throw new ExternalCopilotError(
      `${providerLabel(provider)} keys are cooling down`,
      {
        provider,
        status: 429,
        retryable: true,
        retryAfterMs,
        keysExhausted: true,
      },
    );
  }

  let lastError: unknown;
  for (const candidate of readyCandidates) {
    let emitted = false;
    try {
      for await (const chunk of run(candidate.apiKey)) {
        emitted = true;
        yield chunk;
      }
      keyCooldowns.delete(candidate.modelSlot);
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRotateKey(error, params.signal)) throw error;
      const cooldownSlot =
        error instanceof ExternalCopilotError &&
        (error.status === 401 || error.status === 403)
          ? candidate.globalSlot
          : candidate.modelSlot;
      keyCooldowns.set(cooldownSlot, Date.now() + cooldownMs(error));
      // Replaying after visible output would duplicate the response. The failed
      // key is cooled down so the next request starts on another configured key.
      if (emitted) throw error;
    }
  }
  if (lastError instanceof ExternalCopilotError) {
    throw new ExternalCopilotError(lastError.message, {
      provider: lastError.provider,
      status: lastError.status,
      retryable: lastError.retryable,
      retryAfterMs: lastError.retryAfterMs,
      keysExhausted: true,
      cause: lastError,
    });
  }
  throw lastError;
}

export function isExternalProviderRetryableError(error: unknown): boolean {
  if (error instanceof ExternalCopilotError) {
    return error.retryable && !error.keysExhausted;
  }
  const message = String((error as any)?.message ?? error ?? "");
  return /abort|timeout|timed out|fetch failed|socket|ECONNRESET|EAI_AGAIN|429|502|503|504/i.test(
    message,
  );
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function providerHttpError(
  provider: ExternalProvider,
  response: Response,
): Promise<ExternalCopilotError> {
  const raw = await response.text().catch(() => "");
  let detail = raw.slice(0, 600).replace(/\s+/g, " ").trim();
  try {
    const parsed = JSON.parse(raw);
    detail = String(
      parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? detail,
    ).slice(0, 600);
  } catch {
    // Plain-text provider errors are already bounded above.
  }
  const retryable =
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500;
  return new ExternalCopilotError(
    `${providerLabel(provider)} request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    {
      provider,
      status: response.status,
      retryable,
      retryAfterMs: retryAfterMs(response),
    },
  );
}

function parseArguments(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { _raw: value };
  }
}

function normalizeJsonSchema(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!value || typeof value !== "object") return value;

  const normalized: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      child === undefined ||
      key === "nullable" ||
      key === "propertyOrdering"
    ) {
      continue;
    }
    if (key === "type") {
      normalized.type = Array.isArray(child)
        ? child.map((type) => String(type).toLowerCase())
        : String(child).toLowerCase();
      continue;
    }
    normalized[key] = normalizeJsonSchema(child);
  }
  // Gemini's `nullable` extension is not part of the tool-schema subset
  // consistently accepted by OpenAI-compatible and Ollama endpoints. Dropping
  // it keeps the declared base type portable; tool arguments are optional
  // unless their property name is present in the parent's `required` array.
  return normalized;
}

function normalizeTools(tools: any[]): any[] {
  const declarations = tools.flatMap((entry) =>
    Array.isArray(entry?.functionDeclarations)
      ? entry.functionDeclarations
      : [],
  );
  return declarations.map((declaration: any) => ({
    type: "function",
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: normalizeJsonSchema(
        declaration.parameters ?? { type: "object", properties: {} },
      ),
    },
  }));
}

function partText(part: any): string {
  if (typeof part?.text === "string") return part.text;
  if (part?.fileData?.fileUri) {
    return `[Attached media: ${part.fileData.fileUri} (${part.fileData.mimeType ?? "unknown type"})]`;
  }
  if (part?.inlineData) {
    return `[Attached image: ${part.inlineData.mimeType ?? "image"}; use an image-analysis tool if needed]`;
  }
  return "";
}

function normalizeMessages(contents: any[]): any[] {
  const messages: any[] = [];
  for (const content of contents) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const role = content?.role === "model" ? "assistant" : "user";
    const text = parts.map(partText).filter(Boolean).join("\n");
    const functionCalls = parts
      .filter((part: any) => part?.functionCall?.name)
      .map((part: any) => ({
        id: part.functionCall.id || `call_${randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      }));
    const functionResponses = parts.filter(
      (part: any) => part?.functionResponse?.name,
    );

    if (role === "assistant" && (text || functionCalls.length)) {
      messages.push({
        role: "assistant",
        content: text || null,
        ...(functionCalls.length ? { tool_calls: functionCalls } : {}),
      });
    }

    // Tool results must immediately follow the assistant tool_calls message.
    // A judge/correction text part belongs after those tool messages.
    for (const part of functionResponses) {
      const response = part.functionResponse.response ?? {};
      messages.push({
        role: "tool",
        tool_call_id:
          part.functionResponse.id || `call_${part.functionResponse.name}`,
        name: part.functionResponse.name,
        content: JSON.stringify(response),
      });
    }
    if (role === "user" && text) {
      messages.push({ role: "user", content: text });
    }
  }
  return messages;
}

function normalizeOllamaMessages(contents: any[]): any[] {
  return normalizeMessages(contents).map((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      return {
        ...message,
        tool_calls: message.tool_calls.map((call: any) => ({
          ...call,
          function: {
            ...call.function,
            arguments: parseArguments(call.function?.arguments),
          },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_name: message.name,
      };
    }
    return message;
  });
}

function geminiTextChunk(text: string, thought = false): any {
  return {
    candidates: [
      {
        content: { parts: [{ text, ...(thought ? { thought: true } : {}) }] },
      },
    ],
  };
}

/**
 * Mistral's reasoning models (Magistral) stream `delta.content` as an array of
 * typed blocks instead of a string: reasoning arrives as
 * `{type:"thinking", thinking:[{type:"text", text}]}` and the answer as
 * `{type:"text", text}`. `String(content)` on that yields "[object Object]" for
 * every chunk, so both shapes are normalised here. Empty-string content chunks
 * (Magistral opens with a few) are skipped rather than emitted as blank text.
 */
function* emitDeltaContent(content: unknown): Generator<any> {
  if (!content) return;
  if (typeof content === "string") {
    yield geminiTextChunk(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, any>;
    if (typed.type === "thinking") {
      const parts = Array.isArray(typed.thinking) ? typed.thinking : [typed.thinking];
      const text = parts
        .map((part: any) => (typeof part === "string" ? part : String(part?.text ?? "")))
        .join("");
      if (text) yield geminiTextChunk(text, true);
      continue;
    }
    const text = typeof typed.text === "string" ? typed.text : "";
    if (text) yield geminiTextChunk(text);
  }
}

function geminiToolChunk(toolCall: any): any {
  const fn = toolCall?.function ?? toolCall;
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                id:
                  toolCall?.id ||
                  `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                name: fn?.name,
                args: parseArguments(fn?.arguments),
              },
            },
          ],
        },
      },
    ],
  };
}

async function* readNdjson(response: Response): AsyncGenerator<any> {
  if (!response.body) throw new Error("Provider returned an empty stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        yield JSON.parse(line);
      }
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}

async function* streamOllamaWithKey(
  params: StreamExternalCopilotParams,
  apiKey: string,
): AsyncGenerator<any> {
  let response: Response;
  try {
    response = await fetch(
      process.env.OLLAMA_API_URL?.trim() || "https://ollama.com/api/chat",
      {
        method: "POST",
        signal: params.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: providerModel("ollama", params.model),
          messages: [
            { role: "system", content: params.systemInstruction },
            ...normalizeOllamaMessages(params.contents),
          ],
          tools: normalizeTools(params.tools),
          think: "medium",
          stream: true,
          options: {
            num_predict:
              Number(process.env.COPILOT_ULTRA_MAX_OUTPUT_TOKENS) || 32000,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.1,
          },
        }),
      },
    );
  } catch (error) {
    throw new ExternalCopilotError("Unable to reach Ollama Cloud", {
      provider: "ollama",
      retryable: true,
      cause: error,
    });
  }
  if (!response.ok) throw await providerHttpError("ollama", response);

  for await (const event of readNdjson(response)) {
    const message = event?.message ?? {};
    if (message.thinking) yield geminiTextChunk(String(message.thinking), true);
    if (message.content) yield geminiTextChunk(String(message.content));
    for (const call of message.tool_calls ?? []) {
      if (call?.function?.name || call?.name) yield geminiToolChunk(call);
    }
    if (event?.error) {
      throw new ExternalCopilotError(String(event.error), {
        provider: "ollama",
        retryable: true,
      });
    }
    if (event?.done && (event?.prompt_eval_count != null || event?.eval_count != null)) {
      const promptTokens = Number(event.prompt_eval_count ?? 0);
      const completionTokens = Number(event.eval_count ?? 0);
      yield {
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: completionTokens,
          totalTokenCount: promptTokens + completionTokens,
        },
      };
    }
  }
}

async function* readSseData(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider returned an empty stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* streamOpenAiCompatibleWithKey(
  params: StreamExternalCopilotParams,
  apiKey: string,
  provider: Exclude<ExternalProvider, "ollama">,
): AsyncGenerator<any> {
  const isNvidia = provider === "nvidia";
  const isAgentRouter = provider === "agentrouter";
  const model = providerModel(provider, params.model);
  const normalizedTools = normalizeTools(params.tools);
  const maxTokens = isNvidia
    ? params.model === COPILOT_ULTRA_MODEL
      ? Number(process.env.COPILOT_ULTRA_MAX_OUTPUT_TOKENS) || 60_000
      : Number(process.env.COPILOT_FAST_MAX_OUTPUT_TOKENS) || 60_000
    : (["groq", "openrouter", "aion", "kilo"] as ExternalProvider[]).includes(provider)
      ? Number(process.env.COPILOT_CONSTRAINED_MAX_OUTPUT_TOKENS) || 4_096
      : Number(process.env.COPILOT_FAST_FALLBACK_MAX_OUTPUT_TOKENS) || 16_384;
  let response: Response;
  try {
    response = await fetch(
      providerUrl(provider),
      {
        method: "POST",
        signal: params.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          // AgentRouter's WAF 401s any request that doesn't present as Claude Code.
          ...(isAgentRouter
            ? {
                "User-Agent":
                  process.env.AGENTROUTER_USER_AGENT?.trim() ||
                  "claude-cli/2.0.14 (external, cli)",
                "x-app": "cli",
              }
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: params.systemInstruction },
            ...normalizeMessages(params.contents),
          ],
          ...(normalizedTools.length
            ? { tools: normalizedTools, tool_choice: "auto" }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: maxTokens,
          ...(resolveReasoningEffort(params.model, provider, model)),
          temperature: 0.7,
          top_p: 1,
        }),
      },
    );
  } catch (error) {
    throw new ExternalCopilotError(
      `Unable to reach ${providerLabel(provider)}`,
      {
        provider,
        retryable: true,
        cause: error,
      },
    );
  }
  if (!response.ok) throw await providerHttpError(provider, response);

  const pendingCalls = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();
  for await (const data of readSseData(response)) {
    if (data === "[DONE]") break;
    const event = JSON.parse(data);
    if (event?.error) {
      throw new ExternalCopilotError(
        String(event.error?.message ?? event.error),
        { provider, retryable: true },
      );
    }
    if (event?.usage) {
      yield {
        usageMetadata: {
          promptTokenCount: Number(event.usage.prompt_tokens ?? 0),
          candidatesTokenCount: Number(event.usage.completion_tokens ?? 0),
          totalTokenCount: Number(event.usage.total_tokens ?? 0),
          cachedContentTokenCount: Number(
            event.usage.prompt_tokens_details?.cached_tokens ?? 0,
          ),
          thoughtsTokenCount: Number(
            event.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          ),
        },
      };
    }
    const delta = event?.choices?.[0]?.delta ?? {};
    const thought = delta.reasoning ?? delta.reasoning_content;
    if (thought) yield geminiTextChunk(String(thought), true);
    yield* emitDeltaContent(delta.content);
    for (const call of delta.tool_calls ?? []) {
      const index = Number(call.index ?? 0);
      const existing = pendingCalls.get(index) ?? { arguments: "" };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name = call.function.name;
      if (call.function?.arguments) {
        existing.arguments += String(call.function.arguments);
      }
      pendingCalls.set(index, existing);
    }
  }
  for (const call of [...pendingCalls.entries()].sort(([a], [b]) => a - b)) {
    const value = call[1];
    if (value.name) {
      yield geminiToolChunk({
        id: value.id,
        function: { name: value.name, arguments: value.arguments },
      });
    }
  }
}

export function streamExternalCopilot(
  params: StreamExternalCopilotParams,
): AsyncIterable<any> {
  const provider = getCopilotProvider(params.model);
  if (provider === "ollama") {
    return streamWithKeyRotation("ollama", params, (apiKey) =>
      streamOllamaWithKey(params, apiKey),
    );
  }
  if (provider) {
    return streamWithKeyRotation(provider, params, (apiKey) =>
      streamOpenAiCompatibleWithKey(params, apiKey, provider),
    );
  }
  throw new ExternalCopilotError(
    `Unsupported external Copilot model: ${params.model}`,
    { provider: "ollama" },
  );
}
