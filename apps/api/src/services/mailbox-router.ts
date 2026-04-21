// Portfolio mailbox router — ARCHITECTURE.md §7.
//
// `pickMailbox` is called once per lead enrollment. It enforces:
//   1. Stickiness — a lead that's already been sent from a mailbox keeps using it.
//   2. Viability — only healthy, non-resting mailboxes with capacity left today.
//   3. Pool preference — Primed always beats Ramping; Ramping is only picked
//      when no Primed has capacity.
//   4. Weighted random by (remaining cap) × (health / 100) × (campaign-sender weight).
//   5. Per-domain rate limit (5/hour workspace-wide to the same recipient domain).

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  mailbox,
  mailboxDailyUsage,
  campaignSender,
  emailEvent,
  scheduledEmail,
} from '@ces/db';
import { DEFAULTS } from '@ces/config';
import { db } from '../lib/db';

export type RouterMailbox = {
  id: number;
  email: string;
  pool: 'primed' | 'ramping' | 'resting';
  healthStatus: 'connected' | 'disconnected' | 'paused' | 'bouncing';
  healthScore: number;
  dailyLimitCurrent: number;
  weight: number;
  usageToday: number;
  effectiveLimit: number;
  lastSendAt: Date | null;
};

function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Loads every sender attached to a campaign along with the numbers the router
 * needs to score them: daily usage, yesterday's bounce behavior (for the
 * dynamic brake), and the last-send timestamp.
 *
 * One batched query per column — small, readable, and the N here is the number
 * of senders on a campaign (typically single digits).
 */
export async function loadCampaignSenders(
  campaignId: number,
): Promise<RouterMailbox[]> {
  const senders = await db
    .select({
      mailboxRow: mailbox,
      weight: campaignSender.weight,
      active: campaignSender.active,
    })
    .from(campaignSender)
    .innerJoin(mailbox, eq(mailbox.id, campaignSender.mailboxId))
    .where(eq(campaignSender.campaignId, campaignId));

  if (senders.length === 0) return [];

  const mailboxIds = senders.map((s) => s.mailboxRow.id);

  // Today's usage rows (one per mailbox, if any).
  const today = todayUtcIso();
  const usageRows = await db
    .select()
    .from(mailboxDailyUsage)
    .where(
      and(
        eq(mailboxDailyUsage.date, today),
        inArray(mailboxDailyUsage.mailboxId, mailboxIds),
      ),
    );
  const usageByMailbox = new Map<number, number>();
  for (const row of usageRows) {
    usageByMailbox.set(row.mailboxId, row.sendsUsed);
  }

  // Yesterday's bounce counts (for the dynamic brake). One query, grouped.
  const yesterdayStart = new Date();
  yesterdayStart.setUTCHours(0, 0, 0, 0);
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
  const yesterdayEnd = new Date(yesterdayStart);
  yesterdayEnd.setUTCDate(yesterdayEnd.getUTCDate() + 1);

  const bounceRows = mailboxIds.length === 0 ? [] : await db
    .select({
      mailboxId: emailEvent.mailboxId,
      bounces: sql<number>`count(*) filter (where ${emailEvent.type} = 'bounced')::int`,
      sends: sql<number>`count(*) filter (where ${emailEvent.type} = 'sent')::int`,
    })
    .from(emailEvent)
    .where(
      and(
        gte(emailEvent.occurredAt, yesterdayStart),
        sql`${emailEvent.occurredAt} < ${yesterdayEnd.toISOString()}::timestamptz`,
        inArray(
          emailEvent.mailboxId,
          mailboxIds,
        ),
      ),
    )
    .groupBy(emailEvent.mailboxId);
  const bounceBrake = new Set<number>();
  for (const row of bounceRows) {
    if (!row.mailboxId) continue;
    // Yesterday bounce rate > 2% with any meaningful volume (≥10) trips the brake.
    if (row.sends >= 10 && row.bounces / row.sends > 0.02) {
      bounceBrake.add(row.mailboxId);
    }
  }

  // Most recent successful send per mailbox, for the 60s floor and inter-send
  // jitter. Pulled from scheduled_email rather than email_event so we include
  // the just-inserted "sending" row once sender-worker flips it.
  const lastSendRows = await db
    .select({
      mailboxId: scheduledEmail.mailboxId,
      lastAt: sql<Date | null>`max(${scheduledEmail.sentAt})`,
    })
    .from(scheduledEmail)
    .where(
      and(
        eq(scheduledEmail.status, 'sent'),
        inArray(scheduledEmail.mailboxId, mailboxIds),
      ),
    )
    .groupBy(scheduledEmail.mailboxId);
  const lastSendByMailbox = new Map<number, Date>();
  for (const row of lastSendRows) {
    // postgres-js returns `max(timestamptz)` as an ISO string, not a Date —
    // the drizzle `sql<Date | null>` annotation is only a type hint. Coerce
    // here so computeJitteredSendAt can safely call .getTime() on it.
    if (row.lastAt) {
      const d = row.lastAt instanceof Date ? row.lastAt : new Date(row.lastAt as unknown as string);
      if (!Number.isNaN(d.getTime())) lastSendByMailbox.set(row.mailboxId, d);
    }
  }

  return senders
    .filter((s) => s.active)
    .map((s) => {
      const m = s.mailboxRow;
      const usage = usageByMailbox.get(m.id) ?? 0;
      const base = m.dailyLimitCurrent;
      const effective = bounceBrake.has(m.id)
        ? Math.floor(base * DEFAULTS.health.bounceCircuitBrakeMultiplier)
        : base;
      return {
        id: m.id,
        email: m.email,
        pool: m.pool,
        healthStatus: m.healthStatus,
        healthScore: m.healthScore,
        dailyLimitCurrent: base,
        weight: s.weight,
        usageToday: usage,
        effectiveLimit: effective,
        lastSendAt: lastSendByMailbox.get(m.id) ?? null,
      };
    });
}

