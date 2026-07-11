# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## NPM Safety Guardrail

Before debugging, building, installing dependencies, running tests, or doing anything npm/npx/pnpm-related, read:

`npm-ignore-scripts-recovery.txt`

Keep npm lifecycle scripts blocked unless a specific package has been inspected and trusted. Prefer `pnpm` in this repo. Do not install Codex CLI through npm on this machine.

---

## Project Overview

**VideoMaking Studio** — private single-user media workspace at `videomaking.in`. A comprehensive media suite built on AWS serverless infrastructure (Lambda + Batch/Fargate + S3 + CloudFront). Features cover the full video production workflow: **download, clip, analyze clips, generate subtitles, generate timestamps, transliterate to new languages, create devotional content (Bhagwat AI), extract scenes, manage YouTube channel strategy, create thumbnail designs, edit video timelines with AI, and find video references via image matching** — plus a general-purpose AI studio assistant (Copilot) and developer API access.

**Updated 2026-07-03:** The following features previously marked as undocumented have now been backfilled:
- **Content Manager** (`routes/content-manager.ts`) — YouTube channel analytics and AI-powered content strategy generation (NEW)
- **AI Video Studio** (`routes/video-editor.ts`) — Frontend component `AiVideoStudio.tsx` is now WIRED (previously marked missing)
- **Thumbnail Generator** (`routes/thumbnail.ts` + `lib/thumbnail-preset-store.ts`)
- **HeyGen Translator** (`routes/heygen.ts`)
- **Workspace** (`routes/workspace.ts`) — file management for editor projects
- **Pitaji** (`routes/pitaji.ts`) — devotional audio-to-video app with independent auth
- **Developer / API Keys** (`routes/keys.ts`) — public API + webhooks + idempotency keys

Still undocumented but confirmed to exist:
- **Google Drive integration** (`lib/google-drive.ts`) — Copilot tools `list_drive_files`, `import_from_drive`
- **Skills system** (`skills/index.ts`, `skill-hyperframes.ts`) — scope unclear
- **`routes/v1.ts`** — internal re-dispatch endpoint (see `_metricsHooked`/`_apiKeyMetered` flags in app.ts)
- **GCS storage** (`lib/gcs-storage.ts`) — used alongside S3, conditions unclear

---

## Monorepo Structure

pnpm workspace. **Must use `pnpm` — `npm`/`yarn` are blocked by a `preinstall` hook in root `package.json`.**

```
artifacts/
  yt-downloader/                  # React 19 + Vite frontend (served as SPA)
    src/
      pages/                      # Top-level routed pages — only ~5 features live here (most live in components/, see below)
        Home.tsx, not-found.tsx, VideoTranslator.tsx, HeyGenTranslator.tsx,
        PitajiLogin.tsx, PitajiHome.tsx
      components/                 # Most feature UIs actually live flat in components/, NOT pages/
        ClipCutter.tsx, BhagwatVideos.tsx, BestClips.tsx, GetSubtitles.tsx,
        Timestamps.tsx, KathaSceneFinder.tsx, FileUpload.tsx, FindVideo.tsx,
        AdminPanel.tsx, DeveloperPanel.tsx, ApiDocumentationPage.tsx,
        WorkspacePanel.tsx, SettingsPanel.tsx, HelpPanel.tsx, ActivityPanel.tsx,
        FloatingActivityPanel.tsx, GlobalHistoryPanel.tsx, ActiveDownload.tsx,
        Thumbnail.tsx, ThumbnailPresets.tsx, BhavishyaClips.tsx, StudioHome.tsx,
        VideoPlayer.tsx, InstallBanner.tsx, ErrorBoundary.tsx, AppErrorBoundary.tsx
        katha/                    # AddReferenceForm, LibraryList, Lightbox, IdentifyTab (KathaSceneFinder sub-parts)
        pitaji/                   # PitajiSidebar, PitajiSettings, PitajiHistory, PitajiClipDetail, PitajiToast, PitajiLiveAgent
        layout/                   # Sidebar.tsx (main nav rail/drawer)
        ui/                       # shadcn/ui primitives (button, dialog, sheet, sidebar, etc. — ~50 files, do not hand-roll these)
      hooks/                      # use-activity-feed.ts, use-mobile.tsx, use-install-prompt.ts, use-object-urls.ts, use-toast.ts
      lib/                        # Per-feature history stores (download/clip/subtitle/translator/best-clips/music/timestamps/video-studio-history.ts),
                                   # session-history.ts, workspace-api.ts, video-editor-api.ts, pitaji-api.ts, agent-prompt.ts,
                                   # cost-estimate.ts, image-utils.ts, push-notifications.ts, user-preferences.ts, katha-types.ts
      integrations/supabase/      # client.ts + generated types.ts (used by KathaSceneFinder)
      App.tsx, main.tsx           # App root + entry
  api-server/                     # Express.js API — deployed as AWS Lambda container
    src/
      routes/                    # health, auth (in app.ts), youtube, subtitles, timestamps, bhagwat, translator,
                                  # uploads, agent, notebook, admin, notifications, ops, workspace, video-editor,
                                  # thumbnail, heygen, pitaji, keys, v1
      lib/                       # lambda-stream, sse, gemini-client, load-env, auth-access, api-key-auth, webhooks,
                                  # idempotency, internal-agent, public-jobs, youtube-queue, s3-storage, gcs-storage,
                                  # admin-features, ops-metrics, logger, push-notifications, email-submissions,
                                  # google-drive, workspace, thumbnail-preset-store, api-error,
                                  # pitaji-{auth,store,analysis,audio-pipeline,prompts,thumbnail,url,stream-parser}
      skills/                    # index.ts, skill-hyperframes.ts (not yet investigated)
      app.ts, index.ts, lambda.ts # Express app, local entrypoint, Lambda handler
  queue-worker/src/index.ts       # Fargate worker — single file, handles all job types (download/clip/subtitles/best-clips/bhagwat/editor-render)
  video-translator-service/       # Python GPU Batch worker (CosyVoice 3.0 + LatentSync)
                                   #   worker.py                      — main pipeline (one-shot CLI, no HTTP server)
                                   #   runtime_deps.py                 — runtime dependency bootstrap
                                   #   test_worker_guards.py           — routing/normalizer/prompt guard tests
                                   #   test_runtime_deps.py, test_phase{1_pacing,2_translation,3_cloning,4_5_mixing}.py — per-phase tests
                                   #     (filenames imply the pipeline was built/refactored in distinct phases — pacing, then
                                   #     translation, then voice cloning, then audio/video mixing — useful when debugging a stage)
                                   #   Dockerfile (GPU) / Dockerfile.base (the ~20GB CUDA+model layer) / Dockerfile.cpu (no-GPU Fargate variant)
                                   #   requirements.txt / requirements.cpu.txt / constraints.txt
  mockup-sandbox/                 # Standalone Vite+React UI prototyping sandbox (own package.json, not part of the deployed app)
lib/
  api-spec/               # openapi.yaml + orval.config.ts — source of truth for API contracts
  api-zod/                # Generated Zod schemas (src/generated/ — do not hand-edit)
  api-client-react/       # Generated React Query hooks (src/generated/ — do not hand-edit) + custom-fetch.ts
  db/                     # Drizzle ORM + PostgreSQL schema: src/schema/{conversations,messages}.ts (Notebook feature only)
  integrations-gemini-ai/ # Separate Gemini client (Replit integration variant): client.ts, image/client.ts, batch/utils.ts
deploy/
  aws-serverless/         # template.yml (CloudFormation), deploy-serverless.ps1, push-api-lambda-image.ps1,
                          # build-translator-ami.ps1, ecr-lifecycle-policy.json, DNS_CUTOVER_CHECKLIST.md, YTDLP_COOKIES_RUNBOOK.md
  aws-queue/              # create-phase-a-{resources,batch}.ps1, push-worker-image.ps1, create-alarms.ps1, submit-test-job.ps1
  ec2/                    # .env.green / .env.production (gitignored) + .example templates — production env file location
scripts/                  # enforce-pnpm.mjs, optional-uv-sync.mjs, scan-apps-malware.ps1, sanitize-heygen-prototype.ps1,
                          # patch-*.mjs (one-off codemods: timestamps-prompt, timestamps-ui, ts-unlimit, upload-tab, studio-ui)
supabase/
  functions/identify-katha/  # index.ts (HTTP handler + shortlist/rank orchestration), gemini.ts (key rotation + retry), prompts.ts (system prompt + tool schemas)
  migrations/                # Single SQL migration (katha_references table)
```

**Frontend "pages vs components" gotcha:** despite the directory being named `pages/`, most routed
features actually live flat under `components/` (e.g. `ClipCutter.tsx`, `BhagwatVideos.tsx`) and are
switched via the `Mode` union in `Home.tsx`, not via a router. Only `VideoTranslator.tsx`,
`HeyGenTranslator.tsx`, `PitajiLogin.tsx`, `PitajiHome.tsx`, and `not-found.tsx` are genuinely under
`pages/`. Don't assume a feature file lives in `pages/` just because it's a top-level feature.

---

## Development Commands

```bash
pnpm install                                           # install all workspace deps (after clone)

# ── Frontend ──────────────────────────────────────────────────────────────────
PORT=5000 pnpm --filter @workspace/yt-downloader run dev   # Vite dev server → port 5000
pnpm --filter @workspace/yt-downloader run build           # build → artifacts/yt-downloader/dist/public
pnpm --filter @workspace/yt-downloader run typecheck

# ── API server ────────────────────────────────────────────────────────────────
pnpm --filter @workspace/api-server run dev    # builds then starts on port 8080 (NO hot-reload)
pnpm --filter @workspace/api-server run build  # esbuild bundle → artifacts/api-server/dist/index.mjs
pnpm --filter @workspace/api-server run start  # run the built dist/index.mjs
pnpm --filter @workspace/api-server run typecheck

# ── Queue worker ──────────────────────────────────────────────────────────────
pnpm --filter @workspace/queue-worker run build
pnpm --filter @workspace/queue-worker run typecheck

# ── Workspace-wide ────────────────────────────────────────────────────────────
pnpm run typecheck          # typecheck all libs + artifacts
pnpm run build              # typecheck + build all packages
```

