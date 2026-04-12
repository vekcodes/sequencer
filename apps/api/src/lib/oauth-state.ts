import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStateKey } from './crypto';

// HMAC-signed OAuth state. Used in /api/auth/google/start to bind the OAuth flow
// to a specific user + workspace, so the callback can trust who initiated it
// without needing access to the session cookie.

const STATE_TTL_MS = 1000 * 60 * 10; // 10 minutes

export type OAuthStatePayload = {
  userId: string;
  workspaceId: number;
  nonce: string;
  expiresAt: number; // epoch ms
};

export function signOAuthState(
  fields: Pick<OAuthStatePayload, 'userId' | 'workspaceId'>,
): string {
  const payload: OAuthStatePayload = {
    userId: fields.userId,
    workspaceId: fields.workspaceId,
    nonce: randomBytes(12).toString('base64url'),
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', getStateKey()).update(json).digest('base64url');
  return `${Buffer.from(json).toString('base64url')}.${sig}`;
}

export function verifyOAuthState(state: string): OAuthStatePayload | null {
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!b64 || !sig) return null;

  let json: string;
  try {
    json = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  // Validate shape before doing anything else with the bytes.
  if (
    typeof payload?.userId !== 'string' ||
    typeof payload?.workspaceId !== 'number' ||
    typeof payload?.nonce !== 'string' ||
    typeof payload?.expiresAt !== 'number'
  ) {
    return null;
  }

  const expected = createHmac('sha256', getStateKey()).update(json).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  if (payload.expiresAt < Date.now()) {
    return null;
  }
  return payload;
}
