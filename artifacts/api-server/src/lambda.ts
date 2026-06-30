/**
 * Lambda entrypoint — wraps Express with awslambda.streamifyResponse so the
 * Lambda Function URL streams responses chunk-by-chunk (millisecond SSE
 * delivery, no 30s gateway timeout, no buffering).
 *
 * The same handler also services async worker invocations (timestamps and
 * subtitles) which Lambda calls with InvocationType=Event — for those the
 * `responseStream` is discarded by the runtime, so we just close it.
 */

import dns from "dns";
// Fix Node.js 18+ Windows IPv6 hanging issue with fetch
dns.setDefaultResultOrder("ipv4first");

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
  runClipCutWorker,
  type ClipCutWorkerEvent,
} from "./routes/youtube";
import { runEditorRenderWorker } from "./routes/video-editor";
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
  inputMode?: "url" | "upload";
  uploadS3Key?: string;
  originalFilename?: string;
  transcript?: string;
  videoTitle?: string;
  videoDuration?: number;
  instructions?: string;
  language?: string;
  translateTo?: string;
  notifyClientKey?: string | null;
  isFastPipeline?: boolean;
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

    // ── Clip-cut Lambda worker (async invocation) ──────────────────────
    // Fired only when an API-key clip-cut request self-invokes this Lambda
    // to run the actual yt-dlp/ffmpeg pipeline decoupled from the response.
    // Dashboard clip-cuts never reach this branch — they keep running
    // in-process inside the original HTTP request invocation.
    if (event?.source === "videomaking.clip-cut") {
      const e = event as Partial<ClipCutWorkerEvent>;
      if (
        !e.jobId ||
        typeof e.url !== "string" ||
        typeof e.startTime !== "number" ||
        typeof e.endTime !== "number"
      ) {
        safeEnd(responseStream);
        throw new Error("Invalid clip-cut worker payload");
      }
      try {
        await runClipCutWorker({
          source: "videomaking.clip-cut",
          jobId: e.jobId,
          url: e.url,
          startTime: e.startTime,
          endTime: e.endTime,
          quality: typeof e.quality === "string" ? e.quality : "best",
          notifyClientKey: e.notifyClientKey ?? null,
        });
      } finally {
        safeEnd(responseStream);
      }
      return;
    }

    // ── Subtitles Lambda worker (async invocation) ──────────────────────
    if (event?.source === "videomaking.subtitles") {
      const e = event as WorkerEvent;
      const hasUploadKey = typeof e.uploadS3Key === "string" && e.uploadS3Key.trim().length > 0;
      const hasUrl = typeof e.url === "string" && e.url.trim().length > 0;
      if (!e.jobId || (!hasUrl && !hasUploadKey)) {
        safeEnd(responseStream);
        throw new Error("Invalid Subtitles worker payload: missing jobId or url/uploadS3Key");
      }
      try {
        await runSubtitleWorker({
          source: "videomaking.subtitles",
          jobId: e.jobId,
          inputMode: e.inputMode ?? (hasUploadKey ? "upload" : "url"),
          url: e.url,
          uploadS3Key: e.uploadS3Key,
          originalFilename: e.originalFilename,
          language: e.language,
          translateTo: e.translateTo,
          notifyClientKey: e.notifyClientKey ?? null,
          isFastPipeline: e.isFastPipeline,
        } as SubtitleWorkerEvent);
      } finally {
        safeEnd(responseStream);
      }
      return;
    }

    // ── Editor render Lambda worker (async self-invoke, fast path) ──────
    if (event?.source === "videomaking.editor") {
      const e = event as { jobId?: string; workspaceId?: string; projectId?: string; kind?: "preview" | "final" };
      if (!e.jobId || !e.workspaceId || !e.projectId) {
        safeEnd(responseStream);
        throw new Error("Invalid editor render worker payload: missing jobId/workspaceId/projectId");
      }
      try {
        await runEditorRenderWorker({
          jobId: e.jobId,
          workspaceId: e.workspaceId,
          projectId: e.projectId,
          kind: e.kind === "preview" ? "preview" : "final",
        });
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
