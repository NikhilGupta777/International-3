import assert from "node:assert/strict";
import test from "node:test";
import { getToolResultError } from "./copilot-tool-state";

test("getToolResultError extracts string error from tool result", () => {
  assert.equal(
    getToolResultError({ error: "Clip cut failed" }),
    "Clip cut failed",
  );
});

test("getToolResultError ignores successful tool result", () => {
  assert.equal(getToolResultError({ jobId: "abc123" }), undefined);
});
