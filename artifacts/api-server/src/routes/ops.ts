import { Router, type IRouter } from "express";
import {
  getHttpMetricsSnapshot,
  getSystemMetricsSnapshot,
} from "../lib/ops-metrics";
import { getSubtitlesOpsSnapshot } from "./subtitles";
import { getYoutubeOpsSnapshot } from "./youtube";

const router: IRouter = Router();

router.get("/ops/metrics", (_req, res) => {
  const http = getHttpMetricsSnapshot();
  const system = getSystemMetricsSnapshot();
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();

  res.json({
    ts: Date.now(),
    http,
    system,
    queues: {
      youtube,
      subtitles,
    },
  });
});

router.get("/ops/alerts", (_req, res) => {
  const http = getHttpMetricsSnapshot();
  const system = getSystemMetricsSnapshot();
  const youtube = getYoutubeOpsSnapshot();
  const subtitles = getSubtitlesOpsSnapshot();

  const alerts: Array<{ level: "warn" | "critical"; code: string; message: string }> = [];

  if (http.recent5m.requests >= 20 && http.recent5m.errorRatePct >= 10) {
    alerts.push({
      level: "critical",
      code: "HTTP_5XX_RATE_HIGH",
      message: `5xx rate is ${http.recent5m.errorRatePct}% over last 5 minutes`,
    });
  }

  if (system.memory.systemUsedPct >= 90) {
    alerts.push({
      level: "critical",
      code: "MEMORY_HIGH",
      message: `System memory usage is ${system.memory.systemUsedPct}%`,
    });
  } else if (system.memory.systemUsedPct >= 80) {
    alerts.push({
      level: "warn",
      code: "MEMORY_ELEVATED",
      message: `System memory usage is ${system.memory.systemUsedPct}%`,
    });
  }

  if ((system.disk.rootUsedPct ?? 0) >= 90) {
    alerts.push({
      level: "critical",
      code: "DISK_HIGH",
      message: `Root disk usage is ${system.disk.rootUsedPct}%`,
    });
  } else if ((system.disk.rootUsedPct ?? 0) >= 80) {
    alerts.push({
      level: "warn",
      code: "DISK_ELEVATED",
      message: `Root disk usage is ${system.disk.rootUsedPct}%`,
    });
  }

  if (youtube.queue.queuedClipJobs >= 5) {
    alerts.push({
      level: "warn",
      code: "CLIP_QUEUE_HIGH",
      message: `Clip queue depth is ${youtube.queue.queuedClipJobs}`,
    });
  }

  if (subtitles.queue.queuedSubtitleJobs >= 5) {
    alerts.push({
      level: "warn",
      code: "SUBTITLE_QUEUE_HIGH",
      message: `Subtitle queue depth is ${subtitles.queue.queuedSubtitleJobs}`,
    });
  }

  res.json({
    ts: Date.now(),
    ok: alerts.length === 0,
    alerts,
  });
});

export default router;
