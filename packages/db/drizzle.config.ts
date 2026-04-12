import './src/load-env';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://ces:ces@localhost:5432/ces',
  },
  strict: true,
  verbose: true,
});
