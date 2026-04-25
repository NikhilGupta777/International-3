const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export async function callGemini(messages: any[], tools: any[], toolName: string): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const response = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: { type: "function", function: { name: toolName } },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const error: any = new Error(`Gemini API ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }

  const json = await response.json();
  const call = json.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) throw new Error("No tool call returned by Gemini");
  return JSON.parse(call.function.arguments);
}

export async function callGeminiWithRetry(messages: any[], tools: any[], toolName: string): Promise<any> {
  try {
    return await callGemini(messages, tools, toolName);
  } catch (error: any) {
    if ([400, 401, 402, 403, 429].includes(error.status)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return callGemini(messages, tools, toolName);
  }
}
