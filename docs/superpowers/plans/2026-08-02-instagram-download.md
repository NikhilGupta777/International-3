# Instagram Download Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable Instagram video downloading to the existing Download tab without changing YouTube behavior.

**Architecture:** Centralize supported URL detection and platform headers in an API library, enforce it at the API boundary, and mirror command construction in the independently bundled queue worker. Reuse the existing yt-dlp cookie pipeline with a filtered Instagram-cookie merge.

**Tech Stack:** TypeScript, Express, React, yt-dlp, Node test runner, AWS S3.

---

### Task 1: Supported source policy

**Files:**
- Create: `artifacts/api-server/src/lib/download-source.ts`
- Create: `artifacts/api-server/src/lib/download-source.test.ts`

- [ ] Write tests accepting YouTube and Instagram media URLs and rejecting profiles, lookalike hosts, and non-HTTP schemes.
- [ ] Run `pnpm exec tsx --test src/lib/download-source.test.ts` and verify failure because the module is missing.
- [ ] Implement `getDownloadPlatform`, `isSupportedDownloadUrl`, and `getDownloadPlatformArgs` with exact-host and media-path checks.
- [ ] Run the focused test and verify all cases pass.

### Task 2: API metadata and download path

**Files:**
- Modify: `artifacts/api-server/src/routes/youtube.ts`

- [ ] Import the supported-source policy.
- [ ] Preserve Instagram cookies when converting JSON exports to Netscape format.
- [ ] Add platform headers to metadata and download yt-dlp attempts.
- [ ] Validate `/youtube/info` and `/youtube/download` before running or queueing work.
- [ ] Reject Instagram metadata with no video format and map Instagram-specific failures to safe messages.
- [ ] Run the focused policy tests and API typecheck.

### Task 3: Queue worker parity

**Files:**
- Modify: `artifacts/queue-worker/src/index.ts`

- [ ] Add the same narrow Instagram media URL and header behavior used by the API bundle.
- [ ] Preserve Instagram cookies during JSON-to-Netscape conversion.
- [ ] Include platform headers in worker download attempts while leaving YouTube fallback clients unchanged.
- [ ] Run queue-worker typecheck and build.

### Task 4: Download-tab presentation

**Files:**
- Modify: `artifacts/yt-downloader/src/pages/Home.tsx`

- [ ] Change the top copy to “YouTube and Instagram supported.”
- [ ] Update input name, label, placeholder, and missing-URL error.
- [ ] Hide YouTube subtitle actions for Instagram URLs.
- [ ] Preserve existing unrelated `Home.tsx` worktree changes.
- [ ] Run frontend typecheck and production build sequentially.

### Task 5: Managed cookies

**Inputs:**
- Source: `C:/Users/g_n-n/Downloads/cookies (8).txt`
- Target: `s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt`

- [ ] Verify the source is Netscape format and count Instagram rows without printing secrets.
- [ ] Back up the current target object because its bucket is not versioned.
- [ ] Merge only `instagram.com` rows with the current downloader rows.
- [ ] Upload the base64 Netscape bundle and verify total/Instagram row counts.
- [ ] Retain the backup until final verification succeeds.

### Task 6: End-to-end verification and audit

**Files:**
- Verify all files above; do not add permanent smoke-test artifacts.

- [ ] Build the API and start it locally with queue-primary disabled.
- [ ] Authenticate through `/api/auth/login`.
- [ ] Call `/api/youtube/info` for a current public Instagram reel.
- [ ] Start `/api/youtube/download`, poll to `done`, and verify `/api/youtube/file/:jobId` begins with MP4 `ftyp`.
- [ ] Remove the exact temporary downloaded file and stop the local server.
- [ ] Run policy tests, all three typechecks, and all three builds sequentially to avoid machine-memory contention.
- [ ] Audit `git diff`, confirm no unrelated changes were overwritten, and confirm no staged changes or test artifacts.
- [ ] Keep the S3 backup for rollback until the user approves deployment/push.
