# Studio Copilot Frontend Audit — UI/UX, Accessibility & Visual Issues

**Date:** 2026-06-23 | **File:** `artifacts/yt-downloader/src/components/StudioCopilot.tsx` (3,979 lines) + `index.css`

---

## Accessibility

### High: Missing `aria-expanded`, `aria-label`, and `aria-controls` on critical interactive elements
**Lines:** 1214-1217 (ToolCard), 3682-3688 (suggestion chips), 3727 (attachment remove), 3777 (textarea), 3914 (reasoning menu)

- **ToolCard** header `<button>` (line 1214) — primary interaction for every tool card. No `aria-expanded`, `aria-label`, or descriptive text. Screen-reader users hear the tool label and arg summary as a run-on string with no context that it is expandable.
- **Suggestion chips** (line 3682) — no `aria-label` like "Send suggestion: <text>"
- **Attachment remove buttons** (line 3727) — no `aria-label` like "Remove <filename>"
- **Main textarea** (line 3777) — has `placeholder` but no `<label>`, `aria-label`, or `aria-labelledby`
- **Reasoning mode menu** (line 3914) — has `role="menu"` but no `aria-label` or `aria-labelledby` pointing to trigger

**WCAG Violations:** 1.1.1 (Non-text Content), 4.1.2 (Name, Role, Value)

**Fix:** Add `aria-expanded={expanded}` to ToolCard button, `aria-label` to all unlabeled interactive elements, `aria-labelledby` to the reasoning menu referencing the trigger button.

---

### High: No focus traps in modal dialogs — focus escapes to background
**Lines:** 1478-1556 (canvas modal), 2111-2218 (HistoryDrawer)

The full-screen canvas modal (z-index 80) and history drawer have no focus traps. When open, Tab past the last button lands focus on elements behind the overlay. The Escape key handler (line 2531) handles closing, but there is no `aria-hidden` on the background content.

**Fix:** Implement `useEffect`-based focus trapping: query focusable elements inside modal, on Tab wrap focus to first/last. Set `aria-hidden="true"` on the main chat area when modal/drawer open. On close, return focus to the trigger element.

---

### High: No auto-focus on drawer/modal open
**Lines:** 2111-2218 (HistoryDrawer), 1478-1556 (canvas modal)

When the `HistoryDrawer` opens, focus stays on the trigger element behind the backdrop. The drawer has a close button, search input, and session list — all unreachable without manual tabbing through the obscured page.

**Fix:** After the drawer/modal mounts, call `.focus()` on the first focusable element (close button or search input). Return focus to the trigger on close.

---

### Medium: History drawer missing `aria-modal="true"`
**Lines:** 2128 (StudioCopilot.tsx)

Has `role="dialog"` but lacks `aria-modal="true"`. Screen readers won't announce it as a modal and won't restrict navigation to the dialog.

**Fix:** Add `aria-modal="true"` to the `<motion.aside>` element.

---

### Medium: Hidden file upload input — no keyboard-accessible fallback
**Lines:** 3850-3856 (file input), 3868-3896 (plus menu)

The `<input type="file">` is hidden (`className="hidden"`) and only triggered by clicking the "+" button's popup menu. If the plus menu is collapsed, there's no keyboard-accessible way to upload a file.

**Fix:** Ensure the "+" button's popup menu has full keyboard navigation, or show a direct upload button that is always tabbable.

---

### Medium: History items use `<div role="button">` instead of native `<button>`
**Lines:** 2184-2208 (StudioCopilot.tsx)

```jsx
<div role="button" tabIndex={0} onClick={...} onKeyDown={...}>
```

Using a native `<button>` element would give free focusability, Enter/Space handling, and screen-reader role announcement without manual attribute management.

**Fix:** Replace the div with a native `<button>`, removing manual `role`, `tabIndex`, and `onKeyDown`.

---

### Medium: Message action buttons — no visible focus ring (WCAG 2.4.7 failure)
**CSS lines:** 6511-6516

```css
.gs-message-action-btn:focus-visible {
  background: #2f2f2f; color: #fff; outline: none;
}
```

`outline: none` is explicitly set without replacing it with another visible focus indicator. The background color change alone is too subtle for WCAG 2.4.7 (Focus Visible), especially on already-dark backgrounds.

**Fix:** Replace `outline: none` with `outline: 2px solid rgba(56, 189, 248, 0.7); outline-offset: 2px;`.

---

### Low: Reasoning mode menu has `aria-checked` but no menu-level label
**Lines:** 3919 (StudioCopilot.tsx)

Individual items have `aria-checked={reasoningMode === option.id}` (correct), but the menu itself has no `aria-label` or `aria-labelledby`.

**Fix:** Add `aria-label="Model selection"` on the menu `<div>`.

---

