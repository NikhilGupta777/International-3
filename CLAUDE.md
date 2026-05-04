# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**VideoMaking Studio** — private single-user media workspace at `videomaking.in`. Processes YouTube content through six core features: Download, Clip Cut, Best Clips (AI), Subtitles (AI), Timestamps (AI), Bhagwat AI Video Editor, Video Translator (GPU dubbing), and Find Video (NotebookLM). Hosted on AWS serverless infrastructure (Lambda + Batch/Fargate + S3 + CloudFront).

---

## Monorepo Structure

pnpm workspace. **Must use `pnpm` — `npm`/`yarn` are blocked by a `preinstall` hook in root `package.json`.**

```
artifacts/
  yt-downloader/          # React 19 + Vite frontend (served as SPA)
  api-server/             # Express.js API — deployed as AWS Lambda container
  queue-worker/           # Fargate worker (download/clip/subtitles/best-clips)
  video-translator-service/ # Python GPU Batch worker (CosyVoice 3.0 + LatentSync)
  mockup-sandbox/         # UI component prototyping sandbox (not deployed)
  video-translation-src/  # Git submodule: github.com/NikhilGupta777/video-translation
lib/
  api-spec/               # OpenAPI 3.1 YAML — source of truth for API contracts
  api-zod/                # Generated Zod schemas (do not hand-edit src/generated/)
  api-client-react/       # Generated React Query hooks (do not hand-edit src/generated/)
  db/                     # Drizzle ORM + PostgreSQL schema (conversations + messages)
  integrations-gemini-ai/ # Gemini AI client wrapper (Replit integration variant)
deploy/
  aws-serverless/         # CloudFormation template + PowerShell deploy scripts
  aws-queue/              # Worker image build + Batch resource scripts
  ec2/                    # Production env file location (.env.green — gitignored)
scripts/                  # Workspace tooling scripts (enforce-pnpm, patch scripts)
supabase/
  functions/identify-katha/ # Deno edge function for image matching (KathaSceneFinder)
  migrations/             # Supabase SQL migrations
```

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

**Why Lambda Function URL instead of API Gateway:** API Gateway buffers the entire Lambda response and enforces a hard 30 s timeout — this kills SSE streaming. The Lambda Function URL with `InvokeMode: RESPONSE_STREAM` streams chunks as they are written. `artifacts/api-server/src/lib/lambda-stream.ts` implements the Express↔Lambda streaming bridge: it spins up a `http.createServer(app)` bound to `127.0.0.1:0` on cold start, then per invocation translates the Function URL event into a real `http.request()` and pipes response chunks straight into `awslambda.HttpResponseStream`. **CloudFront `/api*` behavior must have `Compress: false`** — gzip would re-buffer the entire stream.

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
- Protected: all `/api/*` except `/api/healthz`, `/api/auth/*`, public share URLs (`/uploads/file/*`, `/translator/share/*`)
- Internal server-to-server calls bypass cookie auth via `X-Internal-Agent: <INTERNAL_AGENT_SECRET>` header
- `AUTH_USER` default: `"kalki_avatar"` (override with `WEBSITE_AUTH_USER`)
- `ADMIN_PANEL_ENABLED` env flag gates `/api/admin/*` to admin-role sessions only

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

`isGeminiConfigured()` returns false if no key/credentials — AI features degrade gracefully.

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

Metadata cached 5 minutes per video ID; CDN stream URLs cached 25 minutes. Rate limiters on download and clips endpoints. Clips/downloads auto-delete from S3 after 2 hours.

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

Two-pass approach: AssemblyAI (audio transcription) → Gemini (text cleanup + translation). Key env vars: `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY` (+ `_2` through `_10` for rotation), `SUBTITLES_FORCE_LAMBDA`, `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS`, `SUBTITLES_WORKER_FUNCTION_NAME`.

### `/api/youtube/timestamps*` (`routes/timestamps.ts`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/youtube/timestamps` | Start chapter timestamp generation |
| GET | `/youtube/timestamps/stream/:jobId` | SSE progress + results stream |
| GET | `/youtube/timestamps/status/:jobId` | Poll job status |

