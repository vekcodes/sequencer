// scheduler-tick — ARCHITECTURE.md §8.
//
// Runs every 60s. For each active campaign, it:
//   1. Checks the sending window in the campaign's TZ.
//   2. Enforces max_emails_per_day (campaign-level).
//   3. Finds `campaign_lead` rows whose `next_send_at <= now` (or whose
//      `current_step = 0` and `status = 'queued'` — i.e. freshly enrolled,
//      first-step leads).
//   4. Caps first-step enrollments to `max_new_leads_per_day`.
//   5. For each due lead: picks a mailbox, renders subject/body, computes a
//      jittered `send_at`, and inserts a `scheduled_email` row.
//
// Writes are idempotent per-lead per-step: we rely on the presence of a
// non-cancelled row in `scheduled_email` for that (campaign_lead, step) to
// avoid double-queueing. (We use current_step on campaign_lead as the source
// of truth — scheduler-tick advances `nextSendAt` into the future the moment
// it enqueues, so the next tick won't re-pick the same lead.)

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  campaign,
  campaignSchedule,
  campaignLead,
  sequenceStep,
  sequenceStepVariant,
  lead,
  blocklistEmail,
  blocklistDomain,
  scheduledEmail,
  emailEvent,
  mailbox,
} from '@ces/db';
import { db } from '../lib/db';
import { render, leadToVars } from '../lib/render';
import {
  loadCampaignSenders,
  pickMailbox,
  domainSendsLastHour,
  type RouterMailbox,
} from './mailbox-router';
import {
  inSendingWindow,
  computeJitteredSendAt,
  type CampaignScheduleLike,
} from './send-window';
import { DEFAULTS } from '@ces/config';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TickResult = {
  campaignsScanned: number;
  leadsConsidered: number;
  enqueued: number;
  deferredNoMailbox: number;
  deferredDomainLimit: number;
  deferredBlocklisted: number;
  deferredUnresolvedVars: number;
  skippedOutOfWindow: number;
  skippedDailyCap: number;
  errors: Array<{ campaignId: number; error: string }>;
};

