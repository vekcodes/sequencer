import './load-env';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { createDb } from './index';
import { workspace, user } from './schema';

const ARGON2_OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const;

const DEMO_EMAIL = 'demo@ces.local';
const DEMO_PASSWORD = 'password123';
const DEMO_WORKSPACE = 'Demo Workspace';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Did you copy .env.example to .env?');
    process.exit(1);
  }
  const db = createDb(url);

  // Idempotent: if the demo user already exists, no-op.
  const existing = await db
    .select()
    .from(user)
    .where(eq(user.email, DEMO_EMAIL))
    .limit(1);
  if (existing[0]) {
    console.log(`✓ seed already applied — ${DEMO_EMAIL} exists`);
    process.exit(0);
  }

  const passwordHash = await hash(DEMO_PASSWORD, ARGON2_OPTS);

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(workspace)
      .values({ name: DEMO_WORKSPACE, slug: 'demo' })
      .onConflictDoNothing()
      .returning();

    let wsId: number;
    if (inserted[0]) {
      wsId = inserted[0].id;
    } else {
      const found = await tx
        .select()
        .from(workspace)
        .where(eq(workspace.slug, 'demo'))
        .limit(1);
      if (!found[0]) throw new Error('failed to create or find demo workspace');
      wsId = found[0].id;
    }

    // Lucia v3 user IDs are 15-byte entropy → text. crypto.randomUUID() is fine for seed.
    const userId = `seed-${crypto.randomUUID().slice(0, 12)}`;
    await tx.insert(user).values({
      id: userId,
      workspaceId: wsId,
      email: DEMO_EMAIL,
      name: 'Demo User',
      role: 'owner',
      passwordHash,
    });
  });

  console.log(`✓ seeded:`);
  console.log(`    email:    ${DEMO_EMAIL}`);
  console.log(`    password: ${DEMO_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
