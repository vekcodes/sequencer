# Cold Email Sequencer

Robust outbound cold email sequencer with one-click Gmail OAuth, portfolio-based inbox rotation, and cold email deliverability best practices enforced by default.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

## Layout

```
apps/
  web/        Vite + React + TS frontend
  api/        Hono backend (Node)
packages/
  db/         Drizzle schema + migrations
  shared/     Zod types shared FE <-> BE
  config/     DEFAULTS constants
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
npm run docker:up

# 3. Create the database schema
cp .env.example .env
npm run db:push

# 4. Run the apps (in two terminals)
npm run dev:api    # http://localhost:3001
npm run dev:web    # http://localhost:5173
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev:web` | Run the Vite frontend |
| `npm run dev:api` | Run the Hono API in watch mode |
| `npm run db:generate` | Generate migration SQL from current schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Sync schema directly (dev only — no migration files) |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run docker:up` | Start Postgres + Redis |
| `npm run docker:down` | Stop them |
