# Studio Copilot — Previously Known Issues: Fix Status Tracker

**Date:** 2026-06-23 (re-verified against current code)

These 8 issues were previously documented in `audit-reports/studiocopilot_issues.md` (dated ~June 18, 2026). A fresh code review today confirms which have been fixed and which remain.

---

## Issue #1 — Broken Markdown Rendering (Dead Code Bypass)
**Status:** ❌ STILL PRESENT

**Location:** `StudioCopilot.tsx:564-565`

```typescript
function renderMd(text: string, sources?: ...): React.ReactNode {
  return <MarkdownContent text={text} sources={sources} />;
  const lines = text.split("\n"); // DEAD CODE — never reached
```

The early `return` on line 565 bypasses hundreds of lines of custom formatting, token rendering, math formula handling, and citation resolution. All markdown content goes through the `<MarkdownContent />` fallback component instead of the custom parser.

**Note:** `renderStreamingMd` does NOT have the early return — it uses the full custom streaming parser. This inconsistency means markdown renders differently during streaming vs. once complete.

**Original fix direction:** Remove the early `return <MarkdownContent ... />` to allow the custom parsing logic to execute.

---

## Issue #2 — Memory Bloat from Base64 Images in Live React State
**Status:** ❌ STILL PRESENT

**Location:** `StudioCopilot.tsx:2866-2876`

```typescript
updateSession(sessionId, msgs => [...msgs, {
  id: userMsgId, role: "user",
  parts: userParts,  // ← includes full base64 data strings
  timestamp: new Date(),
}]);
```

`slimSessionsForStorage` (line 99) strips base64 data before `localStorage.setItem`, but the in-memory `sessions` array and `sessionsRef` retain full base64 for all images in all messages of up to 120 sessions. Over a long browser session, this causes unbounded heap growth.

**Original fix direction:** Strip the `data` field from attachment parts in the live sessions state immediately after building the API request payload. Keep base64 only in the transient send-payload, not in React state.

---

## Issue #3 — Unrevoked Object URLs (Filesystem Memory Leak)
**Status:** ✅ FIXED

**Location:** `StudioCopilot.tsx:3415-3418`

```typescript
// Cleanup on unmount — NOW REVOKES pending attachment URLs:
useEffect(() => {
  return () => {
    abortRef.current?.abort();
    recognitionRef.current?.stop();
    sessionsRef.current.forEach(session => revokeMessagePreviewUrls(session.messages));
    pendingAttachmentsRef.current.forEach(a => {  // ← THIS IS NEW
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    });
  };
}, []);
```

Both session message preview URLs and pending attachment preview URLs are now cleaned up on unmount.

---

## Issue #4 — Concurrent Tool Resolution (tool_done without toolId resolves all matching tools)
**Status:** ✅ FIXED

**Location:** `StudioCopilot.tsx:3177-3185`

```typescript
if (evt.type === "tool_done") {
  setActiveToolLabel(null);
  patchAssistant(m => {
    let targetIdx = -1;
    if (evt.toolId) {
      targetIdx = m.parts.findIndex(p => p.kind === "tool_start" && (p as any).toolId === evt.toolId);
    } else {
      // NEW: targets only the oldest unfinished tool of this name
      targetIdx = m.parts.findIndex(p => p.kind === "tool_start" && (p as any).name === evt.name && !(p as any).done);
    }
    if (targetIdx === -1) return m;
    const parts = [...m.parts];
    parts[targetIdx] = { ...parts[targetIdx], done: true, result: evt.result, progress: 100 };
    return { ...m, parts };
  });
  return;
}
```

Uses `findIndex` to resolve only the first (oldest) matching unfinished tool, not all matching ones. When `toolId` is present, resolves by exact ID match. When absent, uses name + `!done` — the improved logic won't prematurely resolve parallel tools with the same name.

---

## Issue #5 — ReadAloudButton Missing Unmount speechSynthesis.cancel
**Status:** ✅ FIXED

