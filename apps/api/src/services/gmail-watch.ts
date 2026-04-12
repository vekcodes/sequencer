// Starts/renews Gmail Pub/Sub watches for connected mailboxes. Phase 7.
//
// The actual Pub/Sub topic is taken from the `PUBSUB_GMAIL_TOPIC` env var
// (e.g. `projects/my-gcp/topics/ces-gmail-push`). If the var is missing, the
// watch call is a no-op and we log it — this lets the rest of Phase 7 run
// against the manual cron fallback during local development.

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { mailbox } from '@ces/db';
import { db } from '../lib/db';
import { DEFAULTS } from '@ces/config';
import { startGmailWatch } from '../lib/google';
import { getMailboxAccessToken } from './mailbox';

const DAY_MS = 24 * 60 * 60 * 1000;

function getTopic(): string | null {
  return process.env.PUBSUB_GMAIL_TOPIC ?? null;
}

/**
 * Call on mailbox connect. Best-effort — if the topic isn't configured or the
 * call fails, the mailbox is still usable for sending, just no push delivery.
 */
export async function startWatchForMailbox(mailboxId: number): Promise<{
  started: boolean;
  reason?: string;
  expiresAt?: Date;
}> {
  const topic = getTopic();
  if (!topic) return { started: false, reason: 'no_topic_configured' };

  let accessToken: string;
  try {
    accessToken = await getMailboxAccessToken(mailboxId);
  } catch (e) {
    return {
      started: false,
      reason: `access_token_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let resp;
  try {
    resp = await startGmailWatch(accessToken, topic);
  } catch (e) {
    return {
      started: false,
      reason: `watch_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const expiresAt = new Date(Number(resp.expiration));
  await db
    .update(mailbox)
    .set({
      googleHistoryId: resp.historyId,
      googleWatchExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(mailbox.id, mailboxId));

  return { started: true, expiresAt };
}

/**
 * Renews watches that are within `watchRenewIntervalDays` of expiry (default
 * 6 — watches live 7 days). Also picks up mailboxes that have never been
 * watched (expiresAt IS NULL).
 */
export async function renewExpiringWatches(): Promise<{
  checked: number;
  renewed: number;
  failures: Array<{ mailboxId: number; reason: string }>;
}> {
  const topic = getTopic();
  if (!topic) {
    return { checked: 0, renewed: 0, failures: [] };
  }

  const threshold = new Date(
    Date.now() + (7 - DEFAULTS.gmail.watchRenewIntervalDays) * DAY_MS,
  );

  const due = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(
      and(
        eq(mailbox.provider, 'google'),
        eq(mailbox.healthStatus, 'connected'),
        or(
          isNull(mailbox.googleWatchExpiresAt),
          lte(mailbox.googleWatchExpiresAt, threshold),
        ),
      ),
    );

  const failures: Array<{ mailboxId: number; reason: string }> = [];
  let renewed = 0;
  for (const m of due) {
    const r = await startWatchForMailbox(m.id);
    if (r.started) renewed += 1;
    else failures.push({ mailboxId: m.id, reason: r.reason ?? 'unknown' });
  }
  return { checked: due.length, renewed, failures };
}
