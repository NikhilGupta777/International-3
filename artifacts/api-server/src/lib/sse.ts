import type { Response } from "express";

export function setupSse(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");

  const socket = (res as any).socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }

  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }

  res.write(":" + " ".repeat(2048) + "\n\n");
  if (typeof (res as any).flush === "function") {
    (res as any).flush();
  }
}

export function sseFlush(res: Response): void {
  if (typeof (res as any).flush === "function") {
    (res as any).flush();
  }
  const socket = (res as any).socket;
  if (socket && !socket.destroyed && typeof socket.write === "function") {
    socket.write("");
  }
}
