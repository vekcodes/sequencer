// sender-worker — ARCHITECTURE.md §8, "consumer" half.
//
// Pulls due `scheduled_email` rows (status='queued', send_at<=now) using
// Postgres `FOR UPDATE SKIP LOCKED` so multiple workers can run safely,
// re-validates state, sends via Gmail, and updates the row + enrollment +
// event log in a single transaction.
//
// This is an in-process worker — one drain pass per tick. For Phase 6 we run
// it on a 10-second timer alongside scheduler-tick. BullMQ/Redis can replace
// this in Phase 9+ without touching the transitions.

import { and, eq, lte, sql } from 'drizzle-orm';
import {
  scheduledEmail,
  campaignLead,
  lead,
  mailbox,
  mailboxDailyUsage,
  emailEvent,
  campaign,
  sequenceStep,
  blocklistEmail,
} from '@ces/db';
import { db } from '../lib/db';
import { sendGmailMessage, GmailSendError } from '../lib/gmail-send';
import { getMailboxAccessToken } from './mailbox';
import { dispatchEvent } from './webhooks';
import { generateUnsubToken } from './unsubscribe';
import {
  inSendingWindow,
  addBusinessDays,
  type CampaignScheduleLike,
} from './send-window';
import { campaignSchedule } from '@ces/db';
import { isGoogleOAuthConfigured } from '../lib/env';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DrainResult = {
  claimed: number;
  sent: number;
  failedRetryable: number;
  failedBounced: number;
  failedDisconnected: number;
  failedOther: number;
  skipped: number;
};

function emptyDrain(): DrainResult {
  return {
    claimed: 0,
    sent: 0,
    failedRetryable: 0,
    failedBounced: 0,
    failedDisconnected: 0,
    failedOther: 0,
    skipped: 0,
  };
}

const MAX_ATTEMPTS = 3;
const DRAIN_BATCH = 25;

// ─────────────────────────────────────────────────────────────────────────────
// One row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically claims up to `limit` due scheduled_email rows by flipping their
 * status from 'queued' to 'sending'. Uses `FOR UPDATE SKIP LOCKED` so
 * concurrent workers don't fight over the same rows.
 *
 * Returns the full rows for processing. If nothing is due, returns [].
 */
async function claimDueRows(limit: number): Promise<Array<typeof scheduledEmail.$inferSelect>> {
  const nowIso = new Date().toISOString();
  // Raw SQL because Drizzle doesn't support FOR UPDATE SKIP LOCKED in UPDATE...FROM.
  // All Date values are serialized as ISO strings to avoid postgres-js binding issues.
  const rows = await db.execute(sql`
    WITH due AS (
      SELECT id
      FROM scheduled_email
      WHERE status = 'queued'
        AND send_at <= ${nowIso}::timestamptz
      ORDER BY send_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE scheduled_email
    SET status = 'sending', attempt_count = attempt_count + 1
    FROM due
    WHERE scheduled_email.id = due.id
    RETURNING scheduled_email.*;
  `);
  // postgres-js returns the rows in `.rows` or as the iterable itself depending
  // on how drizzle wrapped it; normalize.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (rows as any).rows ?? (rows as any);
  // The raw rows have snake_case keys — remap to match Drizzle's inferred type.
  return Array.from(raw as Iterable<Record<string, unknown>>).map((r) => ({
    id: r.id as number,
    campaignLeadId: r.campaign_lead_id as number,
    sequenceStepId: r.sequence_step_id as number,
    sequenceStepVariantId: r.sequence_step_variant_id as number,
    mailboxId: r.mailbox_id as number,
    subjectRendered: r.subject_rendered as string,
    bodyRenderedText: r.body_rendered_text as string,
    bodyRenderedHtml: (r.body_rendered_html as string | null) ?? null,
    sendAt: new Date(r.send_at as string),
    status: r.status as 'sending',
    attemptCount: r.attempt_count as number,
    lastError: (r.last_error as string | null) ?? null,
    gmailMessageId: (r.gmail_message_id as string | null) ?? null,
    inReplyToMessageId: (r.in_reply_to_message_id as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    sentAt: r.sent_at ? new Date(r.sent_at as string) : null,
  }));
}

/**
 * Re-fetches the context a single scheduled row needs to be sent: lead,
 * mailbox, campaign, schedule, step. One query per fact for readability;
 * the batch size (~25 rows/tick) makes this cheap.
 */
async function loadRowContext(row: typeof scheduledEmail.$inferSelect) {
  const [clRow] = await db
    .select()
    .from(campaignLead)
    .where(eq(campaignLead.id, row.campaignLeadId))
    .limit(1);
  if (!clRow) return null;

  const [leadRow] = await db
    .select()
    .from(lead)
    .where(eq(lead.id, clRow.leadId))
    .limit(1);
  if (!leadRow) return null;

  const [mailboxRow] = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.id, row.mailboxId))
    .limit(1);
  if (!mailboxRow) return null;

  const [campaignRow] = await db
    .select()
    .from(campaign)
    .where(eq(campaign.id, clRow.campaignId))
    .limit(1);
  if (!campaignRow) return null;

  const [scheduleRow] = await db
    .select()
    .from(campaignSchedule)
    .where(eq(campaignSchedule.campaignId, clRow.campaignId))
    .limit(1);

  const [stepRow] = await db
    .select()
    .from(sequenceStep)
    .where(eq(sequenceStep.id, row.sequenceStepId))
    .limit(1);
  if (!stepRow) return null;

  return { clRow, leadRow, mailboxRow, campaignRow, scheduleRow, stepRow };
}

