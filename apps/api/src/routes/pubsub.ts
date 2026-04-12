import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { mailbox } from '@ces/db';
import { db } from '../lib/db';
import { processMailboxHistory } from '../services/reply-ingestion';

// ─────────────────────────────────────────────────────────────────────────────
// POST /pubsub/gmail
//
// Push endpoint for Gmail's Pub/Sub delivery. Pub/Sub sends:
//   {
//     "message": {
//       "data": "<base64 of {\"emailAddress\":\"...\",\"historyId\":\"...\"}>",
//       "messageId": "...",
//       "publishTime": "..."
//     },
//     "subscription": "projects/.../subscriptions/..."
//   }
//
// Mounted at the app root (not under /api) so it can be configured as a
// public endpoint in the Pub/Sub console. Auth is via:
//   1. Pub/Sub's OIDC token (verified by header) OR
//   2. A shared secret passed as ?token=... (dev mode fallback)
//
// For Phase 7 we implement the shared-secret path + a TODO for OIDC.
// ─────────────────────────────────────────────────────────────────────────────

export const pubsubRoutes = new Hono();

type PubsubPayload = {
  message?: {
    data?: string;
    messageId?: string;
  };
};

type GmailNotification = {
  emailAddress: string;
  historyId: string | number;
};

pubsubRoutes.post('/gmail', async (c) => {
  // Shared-secret check (dev-friendly). In production we'd verify the
  // `Authorization: Bearer <id-token>` JWT with Google's JWKS.
  const expected = process.env.PUBSUB_SHARED_SECRET;
  if (expected) {
    const provided = c.req.query('token');
    if (provided !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  const body = (await c.req.json().catch(() => null)) as PubsubPayload | null;
  if (!body?.message?.data) {
    // Pub/Sub retries on non-2xx. Return 200 for malformed so we don't loop.
    return c.json({ ok: true, ignored: 'no_data' });
  }

  let decoded: GmailNotification;
  try {
    const raw = Buffer.from(body.message.data, 'base64').toString('utf-8');
    decoded = JSON.parse(raw) as GmailNotification;
  } catch {
    return c.json({ ok: true, ignored: 'decode_failed' });
  }

  if (!decoded.emailAddress) {
    return c.json({ ok: true, ignored: 'no_email_address' });
  }

  // Find the mailbox by email. Pub/Sub is workspace-agnostic — we scope the
  // downstream writes by the mailbox's own workspaceId.
  const [mb] = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.email, decoded.emailAddress))
    .limit(1);
  if (!mb) {
    return c.json({ ok: true, ignored: 'mailbox_not_found' });
  }

  // Fire-and-forget. Pub/Sub's retry contract wants a fast 2xx; the actual
  // history walk can take several seconds for busy mailboxes.
  processMailboxHistory(mb.id).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[pubsub/gmail] processMailboxHistory failed:', e);
  });

  return c.json({ ok: true });
});
