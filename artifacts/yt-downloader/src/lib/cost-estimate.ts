// Rough cost estimator for the identify-katha pipeline.
// Based on Gemini 2.5 Flash pricing via Lovable AI Gateway:
//   input  $0.30 / 1M tokens
//   output $2.50 / 1M tokens
// Each 1280px compressed image ≈ 258 tokens (Gemini image tokenization).

const BATCH_SIZE = 25;
const FINAL_TOP_N = 12;
const TOKENS_PER_IMAGE = 258;
const PROMPT_OVERHEAD_TOKENS = 300;
const SHORTLIST_OUTPUT_TOKENS = 400;
const FINAL_OUTPUT_TOKENS = 600;

const INPUT_PER_1M = 0.30;
const OUTPUT_PER_1M = 2.50;

export function estimateIdentifyCost(libraryCount: number) {
  if (libraryCount <= 0) return { usd: 0, batches: 0, inputTokens: 0, outputTokens: 0 };

  const shortlisted = libraryCount > FINAL_TOP_N;
  const batches = shortlisted ? Math.ceil(libraryCount / BATCH_SIZE) : 0;
  const finalCandidates = shortlisted ? FINAL_TOP_N : libraryCount;

  // 1 query image is sent in every call.
  const shortlistInput = batches * ((BATCH_SIZE + 1) * TOKENS_PER_IMAGE + PROMPT_OVERHEAD_TOKENS);
  const finalInput = (finalCandidates + 1) * TOKENS_PER_IMAGE + PROMPT_OVERHEAD_TOKENS;
  const inputTokens = shortlistInput + finalInput;

  const outputTokens = batches * SHORTLIST_OUTPUT_TOKENS + FINAL_OUTPUT_TOKENS;

  const usd = (inputTokens / 1_000_000) * INPUT_PER_1M + (outputTokens / 1_000_000) * OUTPUT_PER_1M;
  return { usd, batches: batches + 1, inputTokens, outputTokens };
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
