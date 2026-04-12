import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { mailbox, mailboxHealthSnapshot, emailEvent } from '@ces/db';
import { DEFAULTS } from '@ces/config';
import { db } from '../lib/db';

// Implements ARCHITECTURE.md §9 — the nightly mailbox health worker.
//
// For each mailbox we:
//   1. Aggregate the last 30 days of email_events (sends/bounces/opens/replies/spam)
//   2. Compute health_score per the formula:
//        0.5 × Placement + 0.3 × (100 − Bounce%) + 0.2 × (100 − Spam%)
//   3. Apply pool transitions in priority order (spam → bounce → health → promote → recover)
//   4. Advance the ramp curve if still ramping and no triggers fired
//   5. Persist the new pool/limit on the mailbox row
//   6. Upsert today's mailbox_health_snapshot for trend charts

const DAY_MS = 1000 * 60 * 60 * 24;
const HOUR_MS = 1000 * 60 * 60;

export type HealthRunResult = {
  mailboxId: number;
  email: string;
  previousPool: 'primed' | 'ramping' | 'resting';
  newPool: 'primed' | 'ramping' | 'resting';
  previousLimit: number;
  newLimit: number;
  healthScore: number;
  bounceRateBps: number;
  spamRateBps: number;
  reason: string;
};

/** Picks the highest curve point whose day index is <= daysSinceStart, capped at target. */
function nextRampLimit(daysSinceStart: number, target: number): number {
  let limit: number = DEFAULTS.mailbox.dailyLimitInitial;
  for (const [day, cap] of DEFAULTS.mailbox.rampCurve) {
    if (day <= daysSinceStart) limit = cap;
  }
  return Math.min(limit, target);
}

function todayLocalIso(): string {
  const d = new Date();
  // Use UTC date; fine for now — Phase 8+ will localize per mailbox.
  return d.toISOString().slice(0, 10);
}

