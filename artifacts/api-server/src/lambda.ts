import type { Request } from "express";
import serverless from "serverless-http";
import app from "./app";
import { runTimestampWorker, type TimestampWorkerEvent } from "./routes/timestamps";
import { runSubtitleWorker, type SubtitleWorkerEvent } from "./routes/subtitles";

type WorkerEvent = {
  source?: string;
  jobId?: string;
  query?: string;
  url?: string;
  transcript?: string;
  videoTitle?: string;
  videoDuration?: number;
  instructions?: string;
  language?: string;
  translateTo?: string;
  notifyClientKey?: string | null;
};

const httpHandler = serverless(app, {
  provider: "aws",
  request(
    request: Request & {
      apiGateway?: { event?: unknown; context?: unknown };
      rawBody?: string;
    },
    event: { body?: unknown; isBase64Encoded?: boolean },
    context: unknown,
  ) {
    const raw =
      typeof event?.body === "string"
        ? event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body
        : Buffer.isBuffer(event?.body)
          ? event.body.toString("utf8")
          : event?.body && typeof event.body === "object"
            ? JSON.stringify(event.body)
            : "";
    Object.assign(request, {
      apiGateway: { event, context },
      rawBody: raw,
    });
  },
});

export const handler = async (event: WorkerEvent, context: unknown) => {
  // Timestamps Lambda worker
  if (event?.source === "videomaking.timestamps") {
    if (!event.jobId) {
      throw new Error("Invalid Timestamps worker payload: missing jobId");
    }
    const hasUrl = typeof event.url === "string" && event.url.trim().length > 0;
    const hasLegacy =
      typeof event.videoTitle === "string" && typeof event.transcript === "string";
    if (!hasUrl && !hasLegacy) {
      throw new Error("Invalid Timestamps worker payload: need url or transcript");
    }
    await runTimestampWorker({
      source: "videomaking.timestamps",
      jobId: event.jobId,
      url: event.url,
      videoTitle: event.videoTitle,
      videoDuration: typeof event.videoDuration === "number" ? event.videoDuration : 0,
      transcript: event.transcript,
      instructions: event.instructions,
    } as TimestampWorkerEvent);
    return { ok: true };
  }

  if (event?.source === "videomaking.subtitles") {
    if (!event.jobId || !event.url) {
      throw new Error("Invalid Subtitles worker payload: missing jobId or url");
    }
    await runSubtitleWorker({
      source: "videomaking.subtitles",
      jobId: event.jobId,
      url: event.url,
      language: event.language,
      translateTo: event.translateTo,
      notifyClientKey: event.notifyClientKey ?? null,
    } as SubtitleWorkerEvent);
    return { ok: true };
  }

  return httpHandler(event as any, context as any);
};