## UX Flaws

### High: No loading indicator between send and first SSE event
**Lines:** 3708-3970 (StudioCopilot.tsx)

After pressing Enter or clicking Send, there's a gap before `run_start` arrives (especially on cold starts / slow Gemini responses). During this gap:
- Send button becomes disabled (line 3964)
- Textarea remains briefly editable with old text until `resetComposerInput` clears it
- No spinner, no "Sending..." text

Users may think nothing happened and press Enter again — **compounding the H2 race condition** (concurrent sends).

**Fix:** Immediately clear textarea on send, show a pulsing send button or "Sending..." indicator until the first SSE event arrives.

---

### High: Auto-scroll breaks when user scrolls up during rapid streaming
**Lines:** 2779-2786 (StudioCopilot.tsx)

The auto-scroll effect fires on every `currentMessages` state change and checks `userIsNearBottom.current`. When streaming is rapid, the scroll handler (lines 3580-3582) may not fire between re-renders, causing `userIsNearBottom` to be stale — the page auto-scrolls down despite the user having scrolled up. The `requestAnimationFrame`-based scrolling creates a visual jump.

**Fix:** Use `el.scrollTop = el.scrollHeight` directly inside the rAF block during live streaming (only smooth-scroll for non-streaming message jumps). Debounce the `onScroll` handler more aggressively.

---

### High: Send button disabled state virtually invisible
**CSS lines:** 3959-3962

```css
.gs-send-disabled {
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.20);
}
```

On the dark input card background, this is nearly invisible — the button looks like it has disappeared entirely. Users may not realize a send button exists until they type text.

**Fix:** Use higher opacity for disabled state: `color: rgba(255,255,255,0.35)`, add a subtle border. Or keep the button in active color with reduced opacity (0.5) to signal "present but unavailable."

---

### High: No visual feedback when copying text — toast fires even on clipboard failure
**Lines:** 1138-1142, 1400-1403, 2022-2030 (StudioCopilot.tsx)

`CopyBubble` and `CompactTextArtifact` copy buttons do correctly swap icon → checkmark. But `InlineToolArtifact` (line 1141) and `WorkspaceFileCard` (lines 1913-1916) call `toast({ title: "Copied" })` even when `navigator.clipboard.writeText` fails silently (empty catch block). Users see "Copied" but nothing was actually copied.

**Fix:** Move toast call inside `.then()` or after successful `await`. Add error toast on failure: "Failed to copy".

---

### Medium: IME composition not handled for Enter key submission
**Lines:** 3822 (StudioCopilot.tsx)

```js
if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
```

The `onKeyDown` handler submits on Enter without checking `e.isComposing` or `e.keyCode === 229`. Users of input method editors (IME) for Chinese, Japanese, Korean, etc. will have their message sent mid-composition when they press Enter to confirm a character candidate → **truncated messages sent**.

**Fix:** Add `if (e.isComposing || e.keyCode === 229) return;` before the Enter key logic.

---

### Medium: Paste URL pill generates opaque prompt the user doesn't see
**Lines:** 3693-3704 (StudioCopilot.tsx)

When a user pastes or types a bare URL, a pill appears with text "Use <url>". Clicking it sets `setInput("What can you do with <url>?")` — a generated prompt the user never saw or approved. If they click it accidentally, the message text is sent on the next Enter.

**Fix:** Clicking the pill should populate the input field but NOT auto-send. Show the generated prompt text in the pill itself so the user knows what will be sent.

---

### Medium: "New Chat" discards unsent composed text without confirmation
**Lines:** 3479 (StudioCopilot.tsx)

`handleNewChat` immediately sets `currentSessionId` to null. If the user has typed a message but not sent, it's silently lost.

**Fix:** If `input.trim().length > 0`, show a confirm dialog.

---

### Medium: Stop button provides no post-stop feedback
**Lines:** 3391-3408 (StudioCopilot.tsx)

The Stop button immediately aborts and marks tools cancelled. No "Response stopped" message. The user sees streaming stop abruptly with no record they stopped it.

**Fix:** Append a brief system message "Response stopped by you" to the chat.

---

### Medium: History drawer search input not auto-focused on open
**Lines:** 2141-2157 (StudioCopilot.tsx)

When the history drawer opens, the search input is visually prominent but not auto-focused. Mobile users must tap into it manually.

**Fix:** Add `autoFocus` on the search `<input>` (line 2145) or use a ref + `useEffect` to focus on drawer mount.

---

### Low: Share copies raw messages without preview
**Lines:** 3467-3477 (StudioCopilot.tsx)

`handleShare` copies the first 5 user messages to clipboard with no preview. The user doesn't know what was copied.

**Fix:** Include message count in toast ("Copied 3 messages to clipboard"), or show a quick preview.

---

