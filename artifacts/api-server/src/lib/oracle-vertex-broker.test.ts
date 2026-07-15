import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { signBrokerRequest } from "./oracle-vertex-broker";

test("Oracle broker signature covers method, path, timestamp, nonce, and exact body", () => {
  const args = {
    secret: "s".repeat(48),
    timestamp: 1_700_000_000_000,
    nonce: "12345678-1234-1234-1234-123456789abc",
    body: '{"model":"gemma-4-26b-a4b-it-maas"}',
  };
  const bodyHash = createHash("sha256").update(args.body).digest("hex");
  const canonical = [
    "v1",
    "POST",
    "/api/internal/vertex/copilot",
    String(args.timestamp),
    args.nonce,
    bodyHash,
  ].join("\n");
  const expected = createHmac("sha256", args.secret).update(canonical).digest("hex");
  assert.equal(signBrokerRequest(args), expected);
  assert.notEqual(signBrokerRequest({ ...args, body: args.body + " " }), expected);
});
