import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { isEmailApproved, type AuthRole } from "./lib/auth-access";
import {
  getHttpMetricsSnapshot,
  getSystemMetricsSnapshot,
  recordHttpMetrics,
} from "./lib/ops-metrics";

const app: Express = express();
app.set("trust proxy", true);
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
const ADMIN_PANEL_ENABLED = process.env.ADMIN_PANEL_ENABLED === "true";

if (!AUTH_PASS) {
  throw new Error("WEBSITE_AUTH_PASSWORD must be set");
}

if (!AUTH_COOKIE_SECRET) {
  throw new Error("SESSION_SECRET or AUTH_COOKIE_SECRET must be set");
}

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
    return { authenticated: true, method: "password", role: "admin" };
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

function setAuthCookie(res: Response, session: Omit<AuthSession, "authenticated"> | "legacy"): void {
  res.cookie(AUTH_COOKIE_NAME, session === "legacy" ? "1" : encodeSessionCookie(session), {
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

  const query = req.query as Record<string, unknown> | undefined;
  if (query && typeof query === "object") {
    const username = typeof query.username === "string" ? query.username : undefined;
    const password = typeof query.password === "string" ? query.password : undefined;
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
app.use(cors());
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
  const started = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - started;
    recordHttpMetrics(res.statusCode, durationMs);
  });
  next();
});

app.get("/api/auth/session", (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const session = getAuthSession(req);
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
    },
  });
});

app.get("/api/auth/config", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.json({
    googleAuthEnabled: GOOGLE_AUTH_ENABLED,
    googleClientId: GOOGLE_AUTH_ENABLED ? GOOGLE_CLIENT_ID : "",
  });
});

app.post("/api/auth/login", (req: Request, res: Response) => {
  const { username, password } = extractLoginCredentials(req);

  const okUser = typeof username === "string" && secureEqual(username, AUTH_USER);
  const okPass = typeof password === "string" && secureEqual(password, AUTH_PASS);
  if (!okUser || !okPass) {
    req.log.warn(
      {
        hasUsername: typeof username === "string",
        hasPassword: typeof password === "string",
      },
      "Login failed due to invalid credentials",
    );
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  setAuthCookie(res, "legacy");

  res.json({ ok: true });
});

app.post("/api/auth/google", async (req: Request, res: Response) => {
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
    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const verifyRes = await fetch(verifyUrl, { method: "GET" });
    if (!verifyRes.ok) {
      res.status(401).json({ error: "Invalid Google credential" });
      return;
    }
    const claims = await verifyRes.json() as {
      aud?: string;
      email?: string;
      email_verified?: string;
      name?: string;
      picture?: string;
    };
    if (claims.aud !== GOOGLE_CLIENT_ID) {
      res.status(401).json({ error: "Google credential audience mismatch" });
      return;
    }
    if (claims.email_verified !== "true" || !claims.email) {
      res.status(401).json({ error: "Google account email is not verified" });
      return;
    }

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

app.post("/api/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: "lax",
    signed: true,
    path: "/",
  });
  res.json({ ok: true });
});

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/healthz") {
    next();
    return;
  }
  if (req.path.startsWith("/auth/")) {
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
    next();
    return;
  }
  if (
    req.method === "GET" &&
    (req.path.startsWith("/uploads/file/") || req.path.startsWith("/translator/share/"))
  ) {
    next();
    return;
  }
  // Internal server-to-server agent calls bypass cookie auth
  const internalSecret = process.env.INTERNAL_AGENT_SECRET ?? "internal-agent-bypass-key";
  if (req.headers["x-internal-agent"] === internalSecret) {
    next();
    return;
  }
  if (isAuthenticated(req)) {
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
  app.use(express.static(staticDir));
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
