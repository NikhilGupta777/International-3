import { randomUUID } from "crypto";
import { Router, type Request, type Response } from "express";
import { GoogleGenAI } from "@google/genai";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { logger } from "../lib/logger";

const router = Router();

const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const JOB_TABLE = process.env.YOUTUBE_QUEUE_JOB_TABLE ?? process.env.JOB_TABLE ?? "";
const WORKER_FUNCTION_NAME =
  process.env.SCENE_FINDER_WORKER_FUNCTION_NAME ??
  process.env.AWS_LAMBDA_FUNCTION_NAME ??
  "";

const ddb = JOB_TABLE ? new DynamoDBClient({ region: REGION }) : null;
const lambda = WORKER_FUNCTION_NAME ? new LambdaClient({ region: REGION }) : null;

type SceneFinderResult = {
  summary: string;
  scenes: Array<{
    title: string;
    startSec: number | null;
    endSec: number | null;
    confidence: number;
    reason: string;
    quote: string;
  }>;
};

type SceneFinderWorkerEvent = {
  source: "videomaking.scene-finder";
  jobId: string;
  query: string;
  transcript: string;
};

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getGeminiKeys(): string[] {
  const keys: string[] = [];
  const first = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (first) keys.push(first.trim());
  for (let index = 2; index <= 10; index += 1) {
    const value = process.env[`GEMINI_API_KEY_${index}`];
    if (value?.trim()) keys.push(value.trim());
  }
  return Array.from(new Set(keys.filter(Boolean)));
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch {}
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("AI returned invalid JSON");
}

function normalizeResult(value: unknown): SceneFinderResult {
  const obj = value && typeof value === "object" ? (value as any) : {};
  const rawScenes = Array.isArray(obj.scenes) ? obj.scenes : [];
  return {
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 1000) : "",
    scenes: rawScenes.slice(0, 12).map((scene: any) => ({
      title: typeof scene.title === "string" ? scene.title.slice(0, 160) : "Matched scene",
      startSec: typeof scene.startSec === "number" && Number.isFinite(scene.startSec) ? scene.startSec : null,
      endSec: typeof scene.endSec === "number" && Number.isFinite(scene.endSec) ? scene.endSec : null,
      confidence:
        typeof scene.confidence === "number" && Number.isFinite(scene.confidence)
          ? Math.max(0, Math.min(1, scene.confidence))
          : 0.7,
      reason: typeof scene.reason === "string" ? scene.reason.slice(0, 1200) : "",
      quote: typeof scene.quote === "string" ? scene.quote.slice(0, 1200) : "",
    })),
  };
}

async function putJob(jobId: string, status: string, message: string, extra?: Record<string, unknown>) {
  if (!ddb || !JOB_TABLE) throw new Error("Scene Finder job table is not configured");
  const now = Date.now();
  const item: Record<string, any> = {
    jobId: { S: jobId },
    jobType: { S: "scene-finder" },
    status: { S: status },
    message: { S: message },
    createdAt: { N: String(now) },
    updatedAt: { N: String(now) },
  };
  if (extra?.query && typeof extra.query === "string") item.query = { S: extra.query };
  await ddb.send(new PutItemCommand({ TableName: JOB_TABLE, Item: item }));
}

async function updateJob(jobId: string, status: string, message: string, extra?: Record<string, unknown>) {
  if (!ddb || !JOB_TABLE) throw new Error("Scene Finder job table is not configured");
  const names: Record<string, string> = {
    "#s": "status",
    "#m": "message",
    "#u": "updatedAt",
  };
  const values: Record<string, any> = {
    ":s": { S: status },
    ":m": { S: message },
    ":u": { N: String(Date.now()) },
  };
  const sets = ["#s = :s", "#m = :m", "#u = :u"];
  if (extra?.resultJson && typeof extra.resultJson === "string") {
    names["#r"] = "resultJson";
    values[":r"] = { S: extra.resultJson };
    sets.push("#r = :r");
  }
  if (typeof extra?.progressPct === "number") {
    names["#p"] = "progressPct";
    values[":p"] = { N: String(extra.progressPct) };
    sets.push("#p = :p");
  }
  await ddb.send(
    new UpdateItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: jobId } },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function readJob(jobId: string) {
  if (!ddb || !JOB_TABLE) return null;
  const out = await ddb.send(
    new GetItemCommand({
      TableName: JOB_TABLE,
      Key: { jobId: { S: jobId } },
      ConsistentRead: true,
    }),
  );
  const item = out.Item;
  if (!item || item.jobType?.S !== "scene-finder") return null;
  return {
    jobId,
    status: item.status?.S ?? "pending",
    message: item.message?.S ?? "",
    updatedAt: item.updatedAt?.N ? Number(item.updatedAt.N) : null,
    progressPct: item.progressPct?.N ? Number(item.progressPct.N) : null,
    resultJson: item.resultJson?.S ?? null,
  };
}

