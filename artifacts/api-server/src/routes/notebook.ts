import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import path from "path";
import pino from "pino";
import {
  DynamoDBClient,
  DeleteItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { setupSse, sseFlush } from "../lib/sse";

const router = Router();
const logger = pino({ name: "notebook" });

const REGION = process.env.YOUTUBE_QUEUE_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const LOCK_TABLE = process.env.NOTEBOOKLM_LOCK_TABLE ?? process.env.YOUTUBE_QUEUE_JOB_TABLE ?? "";
const LOCK_ID = process.env.NOTEBOOKLM_LOCK_ID ?? "notebooklm-global-lock";
const NOTEBOOK_ID = process.env.NOTEBOOKLM_NOTEBOOK_ID ?? "";
const AUTH_JSON = (process.env.NOTEBOOKLM_AUTH_JSON ?? "").trim();
const AUTH_S3_KEY = (process.env.NOTEBOOKLM_AUTH_S3_KEY ?? "").trim();
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const S3_REGION = process.env.S3_REGION ?? process.env.AWS_REGION ?? REGION;
const AUTH_CONFIGURED = Boolean(AUTH_JSON || (AUTH_S3_KEY && S3_BUCKET));
const ENABLED = (process.env.NOTEBOOKLM_ENABLED ?? "").toLowerCase() === "true" || Boolean(NOTEBOOK_ID && AUTH_CONFIGURED);
const PYTHON_BIN = process.env.NOTEBOOKLM_PYTHON_BIN ?? "python3.11";
const TURN_DELAY_MS = Math.max(0, Number.parseInt(process.env.NOTEBOOKLM_TURN_DELAY_MS ?? "2500", 10) || 2500);
const TIMEOUT_MS = Math.max(60_000, Number.parseInt(process.env.NOTEBOOKLM_TIMEOUT_MS ?? "480000", 10) || 480_000);
const LOCK_TTL_MS = Math.max(TIMEOUT_MS + 60_000, Number.parseInt(process.env.NOTEBOOKLM_LOCK_TTL_MS ?? "540000", 10) || 540_000);
const LOCAL_QUEUE_LIMIT = Math.max(1, Number.parseInt(process.env.NOTEBOOKLM_LOCAL_QUEUE_LIMIT ?? "12", 10) || 12);
const SCRIPT_PATH =
  process.env.NOTEBOOKLM_HELPER_PATH ??
  path.resolve(__dirname, "../scripts/notebooklm_ask.py");

const ddb = LOCK_TABLE ? new DynamoDBClient({ region: REGION }) : null;
const s3 = AUTH_S3_KEY && S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;
let cachedAuthJson = AUTH_JSON;
let localTail: Promise<void> = Promise.resolve();
let localPending = 0;

function sse(res: Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamToString(body: unknown): Promise<string> {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getNotebookAuthJson(): Promise<string> {
  if (cachedAuthJson) return cachedAuthJson;
  if (!s3 || !S3_BUCKET || !AUTH_S3_KEY) {
    throw new Error("NotebookLM auth is not configured.");
  }
  const result = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: AUTH_S3_KEY }));
  const payload = (await streamToString(result.Body)).trim();
  if (!payload) throw new Error("NotebookLM auth file is empty.");
  cachedAuthJson = payload;
  return cachedAuthJson;
}

async function acquireGlobalLock(owner: string, deadline: number, onWait: (attempt: number) => void): Promise<boolean> {
  if (!ddb || !LOCK_TABLE) return true;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const now = Date.now();
    const expiresAt = now + LOCK_TTL_MS;
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: LOCK_TABLE,
          Item: {
            jobId: { S: LOCK_ID },
            owner: { S: owner },
            status: { S: "locked" },
            jobType: { S: "notebooklm-lock" },
            createdAt: { N: String(now) },
            updatedAt: { N: String(now) },
            expiresAt: { N: String(Math.floor(expiresAt / 1000)) },
          },
          ConditionExpression: "attribute_not_exists(jobId) OR expiresAt < :nowSec",
          ExpressionAttributeValues: {
            ":nowSec": { N: String(Math.floor(now / 1000)) },
          },
        }),
      );
      return true;
    } catch {
      onWait(attempt);
      await sleep(Math.min(5000, 1200 + attempt * 300));
    }
  }
  return false;
}

async function releaseGlobalLock(owner: string): Promise<void> {
  if (!ddb || !LOCK_TABLE) return;
  try {
    await ddb.send(
      new DeleteItemCommand({
        TableName: LOCK_TABLE,
        Key: { jobId: { S: LOCK_ID } },
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": { S: owner } },
      }),
    );
  } catch {
    // Another container may have expired/replaced the lock.
  }
}

