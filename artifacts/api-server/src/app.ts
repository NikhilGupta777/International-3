import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - started;
    recordHttpMetrics(res.statusCode, durationMs);
  });
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

if (existsSync(staticDir)) {
  logger.info({ staticDir }, "Serving static frontend files");
  app.use(express.static(staticDir));
  // SPA fallback — serve index.html for any non-/api path that doesn't
  // match a static file (handles client-side routing).
  // Explicitly exclude /api/* so API 404s still return proper JSON errors.
  app.get(/^(?!\/api(\/|$))/, (_req: Request, res: Response) => {
    res.sendFile(join(staticDir, "index.html"));
  });
} else {
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
