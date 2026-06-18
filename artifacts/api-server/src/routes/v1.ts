import { Router, type IRouter, type Request, type Response } from "express";
import { getJobStatusFromDdb } from "../lib/youtube-queue";
import { setupSse, sseFlush } from "../lib/sse";
import { registerJobWebhook, isValidWebhookUrl, getJobWebhookStatus, maybeFireJobWebhook } from "../lib/webhooks";
import { INTERNAL_AGENT_SECRET } from "../lib/internal-agent";
import {
  registerPublicJob,
  getPublicJob,
  isPublicJobStoreEnabled,
  type PublicJobResultKind,
} from "../lib/public-jobs";
import { sendApiError, apiErrorBody, isApiErrorBody } from "../lib/api-error";
import {
  getIdempotentRecord,
  saveIdempotentRecord,
  isIdempotencyStoreEnabled,
  requestHash as idemRequestHash,
} from "../lib/idempotency";
import { isApiKeyStoreEnabled } from "../lib/api-key-auth";

// ─────────────────────────────────────────────────────────────────────────────
// Public API v1 — a clean, stable, documented surface over the studio services.
//
// Auth: every call requires an API key.
//     Authorization: Bearer vms_live_xxx        (or  X-API-Key: vms_live_xxx)
//
// These endpoints do NOT re-implement business logic. Each POST alias forwards
// the request in-process to the canonical handler (so validation, queueing,
// rate-limits, and behaviour stay identical), records the job in the public job
// registry, then returns a consistent envelope that ONLY exposes stable v1 URLs
// (never the internal /api/<service>/... routes).
//
// The unified GET /jobs/{id}, /jobs/{id}/events and /jobs/{id}/cancel resolve
// the registry to route to the correct backend, so they work for EVERY
// operation — not just the ones that persist to the shared YouTube job table.
// ─────────────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

type Operation = {
  /** v1 path segment, e.g. "clips" */
  op: string;
  /** canonical in-app path the request is forwarded to (under /api) */
  target: string;
  /** body field the canonical handler expects the media URL in */
  urlKey: "url" | "fileUrl";
  /** human description */
  summary: string;
  /** kind of input URL expected */
  input: "youtube" | "media";
  /** shape of the terminal result for this operation */
  resultKind: PublicJobResultKind;
  /** build the canonical status polling URL for a returned jobId */
  statusUrl: (jobId: string) => string;
  /** build the canonical SSE stream URL, when one exists */
  streamUrl?: (jobId: string) => string;
  /** build the canonical cancel URL, when the operation supports it */
  cancelUrl?: (jobId: string) => string;
  /** extra documented optional fields */
  fields?: Record<string, string>;
};

