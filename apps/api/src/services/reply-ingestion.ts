// Phase 7: reply ingestion.
//
// Two entry points:
//   - processMailboxHistory(mailboxId): walks Gmail history from the mailbox's
//     stored historyId, fetches every new INBOX message, and ingests it.
//   - ingestMessage(mailboxRow, gmailMessage): fetches + classifies + writes a
//     row into `reply`, and triggers auto-pause if appropriate.
//
// Both are safe to call concurrently — the `reply` row is keyed on
// (mailbox_id, gmail_message_id) via an opportunistic dedupe lookup, and
// downstream state flips (campaign_lead.status, scheduled_email cancellation)
// are idempotent.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  mailbox,
  reply,
  emailEvent,
  campaignLead,
  campaign,
  scheduledEmail,
  lead,
  ignorePhrase,
} from '@ces/db';
import { db } from '../lib/db';
import {
  listGmailHistory,
  fetchGmailMessage,
  getHeader,
  extractPlainBody,
  type GmailMessage,
} from '../lib/google';
import { getMailboxAccessToken } from './mailbox';
import { dispatchEvent } from './webhooks';
import { classifyWithLlm, isLlmClassifierAvailable } from '../lib/llm-classifier';
import { handleWarmupInbound } from './warmup';

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

export type ReplyClassification =
  | 'interested'
  | 'not_interested'
  | 'neutral'
  | 'auto_reply'
  | 'unknown';

/**
 * Rule-based classifier. Phase 7 ships with this (+ ignore_phrases) only —
 * the LLM branch lands in Phase 9 once we add a vendor selector. The rules
 * cover the 80% case and are deterministic + free.
 */
