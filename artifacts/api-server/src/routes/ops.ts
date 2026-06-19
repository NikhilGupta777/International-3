import { Router, type IRouter } from "express";
import {
  getHttpMetricsSnapshot,
  getSystemMetricsSnapshot,
} from "../lib/ops-metrics";
import { getSubtitlesOpsSnapshot } from "./subtitles";
import { getYoutubeOpsSnapshot } from "./youtube";
import { isApiKeyStoreEnabled } from "../lib/api-key-auth";
import { isGeminiConfigured } from "../lib/gemini-client";
import { INTERNAL_AGENT_SECRET_FROM_ENV } from "../lib/internal-agent";

const router: IRouter = Router();

const hasEnv = (key: string): boolean => Boolean((process.env[key] ?? "").trim());

// ── GET /ops/readiness — admin config/worker readiness probe ─────────────────
// Surfaces whether the core dependencies the public API relies on are
// configured, so a bad deploy (missing table, queue, or model config) is
// visible immediately instead of failing deep inside a job.
router.get("/ops/readiness", (_req, res) => {
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();

  const checks: Record<string, boolean> = {
    apiKeyStore: isApiKeyStoreEnabled(),
    accessTable: hasEnv("ACCESS_TABLE") || hasEnv("API_KEYS_TABLE"),
    s3Bucket: hasEnv("S3_BUCKET"),
    gemini: isGeminiConfigured(),
    internalAgentSecretFromEnv: INTERNAL_AGENT_SECRET_FROM_ENV,
    sessionSecret: hasEnv("SESSION_SECRET") || hasEnv("AUTH_COOKIE_SECRET"),
  };

  // Core dependencies that must be present for the public API to function.
  const required = ["apiKeyStore", "s3Bucket", "gemini"];
  const missing = required.filter((k) => !checks[k]);

  res.status(missing.length === 0 ? 200 : 503).json({
    ts: Date.now(),
    ok: missing.length === 0,
    missing,
    checks,
    queues: {
      youtube: youtube.queue,
      subtitles: subtitles.queue,
    },
  });
});

router.get("/ops/metrics", (_req, res) => {
  if (!res.locals.authSession?.authenticated || res.locals.authSession?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const http = getHttpMetricsSnapshot();
  const system = getSystemMetricsSnapshot();
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();

  res.json({
    ts: Date.now(),
    http,
    system,
    queues: {
      youtube,
      subtitles,
    },
  });
});

router.get("/ops/alerts", (_req, res) => {
  if (!res.locals.authSession?.authenticated || res.locals.authSession?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const http = getHttpMetricsSnapshot();
  const system = getSystemMetricsSnapshot();
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();

  const alerts: Array<{ level: "warn" | "critical"; code: string; message: string }> = [];

  if (http.recent5m.requests >= 20 && http.recent5m.errorRatePct >= 10) {
    alerts.push({
      level: "critical",
      code: "HTTP_5XX_RATE_HIGH",
      message: `5xx rate is ${http.recent5m.errorRatePct}% over last 5 minutes`,
    });
  }

  if (system.memory.systemUsedPct >= 90) {
    alerts.push({
      level: "critical",
      code: "MEMORY_HIGH",
      message: `System memory usage is ${system.memory.systemUsedPct}%`,
    });
  } else if (system.memory.systemUsedPct >= 80) {
    alerts.push({
      level: "warn",
      code: "MEMORY_ELEVATED",
      message: `System memory usage is ${system.memory.systemUsedPct}%`,
    });
  }

  if ((system.disk.rootUsedPct ?? 0) >= 90) {
    alerts.push({
      level: "critical",
      code: "DISK_HIGH",
      message: `Root disk usage is ${system.disk.rootUsedPct}%`,
    });
  } else if ((system.disk.rootUsedPct ?? 0) >= 80) {
    alerts.push({
      level: "warn",
      code: "DISK_ELEVATED",
      message: `Root disk usage is ${system.disk.rootUsedPct}%`,
    });
  }

  if (youtube.queue.queuedClipJobs >= 5) {
    alerts.push({
      level: "warn",
      code: "CLIP_QUEUE_HIGH",
      message: `Clip queue depth is ${youtube.queue.queuedClipJobs}`,
    });
  }

  if (subtitles.queue.queuedSubtitleJobs >= 5) {
    alerts.push({
      level: "warn",
      code: "SUBTITLE_QUEUE_HIGH",
      message: `Subtitle queue depth is ${subtitles.queue.queuedSubtitleJobs}`,
    });
  }

  res.json({
    ts: Date.now(),
    ok: alerts.length === 0,
    alerts,
  });
});

export default router;
