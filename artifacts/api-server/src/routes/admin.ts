import { Router, type IRouter } from "express";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  getHttpMetricsSnapshot,
  getSystemMetricsSnapshot,
} from "../lib/ops-metrics";
import {
  listApprovedAccess,
  refreshAllowlist,
  removeApprovedEmail,
  setApprovedEmail,
  setApiAccessEmail,
  removeApiAccessEmail,
  type AuthRole,
} from "../lib/auth-access";
import { listEmailSubmissions } from "../lib/email-submissions";
import { cancelYoutubeQueueJob } from "../lib/youtube-queue";
import {
  cleanupOldS3ObjectsDetailed,
  getS3StorageConfig,
  isS3StorageEnabled,
} from "../lib/s3-storage";
import { getSubtitlesOpsSnapshot } from "./subtitles";
import { getYoutubeOpsSnapshot } from "./youtube";
import { isGeminiConfigured } from "../lib/gemini-client";
import {
  AGENTROUTER_GPT_MODEL,
  COPILOT_ROUTE_CATALOG,
  getCopilotFallbackModels,
  getCopilotPrimaryModel,
  getCopilotProvider,
  getExternalCopilotKeyCount,
  getRouteReasoningSupport,
  isExternalCopilotConfigured,
} from "../lib/copilot-external-provider";
import {
  getCopilotLadderConfig,
  isCopilotLadderPersistent,
  refreshCopilotLadder,
  updateCopilotLadder,
  type CopilotLadderPatch,
  type CopilotMode,
} from "../lib/copilot-ladder-store";
import { getCopilotUsageOverview } from "../lib/copilot-usage";
import {
  getRuntimeFeatureState,
  setRuntimeFeature,
  setSuperAgentEmail,
  setTranslatorEmail,
  setTranslatorLipSyncEmail,
  type RuntimeFeatureKey,
} from "../lib/admin-features";

const router: IRouter = Router();
const ddb = new DynamoDBClient({
  region: process.env.YOUTUBE_QUEUE_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
});
const JOB_TABLE = process.env.YOUTUBE_QUEUE_JOB_TABLE ?? process.env.JOB_TABLE ?? "";
const cleanupHistory: Array<{
  ts: number;
  namespace: string;
  maxAgeHours: number;
  deletedCount: number;
  bytesFreed: number;
  scannedCount: number;
  ok: boolean;
  error?: string;
}> = [];
const CLEANUP_NAMESPACES = [
  "youtube/downloads",
  "youtube/clips",
  "subtitles",
  "subtitles-original",
  "translator",
  "uploads",
] as const;

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

/**
 * Prepaid AgentRouter credit pool backing the `agentrouter:gpt-5.6-sol` Copilot
 * fallback. AgentRouter exposes no usage endpoint, so spend is recorded manually
 * via AGENTROUTER_USED_USD; everything downstream of that is derived here.
 */
function agentRouterCredit(): {
  model: string;
  creditUsd: number;
  usedUsd: number | null;
  remainingUsd: number | null;
  usedPct: number | null;
} {
  const creditUsd = numberFromEnv("AGENTROUTER_CREDIT_USD", 175);
  const rawUsed = Number(process.env.AGENTROUTER_USED_USD);
  const usedUsd = Number.isFinite(rawUsed) ? Math.max(0, rawUsed) : null;
  return {
    model: AGENTROUTER_GPT_MODEL,
    creditUsd,
    usedUsd,
    remainingUsd:
      usedUsd === null
        ? null
        : Math.round(Math.max(0, creditUsd - usedUsd) * 100) / 100,
    usedPct:
      usedUsd === null || creditUsd <= 0
        ? null
        : Math.round((usedUsd / creditUsd) * 100),
  };
}

function translatorRuntimeMinutes(): number {
  const seconds = numberFromEnv("TRANSLATOR_BATCH_TIMEOUT_SECONDS", 3000);
  return Math.round(seconds / 60);
}

