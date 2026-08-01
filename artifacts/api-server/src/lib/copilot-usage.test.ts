import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCopilotUsage } from "./copilot-usage";

test("normalizes provider-reported Copilot token usage", () => {
  assert.deepEqual(
    normalizeCopilotUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 5,
      cachedContentTokenCount: 12,
      totalTokenCount: 120,
    }),
    { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cachedTokens: 12, totalTokens: 120 },
  );
});

test("returns null when a provider omits usage", () => {
  assert.equal(normalizeCopilotUsage(undefined), null);
});
