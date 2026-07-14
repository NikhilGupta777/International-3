import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { isEmailApproved, hydrateAllowlistFromDdb, isApiAccessAllowed, type AuthRole } from "./lib/auth-access";
import {
  extractApiKey,
  looksLikeApiKey,
  verifyApiKey,
  apiKeyAllowsPath,
  touchApiKeyUsage,
  enforceApiKeyLimits,
} from "./lib/api-key-auth";
import { INTERNAL_AGENT_SECRET } from "./lib/internal-agent";
import { sendApiError } from "./lib/api-error";
import { saveEmailSubmission } from "./lib/email-submissions";
import { canUseSuperAgent, canUseTranslator, canUseTranslatorLipSync } from "./lib/admin-features";
import { startCooldownSyncLoop } from "./utils/key-circuit-breaker";
import {
  getHttpMetricsSnapshot,
  getSystemMetricsSnapshot,
  recordHttpMetrics,
} from "./lib/ops-metrics";
import { LoginRateLimiter } from "./lib/login-rate-limit";

const app: Express = express();
app.disable("x-powered-by");
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10);
app.set("trust proxy", Number.isFinite(TRUST_PROXY_HOPS) ? Math.max(0, TRUST_PROXY_HOPS) : 1);
const DISABLE_STATIC_SERVE = process.env.DISABLE_STATIC_SERVE === "true";
const AUTH_COOKIE_NAME = "videomaking_auth";
const AUTH_USER = process.env.WEBSITE_AUTH_USER ?? "kalki_avatar";
const AUTH_PASS = process.env.WEBSITE_AUTH_PASSWORD;
const AUTH_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const AUTH_COOKIE_SECRET =
  process.env.SESSION_SECRET ??
  process.env.AUTH_COOKIE_SECRET;
const AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE === "false" ? false : true;
const GOOGLE_AUTH_ENABLED = process.env.GOOGLE_AUTH_ENABLED === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const googleOAuthClient = new OAuth2Client();
const ADMIN_PANEL_ENABLED = process.env.ADMIN_PANEL_ENABLED === "true";
const LOGIN_MAX_FAILURES = Math.max(1, Number.parseInt(process.env.LOGIN_MAX_FAILURES ?? "5", 10) || 5);
const LOGIN_RATE_WINDOW_MS = Math.max(60_000, Number.parseInt(process.env.LOGIN_RATE_WINDOW_MS ?? "900000", 10) || 900_000);
const LOGIN_BLOCK_MS = Math.max(60_000, Number.parseInt(process.env.LOGIN_BLOCK_MS ?? "900000", 10) || 900_000);
const loginRateLimiter = new LoginRateLimiter(LOGIN_MAX_FAILURES, LOGIN_RATE_WINDOW_MS, LOGIN_BLOCK_MS);

if (!AUTH_PASS) {
  throw new Error("WEBSITE_AUTH_PASSWORD must be set");
}

if (!AUTH_COOKIE_SECRET) {
  throw new Error("SESSION_SECRET or AUTH_COOKIE_SECRET must be set");
}

// Start allowlist hydration eagerly, but do not put it on every request's
// critical path. Routes that require the persisted allowlist await it below.
const allowlistHydrationPromise = hydrateAllowlistFromDdb().catch((err) => {
  console.warn("[app] allowlist hydration failed:", err);
});

// Start central API key circuit breaker synchronization loop
startCooldownSyncLoop();

function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

type AuthMethod = "password" | "google";
type AuthSession = {
  authenticated: boolean;
  method?: AuthMethod;
  role?: AuthRole;
  email?: string;
  name?: string;
  picture?: string;
};

function encodeSessionCookie(session: Omit<AuthSession, "authenticated">): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeSessionCookie(value: unknown): AuthSession {
  if (value === "1") {
    return { authenticated: true, method: "password", role: "user" };
  }
  if (typeof value !== "string" || !value) {
    return { authenticated: false };
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AuthSession>;
    const role: AuthRole = parsed.role === "admin" ? "admin" : "user";
    const method: AuthMethod = parsed.method === "google" ? "google" : "password";
    return {
      authenticated: true,
      method,
      role,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      picture: typeof parsed.picture === "string" ? parsed.picture : undefined,
    };
  } catch {
    return { authenticated: false };
  }
}

