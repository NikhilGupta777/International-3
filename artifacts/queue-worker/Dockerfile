FROM node:20-bookworm-slim

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

COPY . .

RUN pnpm config set network-concurrency 1 && pnpm config set child-concurrency 1
# Install ALL workspace deps — the worker dynamically imports api-server routes
# at runtime, so api-server's deps (express, multer, @google/genai, etc.) must
# be present in node_modules even though the worker itself doesn't declare them.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/queue-worker run build

CMD ["node", "artifacts/queue-worker/dist/index.cjs"]
