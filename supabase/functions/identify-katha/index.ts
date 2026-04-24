// Edge function: identifies a katha image against reference dataset.
// Strategy: parallel shortlist batches (with retry), then final ranked pass on top candidates.
import {
  buildFinalMessage, buildShortlistMessage,
  FINAL_TOOL, SHORTLIST_TOOL, RefItem,
} from "./prompts.ts";
import { callGeminiWithRetry } from "./gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 25;       // images per shortlist call
const FINAL_TOP_N = 12;      // candidates fed to final ranking
const SHORTLIST_CONCURRENCY = 4; // parallel shortlist calls

// Run async tasks with a concurrency cap. Returns settled results in input order.
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const queryImage: string = body.queryImage;
    const references: RefItem[] = body.references;

    if (!queryImage || !Array.isArray(references) || references.length === 0) {
      return new Response(JSON.stringify({ error: "queryImage and non-empty references required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const t0 = Date.now();
    console.log(`Identifying against ${references.length} references`);

    let candidates: RefItem[] = references;
    let shortlisted = false;
    let topShortlistScore: number | undefined;

    // Stage 1 - parallel shortlist if dataset is large
    if (references.length > FINAL_TOP_N) {
      shortlisted = true;
      const batches: { batch: RefItem[]; offset: number }[] = [];
      for (let i = 0; i < references.length; i += BATCH_SIZE) {
        batches.push({ batch: references.slice(i, i + BATCH_SIZE), offset: i });
      }

      const settled = await runWithConcurrency(batches, SHORTLIST_CONCURRENCY, async ({ batch, offset }) => {
        const messages = buildShortlistMessage(queryImage, batch, offset);
        return await callGeminiWithRetry(messages, SHORTLIST_TOOL, "score_batch");
      });

      // Abort whole run only on hard credit/rate errors.
      for (const s of settled) {
        if (s.status === "rejected") {
          const st = (s.reason as any)?.status;
          if (st === 429 || st === 402) throw s.reason;
        }
      }

      const scoreMap: Record<number, number> = {};
      settled.forEach((s, batchIdx) => {
        if (s.status !== "fulfilled") {
          console.error(`Shortlist batch ${batchIdx} failed:`, (s.reason as any)?.message);
          return;
        }
        for (const sc of s.value.scores || []) {
          if (typeof sc.reference_index === "number" && typeof sc.score === "number") {
            scoreMap[sc.reference_index] = sc.score;
          }
        }
      });

      const ranked = references
        .map((r, idx) => ({ r, idx, score: scoreMap[idx] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, FINAL_TOP_N);
      candidates = ranked.map((x) => x.r);
      topShortlistScore = ranked[0]?.score;
      console.log(`Shortlisted to ${candidates.length} candidates in ${Date.now() - t0}ms, top score ${topShortlistScore}`);
    }

    // Stage 2 - final ranking
    const finalResult = await callGeminiWithRetry(
      buildFinalMessage(queryImage, candidates),
      FINAL_TOOL,
      "return_match",
    );

    const enriched = (finalResult.matches || []).map((m: any) => {
      const ref = candidates[m.reference_index] ?? null;
      return {
        reference_index: m.reference_index,
        confidence: m.confidence,
        matched_features: m.matched_features,
        reference: ref,
      };
    });

    console.log(`Total identify time: ${Date.now() - t0}ms`);

    return new Response(JSON.stringify({
      matches: enriched,
      overall_analysis: finalResult.overall_analysis,
      shortlisted,
      total_references: references.length,
      candidates_evaluated: candidates.length,
      top_shortlist_score: topShortlistScore,
      elapsed_ms: Date.now() - t0,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    console.error("identify-katha error:", e.message);
    const status = e.status || 500;
    let msg = e.message || "Unknown error";
    if (status === 429) msg = "Rate limit exceeded. Please wait a minute and try again.";
    if (status === 402) msg = "AI credits exhausted. Add funds in Settings -> Workspace -> Usage.";
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});



