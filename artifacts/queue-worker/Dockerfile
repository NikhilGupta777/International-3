FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --upgrade \
    "yt-dlp[default,curl-cffi]" \
    bgutil-ytdlp-pot-provider \
    youtube-transcript-api


RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy only the files needed for dependency resolution first (layer cache efficiency)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/package.json ./scripts/
COPY scripts/enforce-pnpm.mjs scripts/optional-uv-sync.mjs ./scripts/
COPY stubs ./stubs/

# Copy workspace package.json files so pnpm can resolve the graph
# The queue-worker dynamically imports api-server modules at runtime,
# so api-server and its dependencies must also be installed.
COPY artifacts/queue-worker/package.json ./artifacts/queue-worker/
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Install only the worker plus API packages needed by bundled dynamic imports.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set network-concurrency 4 && \
    pnpm --filter @workspace/queue-worker... --filter @workspace/api-server... install --frozen-lockfile

# Copy source after dependencies are installed (maximize cache reuse).
# CI pre-builds `artifacts/api-server/dist/` on the runner (see
# .github/workflows/deploy.yml build-worker job) — this COPY pulls it
# in so the worker can dynImport `@workspace/api-server/dist/routes/
# video-editor.mjs` through the pnpm workspace symlink at runtime.
COPY . .

RUN pnpm --filter @workspace/queue-worker run build

# Pin the ffmpeg/ffprobe paths to the system binaries installed via apt
# above. Without these, the api-server bundle that handleEditorRender
# dynImports falls back to `ffmpeg-static`'s default export, whose path
# was computed by esbuild at bundle time as `__dirname + "/ffmpeg"` —
# i.e. `/app/artifacts/api-server/dist/routes/ffmpeg`, which doesn't
# exist in this image. Mirrors the api-lambda Dockerfile pattern.
ENV FFMPEG_BIN=/usr/bin/ffmpeg
ENV FFPROBE_BIN=/usr/bin/ffprobe

CMD ["node", "artifacts/queue-worker/dist/index.mjs"]
