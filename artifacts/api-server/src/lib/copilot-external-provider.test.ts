import assert from "node:assert/strict";
import test from "node:test";

process.env.OLLAMA_API_KEY = "test-ollama-key";
process.env.GROQ_API_KEY = "test-groq-key";

const provider = await import("./copilot-external-provider");

const contents = [{ role: "user", parts: [{ text: "Hello" }] }];
const tools = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  },
];

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("Ollama streams separate thinking, text, and tool calls", async () => {
  let requestBody: any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      [
        JSON.stringify({ message: { thinking: "checking" }, done: false }),
        JSON.stringify({ message: { content: "Found it" }, done: false }),
        JSON.stringify({
          message: {
            tool_calls: [
              {
                function: { name: "web_search", arguments: { query: "news" } },
              },
            ],
          },
          done: true,
        }),
      ].join("\n") + "\n",
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    );
  };
  try {
    const chunks = await collect(
      provider.streamExternalCopilot({
        model: "gpt-oss:120b",
        contents: [
          ...contents,
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call_previous",
                  name: "web_search",
                  args: { query: "old" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_previous",
                  name: "web_search",
                  response: { result: { error: "temporary" } },
                },
              },
              { text: "[JUDGE] Retry once" },
            ],
          },
        ],
        systemInstruction: "system",
        tools,
      }),
    );
    assert.equal(requestBody.think, "medium");
    assert.equal(requestBody.options.num_predict, 32000);
    assert.equal(requestBody.tools[0].function.name, "web_search");
    assert.deepEqual(
      requestBody.messages.slice(-3).map((message: any) => message.role),
      ["assistant", "tool", "user"],
    );
    assert.equal(chunks[0].candidates[0].content.parts[0].thought, true);
    assert.equal(chunks[1].candidates[0].content.parts[0].text, "Found it");
    assert.equal(
      chunks[2].candidates[0].content.parts[0].functionCall.name,
      "web_search",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Groq assembles streamed tool-call argument fragments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Working" } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: '{"query":' } }] } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"weather"}' } }] } }] })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  try {
    const chunks = await collect(
      provider.streamExternalCopilot({
        model: "llama-3.1-8b-instant",
        contents,
        systemInstruction: "system",
        tools,
      }),
    );
    assert.equal(chunks[0].candidates[0].content.parts[0].text, "Working");
    assert.deepEqual(
      chunks[1].candidates[0].content.parts[0].functionCall.args,
      { query: "weather" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Groq rotates to the next configured key before output on provider failure", async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  process.env.GROQ_API_KEYS = "test-groq-key,test-groq-key-2";
  globalThis.fetch = async (_input, init) => {
    authorizations.push(
      String((init?.headers as Record<string, string>)?.Authorization),
    );
    if (authorizations.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        {
          status: 429,
        },
      );
    }
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const chunks = await collect(
      provider.streamExternalCopilot({
        model: "llama-3.1-8b-instant",
        contents,
        systemInstruction: "system",
        tools,
      }),
    );
    assert.deepEqual(authorizations, [
      "Bearer test-groq-key",
      "Bearer test-groq-key-2",
    ]);
    assert.equal(chunks[0].candidates[0].content.parts[0].text, "OK");
  } finally {
    delete process.env.GROQ_API_KEYS;
    globalThis.fetch = originalFetch;
  }
});

test("provider HTTP errors are bounded and marked retryable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "retry-after": "1" },
    });
  try {
    await assert.rejects(
      () =>
        collect(
          provider.streamExternalCopilot({
            model: "gpt-oss:120b",
            contents,
            systemInstruction: "system",
            tools,
          }),
        ),
      (error: any) => {
        assert.equal(error.status, 429);
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterMs, 1000);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
