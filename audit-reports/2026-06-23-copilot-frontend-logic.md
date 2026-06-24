# Studio Copilot Frontend Audit — Logic Bugs, Race Conditions & Memory Leaks

**Date:** 2026-06-23 | **File:** `artifacts/yt-downloader/src/components/StudioCopilot.tsx` (3,979 lines)

---

## SSE Event Handling

### H1 — Critical: SSE events not filtered by `runId` — stale stream corrupts active message
**Lines:** 3028 (StudioCopilot.tsx)

`handleEvent` ignores `evt.runId` entirely. `currentRunId` is set at line 3029 but never read for gating. Each `sendMessage` call closes over its own `assistantMsgId`/`sessionId`, so events route to THAT run's message — good in isolation. But when a stream is aborted via `handleStop` (line 3391) and a new send starts, the old `fetch`/`reader` loop is not guaranteed to have fully unwound. `reader.read()` rejects with `AbortError` asynchronously, but any frames already buffered and being iterated in the `for (const frame of frames)` loop (line 3349) will still call `patchAssistant` on the OLD `assistantMsgId`.

**Symptoms:**
- Old message text reappears after user has moved to a new conversation
- Tool cards from an aborted run update with stale results
- "Partial update" notes reapplied to stopped messages

**Fix:** Capture `runId` from `run_start`, and in `handleEvent` drop any event whose `runId` doesn't match the run this closure owns. Also check `abortRef.current?.signal.aborted` before applying any patches.

---

### Medium: `parseSseFrame` on trailing buffer after abort — patches stopped message
**Lines:** 3354 (StudioCopilot.tsx)

`parseSseFrame(buf, true)` runs the trailing buffer inside the async flow after the response loop. If the user pressed Stop (abort) and `finally` ran `setStreaming(false)`, a trailing frame can still call `patchAssistant`, re-adding the "partial update" note (line 3013) to a message the user already stopped.

**Fix:** Short-circuit `parseSseFrame` when `abortRef.current?.signal.aborted`.

---

## Race Conditions

### H2 — Critical: Concurrent `sendMessage` invocations overwrite `abortRef` (TOCTOU)
**Lines:** 2840, 3381 (StudioCopilot.tsx)

`pendingPrompt` effect (line 3381) calls `setTimeout(() => sendMessage(prompt), 0)`. `streaming` is React state, read at line 2840:

```js
if (streaming) { ... return; }
```

Between the effect firing and the deferred `sendMessage` running, `streaming` is still its captured value. If `pendingPrompt` and a manual submit (or reconnect-banner retry) race, both read `streaming === false` and both proceed. Both call:

```js
abortRef.current = new AbortController(); // line 2898
```

The first stream's `AbortController` is overwritten and can **never be aborted** by `handleStop` — only the latest is held. The first stream leaks until the server closes it.

**Fix:** Guard with a `streamingRef.current` (ref, not state) set synchronously at the top of `sendMessage`. Check the ref, set it to `true` before any async work, reset in `finally`.

---

### Medium: `currentMessages` creates new array identity every render — unnecessary effect re-fires
**Lines:** 2767 (StudioCopilot.tsx)

```js
const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages ?? [];
```

The `?? []` branch creates a fresh empty array when no session matches, and `.messages` is stable only while `sessions` is unchanged. The effects at lines 2779 (auto-scroll) and 2771 (`messagesRef`) depend on `currentMessages`. When `currentSessionId` is `null` (new chat), `currentMessages` is a brand-new `[]` each render, retriggering both effects unnecessarily — extra `requestAnimationFrame` scroll work, extra ref updates.

**Fix:** `useMemo` the lookup with a module-level frozen `EMPTY` array constant as fallback.

---

### Medium: `messagesRef` lags one render behind `sendMessage`'s history build
**Lines:** 2902, 2767 (StudioCopilot.tsx)

`messagesRef.current` is the source of truth for the history array sent to the API. `messagesRef` is updated by an effect (line 2771) keyed on `currentMessages`, which is recomputed via `sessions.find(...)` each render. After `updateSession` adds the user message (line 2878), `messagesRef.current` has NOT yet updated (effect runs after render, and `sendMessage` continues synchronously). So `allMsgs` manually appends the new user message (line 2902) — this is correct. But if the *previous* turn's assistant message updates (tool results, final text) landed after the last commit that ran the ref effect, those could be missing from the history sent to the API. In practice the prior turn is settled, so impact is low, but the pattern of reading a ref that lags state within the same synchronous flow is fragile.

**Fix:** Derive history from `sessionsRef.current` for the specific `sessionId` rather than the lagging `messagesRef`.

---

## Memory Leaks

### High: Base64 images kept in live `sessions` React state forever (overlaps known issue #2)
**Lines:** 2866-2876 (StudioCopilot.tsx)

`sendMessage` pushes full `userParts` into the user message (including base64 `data` strings for images). `slimSessionsForStorage` (line 99) strips base64 only on the way to localStorage — the in-memory `sessions` array (and `sessionsRef`) keeps full base64 `data` for every image in every message of up to 120 retained sessions. Over a long-lived browser tab with many image attachments, this is **unbounded heap growth** that never gets GC'd because sessions are in React state.

Every re-render clones these strings. With 5 sessions each having 3 images at 2 MB base64 each, that's 30 MB in state plus 30 MB in the VDOM — 60 MB minimum.

**Fix:** Strip base64 from older messages in-memory once a turn completes. Keep only the latest user turn's image data, matching what `sendMessage` already does for the history payload at lines 2943-2951.

