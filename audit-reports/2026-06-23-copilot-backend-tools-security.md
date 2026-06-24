# Studio Copilot Backend Audit — Tool Security, SSRF & Access Control

**Date:** 2026-06-23 | **File:** `artifacts/api-server/src/routes/agent.ts` (4,010 lines)

---

## SSRF (Server-Side Request Forgery)

### CE1 — Critical: `getApiBase` reads `X-Forwarded-Host` from untrusted client
**Lines:** 101-106 (agent.ts)

The internal API base resolver falls back to reading `req.headers["x-forwarded-host"] ?? req.headers.host` when `INTERNAL_API_BASE` is not set. An attacker who sends `X-Forwarded-Host: 169.254.169.254` on the agent chat request would make every internal API call target the AWS metadata endpoint. Because `buildInternalHeaders` (line 1181) forwards the user's cookie and appends `X-Internal-Agent` with the real secret, a request to the metadata endpoint would leak credentials in the `Cookie` and `X-Internal-Agent` headers.

**Attack vector (dev/local only):** When `INTERNAL_API_BASE` is unset (common in local development), any tool that makes internal API calls — download, clip, subtitles, cancel, check_status — will target the attacker-supplied host instead of `127.0.0.1`.

**Production mitigation:** `lambda-stream.ts` always sets `INTERNAL_API_BASE` before the agent route runs, so production is protected. But the fallback code path is dangerous and should be hardened.

**Fix:** Never trust client-supplied headers for host resolution. Hardcode:
```js
const apiBase = process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
```

---

### CE2 — Critical: `read_web_page` SSRF via HTTP redirect after initial URL validation
**Lines:** 1973-2001 (agent.ts)

```js
if (isInternalHost(parsed.hostname)) { throw new APIError(400, ...); }
const r = await fetch(url, { redirect: "follow", ... });
```

The URL is validated with `isInternalHost()` before fetch (correct), but the fetch uses `redirect: "follow"` (line 1981). An attacker hosting a page on an external domain that 302-redirects to `http://169.254.169.254/latest/meta-data/` has its content read and returned as tool output → fed into the model context. The redirected URL is NOT re-checked against `isInternalHost()`. Line 1995 captures `r.url` (the post-redirect URL) but only for reporting — the content has already been read into memory.

**Attack vector:** Create a page at `https://attacker.example/redirect` that 302-redirects to an internal/AWS metadata URL, then tell the Copilot "read https://attacker.example/redirect". The Copilot's tool output will contain the metadata content, which then enters the model context. The model may repeat it to the user.

**Fix:** After fetch completes, re-validate `new URL(r.url).hostname` with `isInternalHost()` and throw if true. Alternatively, use a redirect-aware fetch that validates at each hop.

---

### H1 — High: `read_uploaded_file` — arbitrary URLs in attachments fetched with no origin check
**Lines:** 1721-1798, 2830-2851 (agent.ts)

`latestNonImageAttachment` returns any attachment with a `.url` field from the client-provided conversation. `readAttachmentText` (line 1790) fetches this URL with no `isInternalHost()` check:

```js
const resp = await fetch(attachment.url);
body = await resp.text();
```

More critically: when the file is a PDF and the URL is not `data:`, line 2837-2845 sends the raw URL to Gemini as `fileData: { fileUri: ... }`. If an attacker crafts a conversation message with an attachment URL pointing to a private internal service (e.g., `http://127.0.0.1:8080/api/admin/overview`), Gemini's server-side fetch attempts to retrieve it. The model might include private content in its response.

**Fix:** Validate attachment URLs with `isInternalHost()` before fetching. Restrict `fileData.fileUri` to S3/CDN/YouTube domains only via an allowlist.

---

### H3 — High: `save_artifact_to_workspace` fetches internal URLs without `X-Internal-Agent`
**Lines:** 3132-3181 (agent.ts)

Relative URLs like `/api/youtube/file/<jobId>` are resolved against `apiBase` and fetched with only the user's `Cookie` header (line 3146), NOT the full `internalHeaders`. If `INTERNAL_API_BASE` is not set and `X-Forwarded-Host` is attacker-controlled (see CE1), this goes to an arbitrary host with only the user's cookie. Also, any workspace file from another session could be reachable if the model guesses the path.

**Fix:** Add `X-Internal-Agent` to this fetch. Validate URL origin against allowed API hosts.

---

### Low: `isInternalHost` misses IPv6 zone-ID handling
**Lines:** 1961-1962 (agent.ts)

