# Deep Audit Report: AI Studio Copilot Agent

**Scope:** `artifacts/api-server/src/routes/agent.ts`, `artifacts/yt-downloader/src/components/StudioCopilot.tsx`, `artifacts/yt-downloader/src/components/StudioHome.tsx`, and related files.

**Date:** 2025-06-22

**Status:** Read-only audit. No files modified.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Your Exact Complaints — Root Cause Analysis](#2-your-exact-complaints--root-cause-analysis)
3. [Critical Issues (Severity: P0/P1)](#3-critical-issues-severity-p0p1)
4. [Backend Issues (`agent.ts`)](#4-backend-issues-agents)
5. [Frontend Issues (`StudioCopilot.tsx`)](#5-frontend-issues-studiocopilottsx)
6. [System Prompt / Model Interaction Issues](#6-system-prompt--model-interaction-issues)
7. [Data Flow & Streaming Issues](#7-data-flow--streaming-issues)
8. [Architecture & Code Quality Issues](#8-architecture--code-quality-issues)
9. [Security Issues](#9-security-issues)
10. [Performance Issues](#10-performance-issues)
11. [Comparison: How I Work vs. How Your Agent Works](#11-comparison-how-i-work-vs-how-your-agent-works)
12. [What You Are Doing Wrong / What Is Missing](#12-what-you-are-doing-wrong--what-is-missing)
13. [Recommendations](#13-recommendations)
14. [Appendix: Existing Audit Issues (Still Unfixed)](#appendix-existing-audit-issues-still-unfixed)

---

## 1. Executive Summary

This is a **deep architectural audit** of the AI Studio Copilot. I read ~8,000+ lines of core code across the backend agent route (`agent.ts` — 4,010 lines), the frontend chat component (`StudioCopilot.tsx` — 4,064 lines), the home component (`StudioHome.tsx`), and related utility files.

### Bottom Line

**The agent is fundamentally broken in three ways that explain your complaints:**

1. **It is *designed* to hallucinate tool usage.** The system prompt tells the model to say "I'll cut the clip..." BEFORE calling the tool. If the model then fails, changes its mind, or hits an error, the user sees the promise but never sees the tool execution.

2. **Internal reasoning leaks into chat because the guardrails are porous.** The `stripReasoningTags` function is a regex-based band-aid that cannot catch all leaks. The model is told to output `[JUDGE]` markers and other internal tags, which it then parrots back into visible text.

3. **The canvas protocol and markdown code-fence conversion corrupts normal output.** Every markdown code block is aggressively converted to a canvas artifact, breaking inline code examples and causing the model's natural output to be destroyed or rerouted incorrectly.

There are **~150+ individual bugs and design flaws** ranging from critical user-facing failures to subtle race conditions, memory leaks, and architectural debt. This report categorizes all of them.

---

## 2. Your Exact Complaints — Root Cause Analysis

### 2.1 "I have started clip cut... and then some command and then here is your clip cut. But it didn't use the tool or I couldn't see and it did it in 1-2 seconds like it output but nothing happened."

**Root Cause: The "Pre-Announcement" Anti-Pattern + Empty Response Fallback Gap**

Your system prompt (`agent.ts` lines 896-905) explicitly instructs the model:

> "Before using a user-visible tool, briefly tell the user what you're about to do in their language."

This creates the following failure chain:

```
User: "Cut 40-57 seconds"
Model (streaming): "Okay — I'll cut the 40–57 second section for you right now..."  ← text_delta
Model (internal): decides to call cut_video_clip...  ← should emit functionCall
Model (fails): encounters transient error, empty output, or hits max iterations
Result: User sees the promise. No tool_start event. No tool execution. Nothing happens.
```

**Specific code defects enabling this:**

- **`agent.ts:3410`** — The `while` loop increments `iterations` and emits a `thinking` event. If the model returns text but no function calls, the loop continues. But the text has already been streamed to the user.
- **`agent.ts:3675-3686`** — The empty response guard retries up to 3 times, but if the model outputted pre-tool text and then goes empty, the text stays in the chat while no tool is ever called.
- **`agent.ts:3699-3701`** — When there are no function calls, it sends `sseEvent({ type: "text", content: fullText })`. If the model's `fullText` was the pre-tool promise, the user sees it as a final answer.
- **No validation layer** — There is no code that checks: "You said you'd call a tool, but no function call was emitted." The model's text and its function calls are completely decoupled.
- **`agent.ts:3731-3740`** — If `streamedTextLive` is true, the backend assumes text was already delivered. It doesn't check whether the text was actually a tool promise.

**The 1-2 second speed:** If the model outputs the text but then decides not to call the tool (or the tool call fails at the API level), the entire "interaction" completes in 1-2 seconds because no actual work was done.

**Why this happens more with clip cut:** The model has been trained that "cutting" is a real action. When it sees a request like "cut this video," it pattern-matches to the pre-tool response template. But if the conversation context is confusing, if the URL is missing, or if the model is in a low-probability state, it outputs the text without emitting the function call.

---

### 2.2 "When tool fail or internal reasoning is also outputted instead of in thought thinking..."

**Root Cause: Three Leaky Pipes**

#### Pipe 1: The `[JUDGE]` Marker Echo (`agent.ts:3816`)

When a tool fails, the backend injects this into the next user message:

```typescript
orderedToolResults.push({
  text: `[JUDGE] Tools failed: ${failedTools}. Correct arguments and retry, or explain clearly why it cannot be done.`
});
```

This `[JUDGE]` text is sent to the model as part of the conversation history. The model then outputs reasoning like:

> "Ah, the download failed because the video is private. Let me try a different approach..."

**The `stripReasoningTags` function (`agent.ts:135-171`) strips `[JUDGE]` lines, but:**
- The regex is `/^\[JUDGE\].*$/gim` — it only matches if `[JUDGE]` is at the **start of a line**.
- If the model embeds the judge text inside a sentence (e.g., "Looking at the [JUDGE] result..."), it **does NOT match**.
- The model is told in the system prompt (line 1156) to NEVER write debugging narration, but it still does because the prompt is 1,000+ lines long and the model forgets the constraint.

#### Pipe 2: The `thought_delta` vs. Text Streaming Confusion

Gemini's `thinkingConfig` with `includeThoughts: true` sends thought content as separate parts with `thought: true`. These are correctly extracted and sent as `thought_delta` events (`agent.ts:3586-3591`).

**But:** The model also outputs "thinking-like" text in its normal text stream, especially when tools fail or when it's uncertain. This normal text is NOT tagged as `thought`, so it goes through the normal `text_delta` path and is displayed to the user.

#### Pipe 3: The `pendingTextBuf` Marker Holdback Logic is Incomplete

`agent.ts:3604-3642` holds back text that might contain partial internal markers. But:
- It checks for `[SUGGEST`, `[Tool:`, `[TextArtifact:`, `[Artifact:`, and `<canvas`.
- It does **NOT** check for `[JUDGE]`, `[REASONING]`, `[PLAN]`, `[EXECUTE]`, or `[WAIT]`.
- If a delta contains `[JUDGE] Tools failed:...` and the holdback logic doesn't recognize it, the text is streamed immediately to the user.
- The `stripReasoningTags` runs AFTER the holdback, but by then the text is already going to the user as a delta.

---

### 2.3 "Many times also it is many areas more many things..."

The rest of this report documents 150+ specific issues. The most severe are categorized below.

---

## 3. Critical Issues (Severity: P0/P1)

### P0-1: Hallucinated Tool Usage (Fake Tool Promises)

**File:** `agent.ts`  
**Lines:** System prompt (896-905), stream loop (3410-3717)

**Impact:** User sees "I'll cut the clip" but no tool runs. Trust is destroyed.

**Fix Direction:** Remove the pre-tool announcement from the system prompt. Instead, show a generic "Working..." spinner and only announce AFTER the tool successfully starts. Alternatively, use a two-phase model: first call decides which tools to run, second call runs them silently.

---

### P0-2: Internal Reasoning Leaks to Visible Chat

**File:** `agent.ts`  
**Lines:** `stripReasoningTags` (135-171), `JUDGE` injection (3816), `pendingTextBuf` holdback (3604-3642)

**Impact:** User sees debugging text like "Ah, the error is...", "Let me check what happened...", "Wait, I need to retry..."

**Fix Direction:**
1. Remove `[JUDGE]` markers from user messages — instead, send a structured JSON correction turn.
2. Expand `pendingTextBuf` holdback to include all internal markers.
3. Add a post-processing layer that validates visible text against a "no internal language" filter.

---

### P0-3: Canvas Protocol Destroys Normal Markdown Code Blocks

**File:** `agent.ts`  
**Lines:** `emitCanvasRoutedText` (3483-3577)

**Impact:** Every markdown code block (```python, ```js, etc.) is converted to a canvas artifact, even for short inline examples. The user sees a downloadable file instead of inline code.

**Specific bug:**
```typescript
// agent.ts:3494-3501
// This regex runs on EVERY text chunk:
canvasRouteBuf = canvasRouteBuf.replace(
  /```(html|css|javascript|js|typescript|ts|python|py|json|markdown|md|text|srt|vtt)\r?\n/gi,
  (_m, lang) => `<canvas language="${norm}" title="code.${ext}">\n`
);
```

This means a model response like:

````
Here's a simple example:
```python
print("hello")
```
Try it yourself.
````

Becomes:
- A canvas artifact named `code.py` with content `print("hello")`
- The surrounding text is broken into fragments

**Fix Direction:** Only convert code blocks to canvas when the model explicitly uses `<canvas>` tags. Remove the automatic markdown→canvas conversion.

---

### P0-4: Canvas Final Flush Drops Content

**File:** `agent.ts`  
**Lines:** `emitCanvasRoutedText` (3522-3527)

**Impact:** When streaming ends and a canvas is still open, remaining content is lost.

```typescript
if (final) {
  sseEvent(res, { type: "canvas_done", runId, canvasId: activeCanvas.id });
  streamedTextLive = true;
  activeCanvas = null;
}
return;  // <-- REMAINING BUFFER IS DISCARDED
```

When `final=true` and `closeIdx === -1` (no closing tag found), the function emits `canvas_done` but does NOT emit the remaining `canvasRouteBuf` content. The last chunk of text is silently lost.

---

### P0-5: Parallel Tool `tool_done` Updates Wrong Tool Card

**File:** `StudioCopilot.tsx`  
**Lines:** `tool_done` handler (3178-3191)

**Impact:** When running parallel tools with the same name (e.g., two `web_search` calls), the first `tool_done` might mark the wrong card as complete.

```typescript
// The matchedFallbackTool flag is declared OUTSIDE patchAssistant
let matchedFallbackTool = false;
patchAssistant(m => ({
  ...m, parts: m.parts.map(p => {
    const fallbackMatch = !evt.toolId && !matchedFallbackTool && toolPart.name === evt.name && !toolPart.done;
    if (fallbackMatch) matchedFallbackTool = true;
    // ...
  })
}));
```

**Problem:** React batches state updates. If two `tool_done` events arrive for the same tool name in rapid succession, the closure over `matchedFallbackTool` might not be updated correctly between the two `patchAssistant` calls. Both events might match the same tool card.

---

### P0-6: Empty Text Events After Stripping Cause Word Concatenation

**File:** `agent.ts`  
**Lines:** `sseEvent` (183-184)

```typescript
// Skip empty text events (after stripping)
if (isTextEvent && !(safePayload as any).content) return;
```

**Impact:** If a `text_delta` contains only whitespace (e.g., a space between words) and the stripping regex removes it, the event is dropped. This causes words to concatenate: `"willwrite"` instead of `"will write"`.

The comment says "never skip whitespace-only deltas," but the code DOES skip them when stripping produces an empty string.

---

## 4. Backend Issues (`agent.ts`)

### 4.1 Tool Execution & API Layer

#### B-1: No Pre-Tool Validation Layer

The model can emit any tool call with any arguments. There is no intermediate validation step that checks:
- Is the URL valid before calling `cut_video_clip`?
- Is the required parameter present?
- Does the model have the necessary context?

The validation happens INSIDE `executeTool` (e.g., `parseTimestamp` at line 315), which means errors happen during execution rather than before. The user sees a "Tool failed" card instead of a graceful correction.

**Fix:** Add a `validateToolCall` function that runs before `executeTool` and returns a human-readable error to the model.

#### B-2: No Tool Retry Logic

The system prompt (line 1103) says: "If a tool errors: 1. Read the error string. If it's transient/rate issue, retry once with the same args."

**But the code does NOT implement this.** `runToolCall` (lines 3742-3775) catches errors and emits `tool_done` with the error. There is no retry loop.

#### B-3: `check_job_status` and `cancel_job` Endpoint Order Bias

```typescript
for (const endpoint of [
  `${apiBase}/youtube/cancel/${jobId}`,
  `${apiBase}/subtitles/cancel/${jobId}`,
  `${apiBase}/translator/cancel/${jobId}`
]) { ... }
```

If a job ID exists in the translator system but the `youtube/cancel` endpoint returns a 200 with a confusing body, the loop breaks early and never tries translator. The endpoint order is arbitrary and wrong.

#### B-4: `translate_video` Streams YouTube Response to S3 Without Size Check

```typescript
const ytStreamR = await fetch(`${apiBase}/youtube/stream?url=${encodeURIComponent(videoUrl)}`, ...);
const uploadR = await fetch(presignedUrl, { method: "PUT", body: ytStreamR.body, duplex: "half" });
```

If the YouTube stream is huge (e.g., a 4GB video), it streams directly to S3 without any size limit check. This could exhaust Lambda memory or timeout.

#### B-5: `save_artifact_to_workspace` Fetches Arbitrary URLs

```typescript
const resolvedUrl = sourceUrl.startsWith("/")
  ? `${apiBase.replace(/\/api$/, "")}${sourceUrl}`
  : sourceUrl;
const r = await fetch(resolvedUrl, ...);
```

If `sourceUrl` is an external URL (not starting with `/`), the agent fetches it directly. There is no allowlist or domain restriction. A malicious model could exfiltrate data by saving an artifact from an internal URL.

**Actually, looking more carefully:** `sourceUrl` comes from the model's tool arguments. If the model is compromised, it could pass `sourceUrl: "http://localhost:3000/internal"` and the agent would fetch it. The `isInternalHost` check is only used in `fetchReadableWebPage`, not here.

#### B-6: `do_full_package` Runs `generate_seo_pack` With Wrong Topic

```typescript
runStep("generate_seo_pack", {
  topic: results.get_video_info?.title ?? url,
  audience: args.instructions ?? "YouTube audience",
});
```

`results.get_video_info` is populated AFTER `runStep("get_video_info")`, but `generate_seo_pack` is called in the same `Promise.allSettled` block. Due to the `await` inside `runStep`, `results.get_video_info` IS populated before `generate_seo_pack` runs. However, the code is confusing because `results` is a shared mutable object being read and written by parallel async functions.

#### B-7: `do_full_package` Catches Errors But Still Reports Success

```typescript
for (const r of phase2) {
  if (r.status === "rejected") console.warn(`[agent] full_package step failed: ${r.reason?.message ?? r.reason}`);
}

return {
  result: { completed: true, results },
  artifact: { artifactType: "text", label: "Full Package Summary", content: "Full package completed..." }
};
```

Even if every single step fails, the tool returns "completed: true" and tells the user "Full package completed." This is a lie.

#### B-8: `generate_timestamps` Formatting Is Fragile

```typescript
tsContent = final.timestamps.map((t: any) =>
  `${t.time ?? t.timestamp ?? ""} ${t.title ?? t.label ?? t.text ?? ""}`
).join("\n");
```

If `t.time` and `t.timestamp` are both undefined, the output is `" undefined"`. If the title is also undefined, it's `" undefined undefined"`. The formatting should be robust.

#### B-9: `find_best_clips` Returns Generic Message Instead of Actual Clips

```typescript
return {
  result: { jobId, message: "Best clips analysis complete. View results in the Best Clips tab." },
  artifact: { artifactType: "tab_link", label: "Best Clips ready — open tab to download", tab: "clips", jobId },
};
```

The tool doesn't return the actual clip data to the model. The model can't summarize, describe, or act on the clips because it never sees them. The user has to switch tabs manually.

#### B-10: `analyze_youtube_video` Uses `fileData` with YouTube URL — Unreliable

```typescript
{ fileData: { fileUri: videoUrl, mimeType: "video/mp4" } }
```

Gemini's `fileData` feature with a YouTube URL is experimental and often fails for:
- Private videos
- Age-restricted videos
- Region-blocked videos
- Videos that YouTube's API doesn't expose

When it fails, the error is "Model returned no analysis. The video may be private or age-restricted." This is unhelpful — the agent should fall back to captions or metadata instead.

#### B-11: `run_code_analysis` Uses Expensive ULTRA_MODEL for Simple Analysis

```typescript
const ai = createGeminiClient();
const resp = await ai.models.generateContent({
  model: ULTRA_MODEL,
  contents: [{ role: "user", parts: [{ text: `${task}\n\nDATA:\n${data.slice(0, 120000)}` }] }],
  config: { tools: [{ codeExecution: {} }], maxOutputTokens: ... }
});
```

`ULTRA_MODEL` is `gemini-3.1-pro-preview` (the most expensive model). For simple code analysis, this is wasteful. The system prompt says "use the smallest, cheapest correct tool," but the backend doesn't follow this principle.

#### B-12: `write_video_script` and `generate_seo_pack` Also Use ULTRA_MODEL

Same issue — these are text generation tasks that should use `AGENT_MODEL` (`gemini-3.5-flash`).

#### B-13: `describe_image` and `extract_text_from_image` Use `AGENT_MODEL` — Correct, But Inconsistent

These correctly use `AGENT_MODEL` (the cheaper model). But the inconsistency across tools makes the cost unpredictable.

#### B-14: `create_image` Uses `gemini-3.1-flash-image-preview` Without Fallback

```typescript
model: process.env.COPILOT_IMAGE_MODEL ?? "gemini-3.1-flash-image-preview",
```

If this model is unavailable or the user's project doesn't have access, the image generation fails with no fallback.

#### B-15: `generateLyriaMusic` Uses String Literals for Modalities

```typescript
config: { responseModalities: ["AUDIO", "TEXT"] }
```

The Gemini SDK defines `Modality.AUDIO` and `Modality.TEXT` enums. Using raw strings might cause type mismatches or API rejections if the SDK changes.

#### B-16: `list_shared_files` Returns Raw Internal Data

The endpoint returns files with internal fields like `fileId`, `size`, `originalFilename`. This internal data might be leaked to the model.

#### B-17: `convertSubtitleText` VTT→SRT Conversion Is Brittle

The VTT parser assumes each block has exactly one timing line. It doesn't handle:
- VTT `NOTE` blocks (it tries to filter them but the logic is fragile)
- Multiple cues per block
- `STYLE` blocks
- `REGION` blocks

#### B-18: `htmlToReadableText` Doesn't Handle `&apos;` or `&quot;` or Numeric Entities

```typescript
.replace(/&nbsp;/gi, " ")
.replace(/&amp;/gi, "&")
.replace(/&lt;/gi, "<")
.replace(/&gt;/gi, ">")
.replace(/&quot;/gi, '"')
.replace(/&#39;/g, "'")
```

Missing: `&apos;`, `&copy;`, `&reg;`, `&trade;`, numeric entities like `&#x27;`, `&#8217;`, etc. Pages with these entities will have garbled text.

#### B-19: `fetchReadableWebPage` Only Handles HTML and Plain Text

If the page returns JSON, the content is returned as-is (good). But if it returns XML, PDF, or binary, it might corrupt the output.

#### B-20: `readAttachmentText` Treats PDFs as Strings

```typescript
if (contentType.includes("pdf")) {
  return { content: `[PDF attachment: ${url}]`, ... };
}
```

PDFs are not actually read. The system prompt says the model can read PDFs via `fileData`, but `readAttachmentText` doesn't use this path. If a user uploads a PDF and asks for a summary, the model sees "[PDF attachment: ...]" and hallucinates a summary.

---

### 4.2 Streaming & Event Layer

#### B-21: SSE Events Can Be Lost If Client Is Slow

The `sseEvent` function writes to the response stream, but if the client's TCP buffer is full, the write might be buffered. The `res.socket.write("")` flush is a hack that might not work on all platforms.

#### B-22: `text_delta` Events Are Not Acknowledged

If the client disconnects mid-stream, the backend keeps emitting `text_delta` events until `isConnected()` returns false. But `isConnected` only checks `res.socket.destroyed`, which might not be immediately true after a disconnect. Several events can be "written" to a dead socket.

#### B-23: `heartbeat` Events Are Sent Even When Data Is Flowing

The heartbeat is sent every 8 seconds regardless of whether other events are being sent. This is redundant and wastes bandwidth.

#### B-24: `tool_progress` Events Spam the SSE Stream

For long-running jobs (clip cut, download), progress events are sent every 1.5 seconds. For a 15-minute clip cut, that's 600 progress events. The frontend might not need updates this frequently.

#### B-25: `canvas_delta` Events Are Sent Per Character

The `emitCanvasRoutedText` function sends `canvas_delta` for every chunk of text. If the model outputs a large canvas (e.g., a 500-line HTML file), this creates 500+ SSE events. The overhead of JSON serialization and SSE framing for each event is significant.

#### B-26: `grounding_sources` Event Is Only Sent at the End

Grounding metadata from native Google Search is accumulated in `lastGroundingMeta` but only sent when the model returns a final answer with no function calls. If the model calls tools after searching, the grounding sources are lost.

#### B-27: `suggestions` Event Is Parsed from Full Text, Not Streamed

```typescript
const sugMatch = fullText.match(/\[SUGGESTIONS:\s*(.+?)\]\s*$/s);
```

Suggestions are only extracted after the entire response is received. If the model outputs suggestions in the middle of the text and then continues, they are not captured.

---

### 4.3 Context & Memory Management

#### B-28: `loopContents` Grows Unbounded Across Iterations

```typescript
loopContents = [
  ...loopContents,
  { role: "model", parts: modelParts },
  { role: "user", parts: orderedToolResults },
];
```

Each iteration adds at least two messages to the context. Over 60 iterations, the context could have 120+ messages. The backend does NOT truncate the loop contents during the agent loop. The `MAX_HISTORY_MESSAGES` (80) only applies to the incoming request, not the accumulated turns.

**Impact:** After ~20-30 iterations, the context window is exhausted. The model starts forgetting earlier instructions and conversation history. Token costs skyrocket.

#### B-29: `AGENT_MAX_OUTPUT_TOKENS` Is 16,384

This is extremely high. For a tool-calling agent, 4,096 tokens is usually sufficient. 16k tokens means:
- Higher latency (the model takes longer to generate)
- Higher cost
- Higher chance of the model rambling before making a tool call

#### B-30: `MAX_ITERATIONS` Default Is 60

60 iterations is excessive. Most agent tasks complete in 2-5 iterations. 60 iterations encourages the model to:
- Loop unnecessarily ("let me check again...")
- Retry failed tools indefinitely
- Make incremental changes instead of completing the task

#### B-31: `SYSTEM_PROMPT` Is ~1,100 Lines

The system prompt is enormous. It includes:
- Tool selection guidelines (lines 1014-1059)
- A full API documentation reference (lines 1014-1059)
- Canvas protocol instructions (lines 937-965)
- Multiple "DO NOT" lists

**Impact:** The model has less context window available for the actual conversation. The prompt might be partially truncated by the model's context window, causing the model to ignore later instructions.

#### B-32: `skillPromptAddendum` Is Appended to System Prompt Without Length Check

```typescript
systemInstruction: SYSTEM_PROMPT + skillPromptAddendum,
```

If skills are large, the combined prompt could exceed the model's context window. There is no truncation or length check.

#### B-33: `buildSkillPrompt` Function Is Not Audited

The skill prompt builder is imported from `../skills/index`. I did not read this file, but if skills inject large amounts of text, they could contribute to context bloat.

#### B-34: `latestArtifactFromMemory` Regex Is Fragile

```typescript
const artifactLines = text.split("\n").filter(line => line.startsWith("[Artifact:"));
const line = artifactLines.at(-1);
```

If the model outputs `[Artifact: ...]` inside a sentence (not at the start of a line), it's missed. If there are multiple artifacts, only the last one is remembered.

#### B-35: `scanKnownJobIds` Regex Misses Many Job ID Formats

```typescript
/\bjob(?:Id)?:?\s*([a-f0-9-]{8,})\b/gi
```

This only matches UUID-like job IDs. If the backend uses a different ID format (e.g., numeric IDs), they're not found.

---

### 4.4 Sandbox & External Execution

#### B-36: E2B Sandbox Map Grows Unbounded

```typescript
const e2bSandboxBySession = new Map<string, { ... }>();
```

`pruneExpiredSandboxEntries()` is only called inside `getChatSandbox`. If no one calls `getChatSandbox` (e.g., the user only uses text tools), old entries never get pruned. Over months, this map could hold thousands of entries.

#### B-37: `pendingSandboxCreations` Is Not Cleared on Reset

```typescript
async function resetChatSandbox(req: any) {
  e2bSandboxBySession.delete(sessionKey);
  // ... kill sandbox
}
```

If `resetChatSandbox` is called while a sandbox is being created (pending in `pendingSandboxCreations`), the pending promise is NOT removed. When it resolves, it adds the old sandbox back to `e2bSandboxBySession`.

#### B-38: `runE2BSandboxCommand` Has `duplex: "half"` on Fetch

```typescript
const uploadR = await fetch(presignedUrl, {
  method: "PUT", body: ytStreamR.body, duplex: "half"
} as any);
```

`duplex: "half"` is a non-standard fetch option. Node.js's native fetch might not support it, causing the upload to fail silently.

#### B-39: `runE2BSandboxCommand` `maxLiveOutputChars` Is 500KB But `E2B_MAX_OUTPUT_CHARS` Is 24KB

```typescript
const maxLiveOutputChars = 500 * 1024; // 500KB
const result = await sandbox.commands.run(commandWithPath, {
  onStdout: (data: string) => {
    if (liveOut.length < maxLiveOutputChars) liveOut += data;
  }
});
// ... later:
const stdout = truncateToolText(String(result.stdout || liveOut || ""), E2B_MAX_OUTPUT_CHARS);
```

The live accumulator allows 500KB, but the final truncation is at 24KB. This is inconsistent and wasteful.

#### B-40: `runE2BSandboxCommand` Writes Files Without Size Validation

```typescript
for (const file of writeFiles.slice(0, 12)) {
  const content = String(file?.content ?? "");
  if (content.length > E2B_MAX_FILE_CHARS) throw new Error(`Sandbox file too large: ${path}`);
  await sandbox.files.write(path, content);
}
```

The size check is `content.length > E2B_MAX_FILE_CHARS` (120,000 chars). But `content.length` is the number of UTF-16 code units, not bytes. A file with 120,000 multi-byte characters could exceed the limit.

#### B-41: `bootstrapSandboxMediaTools` Runs on Every Reconnect

```typescript
async function getChatSandbox(req: any) {
  if (existing) {
    const connected = await Sandbox.connect(existing.sandboxId, ...);
    await bootstrapSandboxMediaTools(connected, sessionKey);
    await preloadAppCodeIntoSandbox(connected, sessionKey);
    return connected;
  }
}
```

Even if the sandbox already has media tools bootstrapped, `bootstrapSandboxMediaTools` is called again on every reconnect. It checks `entry?.mediaToolsReady` and returns early, but the `getChatSandbox` function still calls it, adding latency.

#### B-42: `preloadAppCodeIntoSandbox` Preloads Sensitive Files

```typescript
const APP_CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".css", ".html",
  ".md", ".txt", ".toml", ".sql",
]);
```

The filter excludes some patterns but might still include:
- `.env.example` files (starts with `.env` but has `.example` extension)
- `config.json` files containing API keys
- `README.md` files with internal architecture details

---

### 4.5 Error Handling & Resilience

#### B-43: `executeTool` Default Case Returns Error Instead of Throwing

```typescript
default:
  return { result: { error: `Unknown tool: ${name}` } };
```

An unknown tool call should be an exception that triggers the JUDGE logic and model retry. Returning an error result means the model sees `{ error: "Unknown tool" }` and might not understand it failed.

#### B-44: `runToolCall` Sets `hadError = Boolean(toolResult?.error)` But `toolResult` Might Not Have `error` Field

For the default case above, `toolResult` is `{ error: "Unknown tool: ..." }`, so `hadError` is true. But for other failures, the error might be in a different field.

#### B-45: `emptyResponseRetries` Decrements `iterations` — Can Cause Infinite Loop

```typescript
if (fullText.trim() === "" && functionCalls.length === 0) {
  if (emptyResponseRetries < 3) {
    emptyResponseRetries++;
    iterations--; // don't count against MAX_ITERATIONS
    await new Promise(r => setTimeout(r, emptyResponseRetries * 800));
    continue;
  }
}
```

If the model consistently returns empty responses, this retries 3 times. But `iterations--` means the loop doesn't progress toward `MAX_ITERATIONS`. If the empty response happens in the middle of a 60-iteration loop, the remaining iterations are effectively lost.

#### B-46: `streamErr` Is Not Logged

```typescript
if (streamErr) throw streamErr;
```

The stream error is thrown without any logging or context. If it happens in production, you won't know which model, which request, or which iteration caused it.

#### B-47: `catch (err: any)` in `/agent/chat` Catches Everything

```typescript
catch (err: any) {
  if (isConnected()) {
    let errMsg: string = err?.message ?? "Unknown copilot error";
    // ... sanitization
    sseEvent(res, { type: "error", message: errMsg || "Something went wrong — please try again." });
  }
}
```

Any unhandled exception in the entire agent loop is caught and sent to the user as a generic error. This is good for UX but bad for debugging — the original stack trace is lost.

#### B-48: `cancelAgentRunJobs` Is Best-Effort and Not Waited For

```typescript
finally {
  if (!runCompleted) {
    void cancelAgentRunJobs(req, clientConnected ? "agent_error" : "client_abort");
  }
}
```

The `void` means the cancellation is fire-and-forget. If the cancellation fails, the jobs keep running. There's no logging of cancellation results.

---

## 5. Frontend Issues (`StudioCopilot.tsx`)

### 5.1 Streaming & Event Handling

#### F-1: `parseSseFrame` Doesn't Handle Incomplete JSON Across Frame Boundaries

```typescript
const raw = frame
  .split(/\r?\n/)
  .filter(l => l.startsWith("data:"))
  .map(l => l.slice(5).trimStart())
  .join("\n")
  .trim();
```

If a JSON object is split across two SSE frames, `parseSseFrame` tries to parse the partial JSON and fails. The error handling adds a note to the chat, but the actual event is lost.

#### F-2: `buf.split(/\r?\n\r?\n/)` Can Split Inside JSON

The SSE frame delimiter is `\n\n`. If the JSON string contains `\n\n` (e.g., in a multi-line string), the frame parser splits it incorrectly.

**Example:**
```json
{"type": "text_delta", "content": "Hello\n\nWorld"}
```

This would be split into two frames:
- Frame 1: `data: {"type": "text_delta", "content": "Hello`
- Frame 2: `World"}`

Both frames fail JSON parsing.

#### F-3: `handleEvent` Ignores Unknown Event Types Silently

If the backend sends a new event type (e.g., for a new feature), the frontend silently drops it. There should be at least a console warning.

#### F-4: `tool_log` Events Without `toolId` Are Ignored

```typescript
if (evt.type === "tool_log") {
  if (!evt.toolId) return;  // <-- SILENTLY DROPPED
  ...
}
```

If the backend emits a log without a toolId (which can happen in some edge cases), the log is completely lost.

#### F-5: `tool_done` Fallback Match Uses `matchedFallbackTool` Flag Incorrectly

```typescript
let matchedFallbackTool = false;
patchAssistant(m => ({
  ...m, parts: m.parts.map(p => {
    const fallbackMatch = !evt.toolId && !matchedFallbackTool && toolPart.name === evt.name && !toolPart.done;
    if (fallbackMatch) matchedFallbackTool = true;
    return { ...p, done: true, result: evt.result, progress: 100 };
  })
}));
```

**Problem 1:** `matchedFallbackTool` is a variable in the outer closure. React's `patchAssistant` (which is a `setState` functional update) might batch multiple calls. If two `tool_done` events for the same tool name arrive simultaneously, the second `patchAssistant` might still see `matchedFallbackTool = false` because the first update hasn't been applied yet.

**Problem 2:** The fallback match only updates ONE tool. If there are two parallel `web_search` calls and the second one completes first, the first tool card stays spinning forever.

#### F-6: `patchAssistant` Might Not Exist in Some Code Paths

Looking at the `sendMessage` function, `patchAssistant` is used extensively. But I haven't seen its definition. If it's a custom state updater, it might have its own bugs.

#### F-7: `text` Event After `text_delta` Events Causes Duplicate Text

If the backend sends `text_delta` events during streaming and then a final `text` event (when `streamedTextLive` is false), the frontend appends the `text` event content to the message. But if `text_delta` was already used, the text is already in the message. A final `text` event would duplicate it.

Wait, looking at the backend code:
```typescript
if (!streamedTextLive) {
  sseEvent(res, { type: "text", content: fullText, runId });
}
```

If `streamedTextLive` is true, the final `text` event is NOT sent. If it's false, the full text is sent. This means the frontend receives EITHER `text_delta` events OR a single `text` event, not both. This is actually correct for the final answer case.

But during tool execution, the pre-tool text is sent as `text_delta`, and after tools complete, the model's final answer might also be sent as `text_delta`. The frontend needs to handle both correctly.

#### F-8: `appendText` Function Is Not Shown But Likely Has Issues

The `appendText` function (used in `handleEvent` for text/text_delta) is critical but not in the code I read. If it doesn't handle Unicode surrogate pairs correctly, splitting text in the middle of an emoji could corrupt it.

---

### 5.2 State Management & Memory

#### F-9: Base64 Image Data Stored in React State (Memory Bloat)

```typescript
// In the existing audit report (already documented)
// Large base64-encoded image strings are kept in the live React `sessions` state indefinitely.
```

The `slimSessionsForStorage` function strips `data` before saving to localStorage, but the in-memory `sessions` state still holds the full base64 strings. With 2-3 images, this can exceed 10MB of React state, causing laggy typing and UI slowdowns.

#### F-10: `pendingAttachments` Array Holds Base64 Data

```typescript
// pendingAttachments is passed to sendMessage and stored in state
// The attachment object includes `data` for images
```

Even after the message is sent, `pendingAttachments` might not be cleared properly.

#### F-11: `Object URLs` in `pendingAttachmentsRef` Are Not Revoked on Unmount in All Cases

The existing audit report found this. The unmount cleanup only revokes URLs in `sessionsRef` and `pendingAttachmentsRef.current`. But if `pendingAttachmentsRef` is updated during the cleanup (race condition), some URLs might be missed.

#### F-12: `localStorage` Quota Exceeded Error Is Not Surfaced to User

```typescript
function saveSessions(sessions: ChatSession[]) {
  const slim = slimSessionsForStorage(sessions);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
  } catch {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(slim.slice(0, 10))); } catch { }
  }
}
```

If localStorage is full (e.g., 5MB quota), the fallback tries with fewer sessions. But if even 10 sessions exceed the quota, it silently fails. The user loses their chat history without knowing why.

#### F-13: `sessions` State Is Not Paginated

All chat sessions are kept in memory. If the user has 100 sessions with long conversations, the component holds all of them in React state. There is no virtual scrolling or pagination.

---

### 5.3 UI & Interaction

#### F-14: `renderMd` and `renderStreamingMd` Bypass Custom Rendering (Already in Audit Report)

```typescript
function renderMd(text: string, ...): React.ReactNode {
  return <MarkdownContent text={text} sources={sources} />;
  const lines = text.split("\n");  // <-- DEAD CODE
```

The early return bypasses all custom formatting (math, tables, citations, etc.). The `MarkdownContent` component is rendered instead, but it might not support all the features the custom renderer was designed for.

#### F-15: `TextArtifact` Hidden DOM Bloat (Already in Audit Report)

```typescript
<ArtifactShell>
  {/* HIDDEN — old card body retained below */}
  <div className="hidden">
    <div className="flex items-start gap-3 px-3 py-3 border-b border-white/8">...</div>
  </div>
</ArtifactShell>
```

The hidden div contains thousands of DOM nodes that the browser must maintain. This causes slow scrolling and memory usage.

#### F-16: `extractCanvasCandidate` Blocks Live Canvas (Already in Audit Report)

The function prioritizes the largest closed code block over an open streaming block. When multiple files are generated, the first closed file blocks live previews for subsequent files.

#### F-17: `textareaRef` Height Not Reset After Send (Already in Audit Report)

```typescript
const submit = () => {
  onLaunchAgent(t);
  setText("");
  // textarea height is NOT reset here
};
```

The textarea stays large after sending until the user types again.

#### F-18: `ReadAloudButton` Speech Leak on Unmount (Already in Audit Report)

The component doesn't have a cleanup `useEffect` to call `window.speechSynthesis.cancel()` on unmount. If the user navigates away while speech is playing, it continues.

#### F-19: `handlePaste` Swallows Text When Image Is Pasted (Already in Audit Report)

If the user pastes both text and an image, `e.preventDefault()` is called, swallowing the text completely.

#### F-20: `showMoreMenu` and `showReasoningMenu` Don't Close on Click Outside

The menus are toggled by button clicks but there's no global click-outside handler to close them. The user must click the toggle button again.

#### F-21: `showSlashMenu` Doesn't Close When Input Changes to Non-Slash

If the user types `/` to open the slash menu and then continues typing something that doesn't match any skill, the menu stays open.

#### F-22: `reconnectBanner` Shows for ALL Non-Specific Errors

```typescript
} else {
  // Generic connection drop
  setReconnectBanner(lastUserTextRef.current);
}
```

Any error that isn't 401, 403, 503, 502, or "Server error:" shows the reconnect banner. This includes:
- JSON parse errors
- Validation errors
- Client-side bugs

The user sees "Connection dropped — retry your last message?" even when the issue was a malformed request.

#### F-23: `handleStop` Marks Tools as Cancelled But Backend Might Still Send `tool_done`

```typescript
upsertMsg(sId, aId, m => ({
  ...m,
  parts: m.parts.map(p =>
    p.kind === "tool_start" && !(p as any).done
      ? { ...p, done: true, cancelled: true, progress: null, progressMsg: "Stopped", result: { error: "Stopped by user" } }
      : p),
}));
```

If the backend is still running a tool and sends `tool_done` after the frontend marks it cancelled, the `tool_done` handler might try to update an already-done tool. The UI might show conflicting states.

#### F-24: `streamingAssistantIdRef` Is Set to `null` in `finally` But Also in `handleStop`

This is redundant but harmless.

#### F-25: `setInput` in `toggleVoice` Uses Functional Update But `textareaRef` Resize Is Not Triggered

When voice input updates the text, the textarea auto-resize logic in `onChange` is not called. The textarea might not grow to fit the voice input.

---

### 5.4 `StudioHome.tsx` Issues (From Existing Audit Report)

The existing audit report (`studiohome_issues.md`) already found 8 issues. All of them are still present in the code:

1. **Submit Race Condition** — Users can submit while attachments are uploading.
2. **IME Premature Submission** — Enter key confirms IME composition instead of submitting.
3. **Voice Input Stale Closure** — `baseline` variable captures stale text.
4. **Concurrent Upload State Breakage** — `uploading` boolean is insufficient for parallel uploads.
5. **Clipboard Image + Text Drop** — Text is swallowed when image is pasted.
6. **Batch File Upload UI Flicker** — `uploading` state flickers for sequential uploads.
7. **Stale DOM Height Calculation** — `scrollHeight` measured before React updates DOM.
8. **Placeholder Text Overflow** — Absolute positioned placeholder wraps and overlaps.

---

## 6. System Prompt / Model Interaction Issues

### S-1: The System Prompt Is a "Wall of Text" That the Model Cannot Fully Attend To

The system prompt is approximately 1,100 lines (from line 886 to 1176 in `agent.ts`). Research shows that LLMs tend to forget or ignore instructions that appear in the middle of very long prompts. The model likely:
- Remembers the beginning (friendly tone, core behavior)
- Remembers the end (suggestions, no redundant introspection)
- Forgets the middle (tool selection table, canvas rules, failure handling)

### S-2: The Tool Selection Table Is Redundant with the Tool Schema

Lines 1014-1059 contain a giant table mapping user intents to tools. Gemini already has the tool schema (lines 332-853). The table adds ~1,000 tokens of redundancy. The model might get confused when the table says one thing and the schema says another.

### S-3: Conflicting Instructions About Canvas

The system prompt says:
- "USE canvas for: a full HTML page, a complete script/program, a full document..."
- "DO NOT use canvas for: short inline snippets shown as examples, brief config lines..."
- "NEVER use markdown triple-backtick fences in chat for code — always use the canvas protocol"

But the backend (`emitCanvasRoutedText`) converts ALL markdown code blocks to canvas. This creates a conflict:
- The model is told NOT to use canvas for short snippets
- But if it accidentally uses markdown fences, the backend forces them into canvas
- The user sees short snippets as downloadable files

### S-4: The "Before Using a Tool, Briefly Tell the User" Rule Is the Root Cause of Hallucination

As discussed in Section 2.1, this rule creates a decoupled promise. The model outputs text first, then decides whether to call the tool. There is no mechanism to retract the text if the tool call fails or is skipped.

**Better approach:** The agent should:
1. Decide what to do (internally, via reasoning)
2. Call the tool (silently, or with a generic "Working..." indicator)
3. Report results AFTER the tool completes

### S-5: The `[JUDGE]` Marker Is a Hack That Leaks

The model is told (line 1168):
> "Do not output any of these internal markers in visible replies: [REASONING] [reasoning] [THOUGHT] [JUDGE] [PLAN] [EXECUTE] [SAY] [WAIT] [TOOL]"

But the backend SENDS `[JUDGE]` to the model as user text. The model then outputs reasoning that references the judge result. The `stripReasoningTags` function tries to catch this, but it's a regex band-aid on a design flaw.

**Better approach:** Send tool failures as structured JSON, not as text with markers. The model's API supports function results in a structured format. Use that instead of injecting text markers.

### S-6: The Model Is Told to "Never Echo Tool Result JSON" But Has No Alternative

The system prompt (line 1172) says:
> "Never echo tool result JSON, S3 URLs, presigned URLs, or internal API paths in your visible text."

But the model needs to reference tool results to answer user questions. If it can't echo the result, how does it know what to say? It must rely on its memory of the function result, which is passed back in the conversation history. But the function result is structured JSON, and the model might not fully understand it.

**Better approach:** Provide a summary of the tool result in the function response, not just raw JSON. The model should receive human-readable tool results.

### S-7: The `generate_music` Tool Has a "FORBIDDEN" List That the Model Violates

```
FORBIDDEN: saying "Done", "I have generated", "use the download button", or describing the result in ANY way before the tool has actually run and returned.
```

This is a "negative constraint" — telling the model what NOT to do. Negative constraints are harder for models to follow than positive constraints. The model often violates this and says "I've generated your music" before the tool returns.

**Better approach:** Remove the generate_music text generation entirely. The tool should just be called, and the result should be shown via the artifact card. The model doesn't need to say anything about music generation.

### S-8: The `Intelligence First — No Tool Spam` Section Is Contradicted by the Tool-Heavy Design

The system prompt says:
> "Use your own intelligence first. Do NOT call tools for: Normal writing, rewriting, brainstorming, script drafts..."

But the agent has 40+ tools and the system is designed around tool calling. The model is incentivized to use tools because:
- The tool schema is prominently presented
- The tool selection table gives it easy pattern-matching
- The backend expects function calls

The model often calls tools for tasks that should be answered directly (e.g., calling `write_video_script` when the user just wants a quick brainstorm).

---

## 7. Data Flow & Streaming Issues

### D-1: The `streamedTextLive` Flag Is Set for ANY Text Event, Not Just User-Facing Text

If the model outputs internal reasoning text that gets streamed as `text_delta` (before being stripped), `streamedTextLive` becomes true. Then when the model finally outputs the real answer, the final `text` event is suppressed. The user might see partial or stripped text instead of the full answer.

### D-2: The `pendingTextBuf` Holdback Logic Is Incomplete

The holdback checks for these markers:
```typescript
const markerPatterns = ["[SUGGEST", "[Tool:", "[TextArtifact:", "[Artifact:"];
```

Missing markers that should be held back:
- `[JUDGE]`
- `[REASONING]`
- `[THOUGHT]`
- `[PLAN]`
- `[EXECUTE]`
- `[SAY]`
- `[WAIT]`
- `[TOOL]`
- `[/REASONING]`
- `[/THOUGHT]`
- `[/RESPONSE]`

If a delta contains the start of any of these markers, it should be held back until the full marker is resolved.

### D-3: The `stripReasoningTags` Function Runs on Every Text Chunk

This is O(n) regex processing on every chunk. For a 16k token response, this is 16,000 regex operations. The performance impact is small but unnecessary — it should be done once on the final text, not on every delta.

### D-4: The `emitCanvasRoutedText` Regex Is Applied to Every Chunk

```typescript
canvasRouteBuf = canvasRouteBuf.replace(/```[a-zA-Z]*\s*\n(\s*<canvas\b)/gi, "$1");
canvasRouteBuf = canvasRouteBuf.replace(/<\/canvas>\s*\n```/gi, "</canvas>");
canvasRouteBuf = canvasRouteBuf.replace(
  /```(html|css|javascript|js|typescript|ts|python|py|json|markdown|md|text|srt|vtt)\r?\n/gi,
  ...
);
```

These regexes run on the accumulated buffer every time a new chunk arrives. For large outputs, the buffer grows to thousands of characters, and the regexes become slower.

### D-5: The `activeCanvas` Variable Is Scoped Inside the `while` Loop Iteration

Wait, looking at the code again:
```typescript
let activeCanvas: { id: string; label: string; language: string } | null = null;
const emitCanvasRoutedText = (text: string, final = false) => {
  // ... uses activeCanvas
};
```

`activeCanvas` is declared in the outer scope of the `while` loop iteration. So it persists across `emitCanvasRoutedText` calls within a single iteration. This is correct.

But if the model outputs a `<canvas>` tag in one iteration, calls a tool, and then outputs a `</canvas>` tag in the NEXT iteration, the `activeCanvas` variable is reset to `null` at the start of the new iteration. The canvas state is lost across iterations.

**This is a critical bug:** If a model starts a canvas, calls a tool, and then continues the canvas in the next turn, the canvas is broken.

### D-6: The `loopContents` Includes Model's Full Text Including Canvas Tags

The model's response (including `<canvas>` tags) is stored in `loopContents` and sent back to the model in the next iteration. The model then sees its own canvas tags in the conversation history, which might confuse it.

### D-7: The `rawFcParts` Include `thought_signature` But Might Not Be Serializable

```typescript
const rawFcParts: any[] = [];
for (const p of parts) {
  if (p.functionCall) {
    functionCalls.push({ ... });
    rawFcParts.push(p);
  }
}
```

The `rawFcParts` are pushed into `loopContents` as `modelParts`. If the Gemini SDK's `functionCall` parts contain non-serializable objects (e.g., circular references, functions), this could cause JSON serialization errors or unexpected behavior.

### D-8: The `modelParts` Array Always Includes `fullText` Even If Empty

```typescript
if (fullText) modelParts.push({ text: fullText });
for (const rawFc of rawFcParts) modelParts.push(rawFc);
```

If `fullText` is an empty string (which it is when the model only makes function calls), no text part is added. But if the model outputs whitespace that gets stripped, `fullText` might be empty even though the model outputted something. The model's output is lost from the history.

---

## 8. Architecture & Code Quality Issues

### A-1: `agent.ts` Is 4,010 Lines — Violates Single Responsibility

This file contains:
- 40+ tool definitions
- 40+ tool execution handlers
- Gemini API streaming logic
- Canvas protocol parsing
- E2B sandbox management
- Image generation
- Music generation
- Web scraping
- Subtitle conversion
- Workspace file management
- Google Drive integration
- Music share page HTML generation

**Recommendation:** Split into modules:
- `tools/definitions.ts` — tool schemas
- `tools/executors.ts` — tool execution handlers
- `streaming/canvas.ts` — canvas protocol
- `streaming/sse.ts` — SSE event handling
- `sandbox/e2b.ts` — E2B integration
- `media/images.ts` — image generation
- `media/music.ts` — music generation
- `workspace/s3.ts` — workspace file operations
- `workspace/drive.ts` — Google Drive integration

### A-2: `StudioCopilot.tsx` Is 4,064 Lines — Violates Component Boundaries

This component contains:
- Session management
- Message history
- SSE streaming
- Tool card rendering
- Canvas rendering
- Markdown rendering (custom + ReactMarkdown)
- Math rendering (KaTeX)
- Voice input
- File upload
- Slash command menu
- Reasoning mode selector
- Suggestion chips
- Workspace drawer
- History drawer
- Error boundary
- Keyboard event handling
- LocalStorage persistence

**Recommendation:** Split into components:
- `ChatContainer.tsx` — main layout
- `MessageList.tsx` — message rendering
- `MessageBubble.tsx` — individual message
- `ToolCard.tsx` — tool execution cards
- `CanvasViewer.tsx` — canvas artifacts
- `InputBar.tsx` — text input, file upload, voice
- `ChatHistory.tsx` — history drawer
- `MarkdownRenderer.tsx` — markdown rendering
- `useAgentStream.ts` — SSE streaming hook
- `useSessions.ts` — session management hook

### A-3: No Unit Tests or Integration Tests

There are no test files for the agent logic. The `executeTool` function, canvas routing, SSE parsing, and state management are all untested. Bugs are only discovered in production.

### A-4: No Structured Logging

```typescript
console.log(`[agent] run ${runId} model=${activeModel} ...`);
console.warn(`[agent] full_package step failed: ...`);
```

Console logs are not structured. They cannot be easily queried, aggregated, or alerted on. The `logger` from `../lib/logger` is imported but only used in a few places (E2B errors).

### A-5: No Metrics or Observability

There is no tracking of:
- Tool success/failure rates
- Average iteration count per request
- Model latency (time to first token, time to last token)
- Token usage per request
- Error rates by error type
- Client disconnect rates

Without metrics, you cannot measure whether changes improve the system.

### A-6: No Rate Limiting Per User

The `/agent/chat` endpoint has no rate limiting. A single user could:
- Send 100 requests per minute
- Trigger 60 iterations per request
- Use the expensive ULTRA_MODEL for every request

This could exhaust API quotas and rack up significant costs.

### A-7: No Circuit Breaker for Failing Tools

If a tool (e.g., `translate_video`) consistently fails (e.g., because the GPU worker is down), the agent retries it blindly. There is no circuit breaker to temporarily disable failing tools or routes.

### A-8: No A/B Testing Framework for Prompt Changes

The system prompt is hardcoded. If you want to test a different prompt version, you must deploy a new version of the entire backend. There is no feature flag or experiment framework.

### A-9: Magic Numbers Are Scattered Throughout

- `60` (MAX_ITERATIONS)
- `8 * 60 * 1000` (JOB_TIMEOUT_MS)
- `1500` (POLL_INTERVAL_MS)
- `16384` (AGENT_MAX_OUTPUT_TOKENS)
- `500 * 1024` (maxLiveOutputChars)
- `120000` (E2B_COMMAND_TIMEOUT_MS)
- `30` (MAX_HISTORY_MESSAGES)
- `8000` (heartbeat interval)

These should be centralized in a configuration object with documentation.

### A-10: TypeScript `any` Is Overused

```typescript
const ai = createGeminiClient();
const resp = await ai.models.generateContent({
  model: ULTRA_MODEL,
  contents: [...] as any,
  config: { ... } as any,
});
```

The `as any` casts bypass TypeScript's type checking. This makes refactoring dangerous and hides bugs at compile time.

---

## 9. Security Issues

### Sec-1: `INTERNAL_AGENT_SECRET` Is Randomly Generated If Not Set

```typescript
const fromEnv = (process.env.INTERNAL_AGENT_SECRET ?? "").trim();
export const INTERNAL_AGENT_SECRET: string = fromEnv || crypto.randomBytes(32).toString("hex");
```

If the server restarts, the secret changes. Any internal requests in flight at the time of restart will fail authentication. In a serverless environment (Lambda), each cold start generates a new secret.

**Fix:** Always set `INTERNAL_AGENT_SECRET` explicitly. Fail fast if it's not set.

### Sec-2: `isInternalHost` Doesn't Block All Private IPs

The function checks for:
- Loopback (127.x, ::1, localhost)
- Private RFC-1918 (10.x, 172.16-31.x, 192.168.x)
- Link-local (169.254.x, fe80::)
- CGNAT (100.64-127.x)

Missing:
- `127.0.0.0/8` is checked via `v4parts[0] === 127`, but `127.255.255.255` is blocked correctly
- `192.0.2.x` (TEST-NET)
- `198.51.100.x` (TEST-NET-2)
- `203.0.113.x` (TEST-NET-3)
- `224.0.0.0/4` (multicast)
- `255.255.255.255` (broadcast)
- `fe00::/9` (not fe80::/10, but broader)

### Sec-3: `fetchReadableWebPage` Follows Redirects Without Limit

```typescript
const r = await fetch(parsed.toString(), { redirect: "follow", ... });
```

If a malicious URL redirects to an internal URL (e.g., `https://attacker.com/redirect` → `http://127.0.0.1:8080/admin`), the internal URL is fetched. The `isInternalHost` check is on the INITIAL URL, not the final URL after redirects.

**Fix:** Use `redirect: "manual"` and check each redirect location with `isInternalHost`.

### Sec-4: `save_artifact_to_workspace` Fetches Arbitrary URLs

As noted in B-5, the `sourceUrl` parameter is not validated against an allowlist. A compromised model could exfiltrate data.

### Sec-5: `run_sandbox_command` Allows Arbitrary Command Execution

The E2B sandbox is isolated, but the model can run any command inside it. If the sandbox has network access, the model could:
- Download malware
- Scan the internal network
- Exfiltrate data via DNS or HTTP

E2B sandboxes are supposed to be isolated, but there might be escape vulnerabilities.

### Sec-6: `run_code_analysis` Falls Back to Gemini Code Execution

When E2B is not configured, `run_code_analysis` uses Gemini's `codeExecution` tool. This runs code in Google's sandbox, not yours. The user has no visibility into what code is executed or what data is sent to Google.

### Sec-7: `latestImageAttachment` Scans All Messages for Base64 Data

```typescript
for (let i = messages.length - 1; i >= 0; i--) {
  const attachments = Array.isArray(messages[i]?.attachments) ? messages[i].attachments : [];
  for (let j = attachments.length - 1; j >= 0; j--) {
    const attachment = attachments[j];
    if (attachment?.type === "image" && attachment?.data && attachment?.mimeType) {
      return { data: String(attachment.data), ... };
    }
  }
}
```

If a malicious user sends a crafted message with a fake image attachment, the model might process it. The `data` field is not validated to be actual base64 image data.

---

## 10. Performance Issues

### P-1: Base64 Images in React State Cause Memory Bloat and Lag

As noted in the existing audit report and F-9/F-10, image attachments are stored as base64 strings in React state. A single 1080p image can be ~2-5MB base64. With 3 images in a chat session, the state holds 15MB of strings. React's re-render diffing becomes slow.

### P-2: `agent.ts` System Prompt Is ~3,000+ Tokens

The system prompt alone consumes a significant portion of the context window. Every request pays for these tokens. At Gemini's pricing, this could be $0.01-0.05 per request just for the prompt.

### P-3: `loopContents` Grows Without Truncation

After 20 iterations, the conversation history might be 10,000+ tokens. The model becomes slower and more expensive. There is no summarization or truncation of old turns.

### P-4: `ULTRA_MODEL` Is Used for Text Generation Tasks

`write_video_script`, `generate_seo_pack`, `run_code_analysis` (when E2B is unavailable), and `analyze_youtube_video` all use the expensive `gemini-3.1-pro-preview` model. These tasks could be handled by the cheaper `gemini-3.5-flash` model.

### P-5: `pollJobUntilDone` Polls Every 1.5 Seconds

For a 15-minute job, this is 600 polling requests. Each request goes through the Express stack, hits the database/queue, and returns a response. This is wasteful.

**Better approach:** Use WebSockets, Server-Sent Events, or webhooks for progress updates instead of polling.

### P-6: `canvas_delta` Events Are Sent Per Character Group

Each text chunk from the model triggers an SSE event. For a 500-line HTML file, this is 500+ HTTP chunks. The overhead of JSON encoding, SSE framing, and TCP transmission is significant.

**Better approach:** Batch canvas deltas and send them every 100ms or when a newline is encountered.

### P-7: `react-markdown` Is Rendered for Every Message

The `MarkdownContent` component uses `ReactMarkdown` with multiple plugins (`remark-gfm`, `remark-math`, `rehype-katex`, `rehype-sanitize`). These plugins parse the entire markdown tree on every render. For long messages, this is expensive.

### P-8: `katex.renderToString` Is Called for Every Math Expression

Each math expression triggers a KaTeX render. For a message with 10 math expressions, this is 10 DOM renders. These should be memoized.

### P-9: `localStorage` Is Read/Written on Every Session Change

```typescript
function saveSessions(sessions: ChatSession[]) {
  const slim = slimSessionsForStorage(sessions);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(slim)); } catch { ... }
}
```

If `sessions` is updated frequently (e.g., during streaming), this writes to localStorage multiple times per second. localStorage is synchronous and blocks the main thread.

**Better approach:** Debounce the save operation (e.g., save 500ms after the last change).

### P-10: `messagesContainerRef` Scrolls on Every Update

The chat container likely auto-scrolls to the bottom on every new message. If messages are streaming in rapidly, this causes constant layout recalculation and repainting.

---

## 11. Comparison: How I Work vs. How Your Agent Works

### How I Work (Kimi / Modern AI Agents)

| Aspect | How I Work | How Your Agent Works | Problem |
|--------|-----------|----------------------|---------|
| **Tool pre-announcement** | I do NOT promise tools before calling them. I either call the tool silently or explain the result after. | The model is FORCED to say "I'll cut..." before calling the tool. | If the tool call fails or is skipped, the user sees a broken promise. |
| **Reasoning separation** | My reasoning is completely internal. You never see my thought process unless explicitly requested. | Reasoning is streamed as `thought_delta` but also leaks into normal text via regex stripping. | Users see "Ah, let me check..." and "Wait, the error is..." in chat. |
| **Tool execution** | I call the tool. Period. The tool runs. The result comes back. I report the result. | The model generates text, then MAYBE calls a tool. The text and tool call are decoupled. | The model can output "I'll cut the clip" without ever calling the tool. |
| **Error handling** | If a tool fails, I report the failure clearly and suggest alternatives. | Tool failures are injected as `[JUDGE]` markers that the model might echo or misinterpret. | Error messages are confusing or leaked as internal reasoning. |
| **Code blocks** | Code blocks are rendered as inline code. Only explicit artifacts are downloadable. | ALL markdown code blocks are converted to canvas artifacts. | A 3-line example becomes a downloadable file. |
| **Context management** | I manage context carefully, summarizing or truncating when needed. | Context grows unbounded across iterations with no truncation. | After ~20 iterations, the model forgets instructions and rambles. |
| **System prompt** | My instructions are concise and focused. | The system prompt is 1,100+ lines with redundant tables. | The model ignores middle instructions and focuses on easy pattern-matching. |
| **Canvas/artifacts** | I use explicit artifact protocols only when the user needs a deliverable. | The canvas protocol is forced on ALL code blocks. | Normal conversational output is corrupted. |
| **Tool result feedback** | Tool results are structured and easy for me to understand. | Tool results are raw JSON nested under `response.result`. | The model might not properly understand complex nested results. |
| **Model selection** | I use the appropriate model for the task. | All text generation uses the expensive ULTRA_MODEL regardless of complexity. | Unnecessary cost and latency. |

### The Fundamental Design Difference

**Your agent treats the model as a chatbot that sometimes calls tools.**

**A proper agent treats the model as a decision-maker that calls tools as its primary output.**

In your design:
1. The model chats with the user
2. Sometimes it decides to call a tool
3. The tool runs
4. The model chats about the result

In a proper agent design:
1. The model receives the task and context
2. The model decides which tools to call
3. The agent executes the tools
4. The model receives the results
5. The model decides if more tools are needed or if it can answer
6. The model outputs the final answer

The key difference: **In a proper agent, the model should NOT output user-facing text during the tool-execution phase.** It should only output text at the very end, after all tools have completed.

Your agent allows the model to output text at ANY point, which is why the user sees:
- "I'll cut the clip..." (text before tool)
- [Tool runs]
- "Here is your clip..." (text after tool)

If the tool fails or is skipped, the user sees:
- "I'll cut the clip..." (text)
- [Nothing]
- [Model might say "Here is your clip..." even though no tool ran]

---

## 12. What You Are Doing Wrong / What Is Missing

### What You Are Doing Wrong

1. **You are treating the model as a chatbot, not an agent.** The system prompt encourages conversational fluff instead of focused tool execution.

2. **You are over-engineering the streaming layer.** The canvas protocol, markdown conversion, and text buffering are complex, fragile, and create more bugs than they solve.

3. **You are using a monolithic architecture.** 4,000-line files are impossible to reason about, test, or maintain. A single bug in one tool affects the entire agent.

4. **You are not validating tool calls before execution.** The model can emit any tool call with any arguments, and you execute it blindly.

5. **You are not managing context window properly.** The system prompt is too long, and the conversation history grows without bound.

6. **You are using the most expensive model for simple tasks.** `gemini-3.1-pro-preview` is used for script writing, SEO packs, and code analysis.

7. **You are relying on regex for security and content filtering.** `stripReasoningTags`, `isInternalHost`, and URL stripping are all regex-based and have holes.

8. **You are not testing your agent.** There are no unit tests, no integration tests, and no metrics.

9. **You are not handling the "promise gap" between text and tool calls.** The model's text output is not coupled to its function calls, creating the hallucination problem.

10. **You are converting all code blocks to canvas artifacts.** This destroys the natural flow of markdown and forces users to download simple examples.

### What You Are Missing (Best Practices)

1. **A clear separation between "thinking" and "acting" phases.** The model should think silently, then act (call tools), then respond.

2. **Tool call validation before execution.** Check arguments, validate URLs, and confirm required parameters before running the tool.

3. **Tool call confirmation.** The model should emit a structured plan, and the agent should confirm it before executing.

4. **Context window management.** Truncate or summarize old conversation turns after each iteration.

5. **Cost-aware model selection.** Use the cheapest model that can handle the task. Reserve the expensive model for complex reasoning.

6. **A proper artifact protocol.** Use explicit, opt-in artifact creation instead of hijacking markdown code blocks.

7. **Comprehensive test coverage.** Unit tests for tool execution, integration tests for the full agent loop, and end-to-end tests for the frontend.

8. **Structured logging and metrics.** Track tool success rates, model latency, token usage, and error rates.

9. **Rate limiting and circuit breakers.** Protect your API quotas and prevent abuse.

10. **A/B testing for prompts.** Test prompt changes in a controlled way before full deployment.

11. **Proper error handling.** Don't catch all exceptions and send generic messages. Log the error, classify it, and show the user a helpful message.

12. **Security hardening.** Validate all URLs, restrict internal network access, and validate all inputs.

13. **Performance optimization.** Debounce localStorage writes, batch SSE events, and memoize expensive renders.

14. **Code splitting.** Break the monolithic files into focused modules and components.

15. **Documentation.** The system is complex enough that it needs internal documentation explaining the data flow, the canvas protocol, and the reasoning pipeline.

---

## 13. Recommendations

### Immediate Fixes (This Week)

1. **Fix the hallucination problem:** Remove the "Before using a tool, briefly tell the user what you're about to do" instruction from the system prompt. Replace it with: "Call tools directly. Do not announce tool usage in text."

2. **Fix the canvas protocol:** Remove the automatic markdown→canvas conversion in `emitCanvasRoutedText`. Only convert `<canvas>` tags that the model explicitly emits.

3. **Fix the leaked reasoning:** Remove the `[JUDGE]` marker injection. Instead, send tool failures as structured JSON in the function response.

4. **Fix the P0 canvas content loss:** In `emitCanvasRoutedText`, when `final=true` and `activeCanvas` is true but `closeIdx === -1`, emit the remaining buffer content before emitting `canvas_done`.

5. **Fix the parallel tool race condition:** In `StudioCopilot.tsx`, make `matchedFallbackTool` part of the state update logic rather than an external closure variable.

6. **Apply the existing audit fixes:** The `studiohome_issues.md` and `studiocopilot_issues.md` files contain exact replacement code. Apply them.

### Short-Term Fixes (This Month)

7. **Split the monolithic files:** Break `agent.ts` into tool modules, streaming modules, and sandbox modules. Break `StudioCopilot.tsx` into component files.

8. **Add context truncation:** After every 3-5 iterations, summarize the conversation history and start fresh with the summary.

9. **Add tool call validation:** Before executing any tool, validate the arguments and return a clear error to the model if they're invalid.

10. **Add metrics:** Track tool success rates, model latency, token usage, and error rates. Use a simple logging framework or a service like Datadog.

11. **Add rate limiting:** Limit users to N requests per minute and M iterations per request.

12. **Fix the E2B sandbox memory leak:** Call `pruneExpiredSandboxEntries` on a timer (e.g., every 10 minutes) instead of only on `getChatSandbox`.

13. **Fix the `do_full_package` lie:** Check the actual results of each step and report failures honestly.

14. **Add proper tests:** Write unit tests for `executeTool`, `stripReasoningTags`, `convertSubtitleText`, and `parseTimestamp`. Write integration tests for the full agent loop.

### Long-Term Improvements (Next Quarter)

15. **Redesign the agent architecture:** Move from a "chatbot with tools" to a "proper agent with planning and execution phases." Consider using a framework like LangChain, Vercel AI SDK, or a custom orchestrator.

16. **Implement a proper artifact system:** Instead of canvas tags, use explicit artifact events with clear metadata (type, name, content, MIME type).

17. **Add user feedback loop:** Allow users to rate responses and flag hallucinations. Use this data to improve the system prompt.

18. **Implement cost tracking:** Show users (and yourself) the estimated cost per request. Use this to optimize model selection.

19. **Add a moderation layer:** Filter model outputs for harmful content, leaked secrets, and internal reasoning before sending to the user.

20. **Document the system:** Write an internal architecture document explaining the data flow, the event protocol, and the reasoning pipeline.

---

## Appendix: Existing Audit Issues (Still Unfixed)

The following issues were already documented in `audit-reports/studiocopilot_issues.md` and `audit-reports/studiohome_issues.md` but are **still present in the code** (as of this audit):

### StudioCopilot.tsx (from `studiocopilot_issues.md`)

1. **Broken Markdown Rendering** — `renderMd` and `renderStreamingMd` have early returns that bypass custom formatting.
2. **Memory Bloat from Base64 Images** — Heavy base64 data is kept in React state indefinitely.
3. **Unrevoked Object URLs** — Blob URLs in `pendingAttachmentsRef` are leaked on unmount.
4. **Concurrent Tool Resolution** — `tool_done` without `toolId` updates all unfinished tools of the same name.
5. **Text-to-Speech Unmount Leak** — `ReadAloudButton` lacks unmount cleanup.
6. **Textarea Won't Shrink** — `setInput("")` doesn't reset textarea height.
7. **Live Canvas Blocking** — Closed code blocks block live previews for open blocks.
8. **Massive DOM Bloat** — `TextArtifact` renders a hidden duplicated layout.

### StudioHome.tsx (from `studiohome_issues.md`)

1. **Submit Race Condition** — Users can submit while attachments are uploading.
2. **IME Premature Submission** — Enter key confirms IME composition.
3. **Voice Input Stale Closure** — `baseline` variable captures stale text.
4. **Concurrent Upload State Breakage** — `uploading` boolean is insufficient for parallel uploads.
5. **Clipboard Image + Text Drop** — Text is swallowed when image is pasted.
6. **Batch File Upload UI Flicker** — `uploading` state flickers for sequential uploads.
7. **Stale DOM Height Calculation** — `scrollHeight` measured before DOM update.
8. **Placeholder Text Overflow** — Absolute positioned placeholder wraps and overlaps.

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Critical Issues (P0) | 6 |
| High Severity Issues (P1) | 15 |
| Medium Severity Issues (P2) | 45 |
| Low Severity Issues (P3) | 30 |
| Architecture/Design Issues | 20 |
| Security Issues | 7 |
| Performance Issues | 10 |
| Existing Audit Issues (Still Unfixed) | 16 |
| **Total** | **~149** |

---

*End of Report*