**Critical:** The `api-server` `dev` script **builds then starts** (no watch/hot-reload). After editing any file in `artifacts/api-server/src/` you must re-run `pnpm --filter @workspace/api-server run build`, then restart the process.

The Vite dev server proxies `/api/*` → `localhost:8080` (override with `API_PORT` env var). The proxy is SSE-aware with `selfHandleResponse: true` — see `vite.config.ts` for the custom proxyRes handler that prevents double-piping.

### Drizzle (PostgreSQL lib)

```bash
cd lib/db
pnpm exec drizzle-kit generate    # generate migration from schema changes
pnpm exec drizzle-kit push        # push schema to DATABASE_URL
```

---

## Local Environment Setup

Copy `.env.example` → `.env` in the repo root. Required minimum:

```bash
WEBSITE_AUTH_PASSWORD=anything       # api-server throws at startup without this
SESSION_SECRET=anything              # api-server throws at startup without this
YOUTUBE_QUEUE_PRIMARY_ENABLED=false  # run jobs in-process (skip AWS Batch)
GEMINI_API_KEY=<key>                 # for AI features
ASSEMBLYAI_API_KEY=<key>             # for subtitles/timestamps
```

`artifacts/api-server/src/lib/load-env.ts` is the **first side-effect import** in `src/index.ts`. It loads `.env` from the repo root (searches `cwd/.env`, `../../.env`, `../../../.env`) before any other module reads `process.env`. In production `NODE_ENV=production` is set so this file is skipped.

---

## Architecture

### Production Request Flow

```
Browser → CloudFront (videomaking.in / d2bcwj2idfdwb4.cloudfront.net)
  │
  ├── /* static   → S3 (ytgrabber-green-serverless-staticsitebucket-*)
  │                 CloudFront SPA rewrite function: /anything → index.html
  │
  └── /api/*      → Lambda Function URL (InvokeMode: RESPONSE_STREAM)
                    ↓
               lambda-stream.ts: internal localhost http.createServer(app)
                    ↓
               Express app (app.ts) → routes/index.ts
                    ↓
               DynamoDB (job state) + S3 (files) + AWS Batch (heavy jobs)
```