The condition `lower.startsWith("fe80:")` is correct, but IPv6 link-local addresses with zone indices (e.g., `fe80::1%eth0`) are not handled — the `%` zone ID is not stripped. IPv6 addresses like `::ffff:169.254.169.254` (AWS metadata via IPv4-mapped) ARE correctly caught via the embedded v4 check at lines 1964-1966.

**Fix:** Strip zone IDs from IPv6 addresses before comparison: `lower.replace(/%25.*$/, "").replace(/%.*$/, "")`.

---

## Authentication & Access Control

### CE3 — Critical: Internal auth bypass allows cross-user job access
**Lines:** 2346-2371, app.ts:543-549 (agent.ts)

The internal API calls made by `check_job_status`, `cancel_job`, `check_active_jobs`, `cancel_active_jobs` all include `X-Internal-Agent` (line 1186), which in `app.ts:543-549` is checked with constant-time comparison and unconditionally lets the request through. The agent does not restrict which `jobId`s the model may request. A prompt-injected model could enumerate job IDs or cancel other users' jobs if those IDs are guessable.

**Attack scenario:** DynamoDB stores jobs keyed by UUID (hard to guess outright), but UUIDs from conversation history (injected by an attacker via a shared chat link or pasted text) could be targeted for cancellation. Since the internal auth bypass skips ownership checking entirely, any valid job UUID can be touched.

**Fix:** Forward the user's session identity to the internal endpoint and validate ownership server-side. Or pass a scoped auth token instead of the global bypass secret.

---

### Low: `INTERNAL_AGENT_SECRET` generated at startup, not persisted — recovery impossible after cold start
**File:** `lib/internal-agent.ts:27-28`

When not set via env, the secret is `crypto.randomBytes(32).toString("hex")`. There is no fallback to a persistent store. If the Lambda container cold-starts, the secret changes. Internal calls from other event-driven paths (self-invoked workers, timestamps worker) would fail silently.

**Production mitigation:** `lambda-stream.ts` sets `INTERNAL_API_BASE` to `http://127.0.0.1:<port>` and the gate is in the same process, so both sides use the same secret. The random secret regenerates per-process and always matches because the gate is the same process. Only cross-process internal calls would break.

**Fix:** Write the generated secret to `/tmp/internal-agent-secret` (persists across Lambda warm starts) and read it back if env is unset.

---

## Rate Limiting & Cost Controls

### H4 — Critical: `do_full_package` fans out 7 heavy tools with no guardrails
**Lines:** 2510-2563 (agent.ts)

```js
// Runs in parallel: download_video, analyze_youtube_video, generate_timestamps,
// generate_seo_pack, get_youtube_captions (or generate_subtitles), and find_best_clips
```

This is 5-7 concurrent heavy operations for a single user message. Via prompt injection (convincing the model to call `do_full_package` repeatedly), an attacker can spawn repeated batches of workloads costing:
- Gemini API calls (analyze, SEO, timestamps)
- yt-dlp bandwidth (download, captions)
- AssemblyAI transcription (subtitles)
- AWS Batch Fargate (download, clip-cut)

There is **no rate limit** on the `/api/agent/chat` endpoint itself.

**Fix:** Add a per-user concurrency gate (DynamoDB counter with TTL) that rejects a second `do_full_package` within a time window. Add a rate limiter to the agent endpoint. Consider adding a `MAX_CONCURRENT_AGENT_JOBS` env var.

---

### H5 — Critical: `translate_video` — no cost control on GPU Batch jobs
**Lines:** 2254-2304 (agent.ts)

This tool downloads an entire YouTube video via the streaming endpoint, uploads it to S3, then submits a GPU Batch job (CosyVoice 3.0 + LatentSync 1.6 — GPU instances cost $1-3/hour). A prompt-injected model could be tricked into translating dozens of long videos simultaneously.

**Fix:** Same as H4 — agent-level rate limiting, per-user daily/monthly cost quotas, `MAX_PARALLEL_TRANSLATION_JOBS` cap, or a prompt-based guard that prevents the model from issuing more than one translation per conversation turn.

---

### Medium: `run_sandbox_command` — no per-user concurrent sandbox limit
**Lines:** 1498-1499 (agent.ts)

The command timeout is bounded to 10 minutes, and sandbox lifetime is bounded by `E2B_SANDBOX_TIMEOUT_MS` (1 hour). But there is no per-user concurrent sandbox limit. Each new chat session creates a new sandbox. An attacker could spin up many concurrent E2B sandboxes, each running bash commands and installing packages, consuming E2B credits.

**Fix:** Track sandbox count in DynamoDB with TTL. Limit concurrent sandboxes per workspace/user.

