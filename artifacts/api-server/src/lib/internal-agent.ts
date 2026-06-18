import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Internal server-to-server auth secret — single source of truth.
//
// Every internal call (AI Studio copilot tools, Pita Ji video-meta probe, the
// video editor's internal fetches) is routed to INTERNAL_API_BASE, which
// lambda-stream.ts pins to http://127.0.0.1:<port> — i.e. the SAME process that
// serves the /api auth gate. That means a value resolved once per process is
// always consistent between the caller and the gate.
//
// SECURITY
//   The /api gate must never accept a publicly-known constant (otherwise any
//   external client could send `X-Internal-Agent: <that constant>` and bypass
//   authentication entirely). So when INTERNAL_AGENT_SECRET is not provided we
//   generate a strong random secret at startup instead of falling back to a
//   hardcoded string. This keeps the gate hardened while letting internal calls
//   work with zero configuration.
//
//   Set INTERNAL_AGENT_SECRET explicitly if you ever need the value to be
//   stable/shared across separate processes.
// ─────────────────────────────────────────────────────────────────────────────

const fromEnv = (process.env.INTERNAL_AGENT_SECRET ?? "").trim();

/** The resolved internal-agent secret. Always non-empty. */
export const INTERNAL_AGENT_SECRET: string =
  fromEnv || crypto.randomBytes(32).toString("hex");

/** True when the secret came from the environment (not the random fallback). */
export const INTERNAL_AGENT_SECRET_FROM_ENV: boolean = Boolean(fromEnv);