const OPERATIONS: Operation[] = [
  {
    op: "clips",
    target: "/api/youtube/clips",
    urlKey: "url",
    input: "youtube",
    resultKind: "clips",
    summary: "Find the best viral clips in a YouTube video (AI).",
    statusUrl: (id) => `/api/youtube/clips/status/${id}`,
    streamUrl: (id) => `/api/youtube/clips/stream/${id}`,
    cancelUrl: (id) => `/api/youtube/cancel/${id}`,
    fields: { durations: "number[] of target clip lengths", auto: "boolean", instructions: "string" },
  },
  {
    op: "clip-cut",
    target: "/api/youtube/clip-cut",
    urlKey: "url",
    input: "youtube",
    resultKind: "file",
    summary: "Cut a precise clip from a YouTube video.",
    statusUrl: (id) => `/api/youtube/progress/${id}`,
    streamUrl: (id) => `/api/youtube/progress/stream/${id}`,
    cancelUrl: (id) => `/api/youtube/cancel/${id}`,
  },
  {
    op: "download",
    target: "/api/youtube/download",
    urlKey: "url",
    input: "youtube",
    resultKind: "file",
    summary: "Download a full YouTube video or audio.",
    statusUrl: (id) => `/api/youtube/progress/${id}`,
    streamUrl: (id) => `/api/youtube/progress/stream/${id}`,
    cancelUrl: (id) => `/api/youtube/cancel/${id}`,
    fields: { formatId: "string format id (or 'best')", audioOnly: "boolean" },
  },
  {
    op: "timestamps",
    target: "/api/youtube/timestamps",
    urlKey: "url",
    input: "youtube",
    resultKind: "chapters",
    summary: "Generate chapter timestamps for a YouTube video (AI).",
    statusUrl: (id) => `/api/youtube/timestamps/status/${id}`,
    streamUrl: (id) => `/api/youtube/timestamps/stream/${id}`,
    fields: { instructions: "string" },
  },
  {
    op: "subtitles",
    target: "/api/subtitles/generate-from-url",
    urlKey: "fileUrl",
    input: "media",
    resultKind: "subtitles",
    summary: "Transcribe a publicly-accessible media URL into subtitles.",
    statusUrl: (id) => `/api/subtitles/status/${id}`,
    cancelUrl: (id) => `/api/subtitles/cancel/${id}`,
    fields: { language: "BCP-47 code or 'auto'", translateTo: "target language code" },
  },
  {
    op: "translate",
    target: "/api/translator/submit-from-url",
    urlKey: "fileUrl",
    input: "media",
    resultKind: "translation",
    summary: "Translate / dub a publicly-accessible video URL (GPU).",
    statusUrl: (id) => `/api/translator/status/${id}`,
    cancelUrl: (id) => `/api/translator/cancel/${id}`,
    fields: {
      targetLang: "e.g. 'Hindi'",
      targetLangCode: "e.g. 'hi'",
      sourceLang: "e.g. 'auto'",
      voiceClone: "boolean",
      lipSync: "boolean",
    },
  },
];

const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.op, o]));

// ── Internal call helpers (same-process localhost; bypasses the key gate) ────
function internalBase(req: Request): string {
  const env = (process.env.INTERNAL_API_BASE ?? "").trim();
  if (env) return env.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http");
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000");
  return `${proto}://${host}`;
}

async function internalCall(
  req: Request,
  path: string,
  method: "GET" | "POST",
  clientId?: string,
): Promise<{ ok: boolean; status: number; json: any }> {
  const url = `${internalBase(req)}${path}`;
  const headers: Record<string, string> = { "x-internal-agent": INTERNAL_AGENT_SECRET };
  // Replicate the owner id the create path used, so owner-scoped status/cancel
  // endpoints (translator, subtitles) resolve the job correctly.
  if (clientId) headers["x-client-id"] = clientId;
  try {
    const r = await fetch(url, { method, headers });
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: { error: err instanceof Error ? err.message : "internal call failed" },
    };
  }
}

/** The owner client-id for a registry record (matches the gate's `key:<id>`). */
function ownerClientId(ownerKeyId: string): string | undefined {
  return ownerKeyId ? `key:${ownerKeyId}` : undefined;
}

// ── Status normalization (shape-tolerant across heterogeneous services) ──────
type PublicStatus =
  | "pending"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "expired";

const DONE_WORDS = new Set(["done", "completed", "complete", "success", "succeeded", "finished", "ready"]);
const ERROR_WORDS = new Set(["error", "failed", "failure", "errored"]);
const CANCELLED_WORDS = new Set(["cancelled", "canceled", "cancel", "aborted"]);
const EXPIRED_WORDS = new Set(["expired", "gone"]);
const QUEUED_WORDS = new Set(["queued", "pending", "waiting", "submitted", "accepted", "created"]);
const RUNNING_WORDS = new Set([
  "running", "processing", "in_progress", "inprogress", "working", "started",
  "downloading", "transcribing", "translating", "analyzing", "rendering", "uploading",
]);

/** Map any service-specific status string to the stable public lowercase enum. */
function canonicalStatus(raw: string): PublicStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  if (DONE_WORDS.has(s)) return "done";
  if (ERROR_WORDS.has(s)) return "error";
  if (CANCELLED_WORDS.has(s)) return "cancelled";
  if (EXPIRED_WORDS.has(s)) return "expired";
  if (QUEUED_WORDS.has(s)) return "queued";
  if (RUNNING_WORDS.has(s)) return "running";
  if (!s || s === "unknown") return "pending";
  return "running"; // unknown-but-present states are treated as in-flight
}

const TERMINAL_STATUSES = new Set<PublicStatus>(["done", "error", "cancelled", "expired"]);