function getAuthSession(req: Request): AuthSession {
  return decodeSessionCookie(req.signedCookies?.[AUTH_COOKIE_NAME]);
}

function isAuthenticated(req: Request): boolean {
  return getAuthSession(req).authenticated;
}

function isAdmin(req: Request): boolean {
  const session = getAuthSession(req);
  return session.authenticated && session.role === "admin";
}

function requestHost(req: Request): string {
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  return (forwardedHost || req.get("host") || "").toLowerCase();
}

function isTrustedBrowserMutation(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return true;
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) {
    return String(req.headers["sec-fetch-site"] ?? "").toLowerCase() !== "cross-site";
  }
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const reqHost = requestHost(req);
    if (originHost === reqHost) return true;
    // CloudFront may not forward x-forwarded-host, so reqHost falls back to the
    // Lambda Function URL which doesn't match the public domain in Origin.
    // Also accept the configured public site URL as a trusted admin origin.
    const publicHost = (process.env.PUBLIC_SITE_URL ?? "videomaking.in")
      .replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
    return originHost === publicHost;
  } catch {
    return false;
  }
}

function setAuthCookie(res: Response, session: Omit<AuthSession, "authenticated">): void {
  res.cookie(AUTH_COOKIE_NAME, encodeSessionCookie(session), {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: "lax",
    signed: true,
    maxAge: AUTH_MAX_AGE_MS,
    path: "/",
  });
}

function extractLoginCredentials(req: Request): {
  username?: string;
  password?: string;
} {
  const parseCredentials = (value: string): { username?: string; password?: string } => {
    try {
      const parsed = JSON.parse(value) as {
        username?: unknown;
        password?: unknown;
      };
      return {
        username: typeof parsed.username === "string" ? parsed.username : undefined,
        password: typeof parsed.password === "string" ? parsed.password : undefined,
      };
    } catch {
      return {};
    }
  };

  const body = req.body as unknown;
  if (body && typeof body === "object") {
    if (Buffer.isBuffer(body)) {
      const parsed = parseCredentials(body.toString("utf8"));
      if (parsed.username !== undefined || parsed.password !== undefined) {
        return parsed;
      }
    }

    const candidate = body as { username?: unknown; password?: unknown };
    const username =
      typeof candidate.username === "string" ? candidate.username : undefined;
    const password =
      typeof candidate.password === "string" ? candidate.password : undefined;
    if (username !== undefined || password !== undefined) {
      return { username, password };
    }
  }

  // Fallback for Lambda adapters where parsed body is not populated.
  const eventBody = (req as Request & {
    apiGateway?: { event?: { body?: string; isBase64Encoded?: boolean } };
  }).apiGateway?.event?.body;
  const eventIsBase64 = (req as Request & {
    apiGateway?: { event?: { isBase64Encoded?: boolean } };
  }).apiGateway?.event?.isBase64Encoded === true;

  const rawBody =
    typeof body === "string"
      ? body
      : typeof (req as Request & { rawBody?: unknown }).rawBody === "string"
        ? ((req as Request & { rawBody?: string }).rawBody ?? "")
      : eventBody && eventIsBase64
        ? Buffer.from(eventBody, "base64").toString("utf8")
        : eventBody;
  if (!rawBody) return {};

  return parseCredentials(rawBody);
}

// Minimal security headers without introducing new deps.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  next();
});

