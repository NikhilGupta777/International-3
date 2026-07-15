import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const BROKER_PATH = "/api/internal/vertex/copilot";
const VERTEX_MODEL = "gemma-4-26b-a4b-it-maas";

type BrokerStreamInput = {
  contents: unknown;
  config: Record<string, any>;
  signal?: AbortSignal;
};

export function isCopilotVertexBrokerConfigured(): boolean {
  return Boolean(normalizedBrokerUrl() && brokerSecret().length >= 32);
}

export async function streamCopilotViaOracle(input: BrokerStreamInput): Promise<AsyncIterable<any>> {
  const url = normalizedBrokerUrl();
  const secret = brokerSecret();
  if (!url || secret.length < 32) throw new Error("Copilot Vertex broker is not configured");

  const body = JSON.stringify({
    model: VERTEX_MODEL,
    contents: input.contents,
    systemInstruction: input.config.systemInstruction,
    tools: input.config.tools,
    toolConfig: input.config.toolConfig,
    generationConfig: {
      maxOutputTokens: input.config.maxOutputTokens,
      thinkingConfig: input.config.thinkingConfig,
      temperature: input.config.temperature,
      topP: input.config.topP,
      topK: input.config.topK,
    },
  });
  const timestamp = Date.now();
  const nonce = randomUUID();
  const signature = signBrokerRequest({ secret, timestamp, nonce, body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-copilot-timestamp": String(timestamp),
      "x-copilot-nonce": nonce,
      "x-copilot-signature": signature,
    },
    body,
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Copilot Vertex broker failed (${response.status}): ${detail.slice(0, 160)}`);
  }
  return parseVertexSse(response.body);
}

export function signBrokerRequest(args: { secret: string; timestamp: number; nonce: string; body: string }): string {
  const bodyHash = createHash("sha256").update(args.body).digest("hex");
  const canonical = ["v1", "POST", BROKER_PATH, String(args.timestamp), args.nonce, bodyHash].join("\n");
  return createHmac("sha256", args.secret).update(canonical).digest("hex");
}

export function signaturesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function* parseVertexSse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const events = buffered.split(/\r?\n\r?\n/);
    buffered = events.pop() ?? "";
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
    if (done) break;
  }
  const trailing = buffered.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") yield JSON.parse(data);
  }
}

function normalizedBrokerUrl(): string {
  const configured = String(process.env.COPILOT_VERTEX_BROKER_URL || "").trim();
  if (!configured) return "";
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.pathname !== BROKER_PATH || url.username || url.password) {
    throw new Error("COPILOT_VERTEX_BROKER_URL must be the HTTPS Oracle broker endpoint");
  }
  return url.toString();
}
function brokerSecret(): string {
  return String(process.env.COPILOT_VERTEX_BROKER_SECRET || "");
}
