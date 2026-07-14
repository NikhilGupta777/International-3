import assert from "node:assert/strict";
import test from "node:test";
import { LoginRateLimiter } from "./login-rate-limit";

test("blocks a client after repeated failed logins and reports retry timing", () => {
  const limiter = new LoginRateLimiter(3, 60_000, 120_000);
  assert.equal(limiter.check("client", 1_000).allowed, true);
  limiter.recordFailure("client", 1_000);
  limiter.recordFailure("client", 2_000);
  const blocked = limiter.recordFailure("client", 3_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSec, 120);
});

test("successful login clearing and expired windows restore attempts", () => {
  const limiter = new LoginRateLimiter(2, 10_000, 20_000);
  limiter.recordFailure("cleared", 1_000);
  limiter.clear("cleared");
  assert.equal(limiter.check("cleared", 2_000).remaining, 2);

  limiter.recordFailure("expired", 1_000);
  assert.equal(limiter.check("expired", 12_000).remaining, 2);
});