### Low: `ReadAloudButton` — no voice or rate selection for `SpeechSynthesisUtterance`
**Lines:** 2032-2058 (StudioCopilot.tsx)

`SpeechSynthesisUtterance` is created without specifying `voice`, `rate`, or `pitch`. The browser's default voice may be low-quality or inappropriate for the content language.

**Fix:** Look up available voices and pick one matching the content language, or set `utterance.rate = 1.0` explicitly.

---

## Responsive Design

### High: Textarea max-height too small on mobile (≤520px) — only ~3 visible lines
**Lines:** 53-57 (getInputMaxHeight), CSS 7170-7173 (StudioCopilot.tsx)

On viewports ≤520px, max-height drops to **76px**. At 15px font size, that's only ~3 visible lines. Users composing longer messages must constantly scroll within the textarea. The textarea spans the full card width on mobile, so screen real estate is available.

**Fix:** Raise `getInputMaxHeight()` to return at least ~120px for ≤520px viewports, or compute as percentage of viewport height: `Math.min(160, window.innerHeight * 0.2)`.

---

### Medium: Slash command menu overflows on very narrow viewports
**Lines:** 3736-3766, CSS 3770-3780 (StudioCopilot.tsx)

The slash menu width uses `width: min(310px, calc(100vw - 32px))` — reasonable. But if skill descriptions contain long text, individual menu items overflow.

**Fix:** Add `overflow-wrap: break-word` or `word-break: break-word` to `.gs-slash-menu-item-desc`.

---

### Medium: Reasoning mode menu can overflow left on narrow viewports
**Lines:** 3913-3935, CSS 6844-6851 (StudioCopilot.tsx)

Menu positioned with `right: 0; bottom: calc(100% + 12px)`. On screens <352px, the menu extends off-screen leftwards. The 520px media query tries `right: -46px` but this fixed offset won't scale.

**Fix:** Use `left: 50%; transform: translateX(-50%)` to center the menu on small screens.

---

### Low: Voice input button hidden entirely on mobile — no alternative dictation trigger
**CSS lines:** 7121-7123

```css
@media (max-width: 768px) { .gs-pill-speak { display: none; } }
```

Hides the voice input button on tablet and phone. This is an intentional design choice, but there's no alternative way to trigger voice input — an accessibility regression for users who rely on dictation.

**Fix:** Consider showing the speak button as an icon-only circle on mobile (matching Stop/Send button sizing) instead of hiding it.

---

### Low: Welcome screen starters grid breaks at very narrow viewports
**CSS lines:** 4441-4450

The starters grid is `grid-template-columns: repeat(2, 1fr)` default, falling to `1fr` at 640px. At 320-400px, starter buttons with long text (e.g., "Transcribe and translate a video to English") wrap awkwardly in a single column.

**Fix:** Use `grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr))` for more graceful reflow.

---

## Visual Issues

### Medium: Stream cursor color mismatch between rendering paths
**Lines:** 558, 866-873, CSS 2308-2316, 11043-11048 (StudioCopilot.tsx)

- General `.stream-cursor` class (CSS 2308): `background: rgba(248, 113, 113, 0.9)` (red)
- `.copilot-wrap .stream-cursor` override (CSS 11043): `background: rgba(103, 232, 249, 0.72)` (cyan)

Both `renderStreamingMd` inline cursor and `MarkdownContent` cursor are rendered. If the `.copilot-wrap` specificity override isn't always matched, cursors appear in two different colors.

**Fix:** Ensure cursor class is always within `.copilot-wrap` context, or unify to a single color definition.

---

### Medium: KaTeX block math `text-center` clips overflow — left portion of wide formula hidden
**Lines:** 403 (StudioCopilot.tsx)

Display-mode KaTeX has `overflow-x-auto` (correct) but combined with `text-center` — the left portion of a wide formula is clipped at the left edge.

**Fix:** Change `text-center` to `text-left` when formula width exceeds container, or add `min-width: fit-content` with a scroll container.

---

### Medium: `AnimatePresence` on `React.Fragment` — Framer Motion can't track exit animations
**Lines:** 3585 (StudioCopilot.tsx)

`AnimatePresence initial={false}` wraps all messages. Thinking block + message bubble are wrapped in `<React.Fragment key={msg.id}>` — Framer Motion requires a single DOM element to track exit animations.

**Fix:** Use `<div key={msg.id}>` wrapper instead of `React.Fragment`.

---

### Medium: `MusicArtifactCard` download — blob URL revoked before browser may start download
**Lines:** 1577-1592 (StudioCopilot.tsx)

The blob URL download path creates an `<a>`, appends to body, clicks, schedules removal + revoke after 5 seconds. If the download takes >5s to start (common on slow connections), the blob URL is revoked before the browser processes the download → broken download.