**Location:** `StudioCopilot.tsx:2034-2038`

```typescript
function ReadAloudButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {                               // ← NEW
    return () => {                                 // ← NEW
      if ("speechSynthesis" in window) {           // ← NEW
        window.speechSynthesis.cancel();           // ← NEW
      }                                            // ← NEW
    };                                             // ← NEW
  }, []);                                          // ← NEW
```

Component now cleans up browser speech on unmount, preventing orphaned TTS audio.

---

## Issue #6 — Textarea Won't Shrink (No inputRef Resizing)
**Status:** ✅ FIXED

**Location:** `StudioCopilot.tsx:2824-2833`

```typescript
const resetComposerInput = () => {
  setInput("");                    // Clears React state
  textareaRef.current && (textareaRef.current.value = "");  // Clears DOM
  if (textareaRef.current) {      // ← NEW: Resets height
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.overflowY = "hidden";
  }
};
```

`resetComposerInput` now programmatically resets the textarea height to `auto` after clearing. Called from both send paths (lines 2839 and 2846 in the old report).

**Remaining concern:** `getInputMaxHeight()` is only called inside the `onChange` handler, not on viewport resize. If the browser window resizes while composing, the JS-set max-height won't update until the user types. Mitigated by CSS `max-height` media queries, but potential JS/CSS conflict.

---

## Issue #7 — Live Canvas Blocking (extractCanvasCandidate prioritizes closed blocks)
**Status:** ❌ STILL PRESENT

**Location:** `StudioCopilot.tsx:1056-1083`

The parser prioritizes the largest **closed** code block (matching ```` ```...``` ````). When multiple files are being generated, the first closed file blocks live previews for subsequent files currently streaming in an "open" state (unclosed code fence).

```typescript
function extractCanvasCandidate(text: string): CanvasCandidate | null {
  const closed = Array.from(text.matchAll(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*?)```/g));
  // ...
  if (closed.length > 0) {
    match = closed.reduce((best, item) => (item[2].length > best[2].length ? item : best), closed[0]);
  } else {
    const open = text.match(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*)$/);
    // ...
  }
```

The original fix (check for unclosed blocks by counting fence occurrences) was not applied. If any closed block exists, the open/live block is never considered, even if it's the primary content being streamed.

**Original fix direction:** Count total ```` ``` ```` occurrences (3 backticks). If odd → prioritize the open block. If even (all closed) → use the largest closed block.

---

## Issue #8 — TextArtifact Hidden Duplicate DOM Block
**Status:** ✅ FIXED

**Location:** `StudioCopilot.tsx:~1521-1535`

The `<div className="hidden">` block containing a duplicate legacy card layout (icon, label, char count, download button, `<pre>` preview) is no longer present. The component now renders a single `ArtifactShell` wrapper without the hidden duplicate.

---

## Summary

| # | Issue | Status | Fixed When |
|---|-------|--------|------------|
| 1 | `renderMd` dead code bypass | ❌ Unfixed | — |
| 2 | Base64 in live sessions state | ❌ Unfixed | — |
| 3 | `pendingAttachmentsRef` object URL leak | ✅ Fixed | Between Jun 18–23 |
| 4 | `tool_done` without toolId resolves all | ✅ Fixed | Between Jun 18–23 |
| 5 | `ReadAloudButton` no unmount cancel | ✅ Fixed | Between Jun 18–23 |
| 6 | Textarea won't shrink after send | ✅ Fixed | Between Jun 18–23 |
| 7 | `extractCanvasCandidate` live canvas blocking | ❌ Unfixed | — |
| 8 | `TextArtifact` hidden DOM duplicate | ✅ Fixed | Between Jun 18–23 |

**Remaining work:** 3 of 8 known issues still need attention. Issues #1 and #2 are the highest priority — #1 affects all markdown rendering correctness, and #2 causes progressive memory degradation over long sessions.

---

*Generated 2026-06-23 — Part 6 of 6 — Known Issues Fix Status Tracker*
