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
# Install workspace deps recursively — the worker dynamically imports
# api-server route modules at runtime, so api-server runtime deps
# (express, multer, etc.) must exist in this image.
RUN pnpm -r install --frozen-lockfile
RUN pnpm --filter @workspace/queue-worker run build

CMD ["node", "artifacts/queue-worker/dist/index.cjs"]