app.use(
  pinoHttp({
    logger,
    // Skip auto-logging for SSE endpoint \u2014 avoids flush timing interference
    autoLogging: {
      ignore: (req: any) => req.url?.includes("/agent/chat") ?? false,
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const configuredPublicOrigin = (process.env.PUBLIC_SITE_URL ?? "https://videomaking.in").trim();
const allowedCorsOrigins = new Set<string>();
try {
  const publicOrigin = new URL(
    /^https?:\/\//i.test(configuredPublicOrigin)
      ? configuredPublicOrigin
      : `https://${configuredPublicOrigin}`,
  ).origin;
  allowedCorsOrigins.add(publicOrigin);
  const publicUrl = new URL(publicOrigin);
  publicUrl.hostname = publicUrl.hostname.startsWith("www.")
    ? publicUrl.hostname.slice(4)
    : `www.${publicUrl.hostname}`;
  allowedCorsOrigins.add(publicUrl.origin);
} catch {
  logger.warn({ configuredPublicOrigin }, "PUBLIC_SITE_URL is invalid; cross-origin browser access disabled");
}
if (process.env.NODE_ENV !== "production") {
  allowedCorsOrigins.add("http://localhost:5173");
  allowedCorsOrigins.add("http://127.0.0.1:5173");
}
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedCorsOrigins.has(origin));
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.use(cookieParser(AUTH_COOKIE_SECRET));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req: Request, _res: Response, next: NextFunction) => {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  const shouldParseJson = contentType.includes("application/json");
  const eventBody = (req as Request & {
    apiGateway?: { event?: { body?: string } };
  }).apiGateway?.event?.body;
  const parseJson = (value: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };

  if (shouldParseJson) {
    if (typeof eventBody === "string") {
      const parsedEventBody = parseJson(eventBody);
      if (parsedEventBody) {
        req.body = parsedEventBody;
        next();
        return;
      }
    }

    if (Buffer.isBuffer(req.body)) {
      const parsedBody = parseJson(req.body.toString("utf8"));
      if (parsedBody) {
        req.body = parsedBody;
      }
    } else if (typeof req.body === "string") {
      const parsedBody = parseJson(req.body);
      if (parsedBody) {
        req.body = parsedBody;
      }
    }
  }

  next();
});
app.use((req: Request, res: Response, next: NextFunction) => {
  // Guard against double-counting when a request is re-dispatched in-process
  // (e.g. the /api/v1 facade forwards to a canonical handler via app.handle).
  if ((req as Request & { _metricsHooked?: boolean })._metricsHooked) {
    next();
    return;
  }
  (req as Request & { _metricsHooked?: boolean })._metricsHooked = true;
  const started = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - started;
    recordHttpMetrics(res.statusCode, durationMs);
  });
  next();
});

app.get("/api/auth/session", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const session = getAuthSession(req);
  // Existing Google sessions need persisted grants; anonymous and password
  // sessions remain fast even when DynamoDB is cold or unavailable.
  if (session.email) await allowlistHydrationPromise;
  res.json({
    authenticated: session.authenticated,
    user: session.authenticated
      ? {
          method: session.method,
          role: session.role,
          email: session.email,
          name: session.name,
          picture: session.picture,
        }
      : null,
    features: {
      googleAuthEnabled: GOOGLE_AUTH_ENABLED,
      adminPanelEnabled: ADMIN_PANEL_ENABLED,
      translatorAllowed: canUseTranslator(session.email),
      translatorLipSyncAllowed: canUseTranslatorLipSync(session.email),
      superAgentAllowed: canUseSuperAgent(session.email),
      // Developer/API tab visibility: admins always, plus admin-granted emails.
      apiAccessAllowed:
        session.authenticated &&
        (session.role === "admin" || isApiAccessAllowed(session.email)),
    },
  });
});

app.get("/api/auth/config", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  res.json({
    googleAuthEnabled: GOOGLE_AUTH_ENABLED,
    googleClientId: GOOGLE_AUTH_ENABLED ? GOOGLE_CLIENT_ID : "",
  });
});

function loginClientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