---

### Medium: `generate_music` — Lyria generation has no rate limit
**Lines:** 1660-1704, 2764-2824 (agent.ts)

Lyria music generation sends prompts directly to Gemini models (`lyria-3-pro-preview` / `lyria-3-clip-preview`). There's no rate limiting or cooldown between music generations.

**Fix:** Add per-user cooldown between music generations (e.g., 30 seconds minimum).

---

## Resource Exhaustion

### H2 — High: `htmlToReadableText` regex can cause OOM DoS from crafted HTML
**Lines:** 1915-1932 (agent.ts)

The raw fetch is capped at 5 MB (`readResponseTextWithLimit` with `5 * 1024 * 1024`, line 1990). However, a crafted HTML page with thousands of deeply nested empty `<div>` tags can cause near-exponential blowup — each `</div>` becomes `\n` via the regex `</(p|div|...)>/gi` at line 1921. Maliciously constructed markup could produce multi-GB text strings that crash the Lambda process (1536 MB memory limit).

**Fix:** Add a character-count cutoff in `htmlToReadableText` that enforces the requested `maxChars` limit at each processing stage, not just on the final output. Reject text that grows beyond 10× the raw HTML size.

---

### Medium: `get_youtube_captions` — no size limit on returned captions
**Lines:** 2307-2325 (agent.ts)

`r.text()` is called with no size limit. A YouTube video with 12 hours of auto-generated captions could return megabytes of text. This is directly returned to the model and could exceed token limits, cause context truncation, or waste API costs.

**Fix:** Cap caption text to a reasonable size (e.g., 200,000 characters) using a streaming read with limit.

---

### Medium: `web_search` fallbacks — no overall result size cap
**Lines:** 2442-2478 (agent.ts)

The Tavily fallback at line 2452 returns `raw_content` from search results sliced to 4000 chars per result, but there is no overall answer size limit. If Tavily returns 20 results with raw content, the combined text could be 80K+ characters. The Serper fallback similarly has no overall size cap.

**Fix:** Cap total result text size across all fallback paths to a reasonable limit (e.g., 40,000 characters total).

---

### Medium: `extract_text_from_image` / `describe_image` — no size check on base64 data
**Lines:** 1563-1579, 2704-2746 (agent.ts)

`latestImageAttachment` returns any base64 image data from the last message with `type === "image"`. There is no size check on `attachment.data`. The Gemini API has per-request payload limits that will reject oversized images, but a very large base64 string could be processed in Node memory before reaching the API call, potentially causing Lambda OOM.

**Fix:** Reject base64 data strings larger than a reasonable limit (e.g., 10 MB decoded ≈ ~13.3 MB base64) before passing to Gemini.

---

### Medium: `read_uploaded_file` CSV/JSON analysis sends 120K chars to expensive ULTRA_MODEL
**Lines:** 2857-2859 (agent.ts)

Lines 2856-2858 slice content to 120,000 characters, then pass it directly into a Gemini Pro `generateContent` call via `textModelArtifact`. This uses `ULTRA_MODEL` (expensive). A 120K-char CSV combined with a detailed task prompt can easily exceed token budgets or produce very expensive completions.

**Fix:** Use cheaper Flash model for structured data analysis; cap input size lower for ULTRA_MODEL usage.

---

## Input Validation

### Medium: Error messages from internal API calls forwarded unsanitized to model
**Lines:** 2028-2029, 2063-2065, 2110, 2177-2178, etc. (agent.ts)

Many tools catch the internal API error and throw `err.error ?? <message>`. If the internal endpoint returns a verbose error with stack traces or internal paths, those flow into the model context. While the system prompt at line 1108 says "Do not reveal raw stack traces...", the model still SEES them in tool results and could later repeat them.

**Fix:** Sanitize internal error responses at each tool call site before returning to the model. Map known error codes to user-friendly messages.

---

### Medium: PDF URL sent to Gemini `fileData` without origin allowlist
**Lines:** 2837-2851 (agent.ts)

When `attachment.mimeType.includes("pdf")` and the URL is not `data:`, the URL is passed directly to Gemini as `fileData.fileUri`. There is no check that this URL is actually an S3/CDN presigned URL belonging to the application.

**Fix:** Add origin allowlist (only trusted S3/CDN domains) for URLs passed to Gemini `fileData`.

---

### Low: `jobId` not validated against UUID format in cancel/check endpoints
**Lines:** 2346-2371 (agent.ts)

`args.jobId` is used directly in URL paths like `${apiBase}/youtube/cancel/${args.jobId}` without sanitization. `fetch()` will URL-encode, so path traversal is not a concern, but very long jobIds could cause URL length issues or unexpected API behavior.

