#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/db
npx drizzle-kit push --force 2>&1 || echo "Migration warning (may already be applied)"
cd /app

echo "Starting API server..."
exec node apps/api/dist/index.js
