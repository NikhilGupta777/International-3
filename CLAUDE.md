# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**VideoMaking Studio** (`videomaking.in`) — a private single-user media workspace for processing YouTube content. Core features: Download, Clip Cut, Best Clips (Gemini AI), Subtitles (AssemblyAI), Timestamps, Bhagwat Video Editor, and Video Translator (GPU dubbing pipeline).

## Monorepo Structure

pnpm workspace. **Must use `pnpm`** — `npm`/`yarn` are blocked by a `preinstall` hook.

```
artifacts/
  yt-downloader/          # React 19 + Vite frontend
  api-server/             # Express.js API → deployed as AWS Lambda
  queue-worker/           # Fargate worker (yt-dlp, ffmpeg, AssemblyAI)
  video-translator-service/ # Python GPU Batch worker (CosyVoice, LatentSync)
lib/
  api-spec/               # OpenAPI YAML (source of truth)
  api-zod/                # Generated Zod schemas (from OpenAPI via orval)
  api-client-react/       # Generated React query hooks (from OpenAPI via orval)
  db/                     # Drizzle ORM schema (PostgreSQL — conversations/messages only)
  integrations-gemini-ai/ # Gemini AI client wrapper
deploy/
  aws-serverless/         # CloudFormation template + deploy scripts (PowerShell)
  aws-queue/              # Worker image build + Batch scripts
```

## Development Commands

```bash
pnpm install                                           # install all workspace deps

# Frontend (port 5000)
PORT=5000 pnpm --filter @workspace/yt-downloader run dev

# API server (port 8080) — builds first, then starts
pnpm --filter @workspace/api-server run dev

# Build
pnpm --filter @workspace/api-server run build         # required before any API testing
pnpm --filter @workspace/yt-downloader run build

# Typecheck (all packages)
pnpm run typecheck

# Typecheck single package
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/yt-downloader run typecheck
```

The Vite dev server proxies `/api` → `localhost:8080` (override with `API_PORT` env var).

**Critical:** The `api-server` `dev` script **builds then starts** (no hot-reload). After editing any `artifacts/api-server/src/` file you must rebuild: `pnpm --filter @workspace/api-server run build`, then restart.

## Local Environment Setup

Copy `.env.example` → `.env` and set at minimum:

```
WEBSITE_AUTH_PASSWORD=<any>     # required — server won't start without it
SESSION_SECRET=<any>            # required — server won't start without it
YOUTUBE_QUEUE_PRIMARY_ENABLED=false  # skip AWS Batch; run jobs in-process locally
GEMINI_API_KEY=<key>            # for Best Clips / Timestamps / Bhagwat features
```

`load-env.ts` is the **first import** in `src/index.ts` (side-effect ESM import) and loads `.env` from the repo root before any other module reads `process.env`.

## Architecture

### Request flow (production)

```
Browser → CloudFront → Lambda Function URL (RESPONSE_STREAM)
                           └── lambda-stream.ts internal http server → Express app
                           └── async worker events (timestamps / subtitles)
```

The API **does not use API Gateway**. It uses a Lambda Function URL with `InvokeMode: RESPONSE_STREAM`. `artifacts/api-server/src/lib/lambda-stream.ts` spins up a localhost-only `http.createServer(app)` on cold start, then per invocation translates the Function URL event into a real HTTP request and pipes response bytes into `awslambda.HttpResponseStream`. This is the only way to get real SSE streaming through Lambda.

### Job lifecycle

All heavy jobs (download, clip-cut, best-clips, subtitles, bhagwat-analyze/render) go through `lib/youtube-queue.ts`:

1. API creates a DynamoDB record with `status: "queued"`
2. `YOUTUBE_QUEUE_PRIMARY_ENABLED=true` → submits to AWS Batch (Fargate); `false` → runs in-process (local dev)
3. `artifacts/queue-worker/src/index.ts` runs the job and writes status updates to DynamoDB
4. Frontend polls `/api/youtube/progress/:jobId` (or uses SSE where available)

Job status progression: `queued → running → done | error`

**Timestamps and Subtitles** use a different pattern: the API Lambda self-invokes another Lambda with `InvocationType: Event` (async) so the heavy work runs in a separate 15-minute Lambda, not the Fargate worker.

### Auth

