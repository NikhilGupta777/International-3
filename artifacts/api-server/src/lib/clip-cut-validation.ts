export type ClipRange = { startTime: number; endTime: number };

export function normalizeClipRange(
  startTime: unknown,
  endTime: unknown,
  maxDurationSecs = 3600,
): { ok: true; value: ClipRange } | { ok: false; error: string } {
  if (typeof startTime !== "number" || typeof endTime !== "number" ||
      !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return { ok: false, error: "startTime and endTime must be finite numbers in seconds" };
  }
  if (startTime < 0) {
    return { ok: false, error: "startTime cannot be negative" };
  }
  if (endTime <= startTime) {
    return { ok: false, error: "endTime must be greater than startTime" };
  }
  if (endTime - startTime > maxDurationSecs) {
    return { ok: false, error: `Clip cannot exceed ${Math.round(maxDurationSecs / 60)} minutes` };
  }
  const roundedStart = Math.round(startTime);
  const roundedEnd = Math.round(endTime);
  if (roundedEnd <= roundedStart) {
    return { ok: false, error: "Clip range must be at least one second" };
  }
  return { ok: true, value: { startTime: roundedStart, endTime: roundedEnd } };
}
