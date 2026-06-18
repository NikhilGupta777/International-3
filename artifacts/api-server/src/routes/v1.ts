import { Router, type IRouter, type Request, type Response } from "express";
import { getJobStatusFromDdb } from "../lib/youtube-queue";
import { setupSse, sseFlush } from "../lib/sse";
import { registerJobWebhook, isValidWebhookUrl, isTerminalStatus } from "../lib/webhooks";

// ─────────────────────────────────────────────────────────────────────────────
// Public API v1 — a clean, stable, documented surface over the studio services.
//
// Auth: every call requires an API key.
//     Authorization: Bearer vms_live_xxx        (or  X-API-Key: vms_live_xxx)
//
// These endpoints do NOT re-implement business logic. Each POST alias forwards
// the request in-process to the canonical handler (so validation, queueing,
// rate-limits, and behaviour stay identical), then normalizes the response to a
// consistent { jobId, status, statusUrl, streamUrl } envelope.
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
  /** build the canonical status polling URL for a returned jobId */
  statusUrl: (jobId: string) => string;
  /** build the canonical SSE stream URL, when one exists */
  streamUrl?: (jobId: string) => string;
  /** extra documented optional fields */
  fields?: Record<string, string>;
};

const OPERATIONS: Operation[] = [
  {
    op: "clips",
    target: "/api/youtube/clips",
    urlKey: "url",
    input: "youtube",
    summary: "Find the best viral clips in a YouTube video (AI).",
    statusUrl: (id) => `/api/youtube/clips/status/${id}`,
    streamUrl: (id) => `/api/youtube/clips/stream/${id}`,
    fields: { durations: "number[] of target clip lengths", auto: "boolean", instructions: "string" },
  },
  {
    op: "clip-cut",
    target: "/api/youtube/clip-cut",
    urlKey: "url",
    input: "youtube",
    summary: "Cut a precise clip from a YouTube video.",
    statusUrl: (id) => `/api/youtube/progress/${id}`,
    streamUrl: (id) => `/api/youtube/progress/stream/${id}`,
  },
  {
    op: "download",
    target: "/api/youtube/download",
    urlKey: "url",
    input: "youtube",
    summary: "Download a full YouTube video or audio.",
    statusUrl: (id) => `/api/youtube/progress/${id}`,
    streamUrl: (id) => `/api/youtube/progress/stream/${id}`,
    fields: { formatId: "string format id (or 'best')", audioOnly: "boolean" },
  },
  {
    op: "timestamps",
    target: "/api/youtube/timestamps",
    urlKey: "url",
    input: "youtube",
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
    summary: "Transcribe a publicly-accessible media URL into subtitles.",
    statusUrl: (id) => `/api/subtitles/status/${id}`,
    fields: { language: "BCP-47 code or 'auto'", translateTo: "target language code" },
  },
  {
    op: "translate",
    target: "/api/translator/submit-from-url",
    urlKey: "fileUrl",
    input: "media",
    summary: "Translate / dub a publicly-accessible video URL (GPU).",
    statusUrl: (id) => `/api/translator/status/${id}`,
    fields: {
      targetLang: "e.g. 'Hindi'",
      targetLangCode: "e.g. 'hi'",
      sourceLang: "e.g. 'auto'",
      voiceClone: "boolean",
      lipSync: "boolean",
    },
  },
];

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
      "POST an operation to start a job; it returns { jobId, statusUrl, streamUrl, eventsUrl }. " +
      "Poll statusUrl, subscribe to streamUrl/eventsUrl (SSE), or register a webhook for progress.",
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
    })),
    jobStatus: { method: "GET", path: "/api/v1/jobs/{jobId}" },
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
                    streamUrl: { type: "string", nullable: true },
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

// ── Unified job status ───────────────────────────────────────────────────────
router.get("/jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  try {
    const status = await getJobStatusFromDdb(jobId);
    if (!status) {
      res.status(404).json({
        error: "Job not found in the shared job table.",
        hint: "In-memory jobs are only visible via the operation's own statusUrl returned at creation.",
      });
      return;
    }
    const terminal = ["done", "DONE", "error", "failed", "FAILED", "cancelled", "CANCELLED"];
    res.json({
      jobId,
      status: status.status,
      message: status.message || null,
      progressPct: status.progressPct,
      ready: terminal.includes(status.status),
      resultUrl: status.s3Key ? `/api/youtube/file/${jobId}` : null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch job status" });
  }
});

// ── Unified realtime stream (poll-based SSE over the shared job table) ───────
router.get("/jobs/:jobId/events", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId ?? "").trim();
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  setupSse(res);

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sseFlush(res);
  };

  const deadline = Date.now() + 15 * 60 * 1000; // 15 min cap
  let lastStatus = "";

  while (!closed && Date.now() < deadline) {
    let status: Awaited<ReturnType<typeof getJobStatusFromDdb>> = null;
    try {
      status = await getJobStatusFromDdb(jobId);
    } catch {
      /* transient */
    }
    if (status) {
      const key = `${status.status}:${status.progressPct ?? ""}:${status.message ?? ""}`;
      if (key !== lastStatus) {
        lastStatus = key;
        send("status", {
          jobId,
          status: status.status,
          message: status.message || null,
          progressPct: status.progressPct,
          ready: isTerminalStatus(status.status),
          resultUrl: status.s3Key ? `/api/youtube/file/${jobId}` : null,
        });
      }
      if (isTerminalStatus(status.status)) {
        send("done", { jobId, status: status.status });
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

    const keyId = (res.locals.apiKey as { keyId?: string } | undefined)?.keyId;

    // Normalize the canonical response into a consistent v1 envelope.
    const originalJson = res.json.bind(res);
    (res as Response).json = ((payload: unknown) => {
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        payload &&
        typeof payload === "object"
      ) {
        const p = payload as Record<string, unknown>;
        const jobId = (p.jobId ?? p.id) as string | undefined;
        if (jobId) {
          void (async () => {
            const webhookRegistered =
              webhookUrl && isValidWebhookUrl(webhookUrl)
                ? await registerJobWebhook(jobId, webhookUrl, keyId)
                : false;
            originalJson({
              jobId,
              status: (p.status as string) ?? "queued",
              statusUrl: o.statusUrl(jobId),
              streamUrl: o.streamUrl ? o.streamUrl(jobId) : null,
              eventsUrl: `/api/v1/jobs/${jobId}/events`,
              webhookRegistered,
            });
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