app.post("/api/auth/login", (req: Request, res: Response) => {
  if (!isTrustedBrowserMutation(req)) {
    res.status(403).json({ error: "Login origin rejected" });
    return;
  }
  const clientKey = loginClientKey(req);
  const rateDecision = loginRateLimiter.check(clientKey);
  res.setHeader("X-RateLimit-Limit", String(rateDecision.limit));
  res.setHeader("X-RateLimit-Remaining", String(rateDecision.remaining));
  if (!rateDecision.allowed) {
    res.setHeader("Retry-After", String(rateDecision.retryAfterSec ?? 60));
    res.status(429).json({ error: "Too many login attempts. Please wait and try again." });
    return;
  }
  const { username, password } = extractLoginCredentials(req);

  const validShape = typeof username === "string" && username.length <= 256
    && typeof password === "string" && password.length <= 1024;
  const okUser = validShape && secureEqual(username, AUTH_USER);
  const okPass = validShape && secureEqual(password, AUTH_PASS);
  if (!okUser || !okPass) {
    const failedDecision = loginRateLimiter.recordFailure(clientKey);
    res.setHeader("X-RateLimit-Remaining", String(failedDecision.remaining));
    if (!failedDecision.allowed) {
      res.setHeader("Retry-After", String(failedDecision.retryAfterSec ?? 60));
    }
    req.log.warn(
      {
        hasUsername: typeof username === "string",
        hasPassword: typeof password === "string",
      },
      "Login failed due to invalid credentials",
    );
    res.status(failedDecision.allowed ? 401 : 429).json({
      error: failedDecision.allowed
        ? "Invalid credentials"
        : "Too many login attempts. Please wait and try again.",
    });
    return;
  }

  loginRateLimiter.clear(clientKey);
  setAuthCookie(res, {
    method: "password",
    role: "user",
  });

  res.json({ ok: true });
});

