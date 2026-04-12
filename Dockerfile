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

# drizzle-kit + tsx needed for DB migrations at startup
RUN npm install -g drizzle-kit tsx

# Copy built API
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/packages/db packages/db
COPY --from=builder /app/packages/shared packages/shared
COPY --from=builder /app/packages/config packages/config
COPY --from=builder /app/tsconfig.base.json tsconfig.base.json

# Copy built frontend (served by API in production)
COPY --from=builder /app/apps/web/dist apps/web/dist

# Startup script
COPY start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["./start.sh"]