**Fix:** Validate jobId matches `/^[a-f0-9-]{8,64}$/` before use.

---

### Low: `stripReasoningTags` regexes incomplete — could miss model output leakage
**Lines:** 135-171 (agent.ts)

The 17 regex replacements aim to strip reasoning tags, S3 URLs, leaked tool result JSON, etc.:
- S3 URL stripping (line 156) misses regional endpoints like `.s3.us-east-1.amazonaws.com`
- `[JUDGE]`, `[PLAN]`, etc. stripping uses `^` anchor in multiline mode — these could appear mid-line and evade the regex

**Fix:** Add S3 URL pattern for `s3\.([a-z0-9-]+\.)?amazonaws\.com`. Remove `^` anchors from marker-pattern stripping.

---

### Low: `scanKnownJobIds` regex matches any hex string 8+ chars — false positives
**Lines:** 1876-1886 (agent.ts)

The regex `/\bjob(?:Id)?:?\s*([a-f0-9-]{8,})\b/gi` scans the entire conversation for job IDs. This can match UUIDs in user messages that are not job IDs, causing the agent to poll/cancel non-existent or wrong resources. Unlikely to cause harm (poll returns "not_found"), but could confuse the model.

**Fix:** Narrow the regex to require a stricter job ID context marker.

---

## Agent System Prompt

### Medium: `agent-prompt.ts` hardcodes `vms_live_YOUR_KEY` as API key placeholder
**File:** `artifacts/yt-downloader/src/lib/agent-prompt.ts:2`

```js
const keyToUse = apiKey || "vms_live_YOUR_KEY";
```

If `apiKey` is null/omitted, the prompt sent to Gemini includes `vms_live_YOUR_KEY` as the bearer token. This is a placeholder — the Copilot doesn't use this key directly (it uses internal tool calls instead) — but the text `vms_live_YOUR_KEY` appears in Gemini's context and could be output by the model. Users might confuse it for a real credential.

**Fix:** Omit the key entirely when not provided, or use a clearly-documented dev placeholder.

---

## Summary

| # | Severity | Category | Lines | Issue |
|---|----------|----------|-------|-------|
| CE1 | Critical | SSRF | 101-106 | `getApiBase` trusts `X-Forwarded-Host` from client |
| CE2 | Critical | SSRF | 1973-2001 | `read_web_page` follows redirects to internal hosts |
| H1 | High | SSRF | 1721-1798, 2830-2851 | `read_uploaded_file` fetches arbitrary URLs unchecked |
| H3 | High | SSRF | 3132-3181 | `save_artifact_to_workspace` missing `X-Internal-Agent` |
| CE3 | Critical | Auth | 2346-2371, app.ts:543 | Internal auth bypass allows cross-user job access |
| L2 | Low | Auth | lib/internal-agent.ts:27 | Random secret not persisted across cold starts |
| H4 | High | Rate | 2510-2563 | `do_full_package` — 7 heavy tools, no rate limit |
| H5 | High | Rate | 2254-2304 | `translate_video` — no GPU cost control |
| M5 | Medium | Rate | 1498-1499 | No per-user concurrent sandbox limit |
| M6 | Medium | Rate | 1660-1704 | No rate limit on Lyria music generation |
| H2 | High | Resource | 1915-1932 | `htmlToReadableText` regex OOM DoS |
| M1 | Medium | Resource | 2307-2325 | Unbounded caption size into model context |
| M2 | Medium | Resource | 2442-2478 | Unbounded web search result text |
| M3 | Medium | Resource | 1563-1579 | No size check on base64 attachment data |
| M8 | Medium | Resource | 2857-2859 | 120K chars to expensive ULTRA_MODEL |
| M7 | Medium | Input | 2028-2178 | Internal API errors forwarded unsanitized to model |
| M4 | Medium | Input | 2837-2851 | PDF URL to Gemini without origin allowlist |
| L1 | Low | Input | 2346-2371 | jobId not validated against UUID format |
| L3 | Low | Input | 135-171 | Incomplete `stripReasoningTags` regexes |
| L4 | Low | Input | 1961-1962 | `isInternalHost` misses IPv6 zone IDs |
| L5 | Low | Input | 1876-1886 | `scanKnownJobIds` overly broad regex |
| — | Medium | Prompt | agent-prompt.ts:2 | Hardcoded `vms_live_YOUR_KEY` placeholder |

---

*Generated 2026-06-23 — Part 3 of 6 — Backend Tool Security, SSRF & Access Control*
