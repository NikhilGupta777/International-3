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
    bgutil-ytdlp-pot-provider

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy only the files needed for dependency resolution first (layer cache efficiency)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/package.json ./scripts/
COPY scripts/enforce-pnpm.mjs scripts/optional-uv-sync.mjs ./scripts/

# Copy workspace package.json files so pnpm can resolve the graph
# The queue-worker dynamically imports api-server modules at runtime,
# so api-server and its dependencies must also be installed.
COPY artifacts/queue-worker/package.json ./artifacts/queue-worker/
COPY artifacts/api-server/package.json ./artifacts/api-server/
# api-server transitively depends on these workspace libs (zod schemas +
# Drizzle DB types). Their package.json files must be present at install
# time so pnpm can resolve the workspace graph from the lockfile, AND
# their own deps must be installed (otherwise esbuild fails to resolve
# `zod` when bundling lib/api-zod source into the api-server output).
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/

# Install the worker plus all transitive workspace deps (leading `...`).
# The previous trailing-dots variant (`@workspace/api-server...`) selected
# api-server AND its dependents (none), so lib/api-zod's `zod` dependency
# was never installed and esbuild failed at build time.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set network-concurrency 4 && \
    pnpm --filter "...@workspace/queue-worker" --filter "...@workspace/api-server" install --frozen-lockfile

# Copy source after dependencies are installed (maximize cache reuse)
COPY . .

# Build api-server first — the queue worker dynamically imports
# `@workspace/api-server/dist/routes/video-editor.mjs` at runtime to run
# editor-render jobs. Without this step that file doesn't exist in the
# image and editor renders fail with "api-server module not available".
RUN pnpm --filter @workspace/api-server run build
RUN pnpm --filter @workspace/queue-worker run build

CMD ["node", "artifacts/queue-worker/dist/index.mjs"]
