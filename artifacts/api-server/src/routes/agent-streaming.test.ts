import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("agent streams visible model text chunks while reading provider stream", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  const chunkTextBlock = source.match(
    /if \(chunkText\) \{[\s\S]*?pendingTextBuf \+= chunkText;[\s\S]*?\n\s*\}/,
  )?.[0];

  assert.ok(chunkTextBlock, "expected agent stream loop to handle chunkText");
  assert.match(
    chunkTextBlock,
    /emitCanvasRoutedText\(chunkText\)/,
    "chunkText should be emitted live instead of only buffered until final response",
  );
});

test("Copilot exposes NVIDIA primaries with model-specific fallbacks", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.match(source, /const ULTRA_MODEL = COPILOT_ULTRA_MODEL/);
  assert.match(source, /const FAST_MODEL = COPILOT_FAST_MODEL/);
  assert.match(source, /streamExternalCopilot/);
  assert.match(source, /getCopilotFallbackModels\(activeModel\)/);
  assert.doesNotMatch(source, /FAST_INPUT_CHAR_LIMIT/);
  assert.match(source, /AI models are temporarily unavailable/);
  assert.doesNotMatch(source, /streamCopilotViaOracle/);
});
