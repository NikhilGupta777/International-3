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
import { setupSse, sseFlush } from "../lib/sse";

const router = Router();
const logger = pino({ name: "notebook" });

const REGION = process.env.YOUTUBE_QUEUE_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const LOCK_TABLE = process.env.NOTEBOOKLM_LOCK_TABLE ?? process.env.YOUTUBE_QUEUE_JOB_TABLE ?? "";
const LOCK_ID = process.env.NOTEBOOKLM_LOCK_ID ?? "notebooklm-global-lock";
const NOTEBOOK_ID = process.env.NOTEBOOKLM_NOTEBOOK_ID ?? "";
const AUTH_JSON = process.env.NOTEBOOKLM_AUTH_JSON ?? "";
const ENABLED = (process.env.NOTEBOOKLM_ENABLED ?? "").toLowerCase() === "true" || Boolean(NOTEBOOK_ID && AUTH_JSON);
const PYTHON_BIN = process.env.NOTEBOOKLM_PYTHON_BIN ?? "python3.11";
const TURN_DELAY_MS = Math.max(0, Number.parseInt(process.env.NOTEBOOKLM_TURN_DELAY_MS ?? "2500", 10) || 2500);
const TIMEOUT_MS = Math.max(60_000, Number.parseInt(process.env.NOTEBOOKLM_TIMEOUT_MS ?? "480000", 10) || 480_000);
const LOCK_TTL_MS = Math.max(TIMEOUT_MS + 60_000, Number.parseInt(process.env.NOTEBOOKLM_LOCK_TTL_MS ?? "540000", 10) || 540_000);
const LOCAL_QUEUE_LIMIT = Math.max(1, Number.parseInt(process.env.NOTEBOOKLM_LOCAL_QUEUE_LIMIT ?? "12", 10) || 12);
const SCRIPT_PATH =
  process.env.NOTEBOOKLM_HELPER_PATH ??
  path.resolve(__dirname, "../scripts/notebooklm_ask.py");

const ddb = LOCK_TABLE ? new DynamoDBClient({ region: REGION }) : null;
let localTail: Promise<void> = Promise.resolve();
let localPending = 0;

function sse(res: Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  sseFlush(res);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function runNotebookHelper(message: string, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: "/usr/lib64:/lib64",
        NOTEBOOKLM_NOTEBOOK_ID: NOTEBOOK_ID,
        NOTEBOOKLM_AUTH_JSON: AUTH_JSON,
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
    configured: Boolean(NOTEBOOK_ID && AUTH_JSON),
    notebookIdConfigured: Boolean(NOTEBOOK_ID),
    authConfigured: Boolean(AUTH_JSON),
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
  req.on("close", () => {
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
  if (!ENABLED || !NOTEBOOK_ID || !AUTH_JSON) {
    sse(res, {
      type: "error",
      message: "Find Video is not configured yet. Add NOTEBOOKLM_NOTEBOOK_ID and NOTEBOOKLM_AUTH_JSON to enable it.",
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
