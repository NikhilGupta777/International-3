export type LoginAttemptState = {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
};

export type LoginRateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec?: number;
};

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const MAX_TRACKED_CLIENTS = 10_000;

export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttemptState>();

  constructor(
    private readonly maxFailures = DEFAULT_MAX_FAILURES,
    private readonly windowMs = DEFAULT_WINDOW_MS,
    private readonly blockMs = DEFAULT_BLOCK_MS,
  ) {}

  check(key: string, now = Date.now()): LoginRateLimitDecision {
    this.prune(now);
    const state = this.attempts.get(key);
    if (!state) {
      return { allowed: true, limit: this.maxFailures, remaining: this.maxFailures };
    }
    if (state.blockedUntil > now) {
      return {
        allowed: false,
        limit: this.maxFailures,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000)),
      };
    }
    if (now - state.windowStartedAt >= this.windowMs) {
      this.attempts.delete(key);
      return { allowed: true, limit: this.maxFailures, remaining: this.maxFailures };
    }
    return {
      allowed: true,
      limit: this.maxFailures,
      remaining: Math.max(0, this.maxFailures - state.failures),
    };
  }

  recordFailure(key: string, now = Date.now()): LoginRateLimitDecision {
    const current = this.attempts.get(key);
    const state = !current || now - current.windowStartedAt >= this.windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      : current;
    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      state.blockedUntil = now + this.blockMs;
    }
    this.attempts.set(key, state);
    return this.check(key, now);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private prune(now: number): void {
    if (this.attempts.size < MAX_TRACKED_CLIENTS) return;
    for (const [key, state] of this.attempts) {
      const expired = state.blockedUntil <= now && now - state.windowStartedAt >= this.windowMs;
      if (expired) this.attempts.delete(key);
    }
    while (this.attempts.size >= MAX_TRACKED_CLIENTS) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.attempts.delete(oldest);
    }
  }
}