Session is a signed cookie (`videomaking_auth`). The cookie value is either `"1"` (legacy password login) or a base64url-encoded JSON object `{ method, role, email, name, picture }`. Auth middleware in `app.ts` protects all `/api/*` routes except `/api/healthz`, `/api/auth/*`, and public share URLs.

The Bhagwat feature has a **separate auth cookie** (`bhagwat_auth`) requiring `BHAGWAT_PASSWORD`.

### YouTube cookies (bot-detection bypass)

In production, yt-dlp cookies are stored as a base64-encoded Netscape text file at `s3://malikaeditorr/ytgrabber-green/secrets/ytdlp-cookies-base64.txt`. Both `youtube.ts` and `bhagwat.ts` lazily fetch and cache this file on first use. If downloads start failing with bot-detection errors, the cookies need to be refreshed (see `GUIDE.md` Section 10).

### Frontend routing

Single-page app using `wouter`. All modes (`download`, `clips`, `subtitles`, `clipcutter`, `bhagwat`, `scenefinder`, `timestamps`, `upload`, `copilot`, `translator`, `findvideo`, `help`, `activity`, `admin`) are managed by the `Mode` union in `artifacts/yt-downloader/src/pages/Home.tsx`. The Sidebar drives navigation via the `mode` state.

### Studio Agent (Copilot)

`POST /api/agent/chat` is an SSE endpoint backed by Gemini. The agent issues tool calls (cut_video_clip, download_video, get_video_info, generate_subtitles, find_best_clips, etc.) which are executed server-side by making internal HTTP calls to other `/api/*` routes. SSE events: `text | tool_start | tool_progress | tool_done | artifact | navigate | error | done`.

Model defaults: `COPILOT_MODEL` (default `gemini-3-flash-preview`), `COPILOT_ULTRA_MODEL` (`gemini-2.5-pro`). Use `res.on("close")` (not `req.on("close")`) to detect client disconnect in SSE handlers — `req` close fires when the request body is consumed, not when the connection drops.

### Shared lib conventions

- `lib/api-zod` and `lib/api-client-react` contain **generated** files (`src/generated/`). Do not hand-edit them. The source of truth is `lib/api-spec/openapi.yaml`; regenerate via orval (`lib/api-spec/orval.config.ts`).
- `lib/db` uses Drizzle ORM with PostgreSQL — currently only for `conversations` and `messages` tables (notebook feature). Job state lives in DynamoDB, managed entirely by `lib/youtube-queue.ts`.

## CI / Deployment

Push to `main` triggers `.github/workflows/deploy.yml`:

1. **build-api** — builds TypeScript, builds Docker image (`Dockerfile.api-lambda`), pushes to ECR tagged with `${GITHUB_SHA::8}`
2. **build-worker** — builds Fargate worker Docker image, pushes to ECR, registers new Batch job definition revision
3. **build-translator** — only runs when `artifacts/video-translator-service/` changes or manually triggered (image is ~20 GB)
4. **deploy** — runs `deploy/aws-serverless/deploy-serverless.ps1` (PowerShell) which deploys CloudFormation, syncs frontend to S3, invalidates CloudFront

**Always use timestamped image tags** — never push `:latest` alone. The CI uses git SHA; manual deploys use `Get-Date -Format "yyyyMMdd-HHmmss"`.

AWS resources (region `us-east-1`, account `596596146505`):
- Lambda: `ytgrabber-green-api`
- Batch queue: `ytgrabber-green-job-queue`
- DynamoDB: `ytgrabber-green-jobs`
- S3 output: `malikaeditorr`
- CloudFront: `d2bcwj2idfdwb4.cloudfront.net` → `videomaking.in`
- CloudFormation stack: `ytgrabber-green-serverless`

Production secrets live in `deploy/ec2/.env.green` (gitignored). If lost, recover with:
```bash
aws lambda get-function-configuration --region us-east-1 --function-name ytgrabber-green-api --query "Environment.Variables" --output json
```

## TypeScript Config

`tsconfig.base.json` applies to all packages: `"module": "esnext"`, `"moduleResolution": "bundler"`, `"noImplicitAny": true`, `"strictNullChecks": true`. Packages extend this base. The workspace uses `"customConditions": ["workspace"]` for package resolution.

No test runner is configured — use `pnpm run typecheck` to verify correctness.
