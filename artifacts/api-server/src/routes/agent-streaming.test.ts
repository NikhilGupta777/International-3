import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("agent streams visible model text chunks while reading Gemini stream", () => {
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

test("Copilot Ultra uses the Oracle Vertex broker and retains API-key fallback", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.match(source, /const ULTRA_MODEL = "gemma-4-26b-a4b-it"/);
  assert.match(source, /isCopilotUltraVertexEnabled\(\)/);
  assert.match(source, /streamCopilotViaOracle/);
  assert.match(source, /falling back to Gemini API-key routing/);
  assert.doesNotMatch(source, /ensureVertexCredentials\(true\)/);
  assert.doesNotMatch(source, /vertex: useVertex/);
});