function normalizeStatus(op: Operation | undefined, jobId: string, raw: any, origin: string) {
  const r = raw && typeof raw === "object" ? raw : {};
  const rawStatus =
    String(r.status ?? r.state ?? (r.done ? "done" : r.error ? "error" : "")).trim() || "unknown";
  const status = canonicalStatus(rawStatus);
  const terminal = TERMINAL_STATUSES.has(status);
  const succeeded = status === "done";
  const failed = status === "error";
  const message = (r.message ?? r.error ?? r.detail ?? null) as string | null;
  const progressPct = (r.progressPct ?? r.progress ?? r.percent ?? null) as number | null;

  let result: Record<string, unknown> | null = null;
  if (succeeded) {
    switch (op?.resultKind) {
      case "file":
        result = { type: "file", url: `${origin}/api/youtube/file/${jobId}` };
        break;
      case "clips":
        result = { type: "clips", clips: r.clips ?? r.result?.clips ?? r.result ?? null };
        break;
      case "chapters":
        result = {
          type: "chapters",
          chapters: r.timestamps ?? r.chapters ?? r.result?.chapters ?? r.result ?? null,
        };
        break;
      case "subtitles":
        result = {
          type: "subtitles",
          srtUrl: r.srtUrl ?? r.result?.srtUrl ?? null,
          text: r.text ?? r.transcript ?? r.result?.text ?? null,
        };
        break;
      case "translation":
        result = {
          type: "translation",
          outputUrl: r.outputUrl ?? r.downloadUrl ?? r.result?.outputUrl ?? null,
        };
        break;
      default:
        result = null;
    }
  }

  return {
    jobId,
    op: op?.op ?? null,
    status,
    rawStatus,
    terminal,
    succeeded,
    failed,
    ready: terminal, // back-compat alias
    message,
    progressPct,
    result,
    statusUrl: `${origin}/api/v1/jobs/${jobId}`,
    eventsUrl: `${origin}/api/v1/jobs/${jobId}/events`,
    cancelUrl: op?.cancelUrl ? `${origin}/api/v1/jobs/${jobId}/cancel` : null,
    raw: r,
  };
}

/** Public-facing origin for building absolute URLs (prefers PUBLIC_SITE_URL). */
function publicOrigin(req: Request): string {
  const env = (process.env.PUBLIC_SITE_URL ?? "").trim();
  if (env) return env.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.get("host") ?? "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

function requestingKeyId(res: Response): string {
  return (res.locals.apiKey as { keyId?: string } | undefined)?.keyId ?? "";
}

// ── Discovery catalog ────────────────────────────────────────────────────────
router.get("/", (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "VideoMaking Studio API",
    version: "v1",
    auth: {
      scheme: "bearer",
      header: "Authorization: Bearer vms_live_...",
      alternativeHeader: "X-API-Key: vms_live_...",
    },
    jobModel:
      "POST an operation to start a job; it returns { jobId, status, statusUrl, eventsUrl, cancelUrl }. " +
      "Poll statusUrl, subscribe to eventsUrl (SSE), or register a webhook for completion.",
    realtime: {
      sse: "GET /api/v1/jobs/{jobId}/events (Server-Sent Events; emits 'status' and 'done').",
      webhook:
        "Include `webhookUrl` (https) in the create body to receive an HMAC-signed POST on completion. " +
        "Verify X-VMS-Signature: sha256=HMAC_SHA256(body, WEBHOOK_SIGNING_SECRET).",
    },
    operations: OPERATIONS.map((o) => ({
      operation: o.op,
      method: "POST",
      path: `/api/v1/${o.op}`,
      summary: o.summary,
      input: o.input === "youtube" ? "{ url: <youtube url>, ... }" : "{ url: <public media url>, ... }",
      optionalFields: o.fields ?? {},
      cancellable: Boolean(o.cancelUrl),
    })),
    jobStatus: { method: "GET", path: "/api/v1/jobs/{jobId}" },
    jobEvents: { method: "GET", path: "/api/v1/jobs/{jobId}/events" },
    jobCancel: { method: "POST", path: "/api/v1/jobs/{jobId}/cancel" },
    openapi: `${origin}/api/v1/openapi.json`,
  });
});

