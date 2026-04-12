# ── Stage 1: Install & build ─────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

# Build frontend (static files)
RUN npm run build:web

# Build API (TypeScript → JS)
RUN npm run build:api

# ── Stage 2: Production image ────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# Install only production deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
RUN npm ci --omit=dev --ignore-scripts

# Copy built API
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/packages/db packages/db
COPY --from=builder /app/packages/shared packages/shared
COPY --from=builder /app/packages/config packages/config
COPY --from=builder /app/tsconfig.base.json tsconfig.base.json

# Copy built frontend (served by API or a reverse proxy)
COPY --from=builder /app/apps/web/dist apps/web/dist

# DB migrations
COPY packages/db/migrations packages/db/migrations
COPY packages/db/drizzle.config.ts packages/db/

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Start the API server (which also runs all schedulers)
CMD ["node", "apps/api/dist/index.js"]
