# Studio Copilot Backend Audit — SSE, Agent Loop & Gemini Integration

**Date:** 2026-06-23 | **File:** `artifacts/api-server/src/routes/agent.ts` (4,010 lines)

---

## SSE Streaming Correctness

### H1 — Critical: No timeout on Gemini streaming calls; Lambda hangs for 900s
**Lines:** 3423-3436, 3579 (agent.ts)

`ai.models.generateContentStream(...)` is called without any `httpOptions.timeout`. The Gemini SDK's `generateContentStream` accepts no timeout parameter directly, and `createGeminiClient()` at line 3369 is called without `httpOptions`. If the Gemini API stream hangs mid-response (network partition, server-side stall), the `for await (const chunk of stream!)` loop at line 3579 blocks forever. The only escape is the 900-second Lambda timeout, consuming 1536 MB for the full duration.

**Fix:** Add `httpOptions: { timeout: 300_000 }` (5 min) to `createGeminiClient`, or race the stream iteration with a `setTimeout`-based promise. Wire an `AbortController` triggered on client disconnect.

---

### H2 — Critical: No Gemini API key rotation on 429 rate limits
**Lines:** 3369, gemini-client.ts:167-172 (agent.ts)

`createGeminiClient()` at the top of the handler creates one client using only `GEMINI_API_KEY` (via `getPrimaryGeminiApiKey()`). The documented key pool `GEMINI_API_KEY_2` through `_6` from CLAUDE.md exists but is not wired to the agent path. The retry logic at lines 3448-3455 backs off and retries with the **same key**, meaning a rate-limited key stays rate-limited. This is wasteful — the env vars exist but the code doesn't use them.

**Fix:** Add a rotating key selector in `createGeminiClient` or retry logic that cycles through `GEMINI_API_KEY_2`..`_6` on 429 errors.

---

### Medium: `Promise.all` in parallel tool batch abandons in-flight tools if one throws
**Lines:** 3798 (agent.ts)

```js
const completed = await Promise.all(batch.map(({ index, fc }) => runToolCall(index, fc)));
```

`runToolCall` wraps its inner `executeTool` call in try/catch (line 3760) and always returns a successful promise with `hadError: true` on failure. **However**, if `runToolCall` itself throws a JavaScript runtime error outside the try block, `Promise.all` rejects immediately, and every other in-flight tool call in the batch is abandoned. Their SSE events (`tool_start`) already fired, so the client sees permanent "Running..." state for those tools.

**Fix:** Use `Promise.allSettled` instead of `Promise.all` for tool batch execution as defense-in-depth.

---

### High: No abort propagation to in-flight Gemini stream on client disconnect
**Lines:** 3579-3651 (agent.ts)

The `for await (const chunk of stream!)` loop at line 3579 checks `isConnected()` at line 3580 and breaks — correct. But the underlying Gemini HTTP stream is not aborted. It continues downloading data that Lambda discards, wasting Gemini API quota and Lambda execution time. For non-streaming calls inside tool execution (e.g., `generateImageArtifact` calling `ai.models.generateContent` at line 1632), disconnect is not checked at all until the call returns. A 30-second image generation that starts while connected but the client disconnects mid-generation continues to completion.

**Fix:** Pass an `AbortSignal` from the main handler's `AbortController` into `executeTool`, and check `isConnected()` before making Gemini calls inside tools.

---

### Medium: `cancelAgentRunJobs` fire-and-forget races Lambda freeze
**Lines:** 3870 (agent.ts)

```js
void cancelAgentRunJobs(req, clientConnected ? "agent_error" : "client_abort");
```

The `void` is intentional (fire-and-forget in `finally` block). But if cancellation takes longer than the remaining invocation time, the Lambda freeze kills in-flight cancel requests. `res.end()` at line 3872 happens after line 3870, and the Lambda freezes post-response — so cancel calls may or may not complete, racing the freeze.

**Fix:** Consider making `cancelAgentRunJobs` awaitable when the client disconnected.

---

## Agent Iteration Loop

### Medium: Empty response retry with `continue` + `iterations--` creates inaccurate iteration counting
**Lines:** 3675-3680 (agent.ts)

When an empty response is received (line 3675), the code does `iterations--` then `continue`. This decrements `iterations` to prevent counting empty responses against `MAX_ITERATIONS`. However, `emptyResponseRetries` is reset to 0 at line 3688 after ANY non-empty response. If the model alternates between returning text (with tool calls) and returning empty — a degraded state — the empty-response counter resets each cycle, allowing far more than `MAX_ITERATIONS` wall-time loop iterations. Bounded per-cycle, but the `iterations--` + `continue` combination is fragile.

