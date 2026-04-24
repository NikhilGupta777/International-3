# VideoMaking Studio

A private media workspace and automation toolset for processing YouTube content.

## Project Overview
 
Processes YouTube content through four core flows:
1. **Download** - High-quality YouTube video downloads to S3
2. **Clip Cut** - Precise trimming of videos based on timestamps
3. **Best Clips** - AI-powered analysis (via Gemini) to find engaging segments
4. **Subtitles** - AI transcription (via AssemblyAI) to generate `.srt` files

## Architecture

Originally designed for AWS serverless deployment (Lambda + Batch/Fargate + S3 + CloudFront), running as a React frontend in development on Replit.

## Tech Stack

- **Frontend**: React 19, Vite, TypeScript, Tailwind CSS 4, Radix UI, Framer Motion
- **Backend**: Node.js, Express.js (AWS Lambda via serverless-http), TypeScript
- **Database**: DynamoDB with Drizzle ORM
- **AI/Processing**: Google Gemini AI, AssemblyAI, yt-dlp, ffmpeg
- **Infrastructure**: AWS Lambda, AWS Batch/Fargate, S3, CloudFront, API Gateway

## Monorepo Structure

PNPM workspace monorepo:

- `artifacts/yt-downloader/` - React frontend (Vite)
- `artifacts/api-server/` - Express.js API server (AWS Lambda)
- `artifacts/queue-worker/` - Fargate video processing worker
- `artifacts/mockup-sandbox/` - UI component sandbox
- `lib/api-spec/` - OpenAPI definitions
- `lib/api-zod/` - Shared Zod schemas
- `lib/api-client-react/` - Generated React hooks
- `lib/db/` - DynamoDB schema (Drizzle)
- `lib/integrations-gemini-ai/` - Gemini AI client
- `deploy/` - AWS IaC (CloudFormation) and deployment scripts

## Development

### Frontend
Runs on port 5000 via the "Start application" workflow:
```
PORT=5000 pnpm --filter @workspace/yt-downloader run dev
```

### Backend proxy
The Vite dev server proxies `/api` requests to `localhost:8080` (configurable via `API_PORT` env var).

## Deployment

Configured as a static site deployment:
- Build: `pnpm --filter @workspace/yt-downloader run build`
- Output: `artifacts/yt-downloader/dist/public`

## Bhagwat AI Editor — Render Resilience (Apr 2026)

Render jobs use an in-memory `renderJobs` Map that is wiped when the API server restarts. To stop "Connection error during render" misreports:

- Backend writes a `status:"running"` meta JSON the moment a render starts (`persistRenderMetaStart`). On hydration, if meta says `running` but no mp4 exists, the job is hydrated as `error` with message "Render was interrupted by a server restart — please start a new render."
- Render history list filters out `running` markers and entries where the mp4 is gone.
- Render-error catch path deletes the meta marker so real failures aren't later misreported as restart-interrupted.
- Cleanup window (`RENDER_DELETE_MS`) raised from 10 → 60 minutes after first download.
- Frontend `tryResolveRenderJob` treats HTTP 404 from `/render-state` as terminal: clears pending state, stops SSE reconnect, shows actionable message.

## Bhagwat Tab — End-to-End Hardening (Apr 2026)

Production-blocker plus follow-up correctness/robustness fixes:

- **S3 cookie loading**: `bhagwat.ts` now lazily fetches yt-dlp browser cookies from `s3://$S3_BUCKET/$YTDLP_COOKIES_S3_KEY` (JSON browser-export format), converts to Netscape, and caches on disk. Wired into `runYtDlp` and `runYtDlpForSubs` (in-flight dedup + on-disk cache). Mirrors the `youtube.ts` pattern. Required env: `S3_BUCKET`, `S3_REGION`, `YTDLP_COOKIES_S3_KEY`. Without it, AWS Lambda yt-dlp calls fail bot-detection.
- **Local env parity**: New `artifacts/api-server/src/lib/load-env.ts` is the very first import in `src/index.ts` (side-effect ESM import) and loads the repo-root `.env` into `process.env` before any other module reads env. `artifact.toml` carries the same values for the dev workflow.
- **Path-traversal guard**: `pickSafeBhagwatId` (regex `[A-Za-z0-9_-]{1,128}`) replaces `pickFirst` at all 8 `req.params.{jobId,audioId}` sites — bad ids return 400 before touching disk.
- **CLI-flag injection guard**: `safeFsArg` prepends `./` when a path arg starts with `-`, applied at every ffmpeg/ffprobe `-i` call site that takes a user-influenced path (audioFile, audio.path, clip image paths, concat list).
- **Analyze restart-resilience**: parallels render — start marker via `persistAnalysisMetaStart`, cleanup via `clearAnalysisMeta`, boot-time sweep + `hydrateInterruptedAnalysis` (called from analyze-status SSE handler).
- **Background-task error visibility**: replaced silent `.catch(()=>{})` on `runBhagwatAnalysis`, `runBhagwatRender`, `runBhagwatReview`, and the upload-render path with `req.log.error`. Best-effort subtitle fetches stay silent (immediate fallback in code).
- **Frontend SSE hardening**: `safeParseSseJson<T>()` wraps every SSE `JSON.parse` (15 sites) in `BhagwatVideos.tsx`. Review SSE now stored in `esRef.current` with prior-close so Stop terminates review streams too.
