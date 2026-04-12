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

# Build frontend only (static files)
RUN npm run build:web

# ── Stage 2: Production image ────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# Copy everything needed to install + run
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/ apps/api/
COPY packages/ packages/
RUN npm ci --ignore-scripts

# Copy built frontend (served by API in production)
COPY --from=builder /app/apps/web/dist apps/web/dist

# Startup script
COPY start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["./start.sh"]
