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

## Studio Agent (AI Copilot) — Streaming Fix (Apr 2026)

The Studio Agent SSE route (`POST /api/agent/chat`) had two issues that made it
appear to hang:

1. **`req.on("close")` fired prematurely.** In Node 20 / Express 5, the request
   "close" event fires when the request body is fully consumed, which on a
   normal POST happens in milliseconds. The route used that signal to set
   `clientConnected = false`, so the streaming loop bailed after the very first
   chunk. Fixed by using `res.on("close")` plus `!res.writableEnded` instead.
2. **Default model was `gemini-3-flash-preview`** which can take 20+ seconds on
   cold start. Default switched to `gemini-2.5-flash` (override via
   `COPILOT_MODEL` env var). Cold response is now under 1 second.

After editing `artifacts/api-server/src/routes/agent.ts` always rebuild
(`pnpm --filter @workspace/api-server run build`) and restart the **API
Server** workflow — `start` runs the bundled `dist/index.mjs`, not the source.

## Bhagwat AI Editor — Render Resilience (Apr 2026)

Render jobs use an in-memory `renderJobs` Map that is wiped when the API server restarts. To stop "Connection error during render" misreports:

- Backend writes a `status:"running"` meta JSON the moment a render starts (`persistRenderMetaStart`). On hydration, if meta says `running` but no mp4 exists, the job is hydrated as `error` with message "Render was interrupted by a server restart — please start a new render."
- Render history list filters out `running` markers and entries where the mp4 is gone.
- Render-error catch path deletes the meta marker so real failures aren't later misreported as restart-interrupted.
- Cleanup window (`RENDER_DELETE_MS`) raised from 10 → 60 minutes after first download.
- Frontend `tryResolveRenderJob` treats HTTP 404 from `/render-state` as terminal: clears pending state, stops SSE reconnect, shows actionable message.

## Timestamps Tab — Lambda Pipeline Fix (Apr 2026)

**Bug:** In production every Timestamps job was stuck at `progressPct: 5` /
`"Fetching video info…"`. Root cause: the API Lambda's `setImmediate` block
ran `runYtDlpMetadata` + `fetchTranscript` before invoking the worker Lambda
for Gemini. AWS Lambda freezes the request container the moment the response
is returned to API Gateway, so any async work scheduled via `setImmediate`
after `res.json` is suspended and effectively never finishes.

**Fix (`artifacts/api-server/src/routes/timestamps.ts` + `lambda.ts`):**

- POST `/api/youtube/timestamps` now writes the initial DDB record and
  immediately invokes the worker Lambda with `{ url, instructions }` only.
  No more `setImmediate` for the heavy lifting.
- `runTimestampWorker` now accepts a `url`-only payload and runs the full
  pipeline (yt-dlp metadata → transcript fetch → Gemini) inside the worker
  Lambda, which has its own 15-minute runtime. Legacy
  `{ videoTitle, transcript }` payloads are still accepted so any in-flight
  jobs from the prior deploy still complete.
- `lambda.ts` accepts both payload shapes and dispatches accordingly.
- The local Express ("inline") path is unchanged — `runTimestampAnalysis`
  still does everything in-process for dev.

Required prod env (already set): `TIMESTAMPS_WORKER_FUNCTION_NAME=ytgrabber-green-api`
(self-invoke), IAM `lambda:InvokeFunction` policy, `GEMINI_API_KEY`,
`YOUTUBE_QUEUE_JOB_TABLE`, `YTDLP_COOKIES_S3_KEY`.

## Bhagwat Tab — End-to-End Hardening (Apr 2026)

Production-blocker plus follow-up correctness/robustness fixes:

- **S3 cookie loading**: `bhagwat.ts` now lazily fetches yt-dlp browser cookies from `s3://$S3_BUCKET/$YTDLP_COOKIES_S3_KEY` (JSON browser-export format), converts to Netscape, and caches on disk. Wired into `runYtDlp` and `runYtDlpForSubs` (in-flight dedup + on-disk cache). Mirrors the `youtube.ts` pattern. Required env: `S3_BUCKET`, `S3_REGION`, `YTDLP_COOKIES_S3_KEY`. Without it, AWS Lambda yt-dlp calls fail bot-detection.
- **Local env parity**: New `artifacts/api-server/src/lib/load-env.ts` is the very first import in `src/index.ts` (side-effect ESM import) and loads the repo-root `.env` into `process.env` before any other module reads env. `artifact.toml` carries the same values for the dev workflow.
- **Path-traversal guard**: `pickSafeBhagwatId` (regex `[A-Za-z0-9_-]{1,128}`) replaces `pickFirst` at all 8 `req.params.{jobId,audioId}` sites — bad ids return 400 before touching disk.
- **CLI-flag injection guard**: `safeFsArg` prepends `./` when a path arg starts with `-`, applied at every ffmpeg/ffprobe `-i` call site that takes a user-influenced path (audioFile, audio.path, clip image paths, concat list).
- **Analyze restart-resilience**: parallels render — start marker via `persistAnalysisMetaStart`, cleanup via `clearAnalysisMeta`, boot-time sweep + `hydrateInterruptedAnalysis` (called from analyze-status SSE handler).
- **Background-task error visibility**: replaced silent `.catch(()=>{})` on `runBhagwatAnalysis`, `runBhagwatRender`, `runBhagwatReview`, and the upload-render path with `req.log.error`. Best-effort subtitle fetches stay silent (immediate fallback in code).
- **Frontend SSE hardening**: `safeParseSseJson<T>()` wraps every SSE `JSON.parse` (15 sites) in `BhagwatVideos.tsx`. Review SSE now stored in `esRef.current` with prior-close so Stop terminates review streams too.

