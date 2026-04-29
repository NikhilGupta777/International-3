/**
 * Lambda entrypoint — wraps Express with awslambda.streamifyResponse so the
 * Lambda Function URL streams responses chunk-by-chunk (millisecond SSE
 * delivery, no 30s gateway timeout, no buffering).
 *
 * The same handler also services async worker invocations (timestamps and
 * subtitles) which Lambda calls with InvocationType=Event — for those the
 * `responseStream` is discarded by the runtime, so we just close it.
 */

import app from "./app";
import {
  runTimestampWorker,
  type TimestampWorkerEvent,
} from "./routes/timestamps";
import {
  runSubtitleWorker,
  type SubtitleWorkerEvent,
} from "./routes/subtitles";
import {
  ensureInternalServer,
  proxyToInternalServer,
} from "./lib/lambda-stream";

interface AwsLambda {
  streamifyResponse: (
    handler: (event: any, responseStream: any, context: any) => Promise<void>,
  ) => any;
}
declare const awslambda: AwsLambda;

type WorkerEvent = {
  source?: string;
  jobId?: string;
  url?: string;
  transcript?: string;
  videoTitle?: string;
  videoDuration?: number;
  instructions?: string;
  language?: string;
  translateTo?: string;
  notifyClientKey?: string | null;
};

function isHttpEvent(event: any): boolean {
  return !!(
    event &&
    (event.requestContext?.http?.method ||
      typeof event.rawPath === "string" ||
      event.httpMethod)
  );
}

function safeEnd(stream: any): void {
  if (!stream) return;
  try {
    if (typeof stream.end === "function") stream.end();
  } catch { /* noop */ }
}

export const handler = awslambda.streamifyResponse(
  async (event: any, responseStream: any, context: any) => {
    if (context) {
      context.callbackWaitsForEmptyEventLoop = false;
    }

    // ── Timestamps Lambda worker (async invocation) ─────────────────────
    if (event?.source === "videomaking.timestamps") {
      const e = event as WorkerEvent;
      if (!e.jobId) {
        safeEnd(responseStream);
        throw new Error("Invalid Timestamps worker payload: missing jobId");
      }
      const hasUrl = typeof e.url === "string" && e.url.trim().length > 0;
      const hasLegacy =
        typeof e.videoTitle === "string" && typeof e.transcript === "string";
      if (!hasUrl && !hasLegacy) {
        safeEnd(responseStream);
        throw new Error("Invalid Timestamps worker payload: need url or transcript");
      }
      try {
        await runTimestampWorker({
          source: "videomaking.timestamps",
          jobId: e.jobId,
          url: e.url,
          videoTitle: e.videoTitle,
          videoDuration: typeof e.videoDuration === "number" ? e.videoDuration : 0,
          transcript: e.transcript,
          instructions: e.instructions,
        } as TimestampWorkerEvent);
      } finally {
        safeEnd(responseStream);
      }
      return;
    }

    // ── Subtitles Lambda worker (async invocation) ──────────────────────
    if (event?.source === "videomaking.subtitles") {
      const e = event as WorkerEvent;
      if (!e.jobId || !e.url) {
        safeEnd(responseStream);
        throw new Error("Invalid Subtitles worker payload: missing jobId or url");
      }
      try {
        await runSubtitleWorker({
          source: "videomaking.subtitles",
          jobId: e.jobId,
          url: e.url,
          language: e.language,
          translateTo: e.translateTo,
          notifyClientKey: e.notifyClientKey ?? null,
        } as SubtitleWorkerEvent);
      } finally {
        safeEnd(responseStream);
      }
      return;
    }

    // ── HTTP via Lambda Function URL (RESPONSE_STREAM) ──────────────────
    if (isHttpEvent(event)) {
      await ensureInternalServer(app);
      await proxyToInternalServer(event, responseStream);
      return;
    }

    // Unknown event shape — close stream cleanly.
    safeEnd(responseStream);
  },
);
