import { env } from './env';

// Pure-fetch Google OAuth + Gmail helpers. We deliberately avoid the `googleapis`
// SDK in Phase 2 (it's heavy and we only need 2 endpoints). Phase 6 will pull
// it in once we start sending real mail.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

// Minimal scopes — only what's needed to send + read inbound + label our threads.
// We deliberately do NOT request gmail.readonly (full mailbox access).
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: 'Bearer';
  scope: string;
  id_token?: string;
};

export type GoogleUserInfo = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
};

export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

function requireOAuthEnv(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  if (
    !env.GOOGLE_OAUTH_CLIENT_ID ||
    !env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !env.GOOGLE_OAUTH_REDIRECT_URI
  ) {
    throw new Error('google_oauth_not_configured');
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  };
}

export function buildAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = requireOAuthEnv();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', // gives us a refresh_token
    prompt: 'consent', // forces refresh_token even on re-consent
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret, redirectUri } = requireOAuthEnv();

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = requireOAuthEnv();

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google userinfo fetch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleUserInfo;
}

export async function fetchGmailProfile(accessToken: string): Promise<GmailProfile> {
  const res = await fetch(GMAIL_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail profile fetch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GmailProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail history walk + message fetch (Phase 7: reply ingestion)
// ─────────────────────────────────────────────────────────────────────────────

const GMAIL_WATCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/watch';
const GMAIL_STOP_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/stop';
const GMAIL_HISTORY_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/history';
const GMAIL_MESSAGE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

export type GmailWatchResponse = {
  historyId: string;
  expiration: string; // ms-since-epoch, as a string
};

export type GmailHistoryEntry = {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  messagesAdded?: Array<{
    message: { id: string; threadId: string; labelIds?: string[] };
  }>;
};

export type GmailHistoryListResponse = {
  history?: GmailHistoryEntry[];
  historyId: string;
  nextPageToken?: string;
};

export type GmailMessageHeader = { name: string; value: string };

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: { size?: number; data?: string };
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId: string;
  internalDate: string;
  payload?: GmailMessagePart;
};

/**
 * Start a Pub/Sub watch for new inbound mail. `topicName` must be a Pub/Sub
 * topic the service account has Publisher on. Expires after 7 days — callers
 * must renew via the `gmail-watch-renew` worker.
 */
export async function startGmailWatch(
  accessToken: string,
  topicName: string,
): Promise<GmailWatchResponse> {
  const res = await fetch(GMAIL_WATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds: ['INBOX'],
      labelFilterAction: 'include',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gmail.users.watch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GmailWatchResponse;
}

/** Stops a watch. Best-effort — used when a mailbox is deleted or disconnected. */
export async function stopGmailWatch(accessToken: string): Promise<void> {
  const res = await fetch(GMAIL_STOP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`gmail.users.stop failed (${res.status}): ${text}`);
  }
}

/**
 * Returns the history diff since `startHistoryId`. Only `messageAdded` entries
 * are interesting for reply ingestion — we pass historyTypes=messageAdded to
 * reduce payload size.
 */
export async function listGmailHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<GmailHistoryListResponse> {
  const url = new URL(GMAIL_HISTORY_URL);
  url.searchParams.set('startHistoryId', startHistoryId);
  url.searchParams.set('historyTypes', 'messageAdded');
  url.searchParams.set('labelId', 'INBOX');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gmail.users.history.list failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GmailHistoryListResponse;
}

/**
 * Adds/removes Gmail labels on a message. Used by the warmup engagement loop
 * to rescue warmup mail out of SPAM and mark it IMPORTANT + read, which are
 * the two Gmail engagement signals Postmaster Tools weights most heavily.
 */
export async function modifyGmailMessageLabels(
  accessToken: string,
  messageId: string,
  opts: { add?: string[]; remove?: string[] },
): Promise<void> {
  const url = `${GMAIL_MESSAGE_URL}/${encodeURIComponent(messageId)}/modify`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      addLabelIds: opts.add ?? [],
      removeLabelIds: opts.remove ?? [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gmail.users.messages.modify failed (${res.status}): ${text}`);
  }
}

/** Fetches one message with full payload (format=full). */
export async function fetchGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage> {
  const url = new URL(`${GMAIL_MESSAGE_URL}/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gmail.users.messages.get failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GmailMessage;
}

/** Finds a header by name (case-insensitive) in a Gmail message payload. */
export function getHeader(msg: GmailMessage, name: string): string | null {
  const headers = msg.payload?.headers ?? [];
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return null;
}

/**
 * Decodes and concatenates the text/plain parts of a Gmail message. Falls back
 * to text/html (stripped) if no plain part exists. Gmail returns part bodies
 * as base64url-encoded strings.
 */
export function extractPlainBody(msg: GmailMessage): string {
  const parts: GmailMessagePart[] = [];
  const collect = (p: GmailMessagePart) => {
    parts.push(p);
    for (const sub of p.parts ?? []) collect(sub);
  };
  if (msg.payload) collect(msg.payload);

  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain?.body?.data) return b64UrlDecode(plain.body.data);

  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  if (html?.body?.data) {
    return b64UrlDecode(html.body.data).replace(/<[^>]+>/g, '');
  }
  return msg.snippet ?? '';
}

function b64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64').toString('utf-8');
}