/**
 * Workspace-wide check: returns true if we've sent ≥5 in the last hour to the
 * given recipient domain. Stops us from flooding a single corporate mailserver
 * even if the campaign assigns different senders. (ARCHITECTURE §11 rule #3 is
 * implicit — §7 pickMailbox.domainRateLimitOk.)
 */
export async function domainSendsLastHour(
  workspaceId: number,
  recipientDomain: string,
): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(emailEvent)
    .where(
      and(
        eq(emailEvent.workspaceId, workspaceId),
        eq(emailEvent.type, 'sent'),
        gte(emailEvent.occurredAt, since),
        // Extract the domain from the payload.to column we write on every send.
        sql`lower(split_part(${emailEvent.payload}->>'to', '@', 2)) = lower(${recipientDomain})`,
      ),
    );
  return rows[0]?.c ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

function isViable(m: RouterMailbox): boolean {
  if (m.pool === 'resting') return false;
  if (m.healthStatus !== 'connected') return false;
  if (m.usageToday >= m.effectiveLimit) return false;
  return true;
}

function score(m: RouterMailbox): number {
  const remainingCap = Math.max(0, m.effectiveLimit - m.usageToday);
  return remainingCap * (m.healthScore / 100) * (m.weight / 100);
}

function weightedPick(pool: RouterMailbox[]): RouterMailbox | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((s, m) => s + Math.max(0, score(m)), 0);
  if (total <= 0) return pool[0] ?? null; // every score is 0 — just take the first
  let r = Math.random() * total;
  for (const m of pool) {
    r -= Math.max(0, score(m));
    if (r <= 0) return m;
  }
  return pool[pool.length - 1] ?? null;
}

export type PickInput = {
  senders: RouterMailbox[];
  /** If set and still viable, we return it verbatim — sticky assignment. */
  assignedMailboxId: number | null;
};

/**
 * Pure — no DB reads. Caller should `loadCampaignSenders` once per tick and
 * pass the same slice in for every enrollment.
 */
export function pickMailbox(input: PickInput): RouterMailbox | null {
  // 1. Sticky — thread continuity beats rotation. If the sticky mailbox sent
  // recently, the 10-min inter-send floor in computeJitteredSendAt will push
  // this send forward; we don't break the thread to rotate.
  if (input.assignedMailboxId !== null) {
    const sticky = input.senders.find((s) => s.id === input.assignedMailboxId);
    if (sticky && isViable(sticky)) return sticky;
    // Sticky mailbox has gone unhealthy or hit its cap. Fall through — the
    // router will re-assign from the viable set, keeping thread continuity
    // only when possible. sender-worker uses the mailbox returned here.
  }

  // 2. Viable set
  const candidates = input.senders.filter(isViable);
  if (candidates.length === 0) return null;

  // 3. Pool preference
  const primed = candidates.filter((c) => c.pool === 'primed');
  const pool = primed.length > 0 ? primed : candidates;

  // 4. Cooldown preference — among the chosen pool, prefer mailboxes that
  // haven't sent within the inter-send floor window. This is how "send from
  // another email while this one cools down" is actually enforced at pick
  // time (the floor in computeJitteredSendAt is the backstop if every mailbox
  // is hot).
  const now = Date.now();
  const cooldownMs = DEFAULTS.rateLimit.minInterSendSeconds * 1000;
  const cold = pool.filter(
    (m) => !m.lastSendAt || now - m.lastSendAt.getTime() >= cooldownMs,
  );
  const finalPool = cold.length > 0 ? cold : pool;

  // 5. Weighted random
  return weightedPick(finalPool);
}
