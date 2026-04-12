import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Walk up from CWD to find .env so monorepo root .env is discoverable from
// `npm run db:* -w @ces/db` or from the package dir directly.
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
