import { createDb } from '@ces/db';
import { env } from './env';

// Singleton db client. Imported once at startup; the api uses this everywhere.
export const db = createDb(env.DATABASE_URL);
