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

test("Copilot exposes configured primaries with model-specific fallbacks", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.match(source, /const ULTRA_MODEL = COPILOT_ULTRA_MODEL/);
  assert.match(source, /const FAST_MODEL = COPILOT_FAST_MODEL/);
  assert.match(source, /streamExternalCopilot/);
  assert.match(source, /getCopilotFallbackModels\(activeModel\)/);
  assert.doesNotMatch(source, /FAST_INPUT_CHAR_LIMIT/);
  assert.match(source, /AI models are temporarily unavailable/);
  assert.doesNotMatch(source, /streamCopilotViaOracle/);
  assert.match(
    source,
    /const visibleTools = fastMode/,
    "Ultra requests should retain the full tool catalog even when modes share a model",
  );
  assert.match(
    source,
    /model === COPILOT_ULTRA_FALLBACK_MODEL[\s\S]*?basePrompt = OLLAMA_ULTRA_FALLBACK_SYSTEM_PROMPT/,
    "Ollama fallback should use a compact Ultra-capable prompt",
  );
  assert.match(source, /return `\$\{basePrompt\}\\n\\n\$\{CLIP_DELIVERY_PROMPT\}`/);
  assert.doesNotMatch(
    source.match(/const OLLAMA_ULTRA_FALLBACK_SYSTEM_PROMPT = `[\s\S]*?`;/)?.[0] ?? "",
    /switch to Ultra/i,
  );
  assert.match(
    source,
    /const SYSTEM_PROMPT = `You are VideoMaking Studio Copilot in Ultra mode[\s\S]{0,500}selected app mode for this request is Ultra[\s\S]{0,500}Never claim that the user is on Fast mode/,
  );
  assert.match(source, /type: "model_status"[\s\S]*?fallback: true/);
});

test("vision tools always use the media-capable Gemini helper", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  const executorStart = source.indexOf("async function executeTool");
  for (const toolName of ["describe_image", "extract_text_from_image"]) {
    const start = source.indexOf(`case "${toolName}":`, executorStart);
    const end = source.indexOf("\n    case ", start + 1);
    const toolCase = source.slice(start, end);
    assert.match(toolCase, /model: GEMINI_HELPER_MODEL/);
    assert.doesNotMatch(toolCase, /model: AGENT_MODEL/);
  }
});

test("agent job lifecycle validates IDs and releases completed jobs", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.match(source, /function requireAgentJobId/);
  assert.match(source, /requireAgentJobId\([\s\S]{0,120}"Clip cut"/);
  assert.match(source, /requireAgentJobId\([\s\S]{0,120}"Video download"/);
  assert.match(source, /forgetAgentJob\(req, subtitleJobId\)/);
  assert.match(source, /forgetAgentJob\(req, jobId\)/);
  assert.match(
    source,
    /await cancelAgentRunJobs\([\s\S]*?clientConnected \? "agent_error" : "client_abort"/,
  );
});

test("both navigation tools enforce the frontend tab allowlist", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  const executorStart = source.indexOf("async function executeTool");
  for (const toolName of ["navigate_to_tab", "send_result_to_tab"]) {
    const start = source.indexOf(`case "${toolName}":`, executorStart);
    const end = source.indexOf("\n    case ", start + 1);
    assert.match(source.slice(start, end), /ALLOWED_NAV_TABS\.has\(tab\)/);
  }
});

test("chat input normalizes missing bodies and malformed attachments", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.match(source, /req\.body && typeof req\.body === "object"/);
  assert.match(source, /normalizeAgentAttachments\(message\.attachments\)/);
  assert.match(source, /value\.slice\(0, 12\)/);
});

test("ordinary conversation history is never silently truncated", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.doesNotMatch(source, /MAX_HISTORY_MESSAGES/);
  assert.doesNotMatch(source, /messages\.slice\(-/);
  assert.match(source, /const normalizedMessagesRaw = messages/);
});

test("YouTube caption tool keeps the complete fetched SRT in model context", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  const captionCase = source.match(
    /case "get_youtube_captions":[\s\S]*?case "generate_captions_with_assemblyai":/,
  )?.[0] ?? "";

  assert.match(captionCase, /const content = rawText;/);
  assert.match(captionCase, /fullContentInContext: true/);
  assert.match(captionCase, /signal: captionController\.signal/);
  assert.match(captionCase, /MAX_CAPTION_BYTES,\s*captionController/);
  assert.doesNotMatch(captionCase, /rawText\.slice\(/);
});

test("clip discovery returns recommendations in chat instead of only a tab", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  const executorStart = source.indexOf("async function executeTool");
  const bestClipsStart = source.indexOf('case "find_best_clips":', executorStart);
  const bestClipsEnd = source.indexOf('case "generate_timestamps":', bestClipsStart);
  const bestClipsCase = source.slice(bestClipsStart, bestClipsEnd);

  assert.match(bestClipsCase, /youtube\/clips\/status/);
  assert.doesNotMatch(bestClipsCase, /youtube\/progress/);
  assert.match(bestClipsCase, /clips: clipResult\.clips/);
  assert.match(bestClipsCase, /Present every returned clip in the visible chat/);
  assert.match(source, /never respond with only the table, Best Clips tab, tool card/);
  assert.match(source, /Clip discovery rules for every mode/);
  assert.match(source, /Use the complete available context for long documents and transcripts/);
});

test("text-only answers are never rewritten as unfinished actions", () => {
  const source = readFileSync(join(__dirname, "agent.ts"), "utf8");
  assert.match(source, /Disabled legacy unfinished-action guard/);
  assert.doesNotMatch(source, /^function looksLikeUnfulfilledActionPromise/m);
  assert.doesNotMatch(source, /^\s*let noActionNudges\s*=/m);
});