function configured(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function parseDdbNumber(value: any): number | null {
  const raw = value?.N ?? value?.S;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function terminalStatus(status: string): boolean {
  return ["done", "error", "failed", "cancelled", "expired", "DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(status);
}

async function listRecentDdbJobs(): Promise<any[]> {
  if (!JOB_TABLE) return [];
  const items: any[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: JOB_TABLE,
        Limit: 100,
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(out.Items ?? []));
    lastKey = out.LastEvaluatedKey;
  } while (lastKey && items.length < 500);

  return items
    .map((item) => {
      const status = item.status?.S ?? "unknown";
      const createdAt = parseDdbNumber(item.createdAt);
      const updatedAt = parseDdbNumber(item.updatedAt);
      const completedAt = parseDdbNumber(item.completedAt);
      const type =
        item.type?.S === "translator"
          ? "translator"
          : item.jobType?.S ?? item.type?.S ?? "job";
      return {
        jobId: item.jobId?.S ?? "",
        type,
        user: item.ownerId?.S ?? item.requesterId?.S ?? item.clientId?.S ?? "unknown",
        status,
        stage: item.step?.S ?? item.message?.S ?? status,
        progressPct: parseDdbNumber(item.progressPct) ?? parseDdbNumber(item.progress),
        startedAt: parseDdbNumber(item.startedAt) ?? createdAt,
        createdAt,
        updatedAt,
        completedAt,
        elapsedMs:
          completedAt && createdAt
            ? completedAt - createdAt
            : createdAt && !terminalStatus(status)
              ? Date.now() - createdAt
              : null,
        filename: item.filename?.S ?? null,
        error:
          item.error?.S ??
          (["error", "failed", "FAILED"].includes(status) ? item.message?.S : null),
        outputAvailable: Boolean(item.s3Key?.S || item.outputKey?.S),
        lipSync: item.lipSync?.BOOL ?? null,
        translation: item.type?.S === "translator" || Boolean(item.targetLang?.S),
        targetLang: item.targetLang?.S ?? null,
        runtime: item.runtime?.S ?? null,
        batchJobId: item.batchJobId?.S ?? null,
      };
    })
    .filter((job) => job.jobId);
}

function buildJobAnalytics(jobs: any[]) {
  const now = Date.now();
  const windows = [
    ["30m", 30 * 60 * 1000],
    ["1h", 60 * 60 * 1000],
    ["24h", 24 * 60 * 60 * 1000],
  ] as const;
  const out: Record<string, { total: number; active: number; completed: number; failed: number }> = {};
  for (const [key, ms] of windows) {
    const scoped = jobs.filter(
      (job) => now - Number(job.updatedAt ?? job.createdAt ?? 0) <= ms,
    );
    out[key] = {
      total: scoped.length,
      active: scoped.filter((job) => !terminalStatus(String(job.status))).length,
      completed: scoped.filter((job) => ["done", "DONE"].includes(String(job.status))).length,
      failed: scoped.filter((job) =>
        ["error", "failed", "FAILED"].includes(String(job.status)),
      ).length,
    };
  }
  return out;
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

// ── GET /overview ─────────────────────────────────────────────────────────────
router.get("/overview", async (_req, res) => {
  const http = getHttpMetricsSnapshot();
  const system = getSystemMetricsSnapshot();
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();
  const copilotUsage = await getCopilotUsageOverview().catch((err) => {
    console.warn("[admin] failed to load Copilot usage", err);
    return null;
  });
  // Always show the stored allowlist, not this container's stale cache —
  // otherwise the panel appears to "lose" emails added on another container.
  await refreshAllowlist(true);
  const access = listApprovedAccess();
  const runtime = getRuntimeFeatureState();
  const s3 = getS3StorageConfig();
  const emailSubmissions = await listEmailSubmissions(200).catch((err) => {
    console.warn("[admin] failed to scan email submissions", err);
    return [];
  });
  const translatorConfigured =
    configured(process.env.TRANSLATOR_BATCH_JOB_QUEUE) &&
    configured(process.env.TRANSLATOR_BATCH_JOB_DEFINITION);
  const ddbJobs = await listRecentDdbJobs().catch((err) => {
    console.warn("[admin] failed to scan recent jobs", err);
    return [];
  });
  const liveJobs = [
    ...((youtube as any).recentJobs ?? []),
    ...((subtitles as any).recentJobs ?? []),
    ...ddbJobs,
  ]
    .sort(
      (a, b) =>
        Number(b.updatedAt ?? b.createdAt ?? 0) -
        Number(a.updatedAt ?? a.createdAt ?? 0),
    )
    .slice(0, 80);
  const activeLiveJobs = liveJobs.filter((job) => !terminalStatus(String(job.status)));

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
    copilotUsage,
    alerts: buildAlerts({ http, system, youtube, subtitles }),
    queues: {
      youtube,
      subtitles,
      translator: {
        configured: translatorConfigured,
        queueName: configured(process.env.TRANSLATOR_BATCH_JOB_QUEUE)
          ? process.env.TRANSLATOR_BATCH_JOB_QUEUE
          : null,
        jobDefinition: configured(process.env.TRANSLATOR_BATCH_JOB_DEFINITION)
          ? process.env.TRANSLATOR_BATCH_JOB_DEFINITION
          : null,
      },
    },
    features: {
      googleAuthEnabled: enabled(process.env.GOOGLE_AUTH_ENABLED),
      adminPanelEnabled: enabled(process.env.ADMIN_PANEL_ENABLED),
      translatorEnabled: runtime.features.translatorEnabled,
      translatorLipSyncEnabled: runtime.features.translatorLipSyncEnabled,
      superAgentEnabled: runtime.features.superAgentEnabled,
      youtubeQueuePrimaryEnabled: enabled(process.env.YOUTUBE_QUEUE_PRIMARY_ENABLED),
      youtubeQueueShadowEnabled: enabled(process.env.YOUTUBE_QUEUE_SHADOW_ENABLED),
      subtitlesForceLambda: enabled(process.env.SUBTITLES_FORCE_LAMBDA, true),
      translatorBatchConfigured: translatorConfigured,
      s3StorageEnabled: isS3StorageEnabled(),
      notificationsConfigured:
        configured(process.env.VAPID_PUBLIC_KEY) &&
        configured(process.env.VAPID_PRIVATE_KEY),
      geminiConfigured:
        isGeminiConfigured() ||
        configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
      nvidiaCopilotConfigured:
        getExternalCopilotKeyCount("nvidia") > 0,
      ollamaCopilotConfigured:
        getExternalCopilotKeyCount("ollama") > 0,
      groqCopilotConfigured:
        getExternalCopilotKeyCount("groq") > 0,
      mistralCopilotConfigured: getExternalCopilotKeyCount("mistral") > 0,
      sambaNovaCopilotConfigured: getExternalCopilotKeyCount("sambanova") > 0,
      openRouterCopilotConfigured: getExternalCopilotKeyCount("openrouter") > 0,
      aionCopilotConfigured: getExternalCopilotKeyCount("aion") > 0,
      kiloCopilotConfigured: getExternalCopilotKeyCount("kilo") > 0,
      agentRouterCopilotConfigured: getExternalCopilotKeyCount("agentrouter") > 0,
      allowlistPersistence: configured(process.env.ACCESS_TABLE),
    },
    limits: {
      lambdaClipMaxDurationSeconds: Number(
        process.env.LAMBDA_CLIP_MAX_DURATION_SECONDS ?? 480,
      ),
      subtitlesLambdaMaxDurationSeconds: Number(
        process.env.SUBTITLES_LAMBDA_MAX_DURATION_SECONDS ?? 600,
      ),
      maxConcurrentClipJobs: youtube.limits.maxConcurrentClipJobs,
      maxConcurrentSubtitleJobs: subtitles.limits.maxConcurrentSubtitleJobs,
      translatorMaxRuntimeMinutes: translatorRuntimeMinutes(),
      monthlyBudgetUsd: numberFromEnv("MONTHLY_BUDGET_USD", 20),
      ecrKeepTaggedImages: numberFromEnv("ECR_KEEP_TAGGED_IMAGES", 3),
    },
    cost: {
      monthlyBudgetUsd: numberFromEnv("MONTHLY_BUDGET_USD", 20),
      currentMonthUsageUsd: process.env.ADMIN_CURRENT_MONTH_USAGE_USD
        ? Number(process.env.ADMIN_CURRENT_MONTH_USAGE_USD)
        : null,
      gpuMaxRuntimeMinutes: translatorRuntimeMinutes(),
      gpuConcurrency: numberFromEnv("TRANSLATOR_MAX_CONCURRENT_JOBS", 1),
      agentRouter: agentRouterCredit(),
      notes: [
        "This panel shows configured guardrails. AWS Billing remains the source of truth.",
        "GPU cost is controlled by translation job start/stop and max runtime.",
        "ECR storage is controlled by lifecycle policy keep count.",
        "AgentRouter credit is a prepaid pool, not an AWS cost. Spend is recorded from AGENTROUTER_USED_USD — the router has no usage API to poll.",
      ],
    },
    storage: {
      s3,
      cleanupNamespaces: CLEANUP_NAMESPACES,
      signedUrlTtlSec: s3.signedUrlTtlSec,
      cleanupHistory,
    },
    tools: [
      {
        key: "super-agent",
        label: "Super Agent",
        status:
          isGeminiConfigured() ||
          configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
            ? "ready"
            : "needs-key",
        detail:
          "Routes user prompts to download, clip, subtitle, summarize, timestamp, translate, and sharing tools.",
      },
      {
        key: "download",
        label: "Download",
        status: isS3StorageEnabled() ? "ready" : "local-only",
        detail: "Full video/audio downloads with downloadable result cards.",
      },
      {
        key: "clip-cut",
        label: "Clip Cut",
        status: "ready",
        detail: `Lambda-fast clips up to ${process.env.LAMBDA_CLIP_MAX_DURATION_SECONDS ?? 480}s when eligible.`,
      },
      {
        key: "best-clips",
        label: "Best Clips",
        status:
          isGeminiConfigured() ||
          configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
            ? "ready"
            : "needs-key",
        detail: "Finds viral moments and can send cuts to clip tooling.",
      },
      {
        key: "subtitles",
        label: "Subtitles",
        status: "ready",
        detail: `Lambda-fast subtitles up to ${process.env.SUBTITLES_LAMBDA_MAX_DURATION_SECONDS ?? 600}s when eligible.`,
      },
      {
        key: "translator",
        label: "Translator",
        status: translatorConfigured ? "ready" : "needs-batch",
        detail: "GPU translation pipeline with optional voice cloning/lip sync.",
      },
      {
        key: "timestamps",
        label: "Timestamps",
        status:
          isGeminiConfigured() ||
          configured(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
            ? "ready"
            : "needs-key",
        detail: "Chapter marker generation from video/audio.",
      },
      {
        key: "find-sabha",
        label: "Find Sabha",
        status: "ready",
        detail: "Searches sabha/date/video clues, including screenshot workflows where configured.",
      },
      {
        key: "share",
        label: "Share",
        status: isS3StorageEnabled() ? "ready" : "needs-s3",
        detail: "Large file sharing through cloud-backed signed links.",
      },
      {
        key: "google-auth",
        label: "Google Sign-In",
        status: enabled(process.env.GOOGLE_AUTH_ENABLED) ? "enabled" : "disabled",
        detail: "Approved Gmail allow-list login.",
      },
    ],
    auth: {
      googleClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
      persistence: process.env.ACCESS_TABLE ? "dynamodb" : "runtime",
      approvedUserCount: access.users.length,
      approvedAdminCount: access.admins.length,
      approvedUsers: access.users,
      approvedAdmins: access.admins,
      apiAccessEmails: access.apiAccess,
      apiAccessCount: access.apiAccess.length,
    },
    runtime,
    userMessages: {
      emailSubmissions,
      emailSubmissionCount: emailSubmissions.length,
    },
    jobs: {
      active: activeLiveJobs,
      recent: liveJobs,
      analytics: buildJobAnalytics(liveJobs),
    },
  });
});

// ── GET /settings ─────────────────────────────────────────────────────────────
router.get("/email-submissions", async (_req, res) => {
  try {
    const submissions = await listEmailSubmissions(500);
    res.json({ ok: true, submissions, count: submissions.length });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to list email submissions" });
  }
});

router.get("/settings", async (_req, res) => {
  await refreshAllowlist(true);
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
      subtitlesLambdaMaxDurationSeconds: Number(
        process.env.SUBTITLES_LAMBDA_MAX_DURATION_SECONDS ?? 600,
      ),
      translatorBatchJobQueue: process.env.TRANSLATOR_BATCH_JOB_QUEUE ? "configured" : "missing",
      translatorBatchJobDefinition: process.env.TRANSLATOR_BATCH_JOB_DEFINITION
        ? "configured"
        : "missing",
    },
    storage: {
      s3BucketConfigured: Boolean(process.env.S3_BUCKET),
      s3ObjectPrefix: process.env.S3_OBJECT_PREFIX ?? "",
      signedUrlTtlSec: Number(process.env.S3_SIGNED_URL_TTL_SEC ?? 7200),
    },
  });
});

