// Phase 8 — Smart-Adjust feedback loop.
//
// Nudges `mailbox.dailyLimitTarget` up or down based on the mailbox's own
// recent performance. The rules are intentionally conservative:
//
//   - 7d bounce rate > 1% OR spam rate > 0.15% → target -= 5
//   - 7d bounce rate ≤ 0.5% AND spam rate ≤ 0.05% AND health ≥ 95 → target += 2
//   - otherwise no change
//
// The hard ceilings + resting transitions in `mailbox-health.ts` still run
// on top of this. Smart-Adjust only tunes the *target* that the ramp curve
// aims for, so it nudges the ceiling, not the immediate daily limit.

import { and, eq, gte, sql } from 'drizzle-orm';
import { mailbox, emailEvent } from '@ces/db';
import { DEFAULTS } from '@ces/config';
import { db } from '../lib/db';

const DAY_MS = 24 * 60 * 60 * 1000;

const MIN_TARGET = 10;
const MAX_TARGET = DEFAULTS.gmail.workspaceDailyExternalCap;

export type SmartAdjustResult = {
  mailboxId: number;
  email: string;
  previousTarget: number;
  newTarget: number;
  bounceRatePct: number;
  spamRatePct: number;
  reason: string;
};

async function loadRecentRates(mailboxId: number): Promise<{
  sends: number;
  bounces: number;
  spam: number;
}> {
  const since = new Date(Date.now() - 7 * DAY_MS);
  const rows = await db
    .select({
      type: emailEvent.type,
      c: sql<number>`count(*)::int`,
    })
    .from(emailEvent)
    .where(
      and(eq(emailEvent.mailboxId, mailboxId), gte(emailEvent.occurredAt, since)),
    )
    .groupBy(emailEvent.type);
  let sends = 0;
  let bounces = 0;
  let spam = 0;
  for (const r of rows) {
    if (r.type === 'sent') sends = r.c;
    else if (r.type === 'bounced') bounces = r.c;
    // Spam feedback still lives in external systems (Postmaster Tools),
    // not represented as an event yet. Keep 0 for now.
  }
  return { sends, bounces, spam };
}

export async function smartAdjustMailbox(
  mailboxId: number,
): Promise<SmartAdjustResult | null> {
  const [m] = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.id, mailboxId))
    .limit(1);
  if (!m) return null;
  if (!m.smartAdjustEnabled) return null;

  const { sends, bounces, spam } = await loadRecentRates(mailboxId);
  const denom = Math.max(1, sends);
  const bouncePct = (bounces / denom) * 100;
  const spamPct = (spam / denom) * 100;

  let delta = 0;
  let reason = 'no change';

  if (bouncePct > 1 || spamPct > 0.15) {
    delta = -5;
    reason = `bounce=${bouncePct.toFixed(2)}% spam=${spamPct.toFixed(2)}% — cooling off`;
  } else if (
    sends >= 50 &&
    bouncePct <= 0.5 &&
    spamPct <= 0.05 &&
    m.healthScore >= 95
  ) {
    delta = 2;
    reason = `bounce=${bouncePct.toFixed(2)}% health=${m.healthScore} — nudging up`;
  }

  if (delta === 0) {
    return {
      mailboxId,
      email: m.email,
      previousTarget: m.dailyLimitTarget,
      newTarget: m.dailyLimitTarget,
      bounceRatePct: bouncePct,
      spamRatePct: spamPct,
      reason,
    };
  }

  const newTarget = Math.max(
    MIN_TARGET,
    Math.min(MAX_TARGET, m.dailyLimitTarget + delta),
  );
  if (newTarget === m.dailyLimitTarget) {
    return {
      mailboxId,
      email: m.email,
      previousTarget: m.dailyLimitTarget,
      newTarget,
      bounceRatePct: bouncePct,
      spamRatePct: spamPct,
      reason: 'at bound',
    };
  }

  await db
    .update(mailbox)
    .set({ dailyLimitTarget: newTarget, updatedAt: new Date() })
    .where(eq(mailbox.id, mailboxId));

  return {
    mailboxId,
    email: m.email,
    previousTarget: m.dailyLimitTarget,
    newTarget,
    bounceRatePct: bouncePct,
    spamRatePct: spamPct,
    reason,
  };
}

export async function runSmartAdjustSweep(): Promise<SmartAdjustResult[]> {
  const rows = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(eq(mailbox.smartAdjustEnabled, true));
  const out: SmartAdjustResult[] = [];
  for (const r of rows) {
    try {
      const res = await smartAdjustMailbox(r.id);
      if (res) out.push(res);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[smart-adjust] failed for', r.id, e);
    }
  }
  return out;
}
