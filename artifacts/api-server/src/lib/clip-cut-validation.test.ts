import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClipRange } from "./clip-cut-validation";

test("normalizes a valid clip range", () => {
  assert.deepEqual(normalizeClipRange(1.4, 10.6), {
    ok: true,
    value: { startTime: 1, endTime: 11 },
  });
});

for (const [name, start, end] of [
  ["negative start", -1, 10],
  ["infinite start", Number.POSITIVE_INFINITY, 10],
  ["NaN end", 0, Number.NaN],
  ["empty range", 10, 10],
  ["reversed range", 11, 10],
  ["sub-second range lost by rounding", 0.1, 0.2],
  ["too long", 0, 3601],
] as const) {
  test(`rejects ${name}`, () => {
    assert.equal(normalizeClipRange(start, end).ok, false);
  });
}