// ── POST /jobs/youtube/:jobId/cancel ──────────────────────────────────────────
router.post("/jobs/youtube/:jobId/cancel", async (req, res) => {
  try {
    const result = await cancelYoutubeQueueJob(String(req.params.jobId ?? ""));
    res.json(result);
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to cancel job" });
  }
});

// ── POST /maintenance/s3-cleanup ──────────────────────────────────────────────
router.post("/maintenance/s3-cleanup", async (req, res) => {
  try {
    const body = req.body as { namespace?: unknown; maxAgeHours?: unknown };
    const namespace =
      typeof body.namespace === "string" ? body.namespace.trim() : "";
    const maxAgeHours = Number(body.maxAgeHours);
    if (!namespace) {
      res.status(400).json({ error: "Missing namespace" });
      return;
    }
    if (!CLEANUP_NAMESPACES.includes(namespace as (typeof CLEANUP_NAMESPACES)[number])) {
      res.status(400).json({ error: "Unsupported cleanup namespace" });
      return;
    }
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1) {
      res.status(400).json({ error: "maxAgeHours must be at least 1" });
      return;
    }
    const result = await cleanupOldS3ObjectsDetailed({
      namespace,
      maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    });
    cleanupHistory.unshift({ ts: Date.now(), namespace, maxAgeHours, ok: true, ...result });
    cleanupHistory.splice(10);
    res.json({ ok: true, namespace, deleted: result.deletedCount, ...result });
  } catch (err) {
    const body = req.body as { namespace?: unknown; maxAgeHours?: unknown };
    cleanupHistory.unshift({
      ts: Date.now(),
      namespace: typeof body.namespace === "string" ? body.namespace : "unknown",
      maxAgeHours: Number(body.maxAgeHours) || 0,
      deletedCount: 0,
      bytesFreed: 0,
      scannedCount: 0,
      ok: false,
      error: err instanceof Error ? err.message : "Failed to clean S3 objects",
    });
    cleanupHistory.splice(10);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to clean S3 objects" });
  }
});