/**
 * Re-check that we still should send this row. A row can be stale by the time
 * sender-worker picks it up: the lead replied, the campaign was paused, the
 * mailbox went resting, etc. If any of these fire we short-circuit to
 * 'cancelled' (not 'failed') so retry logic doesn't kick in.
 */
function shouldStillSend(
  ctx: NonNullable<Awaited<ReturnType<typeof loadRowContext>>>,
): { ok: true } | { ok: false; reason: string } {
  const { clRow, leadRow, mailboxRow, campaignRow } = ctx;
  if (campaignRow.status !== 'active') {
    return { ok: false, reason: `campaign_${campaignRow.status}` };
  }
  if (clRow.status === 'replied' || clRow.status === 'unsubscribed' || clRow.status === 'bounced') {
    return { ok: false, reason: `lead_${clRow.status}` };
  }
  if (leadRow.status !== 'active') {
    return { ok: false, reason: `lead_status_${leadRow.status}` };
  }
  if (mailboxRow.healthStatus !== 'connected') {
    return { ok: false, reason: `mailbox_${mailboxRow.healthStatus}` };
  }
  if (mailboxRow.pool === 'resting') {
    return { ok: false, reason: 'mailbox_resting' };
  }
  return { ok: true };
}

/** Build the unsubscribe URL + mailto pair if the campaign has unsubscribe enabled. */
function unsubscribeHeaders(
  campaignRow: typeof campaign.$inferSelect,
  leadRow: typeof lead.$inferSelect,
): { url: string; mailto: string } | null {
  if (!campaignRow.canUnsubscribe) return null;
  const token = generateUnsubToken(campaignRow.id, leadRow.id);
  // The base URL should come from env in production. For now we derive it
  // from WEB_ORIGIN (the API is usually co-hosted or behind the same domain).
  const baseUrl = process.env.UNSUB_BASE_URL ?? process.env.WEB_ORIGIN ?? 'https://app.example.com';
  return {
    url: `${baseUrl}/unsub/${token}`,
    mailto: `unsub+${token}@app.example.com`,
  };
}

/**
 * Builds the UPSERT fragment for mailbox_daily_usage. Caller passes it to the
 * transaction's `.execute()`. Kept as a helper so both the drizzle ORM path
 * and any future raw-SQL path can share the same SQL.
 */
function mailboxUsageIncrementSql(mailboxId: number) {
  const today = new Date().toISOString().slice(0, 10);
  return sql`
    INSERT INTO mailbox_daily_usage (mailbox_id, date, sends_used, warmup_sends_used)
    VALUES (${mailboxId}, ${today}, 1, 0)
    ON CONFLICT (mailbox_id, date)
    DO UPDATE SET sends_used = mailbox_daily_usage.sends_used + 1
  `;
}

/**
 * Returns the schedule as a CampaignScheduleLike (the shape send-window wants),
 * or null when no schedule row exists.
 */
