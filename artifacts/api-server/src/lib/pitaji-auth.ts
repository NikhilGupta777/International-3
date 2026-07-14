// Pita Ji workspace auth — independent signed cookie, mirrors the main-site
// auth in app.ts but lives under its own cookie name + credentials so the two
// workspaces never share a session.
//
// Reuses the SAME `cookie-parser` instance and signing secret already mounted
// on the Express app — we just write/read a different cookie name.

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { INTERNAL_AGENT_SECRET } from "./internal-agent";

export const PITAJI_COOKIE_NAME = "pitaji_auth";
const PITAJI_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE === "false" ? false : true;

function envTrim(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export function isPitajiFeatureEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(envTrim("PITAJI_FEATURE_ENABLED", "false"));
}

export function getPitajiUsername(): string {
  return envTrim("PITAJI_USERNAME", "pitaji");
}

export function getPitajiPassword(): string {
  return envTrim("PITAJI_PASSWORD");
}

export function isPitajiConfigured(): boolean {
  return Boolean(getPitajiPassword());
}

function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export type PitajiSession = {
  authenticated: boolean;
  username?: string;
};

function encodeSession(session: Omit<PitajiSession, "authenticated">): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeSession(value: unknown): PitajiSession {
  if (value === "1") {
    return { authenticated: true, username: getPitajiUsername() };
  }
  if (typeof value !== "string" || !value) return { authenticated: false };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PitajiSession>;
    return {
      authenticated: true,
      username: typeof parsed.username === "string" ? parsed.username : undefined,
    };
  } catch {
    return { authenticated: false };
  }
}

export function getPitajiSession(req: Request): PitajiSession {
  return decodeSession(req.signedCookies?.[PITAJI_COOKIE_NAME]);
}

export function isPitajiAuthenticated(req: Request): boolean {
  return getPitajiSession(req).authenticated;
}

export function setPitajiAuthCookie(res: Response, username: string): void {
  res.cookie(PITAJI_COOKIE_NAME, encodeSession({ username }), {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    signed: true,
    maxAge: PITAJI_MAX_AGE_MS,
    path: "/",
  });
}

export function clearPitajiAuthCookie(res: Response): void {
  res.clearCookie(PITAJI_COOKIE_NAME, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    signed: true,
    path: "/",
  });
}

export function verifyPitajiCredentials(username: string, password: string): boolean {
  const expectedUser = getPitajiUsername();
  const expectedPass = getPitajiPassword();
  if (!expectedPass) return false;
  return (
    typeof username === "string" &&
    typeof password === "string" &&
    secureEqual(username, expectedUser) &&
    secureEqual(password, expectedPass)
  );
}

/**
 * Router-level middleware: blocks any request that isn't authenticated to the
 * Pita Ji workspace. Login + session probe routes must be mounted BEFORE this.
 *
 * Internal server-to-server calls (e.g. queue worker -> API) bypass via the
 * shared X-Internal-Agent header used elsewhere in the codebase.
 */
export function requirePitajiAuth(req: Request, res: Response, next: NextFunction): void {
  const internalSecret = INTERNAL_AGENT_SECRET;
  if (req.headers["x-internal-agent"] === internalSecret) {
    next();
    return;
  }
  if (isPitajiAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Pita Ji authentication required" });
}

/**
 * Pulls username + password from the JSON body or raw event body. Credentials
 * are deliberately never accepted from query parameters because URLs are
 * commonly retained by proxies, access logs, and monitoring systems.
 */
export function extractPitajiCredentials(req: Request): {
  username?: string;
  password?: string;
} {
  const tryParse = (value: string) => {
    try {
      const obj = JSON.parse(value) as { username?: unknown; password?: unknown };
      return {
        username: typeof obj.username === "string" ? obj.username : undefined,
        password: typeof obj.password === "string" ? obj.password : undefined,
      };
    } catch {
      return {};
    }
  };

  const body = req.body as unknown;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    const cand = body as { username?: unknown; password?: unknown };
    const u = typeof cand.username === "string" ? cand.username : undefined;
    const p = typeof cand.password === "string" ? cand.password : undefined;
    if (u !== undefined || p !== undefined) return { username: u, password: p };
  }
  if (Buffer.isBuffer(body)) {
    const parsed = tryParse(body.toString("utf8"));
    if (parsed.username !== undefined || parsed.password !== undefined) return parsed;
  }
  if (typeof body === "string" && body) {
    const parsed = tryParse(body);
    if (parsed.username !== undefined || parsed.password !== undefined) return parsed;
  }

  // Lambda Function URL raw fallback
  const evt = (req as Request & {
    apiGateway?: { event?: { body?: string; isBase64Encoded?: boolean } };
  }).apiGateway?.event;
  if (evt?.body) {
    const raw = evt.isBase64Encoded ? Buffer.from(evt.body, "base64").toString("utf8") : evt.body;
    return tryParse(raw);
  }

  return {};
}