function isValidationError(message: string): boolean {
  return message === "Email is required" || message === "Invalid email address";
}

// ── POST /approved-emails ─────────────────────────────────────────────────────
router.post("/approved-emails", async (req, res) => {
  try {
    const body = req.body as { email?: unknown; role?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const role: AuthRole = body.role === "admin" ? "admin" : "user";
    const result = await setApprovedEmail(email, role);
    res.json({ ok: true, ...result, access: listApprovedAccess() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update approved email";
    // Storage failures used to be swallowed, so the panel reported success while
    // nothing was saved. Report them as 5xx so the admin actually sees them.
    res.status(isValidationError(message) ? 400 : 500).json({ error: message });
  }
});

// ── DELETE /approved-emails/:email ────────────────────────────────────────────
router.delete("/approved-emails/:email", async (req, res) => {
  try {
    const result = await removeApprovedEmail(String(req.params.email ?? ""));
    res.json({ ok: true, ...result, access: listApprovedAccess() });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to remove approved email" });
  }
});

// ── POST /api-access ──────────────────────────────────────────────────────────
// Grant an email Developer/API access (visibility of the Developer tab + the
// ability to mint API keys). Admins always have access implicitly.
router.post("/api-access", async (req, res) => {
  try {
    const body = req.body as { email?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const result = await setApiAccessEmail(email);
    res.json({ ok: true, ...result, access: listApprovedAccess() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to grant API access";
    res.status(isValidationError(message) ? 400 : 500).json({ error: message });
  }
});

// ── DELETE /api-access/:email ─────────────────────────────────────────────────
router.delete("/api-access/:email", async (req, res) => {
  try {
    const result = await removeApiAccessEmail(String(req.params.email ?? ""));
    res.json({ ok: true, ...result, access: listApprovedAccess() });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Failed to revoke API access" });
  }
});

// ── POST /features ────────────────────────────────────────────────────────────
router.post("/features", (req, res) => {
  try {
    const body = req.body as { key?: unknown; enabled?: unknown };
    const key = String(body.key ?? "") as RuntimeFeatureKey;
    if (
      !["translatorEnabled", "translatorLipSyncEnabled", "superAgentEnabled"].includes(key)
    ) {
      res.status(400).json({ error: "Unsupported feature key" });
      return;
    }
    const enabledValue =
      typeof body.enabled === "boolean"
        ? body.enabled
        : ["1", "true", "yes", "on"].includes(
            String(body.enabled ?? "").toLowerCase(),
          );
    res.json({ ok: true, runtime: setRuntimeFeature(key, enabledValue) });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "Failed to update feature" });
  }
});

// ── POST /permissions/:feature ────────────────────────────────────────────────
// Handles: translator | super-agent | lipsync
router.post("/permissions/:feature", (req, res) => {
  try {
    const body = req.body as { email?: unknown; allowed?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const allowed =
      typeof body.allowed === "boolean"
        ? body.allowed
        : ["1", "true", "yes", "on"].includes(
            String(body.allowed ?? "true").toLowerCase(),
          );
    const feature = String(req.params.feature ?? "");
    const runtime =
      feature === "translator"
        ? setTranslatorEmail(email, allowed)
        : feature === "super-agent"
          ? setSuperAgentEmail(email, allowed)
          : feature === "lipsync"
            ? setTranslatorLipSyncEmail(email, allowed)
            : null;
    if (!runtime) {
      res.status(400).json({ error: "Unsupported permission feature" });
      return;
    }
    res.json({ ok: true, runtime });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "Failed to update permission" });
  }
});

// ── DELETE /permissions/:feature/:email ───────────────────────────────────────
// Handles: translator | super-agent | lipsync
router.delete("/permissions/:feature/:email", (req, res) => {
  try {
    const feature = String(req.params.feature ?? "");
    const email = String(req.params.email ?? "");
    const runtime =
      feature === "translator"
        ? setTranslatorEmail(email, false)
        : feature === "super-agent"
          ? setSuperAgentEmail(email, false)
          : feature === "lipsync"
            ? setTranslatorLipSyncEmail(email, false)
            : null;
    if (!runtime) {
      res.status(400).json({ error: "Unsupported permission feature" });
      return;
    }
    res.json({ ok: true, runtime });
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "Failed to remove permission" });
  }
});

// ── Super Agent model ladder ──────────────────────────────────────────────────
// Reordering the ladder or changing the primary model without a redeploy.
// Persistence lives in DynamoDB (lib/copilot-ladder-store) so a change applies
// to every Lambda container rather than only the one that served the request.

function describeLadderRoute(route: string) {
  return {
    route,
    provider: getCopilotProvider(route) ?? "unknown",
    configured: isExternalCopilotConfigured(route),
    reasoningOptions: getRouteReasoningSupport(route),
  };
}

function buildLadderState() {
  const config = getCopilotLadderConfig();
  const modes = (["ultra", "fast"] as CopilotMode[]).map((mode) => {
    const primary = getCopilotPrimaryModel(mode);
    return {
      mode,
      primary,
      overridden: config.primary[mode] !== null,
      // Exactly what a request would try, in order.
      effective: [primary, ...getCopilotFallbackModels(primary)].filter((route) =>
        isExternalCopilotConfigured(route),
      ),
    };
  });
  // The list the panel edits: the saved override when present, otherwise the
  // code ladder for the Ultra primary, so the editor opens on today's order
  // rather than an empty list.
  const editableOrder =
    config.order.length > 0
      ? config.order
      : getCopilotFallbackModels(getCopilotPrimaryModel("ultra"));

  return {
    persistent: isCopilotLadderPersistent(),
    updatedAt: config.updatedAt,
    override: config,
    modes,
    editableOrder: editableOrder.map(describeLadderRoute),
    catalog: COPILOT_ROUTE_CATALOG.map(describeLadderRoute),
  };
}

router.get("/copilot-ladder", async (_req, res) => {
  try {
    await refreshCopilotLadder(true);
    res.json(buildLadderState());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read the model ladder",
    });
  }
});