**Fix:** Use a dedicated empty-response counter that never resets, or track total iterations separately from retries.

---

### Medium: Native search tool config error retry — `attempt--` with `continue` creates messy control flow
**Lines:** 3441-3445 (agent.ts)

When `isNativeToolConfigError(e)` is true, `useNativeSearchTools = false`, `attempt--`, and `continue`. The `attempt--` means the same counter is decremented and then incremented by the loop, creating confusing iteration numbering. Bounded by `attempts < 3`, so not an infinite loop, but the control flow is convoluted and hard to reason about.

**Fix:** Use a separate retry counter for the native tool config path.

---

### Low: `stream!` non-null assertion — could crash if retry logic leaves `stream` undefined
**Lines:** 3417, 3579 (agent.ts)

`stream` is declared as `AsyncIterable<any> | undefined` at line 3417. After the retry loop, if all 3 attempts fail and `streamErr` is set, line 3459 throws `streamErr`. If `streamErr` is null but `stream` is still undefined (a bug in the retry logic), the non-null assertion at line 3579 (`stream!`) causes a runtime crash. Unlikely given current logic but violates type safety.

**Fix:** Add an explicit `if (!stream) throw streamErr ?? new Error(...)` before the `for await` loop.

---

## Gemini API Integration

### Critical: Missing break on disconnect during tool execution batch
**Lines:** 3777-3802 (agent.ts)

The `for` loop at line 3777 checks `isConnected()` in its condition. After `Promise.all` completes at line 3798, execution continues to the next while-iteration header which re-checks `isConnected()`. So far correct. But the gap: between `Promise.all` finishing and the next `while` condition evaluating, no check happens. If tools ran for many minutes and the client disconnected during execution, the disconnect is invisible until the next loop iteration.

**Mitigation:** The internal fetch calls inside tools will themselves fail fast (connection refused on `127.0.0.1`), so practical impact is low.

---

### Medium: `AGENT_MAX_OUTPUT_TOKENS` at 16384 may exceed Flash model limits
**Lines:** 37, 3430 (agent.ts)

`AGENT_MAX_OUTPUT_TOKENS` defaults to 16384. Some Gemini Flash model configurations support only ~8192 output tokens. If the model silently caps the response, function calls at the end of a long response could be truncated (partial JSON), leading to malformed tool args or missing tool calls.

**Fix:** Verify `maxOutputTokens` against the specific model being used; reduce to 8192 for Flash variants.

---

### Medium: Empty response retry resends same `loopContents` — poison persistence
**Lines:** 3675-3680 (agent.ts)

When the model returns no text and no function calls, the code retries with the same `loopContents` (same history). If the last model turn "poisoned" the context (e.g., model output a partial JSON array in `rawFcParts` that causes the next request to fail silently), every retry hits the same failure. Partially mitigated by `emptyResponseRetries` max of 3.

**Fix:** On the 2nd empty response retry, strip the last assistant turn from `loopContents` before retrying.

---

### Low: Heartbeat interval fires only 8s — correctly cleaned up
**Lines:** 3364-3366, 3868, 3872 (agent.ts)

`setInterval` fires every 8 seconds, calling `sseEvent` which guards on `res.writableEnded`. `clearInterval(keepAlive)` at line 3868 runs in the `finally` block before `res.end()` at line 3872, so the interval is correctly stopped before the response ends. No stale heartbeats after response completion.

---

## Concurrency Control

### High: `TOOL_PARALLEL_LIMITS` at 7 concurrent operations is excessive
**Lines:** 61-64, 3789-3796 (agent.ts)

```js
const TOOL_PARALLEL_LIMITS: Record<string, number> = { light: 7, youtube_processing: 7 };
```

Seven concurrent tool calls is very high. `Promise.all` on 7 simultaneous `download_video` calls each polling for 8 minutes creates 7 concurrent `fetch` loops plus the Gemini calls. In Lambda (1536 MB, single vCPU), this can cause memory pressure and I/O contention.

Worse: with parallel limits of 7 in two groups, the code could theoretically execute up to 14 concurrent tool calls within one iteration (7 light + 7 youtube_processing batched sequentially), each with potentially hundreds of internal fetch calls during polling. This is self-inflicted DoS against the internal API.

**Fix:** Reduce limits to `light: 3, youtube_processing: 3` as originally documented in CLAUDE.md's concurrency specification.

---

## Lambda-Specific

### Critical: Global `Map` state persists across Lambda warm invocations (also in Security report)
**Lines:** 1202-1203 (agent.ts)