Uses Gemini 2.5 Pro with a domain-specific system prompt for Bhagwat Katha (devotional discourse) chapter generation. Requires "EVERY distinct topic" — no merging, no max count. Entry 0 must start at 0; labels in video's original language. Worker invoked via self-invoke Lambda (`TIMESTAMPS_WORKER_FUNCTION_NAME`). Transcript capped at 120K chars for token limits.

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

Image generation priority: Replit Gemini integration (`gemini-2.5-flash-image`) → personal `GEMINI_API_KEY` (`gemini-3.1-flash-image-preview`) → colored scene card fallback.

Security guards in bhagwat.ts: `pickSafeBhagwatId` (regex `[A-Za-z0-9_-]{1,128}`) for path traversal prevention; `safeFsArg` prepends `./` when a path starts with `-` to prevent CLI flag injection.

In-memory state auto-cleanup: temp files deleted after 2 hours, cleanup runs every 30 minutes. `renderJobs` and `analysisJobs` Maps are wiped on Lambda restart — restart-resilience is handled by `persistRenderMetaStart` / `persistAnalysisMetaStart` writing S3 meta markers at start, then `hydrateInterruptedAnalysis` reading them on boot.

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

Single PUT for < 50 MB; 10 MB multipart parts for >= 50 MB. 7-day DynamoDB TTL. `UPLOADS_TABLE` env var required for persistence; falls back to in-memory for dev.

### `/api/agent/chat` (`routes/agent.ts`)

`POST /api/agent/chat` — SSE stream. The AI Studio Copilot agent.

**32 tools** organized by parallel execution group:
- **light** (≤3 concurrent): `get_video_info`, `get_youtube_captions`, `web_search`, `read_web_page`, `check_job_status`, `check_active_jobs`, `repeat_last_artifact`, `read_uploaded_file`, `describe_image`, `extract_text_from_image`, `write_video_script`, `generate_seo_pack`
- **youtube_processing** (≤3 concurrent): `cut_video_clip`, `download_video`, `generate_subtitles`, `find_best_clips`, `generate_timestamps`
- **serial**: all others (image gen, translate_video, navigate_to_tab, etc.)

SSE event stream: `run_start` → `text` / `tool_start` / `tool_progress` / `tool_log` / `tool_done` / `artifact` / `navigate` → `done`. Heartbeat every 8 seconds to keep connection alive.

Models: `COPILOT_MODEL` (default `gemini-3-flash-preview`), ultra mode → `gemini-2.5-pro`, search → `gemini-2.5-flash`. Max iterations: 24 (`COPILOT_MAX_ITERATIONS`). Max output tokens: 16,384.

Internal tool calls go to `process.env.INTERNAL_API_BASE/api` (set by `lambda-stream.ts` in production) to hit the same Express instance without a network round-trip.

### Other Routes

| File | Routes | Description |
|------|--------|-------------|
| `health.ts` | `GET /healthz` | Returns `{ status: "ok" }` |
| `ops.ts` | `GET /ops/metrics`, `GET /ops/alerts` | HTTP + system + queue metrics |
| `notifications.ts` | `GET /notifications/config`, `POST /subscribe`, `POST /unsubscribe` | Web Push (VAPID) setup |
| `notebook.ts` | `GET /notebook/health`, `POST /notebook/ask/stream` | NotebookLM integration (Find Video) |
| `admin.ts` | `GET /admin/overview`, `GET /admin/settings`, `POST /admin/jobs/youtube/:id/cancel`, `POST /admin/maintenance/s3-cleanup`, `POST /admin/approved-emails`, `DELETE /admin/approved-emails/:email` | Admin dashboard (requires admin role) |

---

## Frontend Structure (`artifacts/yt-downloader/src/`)

### Navigation Modes (14)

Defined as `Mode` union in `pages/Home.tsx`:

