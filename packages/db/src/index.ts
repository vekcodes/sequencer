import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
export * from './schema/index';
