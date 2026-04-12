import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { user, workspace } from '@ces/db';
import { SignupRequest, LoginRequest } from '@ces/shared';
import { db } from '../lib/db';
import {
  createSession,
  invalidateSession,
  createSessionCookie,
  createBlankSessionCookie,
  generateUserId,
} from '../lib/auth';
import { hashPassword, verifyPassword } from '../lib/password';
import type { AuthVariables } from '../middleware/auth';

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56);
  return base || `workspace-${Date.now()}`;
}

// A pre-computed argon2id hash of a random string. Used to make /login take
// the same wall-clock time whether or not the email exists.
const TIMING_DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0c3RyaW5n$x47cT0OB2BGBfiPg4eK8C7P3Yh3PVR4o2MwHdCkkSf0';

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

authRoutes.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SignupRequest.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const { email, password, name, workspaceName } = parsed.data;
  const passwordHash = await hashPassword(password);
  const userId = generateUserId();
  const slug = slugify(workspaceName);

  try {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(workspace)
        .values({ name: workspaceName, slug })
        .returning();
      const ws = inserted[0];
      if (!ws) throw new Error('workspace_create_failed');

      await tx.insert(user).values({
        id: userId,
        workspaceId: ws.id,
        email,
        name,
        role: 'owner',
        passwordHash,
      });
    });
  } catch (e) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code: string }).code === '23505'
    ) {
      return c.json({ error: 'email_or_workspace_taken' }, 409);
    }
    throw e;
  }

  const session = await createSession(userId);
  const cookie = createSessionCookie(session.id);
  setCookie(c, cookie.name, cookie.value, cookie.attributes);
  return c.json({ ok: true as const });
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = LoginRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input' }, 400);
  }

  const { email, password } = parsed.data;
  const found = await db
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  const u = found[0];

  if (!u || !u.passwordHash) {
    // Burn the same time argon2 would normally take so we don't leak existence.
    await verifyPassword(TIMING_DUMMY_HASH, password).catch(() => false);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const ok = await verifyPassword(u.passwordHash, password);
  if (!ok) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const session = await createSession(u.id);
  const cookie = createSessionCookie(session.id);
  setCookie(c, cookie.name, cookie.value, cookie.attributes);
  return c.json({ ok: true as const });
});

authRoutes.post('/logout', async (c) => {
  const session = c.get('session');
  if (session) {
    await invalidateSession(session.id);
  }
  const blank = createBlankSessionCookie();
  setCookie(c, blank.name, blank.value, blank.attributes);
  return c.json({ ok: true as const });
});

authRoutes.get('/me', (c) => {
  const u = c.get('user');
  if (!u) return c.json({ user: null });
  return c.json({
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      workspaceId: u.workspaceId,
    },
  });
});