| Mode | Component | Description |
|------|-----------|-------------|
| `home` | `StudioHome.tsx` | Landing page with prompt input |
| `copilot` | `StudioCopilot.tsx` | AI Studio Agent chat |
| `download` | inline in Home | YouTube video download |
| `clips` | `BestClips.tsx` | AI Best Clips analysis |
| `subtitles` | `GetSubtitles.tsx` | Subtitle generation |
| `clipcutter` | `ClipCutter.tsx` | Precise time-range cutting |
| `bhagwat` | `BhagwatVideos.tsx` | Bhagwat AI video editor |
| `scenefinder` | `KathaSceneFinder.tsx` | Find Sabha / Katha scene search |
| `timestamps` | `Timestamps.tsx` | Chapter timestamp generation |
| `upload` | `FileUpload.tsx` | File sharing |
| `translator` | `VideoTranslator.tsx` | Video translation/dubbing |
| `findvideo` | `FindVideo.tsx` | NotebookLM-powered video search |
| `help` | `HelpPanel.tsx` | Help sidebar tab |
| `activity` | `ActivityPanel.tsx` | Job activity sidebar tab |
| `admin` | `AdminPanel.tsx` | Admin panel (admin role only) |

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

**Required GitHub Secrets:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ENV_GREEN_CONTENT` (base production env file), `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, `WEBSITE_AUTH_PASSWORD`, `BHAGWAT_PASSWORD`, and optionally `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS_BASE64`, `NOTEBOOKLM_*`.

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
| `SUBTITLES_FORCE_LAMBDA` | | `false` | Force subtitles to run in Lambda (not Batch) |
| `SUBTITLES_LAMBDA_MAX_DURATION_SECONDS` | | `600` | Subtitle in-Lambda max duration |
| `SUBTITLES_WORKER_FUNCTION_NAME` | | — | Lambda function name for subtitle worker self-invoke |
| `TIMESTAMPS_WORKER_FUNCTION_NAME` | | — | Lambda function name for timestamps worker self-invoke |
| `TRANSLATOR_BATCH_JOB_QUEUE` | ✅ (translator) | — | GPU Batch queue |
| `TRANSLATOR_BATCH_JOB_DEFINITION` | ✅ (translator) | — | Translator Batch job definition |
| `TRANSLATOR_BATCH_TIMEOUT_SECONDS` | | `3000` | GPU job timeout (50 min) |
| `TRANSLATOR_MAX_VIDEO_SIZE_BYTES` | | `2147483648` | Max upload size (2 GB) |
| `TRANSLATOR_ALLOW_RUNTIME_MODEL_DOWNLOADS` | | `1` | Allow HF/ModelScope downloads in worker |
| `COPILOT_MODEL` | | `gemini-3-flash-preview` | Default agent model |
| `COPILOT_ULTRA_MODEL` | | `gemini-2.5-pro` | Ultra mode model |
| `COPILOT_SEARCH_MODEL` | | `gemini-2.5-flash` | Web search model |
| `COPILOT_MAX_ITERATIONS` | | `24` | Max agent tool calls per turn |
| `COPILOT_MAX_OUTPUT_TOKENS` | | `16384` | Max agent response tokens |
| `INTERNAL_API_BASE` | | auto-detected | Base URL for agent's internal API calls (set by lambda-stream.ts) |
| `INTERNAL_AGENT_SECRET` | | `internal-agent-bypass-key` | Header secret for server-to-server auth bypass |
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

**S3 output files.** Auto-deleted after 2 hours via cleanup logic in `youtube.ts` and `bhagwat.ts`. If a user needs longer retention, `S3_SIGNED_URL_TTL_SEC` extends the download link, not the file lifetime.

**Translator image size.** The GPU translator Dockerfile produces a ~20 GB image (PyTorch + CosyVoice + LatentSync + models). CI skips rebuilding it unless the relevant files change. To force a rebuild, use `workflow_dispatch` with `rebuild_translator: "true"`.

**pnpm workspace `catalog:` entries.** Package versions in `pnpm-workspace.yaml` under `catalog:` provide shared version pinning across packages. Use `catalog:` in `package.json` dependencies to reference catalog entries.
