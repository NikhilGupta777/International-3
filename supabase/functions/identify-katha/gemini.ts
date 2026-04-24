// Gemini caller using Google Generative Language OpenAI-compatible endpoint.
const MODEL = Deno.env.get("KATHA_GEMINI_MODEL") || Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

function getGeminiKeys(): string[] {
  const keys: string[] = [];
  const primary = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (primary?.trim()) keys.push(primary.trim());
  for (let i = 2; i <= 10; i += 1) {
    const key = Deno.env.get(`GEMINI_API_KEY_${i}`);
    if (key?.trim()) keys.push(key.trim());
  }
  return Array.from(new Set(keys));
}

export async function callGemini(
  messages: any[],
  tools: any[],
  toolName: string,
): Promise<any> {
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error("GEMINI_API_KEY is not configured");

  let lastError: any = null;
  for (const apiKey of keys) {
    const resp = await fetch(API_BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools,
        tool_choice: { type: "function", function: { name: toolName } },
      }),
    });
    if (resp.ok) {
      const json = await resp.json();
      const call = json.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) throw new Error("No tool call returned by AI");
      return JSON.parse(call.function.arguments);
    }
    const text = await resp.text();
    const err: any = new Error(`Gemini API ${resp.status}: ${text}`);
    err.status = resp.status;
    lastError = err;
    if (![429, 500, 502, 503, 504].includes(resp.status)) throw err;
  }
  throw lastError || new Error("Gemini API failed");
}

export async function callGeminiWithRetry(
  messages: any[],
  tools: any[],
  toolName: string,
): Promise<any> {
  try {
    return await callGemini(messages, tools, toolName);
  } catch (e: any) {
    if ([400, 401, 402, 403, 429].includes(e.status)) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return await callGemini(messages, tools, toolName);
  }
}
