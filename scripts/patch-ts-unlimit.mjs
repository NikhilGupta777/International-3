/**
 * Removes the "1 per 4-8 min" density constraint from the timestamps prompt.
 * AI should capture EVERY distinct topic — no count limit at all.
 */
import { readFileSync, writeFileSync } from "fs";

const file = "artifacts/api-server/src/routes/timestamps.ts";
let src = readFileSync(file, "utf8");

// Remove the restrictive density rule and replace with an unlimited one
src = src.replace(
  `2. TARGET DENSITY: aim for 1 timestamp every 4-8 minutes of content. A 2-hour video = 15-20+ entries. A 30-min video = 5-8 entries. Never give fewer than 5.`,
  `2. COVERAGE: capture EVERY distinct topic, scripture, story, prophecy, bhajan, mantra, and segment — however many there are. A 2h video with 30 topic shifts gets 30 entries. Do NOT merge unrelated topics. Do NOT impose any maximum or minimum count — let the content dictate.`
);

// Also update the callGemini user message
src = src.replace(
  `Generate detailed topic-level timestamps (1 per 4-8 min, 15-20+ for a 2h video). Include endSec for each entry. Return ONLY the JSON array.`,
  `Generate topic-level timestamps — one entry for EVERY distinct topic, bhajan, story, scripture, or segment in the video. No count limit. Include endSec for each entry. Return ONLY the JSON array.`
);

writeFileSync(file, src, "utf8");
console.log("✅ Density limit removed from timestamps prompt.");