export function classifyReply(
  subject: string,
  body: string,
  fromEmail: string,
  ignorePhrasesList: string[],
): ReplyClassification {
  const haystack = `${subject}\n${body}`.toLowerCase();
  const from = fromEmail.toLowerCase();

  // Mailer daemons / bounces — the bounce handler cares about these separately.
  if (
    from.includes('mailer-daemon') ||
    from.includes('postmaster@') ||
    from.includes('noreply') ||
    from.includes('no-reply')
  ) {
    return 'auto_reply';
  }

  // User-configured ignore phrases (out-of-office templates usually).
  for (const phrase of ignorePhrasesList) {
    if (phrase && haystack.includes(phrase.toLowerCase())) return 'auto_reply';
  }

  // Standard out-of-office heuristics.
  const autoSignals = [
    'out of office',
    'out-of-office',
    'on vacation',
    'automatic reply',
    'auto-reply',
    'i am currently away',
    'currently out of the office',
    'will be out of the office',
  ];
  if (autoSignals.some((s) => haystack.includes(s))) return 'auto_reply';

  const positiveSignals = [
    'interested',
    'sounds good',
    'let\'s chat',
    'let\'s talk',
    'love to learn more',
    'would love to',
    'yes please',
    'schedule a call',
    'book a time',
    'book a meeting',
    'tell me more',
  ];
  const negativeSignals = [
    'not interested',
    'no thanks',
    'no thank you',
    'unsubscribe',
    'remove me',
    'stop emailing',
    'do not contact',
    'don\'t contact',
    'please stop',
    'not a fit',
  ];

  if (negativeSignals.some((s) => haystack.includes(s))) return 'not_interested';
  if (positiveSignals.some((s) => haystack.includes(s))) return 'interested';
  return 'neutral';
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread/lead lookup
// ─────────────────────────────────────────────────────────────────────────────

type LookupResult = {
  campaignLeadRow: typeof campaignLead.$inferSelect;
  campaignRow: typeof campaign.$inferSelect;
  leadRow: typeof lead.$inferSelect;
};

/**
 * Maps an inbound message to a campaign_lead by trying in order:
 *   1. gmailThreadId match on a known enrollment (best).
 *   2. Lead email match in ANY active campaign in the workspace (fallback).
 *
 * Returns null if neither hits — the reply is "untracked" and we still save it
 * to master inbox but don't advance enrollment state.
 */
async function lookupEnrollment(
  workspaceId: number,
  gmailThreadId: string,
  fromEmail: string,
): Promise<LookupResult | null> {
  // (1) Thread match.
  const [byThread] = await db
    .select({
      cl: campaignLead,
      c: campaign,
      l: lead,
    })
    .from(campaignLead)
    .innerJoin(campaign, eq(campaign.id, campaignLead.campaignId))
    .innerJoin(lead, eq(lead.id, campaignLead.leadId))
    .where(
      and(
        eq(campaign.workspaceId, workspaceId),
        eq(campaignLead.threadId, gmailThreadId),
      ),
    )
    .limit(1);
  if (byThread) {
    return {
      campaignLeadRow: byThread.cl,
      campaignRow: byThread.c,
      leadRow: byThread.l,
    };
  }

  // (2) Lead-email match — prefer an enrollment in an active campaign.
  const [byEmail] = await db
    .select({
      cl: campaignLead,
      c: campaign,
      l: lead,
    })
    .from(campaignLead)
    .innerJoin(campaign, eq(campaign.id, campaignLead.campaignId))
    .innerJoin(lead, eq(lead.id, campaignLead.leadId))
    .where(
      and(
        eq(campaign.workspaceId, workspaceId),
        eq(lead.email, fromEmail),
        eq(campaign.status, 'active'),
      ),
    )
    .limit(1);
  if (byEmail) {
    return {
      campaignLeadRow: byEmail.cl,
      campaignRow: byEmail.c,
      leadRow: byEmail.l,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

/** Extracts an email address from a header like `"Name" <foo@bar.com>`. */
function extractAddress(headerValue: string): { name: string | null; email: string } {
  const match = headerValue.match(/^(?:"?([^"<]*)"?\s*)?<?([^>\s]+@[^>\s]+)>?/);
  if (!match || !match[2]) return { name: null, email: headerValue.trim() };
  return {
    name: (match[1] ?? '').trim() || null,
    email: match[2].trim(),
  };
}

async function loadIgnorePhrases(workspaceId: number): Promise<string[]> {
  const rows = await db
    .select({ phrase: ignorePhrase.phrase })
    .from(ignorePhrase)
    .where(eq(ignorePhrase.workspaceId, workspaceId));
  return rows.map((r) => r.phrase);
}

export type IngestResult = {
  replyId: number | null;
  classification: ReplyClassification;
  skipped: boolean;
  reason?: string;
};

/**
 * Write-once ingestion of a single message. If we've already ingested it
 * (dedupe by mailbox_id + gmail_message_id), returns skipped=true.
 */
export async function ingestMessage(
  mailboxRow: typeof mailbox.$inferSelect,
  msg: GmailMessage,
): Promise<IngestResult> {
  // Skip messages sent by us — Gmail's history feed includes SENT label
  // transitions too. We only care about inbound INBOX messages.
  const labelIds = msg.labelIds ?? [];
  if (!labelIds.includes('INBOX')) {
    return { replyId: null, classification: 'unknown', skipped: true, reason: 'not_inbox' };
  }
  if (labelIds.includes('SENT') && !labelIds.includes('INBOX')) {
    return { replyId: null, classification: 'unknown', skipped: true, reason: 'sent_label' };
  }

  // Dedupe.
  const [existing] = await db
    .select({ id: reply.id })
    .from(reply)
    .where(
      and(
        eq(reply.mailboxId, mailboxRow.id),
        eq(reply.gmailMessageId, msg.id),
      ),
    )
    .limit(1);
  if (existing) {
    return { replyId: existing.id, classification: 'unknown', skipped: true, reason: 'duplicate' };
  }

  const fromRaw = getHeader(msg, 'From') ?? '';
  const toRaw = getHeader(msg, 'To') ?? mailboxRow.email;
  const subject = getHeader(msg, 'Subject') ?? '';
  const from = extractAddress(fromRaw);
  const to = extractAddress(toRaw);
  const body = extractPlainBody(msg);
  const receivedAt = new Date(Number(msg.internalDate || Date.now()));

  // Ignore messages we sent to ourselves.
  if (from.email.toLowerCase() === mailboxRow.email.toLowerCase()) {
    return { replyId: null, classification: 'unknown', skipped: true, reason: 'self_loopback' };
  }

  // Warmup partner mail: route to the warmup engagement handler (it schedules
  // an auto-reply + rescues from SPAM + marks IMPORTANT). Never saved to the
  // master inbox — warmup traffic is not a lead reply.
  const [senderMailbox] = await db
    .select()
    .from(mailbox)
    .where(
      and(
        eq(mailbox.workspaceId, mailboxRow.workspaceId),
        eq(mailbox.email, from.email.toLowerCase()),
      ),
    )
    .limit(1);
  if (senderMailbox && senderMailbox.warmupEnabled) {
    await handleWarmupInbound({
      receiverMailbox: mailboxRow,
      partnerMailbox: senderMailbox,
      gmailMessage: msg,
      subject,
      bodyText: body,
    });
    return {
      replyId: null,
      classification: 'unknown',
      skipped: true,
      reason: 'warmup_inbound',
    };
  }

  // Tracked leads only: resolve enrollment FIRST. Untracked mail is dropped
  // before it hits the reply table or the LLM — master inbox shows only
  // replies from leads we actively sent to, and we don't burn Claude credits
  // classifying newsletters or random inbox noise.
  const lookup = await lookupEnrollment(mailboxRow.workspaceId, msg.threadId, from.email);
  if (!lookup) {
    return {
      replyId: null,
      classification: 'unknown',
      skipped: true,
      reason: 'untracked',
    };
  }

  const ignorePhrases = await loadIgnorePhrases(mailboxRow.workspaceId);
  const ruleResult = classifyReply(subject, body, from.email, ignorePhrases);
  let classification: ReplyClassification;
  if (isLlmClassifierAvailable() && ruleResult !== 'auto_reply') {
    const llmResult = await classifyWithLlm(subject, body, from.email);
    classification = llmResult ?? ruleResult;
  } else {
    classification = ruleResult;
  }

  const [inserted] = await db
    .insert(reply)
    .values({
      workspaceId: mailboxRow.workspaceId,
      campaignLeadId: lookup.campaignLeadRow.id,
      mailboxId: mailboxRow.id,
      gmailThreadId: msg.threadId,
      gmailMessageId: msg.id,
      subject,
      bodyText: body,
      bodyHtml: null,
      fromEmail: from.email,
      fromName: from.name,
      toEmail: to.email,
      classification,
      read: false,
      starred: false,
      archived: false,
      receivedAt,
    })
    .returning({ id: reply.id });

  // Log the `replied` event for analytics + webhooks.
  await db.insert(emailEvent).values({
    workspaceId: mailboxRow.workspaceId,
    campaignId: lookup.campaignRow.id,
    campaignLeadId: lookup.campaignLeadRow.id,
    mailboxId: mailboxRow.id,
    type: 'replied',
    payload: {
      from: from.email,
      classification,
      gmail_thread_id: msg.threadId,
      gmail_message_id: msg.id,
    },
  });

  // Fire webhooks for the reply.
  dispatchEvent(mailboxRow.workspaceId, 'lead_replied', {
    campaign_id: lookup.campaignRow.id,
    lead_id: lookup.leadRow.id,
    email: from.email,
    classification,
    reply_id: inserted?.id ?? null,
  }).catch(() => {});
  if (classification === 'interested') {
    dispatchEvent(mailboxRow.workspaceId, 'lead_interested', {
      campaign_id: lookup.campaignRow.id,
      lead_id: lookup.leadRow.id,
      email: from.email,
      reply_id: inserted?.id ?? null,
    }).catch(() => {});
  }

  // Auto-pause the lead on non-auto replies, per campaign.reply_behavior.
  if (
    classification !== 'auto_reply' &&
    lookup.campaignRow.replyBehavior === 'auto_pause_lead'
  ) {
    await db.transaction(async (tx) => {
      await tx
        .update(campaignLead)
        .set({ status: 'replied' })
        .where(eq(campaignLead.id, lookup.campaignLeadRow.id));

      // Cancel any queued follow-ups.
      await tx
        .update(scheduledEmail)
        .set({ status: 'cancelled', lastError: 'lead_replied' })
        .where(
          and(
            eq(scheduledEmail.campaignLeadId, lookup.campaignLeadRow.id),
            eq(scheduledEmail.status, 'queued'),
          ),
        );

      // Also flip the lead row so it can't be enrolled again.
      await tx
        .update(lead)
        .set({ status: 'replied', updatedAt: new Date() })
        .where(eq(lead.id, lookup.leadRow.id));
    });
  }

  return {
    replyId: inserted?.id ?? null,
    classification,
    skipped: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// History walk
// ─────────────────────────────────────────────────────────────────────────────

export type ProcessHistoryResult = {
  mailboxId: number;
  messagesProcessed: number;
  messagesIngested: number;
  skipped: number;
  errors: string[];
};

/**
 * Walks Gmail history for a single mailbox, starting from its stored
 * `googleHistoryId`. Every new message gets fetched and handed to
 * `ingestMessage`. On success, `googleHistoryId` is advanced to the latest
 * history id Gmail returns.
 */
export async function processMailboxHistory(
  mailboxId: number,
): Promise<ProcessHistoryResult> {
  const out: ProcessHistoryResult = {
    mailboxId,
    messagesProcessed: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  const [mbRow] = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.id, mailboxId))
    .limit(1);
  if (!mbRow) {
    out.errors.push('mailbox_not_found');
    return out;
  }
  if (!mbRow.googleHistoryId) {
    out.errors.push('no_start_history_id');
    return out;
  }

  let accessToken: string;
  try {
    accessToken = await getMailboxAccessToken(mailboxId);
  } catch (e) {
    out.errors.push(`access_token_failed: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  // Collect all new message ids across paged history responses.
  const messageIds: string[] = [];
  let latestHistoryId: string = mbRow.googleHistoryId;
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await listGmailHistory(accessToken, mbRow.googleHistoryId, pageToken);
    latestHistoryId = res.historyId ?? latestHistoryId;
    for (const entry of res.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) messageIds.push(added.message.id);
      }
    }
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }

  // De-duplicate within the batch (a single message can appear in multiple
  // history entries if it changed labels).
  const unique = Array.from(new Set(messageIds));
  for (const id of unique) {
    try {
      const msg = await fetchGmailMessage(accessToken, id);
      out.messagesProcessed += 1;
      const r = await ingestMessage(mbRow, msg);
      if (r.skipped) out.skipped += 1;
      else out.messagesIngested += 1;
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Advance the history cursor.
  await db
    .update(mailbox)
    .set({ googleHistoryId: latestHistoryId, updatedAt: new Date() })
    .where(eq(mailbox.id, mailboxId));

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk
// ─────────────────────────────────────────────────────────────────────────────

/** Process history for every connected mailbox. Used by the cron fallback. */
export async function processAllConnectedMailboxes(): Promise<ProcessHistoryResult[]> {
  const rows = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(
      and(
        eq(mailbox.healthStatus, 'connected'),
        // Don't waste calls on mailboxes that never finished the OAuth handshake.
        sql`${mailbox.googleHistoryId} IS NOT NULL`,
      ),
    );
  const out: ProcessHistoryResult[] = [];
  for (const r of rows) {
    try {
      out.push(await processMailboxHistory(r.id));
    } catch (e) {
      out.push({
        mailboxId: r.id,
        messagesProcessed: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [e instanceof Error ? e.message : String(e)],
      });
    }
  }
  return out;
}

// silence unused-import linters
void inArray;
