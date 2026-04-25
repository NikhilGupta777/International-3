import type { RefItem } from "./types";
import { buildFinalMessage, buildShortlistMessage, FINAL_TOOL, SHORTLIST_TOOL } from "./prompts";
import { callGeminiWithRetry } from "./gemini";

const BATCH_SIZE = Number(process.env.KATHA_BATCH_SIZE || 25);
const FINAL_TOP_N = Number(process.env.KATHA_FINAL_TOP_N || 12);
const SHORTLIST_CONCURRENCY = Number(process.env.KATHA_SHORTLIST_CONCURRENCY || 4);

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

export async function identifyKatha(queryImage: string, references: RefItem[]) {
  if (!queryImage || !Array.isArray(references) || references.length === 0) {
    const error: any = new Error("queryImage and non-empty references required");
    error.status = 400;
    throw error;
  }

  const started = Date.now();
  let candidates = references;
  let shortlisted = false;
  let topShortlistScore: number | undefined;

  if (references.length > FINAL_TOP_N) {
    shortlisted = true;
    const batches: { batch: RefItem[]; offset: number }[] = [];
    for (let i = 0; i < references.length; i += BATCH_SIZE) {
      batches.push({ batch: references.slice(i, i + BATCH_SIZE), offset: i });
    }

    const settled = await runWithConcurrency(batches, SHORTLIST_CONCURRENCY, ({ batch, offset }) => {
      return callGeminiWithRetry(buildShortlistMessage(queryImage, batch, offset), SHORTLIST_TOOL, "score_batch");
    });

    for (const s of settled) {
      if (s.status === "rejected" && [429, 402].includes((s.reason as any)?.status)) throw s.reason;
    }

    const scoreMap: Record<number, number> = {};
    settled.forEach((s) => {
      if (s.status !== "fulfilled") return;
      for (const score of s.value.scores || []) {
        if (typeof score.reference_index === "number" && typeof score.score === "number") {
          scoreMap[score.reference_index] = score.score;
        }
      }
    });

    const ranked = references
      .map((ref, index) => ({ ref, index, score: scoreMap[index] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, FINAL_TOP_N);
    candidates = ranked.map((item) => item.ref);
    topShortlistScore = ranked[0]?.score;
  }

  const finalResult = await callGeminiWithRetry(buildFinalMessage(queryImage, candidates), FINAL_TOOL, "return_match");
  const matches = (finalResult.matches || []).map((match: any) => ({
    reference_index: match.reference_index,
    confidence: match.confidence,
    matched_features: match.matched_features || [],
    reference: candidates[match.reference_index] || null,
  }));

  return {
    matches,
    overall_analysis: finalResult.overall_analysis || "",
    shortlisted,
    total_references: references.length,
    candidates_evaluated: candidates.length,
    top_shortlist_score: topShortlistScore,
    elapsed_ms: Date.now() - started,
  };
}