export async function computeMailboxHealth(
  mailboxId: number,
): Promise<HealthRunResult> {
  const rows = await db.select().from(mailbox).where(eq(mailbox.id, mailboxId)).limit(1);
  const m = rows[0];
  if (!m) throw new Error('mailbox_not_found');

  // ── 1. Aggregate the last 30 days of email_events ─────────────────────────
  const since = new Date(Date.now() - 30 * DAY_MS);
  const stats = await db
    .select({
      type: emailEvent.type,
      // postgres count() returns bigint; cast to int for js
      count: sql<number>`count(*)::int`,
    })
    .from(emailEvent)
    .where(
      and(eq(emailEvent.mailboxId, mailboxId), gte(emailEvent.occurredAt, since)),
    )
    .groupBy(emailEvent.type);

  let sends = 0;
  let bounces = 0;
  let opens = 0;
  let replies = 0;
  // Spam complaints will come from Gmail Postmaster Tools in a later phase.
  // For now we have no source — keep at 0.
  const spam = 0;

  for (const s of stats) {
    if (s.type === 'sent') sends = s.count;
    else if (s.type === 'bounced') bounces = s.count;
    else if (s.type === 'opened') opens = s.count;
    else if (s.type === 'replied') replies = s.count;
  }

  // ── 2. Health score (rates stored as basis points) ────────────────────────
  const denom = Math.max(1, sends);
  const bounceRateBps = Math.round((bounces / denom) * 10_000);
  const spamRateBps = Math.round((spam / denom) * 10_000);
  const placement = m.placementScore;
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        0.5 * placement +
          0.3 * (100 - bounceRateBps / 100) +
          0.2 * (100 - spamRateBps / 100),
      ),
    ),
  );

  // ── 3. Pool transitions (priority order — first match wins) ───────────────
  const previousPool = m.pool;
  const previousLimit = m.dailyLimitCurrent;
  let newPool: 'primed' | 'ramping' | 'resting' = previousPool;
  let restingUntil: Date | null = m.restingUntil;
  let restingReason: 'spam' | 'bounce' | 'health' | 'manual' | null = m.restingReason;
  let reason = 'no change';
  const now = new Date();

  if (spamRateBps >= DEFAULTS.health.spamComplaintHardCeilingBps) {
    newPool = 'resting';
    restingReason = 'spam';
    restingUntil = null; // requires manual unblock
    reason = `spam rate ${(spamRateBps / 100).toFixed(2)}% ≥ 0.30% — manual unblock required`;
  } else if (bounceRateBps >= DEFAULTS.health.bounceRateCircuitBreakerBps) {
    newPool = 'resting';
    restingReason = 'bounce';
    restingUntil = new Date(
      Date.now() + DEFAULTS.health.bounceCircuitDurationHours * HOUR_MS,
    );
    reason = `bounce rate ${(bounceRateBps / 100).toFixed(2)}% ≥ 2.00% — 48h rest`;
  } else if (healthScore < DEFAULTS.health.healthScoreMin) {
    newPool = 'resting';
    restingReason = 'health';
    restingUntil = new Date(
      Date.now() + DEFAULTS.health.healthRestDurationDays * DAY_MS,
    );
    reason = `health score ${healthScore} < ${DEFAULTS.health.healthScoreMin} — 7d rest`;
  } else if (
    previousPool === 'ramping' &&
    Date.now() - m.rampStartedAt.getTime() >=
      DEFAULTS.health.rampToPromotedDays * DAY_MS &&
    healthScore >= DEFAULTS.health.promotionMinHealth
  ) {
    newPool = 'primed';
    restingUntil = null;
    restingReason = null;
    reason = `ramp complete (${DEFAULTS.health.rampToPromotedDays}d) + health ≥ ${DEFAULTS.health.promotionMinHealth} → promoted to primed`;
  } else if (
    previousPool === 'resting' &&
    restingUntil !== null &&
    now > restingUntil &&
    healthScore >= DEFAULTS.health.promotionMinHealth
  ) {
    newPool = 'ramping';
    restingUntil = null;
    restingReason = null;
    reason = `rest period over + health ≥ ${DEFAULTS.health.promotionMinHealth} → back to ramping`;
  } else if (previousPool !== 'resting') {
    // Stable in primed/ramping — clear any stale resting fields.
    restingUntil = null;
    restingReason = null;
  }

  // ── 4. Ramp progression (only if no triggers fired and we're ramping) ────
  let newLimit = previousLimit;
  if (newPool === 'ramping') {
    const daysSinceStart =
      Math.floor((Date.now() - m.rampStartedAt.getTime()) / DAY_MS) + 1;
    newLimit = nextRampLimit(daysSinceStart, m.dailyLimitTarget);
    if (newLimit !== previousLimit && reason === 'no change') {
      reason = `ramp curve day ${daysSinceStart}: ${previousLimit} → ${newLimit}`;
    }
  } else if (newPool === 'primed') {
    // Primed mailboxes run at target capacity.
    newLimit = m.dailyLimitTarget;
  } else if (newPool === 'resting') {
    // Resting mailboxes get 0 effective sends; the limit on the row is left
    // alone so we can resume them at their previous cap.
  }

  // ── 5. Persist mailbox row ────────────────────────────────────────────────
  await db
    .update(mailbox)
    .set({
      pool: newPool,
      poolChangedAt: previousPool !== newPool ? now : m.poolChangedAt,
      restingUntil,
      restingReason,
      dailyLimitCurrent: newLimit,
      healthScore,
      bounceRate30dBps: bounceRateBps,
      spamComplaintRate30dBps: spamRateBps,
      updatedAt: now,
      ...(previousPool === 'ramping' && newPool === 'primed'
        ? { rampCompletedAt: now }
        : {}),
    })
    .where(eq(mailbox.id, mailboxId));

  // ── 6. Upsert today's snapshot ────────────────────────────────────────────
  const today = todayLocalIso();
  await db
    .insert(mailboxHealthSnapshot)
    .values({
      mailboxId,
      date: today,
      pool: newPool,
      healthScore,
      placementScore: placement,
      bounceRate30dBps: bounceRateBps,
      spamRate30dBps: spamRateBps,
      sendsCount: sends,
      opensCount: opens,
      repliesCount: replies,
      bouncesCount: bounces,
      effectiveDailyLimit: newLimit,
    })
    .onConflictDoUpdate({
      target: [mailboxHealthSnapshot.mailboxId, mailboxHealthSnapshot.date],
      set: {
        pool: newPool,
        healthScore,
        placementScore: placement,
        bounceRate30dBps: bounceRateBps,
        spamRate30dBps: spamRateBps,
        sendsCount: sends,
        opensCount: opens,
        repliesCount: replies,
        bouncesCount: bounces,
        effectiveDailyLimit: newLimit,
      },
    });

  return {
    mailboxId: m.id,
    email: m.email,
    previousPool,
    newPool,
    previousLimit,
    newLimit,
    healthScore,
    bounceRateBps,
    spamRateBps,
    reason,
  };
}

/**
 * Always processes every mailbox in a workspace. Used by the manual
 * "Recompute" button — bypasses the "skip if processed today" guard.
 */
export async function forceRunHealthForWorkspace(
  workspaceId: number,
): Promise<HealthRunResult[]> {
  const rows = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(eq(mailbox.workspaceId, workspaceId));

  const results: HealthRunResult[] = [];
  for (const m of rows) {
    try {
      results.push(await computeMailboxHealth(m.id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[mailbox-health] failed for mailbox', m.id, e);
    }
  }
  return results;
}

/**
 * Daily worker entry point. Only processes mailboxes whose latest snapshot
 * is older than today, so it's safe to call on an hourly cron.
 */
export async function runDailyHealthSweep(): Promise<{ processed: number; skipped: number }> {
  const today = todayLocalIso();

  const rows = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .leftJoin(
      mailboxHealthSnapshot,
      and(
        eq(mailboxHealthSnapshot.mailboxId, mailbox.id),
        eq(mailboxHealthSnapshot.date, today),
      ),
    )
    .where(isNull(mailboxHealthSnapshot.id));

  let processed = 0;
  for (const m of rows) {
    try {
      await computeMailboxHealth(m.id);
      processed++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[mailbox-health] sweep failed for', m.id, e);
    }
  }

  // For logging only — total mailboxes minus processed = those with a snapshot already
  const total = await db.select({ id: mailbox.id }).from(mailbox);
  return { processed, skipped: total.length - processed };
}