function toScheduleLike(
  row: typeof campaignSchedule.$inferSelect | undefined,
): CampaignScheduleLike | null {
  if (!row) return null;
  return {
    monday: row.monday,
    tuesday: row.tuesday,
    wednesday: row.wednesday,
    thursday: row.thursday,
    friday: row.friday,
    saturday: row.saturday,
    sunday: row.sunday,
    startTime: row.startTime,
    endTime: row.endTime,
    timezone: row.timezone,
    avoidHoursLocal: (row.avoidHoursLocal as string[] | null) ?? [],
  };
}

async function handleBounce(
  ctx: NonNullable<Awaited<ReturnType<typeof loadRowContext>>>,
  row: typeof scheduledEmail.$inferSelect,
  errorMessage: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(scheduledEmail)
      .set({ status: 'bounced', lastError: errorMessage })
      .where(eq(scheduledEmail.id, row.id));

    await tx
      .update(campaignLead)
      .set({ status: 'bounced', completedAt: new Date() })
      .where(eq(campaignLead.id, ctx.clRow.id));

    await tx
      .update(lead)
      .set({ status: 'bounced', updatedAt: new Date() })
      .where(eq(lead.id, ctx.leadRow.id));

    // Auto-add to the workspace blocklist (ARCHITECTURE §8).
    await tx
      .insert(blocklistEmail)
      .values({
        workspaceId: ctx.campaignRow.workspaceId,
        email: ctx.leadRow.email,
        reason: 'hard bounce',
      })
      .onConflictDoNothing();

    await tx.insert(emailEvent).values({
      workspaceId: ctx.campaignRow.workspaceId,
      campaignId: ctx.campaignRow.id,
      campaignLeadId: ctx.clRow.id,
      mailboxId: row.mailboxId,
      scheduledEmailId: row.id,
      type: 'bounced',
      payload: { reason: errorMessage, to: ctx.leadRow.email },
    });

    // Mailbox consecutive-bounce counter.
    await tx
      .update(mailbox)
      .set({
        consecutiveBounceCount: sql`${mailbox.consecutiveBounceCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(mailbox.id, row.mailboxId));
  });

  // Fire-and-forget webhook.
  dispatchEvent(ctx.campaignRow.workspaceId, 'lead_bounced', {
    campaign_id: ctx.campaignRow.id,
    lead_id: ctx.leadRow.id,
    email: ctx.leadRow.email,
    mailbox_id: row.mailboxId,
  }).catch(() => {});
}

async function handleDisconnect(
  ctx: NonNullable<Awaited<ReturnType<typeof loadRowContext>>>,
  row: typeof scheduledEmail.$inferSelect,
  errorMessage: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Put the row back to queued so retry picks it up once the mailbox reconnects.
    await tx
      .update(scheduledEmail)
      .set({
        status: 'queued',
        lastError: errorMessage,
        // Defer it 30 minutes so we don't pound the dead mailbox.
        sendAt: new Date(Date.now() + 30 * 60 * 1000),
      })
      .where(eq(scheduledEmail.id, row.id));

    await tx
      .update(mailbox)
      .set({
        healthStatus: 'disconnected',
        pauseReason: 'OAuth refresh failed — please reconnect',
        updatedAt: new Date(),
      })
      .where(eq(mailbox.id, row.mailboxId));

    await tx.insert(emailEvent).values({
      workspaceId: ctx.campaignRow.workspaceId,
      campaignId: ctx.campaignRow.id,
      mailboxId: row.mailboxId,
      type: 'failed',
      payload: { reason: 'mailbox_disconnected', error: errorMessage },
    });
  });
}

async function handleRetry(
  row: typeof scheduledEmail.$inferSelect,
  errorMessage: string,
): Promise<void> {
  const newStatus = row.attemptCount >= MAX_ATTEMPTS ? 'failed' : 'queued';
  // Exponential backoff: 1 min, 5 min, 25 min, cap at 2h.
  const backoffMin = Math.min(120, 1 * Math.pow(5, row.attemptCount - 1));
  await db
    .update(scheduledEmail)
    .set({
      status: newStatus,
      lastError: errorMessage,
      sendAt:
        newStatus === 'queued'
          ? new Date(Date.now() + backoffMin * 60 * 1000)
          : row.sendAt,
    })
    .where(eq(scheduledEmail.id, row.id));
}

async function handleSuccess(
  ctx: NonNullable<Awaited<ReturnType<typeof loadRowContext>>>,
  row: typeof scheduledEmail.$inferSelect,
  result: { id: string; threadId: string; rfc822MessageId: string | null },
): Promise<void> {
  const now = new Date();
  const schedule = toScheduleLike(ctx.scheduleRow);

  await db.transaction(async (tx) => {
    // 1. Flip the scheduled_email row to sent.
    await tx
      .update(scheduledEmail)
      .set({
        status: 'sent',
        sentAt: now,
        gmailMessageId: result.id,
      })
      .where(eq(scheduledEmail.id, row.id));

    // 2. Log the sent event.
    await tx.insert(emailEvent).values({
      workspaceId: ctx.campaignRow.workspaceId,
      campaignId: ctx.campaignRow.id,
      campaignLeadId: ctx.clRow.id,
      mailboxId: row.mailboxId,
      scheduledEmailId: row.id,
      type: 'sent',
      payload: {
        to: ctx.leadRow.email,
        gmail_message_id: result.id,
        gmail_thread_id: result.threadId,
      },
    });

    // 3. Bump the mailbox daily usage counter.
    await tx.execute(mailboxUsageIncrementSql(row.mailboxId));
    await tx
      .update(mailbox)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(mailbox.id, row.mailboxId));

    // 4. Advance the enrollment.
    const justSentStepOrder = ctx.stepRow.stepOrder;
    const newCurrentStep = justSentStepOrder;
    const isFirstSuccessfulSend = ctx.clRow.currentStep === 0;

    // Look for the next step.
    const [nextStep] = await tx
      .select()
      .from(sequenceStep)
      .where(
        and(
          eq(sequenceStep.campaignId, ctx.campaignRow.id),
          eq(sequenceStep.stepOrder, justSentStepOrder + 1),
        ),
      )
      .limit(1);

    if (nextStep) {
      // Compute next_send_at by adding the next step's wait.
      const nextSendAt = schedule
        ? addBusinessDays(now, nextStep.waitInBusinessDays, schedule)
        : new Date(now.getTime() + nextStep.waitInBusinessDays * 24 * 60 * 60 * 1000);

      await tx
        .update(campaignLead)
        .set({
          currentStep: newCurrentStep,
          nextSendAt,
          status: 'active',
          // Cement stickiness on first successful send.
          ...(isFirstSuccessfulSend
            ? {
                assignedMailboxId: row.mailboxId,
                threadId: result.threadId,
                firstMessageId: result.rfc822MessageId,
              }
            : {}),
        })
        .where(eq(campaignLead.id, ctx.clRow.id));
    } else {
      // Sequence finished for this lead.
      await tx
        .update(campaignLead)
        .set({
          currentStep: newCurrentStep,
          status: 'completed',
          completedAt: now,
          nextSendAt: null,
          ...(isFirstSuccessfulSend
            ? {
                assignedMailboxId: row.mailboxId,
                threadId: result.threadId,
                firstMessageId: result.rfc822MessageId,
              }
            : {}),
        })
        .where(eq(campaignLead.id, ctx.clRow.id));
    }
  });
}

/**
 * Processes a single claimed row end-to-end. Never throws — errors are
 * converted into status transitions on the row so the drain loop can continue.
 */
async function processRow(
  row: typeof scheduledEmail.$inferSelect,
  result: DrainResult,
): Promise<void> {
  const ctx = await loadRowContext(row);
  if (!ctx) {
    // Orphaned row (lead or mailbox deleted) — cancel it.
    await db
      .update(scheduledEmail)
      .set({ status: 'cancelled', lastError: 'orphaned_context' })
      .where(eq(scheduledEmail.id, row.id));
    result.skipped += 1;
    return;
  }

  const validity = shouldStillSend(ctx);
  if (!validity.ok) {
    await db
      .update(scheduledEmail)
      .set({ status: 'cancelled', lastError: validity.reason })
      .where(eq(scheduledEmail.id, row.id));
    result.skipped += 1;
    return;
  }

  // Re-check the window — if the row landed outside it (clock drift, schedule
  // edit), push it forward to the next valid slot and bail.
  const schedule = toScheduleLike(ctx.scheduleRow);
  if (schedule && !inSendingWindow(schedule, new Date())) {
    await db
      .update(scheduledEmail)
      .set({
        status: 'queued',
        sendAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .where(eq(scheduledEmail.id, row.id));
    result.skipped += 1;
    return;
  }

  // Check per-mailbox cap one more time — another concurrent tick could have
  // drained it already.
  const today = new Date().toISOString().slice(0, 10);
  const [usageRow] = await db
    .select()
    .from(mailboxDailyUsage)
    .where(
      and(
        eq(mailboxDailyUsage.mailboxId, row.mailboxId),
        eq(mailboxDailyUsage.date, today),
      ),
    )
    .limit(1);
  const usedToday = usageRow?.sendsUsed ?? 0;
  if (usedToday >= ctx.mailboxRow.dailyLimitCurrent) {
    await db
      .update(scheduledEmail)
      .set({
        status: 'queued',
        sendAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(eq(scheduledEmail.id, row.id));
    result.skipped += 1;
    return;
  }

  // Dev fallback: if Google OAuth isn't configured, the worker still runs the
  // full state machine but marks rows 'failed' with a clear reason. This makes
  // Phase 6 runnable locally without wiring real OAuth yet.
  if (!isGoogleOAuthConfigured()) {
    await db
      .update(scheduledEmail)
      .set({
        status: 'failed',
        lastError: 'google_oauth_not_configured',
      })
      .where(eq(scheduledEmail.id, row.id));
    await db.insert(emailEvent).values({
      workspaceId: ctx.campaignRow.workspaceId,
      campaignId: ctx.campaignRow.id,
      campaignLeadId: ctx.clRow.id,
      mailboxId: row.mailboxId,
      scheduledEmailId: row.id,
      type: 'failed',
      payload: { reason: 'google_oauth_not_configured' },
    });
    result.failedOther += 1;
    return;
  }

  // Actually send.
  try {
    const accessToken = await getMailboxAccessToken(row.mailboxId);
    const sendResult = await sendGmailMessage({
      accessToken,
      from: { email: ctx.mailboxRow.email, displayName: ctx.mailboxRow.displayName },
      to: ctx.leadRow.email,
      subject: row.subjectRendered,
      bodyText: row.bodyRenderedText,
      inReplyToMessageId: row.inReplyToMessageId,
      threadId: ctx.stepRow.threadReply ? ctx.clRow.threadId : null,
      unsubscribe: unsubscribeHeaders(ctx.campaignRow, ctx.leadRow),
    });
    await handleSuccess(ctx, row, sendResult);
    // Fire-and-forget webhook.
    dispatchEvent(ctx.campaignRow.workspaceId, 'lead_sent', {
      campaign_id: ctx.campaignRow.id,
      lead_id: ctx.leadRow.id,
      email: ctx.leadRow.email,
      mailbox_id: row.mailboxId,
      gmail_message_id: sendResult.id,
    }).catch(() => {});
    result.sent += 1;
  } catch (e) {
    if (e instanceof GmailSendError) {
      if (e.kind === 'bad_recipient') {
        await handleBounce(ctx, row, e.message);
        result.failedBounced += 1;
        return;
      }
      if (e.kind === 'invalid_grant') {
        await handleDisconnect(ctx, row, e.message);
        result.failedDisconnected += 1;
        return;
      }
      // rate_limited / other — retry with backoff.
      await handleRetry(row, e.message);
      result.failedRetryable += 1;
      return;
    }
    // Non-Gmail error (DB blip, etc.) — retry.
    const msg = e instanceof Error ? e.message : String(e);
    await handleRetry(row, msg);
    result.failedOther += 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public drain entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runSenderDrain(): Promise<DrainResult> {
  const result = emptyDrain();
  const claimed = await claimDueRows(DRAIN_BATCH);
  result.claimed = claimed.length;

  for (const row of claimed) {
    try {
      await processRow(row, result);
    } catch (e) {
      // Catastrophic path — mark failed and continue.
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .update(scheduledEmail)
        .set({ status: 'failed', lastError: msg })
        .where(eq(scheduledEmail.id, row.id));
      result.failedOther += 1;
    }
  }
  return result;
}

// keep imports used
void lte;