app.post("/api/auth/google", async (req: Request, res: Response) => {
  if (!isTrustedBrowserMutation(req)) {
    res.status(403).json({ error: "Login origin rejected" });
    return;
  }
  if (!GOOGLE_AUTH_ENABLED) {
    res.status(404).json({ error: "Google sign-in is not enabled" });
    return;
  }
  if (!GOOGLE_CLIENT_ID) {
    res.status(503).json({ error: "Google sign-in is not configured" });
    return;
  }

  const idToken =
    typeof (req.body as { credential?: unknown })?.credential === "string"
      ? ((req.body as { credential: string }).credential)
      : typeof (req.body as { idToken?: unknown })?.idToken === "string"
        ? ((req.body as { idToken: string }).idToken)
        : "";
  if (!idToken) {
    res.status(400).json({ error: "Missing Google credential" });
    return;
  }

  try {
    // Verify the signed ID token locally through Google's supported library.
    // This validates signature, issuer, audience, and expiry without putting
    // the credential into a tokeninfo query URL.
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const claims = ticket.getPayload();
    if (!claims?.email_verified || !claims.email) {
      res.status(401).json({ error: "Google account email is not verified" });
      return;
    }

    await allowlistHydrationPromise;
    const approval = isEmailApproved(claims.email);
    if (!approval.approved) {
      res.status(403).json({ error: "This Google account is not approved yet" });
      return;
    }

    setAuthCookie(res, {
      method: "google",
      role: approval.role,
      email: claims.email.toLowerCase(),
      name: claims.name,
      picture: claims.picture,
    });
    res.json({
      ok: true,
      user: {
        method: "google",
        role: approval.role,
        email: claims.email.toLowerCase(),
        name: claims.name,
        picture: claims.picture,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Google sign-in verification failed");
    res.status(502).json({ error: "Failed to verify Google sign-in" });
  }
});

app.post("/api/auth/logout", (req: Request, res: Response) => {
  if (!isTrustedBrowserMutation(req)) {
    res.status(403).json({ error: "Logout origin rejected" });
    return;
  }
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: "lax",
    signed: true,
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/email-submissions", async (req: Request, res: Response) => {
  if (!isTrustedBrowserMutation(req)) {
    res.status(403).json({ error: "Mutation origin rejected" });
    return;
  }
  const session = getAuthSession(req);
  if (!session.authenticated) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const body = req.body as { email?: unknown; name?: unknown };
  try {
    const record = await saveEmailSubmission({
      email: typeof body.email === "string" ? body.email : "",
      name: typeof body.name === "string" ? body.name : session.name,
      loginMethod: session.method ?? "unknown",
      loginEmail: session.email ?? "",
      role: session.role ?? "user",
      userAgent: String(req.headers["user-agent"] ?? ""),
    });
    res.json({ ok: true, submission: record });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "Could not save email" });
  }
});

app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
  res.locals.authSession = getAuthSession(req);
  if (req.path === "/healthz") {
    next();
    return;
  }
  if (req.path.startsWith("/auth/")) {
    next();
    return;
  }
  // Pita Ji workspace has its own independent auth scope (pitaji_auth cookie).
  // The pitaji router enforces its own gating internally — bypass the
  // videomaking_auth check here so the two workspaces never share sessions.
  if (req.path.startsWith("/pitaji/") || req.path === "/pitaji") {
    if (!isTrustedBrowserMutation(req)) {
      res.status(403).json({ error: "Mutation origin rejected" });
      return;
    }
    next();
    return;
  }
  if (req.path.startsWith("/admin/")) {
    if (!ADMIN_PANEL_ENABLED) {
      res.status(404).json({ error: "Admin panel is not enabled" });
      return;
    }
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    if (!isTrustedBrowserMutation(req)) {
      res.status(403).json({ error: "Admin mutation origin rejected" });
      return;
    }
    next();
    return;
  }
  if (
    req.method === "GET" &&
    (req.path.startsWith("/uploads/file/") || req.path.startsWith("/translator/share/") || req.path.startsWith("/agent/music-share/"))
  ) {
    next();
    return;
  }
  // Internal server-to-server agent calls bypass cookie auth. The secret is
  // resolved once per process (env value, else a strong random) so it is always
  // non-empty and never a publicly-known constant — see lib/internal-agent.ts.
  const internalSecret = INTERNAL_AGENT_SECRET;
  const internalHeader = String(req.headers["x-internal-agent"] ?? "").trim();
  if (internalHeader && secureEqual(internalHeader, internalSecret)) {
    next();
    return;
  }
  // Programmatic access via API key (Authorization: Bearer vms_live_... or X-API-Key).
  // Keys grant access to service routes but never to /admin or key management
  // (those segments are rejected inside apiKeyAllowsPath).
  const presentedKey = extractApiKey(req.headers as Record<string, unknown>);
  if (presentedKey && looksLikeApiKey(presentedKey)) {
    const keyRecord = await verifyApiKey(presentedKey);
    if (!keyRecord) {
      sendApiError(res, 401, "INVALID_API_KEY", "Invalid or revoked API key.");
      return;
    }
    if (!apiKeyAllowsPath(keyRecord, req.path)) {
      sendApiError(
        res,
        403,
        "FORBIDDEN_SCOPE",
        "This API key is not permitted to access this resource.",
      );
      return;
    }
    res.locals.apiKey = keyRecord;
    res.locals.authVia = "apikey";
    // Scope the request to this key so existing owner-isolation (x-client-id)
    // partitions all resources per key, exactly like a logged-in browser user.
    req.headers["x-client-id"] = `key:${keyRecord.keyId}`;
    // Enforce rate limit + monthly quota exactly once per external request
    // (skip on the in-process /v1 re-dispatch, which re-enters this gate).
    const metered = req as Request & { _apiKeyMetered?: boolean };
    if (!metered._apiKeyMetered) {
      metered._apiKeyMetered = true;
      const decision = enforceApiKeyLimits(keyRecord);
      // Standard rate-limit headers on every key-authenticated request.
      res.setHeader("X-RateLimit-Limit", String(decision.limit));
      res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
      res.setHeader("X-RateLimit-Reset", String(decision.resetEpochSec));
      if (!decision.allowed) {
        sendApiError(res, decision.status ?? 429, decision.code ?? "RATE_LIMIT_EXCEEDED", decision.error ?? "Rate limit exceeded.", {
          retryable: true,
          retryAfterSec: decision.retryAfterSec,
        });
        return;
      }
    }
    void touchApiKeyUsage(keyRecord);
    next();
    return;
  }
  if (isAuthenticated(req)) {
    if (!isTrustedBrowserMutation(req)) {
      res.status(403).json({ error: "Mutation origin rejected" });
      return;
    }
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required" });
});

