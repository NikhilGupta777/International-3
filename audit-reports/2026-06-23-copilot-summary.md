# Studio Copilot — Deep Audit Summary

**Date:** 2026-06-23
**Scope:** Full-stack audit of the Studio Copilot AI chat feature
**Auditors:** Claude Opus 4.8 (four parallel deep-audit agents)

---

## Files Audited

| File | Lines | Area |
|------|-------|------|
| `artifacts/yt-downloader/src/components/StudioCopilot.tsx` | 3,979 | Frontend chat UI |
| `artifacts/api-server/src/routes/agent.ts` | 4,010 | Backend agent loop + 32 tools |
| `artifacts/yt-downloader/src/lib/agent-prompt.ts` | 279 | Agent system prompt sent to Gemini |
| `artifacts/api-server/src/lib/internal-agent.ts` | 31 | Internal auth secret management |
| `artifacts/api-server/src/lib/sse.ts` | ~50 | SSE streaming helpers |
| `artifacts/yt-downloader/src/index.css` | ~11,000 | CSS (gs-* copilot classes) |

---

## Totals

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 20 |
| Medium | 34 |
| Low | 20 |
| Previously Known | 8 (3 unfixed, 5 fixed) |
| **Total** | **85** |

---

## Report Files

This audit is split into 6 focused reports:

| # | File | Contents |
|---|------|----------|
| 1 | `2026-06-23-copilot-summary.md` | **This file** — executive summary, action plan, master index |
| 2 | `2026-06-23-copilot-backend-sse-loop.md` | Backend SSE correctness, agent iteration loop, Gemini API calls, concurrency, Lambda lifecycle |
| 3 | `2026-06-23-copilot-backend-tools-security.md` | Tool implementations, SSRF, credential leakage, rate limiting, cost controls, input validation |
| 4 | `2026-06-23-copilot-frontend-logic.md` | React state bugs, SSE parsing, race conditions, memory leaks, localStorage, session persistence |
| 5 | `2026-06-23-copilot-frontend-uiux.md` | Accessibility, responsive design, UX flaws, visual bugs, input handling |
| 6 | `2026-06-23-copilot-known-issues-tracker.md` | Status of the 8 previously-identified issues + verification notes |

---

## Top 10 Most Urgent Findings

| Rank | ID | Severity | Area | Finding |
|------|----|----------|------|---------|
| 1 | CE1 | Critical | Backend Security | `getApiBase` reads `X-Forwarded-Host` from untrusted client — SSRF + credential leak in dev |
| 2 | CE2 | Critical | Backend Security | `read_web_page` follows redirects to internal hosts — SSRF |
| 3 | CE3 | Critical | Backend Security | Global E2B sandbox Maps survive Lambda warm starts — cross-tenant state leak |
| 4 | H11 | High | Frontend Logic | Concurrent `sendMessage` invocations overwrite `abortRef` — stream leak |
| 5 | H10 | High | Frontend Logic | SSE events not filtered by `runId` — stale stream corrupts active message |
| 6 | H5 | High | Backend Security | `do_full_package` fans out 7 heavy tools with no rate limit |
| 7 | H6 | High | Backend Security | `translate_video` — no cost control on GPU Batch jobs |
| 8 | CE1-CE2-H1 | Critical/High | Backend Security | SSRF hardening: validate redirect targets, attachment URLs, `X-Forwarded-Host` |
| 9 | H1 | High | Backend SSE | No timeout on Gemini streaming — Lambda hangs 900s |
| 10 | H15-H16 | High | Frontend A11y | Missing aria-labels, no focus traps in modals |

---

## Action Plan by Priority

### 🔴 Phase 1 — Critical (fix immediately, before next deploy)

| # | Finding | File | Lines | Effort |
|---|---------|------|-------|--------|
| 1 | Remove `X-Forwarded-Host` fallback, hardcode `http://127.0.0.1` | `agent.ts` | 101-106 | 5 min |
| 2 | Add post-redirect `isInternalHost` check in `read_web_page` | `agent.ts` | 1973-2001 | 15 min |
| 3 | Cap E2B sandbox Maps + session ownership validation | `agent.ts` | 1202-1203 | 1 hr |

### 🟠 Phase 2 — High Security (fix within 1 week)