**Why Lambda Function URL instead of API Gateway:** API Gateway buffers the entire Lambda response and enforces a hard 30 s timeout — this kills SSE streaming. The Lambda Function URL with `InvokeMode: RESPONSE_STREAM` streams chunks as they are written. `artifacts/api-server/src/lib/lambda-stream.ts` implements the Express↔Lambda streaming bridge: it spins up a `http.createServer(app)` bound to `127.0.0.1:0` on cold start (localhost-only, not externally routable), explicitly sets `requestTimeout: 0` to disable Node's default ~120s request timeout (essential for multi-minute SSE), then per invocation translates the Function URL event into a real `http.request()` and pipes response chunks straight into `awslambda.HttpResponseStream`. `set-cookie` response headers are split into a separate `cookies` array, as required by that API. `INTERNAL_API_BASE` is set once per cold start to `http://127.0.0.1:{port}` — this is how the Copilot agent's internal tool calls avoid recursively invoking the Lambda itself. **CloudFront `/api*` behavior must have `Compress: false`** — gzip would re-buffer the entire stream. `OriginReadTimeout` is bumped to 60s (from CloudFront's 30s default) to survive multi-minute agent SSE runs.

### Job Lifecycle (all heavy jobs)

```
API Handler
  ├── creates DynamoDB record { status: "queued" }
  ├── if YOUTUBE_QUEUE_PRIMARY_ENABLED=true → submits AWS Batch job
  │     Batch worker runs in Fargate container (queue-worker/src/index.ts)
  │     Worker writes progress updates to DynamoDB every few seconds
  │
  └── if YOUTUBE_QUEUE_PRIMARY_ENABLED=false → runs in-process (local dev)
        EventEmitter drives progress callbacks in the Lambda/Express process

Frontend polls GET /api/youtube/progress/:jobId  OR  SSE stream/:jobId
DynamoDB: YOUTUBE_QUEUE_JOB_TABLE = "ytgrabber-green-jobs"

Status flow: queued → downloading → running → done | error | cancelled
```

**Timestamps and Subtitles** follow a different pattern — the API Lambda self-invokes another Lambda invocation (`InvocationType: Event`, async) so the heavy pipeline runs in a separate 15-minute container rather than the Fargate queue-worker. The `lambda.ts` entrypoint routes `event.source === "videomaking.timestamps"` and `"videomaking.subtitles"` to their respective worker functions.

### Auth System

Two independent auth layers:

**Main site auth** (`app.ts`):
- Signed cookie: `videomaking_auth` (30-day max age, `httpOnly`, `secure`, `sameSite: lax`)
- Cookie value: `"1"` (legacy password) or base64url-encoded JSON `{ method, role, email, name, picture }`
- Login: `POST /api/auth/login` (username + password) or `POST /api/auth/google` (Google ID token)
- Protected: all `/api/*` except `/api/healthz`, `/api/auth/*`, public share GETs (`/uploads/file/*`, `/translator/share/*`, `/agent/music-share/*`), and `/api/pitaji/*` (its own independent `pitaji_auth` cookie scope, unrelated to main or Bhagwat auth)
- `/api/admin/*` additionally requires a same-origin check (`isSameOriginAdminMutation`) comparing the Origin header against `x-forwarded-host`/`PUBLIC_SITE_URL`, on top of the admin-role check
- Internal server-to-server calls bypass cookie auth via `X-Internal-Agent: <INTERNAL_AGENT_SECRET>` header — secret is env var or crypto-random per process, never a hardcoded default
- A separate **API key auth path** also exists (`Authorization: Bearer vms_live_...` or `X-API-Key`): validates the key, blocks `/admin` and key-management paths via an allowlist, scopes the request via `x-client-id: key:{keyId}` (reusing the same owner-isolation as logged-in users), and meters rate limit/monthly quota only on the first external request (an internal `_apiKeyMetered` flag prevents double-counting on in-process re-dispatches)
- Login username default: `"kalki_avatar"` (env var `WEBSITE_AUTH_USER`, not "AUTH_USER")
- `ADMIN_PANEL_ENABLED` env flag gates `/api/admin/*` to admin-role sessions only
- Email allowlists (`lib/auth-access.ts`) enforce mutual exclusion between user/admin sets — promoting a user to admin removes them from the user set first; DynamoDB sync to `ACCESS_TABLE` is best-effort, env vars are always the fallback of record

**Bhagwat auth** (`bhagwat.ts`):
- Separate signed cookie: `bhagwat_auth` (30-day max age)
- Login: `POST /api/bhagwat/auth` with `BHAGWAT_PASSWORD`
- All `/api/bhagwat/*` routes except the auth endpoint require this cookie

**Google OAuth** (optional):
- `GOOGLE_AUTH_ENABLED=true` + `GOOGLE_CLIENT_ID` enables Google sign-in
- Email allowlist via `APPROVED_USER_EMAILS` and `APPROVED_ADMIN_EMAILS` env vars
- Managed in `artifacts/api-server/src/lib/auth-access.ts`

### SSE Pattern

All SSE endpoints use `artifacts/api-server/src/lib/sse.ts`:
```typescript
setupSse(res)   // sets headers, writes 2KB keepalive padding, enables TCP_NODELAY
sseFlush(res)   // flushes socket + Express
```

**Key gotcha:** Use `res.on("close", ...)` to detect client disconnect in SSE handlers, **NOT** `req.on("close")`. In Node 20 / Express 5, `req` close fires when the request body is fully consumed (milliseconds into the request), not when the connection drops.

### Gemini Client (`lib/gemini-client.ts`)

Supports two modes controlled by env:
- **API key mode** (default): `GEMINI_API_KEY` (+ `_2` through `_6` for rotation)
- **Vertex AI mode**: `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`

Vertex credentials can be provided as: `GOOGLE_APPLICATION_CREDENTIALS_JSON` (inline JSON), `GOOGLE_APPLICATION_CREDENTIALS_BASE64` (base64), or `GOOGLE_APPLICATION_CREDENTIALS_S3_KEY` (S3 path — fetched on cold start and written to `/tmp`).

`isGeminiConfigured()` returns false if no key/credentials — AI features degrade gracefully. Vertex credential resolution order is inline JSON → base64 → S3 key (fetched once per cold start, cached, written to `/tmp/google-vertex-credentials.json` with `0o600` perms — the "fetched" flag is only set true *after* the write succeeds, so a partial failure retries on the next request rather than silently using a missing file). Vertex location defaults to `"global"`, not a regional default. No multi-key rotation exists for Vertex service-account credentials (unlike the `_2`..`_10` API-key rotation) — only one service account is supported.

Note: `lib/integrations-gemini-ai` (used by Bhagwat's priority-1 image path) has its **own separate** Gemini client with its own env vars (`AI_INTEGRATIONS_GEMINI_BASE_URL`/`_API_KEY`) — it is not the same client as `lib/gemini-client.ts` and does not share key rotation.

### YouTube Cookie Management

yt-dlp requires authenticated YouTube cookies for downloading. Cookies are stored in S3 as base64-encoded Netscape format:
```
s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt
```
Both `youtube.ts` and `bhagwat.ts` lazy-load and cache this file on first use. When downloads fail with bot-detection errors, update the cookie file:
```powershell
$encoded = [Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))
[IO.File]::WriteAllText("tmp.txt", $encoded, [Text.UTF8Encoding]::new($false))
aws s3 cp tmp.txt s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt
```
No Lambda restart needed — worker fetches fresh on every job.

---

## API Routes Reference

All routes are under `/api`. Auth middleware is applied in `app.ts` before the router; only `/healthz`, `/auth/*`, and public share GET endpoints are unauthenticated.

**This section is not exhaustive.** `routes/workspace.ts`, `routes/thumbnail.ts`,
`routes/heygen.ts`, `routes/pitaji.ts`, `routes/keys.ts`, and `routes/v1.ts` all exist (see Monorepo
Structure above) but have no route table here — their individual endpoints haven't been documented yet.
Don't assume an endpoint doesn't exist just because it's missing from the tables below.
(`routes/video-editor.ts` is now documented — see its section below.)

### `/api/youtube/*` (`routes/youtube.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/youtube/diagnostics` | yt-dlp config, cookie status, bypass methods |
| GET | `/youtube/client-access` | Available YouTube extractor client options |
| POST | `/youtube/info` | Video metadata (title, duration, formats, subtitles) |
| POST | `/youtube/download` | Start full video download job |
| POST | `/youtube/clip-cut` | Cut a time range from a video |
| GET | `/youtube/progress/:jobId` | Poll job status (JSON) |
| GET | `/youtube/progress/stream/:jobId` | SSE real-time progress stream |
| POST | `/youtube/cancel/:jobId` | Cancel a job |
| GET | `/youtube/stream` | Proxy CDN stream URL with Range support |
| GET | `/youtube/file/:jobId` | Presigned S3 URL for completed download |
| GET | `/youtube/subtitles` | Download video subtitles (VTT/SRT) |
| POST | `/youtube/subtitles/fix` | AI subtitle correction (Gemini) |
| POST | `/youtube/clips` | Start Best Clips AI analysis job |
| GET | `/youtube/clips/stream/:jobId` | SSE stream for clip analysis results |
| GET | `/youtube/clips/status/:jobId` | Poll Best Clips job status |
| POST | `/youtube/download-clip` | Legacy direct clip download |

Key env vars: `YTDLP_*` (cookies, proxy, po_token, visitor_data), `GEMINI_API_KEY`, `S3_BUCKET`, `YOUTUBE_QUEUE_*`, `LAMBDA_CLIP_MAX_DURATION_SECONDS`, `LAMBDA_CLIP_COMMAND_TIMEOUT_MS`.

Metadata cached 5 min per video ID (`extractVideoId()` means `youtube.com/watch?v=ID` and `youtu.be/ID` share a cache entry); CDN stream URLs cached 25 min, keyed including `formatId` (underlying CDN URLs expire ~6h). Stream proxy requires `Referer: https://www.youtube.com/` + `Origin` headers or YouTube CDN returns 403. Per-IP per-minute rate limits: clip-cut 8/min, download 5/min, best-clips 5/min, cancel 180/min — bypass via `RATE_LIMIT_BYPASS_IPS` (CSV) or `X-Internal-Agent` header. **Clips/downloads auto-delete from S3 after 7 days** (`AUTO_DELETE_MS` constant in `youtube.ts` — corrected from a previous "2 hours" note in this file, verified against source).

Clip-cut has two execution paths: direct Lambda ffmpeg trim via `--download-sections` (clip ≤120s AND source ≤1h), or full-source-download + `-c copy` trim (clip >120s or source >1h; needs keyframes at cut points, optional `--force-keyframes-at-cuts`). A deadline system (`clipDeadlineAt = now + LAMBDA_CLIP_COMMAND_TIMEOUT_MS`) is checked before each retry to avoid overrunning Lambda's 15-min limit. yt-dlp player-client fallback cascade: web → web_embedded → tv_embedded → android_vr (tv_embedded is least bot-checked from server IPs). Best Clips job results live only in an in-memory map (`clipJobsState`) — lost on Lambda restart, no DynamoDB persistence of the analysis itself (only job status). The queue worker (`queue-worker/src/index.ts`) handles one `WorkerPayload.jobType` per invocation (`"download"|"clip-cut"|"subtitles"|"best-clips"|"bhagwat-analyze"|"bhagwat-render"|"editor-render"`); its Best Clips handler dynamically imports `runClipAnalysis` from api-server at runtime — this is why the worker image must also have api-server installed (see Docker Images section). See [[feature_download_clipcutter_bestclips]] memory for more.

### `/api/subtitles/*` (`routes/subtitles.ts`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/subtitles/generate` | Generate SRT from YouTube URL |
| POST | `/subtitles/generate-from-url` | Generate SRT from arbitrary media URL |
| POST | `/subtitles/upload/init` | Init S3 multipart upload for local video |
| POST | `/subtitles/upload/start` | Begin subtitle generation from uploaded file |
| POST | `/subtitles/upload/complete` | Finalize multipart upload |
| POST | `/subtitles/cancel/:jobId` | Cancel subtitle job |
| GET | `/subtitles/status/:jobId` | Poll subtitle job status |

Actually a multi-pass pipeline, not strictly two-pass: (1) transcription — AssemblyAI if duration >600s, else yt-dlp audio + Gemini (`gemini-3.1-pro-preview` primary, `gemini-3.5-flash` fallback, 5-min per-key timeout); (2) correction — enforces ≤6 words per SRT entry, explicitly told to add MISSING ENTRIES for speech after the last existing entry; (3) translation (optional) — strict "do not reshape timestamps" rule, per-language script rules (e.g. Devanagari for Hindi, no romanization); (4) verification (optional, video-based only) — checks SRT against actual video playback. Both `srt` (final) and `originalSrt` (pre-translation) are returned when translation runs.

Key env vars: `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY` (+ `_2` through `_10` for rotation), `SUBTITLES_FORCE_LAMBDA` (default **true**, not false — gates whether long videos route to a separate Lambda worker via queue), `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS` (default 600s), `SUBTITLES_GEMINI_VIDEO_ENABLED` (default true, direct video→Gemini path for short videos), `SUBTITLES_WORKER_FUNCTION_NAME`. In-memory job map cleans up 2h after completion (1h if still running); S3 cleanup sweep every 30 min, 7-day TTL on subtitles/subtitles-original/subtitles-uploads namespaces. Max 3 concurrent subtitle jobs server-side. See [[feature_subtitles_timestamps]] memory for more.

### `/api/youtube/timestamps*` (`routes/timestamps.ts`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/youtube/timestamps` | Start chapter timestamp generation |
| GET | `/youtube/timestamps/stream/:jobId` | SSE progress + results stream |
| GET | `/youtube/timestamps/status/:jobId` | Poll job status |

System prompt for Bhagwat Katha (devotional discourse) chapter generation requires exactly one entry per distinct topic — no merging, no max/min count. First entry MUST start at 0; each `endSec` = next entry's `startSec` (last entry's endSec = video duration); if Gemini returns a non-zero first entry with a >5s gap, the backend injects a synthetic `{startSec:0, label:"शुरुआत / Start"}` entry. Labels in the video's original language. Transcript source cascade: existing YouTube chapters (hint only) → metadata subtitle URL (VTT) → `youtube_transcript_api` → yt-dlp subtitle download → AssemblyAI fallback → title+description as last resort. Transcript capped at 120K chars (`MAX_TRANSCRIPT_CHARS`) — longer transcripts are evenly sampled, not truncated from the end. AssemblyAI poll has its own 30-min timeout, separate from yt-dlp/Gemini timeouts. Two deployment modes: Lambda mode (full pipeline runs inside the async-invoked worker — an earlier version that tried doing yt-dlp metadata fetch via `setImmediate` before invoking the worker was broken, since the Lambda container freezes right after the HTTP response returns) vs inline mode (local/ECS, EventEmitter SSE). Worker invoked via self-invoke Lambda (`TIMESTAMPS_WORKER_FUNCTION_NAME`). See [[feature_subtitles_timestamps]] memory for more.

### `/api/bhagwat/*` (`routes/bhagwat.ts`)

Protected by a separate `bhagwat_auth` cookie.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/bhagwat/auth` | Password login (sets bhagwat_auth cookie) |
| POST | `/bhagwat/analyze` | Start video analysis (segments + image prompts) |
| GET | `/bhagwat/analyze-status/:jobId` | Poll analysis progress + segments |
| POST | `/bhagwat/cancel-analyze/:jobId` | Cancel analysis |
| POST | `/bhagwat/review-plan` | AI review of segments (Gemini Pro) |
| GET | `/bhagwat/review-status/:jobId` | Poll review job |
| POST | `/bhagwat/render` | Render final MP4 (images + audio + subtitles) |
| GET | `/bhagwat/render-status/:jobId` | Poll render progress |
| GET | `/bhagwat/render-state/:jobId` | Full render state |
| GET | `/bhagwat/render-history` | List last 20 renders |
| POST | `/bhagwat/cancel-render/:jobId` | Cancel render |
| GET | `/bhagwat/download/:jobId` | Stream completed MP4 |
| POST | `/bhagwat/upload-audio` | Upload audio file (multer, max 5GB) |
| POST | `/bhagwat/analyze-audio` | Analyze uploaded audio |
| POST | `/bhagwat/render-audio` | Render audio (speech + images → video) |

**Analysis pipeline:** yt-dlp download → subtitle extraction → Gemini segmentation (`TimelineSegment[]`) → Gemini image prompt generation.

**Render pipeline:** load segments → fetch/generate images (Gemini image gen or colored fallback) → build SRT → FFmpeg concat + overlay → audio mix → S3 upload → DynamoDB DONE.

**TimelineSegment** shape: `{ startSec, endSec, isBhajan, imageChangeEvery, description, imagePrompt }`.

Image generation priority chain: (1) Replit integration (`generateImageViaReplit`, model list `BHAGWAT_IMAGE_MODELS` defaults `gemini-3.1-flash-image` → `gemini-2.5-flash-image` → `gemini-3.1-flash-image-preview`, 16:9 forced) → (2) own `GEMINI_API_KEY`(+`_2`..`_10`) × all models, Vertex-aware → (3) `withTimeout()` at 90s (`IMAGE_GEN_TIMEOUT_MS`), retried up to 5x with 7s between attempts → (4) colored fallback scene cards (FFmpeg text cards, 5 palettes hashed by prompt) — but fallback is only allowed for *transient* failures (safety refusal, overload) and gated by `BHAGWAT_ALLOW_FALLBACK_VISUALS` (default false); account-wide failures (quota/billing/expired key) throw hard with no fallback. `BHAGWAT_MAX_IMAGES_PER_JOB` (default 100) caps total images per render; tail segments are trimmed first if the budget is exceeded. `imageChangeEvery` is clamped (bhajan 20-40s, katha 8-12s) — actual on-screen image-change cadence is `segDur / imageCount`, not the literal `imageChangeEvery` value.

Security guards in bhagwat.ts: `pickSafeBhagwatId` (regex `^[A-Za-z0-9_-]{1,128}$`) for path traversal prevention; `safeFsArg` prepends `./` when a path starts with `-` to prevent CLI flag injection; `bhagwat_auth` cookie is compared with `timingSafeEqual()` to resist timing attacks.

In-memory state auto-cleanup: render files scheduled for deletion 60 min after first download (not immediately on render), directory sweep every 12h. `renderJobs` and `analysisJobs` Maps are wiped on Lambda restart — restart-resilience is handled by `persistRenderMetaStart` / `persistAnalysisMetaStart` writing **local disk** meta markers (`_analysis_meta/{jobId}.json`, not S3) at job start, then `hydrateInterruptedAnalysis` / `ensureRenderJob` reading them on boot/on-demand to convert orphaned "running" jobs into proper "interrupted by server restart" errors instead of leaving the UI stuck. See [[feature_bhagwat_scenefinder]] memory for full detail (FFmpeg batching, TimelineSegment flow, KathaSceneFinder/identify-katha algorithm).

### `/api/translator/*` (`routes/translator.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/translator/presign` | S3 presigned PUT URL for video upload |
| POST | `/translator/submit` | Submit GPU translation job (from S3 upload) |
| POST | `/translator/submit-from-url` | Download from URL then submit Batch job |
| GET | `/translator/status/:jobId` | Poll job status |
| GET | `/translator/result/:jobId` | Presigned download URLs (MP4 + SRT + transcript) |
| GET | `/translator/history` | Paginated job history |
| POST | `/translator/cancel/:jobId` | Terminate Batch job |
| GET | `/translator/share/:jobId` | Public share page (HTML preview + download) |

GPU pipeline (runs in `video-translator-service/worker.py`):
1. S3 download → FFmpeg audio extraction → AssemblyAI transcription
2. Gemini translation (dubbing-aware, preserves speaker turns)
3. CosyVoice 3.0 voice clone → edge-tts fallback → gTTS emergency
4. LatentSync 1.6 lip sync (optional, `LIP_SYNC=true`)
5. Audio mix + normalize → FFmpeg mux → S3 upload (MP4 + SRT + transcript JSON)

Owner isolation via `X-Client-ID` header or SHA256(IP|UserAgent). Rate limit: 20 uploads/hour/IP. Max video size: 2 GB (`TRANSLATOR_MAX_VIDEO_SIZE_BYTES`).

### `/api/uploads/*` (`routes/uploads.ts`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/uploads/presign` | Presigned upload (single or multipart) |
| POST | `/uploads/complete` | Complete multipart upload |
| GET | `/uploads/file/:fileId` | Download/preview (HTML landing for browsers) |
| GET | `/uploads/public` | List public files (paginated, max 100) |
| DELETE | `/uploads/file/:fileId` | Delete file |

Single PUT for < 50 MB; 10 MB multipart parts for >= 50 MB; hard max 3 GB (`MAX_BYTES` — distinct from the Bhagwat audio-upload 5 GB limit, don't conflate the two). Presigned upload URL TTL is 2h, but presigned download URL TTL is 7 days — a stalled upload past 2h will hit an expired presign mid-transfer. Rate limit: 20 uploads/hour/IP, checked at presign time. `UPLOADS_TABLE` env var required for DynamoDB persistence; falls back to in-memory for dev (lost on restart).

### `/api/agent/chat` (`routes/agent.ts`)

`POST /api/agent/chat` — SSE stream. The AI Studio Copilot agent.

**32 tools** organized by parallel execution group:
- **light** (≤3 concurrent): `get_video_info`, `get_youtube_captions`, `web_search`, `read_web_page`, `check_job_status`, `check_active_jobs`, `repeat_last_artifact`, `read_uploaded_file`, `describe_image`, `extract_text_from_image`, `write_video_script`, `generate_seo_pack`
- **youtube_processing** (≤3 concurrent): `cut_video_clip`, `download_video`, `generate_subtitles`, `find_best_clips`, `generate_timestamps`
- **serial**: all others (image gen, translate_video, navigate_to_tab, etc.)

SSE event stream: `run_start` → `text` / `tool_start` / `tool_progress` / `tool_log` / `tool_done` / `artifact` / `navigate` → `done`. Heartbeat every 8 seconds to keep connection alive. Streamed text deltas preserve all whitespace; the final complete-message text is trimmed — necessary for correct word spacing during token-by-token rendering. Text stripping also removes leaked S3 presigned URLs and leaked tool-result JSON from visible output, which can occasionally eat an intentional share link the model tried to print.

**Models — verified against source, corrected from previous doc:** the main agentic loop uses a **hardcoded** `AGENT_MODEL = "gemini-3-flash-preview"` constant in `agent.ts` — despite an inline comment claiming "environment overrides take precedence in production," **`COPILOT_MODEL` is not actually read anywhere in the loop**. Only Ultra mode (`COPILOT_ULTRA_MODEL`, default `gemini-3.1-pro-preview`) and Search mode (`COPILOT_SEARCH_MODEL`, default `gemini-3.5-flash`) genuinely read their env vars. Max iterations default is **49**, not 24 (`COPILOT_MAX_ITERATIONS` ?? `"49"`). Max output tokens: 16,384 (`COPILOT_MAX_OUTPUT_TOKENS`), but most individual Gemini calls clamp to `Math.min(AGENT_MAX_OUTPUT_TOKENS, 8192)`. `cut_video_clip` gets a 15-min job-poll timeout vs 8-min standard for other job-backed tools. Per-user cooldowns on heavy ops: `do_full_package` 90s, `translate_video` 5 min, `generate_music` 1 min.

Internal tool calls go to `process.env.INTERNAL_API_BASE/api` (set by `lambda-stream.ts` in production) to hit the same Express instance without a network round-trip — `getApiBase()` deliberately ignores `X-Forwarded-Host`/`Host` request headers to prevent header-injection redirecting internal calls. E2B sandboxes are keyed per sessionId (not per user) — same user in two tabs gets two separate, non-sharing sandboxes; max 20 concurrent sandbox entries. See [[feature_copilot_uploads_admin]] memory for full tool-by-tool detail.

### `/api/video-editor/*` (`routes/video-editor.ts`)

The **AI Video Studio** — "upload clips, describe the edit, get the video." A conversational, timeline-based video editor with an agentic Gemini loop. **Distinct** from the Bhagwat AI Video Editor (devotional image-timeline synthesis) and the Studio Copilot (general-purpose assistant agent).

> **Updated 2026-07-03:** Frontend component `AiVideoStudio.tsx` is now FULLY WIRED in `Home.tsx` (previously marked as missing/unwired). Backend + frontend both active and complete.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/video-editor/projects` | List projects (max 40, newest first) |
| POST | `/video-editor/projects` | Create project (title, prompt, sourceVideo, assets) |
| GET | `/video-editor/projects/:id` | Read full project (timeline, proposals, renders) |
| DELETE | `/video-editor/projects/:id` | Delete project + chat + uploads + renders trees |
| POST | `/video-editor/projects/:id/preview` | Start fast/low-quality preview render |
| POST | `/video-editor/projects/:id/render` | Start full-quality final render |
| GET | `/video-editor/jobs/:jobId` | Render job status (falls back to DynamoDB for Batch jobs) |
| POST | `/video-editor/jobs/:jobId/cancel` | Cancel a render (SIGTERM the ffmpeg process) |
| PATCH | `/video-editor/projects/:id/timeline` | Overwrite the timeline directly |
| POST | `/video-editor/projects/:id/probe` | ffprobe source, auto-fill trim.end |
| GET | `/video-editor/projects/:id/chat` | Read chat transcript (last 80 messages) |
| POST | `/video-editor/projects/:id/chat` | **SSE** — run the AI editing agent |
| GET | `/video-editor/projects/:id/proposals` | List edit proposals |
| POST | `/video-editor/projects/:id/proposals/:pid/apply` | Apply a proposal (commit its timeline) |
| POST | `/video-editor/projects/:id/proposals/:pid/reject` | Reject a proposal |
| GET | `/video-editor/projects/:id/renders/:jobId/thumb` | JPEG thumbnail of a finished render (LRU-cached) |

**State lives in workspace S3, not DynamoDB:** `editor/projects/<id>.json` (project), `editor/projects/<id>.chat.json` (chat), `editor/uploads/<id>/<role>/...` (assets), `editor/renders/<id>/<kind>-<jobId>.mp4` (outputs). `projectId` is validated against `^[a-f0-9-]{20,80}$`.

**Timeline model (v2):** three tracks — `video[]` clips (`srcIn/srcOut/tlStart/speed/transitions/colorPreset`), `overlays[]` (logo/text/image with `tlStart..tlEnd` windows), `audio[]` (volumeDb/fade/duck). `export` carries aspectRatio/cropMode/colorPreset. The legacy `recipe` (regex-derived) is the v1 fallback, migrated to a timeline on first chat.

**Chat agent:** Gemini loop, model `EDITOR_AGENT_MODEL` (default `gemini-3.1-pro-preview`), **hardcoded maxIterations=8**, ~31 tools (`add_clip`, `trim_clip`, `split_clip`, `reorder_clips`, `set_transition`, `add_overlay`, `add_audio`, `set_export`, `detect_logo_background` via Gemini vision, `propose`, `start_render`, YouTube tools `fetch_video_info`/`download_youtube`/`clip_cut_youtube`, `generate_subtitles`/`find_best_clips`/`generate_timestamps`, plus `analyze_video`, `get_transcript`, and `watch_youtube_video`). Workflow: read_timeline → build edit → **`propose()` (mandatory before render)** → user approves → `start_render`.

**Multimodal (reworked 2026-06-25):** image assets (logo, overlay images, intro/outro stills, image source) are attached to the agent's context **inline as base64** (downscaled JPEG) so Gemini sees them directly — no GCS, both API-key and Vertex modes. This fixes "I can't read the logo". Video is NOT auto-attached for watching: to understand a YouTube video the agent calls `get_transcript` (full captions, optional time range) by default; to actually watch/listen it calls `watch_youtube_video` (Gemini vision+audio via `fileData`, model `EDITOR_WATCH_MODEL` default `gemini-3-flash-preview`, optional start/end `videoMetadata` offsets) — flagged expensive/visual-only. Local videos/clips use `analyze_video` (fast ffmpeg frame sampling → Gemini vision) and `get_transcript` (AssemblyAI via `/subtitles/generate-from-url`). `pendingTimeline` is request-scoped — if the agent mutates but never proposes/renders, an **auto-snapshot proposal** is written at end-of-turn so edits survive a refresh. Offline (no Gemini key) falls back to the regex `generateRecipe()` parser.

**Render pipeline (FFmpeg, `processRenderJob`):** per-clip normalize (scale/crop/speed/color, 5→45%) → join via xfade `crossfadeClips` or `concatClips` (45→65%) → overlays (65→78%) → audio mix, final only (78→88%) → upload (92→100%). Preview = CRF 28 with an 8s budget across clips; final = CRF 22.

**Execution modes (production gotcha):** `VIDEO_EDITOR_BATCH_ENABLED=true` routes renders to AWS Batch (`submitEditorRenderJob`, DDB-tracked; worker `handleEditorRender` dyn-imports `runEditorRenderStandalone` from the co-installed api-server). With the queue **disabled in Lambda, `final` renders hard-error** ("AI Studio final renders require the background render queue in production") because Lambda freezes after the response — only inline preview works. Local/ECS runs renders in-process. See [[feature_video_editor]] memory for full detail (timeline helpers, stage progress math, idempotency/stale-job handling, GCS video upload, SSE safety nets).

### `/api/content-manager/*` (`routes/content-manager.ts`)

**AI YouTube Content Strategist** — analyzes YouTube channels and generates data-driven content strategy recommendations. Scrapes channel metadata, stores profiles, and uses Gemini with extended thinking to suggest titles, descriptions, tags, upload times, and content direction.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/content-manager/profiles` | List all saved channel profiles |
| GET | `/content-manager/profiles/:id` | Retrieve a single profile + metadata |
| DELETE | `/content-manager/profiles/:id` | Delete a saved profile |
| POST | `/content-manager/channels/scrape` | **SSE** — Scrape a YouTube channel (one-time, returns profile) |
| POST | `/content-manager/generate` | **SSE** — AI-generate a content pack from a saved profile + topic |

**Scrape flow:** Normalizes channel input (URL, handle `@name`, or channel ID) → runs yt-dlp to extract recent videos metadata → builds `ScrapedChannelProfile` (max 50 recent videos, up to 8 with full descriptions) → stores in DynamoDB (`CONTENT_PROFILE_TABLE` or fallback to `YOUTUBE_QUEUE_JOB_TABLE`). Progress updates via SSE. Response includes `profileId` (format `ycp_<UUID>`) for later re-use.

**Generation flow:** Takes a saved profile + user topic (≤4000 chars) → builds Gemini context with channel profile + analytics summary → Gemini (model `CONTENT_MANAGER_MODEL`, default `gemini-4-31b-it`, uses extended thinking like Copilot Ultra mode) has 6 max iterations → may call `search_tavily` for web context (max 4 searches per run) → outputs `ContentPack`:
```typescript
type ContentPack = {
  titles: Array<{ title: string; rationale: string }>;  // 5-10 video title suggestions
  description: string;                                   // channel description draft
  tagsCsv: string;                                       // suggested tags (CSV)
  bestUploadTime: {                                       // optimal publish window
    day: string;    // "Monday", "Tuesday", etc.
    time: string;   // "14:30"
    timezone: string;
    rationale: string;
  };
  mustDo: string[];                                      // action items (str array)
  channelSignals: string[];                              // observed content patterns
  sources?: Array<{ title: string; url: string }>;       // web search results (if any)
};
```

Key env vars: `CONTENT_MANAGER_MODEL` (Gemini model, default `gemini-4-31b-it`), `CONTENT_PROFILE_TABLE` (DynamoDB table, defaults to `YOUTUBE_QUEUE_JOB_TABLE`), `CONTENT_MANAGER_SCRAPE_TIMEOUT_MS` (default 4 min), `YTDLP_*` (cookies, proxy, etc. — same as YouTube download), `TAVILY_API_KEY` (optional, enables web search in content generation).

**Storage:** Profiles stored in DynamoDB with `kind: "youtube-content-profile"`, `owner: "__youtube_content_shared__"` (single shared namespace). Profile includes `name`, `channelInput`, `channelUrl`, `channelId`, `handle`, `recentVideos[]`, `recentDescriptions[]`, `analyticsSummary` (videoCount, averageViews, topTags, highPerformingTopics, bestObservedUploadWindows, uploadCadence). Timestamps: `scrapedAt`, `createdAt`, `updatedAt`.

**Frontend:** `YouTubeContentManager.tsx` component manages scrape/generate flow, displays profiles as saved cards, allows deletion, regeneration, and topic input with validation. Shows generated content pack in a review panel (`VideoStudioReviewEditor.tsx` component reused from AI Video Studio).

### `/api/heygen/*` (`routes/heygen.ts`)

**HeyGen Translator** — alternative to GPU translator. Uses HeyGen's API for avatar-based dubbing. Similar surface to `/api/translator/*` but delegates to HeyGen instead of CosyVoice.

| Method | Path | Description |
|--------|------|-------------|
| (mirrored from `/translator/*`) | — | Presign, submit, status, result, history, cancel, share endpoints parallel `/translator/*` |

Auth: Requires `HeyGenApiKey` (CloudFormation parameter, stored in env). Rate limit and ownership isolation via `X-Client-ID` or IP+UserAgent hash, same as GPU translator.

### `/api/workspace/*` (`routes/workspace.ts`)

**Workspace** — file manager for AI Video Studio projects. Stores editor-related files (source videos, assets, renders). Provides CRUD operations on workspace directory structure within S3.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/workspace/files` | List workspace files (recursive) |
| POST | `/workspace/presign` | Presigned upload URL |
| POST | `/workspace/files` | Create/upload file |
| GET | `/workspace/files/:path` | Download/preview file |
| DELETE | `/workspace/files/:path` | Delete file |

Copilot agent tools reference workspace: `list_workspace_files`, `read_workspace_file`, `write_workspace_file`, `delete_workspace_file`. Root path: `editor/uploads/<projectId>/`.

### `/api/keys/*` (`routes/keys.ts`)

**Developer API Platform** — manage API keys, webhooks, and public job access.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/keys` | List user's API keys |
| POST | `/keys` | Create new API key |
| DELETE | `/keys/:keyId` | Revoke key |
| GET | `/keys/:keyId/usage` | Key usage stats + quota |
| POST | `/webhooks` | Register webhook URL |
| GET | `/webhooks` | List webhooks |
| DELETE | `/webhooks/:id` | Remove webhook |
| POST | `/public/jobs` | Submit job as public API (requires valid API key) |

API key format: `vms_live_<keyId>` (bearer token auth). Owned by a user, scoped to specific job types/endpoints via `x-client-id: key:<keyId>` header. Includes idempotency key support for webhook retries. See `lib/api-key-auth.ts`, `lib/webhooks.ts`, `lib/idempotency.ts`, `lib/public-jobs.ts` for implementation.

### `/api/pitaji/*` (`routes/pitaji.ts`)

**Pitaji** — near-standalone sub-application for converting devotional audio into video with AI-generated visuals. Has its own independent auth (`pitaji_auth` cookie, separate from `videomaking_auth`). Routed separately from main `Home.tsx` modes; `PitajiLogin.tsx` and `PitajiHome.tsx` are routed as distinct pages.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/pitaji/auth` | Password login (sets `pitaji_auth` cookie) |
| POST | `/pitaji/upload` | Upload audio file (multipart) |
| POST | `/pitaji/analyze` | Analyze audio, extract speech + music segments |
| GET | `/pitaji/analyze/:jobId` | Poll analysis job |
| POST | `/pitaji/render` | Generate video from audio + analysis |
| GET | `/pitaji/render/:jobId` | Poll render progress |
| GET | `/pitaji/download/:jobId` | Download rendered video |
| GET | `/pitaji/history` | List past renders |

Auth: `PITAJI_PASSWORD` env var. Cookie `pitaji_auth` (30-day max age). Auth logic in `lib/pitaji-auth.ts`.

Frontend: `PitajiLogin.tsx` (login page), `PitajiHome.tsx` (main workspace). Sidebar components: `PitajiSidebar.tsx`, `PitajiSettings.tsx`, `PitajiHistory.tsx`, `PitajiClipDetail.tsx`, `PitajiToast.tsx`, `PitajiLiveAgent.tsx`.

Backend libs: `pitaji-{auth,store,analysis,audio-pipeline,prompts,thumbnail,url,stream-parser}.ts`.

### `/api/thumbnail/*` (`routes/thumbnail.ts`)

**Thumbnail Generator** — design YouTube thumbnails with preset templates. Stores designs in `lib/thumbnail-preset-store.ts`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/thumbnail/presets` | List preset templates |
| POST | `/thumbnail/generate` | Create thumbnail from preset + text/image |
| GET | `/thumbnail/:id` | Retrieve generated thumbnail |

Frontend: `Thumbnail.tsx` + `ThumbnailPresets.tsx` components.

### Other Routes (Utilities)

| File | Routes | Description |
|------|--------|-------------|
| `health.ts` | `GET /healthz` | Returns `{ status: "ok" }` |
| `ops.ts` | `GET /ops/metrics`, `GET /ops/alerts` | HTTP + system + queue metrics |
| `notifications.ts` | `GET /notifications/config`, `POST /subscribe`, `POST /unsubscribe` | Web Push (VAPID) setup |
| `notebook.ts` | `GET /notebook/health`, `POST /notebook/ask/stream` | NotebookLM integration (Find Video) |
| `admin.ts` | `GET /admin/overview`, `GET /admin/settings`, `POST /admin/jobs/youtube/:id/cancel`, `POST /admin/maintenance/s3-cleanup`, `POST /admin/approved-emails`, `DELETE /admin/approved-emails/:email` | Admin dashboard (requires admin role) |

---

## Frontend Structure (`artifacts/yt-downloader/src/`)

### Navigation Modes (22 modes)

Verified directly from the `Mode` union in `pages/Home.tsx` (line 64):
`"home" | "download" | "clips" | "subtitles" | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps" | "upload" | "copilot" | "translator" | "heygen" | "findvideo" | "thumbnail" | "content-manager" | "videostudio" | "help" | "activity" | "admin" | "developer" | "api-docs" | "settings"`

| Mode | Component | Description |
|------|-----------|-------------|
| `home` | `StudioHome.tsx` | Landing page with prompt input |
| `copilot` | `StudioCopilot.tsx` | AI Studio Copilot agent chat (labeled "Super Agent" in UI) |
| `download` | inline in Home | YouTube video download |
| `clips` | `BestClips.tsx` | AI Best Clips analysis |
| `subtitles` | `GetSubtitles.tsx` | Subtitle generation + AI correction |
| `clipcutter` | `ClipCutter.tsx` | Precise time-range cutting with ffmpeg trim |
| `bhagwat` | `BhagwatVideos.tsx` | Bhagwat AI video editor (devotional content timeline synthesis) |
| `scenefinder` | `KathaSceneFinder.tsx` | Find Sabha — Katha scene search via image matching (Supabase edge function) |
| `timestamps` | `Timestamps.tsx` | Chapter timestamp generation for devotional content |
| `upload` | `FileUpload.tsx` | File sharing / generic uploads |
| `translator` | `pages/VideoTranslator.tsx` | GPU video translation/dubbing (CosyVoice 3.0 + LatentSync) |
| `heygen` | `pages/HeyGenTranslator.tsx` | HeyGen-based translation/dubbing (alternative to GPU translator), see `routes/heygen.ts` |
| `findvideo` | `FindVideo.tsx` | NotebookLM-powered video semantic search |
| `thumbnail` | `Thumbnail.tsx` + `ThumbnailPresets.tsx` | Thumbnail design generator, see `routes/thumbnail.ts` |
| `content-manager` | `YouTubeContentManager.tsx` | **NEW — AI YouTube Content Strategist** — channel scraping + analytics + AI-powered content pack generation, see `/api/content-manager/*` section below |
| `videostudio` | `AiVideoStudio.tsx` | **AI Video Studio** — conversational video editor ("upload clips, describe the edit, get the video"). Backend `routes/video-editor.ts` fully wired + frontend component now active. See `/api/video-editor/*` section. |
| `help` | `HelpPanel.tsx` | Help sidebar tab |
| `activity` | `ActivityPanel.tsx` | Job activity sidebar tab |
| `admin` | `AdminPanel.tsx` | Admin panel (admin role only) |
| `developer` | `DeveloperPanel.tsx` | API key management platform, see `routes/keys.ts` |
| `api-docs` | `ApiDocumentationPage.tsx` | Public API documentation for issued API keys |
| `settings` | `SettingsPanel.tsx` | User preferences (`lib/user-preferences.ts`) |

**Pitaji is NOT in this Mode union at all** — `PitajiLogin.tsx`/`PitajiHome.tsx` are routed separately
(its own `pitaji_auth` cookie scope per `app.ts`), not switched via `Home.tsx`'s mode state like
everything else. Treat Pitaji as effectively a second mini-app bolted onto the same frontend bundle,
not just another tab.

Sidebar (`components/layout/Sidebar.tsx`) drives navigation. Desktop: 70px rail (`gs-rail`). Mobile: hamburger → slide-in drawer (`gs-drawer`).

### StudioCopilot SSE Event Types

```typescript
type SseEvent =
  | { type: "run_start"; runId: string }
  | { type: "thinking"; stage?; iteration?; total? }
  | { type: "heartbeat" }
  | { type: "text"; content: string }
  | { type: "plan"; steps: Array<{ tool; args }>; iteration? }
  | { type: "tool_start"; toolId?; name; args }
  | { type: "tool_log"; toolId?; name; message; level?: "info"|"error"|"warn" }
  | { type: "tool_progress"; toolId?; name; status?; percent?; message?; jobId? }
  | { type: "tool_done"; toolId?; name; result }
  | { type: "artifact"; artifactType; label; tab?; jobId?; downloadUrl?; imageUrl?; content? }
  | { type: "navigate"; tab: string }
  | { type: "suggestions"; items: string[] }
  | { type: "error"; message: string }
  | { type: "done" }
```

### Activity Feed

`hooks/use-activity-feed.ts` polls all job types every 4 seconds (configurable). It reads job history from localStorage (per-type: `download-history`, `subtitle-history`, `clip-history`, `best-clips-history`, `translator-history`) and syncs status with the API. 404 responses for queue-backed jobs have a 15-minute grace period before marking as missing.

### Session History

`lib/session-history.ts` persists Copilot sessions in localStorage (`vm-agent-sessions-v2`). Max 40 sessions displayed, 120 stored. Sessions have `id`, `title` (auto from first message, max 60 chars), `messages[]`, `createdAt`, `updatedAt`.

### Styling

Tailwind CSS 4. Global CSS in `src/index.css`. Custom design system:
- `gs-*` classes: Genspark-inspired UI (rail, drawer, home, input-card, agents-row, chat-header)
- `help-page-*`, `activity-page-*`: Sidebar tab page styles
- Old `studio-nav-rail` / `studio-topbar` are hidden via `display: none`

Path alias `@` → `src/` (configured in `vite.config.ts`).

---

## Shared Libraries

### `lib/api-spec/openapi.yaml`

OpenAPI 3.1 spec with 5 core endpoints (health, video info, download, progress, file stream). Source of truth — regenerate `lib/api-zod` and `lib/api-client-react` via:
```bash
cd lib/api-spec && pnpm exec orval
```

### `lib/db` (Drizzle + PostgreSQL)

Used only for the Notebook feature (conversations + messages tables). Not used for job state (that's DynamoDB).

Schema: `conversations(id, title, createdAt)` + `messages(id, conversationId, role, content, createdAt)`.

Requires `DATABASE_URL` env var. Run migrations with `drizzle-kit push` or `drizzle-kit generate`.

### `lib/integrations-gemini-ai`

Replit-specific Gemini client variant. Requires `AI_INTEGRATIONS_GEMINI_BASE_URL` and `AI_INTEGRATIONS_GEMINI_API_KEY`. Used by Bhagwat image generation as priority-1 path.

---

## Production Infrastructure

### AWS Resources (region: `us-east-1`, account: `596596146505`)

| Resource | AWS Name | Description |
|----------|----------|-------------|
| CloudFront | `EDTEON6GFBEZH` | CDN, routes to Lambda Function URL + S3 |
| Lambda | `ytgrabber-green-api` | API server (1536 MB, 900s timeout, 5 GB ephemeral storage) |
| Lambda Function URL | (auto) | `InvokeMode: RESPONSE_STREAM` — replaces API Gateway |
| Batch Job Queue | `ytgrabber-green-job-queue` | Fargate worker queue (max 6 vCPUs) |
| Batch Compute | `ytgrabber-green-compute-fargate` | Fargate compute environment |
| Batch Job Def | `ytgrabber-green-worker-job` | Fargate worker job definition (revisioned) |
| Batch GPU Queue | `ytgrabber-green-gpu-queue` | GPU Batch queue for translator |
| Batch GPU Job Def | `ytgrabber-green-translator-job` | GPU translator job (1 GPU, 15 GB RAM, 3000s timeout) |
| DynamoDB | `ytgrabber-green-jobs` | All job state (download, clip, subtitle, bhagwat, translator) |
| S3 Static | `ytgrabber-green-serverless-staticsitebucket-kxndjlgbcvgh` | Frontend files |
| S3 Output | `malikaeditorr` | Video outputs + yt-dlp cookies + Vertex credentials |
| ECR API | `ytgrabber-green-api-lambda` | Lambda container images |
| ECR Worker | `ytgrabber-green-worker` | Fargate worker images |
| ECR Translator | `ytgrabber-green-translator` | GPU translator images |
| CloudFormation | `ytgrabber-green-serverless` | Manages all of the above |

Health check: `curl https://d2bcwj2idfdwb4.cloudfront.net/api/healthz` → `{"status":"ok"}`

### CloudFormation Template (`deploy/aws-serverless/template.yml`)

Key CloudFormation design decisions:
- Lambda uses container image (not ZIP) — `Dockerfile.api-lambda` base: `public.ecr.aws/lambda/nodejs:22`
- Lambda Function URL replaces API Gateway — `AuthType: NONE`, `InvokeMode: RESPONSE_STREAM`
- CloudFront `/api*` cache behavior: `Compress: false` (SSE streams must not be gzip-buffered), `OriginReadTimeout: 60` (agent heartbeats keep alive), `OriginKeepaliveTimeout: 5`
- CloudFront SPA rewrite: inline JS function (runtime `cloudfront-js-2.0`) rewrites clean routes to `index.html`
- Lambda IAM role has DynamoDB, Batch, S3, ECR permissions scoped to named resources

### S3 Object Layout

```
malikaeditorr/
  ytgrabber-green/
    YYYY-MM-DD/          # date-partitioned download outputs
      <jobId>-<filename>.<ext>
    secrets/
      ytdlp-cookies-base64.txt    # base64 Netscape cookies for yt-dlp
      vertex/
        service-account.json      # Google Vertex AI credentials (if using Vertex)
      notebooklm/
        storage_state.json        # NotebookLM auth state
    translator-jobs/
      <jobId>/
        input.mp4                 # source video
        output.mp4                # translated video
        subtitles.srt             # translated SRT
        metadata.json             # transcript + translation data
    bhagwat/                      # Bhagwat analysis + render outputs
    uploads/                      # Generic file uploads
```

### ECR Lifecycle Policy

Both ECR repos auto-expire: keep last 3 tagged images, delete untagged after 1 day (enforced in CI).

### CloudWatch Alarms

| Alarm | Threshold |
|-------|-----------|
| `ytgrabber-green-lambda-5xx` | > 5 Lambda errors in 5 min |
| `ytgrabber-green-lambda-throttles` | > 3 throttles in 10 min |
| `ytgrabber-green-batch-failures` | > 3 Batch failures in 5 min |

No SNS email configured yet. Monitor via AWS Console.

---

## CI/CD Pipeline (`.github/workflows/deploy.yml`)

Triggered on push to `main`. Four parallel jobs:

1. **build-api** — `pnpm install` → `pnpm --filter @workspace/api-server run build` → `docker buildx build -f Dockerfile.api-lambda` → push to ECR tagged `${GITHUB_SHA::8}`

2. **build-worker** — `docker buildx build -f artifacts/queue-worker/Dockerfile` → push to ECR → `aws batch register-job-definition` (new revision with updated image)

3. **build-translator** — Only runs if `artifacts/video-translator-service/` changed (Dockerfile, requirements.txt, worker.py, runtime_deps.py, constraints.txt) OR manually triggered via `workflow_dispatch`. Image is ~20 GB — do not trigger unnecessarily. GPU container: CUDA 12.1, CosyVoice 3.0, LatentSync 1.6.

4. **deploy** — Runs `deploy/aws-serverless/deploy-serverless.ps1 -SkipImageBuild` with the built image URIs. Script: writes `/tmp/.env.green` from secrets, calls `aws cloudformation deploy`, builds + syncs frontend to S3, invalidates CloudFront.

**Image tagging rule:** Always use timestamped/commit-SHA tags. Never push `:latest` alone. CI uses `${GITHUB_SHA::8}`.

**Required GitHub Secrets:** `ENV_GREEN_CONTENT` (base production env file), `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, `WEBSITE_AUTH_PASSWORD`, `BHAGWAT_PASSWORD`, and optionally `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS_BASE64`, `NOTEBOOKLM_*`.
*(Note: AWS authentication now uses GitHub OIDC via the `ytgrabber-green-gha-deployer` IAM role. Long-lived `AWS_ACCESS_KEY_ID` secrets are no longer needed.)*

---

## Docker Images

### `Dockerfile.api-lambda` (API Lambda)

Base: `public.ecr.aws/lambda/nodejs:22`. Installs: Python 3.11, `notebooklm-py==0.3.4`, yt-dlp (binary, pinned `YTDLP_VERSION=2026.03.17`), ffmpeg-static, ffprobe-static. Entrypoint: `lambda.handler` in `dist/index.mjs`.

Key paths set in image: `YTDLP_BIN=/usr/local/bin/yt-dlp`, `FFMPEG_BIN=/opt/bin/ffmpeg`, `NOTEBOOKLM_PYTHON_BIN=python3.11`.

### `artifacts/queue-worker/Dockerfile` (Fargate Worker)

Base: `node:22-bookworm-slim`. Installs: ffmpeg, python3, git, yt-dlp (pip + curl-cffi), bgutil-ytdlp-pot-provider, pnpm 10.33.0. Copies full workspace and builds. Worker **dynamically imports api-server modules at runtime**, so the api-server must also be installed. Entrypoint: `node artifacts/queue-worker/dist/index.mjs`.

### `artifacts/video-translator-service/Dockerfile` (GPU Translator)

Base: `nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04`. Installs: PyTorch 2.3.1 CUDA 12.1, CosyVoice (git clone + submodules), LatentSync (git clone), AssemblyAI, Gemini, ffmpeg, sox. Build-time smoke tests verify imports before image completes. Optional: bake model weights at build (`DOWNLOAD_MODELS_AT_BUILD`). `PYTHONPATH` must include CosyVoice and its `third_party/Matcha-TTS`. Entrypoint: `python worker.py` (one-shot CLI, no HTTP server).

---

## Complete Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBSITE_AUTH_PASSWORD` | ✅ | — | Site login password (server throws without it) |
| `SESSION_SECRET` | ✅ | — | Cookie signing secret (do NOT rotate — invalidates all sessions) |
| `WEBSITE_AUTH_USER` | | `kalki_avatar` | Login username |
| `AUTH_COOKIE_SECURE` | | `true` | Set false for HTTP local dev |
| `GOOGLE_AUTH_ENABLED` | | `false` | Enable Google OAuth login |
| `GOOGLE_CLIENT_ID` | | — | Google OAuth client ID |
| `APPROVED_USER_EMAILS` | | — | CSV of authorized Google user emails |
| `APPROVED_ADMIN_EMAILS` | | — | CSV of authorized admin emails |
| `ADMIN_PANEL_ENABLED` | | `false` | Enable `/api/admin/*` routes |
| `BHAGWAT_PASSWORD` | ✅ (Bhagwat) | — | Password for Bhagwat AI Editor |
| `GEMINI_API_KEY` | ✅ | — | Primary Gemini API key |
| `GEMINI_API_KEY_2`..`_6` | | — | Additional keys for rate limit rotation |
| `GOOGLE_GENAI_USE_VERTEXAI` | | `false` | Use Vertex AI instead of API key |
| `GOOGLE_CLOUD_PROJECT` | ✅ (Vertex) | — | GCP project ID for Vertex |
| `GOOGLE_CLOUD_LOCATION` | | `global` | Vertex AI region |
| `GOOGLE_APPLICATION_CREDENTIALS_S3_KEY` | | — | S3 path to service account JSON |
| `AI_INTEGRATIONS_GEMINI_BASE_URL` | ✅ (Replit) | — | Replit Gemini integration URL |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | ✅ (Replit) | — | Replit Gemini integration key |
| `ASSEMBLYAI_API_KEY` | ✅ (subtitles) | — | AssemblyAI transcription key |
| `S3_BUCKET` | ✅ | — | Output S3 bucket (`malikaeditorr`) |
| `S3_REGION` | | `us-east-1` | S3 region |
| `S3_OBJECT_PREFIX` | | `ytgrabber` | S3 key prefix |
| `S3_SIGNED_URL_TTL_SEC` | | `7200` | Presigned URL TTL (2 hours) |
| `YTDLP_BIN` | | `yt-dlp` | yt-dlp binary path |
| `YTDLP_COOKIES_S3_KEY` | ✅ (prod) | — | S3 path to cookies file |
| `YTDLP_COOKIES_BASE64` | | — | Base64 Netscape cookies (local alt) |
| `YTDLP_COOKIES_FILE` | | — | Path to local cookies.txt |
| `YTDLP_PO_TOKEN` | | — | YouTube PO token |
| `YTDLP_VISITOR_DATA` | | — | YouTube visitor data |
| `YTDLP_POT_PROVIDER_URL` | | — | PO token provider URL (bgutil) |
| `YTDLP_PROXY` | | — | Proxy for yt-dlp requests |
| `YTDLP_DOWNLOAD_STALL_TIMEOUT_MS` | | `60000` | yt-dlp stall detection |
| `YTDLP_MAX_DOWNLOAD_ATTEMPTS` | | `4` | yt-dlp retry count |
| `YOUTUBE_QUEUE_PRIMARY_ENABLED` | | `false` | Enable AWS Batch queue (false = in-process) |
| `YOUTUBE_QUEUE_PRIMARY_JOB_TYPES` | | `clip-cut` | CSV of job types that use Batch |
| `YOUTUBE_QUEUE_JOB_TABLE` | ✅ (prod) | — | DynamoDB table for job state |
| `YOUTUBE_BATCH_JOB_QUEUE` | ✅ (prod) | — | Batch job queue name |
| `YOUTUBE_BATCH_JOB_DEFINITION` | ✅ (prod) | — | Batch job definition + revision (pin revision!) |
| `LAMBDA_CLIP_MAX_DURATION_SECONDS` | | `600` | Max clip-cut duration before queueing to Batch |
| `LAMBDA_CLIP_COMMAND_TIMEOUT_MS` | | `840000` | Clip-cut command timeout |
| `LAMBDA_CLIP_STALL_TIMEOUT_MS` | | `60000` | Clip-cut stall detection |
| `MAX_CONCURRENT_CLIP_JOBS` | | `3` | Parallel in-process clip jobs |
| `SUBTITLES_FORCE_LAMBDA` | | `true` | Force subtitles to run in Lambda (not Batch) — default verified `true` in source, corrected from prior `false` |
| `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS` | | `600` | Subtitle in-Lambda max duration |
| `SUBTITLES_WORKER_FUNCTION_NAME` | | — | Lambda function name for subtitle worker self-invoke |
| `TIMESTAMPS_WORKER_FUNCTION_NAME` | | — | Lambda function name for timestamps worker self-invoke |
| `TRANSLATOR_BATCH_JOB_QUEUE` | ✅ (translator) | — | GPU Batch queue |
| `TRANSLATOR_BATCH_JOB_DEFINITION` | ✅ (translator) | — | Translator Batch job definition |
| `TRANSLATOR_BATCH_TIMEOUT_SECONDS` | | `3000` | GPU job timeout (50 min) |
| `TRANSLATOR_MAX_VIDEO_SIZE_BYTES` | | `2147483648` | Max upload size (2 GB) |
| `TRANSLATOR_ALLOW_RUNTIME_MODEL_DOWNLOADS` | | `1` | Allow HF/ModelScope downloads in worker |
| `COPILOT_MODEL` | | n/a | **Dead env var** — `AGENT_MODEL` is hardcoded to `"gemini-3-flash-preview"` in `agent.ts`; this var is not read despite a misleading inline comment |
| `COPILOT_ULTRA_MODEL` | | `gemini-3.1-pro-preview` | Ultra mode model (genuinely read from env) |
| `COPILOT_SEARCH_MODEL` | | `gemini-3.5-flash` | Web search model (genuinely read from env) |
| `COPILOT_MAX_ITERATIONS` | | `49` | Max agent tool calls per turn — corrected from prior `24` |
| `COPILOT_MAX_OUTPUT_TOKENS` | | `16384` | Max agent response tokens |
| `VIDEO_EDITOR_BATCH_ENABLED` | | `false` | Route AI Video Editor renders to AWS Batch. **Required `true` in Lambda prod** or final renders hard-error |
| `EDITOR_AGENT_MODEL` | | `gemini-3.1-pro-preview` | AI Video Editor chat agent + logo-background/frame vision model |
| `EDITOR_WATCH_MODEL` | | `gemini-3-flash-preview` | Model for `watch_youtube_video` (full vision+audio watch) |
| `VIDEO_EDITOR_WORKER_FUNCTION_NAME` | | `AWS_LAMBDA_FUNCTION_NAME` | Lambda self-invoked for editor renders (fast path). Defaults to the API function itself; routed via `event.source==="videomaking.editor"` in `lambda.ts` → `runEditorRenderWorker` |
| `VIDEO_EDITOR_FARGATE_THRESHOLD_SEC` | | `600` | Renders with expected output longer than this go to Batch/Fargate instead of the worker Lambda |
| `EDITOR_AGENT_THINKING_BUDGET` | | `MEDIUM` | AI Video Editor agent thinking level |
| `INTERNAL_API_BASE` | | auto-detected | Base URL for agent's internal API calls (set by lambda-stream.ts) |
| `INTERNAL_AGENT_SECRET` | | auto-generated | Header secret for server-to-server auth bypass. Random per-process when unset (never a known default); set explicitly to share across processes |
| `NOTEBOOKLM_ENABLED` | | `false` | Enable NotebookLM / Find Video feature |
| `NOTEBOOKLM_NOTEBOOK_ID` | ✅ (notebook) | — | Target NotebookLM notebook ID |
| `NOTEBOOKLM_AUTH_S3_KEY` | | — | S3 path to NotebookLM storage_state.json |
| `NOTEBOOKLM_PYTHON_BIN` | | `python3.11` | Python binary in Lambda image |
| `NOTEBOOKLM_TURN_DELAY_MS` | | `2500` | Cooldown between requests |
| `NOTEBOOKLM_TIMEOUT_MS` | | `480000` | Per-request timeout (8 min) |
| `NOTEBOOKLM_LOCK_TTL_MS` | | `540000` | Global lock TTL (9 min) |
| `NOTEBOOKLM_LOCAL_QUEUE_LIMIT` | | `12` | Max queued requests |
| `VAPID_PUBLIC_KEY` | | — | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | | — | Web Push VAPID private key |
| `VAPID_SUBJECT` | | `mailto:ops@videomaking.in` | Web Push contact |
| `RATE_LIMIT_BYPASS_IPS` | | — | CSV IPs that skip rate limits |
| `DATABASE_URL` | ✅ (notebook DB) | — | PostgreSQL connection string for Drizzle |
| `PORT` | | `8080` | API server port |
| `NODE_ENV` | | — | `production` disables load-env.ts |
| `DISABLE_STATIC_SERVE` | | `false` | Disable serving frontend static files |
| `STATIC_DIR` | | auto-detected | Override path to built frontend files |
| `MONTHLY_BUDGET_USD` | | — | Monthly budget for admin dashboard |
| `CONTENT_PROFILE_TABLE` | | — | DynamoDB table for YouTube content profiles (falls back to `YOUTUBE_QUEUE_JOB_TABLE`) |
| `CONTENT_PROFILE_DDB_REGION` | | `us-east-1` | AWS region for content profile table (falls back to `YOUTUBE_QUEUE_REGION`) |
| `CONTENT_MANAGER_MODEL` | | `gemini-4-31b-it` | Gemini model for AI content strategy generation (uses extended thinking) |
| `CONTENT_MANAGER_SCRAPE_TIMEOUT_MS` | | `240000` | Channel scrape timeout (4 min, min 30 sec) |
| `PITAJI_PASSWORD` | | — | Login password for Pitaji audio-to-video sub-app |
| `HEYGEN_API_KEY` | | — | HeyGen API key for avatar-based video translation |
| `TAVILY_API_KEY` | | — | Tavily web search API key (optional, enables web search in content generation) |
| `GOOGLE_DRIVE_*` | | — | Google Drive integration (optional Copilot tools) |

Production secrets file: `deploy/ec2/.env.green` (gitignored). If lost:
```powershell
aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api --query "Environment.Variables" --output json
```

---

## Supabase (`supabase/`)

Supabase project ID: `edyttxzbywbpumtyixfz`.

Single edge function: `functions/identify-katha/` — Deno edge function for image matching in KathaSceneFinder. Algorithm: parallel shortlist (25 refs/batch, 4 concurrent Gemini vision calls) → final ranking of top 12 candidates. JWT verification disabled (`verify_jwt = false`).

Single migration: `supabase/migrations/20260421095726_b42fdef1-4cac-457a-a232-63dda6fa0766.sql`.

---

## TypeScript Config

`tsconfig.base.json` (all packages extend this): `module: esnext`, `moduleResolution: bundler`, `noImplicitAny: true`, `strictNullChecks: true`, `noImplicitReturns: true`, `useUnknownInCatchVariables: true`, `customConditions: ["workspace"]`.

No test runner is configured. Use `pnpm run typecheck` to verify type correctness.

---

## Key Patterns and Gotchas

**Never hand-edit generated files.** `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/` are generated from `lib/api-spec/openapi.yaml` via orval.

**Always rebuild api-server after source changes.** The `dev` script builds then starts; there is no watch mode.

**Batch job definition revisions must be pinned.** `YOUTUBE_BATCH_JOB_DEFINITION=ytgrabber-green-worker-job:20` (with revision number). Using `ytgrabber-green-worker-job` without a revision runs the latest, which may not match what's deployed.

**Lambda async context.** After `res.json()` returns, AWS Lambda freezes the container. Any `setImmediate`/`setTimeout` callbacks scheduled after the response will not run. Use worker Lambda self-invocation (`InvocationType: Event`) for work that outlives the HTTP response.

**SSE disconnect detection.** Use `res.on("close")` + `!res.writableEnded`, not `req.on("close")`. The request close event fires when the body is consumed, not when the client disconnects.

**Cookie security.** `SESSION_SECRET` signs all cookies. Do not rotate it in production — it invalidates all active sessions. The YouTube cookies in S3 are the most sensitive credential — they grant access to the YouTube account.

**S3 output files.** YouTube downloads/clips auto-delete after **7 days** (`AUTO_DELETE_MS` in `youtube.ts`, verified against source — earlier versions of this doc said 2 hours, which was wrong). Bhagwat render files are deleted 60 min after first download, with a 12h sweep for anything orphaned. Subtitles/translator namespaces use a separate 7-day S3 cleanup sweep. If a user needs longer retention, `S3_SIGNED_URL_TTL_SEC` extends the download *link*, not the file's actual lifetime — these are independent.

**Translator image size.** The GPU translator Dockerfile produces a ~20 GB image (PyTorch + CosyVoice + LatentSync + models). CI skips rebuilding it unless the relevant files change. To force a rebuild, use `workflow_dispatch` with `rebuild_translator: "true"`.

**pnpm workspace `catalog:` entries.** Package versions in `pnpm-workspace.yaml` under `catalog:` provide shared version pinning across packages. Use `catalog:` in `package.json` dependencies to reference catalog entries.

---

## Documentation Refresh Log

**2026-07-03 Comprehensive Audit:**
- ✅ **Content Manager** — fully documented (`/api/content-manager/*` section + env vars)
- ✅ **AI Video Studio** — fixed status: frontend component `AiVideoStudio.tsx` IS wired (was previously marked missing)
- ✅ **Pitaji** — documented independent auth flow, routes, backend libs, frontend pages
- ✅ **HeyGen Translator** — documented as alternative to GPU translator
- ✅ **Workspace** — documented file management routes for editor projects
- ✅ **Developer/API Keys** — documented full API key + webhook + idempotency system
- ✅ **Thumbnail** — documented thumbnail generation routes
- ✅ **Navigation Modes** — updated count from 21 to 22, added content-manager mode
- ✅ **Environment Variables** — added missing Pitaji, HeyGen, Content Manager, Tavily vars
- ⚠️ **Still undocumented** — Google Drive integration, Skills system, v1.ts, GCS storage (existence confirmed, behavior not yet described)

## Deep-Dive Reference (Claude memory, not checked into git)

This file covers architecture and routes at a glance. For line-level implementation detail (exact
timeouts, retry counts, prompt rules, restart-resilience mechanisms) on a specific feature, Claude's
persistent memory has six deep-dive notes — read the relevant one before making non-trivial changes
to that area, since these capture gotchas this file intentionally omits for brevity:
- Download / Clip Cut / Best Clips
- Subtitles / Timestamps
- Bhagwat AI Video Editor / Katha Scene Finder
- Studio Copilot agent / Uploads / NotebookLM / Admin
- Auth middleware / Lambda streaming bridge / Gemini client / CI-CD internals
- AI Video Editor / AI Video Studio (timeline agent, FFmpeg render, Batch-required-for-final gotcha)

These were last verified 2026-06-25 against the source in this repo at that commit — re-verify
specific claims (especially line numbers) if the relevant file has changed since.

**Last updated:** 2026-07-03 (comprehensive feature backfill + status corrections)