// ── SSE route prep: disable socket Nagle buffering for streaming responses ──
// Must be registered before the main router so it applies to /api/agent/chat
app.use("/api/agent", (_req: Request, res: Response, next: NextFunction) => {
  const socket = (res as any).socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true); // TCP_NODELAY — send data immediately
  }
  next();
});

// Pita Ji workspace also streams analysis events — same Nagle bypass.
app.use("/api/pitaji", (_req: Request, res: Response, next: NextFunction) => {
  const socket = (res as any).socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }
  next();
});

// Thumbnail Studio streams SSE too — same Nagle bypass.
app.use("/api/thumbnail", (_req: Request, res: Response, next: NextFunction) => {
  const socket = (res as any).socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }
  next();
});

// Admin access management needs the persisted allowlist, while ordinary API
// traffic must never wait for this cold-start dependency.
app.use("/api/admin", async (_req: Request, _res: Response, next: NextFunction) => {
  try {
    await allowlistHydrationPromise;
    next();
  } catch (err) {
    next(err);
  }
});

// Content Manager streams scrape and generation events — same Nagle bypass.
app.use("/api/content-manager", (_req: Request, res: Response, next: NextFunction) => {
  const socket = (res as any).socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }
  next();
});

app.use("/api", router);
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "API route not found" });
});

// Serve built frontend static files whenever they exist (production always, dev when built)
const __dirname = fileURLToPath(new URL(".", import.meta.url));

// STATIC_DIR env var allows overriding the path (useful in Docker)
// Fallback: from artifacts/api-server/dist/ go 2 levels up → artifacts/
const staticDir =
  process.env["STATIC_DIR"] ??
  join(__dirname, "..", "..", "yt-downloader", "dist", "public");

if (!DISABLE_STATIC_SERVE && existsSync(staticDir)) {
  logger.info({ staticDir }, "Serving static frontend files");
  // Hashed assets (JS/CSS) can be cached forever; index.html must always revalidate
  app.use(express.static(staticDir, {
    maxAge: "1y",
    immutable: true,
    setHeaders(res, filePath) {
      // index.html and any non-hashed file should never be cached
      if (filePath.endsWith(".html") || filePath.endsWith(".json")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }));
  // SPA fallback — serve index.html for any non-/api path that doesn't
  // match a static file (handles client-side routing).
  // Explicitly exclude /api/* so API 404s still return proper JSON errors.
  app.get(/^(?!\/api(\/|$))/, (req: Request, res: Response) => {
    const path = req.path || "/";
    const hasDotSegment = /\/[^/]*\.[^/]+$/.test(path) || path.startsWith("/.");
    const acceptHeader = String(req.headers["accept"] ?? "");
    const wantsHtmlDocument = acceptHeader.includes("text/html");

    // Only route clean client-side paths to SPA index.
    // Requests that look like files should return 404.
    if (hasDotSegment || !wantsHtmlDocument) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(join(staticDir, "index.html"));
  });
} else if (!DISABLE_STATIC_SERVE) {
  logger.warn(
    { staticDir },
    "Static dir not found — frontend will not be served. Run the frontend build first.",
  );
}

// Global error handler — catches unhandled errors from any route/middleware
// and returns a consistent JSON error response instead of crashing or returning HTML.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : (err?.message ?? "Internal server error");
  logger.error({ err }, "Unhandled route error");
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

const ALERT_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  const http = getHttpMetricsSnapshot();
  const sys = getSystemMetricsSnapshot();

  if (http.recent5m.errorRatePct >= 10 && http.recent5m.requests >= 20) {
    logger.warn(
      {
        errorRatePct: http.recent5m.errorRatePct,
        requests5m: http.recent5m.requests,
      },
      "High 5xx rate detected in last 5 minutes",
    );
  }

  if (sys.memory.systemUsedPct >= 90) {
    logger.warn(
      { systemUsedPct: sys.memory.systemUsedPct },
      "High system memory usage detected",
    );
  }

  if ((sys.disk.rootUsedPct ?? 0) >= 90) {
    logger.warn(
      { diskRootUsedPct: sys.disk.rootUsedPct },
      "High disk usage detected on root filesystem",
    );
  }
}, ALERT_INTERVAL_MS);

export default app;
