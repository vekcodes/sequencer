import { Hono } from 'hono';
import { env, isGoogleOAuthConfigured } from '../lib/env';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  fetchGmailProfile,
} from '../lib/google';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state';
import { runDnsChecks } from '../lib/dns-checks';
import {
  upsertGoogleMailbox,
  updateMailboxDnsResults,
} from '../services/mailbox';
import { computeMailboxHealth } from '../services/mailbox-health';
import { startWatchForMailbox } from '../services/gmail-watch';
import type { AuthVariables } from '../middleware/auth';
import { requireAuth } from '../middleware/auth';

export const oauthRoutes = new Hono<{ Variables: AuthVariables }>();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/start
// Requires session. Returns 302 to Google's consent screen with a signed state.
// ─────────────────────────────────────────────────────────────────────────────

oauthRoutes.get('/google/start', requireAuth, (c) => {
  if (!isGoogleOAuthConfigured()) {
    return c.json(
      {
        error: 'google_oauth_not_configured',
        message:
          'Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in .env',
      },
      503,
    );
  }
  const user = c.get('user')!;
  const state = signOAuthState({ userId: user.id, workspaceId: user.workspaceId });
  const url = buildAuthorizationUrl(state);
  return c.redirect(url, 302);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/callback?code=...&state=...
// Public — relies on signed state for auth (the user's session cookie may not
// be present here if the redirect_uri points directly at the api host).
// ─────────────────────────────────────────────────────────────────────────────

function redirectToWeb(path: string, params?: Record<string, string>) {
  const url = new URL(path, env.WEB_ORIGIN);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

oauthRoutes.get('/google/callback', async (c) => {
  if (!isGoogleOAuthConfigured()) {
    return c.json({ error: 'google_oauth_not_configured' }, 503);
  }

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: errorParam }),
      302,
    );
  }

  if (!code || !state) {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'missing_code_or_state' }),
      302,
    );
  }

  const payload = verifyOAuthState(state);
  if (!payload) {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'invalid_state' }),
      302,
    );
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'token_exchange_failed' }),
      302,
    );
  }

  if (!tokens.refresh_token) {
    // Should not happen because we set prompt=consent, but defend against it.
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'no_refresh_token' }),
      302,
    );
  }

  let userInfo;
  try {
    userInfo = await fetchUserInfo(tokens.access_token);
  } catch {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'userinfo_failed' }),
      302,
    );
  }
  if (!userInfo.email_verified) {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'email_not_verified' }),
      302,
    );
  }

  let gmailProfile;
  try {
    gmailProfile = await fetchGmailProfile(tokens.access_token);
  } catch {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'gmail_profile_failed' }),
      302,
    );
  }

  // Upsert the mailbox row
  let row;
  try {
    row = await upsertGoogleMailbox({
      workspaceId: payload.workspaceId,
      email: gmailProfile.emailAddress,
      displayName: userInfo.name ?? null,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresInSec: tokens.expires_in,
      historyId: gmailProfile.historyId,
    });
  } catch {
    return c.redirect(
      redirectToWeb('/mailboxes', { error: 'mailbox_save_failed' }),
      302,
    );
  }

  // Best-effort DNS checks. Don't block the redirect if they fail.
  const domain = gmailProfile.emailAddress.split('@')[1];
  if (domain) {
    try {
      const dnsResults = await runDnsChecks(domain);
      await updateMailboxDnsResults(row.id, dnsResults);
    } catch {
      /* swallow — these get retried in mailbox-health-worker */
    }
  }

  // Kick off an initial health snapshot so the detail page has data immediately.
  // Fire and forget — the redirect doesn't wait.
  computeMailboxHealth(row.id).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[oauth] initial health snapshot failed:', e);
  });

  // Phase 7: start the Gmail push watch so replies arrive in near-real-time.
  // Also fire-and-forget — the cron fallback will pick it up within 10 minutes
  // if this particular call fails.
  startWatchForMailbox(row.id).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[oauth] start watch failed:', e);
  });

  return c.redirect(
    redirectToWeb(`/mailboxes/${row.id}`, { welcome: '1' }),
    302,
  );
});