// ── Health / key check ───────────────────────────────────────────────────────
// A lightweight, key-authenticated probe. Doubles as a "does my key work?"
// check for clients and dashboards.
router.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "videomaking-studio-api",
    version: "v1",
    time: new Date().toISOString(),
    components: {
      apiKeyStore: isApiKeyStoreEnabled(),
      jobRegistry: isPublicJobStoreEnabled(),
      idempotency: isIdempotencyStoreEnabled(),
    },
  });
});

// ── OpenAPI document (self-contained; independent of the internal orval spec) ──

// Proper JSON-schema types for known optional fields (so the spec isn't
// all-strings). Anything not listed defaults to string.
const FIELD_SCHEMA: Record<string, { type: string; items?: { type: string } }> = {
  durations: { type: "array", items: { type: "number" } },
  auto: { type: "boolean" },
  audioOnly: { type: "boolean" },
  voiceClone: { type: "boolean" },
  lipSync: { type: "boolean" },
};

function exampleBodyFor(o: Operation): Record<string, unknown> {
  const ex: Record<string, unknown> = {
    url: o.input === "youtube" ? "https://www.youtube.com/watch?v=dQw4w9WgXcQ" : "https://example.com/video.mp4",
  };
  if (o.op === "clips") ex.durations = [30, 60];
  if (o.op === "translate") {
    ex.targetLang = "Hindi";
    ex.targetLangCode = "hi";
  }
  if (o.op === "subtitles") ex.language = "auto";
  ex.webhookUrl = "https://your-server.example.com/hooks/vms";
  return ex;
}

