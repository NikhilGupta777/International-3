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

# Copy workspace package.json files so pnpm can resolve the graph
# The queue-worker dynamically imports api-server modules at runtime,
# so api-server and its dependencies must also be installed.
COPY artifacts/queue-worker/package.json ./artifacts/queue-worker/
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Install only the worker plus API packages needed by bundled dynamic imports.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set network-concurrency 4 && \
    pnpm --filter @workspace/queue-worker... --filter @workspace/api-server... install --frozen-lockfile

# Copy source after dependencies are installed (maximize cache reuse)
COPY . .

RUN pnpm --filter @workspace/queue-worker run build

CMD ["node", "artifacts/queue-worker/dist/index.mjs"]