router.post("/copilot-ladder", async (req, res) => {
  try {
    const body = req.body as {
      primary?: Record<string, unknown>;
      order?: unknown;
      reasoning?: Record<string, unknown>;
    };
    const known = new Set(COPILOT_ROUTE_CATALOG);
    const patch: CopilotLadderPatch = {};

    if (body.primary && typeof body.primary === "object") {
      patch.primary = {};
      for (const mode of ["ultra", "fast"] as CopilotMode[]) {
        if (!(mode in body.primary)) continue;
        const raw = body.primary[mode];
        if (raw === null || raw === "") {
          patch.primary[mode] = null;
          continue;
        }
        const route = String(raw ?? "").trim();
        if (!known.has(route)) {
          res.status(400).json({ error: `Unknown route: ${route}` });
          return;
        }
        // A primary with no API key would fail on every request before the
        // ladder could help, so refuse rather than take Copilot down.
        if (!isExternalCopilotConfigured(route)) {
          res.status(400).json({
            error: `${route} has no configured API key, so it cannot be the primary model.`,
          });
          return;
        }
        patch.primary[mode] = route;
      }
    }

    if (body.order !== undefined) {
      if (!Array.isArray(body.order)) {
        res.status(400).json({ error: "order must be an array of routes" });
        return;
      }
      const order: string[] = [];
      for (const entry of body.order) {
        const route = String(entry ?? "").trim();
        if (!route) continue;
        if (!known.has(route)) {
          res.status(400).json({ error: `Unknown route: ${route}` });
          return;
        }
        order.push(route);
      }
      patch.order = order;
    }

    if (body.reasoning && typeof body.reasoning === "object") {
      const reasoning: Record<string, string | null> = {};
      for (const [rawRoute, rawEffort] of Object.entries(body.reasoning)) {
        const route = rawRoute.trim();
        if (!known.has(route)) {
          res.status(400).json({ error: `Unknown route: ${route}` });
          return;
        }
        if (rawEffort === null || String(rawEffort ?? "").trim() === "") {
          reasoning[route] = null;
          continue;
        }
        const effort = String(rawEffort).trim();
        const supported = getRouteReasoningSupport(route);
        // Mistral hard-rejects an unsupported value, which would drop the route
        // out of the ladder on every request.
        if (!supported.includes(effort)) {
          res.status(400).json({
            error: supported.length
              ? `${route} accepts reasoning_effort ${supported.join(", ")} — not "${effort}".`
              : `${route} does not support reasoning_effort.`,
          });
          return;
        }
        reasoning[route] = effort;
      }
      patch.reasoning = reasoning;
    }

    await updateCopilotLadder(patch);
    res.json({ ok: true, ladder: buildLadderState() });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update the model ladder",
    });
  }
});

export default router;
