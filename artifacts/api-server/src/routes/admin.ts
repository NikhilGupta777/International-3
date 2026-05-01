import { Router, type IRouter } from "express";
import {
  getHttpMetricsSnapshot,
  getSystemMetricsSnapshot,
} from "../lib/ops-metrics";
import {
  listApprovedAccess,
  removeApprovedEmail,
  setApprovedEmail,
  type AuthRole,
} from "../lib/auth-access";
import { cancelYoutubeQueueJob } from "../lib/youtube-queue";
import {
  cleanupOldS3Objects,
  getS3StorageConfig,
  isS3StorageEnabled,
} from "../lib/s3-storage";
import { getSubtitlesOpsSnapshot } from "./subtitles";
import { getYoutubeOpsSnapshot } from "./youtube";
import { isGeminiConfigured } from "../lib/gemini-client";

const router: IRouter = Router();

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function enabled(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function configured(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function buildAlerts(args: {
  http: ReturnType<typeof getHttpMetricsSnapshot>;
  system: ReturnType<typeof getSystemMetricsSnapshot>;
  youtube: ReturnType<typeof getYoutubeOpsSnapshot>;
  subtitles: ReturnType<typeof getSubtitlesOpsSnapshot>;
}) {
  const alerts: Array<{ level: "info" | "warning" | "critical"; title: string; detail: string }> = [];
  if (args.http.recent5m.errorRatePct >= 10) {
    alerts.push({
      level: "critical",
      title: "High API error rate",
      detail: `${args.http.recent5m.errorRatePct}% 5xx responses in the last 5 minutes.`,
    });
  }
  if (args.system.disk.rootUsedPct !== null && args.system.disk.rootUsedPct >= 85) {
    alerts.push({
      level: "warning",
      title: "Disk usage is high",
      detail: `${args.system.disk.rootUsedPct}% of root disk is used.`,
    });
  }
  if (args.youtube.queue.queuedClipJobs > 0) {
    alerts.push({
      level: "info",
      title: "Clip queue has waiting jobs",
      detail: `${args.youtube.queue.queuedClipJobs} clip job(s) are queued.`,
    });
  }
  if (args.subtitles.queue.queuedSubtitleJobs > 0) {
    alerts.push({
      level: "info",
      title: "Subtitle queue has waiting jobs",
      detail: `${args.subtitles.queue.queuedSubtitleJobs} subtitle job(s) are queued.`,
    });
  }
  return alerts;
}

router.get("/overview", (_req, res) => {
  const http = getHttpMetricsSnapshot();
  const system = getSystemMetricsSnapshot();
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();
  const access = listApprovedAccess();
  const s3 = getS3StorageConfig();
  const translatorConfigured = configured(process.env.TRANSLATOR_BATCH_JOB_QUEUE) && configured(process.env.TRANSLATOR_BATCH_JOB_DEFINITION);

  res.json({
    ts: Date.now(),
    health: {
      nodeEnv: process.env.NODE_ENV ?? "development",
      uptimeSec: Math.round(process.uptime()),
      cpu: system.cpu,
      memory: system.memory,
      disk: system.disk,
    },
    traffic: http,
    alerts: buildAlerts({ http, system, youtube, subtitles }),
    queues: {
      youtube,
      subtitles,
      translator: {
        configured: translatorConfigured,
        queueName: configured(process.env.TRANSLATOR_BATCH_JOB_QUEUE) ? process.env.TRANSLATOR_BATCH_JOB_QUEUE : null,
        jobDefinition: configured(process.env.TRANSLATOR_BATCH_JOB_DEFINITION) ? process.env.TRANSLATOR_BATCH_JOB_DEFINITION : null,
      },
    },
    features: {
      googleAuthEnabled: enabled(process.env.GOOGLE_AUTH_ENABLED),
      adminPanelEnabled: enabled(process.env.ADMIN_PANEL_ENABLED),
      youtubeQueuePrimaryEnabled: enabled(process.env.YOUTUBE_QUEUE_PRIMARY_ENABLED),
      youtubeQueueShadowEnabled: enabled(process.env.YOUTUBE_QUEUE_SHADOW_ENABLED),
      subtitlesForceLambda: enabled(process.env.SUBTITLES_FORCE_LAMBDA, true),
      translatorBatchConfigured: translatorConfigured,
      s3StorageEnabled: isS3StorageEnabled(),
      notificationsConfigured: configured(process.env.VAPID_PUBLIC_KEY) && configured(process.env.VAPID_PRIVATE_KEY),
      geminiConfigured: isGeminiConfigured() || configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    },
    limits: {
      lambdaClipMaxDurationSeconds: Number(process.env.LAMBDA_CLIP_MAX_DURATION_SECONDS ?? 480),
      subtitlesLambdaMaxDurationSeconds: Number(process.env.SUBTITLES_LAMBDA_MAX_DURATION_SECONDS ?? 600),
      maxConcurrentClipJobs: youtube.limits.maxConcurrentClipJobs,
      maxConcurrentSubtitleJobs: subtitles.limits.maxConcurrentSubtitleJobs,
      translatorMaxRuntimeMinutes: numberFromEnv("TRANSLATOR_MAX_RUNTIME_MINUTES", 30),
      monthlyBudgetUsd: numberFromEnv("MONTHLY_BUDGET_USD", 20),
      ecrKeepTaggedImages: numberFromEnv("ECR_KEEP_TAGGED_IMAGES", 3),
    },
    cost: {
      monthlyBudgetUsd: numberFromEnv("MONTHLY_BUDGET_USD", 20),
      currentMonthUsageUsd: process.env.ADMIN_CURRENT_MONTH_USAGE_USD ? Number(process.env.ADMIN_CURRENT_MONTH_USAGE_USD) : null,
      gpuMaxRuntimeMinutes: numberFromEnv("TRANSLATOR_MAX_RUNTIME_MINUTES", 30),
      gpuConcurrency: numberFromEnv("TRANSLATOR_MAX_CONCURRENT_JOBS", 1),
      notes: [
        "This panel shows configured guardrails. AWS Billing remains the source of truth.",
        "GPU cost is controlled by translation job start/stop and max runtime.",
        "ECR storage is controlled by lifecycle policy keep count.",
      ],
    },
    storage: {
      s3,
      cleanupNamespaces: [
        "youtube/downloads",
        "youtube/clips",
        "subtitles",
        "subtitles-original",
        "translator",
        "uploads",
      ],
      signedUrlTtlSec: s3.signedUrlTtlSec,
    },
    tools: [
      { key: "super-agent", label: "Super Agent", status: isGeminiConfigured() || configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ? "ready" : "needs-key", detail: "Routes user prompts to download, clip, subtitle, summarize, timestamp, translate, and sharing tools." },
      { key: "download", label: "Download", status: isS3StorageEnabled() ? "ready" : "local-only", detail: "Full video/audio downloads with downloadable result cards." },
      { key: "clip-cut", label: "Clip Cut", status: "ready", detail: `Lambda-fast clips up to ${process.env.LAMBDA_CLIP_MAX_DURATION_SECONDS ?? 480}s when eligible.` },
      { key: "best-clips", label: "Best Clips", status: isGeminiConfigured() || configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ? "ready" : "needs-key", detail: "Finds viral moments and can send cuts to clip tooling." },
      { key: "subtitles", label: "Subtitles", status: "ready", detail: `Lambda-fast subtitles up to ${process.env.SUBTITLES_LAMBDA_MAX_DURATION_SECONDS ?? 600}s when eligible.` },
      { key: "translator", label: "Translator", status: translatorConfigured ? "ready" : "needs-batch", detail: "GPU translation pipeline with optional voice cloning/lip sync." },
      { key: "timestamps", label: "Timestamps", status: isGeminiConfigured() || configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ? "ready" : "needs-key", detail: "Chapter marker generation from video/audio." },
      { key: "find-sabha", label: "Find Sabha", status: "ready", detail: "Searches sabha/date/video clues, including screenshot workflows where configured." },
      { key: "share", label: "Share", status: isS3StorageEnabled() ? "ready" : "needs-s3", detail: "Large file sharing through cloud-backed signed links." },
      { key: "google-auth", label: "Google Sign-In", status: enabled(process.env.GOOGLE_AUTH_ENABLED) ? "enabled" : "disabled", detail: "Approved Gmail allow-list login." },
    ],
    auth: {
      googleClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
      persistence: "runtime",
      approvedUserCount: access.users.length,
      approvedAdminCount: access.admins.length,
      approvedUsers: access.users,
      approvedAdmins: access.admins,
    },
  });
});

router.get("/settings", (_req, res) => {
  const access = listApprovedAccess();
  res.json({
    auth: {
      googleAuthEnabled: enabled(process.env.GOOGLE_AUTH_ENABLED),
      googleClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
      approvedUsers: access.users,
      approvedAdmins: access.admins,
    },
    processing: {
      youtubeQueuePrimaryJobTypes: splitCsv(process.env.YOUTUBE_QUEUE_PRIMARY_JOB_TYPES),
      lambdaClipMaxDurationSeconds: Number(process.env.LAMBDA_CLIP_MAX_DURATION_SECONDS ?? 480),
      subtitlesLambdaMaxDurationSeconds: Number(process.env.SUBTITLES_LAMBDA_MAX_DURATION_SECONDS ?? 600),
      translatorBatchJobQueue: process.env.TRANSLATOR_BATCH_JOB_QUEUE ? "configured" : "missing",
      translatorBatchJobDefinition: process.env.TRANSLATOR_BATCH_JOB_DEFINITION ? "configured" : "missing",
    },
    storage: {
      s3BucketConfigured: Boolean(process.env.S3_BUCKET),
      s3ObjectPrefix: process.env.S3_OBJECT_PREFIX ?? "",
      signedUrlTtlSec: Number(process.env.S3_SIGNED_URL_TTL_SEC ?? 7200),
    },
  });
});

router.post("/jobs/youtube/:jobId/cancel", async (req, res) => {
  try {
    const result = await cancelYoutubeQueueJob(String(req.params.jobId ?? ""));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to cancel job" });
  }
});

router.post("/maintenance/s3-cleanup", async (req, res) => {
  try {
    const body = req.body as { namespace?: unknown; maxAgeHours?: unknown };
    const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
    const maxAgeHours = Number(body.maxAgeHours);
    if (!namespace) {
      res.status(400).json({ error: "Missing namespace" });
      return;
    }
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1) {
      res.status(400).json({ error: "maxAgeHours must be at least 1" });
      return;
    }
    const deleted = await cleanupOldS3Objects({
      namespace,
      maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    });
    res.json({ ok: true, namespace, deleted });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to clean S3 objects" });
  }
});

router.post("/approved-emails", (req, res) => {
  try {
    const body = req.body as { email?: unknown; role?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const role: AuthRole = body.role === "admin" ? "admin" : "user";
    const result = setApprovedEmail(email, role);
    res.json({ ok: true, ...result, access: listApprovedAccess() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to update approved email" });
  }
});

router.delete("/approved-emails/:email", (req, res) => {
  const result = removeApprovedEmail(String(req.params.email ?? ""));
  res.json({ ok: true, ...result, access: listApprovedAccess() });
});

export default router;
