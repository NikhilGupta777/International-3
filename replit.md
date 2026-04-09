# Workspace

## Fresh Setup (new Replit from GitHub)

When opening this project in a new Replit for the first time:

1. **Dependencies install automatically** — the dev workflow commands run `pnpm install` before starting, which also installs Python/yt-dlp via the `postinstall` hook. No manual steps needed.

2. **Required secrets** — set these in the Replit Secrets panel:
   - `GEMINI_API_KEY` — required for the Bhagwat AI features (AI image generation, timeline analysis). Without it, AI features will show an error. Get it from [Google AI Studio](https://aistudio.google.com/app/apikey).
   - `DATABASE_URL` — required only if you use DB features (not used by current routes). Replit provides this automatically when you add a PostgreSQL database integration.

3. **Bhagwat section password** — `bhagwatnarrationvideos@clips2026` (hardcoded server-side, can be changed via `BHAGWAT_PASSWORD` secret)

4. The frontend runs at `/` and the API at `/api`. Both start automatically.

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Applications

### `artifacts/yt-downloader` (`@workspace/yt-downloader`)

YouTube video downloader web app (React + Vite). Features:
- Paste any YouTube URL to fetch video info (title, thumbnail, duration, uploader, views)
- Shows all available quality options: 4K (2160p), 1440p, 1080p, 720p, 480p, 360p, 240p, 144p, and audio-only (MP3)
- Best quality badge on top format
- Real-time download progress (percent, speed, ETA) via polling
- **In-browser video playback**: clicking the thumbnail/play button opens a full video player modal that streams via `/api/youtube/stream`
- Uses `/api/youtube/*` backend routes
- **Bhagwat tab** (password-protected: `bhagwatnarrationvideos@clips2026`): AI-powered devotional video editor with two sub-features:
  - **AI Image Video** (`BhagwatEditor`): Analyzes Bhagwat Katha transcripts with Gemini, generates AI images for each scene, renders a narrated MP4. Supports **Clip Mode** — when a clip is opened from "Find Clips", the editor targets only that time range (transcript filtered, audio trimmed with FFmpeg, AI prompt constrained).
  - **Find Clips** (`BestClips`): AI finds the best clips by duration. Each clip has an "Edit with AI" button that opens it in the Bhagwat Editor in clip mode, passing `clipStartSec`/`clipEndSec` to both the analyze and render API endpoints.
- Key files: `src/components/BhagwatVideos.tsx`, `src/components/BestClips.tsx`
- `previewPath: "/"`

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- YouTube routes: `src/routes/youtube.ts` — uses **yt-dlp** (via `python3 -m yt_dlp`) for all YouTube operations; requires Python 3 + yt-dlp installed (`python3 -m pip install yt-dlp`). YouTube downloading previously used `youtubei.js` but it was blocked by YouTube CDNs (HTTP 403). yt-dlp handles all clients/decryption internally and is not blocked.
- `GET /api/youtube/stream?url=<ytUrl>&formatId=<id>` — resolves direct CDN stream URL via `yt-dlp --get-url` and proxies it with Range request support so the browser `<video>` tag can seek.
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.mjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

**Important setup**: Python 3 and yt-dlp are managed via `uv` (see `pyproject.toml`). Run `uv sync` from the workspace root to install deps into `.pythonlibs`. The `pnpm install` postinstall hook does this automatically.

**yt-dlp JS challenge solving (EJS — critical since yt-dlp 2026.03.17)**: YouTube now requires JavaScript challenge solving (EJS) for the `web`/`web_embedded`/`mweb` clients to work. yt-dlp 2026.03.17 ships the EJS system but defaults to Deno as the only enabled JS runtime. Since Deno is not installed in this environment, all three route files (`youtube.ts`, `bhagwat.ts`, `subtitles.ts`) pass `--js-runtimes node --js-runtimes bun --remote-components ejs:github` in their base args to enable Node.js (20.20.0) and Bun (1.3.6) — both installed in Nix — and allow fetching the latest solver script from GitHub (cached on first run). Without these flags, yt-dlp reports `JS runtimes: none` and all HTTPS formats fail with signature/n-challenge errors.

**Production deployment**: The API server artifact.toml build step runs `pnpm install --frozen-lockfile` (which triggers `uv sync` via postinstall) before bundling with esbuild. Environment vars `UV_PROJECT_ENVIRONMENT=/home/runner/workspace/.pythonlibs`, `UV_PYTHON_PREFERENCE=only-system`, and `UV_PYTHON_DOWNLOADS=never` ensure Python deps go to the correct location. The PYTHONPATH in spawn calls (`youtube.ts`, `bhagwat.ts`) is set dynamically from `process.env.REPL_HOME ?? process.cwd()` so it works in both dev and production.

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