**Fix:** Use a longer timeout (60s) or detect download completion via anchor's `onblur` event before revoking.

---

## Internationalization

### Low: No RTL support — LTR-specific CSS utilities used throughout
**Lines:** 2252-2353 (StudioCopilot.tsx)

User/assistant bubbles use `ml-auto`/`mr-auto`-style direction via classes like `gs-message-row-user` / `gs-message-row-assistant`. In RTL mode, the alignment logic wouldn't flip. Similarly, `border-left` on thinking content strip (CSS 6570) would be on the wrong side.

**Fix:** Use logical properties: `margin-inline-start: auto`, `border-inline-start`. Replace `pl-*`/`pr-*` with `ps-*`/`pe-*`. Low priority — this is an English/Hindi application.

---

## Input Handling

### Low: `getInputMaxHeight()` not re-evaluated on viewport resize
**Lines:** 53-57, 3789-3795 (StudioCopilot.tsx)

`getInputMaxHeight()` is called inside `onChange` handler only. If the user resizes the browser while composing, the max-height won't update until they type again. CSS `max-height` (line 7172) and JS dynamically-set `max-height` can conflict.

**Fix:** Add a `resize` event listener that re-applies height calculation, or rely solely on CSS media queries for max-height.

---

### Low: Large image paste has no progress indicator — UI can freeze for seconds
**Lines:** 3832-3840 (StudioCopilot.tsx)

When a user pastes a large image from clipboard, `FileReader` reads it as base64 synchronously within the paste handler. For large images near the 50 MB limit, this can freeze the UI for several seconds with no loading indicator.

**Fix:** Show a brief "Processing image..." indicator while `FileReader` reads.

---

## Summary

| # | Severity | Category | Lines | Issue |
|---|----------|----------|-------|-------|
| H15 | High | A11y | 1214, 3682, 3727, 3777 | Missing aria-labels on critical interactive elements |
| H16 | High | A11y | 1478-1556, 2111-2218 | No focus traps in modals; focus escapes to background |
| H17 | High | A11y | 2111-2218, 1478-1556 | No auto-focus on drawer/modal open |
| H18 | High | UX | 3708-3970 | No loading indicator between send and first SSE event |
| H19 | High | UX | 2779-2786 | Auto-scroll breaks when user scrolls up during streaming |
| H20 | High | UX | CSS 3959-3962 | Send button disabled state virtually invisible |
| — | High | UX | 1138-1142, 1400 | Copy toast fires even on clipboard failure |
| — | Medium | A11y | 2128 | History drawer missing `aria-modal="true"` |
| — | Medium | A11y | 3850-3856 | Hidden file input — no keyboard-accessible upload |
| — | Medium | A11y | 2184-2208 | `<div role="button">` instead of native `<button>` |
| — | Medium | A11y | CSS 6511-6516 | No visible focus ring — WCAG 2.4.7 violation |
| — | Medium | UX | 3822 | IME composition not handled — CJK users send truncated messages |
| — | Medium | UX | 3693-3704 | Paste URL pill generates opaque prompt |
| — | Medium | UX | 3479 | New Chat discards unsent text silently |
| — | Medium | UX | 3391-3408 | Stop provides no post-stop feedback |
| — | Medium | UX | 2141-2157 | History search input not auto-focused |
| — | Medium | Responsive | 53-57 | Textarea max-height too small on mobile |
| — | Medium | Responsive | 3736-3766 | Slash menu overflows narrow viewports |
| — | Medium | Responsive | 3913-3935 | Reasoning menu overflows left on narrow screens |
| — | Medium | Visual | 558, CSS 2308 | Stream cursor color mismatch (red vs cyan) |
| — | Medium | Visual | 403 | KaTeX `text-center` clips left side of wide formula |
| — | Medium | Visual | 3585 | `AnimatePresence` on `Fragment` breaks exit animations |
| — | Medium | Visual | 1577-1592 | Blob URL revoked before download starts |
| — | Low | A11y | 3919 | Reasoning menu lacks `aria-label` |
| — | Low | A11y | CSS 7121-7123 | Voice button hidden on mobile, no alternative |
| — | Low | Responsive | CSS 4441-4450 | Starters grid breaks at 320-400px |
| — | Low | UX | 3467-3477 | Share copies without preview |
| — | Low | UX | 2032-2058 | `ReadAloudButton` — no voice/rate selection |
| — | Low | I18n | 2252-2353 | No RTL support (LTR-specific margin utilities) |
| — | Low | Input | 3789-3795 | `getInputMaxHeight` not re-evaluated on resize |
| — | Low | Input | 3832-3840 | No progress indicator for large image paste |

---

*Generated 2026-06-23 — Part 5 of 6 — Frontend UI/UX, Accessibility & Visual Issues*