## Genspark-style UI Redesign (Apr 2026)

The yt-downloader frontend was redesigned to mirror Genspark AI's look:

- **Sidebar (`components/layout/Sidebar.tsx`)**: vertical "gs-rail" 70px wide, app tile, "+ New" pinned, "Super Agent" pinned with sparkle accent, NAV_ITEMS as icon+label-below tiles, divider, decorative footer items (Workflows/Teams/Drive/More), bottom avatar. Mobile drawer = `gs-drawer`. New `onNewChat` prop sent from `Home.tsx`.
- **Home / landing screen (`components/StudioHome.tsx`)**: centered "VideoMaking Studio Workspace 4.0" title with cyan dot, big "Ask anything, create anything" `gs-input-card` (Plus / Paperclip / Ultra pill / Mic / Speak), and a `gs-agents-row` of colored circular agent tiles (Best Clips, Clip Cut, Subtitles, Translator, Timestamps, Download, Find Sabha, Bhagwat, Share, Super Agent, All Agents). Submitting routes the prompt into Studio Agent via `pendingCopilotPrompt`.
- **Studio Agent / Copilot (`components/StudioCopilot.tsx`)**: new `gs-chat-header` (back arrow, hamburger, centered editable session title with pencil, Share / SquarePen-new-chat / MoreHorizontal), `gs-welcome` empty state with starter cards, "Thinking…" with cursor block + cyan pulse dot, `gs-input-wrap` with mode tabs ("Super Agent" active / "AI works for you 75% off"), URL paste pill, and `gs-input-card` matching the home input. Receives `pendingPrompt`, `onPromptConsumed`, `onBackToHome`, and `key={copilotResetKey}` from Home for new-chat resets.
- **Page state (`pages/Home.tsx`)**: Mode union now includes `"home"` and is the default; Sidebar's `onNewChat` increments `copilotResetKey` and routes back to "home". Home renders `<StudioHome>` for the new mode and keeps all existing modes intact.
- **Styles**: ~770 lines of `gs-*` classes appended to `src/index.css` (rail, drawer, home, input card, agents row, chat header, welcome, thinking indicator, mode tabs, paste pill, send/stop). Old `studio-nav-rail` and `studio-topbar` are hidden via `display:none`. Backend, SSE streaming, and default Gemini model (`gemini-2.5-flash`) were not touched.

## Mobile UI Fixes + Help/Activity Sidebar Tabs (Apr 2026)

Mobile drawer + chat-header crowding cleanup, plus a refactor of Help and Activity from a floating top-right panel into proper sidebar tabs:

- **Help is now a sidebar tab** (`components/HelpPanel.tsx`). The old auto-launching `GuideModal` in `Home.tsx` was removed; first-visit users now land on the Help tab (controlled via existing `GUIDE_SEEN_KEY` localStorage). `openGuide` switches `mode === "help"` and remembers the prior tab via `helpInitialMode` so the relevant section opens by default.
- **Activity is now a sidebar tab** (`components/ActivityPanel.tsx`). Mirrors the floating panel's per-kind entry rendering (subtitle, clip, bestclips, download, translator) with copy/download/delete actions and "Processing now" / "Completed" sections. Uses the same `useActivityFeed(4000)` hook.
- **Shared guide content** (`lib/guide-tabs.ts`): `GUIDE_TABS` extracted into a shared module so HelpPanel and any future inline guide stay in sync.
- **Sidebar nav** (`components/layout/Sidebar.tsx`): Mode union extended with `"help" | "activity"`. Decorative footer items (Workflows/Teams/Drive/More) replaced by a `UTILITY_ITEMS` row containing Activity (lucide `Activity`) and Help (lucide `CircleHelp`), separated by a divider from the main nav. Active state highlighting works for both desktop rail and mobile drawer.
- **Floating panel removed**: `<FloatingActivityPanel>` no longer rendered in `Home.tsx`. The component file is kept as dead code for now.
- **Mobile drawer label visibility** (`index.css`): `.studio-drawer-backdrop` z-index 100 → 55 so it sits *under* `.gs-drawer` (z-60); `.gs-drawer .gs-nav-item` color forced to `rgba(255,255,255,0.88)` so labels are clearly readable on the dark drawer background.
- **Chat header crowding** (`components/StudioCopilot.tsx` + `index.css`): the secondary chat-history Menu button (`.gs-chat-history-toggle`) is hidden via `@media (max-width: 768px)` so the floating hamburger no longer collides with a duplicate menu icon. Desktop unaffected.
- **Home title clearance**: `.gs-home-title` gets `margin-top: 8px` and side padding under 768px so it can't be clipped by the floating hamburger button.
- **HelpPage / ActivityPage styles**: ~200 new lines of `.help-page-*` and `.activity-page-*` classes appended to `src/index.css` (full-page cards, mobile pill tab strip, action icon buttons, empty state, active vs completed sections).
