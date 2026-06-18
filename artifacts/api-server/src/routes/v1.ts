import { Router, type IRouter, type Request, type Response } from "express";
import { getJobStatusFromDdb } from "../lib/youtube-queue";
import { setupSse, sseFlush } from "../lib/sse";
import { registerJobWebhook, isValidWebhookUrl } from "../lib/webhooks";
import { INTERNAL_AGENT_SECRET } from "../lib/internal-agent";
import {
  registerPublicJob,
  getPublicJob,
  type PublicJobResultKind,
} from "../lib/public-jobs";

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

// ── OpenAPI document (self-contained; independent of the internal orval spec) ──
router.get("/openapi.json", (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  const paths: Record<string, unknown> = {};
  for (const o of OPERATIONS) {
    const props: Record<string, unknown> = {
      url: { type: "string", description: o.input === "youtube" ? "YouTube URL" : "Public media URL" },
    };
    for (const [k, v] of Object.entries(o.fields ?? {})) props[k] = { type: "string", description: v };
    props.webhookUrl = { type: "string", description: "Optional https URL for an HMAC-signed completion callback" };
    paths[`/api/v1/${o.op}`] = {
      post: {
        operationId: `v1_${o.op.replace(/-/g, "_")}`,
        summary: o.summary,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["url"], properties: props },
            },
          },
        },
        responses: {
          "200": {
            description: "Job accepted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string" },
                    status: { type: "string" },
                    statusUrl: { type: "string" },
                    eventsUrl: { type: "string" },
                    cancelUrl: { type: "string", nullable: true },
                    webhookRegistered: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  paths["/api/v1/jobs/{jobId}"] = {
    get: {
      operationId: "v1_job_status",
      summary: "Get the status of a job.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "Job status" }, "404": { description: "Not found" } },
    },
  };
  paths["/api/v1/jobs/{jobId}/cancel"] = {
    post: {
      operationId: "v1_job_cancel",
      summary: "Cancel a running job (when the operation supports it).",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Cancellation requested" },
        "400": { description: "Operation not cancellable" },
        "404": { description: "Not found" },
      },
    },
  };

  res.json({
    openapi: "3.1.0",
    info: { title: "VideoMaking Studio API", version: "1.0.0", description: "Programmatic access to all studio services via a single API key." },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "vms_live_*" },
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
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  try {
    const origin = publicOrigin(req);
    const reg = await getPublicJob(jobId);
    if (reg && reg.op) {
      // Ownership: a key may only read its own jobs (don't leak others' jobIds).
      const keyId = requestingKeyId(res);
      if (reg.ownerKeyId && keyId && reg.ownerKeyId !== keyId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      const op = OP_BY_NAME.get(reg.op);
      const { json } = await internalCall(req, reg.statusPath, "GET", ownerClientId(reg.ownerKeyId));
      res.json(normalizeStatus(op, jobId, json, origin));
      return;
    }

    // Fallback: shared YouTube job table (jobs created outside the v1 surface).
    const status = await getJobStatusFromDdb(jobId);
    if (!status) {
      res.status(404).json({ error: "Job not found." });
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
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch job status" });
  }
});

// ── Unified cancel (routes to the correct backend via the registry) ──────────
router.post("/jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  try {
    const reg = await getPublicJob(jobId);
    if (!reg) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const keyId = requestingKeyId(res);
    if (reg.ownerKeyId && keyId && reg.ownerKeyId !== keyId) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (!reg.cancelPath) {
      res.status(400).json({ error: `Operation '${reg.op}' does not support cancellation` });
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
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to cancel job" });
  }
});

// ── Unified realtime stream (poll-based SSE; works for every operation) ──────
router.get("/jobs/:jobId/events", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }

  const reg = await getPublicJob(jobId);
  const op = reg ? OP_BY_NAME.get(reg.op) : undefined;
  if (reg && reg.ownerKeyId) {
    const keyId = requestingKeyId(res);
    if (keyId && reg.ownerKeyId !== keyId) {
      res.status(404).json({ error: "Job not found" });
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

// ── POST aliases: forward in-process to the canonical handler ────────────────
function registerAlias(o: Operation) {
  router.post(`/${o.op}`, (req: Request, res: Response) => {
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
                  ? await registerJobWebhook(jobId, webhookUrl, keyId)
                  : false;
            } catch {
              /* never let bookkeeping break the response */
            }
            if (!res.headersSent) {
              originalJson(envelope(jobId, p.status as string, webhookRegistered));
            }
          })();
          return res as Response;
        }
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
