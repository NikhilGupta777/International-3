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

function isAuthenticated(req: Request): boolean {
  return req.signedCookies?.[AUTH_COOKIE_NAME] === "1";
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
  res.json({ authenticated: isAuthenticated(req) });
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

  res.cookie(AUTH_COOKIE_NAME, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    signed: true,
    maxAge: AUTH_MAX_AGE_MS,
    path: "/",
  });

  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
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
