import {
  COPILOT_FALLBACK_MODELS,
  COPILOT_FAST_MODEL,
  COPILOT_ULTRA_MODEL,
  getCopilotProvider,
  isExternalCopilotConfigured,
  streamExternalCopilot,
} from "../src/lib/copilot-external-provider";

const routes = [...new Set([COPILOT_ULTRA_MODEL, COPILOT_FAST_MODEL, ...COPILOT_FALLBACK_MODELS])];
const tool = {
  functionDeclarations: [{
    name: "lookup_video",
    description: "Find a video by search query",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING" } },
      required: ["query"],
    },
  }],
};
let unhealthyRoutes = 0;

for (const model of routes) {
  if (!isExternalCopilotConfigured(model)) {
    console.log(JSON.stringify({ model, provider: getCopilotProvider(model), status: "skipped-no-key" }));
    continue;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const startedAt = Date.now();
  let toolName = "";
  let query = "";
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const chunk of streamExternalCopilot({
      model,
      contents: [{ role: "user", parts: [{ text: "Call lookup_video with query cats. Do not answer in text." }] }],
      systemInstruction: "Use the required tool and return valid arguments.",
      tools: [tool],
      signal: controller.signal,
    })) {
      const call = chunk?.candidates?.[0]?.content?.parts?.find((part: any) => part?.functionCall)?.functionCall;
      if (call) {
        toolName = String(call.name ?? "");
        query = String(call.args?.query ?? "");
      }
      if (chunk?.usageMetadata) {
        inputTokens = Number(chunk.usageMetadata.promptTokenCount ?? 0);
        outputTokens = Number(chunk.usageMetadata.candidatesTokenCount ?? 0);
      }
    }
    const status = toolName === "lookup_video" && query === "cats" ? "pass" : "fail";
    if (status !== "pass") unhealthyRoutes++;
    console.log(JSON.stringify({
      model, provider: getCopilotProvider(model),
      status,
      durationMs: Date.now() - startedAt, toolName, query, inputTokens, outputTokens,
    }));
  } catch (error: any) {
    unhealthyRoutes++;
    console.log(JSON.stringify({
      model, provider: getCopilotProvider(model), status: "error",
      durationMs: Date.now() - startedAt,
      error: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

if (unhealthyRoutes > 0) process.exitCode = 1;
