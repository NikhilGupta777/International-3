FROM ubuntu:24.04

# ── System packages ─────────────────────────────────────────────────────────
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      gnupg \
      unzip \
      ffmpeg \
      python3 \
      python3-pip \
      git \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 24 via NodeSource ────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Deno so yt-dlp can solve YouTube JS challenges inside the container.
RUN curl -fsSL https://deno.land/install.sh | sh \
    && ln -s /root/.deno/bin/deno /usr/local/bin/deno

# ── pnpm ─────────────────────────────────────────────────────────────────────
RUN npm install -g pnpm@10

# ── yt-dlp + dynamic PO-token provider plugin ────────────────────────────────
RUN pip3 install --break-system-packages --upgrade \
      "yt-dlp[default,curl-cffi]" \
      bgutil-ytdlp-pot-provider

# ── App source ────────────────────────────────────────────────────────────────
WORKDIR /app

# Copy everything — .dockerignore excludes node_modules, dist, .git, etc.
COPY . .

# ── Install Node.js dependencies ──────────────────────────────────────────────
# Note: postinstall runs "uv sync || true" — safe to run, won't fail without uv
RUN pnpm install --frozen-lockfile

# ── Build frontend ────────────────────────────────────────────────────────────
RUN pnpm --filter @workspace/yt-downloader run build

# ── Build backend ─────────────────────────────────────────────────────────────
RUN pnpm --filter @workspace/api-server run build

# ── Runtime environment ───────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_DIR=/app/artifacts/yt-downloader/dist/public

EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/api/healthz || exit 1

# ── Entrypoint: runs DB migrations then starts the server ─────────────────────
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD []
