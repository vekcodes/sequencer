#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/db
npx drizzle-kit push --force 2>&1 || echo "Migration warning (may already be applied)"
cd /app

echo "Starting API server..."
exec npx tsx apps/api/src/index.ts
