import type { Request } from "express";
import serverless from "serverless-http";
import app from "./app";
import { runSceneFinderWorker } from "./routes/scene-finder";
import { runTimestampWorker, type TimestampWorkerEvent } from "./routes/timestamps";

type WorkerEvent = {
  source?: string;
  jobId?: string;
  query?: string;
  transcript?: string;
  videoTitle?: string;
  videoDuration?: number;
  instructions?: string;
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
  // Scene Finder Lambda worker
  if (event?.source === "videomaking.scene-finder") {
    if (!event.jobId || !event.query || !event.transcript) {
      throw new Error("Invalid Scene Finder worker payload");
    }
    await runSceneFinderWorker({
      source: "videomaking.scene-finder",
      jobId: event.jobId,
      query: event.query,
      transcript: event.transcript,
    });
    return { ok: true };
  }

  // Timestamps Lambda worker
  if (event?.source === "videomaking.timestamps") {
    if (!event.jobId || typeof event.videoTitle !== "string" || typeof event.transcript !== "string") {
      throw new Error("Invalid Timestamps worker payload");
    }
    await runTimestampWorker({
      source: "videomaking.timestamps",
      jobId: event.jobId,
      videoTitle: event.videoTitle,
      videoDuration: typeof event.videoDuration === "number" ? event.videoDuration : 0,
      transcript: event.transcript,
      instructions: event.instructions,
    } as TimestampWorkerEvent);
    return { ok: true };
  }

  return httpHandler(event as any, context as any);
};