router.get("/openapi.json", (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  const paths: Record<string, unknown> = {};

  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  });
  const commonErrorResponses = {
    "400": errorResponse("Invalid request"),
    "401": errorResponse("Missing/invalid API key"),
    "403": errorResponse("API key not permitted (scope)"),
    "429": errorResponse("Rate limit or monthly quota exceeded"),
  };

  for (const o of OPERATIONS) {
    const props: Record<string, unknown> = {
      url: { type: "string", description: o.input === "youtube" ? "YouTube URL" : "Public media URL" },
    };
    for (const [k, v] of Object.entries(o.fields ?? {})) {
      props[k] = { ...(FIELD_SCHEMA[k] ?? { type: "string" }), description: v };
    }
    props.webhookUrl = { type: "string", description: "Optional https URL for an HMAC-signed completion callback" };
    paths[`/api/v1/${o.op}`] = {
      post: {
        operationId: `v1_${o.op.replace(/-/g, "_")}`,
        summary: o.summary,
        tags: ["operations"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Optional. Retrying with the same key + body replays the original job instead of creating a duplicate.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["url"], properties: props },
              examples: { default: { value: exampleBodyFor(o) } },
            },
          },
        },
        responses: {
          "200": {
            description: "Job accepted",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JobAccepted" },
                examples: {
                  default: {
                    value: {
                      jobId: "a1b2c3d4",
                      status: "queued",
                      rawStatus: "queued",
                      statusUrl: `${origin}/api/v1/jobs/a1b2c3d4`,
                      eventsUrl: `${origin}/api/v1/jobs/a1b2c3d4/events`,
                      cancelUrl: o.cancelUrl ? `${origin}/api/v1/jobs/a1b2c3d4/cancel` : null,
                      webhookRegistered: false,
                    },
                  },
                },
              },
            },
          },
          ...commonErrorResponses,
        },
      },
    };
  }

  paths["/api/v1/health"] = {
    get: {
      operationId: "v1_health",
      summary: "Lightweight health / key check.",
      tags: ["jobs"],
      security: [{ bearerAuth: [] }],
      responses: { "200": { description: "Service healthy" } },
    },
  };
  paths["/api/v1/jobs/{jobId}"] = {
    get: {
      operationId: "v1_job_status",
      summary: "Get the status of a job.",
      tags: ["jobs"],
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Job status",
          content: { "application/json": { schema: { $ref: "#/components/schemas/JobStatus" } } },
        },
        "404": errorResponse("Job not found"),
      },
    },
  };
  paths["/api/v1/jobs/{jobId}/events"] = {
    get: {
      operationId: "v1_job_events",
      summary: "Server-Sent Events stream of job progress (emits 'status' then 'done').",
      tags: ["jobs"],
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "text/event-stream of status/done events", content: { "text/event-stream": {} } },
        "404": errorResponse("Job not found"),
      },
    },
  };
  paths["/api/v1/jobs/{jobId}/cancel"] = {
    post: {
      operationId: "v1_job_cancel",
      summary: "Cancel a running job (when the operation supports it).",
      tags: ["jobs"],
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Cancellation requested",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  jobId: { type: "string" },
                  op: { type: "string" },
                  cancelled: { type: "boolean" },
                  detail: { type: "object", nullable: true, additionalProperties: true },
                },
              },
            },
          },
        },
        "400": errorResponse("Operation not cancellable"),
        "404": errorResponse("Job not found"),
      },
    },
  };

  const statusEnum = ["pending", "queued", "running", "done", "error", "cancelled", "expired"];

  res.json({
    openapi: "3.1.0",
    info: {
      title: "VideoMaking Studio API",
      version: "1.0.0",
      description:
        "Programmatic access to all studio services via a single API key. " +
        "Every operation is asynchronous: POST to start a job, then poll the statusUrl, " +
        "subscribe to the eventsUrl (SSE), or register a webhook.",
    },
    servers: [{ url: origin }],
    tags: [
      { name: "operations", description: "Start jobs" },
      { name: "jobs", description: "Track, stream, and cancel jobs" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "vms_live_*" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "retryable"],
              properties: {
                code: { type: "string", description: "Stable machine-readable error code", example: "RATE_LIMIT_EXCEEDED" },
                message: { type: "string" },
                retryable: { type: "boolean" },
                retryAfterSec: { type: "integer", nullable: true },
                details: { type: "object", nullable: true, additionalProperties: true },
              },
            },
          },
        },
        JobAccepted: {
          type: "object",
          required: ["jobId", "status", "statusUrl", "eventsUrl"],
          properties: {
            jobId: { type: "string" },
            status: { type: "string", enum: statusEnum },
            rawStatus: { type: "string", description: "Original service status before normalization" },
            statusUrl: { type: "string" },
            eventsUrl: { type: "string" },
            cancelUrl: { type: "string", nullable: true },
            webhookRegistered: { type: "boolean" },
          },
        },
        JobStatus: {
          type: "object",
          required: ["jobId", "status", "terminal", "succeeded", "failed"],
          properties: {
            jobId: { type: "string" },
            op: { type: "string", nullable: true },
            status: { type: "string", enum: statusEnum },
            rawStatus: { type: "string" },
            terminal: { type: "boolean" },
            succeeded: { type: "boolean" },
            failed: { type: "boolean" },
            ready: { type: "boolean", description: "Alias of `terminal` (back-compat)" },
            message: { type: "string", nullable: true },
            progressPct: { type: "number", nullable: true },
            result: {
              type: "object",
              nullable: true,
              description: "Present only on success; shape depends on the operation.",
              properties: { type: { type: "string", enum: ["file", "clips", "chapters", "subtitles", "translation"] } },
              additionalProperties: true,
            },
            statusUrl: { type: "string" },
            eventsUrl: { type: "string" },
            cancelUrl: { type: "string", nullable: true },
          },
        },
        WebhookEvent: {
          type: "object",
          description: "POSTed to your webhookUrl on completion; signed via X-VMS-Signature.",
          properties: {
            jobId: { type: "string" },
            status: { type: "string", enum: statusEnum },
            message: { type: "string", nullable: true },
            ready: { type: "boolean" },
            timestamp: { type: "integer", description: "epoch ms" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  });
});

