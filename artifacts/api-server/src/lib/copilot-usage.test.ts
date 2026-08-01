import assert from "node:assert/strict";
import test from "node:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getCopilotUsageOverview, normalizeCopilotUsage, recordCopilotUsage } from "./copilot-usage";

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

test("disabled usage overview exposes complete zero-value dimensions", async () => {
  const previous = process.env.AI_USAGE_TABLE;
  delete process.env.AI_USAGE_TABLE;
  try {
    const overview = await getCopilotUsageOverview();
    assert.equal(overview.enabled, false);
    assert.equal(overview.today.failedCalls, 0);
    assert.equal(overview.today.timedOutCalls, 0);
    assert.deepEqual(overview.todayByProvider, {});
  } finally {
    if (previous === undefined) delete process.env.AI_USAGE_TABLE;
    else process.env.AI_USAGE_TABLE = previous;
  }
});

test("usage writes retry transaction conflicts and retain raw events indefinitely", async () => {
  const previousTable = process.env.AI_USAGE_TABLE;
  const originalSend = DynamoDBClient.prototype.send;
  process.env.AI_USAGE_TABLE = "test-ai-usage";
  let attempts = 0;
  let finalCommand: any;
  DynamoDBClient.prototype.send = (async function (command: any) {
    attempts++;
    finalCommand = command;
    if (attempts < 3) {
      const error: any = new Error("transaction conflict");
      error.name = "TransactionCanceledException";
      error.CancellationReasons = [{ Code: "TransactionConflict" }];
      throw error;
    }
    return {} as any;
  }) as any;
  try {
    await recordCopilotUsage({
      eventId: "run:attempt:1",
      runId: "run",
      mode: "fast",
      provider: "ollama",
      model: "ollama:gpt-oss:120b",
      iteration: 1,
      fallback: false,
      durationMs: 123,
      usage: null,
      outcome: "timeout",
    });
    assert.equal(attempts, 3);
    const event = finalCommand.input.TransactItems[0].Put.Item;
    assert.equal(event.outcome.S, "timeout");
    assert.equal("expiresAt" in event, false);
    const values = finalCommand.input.TransactItems[1].Update.ExpressionAttributeValues;
    assert.equal(values[":failed"].N, "1");
    assert.equal(values[":timedOut"].N, "1");
  } finally {
    DynamoDBClient.prototype.send = originalSend;
    if (previousTable === undefined) delete process.env.AI_USAGE_TABLE;
    else process.env.AI_USAGE_TABLE = previousTable;
  }
});
