import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Walk up from CWD to find .env (so it works whether you `cd apps/api && tsx ...`
// or run via `npm run dev:api` from the monorepo root).
{
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = resolve(dir, '.env');
    if (existsSync(p)) {
      loadDotenv({ path: p });
      break;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

  // Token encryption (AES-256-GCM key, base64-encoded 32 bytes).
  // Optional in dev — an ephemeral key is generated if missing, with a warning.
  // REQUIRED in production.
  TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // Google OAuth — optional so the app boots without them.
  // Routes will return 503 with a clear error until set.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),

  // Anthropic API key — powers LLM reply classification (Phase 7+).
  // Optional: if missing, the rule-based classifier is used as a fallback.
  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof EnvSchema>;

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}