// ── Unified job status (works for every operation via the registry) ──────────
router.get("/jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    sendApiError(res, 400, "INVALID_REQUEST", "jobId is required.");
    return;
  }
  try {
    const origin = publicOrigin(req);
    const reg = await getPublicJob(jobId);
    if (reg && reg.op) {
      // Ownership: a key may only read its own jobs (don't leak others' jobIds).
      const keyId = requestingKeyId(res);
      if (reg.ownerKeyId && keyId && reg.ownerKeyId !== keyId) {
        sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
        return;
      }
      const op = OP_BY_NAME.get(reg.op);
      const { json } = await internalCall(req, reg.statusPath, "GET", ownerClientId(reg.ownerKeyId));
      const normalized = normalizeStatus(op, jobId, json, origin);
      // Non-youtube ops don't flow through the queue chokepoint, so deliver any
      // registered webhook here when we observe a terminal state (idempotent).
      if (normalized.terminal) {
        void maybeFireJobWebhook(jobId, normalized.status, { message: normalized.message });
      }
      res.json(normalized);
      return;
    }

    // Fallback: shared YouTube job table (jobs created outside the v1 surface).
    const status = await getJobStatusFromDdb(jobId);
    if (!status) {
      sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
    const canonical = canonicalStatus(status.status);
    const terminal = TERMINAL_STATUSES.has(canonical);
    res.json({
      jobId,
      op: null,
      status: canonical,
      rawStatus: status.status,
      terminal,
      succeeded: canonical === "done",
      failed: canonical === "error",
      ready: terminal,
      message: status.message || null,
      progressPct: status.progressPct ?? null,
      result:
        canonical === "done" && status.s3Key
          ? { type: "file", url: `${origin}/api/youtube/file/${jobId}` }
          : null,
      statusUrl: `${origin}/api/v1/jobs/${jobId}`,
      eventsUrl: `${origin}/api/v1/jobs/${jobId}/events`,
      cancelUrl: `${origin}/api/v1/jobs/${jobId}/cancel`,
    });
  } catch (err) {
    sendApiError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : "Failed to fetch job status", { retryable: true });
  }
});

// ── Unified cancel (routes to the correct backend via the registry) ──────────
router.post("/jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    sendApiError(res, 400, "INVALID_REQUEST", "jobId is required.");
    return;
  }
  try {
    const reg = await getPublicJob(jobId);
    if (!reg) {
      sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
    const keyId = requestingKeyId(res);
    if (reg.ownerKeyId && keyId && reg.ownerKeyId !== keyId) {
      sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
    if (!reg.cancelPath) {
      sendApiError(res, 400, "NOT_CANCELLABLE", `Operation '${reg.op}' does not support cancellation.`);
      return;
    }
    const { ok, status, json } = await internalCall(req, reg.cancelPath, "POST", ownerClientId(reg.ownerKeyId));
    res.status(ok ? 200 : status || 502).json({
      jobId,
      op: reg.op,
      cancelled: ok,
      detail: json ?? null,
    });
  } catch (err) {
    sendApiError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : "Failed to cancel job", { retryable: true });
  }
});

// ── Unified realtime stream (poll-based SSE; works for every operation) ──────
router.get("/jobs/:jobId/events", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    sendApiError(res, 400, "INVALID_REQUEST", "jobId is required.");
    return;
  }

  const reg = await getPublicJob(jobId);
  const op = reg ? OP_BY_NAME.get(reg.op) : undefined;
  if (reg && reg.ownerKeyId) {
    const keyId = requestingKeyId(res);
    if (keyId && reg.ownerKeyId !== keyId) {
      sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
  }

  setupSse(res);
  const origin = publicOrigin(req);
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sseFlush(res);
  };

  const deadline = Date.now() + 15 * 60 * 1000; // 15 min cap
  let lastKey = "";

  while (!closed && Date.now() < deadline) {
    let normalized: ReturnType<typeof normalizeStatus> | null = null;
    try {
      if (reg && reg.statusPath) {
        const { json } = await internalCall(req, reg.statusPath, "GET", ownerClientId(reg.ownerKeyId));
        normalized = normalizeStatus(op, jobId, json, origin);
      } else {
        const status = await getJobStatusFromDdb(jobId);
        if (status) {
          const canonical = canonicalStatus(status.status);
          const terminal = TERMINAL_STATUSES.has(canonical);
          normalized = {
            jobId,
            op: null,
            status: canonical,
            rawStatus: status.status,
            terminal,
            succeeded: canonical === "done",
            failed: canonical === "error",
            ready: terminal,
            message: status.message || null,
            progressPct: status.progressPct ?? null,
            result:
              canonical === "done" && status.s3Key
                ? { type: "file", url: `${origin}/api/youtube/file/${jobId}` }
                : null,
            statusUrl: `${origin}/api/v1/jobs/${jobId}`,
            eventsUrl: `${origin}/api/v1/jobs/${jobId}/events`,
            cancelUrl: `${origin}/api/v1/jobs/${jobId}/cancel`,
            raw: status as unknown as Record<string, unknown>,
          };
        }
      }
    } catch {
      /* transient */
    }

    if (normalized) {
      const key = `${normalized.status}:${normalized.progressPct ?? ""}:${normalized.message ?? ""}`;
      if (key !== lastKey) {
        lastKey = key;
        send("status", normalized);
      }
      if (normalized.terminal) {
        // Deliver any registered webhook (idempotent) — covers ops that don't
        // flow through the youtube-queue chokepoint.
        void maybeFireJobWebhook(jobId, normalized.status, { message: normalized.message });
        send("done", {
          jobId,
          status: normalized.status,
          succeeded: normalized.succeeded,
          failed: normalized.failed,
          result: normalized.result,
        });
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!closed) res.end();
});

