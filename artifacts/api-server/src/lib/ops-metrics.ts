import { statfsSync } from "fs";
import os from "os";

type HttpWindowEntry = { ts: number; statusCode: number; durationMs: number };

const startedAt = Date.now();
let totalRequests = 0;
let total5xx = 0;
let total4xx = 0;
let total2xx = 0;
let total3xx = 0;
let totalDurationMs = 0;

const recentWindow: HttpWindowEntry[] = [];
const RECENT_WINDOW_MS = 5 * 60 * 1000;

function trimWindow(now: number) {
  while (recentWindow.length > 0 && now - recentWindow[0].ts > RECENT_WINDOW_MS) {
    recentWindow.shift();
  }
}

export function recordHttpMetrics(statusCode: number, durationMs: number): void {
  const now = Date.now();
  totalRequests += 1;
  totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0;

  if (statusCode >= 500) total5xx += 1;
  else if (statusCode >= 400) total4xx += 1;
  else if (statusCode >= 300) total3xx += 1;
  else total2xx += 1;

  recentWindow.push({ ts: now, statusCode, durationMs: Math.max(0, durationMs) });
  trimWindow(now);
}

export function getHttpMetricsSnapshot() {
  const now = Date.now();
  trimWindow(now);
  const recentTotal = recentWindow.length;
  const recent5xx = recentWindow.filter((x) => x.statusCode >= 500).length;
  const recentAvgDurationMs =
    recentTotal > 0
      ? recentWindow.reduce((sum, x) => sum + x.durationMs, 0) / recentTotal
      : 0;

  return {
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    totals: {
      requests: totalRequests,
      status2xx: total2xx,
      status3xx: total3xx,
      status4xx: total4xx,
      status5xx: total5xx,
      avgDurationMs:
        totalRequests > 0 ? Math.round((totalDurationMs / totalRequests) * 100) / 100 : 0,
    },
    recent5m: {
      requests: recentTotal,
      status5xx: recent5xx,
      errorRatePct: recentTotal > 0 ? Math.round((recent5xx / recentTotal) * 10000) / 100 : 0,
      avgDurationMs: Math.round(recentAvgDurationMs * 100) / 100,
    },
  };
}

export function getSystemMetricsSnapshot() {
  const mem = process.memoryUsage();
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const usedMem = totalMem - freeMem;

  let diskUsedPct: number | null = null;
  try {
    const fsStats = statfsSync("/");
    const total = Number(fsStats.blocks) * Number(fsStats.bsize);
    const free = Number(fsStats.bavail) * Number(fsStats.bsize);
    if (total > 0) {
      diskUsedPct = Math.round(((total - free) / total) * 10000) / 100;
    }
  } catch {
    diskUsedPct = null;
  }

  return {
    cpu: {
      load1m: Math.round(os.loadavg()[0] * 100) / 100,
      load5m: Math.round(os.loadavg()[1] * 100) / 100,
      load15m: Math.round(os.loadavg()[2] * 100) / 100,
      cores: os.cpus().length,
    },
    memory: {
      processRssMb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
      processHeapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
      systemUsedPct: Math.round((usedMem / totalMem) * 10000) / 100,
    },
    disk: {
      rootUsedPct: diskUsedPct,
    },
  };
}
