#!/bin/sh
set -e

echo "==> Waiting for database to be ready..."
# Give the DB a moment if it just became healthy
sleep 1

if [ -n "$YTDLP_COOKIES_BASE64" ]; then
  echo "==> Writing YouTube cookies from YTDLP_COOKIES_BASE64..."
  printf "%s" "$YTDLP_COOKIES_BASE64" | base64 -d > /app/.yt-cookies.txt
fi

echo "==> Running database schema push..."
if pnpm --filter @workspace/db run push-force 2>&1; then
  echo "==> Database schema is up to date."
else
  echo "ERROR: Database schema push failed. Check DATABASE_URL and DB connectivity."
  exit 1
fi

echo "==> Starting YTGrabber server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