---

### Low: `toggleVoice` recognition `onresult` calls `setInput` after unmount (no mounted guard)
**Lines:** 3449 (StudioCopilot.tsx)

Unmount cleanup (line 3411) calls `recognitionRef.current?.stop()` — good. But `r.onresult` (line 3449) calls `setInput` after a possible unmount. `stop()` may still fire a final `onresult`/`onend` asynchronously, calling `setInput`/`setListening` on an unmounted component. React warns in dev but is harmless in production.

**Fix:** Add a `mountedRef` guard in the `onresult` callback.

---

## Tool Progress Side Effects

### Medium: `tool_progress` global-history side effects — parallel tools overwrite each other
**Lines:** 3124-3172 (StudioCopilot.tsx)

`loadActiveClipJobs()`, `loadActiveDownload()` etc. are read synchronously inside a code path that fires for EVERY `tool_progress` event. For `download_video` (3142) and `generate_subtitles` (3150) the guard compares only the single active job's `jobId`; if two download tools run (parallel youtube_processing allows ≤3), the second **overwrites** the first's active record because `saveActiveDownload` stores a single job. The activity feed loses track of the first job.

**Fix:** Store active jobs as a keyed collection (like clip jobs already do via `loadActiveClipJobs`) rather than single-slot for download/subtitle.

---

## Session Persistence & Reconnect

### Medium: `reconnectBanner` retry reuses `lastUserAttachmentsRef.current` with possibly revoked blob URLs
**Lines:** 3657, 3589 (StudioCopilot.tsx)

On retry (line 3657) and message-retry (line 3589), `lastUserAttachmentsRef.current` is passed back into `sendMessage`. If the user deleted those attachment chips (`removeAttachment` revokes `previewUrl` at line 2733), the `previewUrl` is a revoked blob URL. The new user bubble (line 2867) renders `<img src={revokedBlobUrl}>` → broken image.

**Fix:** On retry, drop `previewUrl` for attachments whose blob may be revoked, or re-create object URLs from retained file references.

---

### Medium: Share feature copies raw messages — no preview or confirmation of what was copied
**Lines:** 3467-3477 (StudioCopilot.tsx)

`handleShare` copies the first 5 user messages to clipboard with no preview. The user does not know what was copied or if it was successful beyond a generic toast "Chat summary copied."

**Fix:** Show a brief modal/tooltip preview, or at minimum include message count in the toast ("Copied 3 messages").

---

## Stop & Abort

### Medium: Stop button — no post-stop feedback message appended to chat
**Lines:** 3391-3408 (StudioCopilot.tsx)

`handleStop` immediately aborts the fetch (`abortRef.current?.abort()`) and marks all in-flight tool cards as cancelled. There is no "Response stopped" message appended — the user just sees streaming stop abruptly with no record that they stopped it. Tool cards get "'tool' cancelled" markers (line 3402), but text does not.

**Fix:** Append a brief system message "Response stopped by you" as an assistant note when the user hits stop.

---

### Medium: "New Chat" discards current session with unsent input — no confirmation
**Lines:** 3479 (StudioCopilot.tsx)

`handleNewChat` immediately sets `currentSessionId` to null, moving the user to the welcome screen. If they had unsent text in the input, it's silently lost. Streaming is guarded (`if (streaming) return`), but unsent composed text is not.

**Fix:** If `input.trim().length > 0`, show a confirm dialog: "You have unsent text. Start a new chat?"

---

## Slash Command / Input Parsing

### Low: Slash menu only opens when entire input matches `/^\/(\S*)$/`
**Lines:** 2579 (StudioCopilot.tsx)

Typing `/dub ` (with trailing space or any text) closes the slash menu — but `consumeLeadingSkillCommand` (line 2608) still parses a leading `/skill` at send time, so functionally OK. However, the menu won't reopen after editing, and `slashQuery` resets — minor UX/logic mismatch.

**Fix:** Match on `/^\/(\S*)$/` without requiring the input to end there, or keep the menu open on trailing space until a second space appears.

---

## Summary

| # | Severity | Category | Lines | Issue |
|---|----------|----------|-------|-------|
| H1 | Critical | SSE | 3028 | Events not filtered by `runId` — stale stream corrupts active message |
| H2 | Critical | Race | 2840, 3381 | Concurrent sends overwrite `abortRef` — stream leak |
| — | High | Memory | 2866-2876 | Base64 images in live sessions state forever |
| — | Medium | SSE | 3354 | Trailing buffer `parseSseFrame` after abort patches stopped message |
| — | Medium | State | 2767 | `currentMessages` new identity every render → wasted effects |
| — | Medium | State | 2902, 2767 | `messagesRef` lags by one render inside `sendMessage` |
| — | Medium | Tools | 3124-3172 | Parallel download/subtitle tools overwrite single-slot active job |
| — | Medium | Reconnect | 3657 | Retry reuses possibly-revoked blob URLs |
| — | Medium | UX-Logic | 3467-3477 | Share copies without preview |
| — | Medium | UX-Logic | 3391-3408 | Stop provides no feedback message |
| — | Medium | UX-Logic | 3479 | New Chat discards unsent input silently |
| — | Low | Voice | 3449 | Voice `onresult` fires `setInput` after unmount |
| — | Low | Input | 2579 | Slash menu closes on trailing space |

---

*Generated 2026-06-23 — Part 4 of 6 — Frontend Logic, Race Conditions & Memory Leaks*