function emptyResult(): TickResult {
  return {
    campaignsScanned: 0,
    leadsConsidered: 0,
    enqueued: 0,
    deferredNoMailbox: 0,
    deferredDomainLimit: 0,
    deferredBlocklisted: 0,
    deferredUnresolvedVars: 0,
    skippedOutOfWindow: 0,
    skippedDailyCap: 0,
    errors: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-campaign tick
// ─────────────────────────────────────────────────────────────────────────────

/** How many already-queued-or-sent scheduled_email rows exist for this campaign today. */
async function countTodaySendsOrQueue(campaignId: number): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(scheduledEmail)
    .innerJoin(campaignLead, eq(campaignLead.id, scheduledEmail.campaignLeadId))
    .where(
      and(
        eq(campaignLead.campaignId, campaignId),
        gte(scheduledEmail.createdAt, since),
        inArray(scheduledEmail.status, ['queued', 'sending', 'sent']),
      ),
    );
  return rows[0]?.c ?? 0;
}

function pickVariant<T extends { weight: number }>(variants: T[]): T | null {
  if (variants.length === 0) return null;
  const total = variants.reduce((s, v) => s + Math.max(1, v.weight), 0);
  let r = Math.random() * total;
  for (const v of variants) {
    r -= Math.max(1, v.weight);
    if (r <= 0) return v;
  }
  return variants[variants.length - 1] ?? null;
}

function domainOf(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

export async function tickCampaign(
  c: typeof campaign.$inferSelect,
  result: TickResult,
): Promise<void> {
  result.campaignsScanned += 1;

  // 1. Schedule / window
  const schedRows = await db
    .select()
    .from(campaignSchedule)
    .where(eq(campaignSchedule.campaignId, c.id))
    .limit(1);
  const scheduleRow = schedRows[0];
  if (!scheduleRow) return;
  const schedule: CampaignScheduleLike = {
    monday: scheduleRow.monday,
    tuesday: scheduleRow.tuesday,
    wednesday: scheduleRow.wednesday,
    thursday: scheduleRow.thursday,
    friday: scheduleRow.friday,
    saturday: scheduleRow.saturday,
    sunday: scheduleRow.sunday,
    startTime: scheduleRow.startTime,
    endTime: scheduleRow.endTime,
    timezone: scheduleRow.timezone,
    avoidHoursLocal: (scheduleRow.avoidHoursLocal as string[] | null) ?? [],
  };

  const now = new Date();
  if (!inSendingWindow(schedule, now)) {
    result.skippedOutOfWindow += 1;
    return;
  }

  // 2. Daily cap
  const todayCount = await countTodaySendsOrQueue(c.id);
  const remainingDaily = c.maxEmailsPerDay - todayCount;
  if (remainingDaily <= 0) {
    result.skippedDailyCap += 1;
    return;
  }

  // 3. Load sequence (one query) and senders (one query)
  const steps = await db
    .select()
    .from(sequenceStep)
    .where(eq(sequenceStep.campaignId, c.id))
    .orderBy(asc(sequenceStep.stepOrder));
  if (steps.length === 0) return;

  const stepIds = steps.map((s) => s.id);
  const variants = await db
    .select()
    .from(sequenceStepVariant)
    .where(inArray(sequenceStepVariant.sequenceStepId, stepIds));
  const variantsByStep = new Map<number, typeof variants>();
  for (const v of variants) {
    const arr = variantsByStep.get(v.sequenceStepId) ?? [];
    arr.push(v);
    variantsByStep.set(v.sequenceStepId, arr);
  }

  let senders: RouterMailbox[];
  try {
    senders = await loadCampaignSenders(c.id);
  } catch (e) {
    result.errors.push({ campaignId: c.id, error: `loadCampaignSenders: ${e instanceof Error ? e.stack ?? e.message : String(e)}` });
    return;
  }
  if (senders.length === 0) return; // nothing to send from

  // Mutable local copies — we decrement usage as we enqueue so the scorer
  // reflects the in-progress batch, not just what was on disk at tick start.
  const sendersLocal: RouterMailbox[] = senders.map((s) => ({ ...s }));
  const sendersById = new Map(sendersLocal.map((s) => [s.id, s]));

  // 4. Pull due leads — prioritised per campaign.sequence_prioritization
  const prioritiseFollowups = c.sequencePrioritization === 'followups';
  const dueRows = await db
    .select({ cl: campaignLead, leadRow: lead })
    .from(campaignLead)
    .innerJoin(lead, eq(lead.id, campaignLead.leadId))
    .where(
      and(
        eq(campaignLead.campaignId, c.id),
        inArray(campaignLead.status, ['queued', 'active']),
        or(
          isNull(campaignLead.nextSendAt),
          lte(campaignLead.nextSendAt, now),
        ),
      ),
    )
    .orderBy(
      prioritiseFollowups
        ? desc(campaignLead.currentStep)
        : asc(campaignLead.currentStep),
      asc(campaignLead.id),
    )
    .limit(remainingDaily);

  if (dueRows.length === 0) return;

  // 4a. First-step cap — enforce max_new_leads_per_day.
  const firstStepToday = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(scheduledEmail)
    .innerJoin(
      campaignLead,
      eq(campaignLead.id, scheduledEmail.campaignLeadId),
    )
    .where(
      and(
        eq(campaignLead.campaignId, c.id),
        sql`${scheduledEmail.createdAt} >= (now() at time zone 'utc')::date`,
        // Step 1 in the sequence = sequenceStep with the lowest stepOrder.
        eq(
          scheduledEmail.sequenceStepId,
          steps[0]?.id ?? -1,
        ),
      ),
    );
  const newLeadsSoFarToday = firstStepToday[0]?.c ?? 0;
  const remainingNewLeads = Math.max(
    0,
    c.maxNewLeadsPerDay - newLeadsSoFarToday,
  );

  // 4b. Pre-load blocklists for this workspace — cheap, scoped, and shared
  // across the whole batch.
  const [blockedEmailsRows, blockedDomainsRows] = await Promise.all([
    db
      .select({ email: blocklistEmail.email })
      .from(blocklistEmail)
      .where(eq(blocklistEmail.workspaceId, c.workspaceId)),
    db
      .select({ domain: blocklistDomain.domain })
      .from(blocklistDomain)
      .where(eq(blocklistDomain.workspaceId, c.workspaceId)),
  ]);
  const blockedEmails = new Set(
    blockedEmailsRows.map((r) => r.email.toLowerCase()),
  );
  const blockedDomains = new Set(
    blockedDomainsRows.map((r) => r.domain.toLowerCase()),
  );

  // Cache domain-rate-limit results to avoid N queries to the same domain.
  const domainHourCache = new Map<string, number>();
  async function sendsLastHourCached(dom: string): Promise<number> {
    const cached = domainHourCache.get(dom);
    if (cached !== undefined) return cached;
    const n = await domainSendsLastHour(c.workspaceId, dom);
    domainHourCache.set(dom, n);
    return n;
  }

  // 5. Process each due lead
  let firstStepCountdown = remainingNewLeads;
  for (const { cl, leadRow } of dueRows) {
    result.leadsConsidered += 1;

    // Skip blocklisted leads.
    const dom = domainOf(leadRow.email);
    if (
      blockedEmails.has(leadRow.email.toLowerCase()) ||
      (dom && blockedDomains.has(dom))
    ) {
      // Mark the enrollment as completed so we don't reconsider it on every tick.
      await db
        .update(campaignLead)
        .set({ status: 'unsubscribed', completedAt: new Date() })
        .where(eq(campaignLead.id, cl.id));
      result.deferredBlocklisted += 1;
      continue;
    }

    // Which step are we sending?
    const nextStepOrder = cl.currentStep + 1;
    const step = steps.find((s) => s.stepOrder === nextStepOrder);
    if (!step) {
      // Sequence complete — mark the enrollment done and move on.
      await db
        .update(campaignLead)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(campaignLead.id, cl.id));
      continue;
    }

    // Enforce first-step cap.
    const isFirstStep = nextStepOrder === 1;
    if (isFirstStep) {
      if (firstStepCountdown <= 0) continue;
      firstStepCountdown -= 1;
    }

    // Domain rate limit (workspace-wide, 5/hour).
    if (dom) {
      const sentLastHour = await sendsLastHourCached(dom);
      if (sentLastHour >= DEFAULTS.rateLimit.perDomainPerHour) {
        // Defer for 15 minutes.
        await db
          .update(campaignLead)
          .set({ nextSendAt: new Date(Date.now() + 15 * 60 * 1000) })
          .where(eq(campaignLead.id, cl.id));
        result.deferredDomainLimit += 1;
        continue;
      }
    }

    // Pick a mailbox.
    const picked = pickMailbox({
      senders: sendersLocal,
      assignedMailboxId: cl.assignedMailboxId,
    });
    if (!picked) {
      // No viable sender right now — defer 30 minutes.
      await db
        .update(campaignLead)
        .set({ nextSendAt: new Date(Date.now() + 30 * 60 * 1000) })
        .where(eq(campaignLead.id, cl.id));
      result.deferredNoMailbox += 1;
      continue;
    }

    // Pick a variant by weight.
    const stepVariants = variantsByStep.get(step.id) ?? [];
    const variant = pickVariant(stepVariants);
    if (!variant) continue;

    // Render subject + body. Spintax seed is the enrollment id → deterministic
    // per lead (so a re-tick produces the same text).
    const vars = leadToVars({
      email: leadRow.email,
      firstName: leadRow.firstName,
      lastName: leadRow.lastName,
      company: leadRow.company,
      title: leadRow.title,
      customVariables: leadRow.customVariables as Record<string, unknown> | null,
    });
    const subjectOut = render(variant.subject, vars, cl.id);
    const bodyOut = render(variant.body, vars, cl.id + 1); // different seed → different spintax

    if (subjectOut.unresolved.length > 0 || bodyOut.unresolved.length > 0) {
      // Missing required variable. Defer the enrollment by 24h so a human has
      // time to fix the lead, but don't spam the log every tick.
      await db
        .update(campaignLead)
        .set({ nextSendAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(eq(campaignLead.id, cl.id));
      result.deferredUnresolvedVars += 1;
      continue;
    }

    // Compute a jittered send-at.
    const sendAt = computeJitteredSendAt({
      schedule,
      now,
      isFirstStep,
      mailboxDailyLimit: picked.effectiveLimit,
      mailboxUsageToday: picked.usageToday,
      lastSendFromMailbox: picked.lastSendAt,
    });

    // Thread reply: attach inReplyTo + threadId only when the step wants it
    // AND we already have a thread from a prior successful send.
    const inReplyTo = step.threadReply ? cl.firstMessageId : null;

    // 6. Insert scheduled_email + advance enrollment, in one transaction.
    try {
      await db.transaction(async (tx) => {
        await tx.insert(scheduledEmail).values({
          campaignLeadId: cl.id,
          sequenceStepId: step.id,
          sequenceStepVariantId: variant.id,
          mailboxId: picked.id,
          subjectRendered: subjectOut.rendered,
          bodyRenderedText: bodyOut.rendered,
          sendAt,
          status: 'queued',
          inReplyToMessageId: inReplyTo,
        });

        // Advance the enrollment: current_step is the step we just queued, and
        // nextSendAt gets pushed to the scheduled send (+60s safety) so the next
        // scheduler tick doesn't re-pick this lead until the row is handled.
        // current_step is NOT advanced to nextStepOrder yet — sender-worker does
        // that on successful send.
        await tx
          .update(campaignLead)
          .set({
            status: 'active',
            assignedMailboxId: picked.id,
            nextSendAt: new Date(sendAt.getTime() + 60_000),
          })
          .where(eq(campaignLead.id, cl.id));
      });

      // Bookkeeping on the in-memory sender slice so subsequent leads in this
      // batch don't over-pick the same mailbox.
      const memSender = sendersById.get(picked.id);
      if (memSender) {
        memSender.usageToday += 1;
        memSender.lastSendAt = sendAt;
      }
      result.enqueued += 1;
    } catch (e) {
      result.errors.push({
        campaignId: c.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs one tick across every active campaign. Safe to call on any cadence —
 * each per-lead write is idempotent via nextSendAt being pushed into the future.
 */
export async function runSchedulerTick(): Promise<TickResult> {
  const result = emptyResult();
  const active = await db
    .select()
    .from(campaign)
    .where(eq(campaign.status, 'active'));

  for (const c of active) {
    try {
      await tickCampaign(c, result);
    } catch (e) {
      result.errors.push({
        campaignId: c.id,
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    }
  }

  return result;
}

// Silence the unused-import lint (we import `mailbox` for JSDoc/type-narrowing
// of campaign_lead.assignedMailboxId but don't reference it at runtime here).
void mailbox;
void emailEvent;
