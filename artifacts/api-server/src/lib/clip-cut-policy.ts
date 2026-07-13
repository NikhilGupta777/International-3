export type ClipHandoffDecision = {
  shouldHandoff: boolean;
  projectedRemainingMs: number | null;
  speed: number | null;
};

function parseFfmpegSpeed(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/([0-9]+(?:\.[0-9]+)?)x/i);
  if (!match) return null;
  const speed = Number.parseFloat(match[1]);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

export function evaluateClipHandoff(input: {
  elapsedMs: number;
  durationSecs: number;
  progressPct: number | null;
  speedText: string | null;
  sampleAfterMs: number;
  noProgressAfterMs: number;
  lambdaBudgetMs: number;
  completionReserveMs: number;
}): ClipHandoffDecision {
  if (input.elapsedMs < input.sampleAfterMs) {
    return { shouldHandoff: false, projectedRemainingMs: null, speed: null };
  }

  const speed = parseFfmpegSpeed(input.speedText);
  const hardCutoffMs = Math.max(0, input.lambdaBudgetMs - input.completionReserveMs);
  if (input.elapsedMs >= hardCutoffMs) {
    return { shouldHandoff: true, projectedRemainingMs: 0, speed };
  }
  const progressPct = Math.max(0, Math.min(95, input.progressPct ?? 0));
  if (!speed) {
    return {
      shouldHandoff: input.elapsedMs >= input.noProgressAfterMs,
      projectedRemainingMs: null,
      speed: null,
    };
  }

  const processedSecs = input.durationSecs * (progressPct / 95);
  const remainingSecs = Math.max(0, input.durationSecs - processedSecs);
  const projectedRemainingMs = (remainingSecs / speed) * 1000;
  const safeTimeRemainingMs = Math.max(
    0,
    input.lambdaBudgetMs - input.elapsedMs - input.completionReserveMs,
  );
  return {
    shouldHandoff: projectedRemainingMs > safeTimeRemainingMs,
    projectedRemainingMs,
    speed,
  };
}