| # | Finding | File | Lines | Effort |
|---|---------|------|-------|--------|
| 4 | Add `isInternalHost` to attachment URL fetch and Gemini `fileData` | `agent.ts` | 1721-1798, 2830-2851 | 30 min |
| 5 | Add `X-Internal-Agent` to `save_artifact_to_workspace` fetch | `agent.ts` | 3132-3181 | 10 min |
| 6 | Add per-user rate limit + cost quota on agent-triggered heavy ops | `agent.ts` | 2510-2563, 2254-2304 | 3 hr |
| 7 | Add output character limit in `htmlToReadableText` | `agent.ts` | 1915-1932 | 15 min |
| 8 | Cap caption/search/image sizes returned to model | `agent.ts` | 2307-2325, 2442-2478, 1563-1579 | 1 hr |

### 🟠 Phase 3 — High Frontend (fix within 1 week)

| # | Finding | File | Lines | Effort |
|---|---------|------|-------|--------|
| 9 | Gate SSE events by `runId` + `abortRef.current.signal.aborted` | `StudioCopilot.tsx` | 3028 | 1 hr |
| 10 | Guard `sendMessage` with `streamingRef` (ref, not state) | `StudioCopilot.tsx` | 2840, 3381 | 30 min |
| 11 | Use `el.scrollTop = el.scrollHeight` during streaming | `StudioCopilot.tsx` | 2779-2786 | 15 min |
| 12 | Add `aria-expanded`, `aria-label`, focus traps to modals | `StudioCopilot.tsx` | 1214, 1478, 2111 | 2 hr |
| 13 | Add sending indicator between submit and first SSE event | `StudioCopilot.tsx` | 3708-3970 | 30 min |

### 🟡 Phase 4 — High Remainder (fix within 2 weeks)

| # | Finding | File | Lines | Effort |
|---|---------|------|-------|--------|
| 14 | Add 5-minute timeout on Gemini streaming calls | `agent.ts` | 3423-3436 | 15 min |
| 15 | Wire `GEMINI_API_KEY_2`..`_6` rotation into retry logic | `agent.ts` | 3369 | 1 hr |
| 16 | Pass `AbortSignal` from handler into tool-level Gemini calls | `agent.ts` | 3579-3651 | 1 hr |
| 17 | Use `Promise.allSettled` instead of `Promise.all` for tool batches | `agent.ts` | 3798 | 5 min |
| 18 | Fix clipboard error handling (toast only on success) | `StudioCopilot.tsx` | 1138, 1400 | 10 min |
| 19 | Increase disabled send button opacity | `index.css` | 3959-3962 | 5 min |
| 20 | Fix `renderMd` early-return dead code (known issue #1) | `StudioCopilot.tsx` | 565 | 5 min |
| 21 | Strip base64 from live sessions state after send (known issue #2) | `StudioCopilot.tsx` | 2866-2876 | 15 min |
| 22 | Fix `extractCanvasCandidate` live canvas blocking (known issue #7) | `StudioCopilot.tsx` | 1056-1083 | 20 min |

### 🔵 Phase 5 — Medium/Low (fix when convenient, 52 items)

See individual report files for complete listings.

---

## Affected Subsystems

- **Backend SSE streaming** — 11 findings (disconnect detection, heartbeat, flush correctness, abort propagation)
- **Backend agent loop** — 8 findings (iteration control, infinite loop risk, empty response retry)
- **Backend tools** — 24 findings (SSRF × 4, credential leak × 2, rate limiting × 5, unbounded resources × 6, input validation × 4, error sanitization × 3)
- **Backend security/auth** — 7 findings (internal auth bypass, X-Forwarded-Host, secret persistence, job enumeration)
- **Frontend state management** — 9 findings (race conditions, stale closures, ref/state desync, concurrent streams)
- **Frontend memory** — 5 findings (base64 retention, object URL leaks, session storage bloat, DOM bloat)
- **Frontend accessibility** — 9 findings (missing aria, focus traps, keyboard nav, WCAG violations)
- **Frontend UX** — 20 findings (scroll behavior, loading states, disabled states, copy feedback, IME, mobile)

---

## Methodology

Four independent audit agents ran in parallel, each with a distinct focus area and adversarial verification prompts. Each agent was read-only (no edits). After all agents completed, findings were consolidated, deduplicated, and severity-graded.

1. **Backend Tools & Security Agent** — Examined all 32 tool implementations for SSRF, input validation, auth bypass, rate limiting, resource exhaustion
2. **Backend SSE & Agent Loop Agent** — Examined SSE streaming correctness, agent iteration control, Gemini API calls, concurrency, Lambda lifecycle
3. **Frontend Logic & Bugs Agent** — Examined React state, SSE parsing, race conditions, memory leaks, localStorage persistence
4. **Frontend UI/UX & A11y Agent** — Examined accessibility, responsive design, UX flows, visual bugs, input handling

---

*Generated 2026-06-23 by Claude Opus 4.8 — VideoMaking Studio Copilot Deep Audit*
