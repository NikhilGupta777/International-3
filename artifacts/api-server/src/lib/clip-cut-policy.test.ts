import test from "node:test";
import assert from "node:assert/strict";
import { evaluateClipHandoff } from "./clip-cut-policy";

const base = {
  durationSecs: 180,
  sampleAfterMs: 75_000,
  noProgressAfterMs: 120_000,
  lambdaBudgetMs: 660_000,
  completionReserveMs: 120_000,
};

test("keeps a fast clip in the Lambda worker", () => {
  const decision = evaluateClipHandoff({
    ...base,
    elapsedMs: 80_000,
    progressPct: 48,
    speedText: "1.81x",
  });
  assert.equal(decision.shouldHandoff, false);
  assert.equal(decision.speed, 1.81);
});

test("hands a slow clip to Batch when projected completion exceeds the safe budget", () => {
  const decision = evaluateClipHandoff({
    ...base,
    elapsedMs: 80_000,
    progressPct: 8,
    speedText: "0.10x",
  });
  assert.equal(decision.shouldHandoff, true);
  assert.ok((decision.projectedRemainingMs ?? 0) > 1_000_000);
});

test("waits for the sampling window before making a decision", () => {
  const decision = evaluateClipHandoff({
    ...base,
    elapsedMs: 30_000,
    progressPct: 1,
    speedText: "0.05x",
  });
  assert.equal(decision.shouldHandoff, false);
});

test("hands off a job that still has no measurable progress", () => {
  const decision = evaluateClipHandoff({
    ...base,
    elapsedMs: 125_000,
    progressPct: 0,
    speedText: null,
  });
  assert.equal(decision.shouldHandoff, true);
});
