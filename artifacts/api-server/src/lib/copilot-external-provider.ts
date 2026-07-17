import { randomUUID } from "crypto";

export const COPILOT_ULTRA_MODEL =
  process.env.COPILOT_ULTRA_MODEL?.trim() || "gpt-oss:120b";
export const COPILOT_FAST_MODEL =
  process.env.COPILOT_FAST_MODEL?.trim() || "llama-3.1-8b-instant";

type ExternalProvider = "ollama" | "groq";

const PROVIDER_KEY_SLOTS = 4;
const keyCooldowns = new Map<string, number>();

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

  constructor(
    message: string,
    options: {
      provider: ExternalProvider;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ExternalCopilotError";
    this.provider = options.provider;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function getCopilotProvider(model: string): ExternalProvider | null {
  if (model === COPILOT_ULTRA_MODEL || model.startsWith("gpt-oss:")) {
    return "ollama";
  }
  if (model === COPILOT_FAST_MODEL || model === "llama-3.1-8b-instant") {
    return "groq";
  }
  return null;
}

export function isExternalCopilotModel(model: string): boolean {
  return getCopilotProvider(model) !== null;
}

export function isExternalCopilotConfigured(model?: string): boolean {
  if (!model) {
    return (
      getProviderKeys("ollama").length > 0 || getProviderKeys("groq").length > 0
    );
  }
  const provider = getCopilotProvider(model);
  if (provider) return getProviderKeys(provider).length > 0;
  return false;
}

function getProviderKeys(provider: ExternalProvider): string[] {
  const prefix = provider === "ollama" ? "OLLAMA_API_KEY" : "GROQ_API_KEY";
  return [
    ...new Set(
      Array.from({ length: PROVIDER_KEY_SLOTS }, (_, index) =>
        process.env[index === 0 ? prefix : `${prefix}_${index + 1}`]?.trim(),
      ).filter((value): value is string => Boolean(value)),
    ),
  ];
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
      `${provider === "ollama" ? "Ollama Cloud" : "Groq"} is not configured`,
      { provider, status: 503 },
    );
  }

  const now = Date.now();
  const candidates = keys
    .map((apiKey, index) => ({
      apiKey,
      slot: `${provider}:${index}`,
      availableAt: keyCooldowns.get(`${provider}:${index}`) ?? 0,
    }))
    .sort((a, b) => {
      const aReady = a.availableAt <= now ? 0 : 1;
      const bReady = b.availableAt <= now ? 0 : 1;
      return aReady - bReady || a.availableAt - b.availableAt;
    });

  let lastError: unknown;
  for (const candidate of candidates) {
    let emitted = false;
    try {
      for await (const chunk of run(candidate.apiKey)) {
        emitted = true;
        yield chunk;
      }
      keyCooldowns.delete(candidate.slot);
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRotateKey(error, params.signal)) throw error;
      keyCooldowns.set(candidate.slot, Date.now() + cooldownMs(error));
      // Replaying after visible output would duplicate the response. The failed
      // key is cooled down so the next request starts on another configured key.
      if (emitted) throw error;
    }
  }
  throw lastError;
}

export function isExternalProviderRetryableError(error: unknown): boolean {
  if (error instanceof ExternalCopilotError) return error.retryable;
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
    `${provider === "ollama" ? "Ollama Cloud" : "Groq"} request failed (${response.status})${detail ? `: ${detail}` : ""}`,
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
      parameters: declaration.parameters ?? {
        type: "object",
        properties: {},
      },
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

function geminiTextChunk(text: string, thought = false): any {
  return {
    candidates: [
      {
        content: { parts: [{ text, ...(thought ? { thought: true } : {}) }] },
      },
    ],
  };
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
          model: params.model,
          messages: [
            { role: "system", content: params.systemInstruction },
            ...normalizeMessages(params.contents),
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

async function* streamGroqWithKey(
  params: StreamExternalCopilotParams,
  apiKey: string,
): AsyncGenerator<any> {
  let response: Response;
  try {
    response = await fetch(
      process.env.GROQ_API_URL?.trim() ||
        "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        signal: params.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          messages: [
            { role: "system", content: params.systemInstruction },
            ...normalizeMessages(params.contents),
          ],
          tools: normalizeTools(params.tools),
          tool_choice: "auto",
          stream: true,
          max_tokens:
            Number(process.env.COPILOT_FAST_MAX_OUTPUT_TOKENS) || 1024,
          temperature: 0.7,
          top_p: 1,
        }),
      },
    );
  } catch (error) {
    throw new ExternalCopilotError("Unable to reach Groq", {
      provider: "groq",
      retryable: true,
      cause: error,
    });
  }
  if (!response.ok) throw await providerHttpError("groq", response);

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
        { provider: "groq", retryable: true },
      );
    }
    const delta = event?.choices?.[0]?.delta ?? {};
    const thought = delta.reasoning ?? delta.reasoning_content;
    if (thought) yield geminiTextChunk(String(thought), true);
    if (delta.content) yield geminiTextChunk(String(delta.content));
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
  if (provider === "groq") {
    return streamWithKeyRotation("groq", params, (apiKey) =>
      streamGroqWithKey(params, apiKey),
    );
  }
  throw new ExternalCopilotError(
    `Unsupported external Copilot model: ${params.model}`,
    { provider: "ollama" },
  );
}