// ── Webhook delivery status for a job (owner-scoped) ─────────────────────────
router.get("/jobs/:jobId/webhook", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    sendApiError(res, 400, "INVALID_REQUEST", "jobId is required.");
    return;
  }
  try {
    const reg = await getPublicJob(jobId);
    const keyId = requestingKeyId(res);
    if (reg && reg.ownerKeyId && keyId && reg.ownerKeyId !== keyId) {
      sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
    const wh = await getJobWebhookStatus(jobId);
    if (!wh) {
      res.json({ jobId, registered: false });
      return;
    }
    // Owner check against the webhook row's keyId too (covers legacy jobs).
    if (wh.ownerKeyId && keyId && wh.ownerKeyId !== keyId) {
      sendApiError(res, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
    res.json({
      jobId,
      registered: wh.registered,
      url: wh.url ?? null,
      delivered: wh.fired ?? false,
      attempts: wh.attempts ?? 0,
      lastDeliveryStatus: wh.lastDeliveryStatus ?? null,
      lastDeliveryCode: wh.lastDeliveryCode ?? null,
      lastDeliveryAt: wh.lastDeliveryAt ?? null,
    });
  } catch (err) {
    sendApiError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : "Failed to read webhook status", { retryable: true });
  }
});

// ── v1 uploads: thin passthrough to the canonical uploads service ────────────
// Uploads are not job-based; forward the request in-process to the canonical
// handler (auth + scope re-enforced) without transforming the response.
function forwardUpload(method: "GET" | "POST" | "DELETE", v1Path: string, target: (req: Request) => string) {
  const handler = (req: Request, res: Response) => {
    req.url = target(req);
    (req as Request & { originalUrl: string }).originalUrl = req.url;
    (req.app as unknown as { handle: (rq: Request, rs: Response) => void }).handle(req, res);
  };
  if (method === "GET") router.get(v1Path, handler);
  else if (method === "POST") router.post(v1Path, handler);
  else router.delete(v1Path, handler);
}

forwardUpload("POST", "/uploads/presign", () => "/api/uploads/presign");
forwardUpload("POST", "/uploads/complete", () => "/api/uploads/complete");
forwardUpload("GET", "/uploads/:fileId", (req) => `/api/uploads/file/${encodeURIComponent(String(req.params.fileId))}`);
forwardUpload("DELETE", "/uploads/:fileId", (req) => `/api/uploads/file/${encodeURIComponent(String(req.params.fileId))}`);

