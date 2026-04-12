import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie } from 'hono/cookie';
import {
  SESSION_COOKIE_NAME,
  validateSession,
  createSessionCookie,
  createBlankSessionCookie,
  type AuthSession,
  type AuthUserRecord,
} from '../lib/auth';

export type AuthVariables = {
  user: AuthUserRecord | null;
  session: AuthSession | null;
};

/**
 * Reads the session cookie, validates it, and sets c.var.user / c.var.session.
 * Refreshes the cookie if the session was just slid forward, or clears it if invalid.
 */
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME) ?? null;
    if (!sessionId) {
      c.set('user', null);
      c.set('session', null);
      return next();
    }

    const result = await validateSession(sessionId);

    if (result.session?.fresh) {
      const cookie = createSessionCookie(result.session.id);
      setCookie(c, cookie.name, cookie.value, cookie.attributes);
    }
    if (!result.session) {
      const blank = createBlankSessionCookie();
      setCookie(c, blank.name, blank.value, blank.attributes);
    }

    c.set('user', result.user);
    c.set('session', result.session);
    return next();
  },
);

/** Returns 401 if no authenticated user. */
export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    if (!c.get('user')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  },
);