async function runNotebookHelper(message: string, signal: AbortSignal): Promise<any> {
  const authJson = await getNotebookAuthJson();
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: "/usr/lib64:/lib64",
        NOTEBOOKLM_NOTEBOOK_ID: NOTEBOOK_ID,
        NOTEBOOKLM_AUTH_JSON: authJson,
        NOTEBOOKLM_CLIENT_TIMEOUT_SECONDS: String(Math.max(30, Math.floor((TIMEOUT_MS - 30_000) / 1000))),
      },
    });

    let stdout = "";
    let stderr = "";
    const kill = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    signal.addEventListener("abort", kill, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stderr.trim());
          reject(new Error(parsed.error || "NotebookLM helper failed"));
        } catch {
          reject(new Error(stderr.trim() || `NotebookLM helper exited with ${code}`));
        }
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error("NotebookLM helper returned invalid JSON"));
      }
    });

    child.stdin.end(
      JSON.stringify({
        notebook_id: NOTEBOOK_ID,
        message,
        timeout_seconds: Math.max(30, Math.floor((TIMEOUT_MS - 30_000) / 1000)),
      }),
    );
  });
}

async function runInLocalQueue<T>(work: (position: number) => Promise<T>): Promise<T> {
  localPending += 1;
  const position = localPending;
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = localTail;
  localTail = localTail.then(() => next, () => next);

  try {
    await previous;
    return await work(position);
  } finally {
    localPending = Math.max(0, localPending - 1);
    release();
  }
}

router.get("/notebook/health", (_req: Request, res: Response) => {
  res.json({
    enabled: ENABLED,
    configured: Boolean(NOTEBOOK_ID && AUTH_CONFIGURED),
    notebookIdConfigured: Boolean(NOTEBOOK_ID),
    authConfigured: AUTH_CONFIGURED,
    authS3Configured: Boolean(AUTH_S3_KEY && S3_BUCKET),
    globalLock: Boolean(ddb && LOCK_TABLE),
    timeoutMs: TIMEOUT_MS,
    localPending,
  });
});

router.post("/notebook/ask/stream", async (req: Request, res: Response) => {
  setupSse(res);
  const requestId = randomUUID();
  const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
  const message = rawMessage.trim();
  const startedAt = Date.now();
  let closed = false;
  let controller: AbortController | null = null;
  res.on("close", () => {
    closed = true;
    controller?.abort();
  });

  if (!message) {
    sse(res, { type: "error", message: "Enter a question first." });
    res.end();
    return;
  }
  if (message.length > 8000) {
    sse(res, { type: "error", message: "Question is too long. Keep it under 8,000 characters." });
    res.end();
    return;
  }
  if (!ENABLED || !NOTEBOOK_ID || !AUTH_CONFIGURED) {
    sse(res, {
      type: "error",
      message: "Find Video is not configured yet. Add NOTEBOOKLM_NOTEBOOK_ID and NotebookLM auth to enable it.",
    });
    res.end();
    return;
  }
  if (localPending >= LOCAL_QUEUE_LIMIT) {
    sse(res, { type: "error", message: "Find Video is busy. Try again in a minute." });
    res.end();
    return;
  }

  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    await runInLocalQueue(async (position) => {
      if (closed) return;
      sse(res, {
        type: "queued",
        requestId,
        position,
        message: position > 1 ? `Waiting for your turn (${position} in this server queue)` : "Taking your turn",
        elapsedMs: Date.now() - startedAt,
      });
      const deadline = Date.now() + TIMEOUT_MS - 15_000;
      const locked = await acquireGlobalLock(requestId, deadline, (attempt) => {
        if (closed) return;
        sse(res, {
          type: "waiting_global",
          requestId,
          attempt,
          message: "Another Find Video request is using NotebookLM. Waiting safely.",
          elapsedMs: Date.now() - startedAt,
        });
      });
      if (!locked) throw new Error("NotebookLM is still busy. Please retry.");

      try {
        if (TURN_DELAY_MS > 0) {
          sse(res, {
            type: "cooldown",
            requestId,
            message: "Waiting briefly before asking NotebookLM",
            elapsedMs: Date.now() - startedAt,
          });
          await sleep(TURN_DELAY_MS);
        }
        if (closed) return;
        sse(res, {
          type: "asking",
          requestId,
          message: "Asking NotebookLM",
          elapsedMs: Date.now() - startedAt,
        });
        const result = await runNotebookHelper(message, controller.signal);
        if (closed) return;
        sse(res, {
          type: "answer",
          requestId,
          answer: result.answer ?? "",
          references: result.references ?? [],
          conversationId: result.conversationId ?? null,
          elapsedMs: Date.now() - startedAt,
        });
      } finally {
        await releaseGlobalLock(requestId);
      }
    });
    if (!closed) sse(res, { type: "done", requestId, elapsedMs: Date.now() - startedAt });
  } catch (error) {
    logger.warn({ err: error, requestId }, "Find Video request failed");
    if (!closed) {
      sse(res, {
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : "NotebookLM request failed",
        elapsedMs: Date.now() - startedAt,
      });
    }
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
});

export default router;