// ── POST aliases: forward in-process to the canonical handler ────────────────
function registerAlias(o: Operation) {
  router.post(`/${o.op}`, async (req: Request, res: Response) => {
    // Normalize the v1 body: accept `url` and map it to the canonical field.
    const body = (req.body && typeof req.body === "object" ? { ...req.body } : {}) as Record<string, unknown>;
    if (typeof body.url === "string" && o.urlKey !== "url") {
      body[o.urlKey] = body.url;
      delete body.url;
    }
    // Pull off the optional per-job webhook URL — canonical handlers ignore it.
    const webhookUrl = typeof body.webhookUrl === "string" ? body.webhookUrl : null;
    delete body.webhookUrl;
    req.body = body;

    const keyId = requestingKeyId(res);
    const origin = publicOrigin(req);

    // Idempotency: replay the stored response when the same key + body is
    // retried; reject the same key with a different body.
    const idemKey = String(
      req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"] ?? "",
    ).trim();
    const reqHash = idemKey ? idemRequestHash(o.op, keyId, body) : "";
    if (idemKey) {
      const existing = await getIdempotentRecord(keyId, idemKey);
      if (existing) {
        if (existing.requestHash && existing.requestHash !== reqHash) {
          sendApiError(
            res,
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This Idempotency-Key was already used with a different request body.",
          );
          return;
        }
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200).json(existing.response);
        return;
      }
    }

    // Build the v1-only envelope (absolute URLs; never leaks internal paths).
    const envelope = (jobId: string, status: string, webhookRegistered: boolean) => ({
      jobId,
      status: canonicalStatus(status),
      rawStatus: status || "queued",
      statusUrl: `${origin}/api/v1/jobs/${jobId}`,
      eventsUrl: `${origin}/api/v1/jobs/${jobId}/events`,
      cancelUrl: o.cancelUrl ? `${origin}/api/v1/jobs/${jobId}/cancel` : null,
      webhookRegistered,
    });

    // Normalize the canonical response into the consistent v1 envelope.
    const originalJson = res.json.bind(res);
    (res as Response).json = ((payload: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        const jobId = (p.jobId ?? p.id) as string | undefined;
        if (jobId) {
          void (async () => {
            let webhookRegistered = false;
            try {
              // Record the job so the unified endpoints can route to it.
              await registerPublicJob({
                jobId,
                op: o.op,
                ownerKeyId: keyId,
                statusPath: o.statusUrl(jobId),
                streamPath: o.streamUrl ? o.streamUrl(jobId) : undefined,
                cancelPath: o.cancelUrl ? o.cancelUrl(jobId) : undefined,
                resultKind: o.resultKind,
                createdAt: Date.now(),
              });
              webhookRegistered =
                webhookUrl && isValidWebhookUrl(webhookUrl)
                  ? await registerJobWebhook(
                      jobId,
                      webhookUrl,
                      keyId,
                      (res.locals.apiKey as { webhookSecret?: string } | undefined)?.webhookSecret,
                    )
                  : false;
            } catch {
              /* never let bookkeeping break the response */
            }
            const body = envelope(jobId, p.status as string, webhookRegistered);
            if (idemKey) {
              await saveIdempotentRecord(keyId, idemKey, {
                requestHash: reqHash,
                response: body,
                jobId,
                createdAt: Date.now(),
              });
            }
            if (!res.headersSent) {
              originalJson(body);
            }
          })();
          return res as Response;
        }
      }
      // Wrap upstream (canonical handler) error responses in the structured
      // envelope so clients see one consistent error shape across v1.
      if (res.statusCode >= 400 && payload && typeof payload === "object" && !isApiErrorBody(payload)) {
        const p = payload as Record<string, unknown>;
        const message =
          (typeof p.error === "string" && p.error) ||
          (typeof p.message === "string" && p.message) ||
          "Request failed.";
        const code =
          res.statusCode === 400
            ? "UPSTREAM_VALIDATION"
            : res.statusCode === 404
              ? "NOT_FOUND"
              : res.statusCode === 429
                ? "RATE_LIMIT_EXCEEDED"
                : res.statusCode >= 500
                  ? "UPSTREAM_ERROR"
                  : "REQUEST_FAILED";
        return originalJson(
          apiErrorBody(code, String(message), { retryable: res.statusCode >= 500 || res.statusCode === 429 }),
        );
      }
      return originalJson(payload as any);
    }) as Response["json"];

    // Re-dispatch through the full app pipeline at the canonical path. This
    // re-runs auth (key re-verified) and enforces the canonical service scope.
    req.url = o.target;
    (req as Request & { originalUrl: string }).originalUrl = o.target;
    (req.app as unknown as { handle: (rq: Request, rs: Response) => void }).handle(req, res);
  });
}

for (const o of OPERATIONS) registerAlias(o);

export default router;
