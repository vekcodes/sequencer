import { randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { session, user } from '@ces/db';
import { db } from './db';
import { env } from './env';

// ─────────────────────────────────────────────────────────────────────────────
// Session lifetime
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'ces_session';
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
/** If less time than this remains, we extend the session on the next request. */
export const SESSION_REFRESH_THRESHOLD_MS = 1000 * 60 * 60 * 24 * 15; // 15 days

const SESSION_ID_BYTES = 25; // 200 bits of entropy
const USER_ID_BYTES = 15;

// ─────────────────────────────────────────────────────────────────────────────
// ID generation
// ─────────────────────────────────────────────────────────────────────────────

export function generateSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export function generateUserId(): string {
  return randomBytes(USER_ID_BYTES).toString('base64url');
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AuthSession = {
  id: string;
  userId: string;
  expiresAt: Date;
  /** True if the session expiry was just refreshed — middleware should re-set the cookie. */
  fresh: boolean;
};

export type AuthUserRecord = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  workspaceId: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function createSession(userId: string): Promise<AuthSession> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await db.insert(session).values({ id, userId, expiresAt });
  return { id, userId, expiresAt, fresh: false };
}

export async function validateSession(
  sessionId: string,
): Promise<{ session: AuthSession | null; user: AuthUserRecord | null }> {
  const rows = await db
    .select({
      sessionId: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      uId: user.id,
      uEmail: user.email,
      uName: user.name,
      uRole: user.role,
      uWorkspaceId: user.workspaceId,
    })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(eq(session.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return { session: null, user: null };

  // Expired? Garbage-collect.
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(session).where(eq(session.id, sessionId));
    return { session: null, user: null };
  }

  // Sliding-window refresh.
  let expiresAt = row.expiresAt;
  let fresh = false;
  if (expiresAt.getTime() - Date.now() < SESSION_REFRESH_THRESHOLD_MS) {
    expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await db.update(session).set({ expiresAt }).where(eq(session.id, sessionId));
    fresh = true;
  }

  return {
    session: { id: row.sessionId, userId: row.userId, expiresAt, fresh },
    user: {
      id: row.uId,
      email: row.uEmail,
      name: row.uName,
      role: row.uRole,
      workspaceId: row.uWorkspaceId,
    },
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sessionId));
}

/** Cleanup hook — call from a cron later. */
export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(session).where(lt(session.expiresAt, new Date()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookies
// ─────────────────────────────────────────────────────────────────────────────

export type SessionCookieAttributes = {
  httpOnly: true;
  sameSite: 'Lax';
  path: string;
  secure: boolean;
  maxAge: number;
};

export function createSessionCookie(sessionId: string): {
  name: string;
  value: string;
  attributes: SessionCookieAttributes;
} {
  return {
    name: SESSION_COOKIE_NAME,
    value: sessionId,
    attributes: {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: env.NODE_ENV === 'production',
      maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    },
  };
}

export function createBlankSessionCookie(): {
  name: string;
  value: string;
  attributes: SessionCookieAttributes;
} {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    attributes: {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: env.NODE_ENV === 'production',
      maxAge: 0,
    },
  };
}