async function generateSceneMatches(query: string, transcript: string): Promise<SceneFinderResult> {
  const keys = getGeminiKeys();
  if (keys.length === 0) throw new Error("GEMINI_API_KEY is not configured");

  const prompt = `You are a precise Katha scene matching assistant.

Find the best scenes in the transcript that match the user's request.

Return ONLY valid JSON with this shape:
{
  "summary": "short summary",
  "scenes": [
    {
      "title": "short title",
      "startSec": 0,
      "endSec": 60,
      "confidence": 0.85,
      "reason": "why this scene matches",
      "quote": "small exact supporting quote"
    }
  ]
}

Rules:
- If timestamps exist, convert them to seconds.
- If timestamps do not exist, use null for startSec/endSec.
- Return at most 8 scenes.
- Do not invent timestamps or quotes.

User request:
${query}

Transcript/source:
${transcript.slice(0, 120000)}`;

  let lastErr: Error | null = null;
  for (const model of ["gemini-3-flash-preview", "gemini-2.5-flash"]) {
    for (const apiKey of keys) {
      try {
        const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 70_000 } });
        const result = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        });
        return normalizeResult(extractJsonObject((result as any).text ?? ""));
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err ?? ""));
        logger.warn({ err: lastErr.message, model }, "[scene-finder] Gemini attempt failed");
      }
    }
  }
  throw lastErr ?? new Error("Scene matching failed");
}

export async function runSceneFinderWorker(event: SceneFinderWorkerEvent): Promise<void> {
  const { jobId, query, transcript } = event;
  await updateJob(jobId, "running", "Finding matching scenes...", { progressPct: 20 });
  try {
    const result = await generateSceneMatches(query, transcript);
    await updateJob(jobId, "done", `${result.scenes.length} scenes found`, {
      progressPct: 100,
      resultJson: JSON.stringify(result),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scene matching failed";
    await updateJob(jobId, "error", message, { progressPct: 0 });
  }
}

router.post("/scene-finder/start", async (req: Request, res: Response) => {
  const query = pickString((req.body as any)?.query);
  const transcript = pickString((req.body as any)?.transcript);
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  if (transcript.length < 20) {
    res.status(400).json({ error: "transcript/source text is required" });
    return;
  }
  if (transcript.length > 180000) {
    res.status(413).json({ error: "source text is too large; keep it under 180k characters" });
    return;
  }
  if (!ddb || !JOB_TABLE) {
    res.status(503).json({ error: "Scene Finder storage is not configured" });
    return;
  }

  const jobId = randomUUID();
  await putJob(jobId, "queued", "Queued - starting soon...", { query });

  const payload: SceneFinderWorkerEvent = {
    source: "videomaking.scene-finder",
    jobId,
    query,
    transcript,
  };

  if (lambda && WORKER_FUNCTION_NAME) {
    await lambda.send(
      new InvokeCommand({
        FunctionName: WORKER_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  } else {
    setImmediate(() => {
      void runSceneFinderWorker(payload).catch((err) => {
        logger.error({ err, jobId }, "[scene-finder] local worker failed");
      });
    });
  }

  res.json({ jobId, status: "queued", message: "Scene Finder job started" });
});

router.get("/scene-finder/status/:jobId", async (req: Request, res: Response) => {
  const jobId = pickString(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = await readJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  let result: SceneFinderResult | null = null;
  if (job.status === "done" && job.resultJson) {
    try {
      result = normalizeResult(JSON.parse(job.resultJson));
    } catch {}
  }
  res.json({
    jobId,
    status: job.status,
    message: job.message,
    progressPct: job.progressPct,
    updatedAt: job.updatedAt,
    result,
  });
});

export default router;