```js
const e2bSandboxBySession = new Map<string, { sandboxId: string; lastUsed: number; ... }>();
const pendingSandboxCreations = new Map<string, Promise<any>>();
```

Module-level Maps survive between Lambda invocations (warm starts):
1. Two users with the same `sessionKey` (sha256 of session ID, first 32 chars) would share sandbox state
2. Maps have no maximum size — grows unboundedly in long-running containers
3. `pendingSandboxCreations` stores Promises; if sandbox creation fails, the failed promise is deleted from the map in the `finally` block, but if Lambda freezes between `map.set` and `try`, the stale promise leaks

**Fix:** Cap Map sizes, validate session ownership, persist mappings to DynamoDB with TTL.

---

### Medium: `send_result_to_tab` uses raw regex to strip non-alphanumeric from tab name
**Lines:** 413-425, 2623-2628 (agent.ts)

The `navigate_to_tab` tool definition allows arbitrary string input for `tab` (description limits it but doesn't enforce it). `send_result_to_tab` at line 2623 does no validation on `args.tab` before sending an SSE `navigate` event. A model hallucinating a tab name could cause a client-side error.

**Fix:** Validate tab name against a known whitelist before emitting the SSE event.

---

## JSON Parsing / Schema Validation

### Medium: Tool args are passed directly from Gemini without schema validation
**Lines:** 3646-3649, 3742-3775 (agent.ts)

```js
functionCalls.push({ id: p.functionCall.id, name: p.functionCall.name!, args: (p.functionCall.args ?? {}) as Record<string, any> });
```

Gemini's function call args are used directly with no Zod or JSON Schema validation layer. Gemini can and sometimes does omit required fields, pass numbers as strings, or pass empty objects. Individual tool handlers do some validation (`parseTimestamp` handles string numbers for times), but the error messages from the tool level may not clearly indicate what went wrong. The `default` case in `executeTool` at line 3244 **returns** rather than throws — so the model receives an error object and may misinterpret it as a tool result.

**Fix:** Add a Zod schema validation layer between Gemini function call parsing and tool execution. Return structured error objects with clear field paths.

---

### Low: `latestArtifactFromMemory` parses `[Artifact:...]` from conversation text — fragile format
**Lines:** 1888-1913 (agent.ts)

Regex-based parsing at line 1894 splits on ` | ` then `:`. If the artifact content contains a pipe character or colon, the parsing breaks. This is only used for `repeat_last_artifact`, so failure is contained to that feature.

---

## Resource Cleanup on Disconnect

### Medium: Tool-level Gemini calls don't check disconnect before executing
**Lines:** 1632+ (agent.ts)

`generateImageArtifact`, `generateMusic`, and other tool-level Gemini calls don't check `isConnected()` before making expensive API calls. If the client disconnects while a tool is about to start, the API call proceeds anyway, wasting quota.

**Fix:** Check `isConnected()` before each Gemini API call inside tool implementations. Pass the `AbortSignal` from the handler.

---

## Summary

| # | Severity | Lines | Issue |
|---|----------|-------|-------|
| H1 | Critical | 3423, 3579 | No timeout on Gemini streaming — Lambda hangs 900s |
| H2 | Critical | 3369 | No API key rotation on 429; documented `_2`..`_6` keys unused |
| — | High | 3798 | `Promise.all` in tool batch may abandon in-flight tools |
| — | High | 3579 | No AbortSignal to Gemini stream or tool calls on disconnect |
| — | High | 61-64, 3789 | Parallel tool limit at 7 concurrency is excessive |
| — | Critical | 1202-1203 | Global E2B sandbox Maps persist across Lambda warm invocations |
| — | Medium | 3870 | `cancelAgentRunJobs` fire-and-forget races Lambda freeze |
| — | Medium | 3675-3680 | Empty response retry + `iterations--` creates inaccurate counting |
| — | Medium | 3441-3445 | Native search tool config error retry — messy control flow |
| — | Medium | 3646-3649 | Tool args used without schema validation |
| — | Medium | 1632+ | Tool-level Gemini calls don't check disconnect |
| — | Low | 3417, 3579 | `stream!` non-null assertion — type safety violation |
| — | Low | 3364-3366 | Heartbeat interval correctly cleaned up (verified OK) |
| — | Low | 2623-2628 | `send_result_to_tab` — no tab name validation |
| — | Low | 1888-1913 | `latestArtifactFromMemory` fragile pipe/colon parsing |
| — | Low | 37, 3430 | `AGENT_MAX_OUTPUT_TOKENS` 16384 may exceed Flash model limit |

---

*Generated 2026-06-23 — Part 2 of 6 — Backend SSE, Agent Loop & Gemini Integration*
