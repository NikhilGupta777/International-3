#!/bin/bash
set -e
pnpm install
if [ -n "$DATABASE_URL" ]; then
  pnpm --filter @workspace/db run push || true
fi
