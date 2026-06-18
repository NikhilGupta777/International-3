import type { Response } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// Structured, machine-readable API errors for the public surface.
//
//   { "error": { "code", "message", "retryable", "retryAfterSec?", "details?" } }
//
// `code` is a stable SCREAMING_SNAKE identifier clients can branch on.
// `retryable` tells a client whether retrying the same request may succeed.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSec?: number;
    details?: unknown;
  };
}

export function apiErrorBody(
  code: string,
  message: string,
  opts: { retryable?: boolean; retryAfterSec?: number; details?: unknown } = {},
): ApiErrorBody {
  const body: ApiErrorBody = {
    error: { code, message, retryable: opts.retryable ?? false },
  };
  if (opts.retryAfterSec !== undefined) body.error.retryAfterSec = opts.retryAfterSec;
  if (opts.details !== undefined) body.error.details = opts.details;
  return body;
}

export function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  opts: { retryable?: boolean; retryAfterSec?: number; details?: unknown } = {},
): void {
  if (opts.retryAfterSec !== undefined) res.setHeader("Retry-After", String(opts.retryAfterSec));
  res.status(status).json(apiErrorBody(code, message, opts));
}

/** True when a payload already conforms to the structured error envelope. */
export function isApiErrorBody(payload: unknown): payload is ApiErrorBody {
  return (
    !!payload &&
    typeof payload === "object" &&
    typeof (payload as any).error === "object" &&
    typeof (payload as any).error?.code === "string"
  );
}
