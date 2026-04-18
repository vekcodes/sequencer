// Phase 8 — Warmup pool.
//
// Every mailbox with `warmupEnabled=true` participates in a workspace-scoped
// warmup pool. On each warmup tick, we give every participating mailbox a
// per-mailbox daily quota (`warmupDailyLimit`) of benign messages to send to
// random other pool members. The messages use real Gmail sends — that's the
// only thing that actually moves the deliverability needle — and then we use
// the RECIPIENT mailbox's access token to mark the message as read + important
// and remove any SPAM label. This is the "auto-reply engagement" loop that
// makes warmup actually work.
//
// Warmup sends count against the mailbox's daily cap (§11 rule #1) — the
// mailbox router already subtracts warmupSendsUsed from the effective limit
// via the `effectiveDailyLimit` calculation, but we also increment the
// dedicated counter so the UI can distinguish warmup from real sends.

import { and, eq, lte, ne, sql } from 'drizzle-orm';
import {
  mailbox,
  emailEvent,
  mailboxDailyUsage,
  scheduledEmail,
  warmupEngagement,
} from '@ces/db';
import { db } from '../lib/db';
import { sendGmailMessage } from '../lib/gmail-send';
import { getMailboxAccessToken } from './mailbox';
import { isGoogleOAuthConfigured } from '../lib/env';
import { modifyGmailMessageLabels, type GmailMessage } from '../lib/google';

// ─────────────────────────────────────────────────────────────────────────────
// Message templates — benign, conversational, looks-like-a-human content.
// ─────────────────────────────────────────────────────────────────────────────

const WARMUP_TEMPLATES = [
  {
    subject: 'Quick thought on your last update',
    body:
      'Hey,\n\nRead your last note and wanted to say it really resonated. The point about prioritization is something I keep coming back to.\n\nHope the week is going well.\n\n- A',
  },
  {
    subject: 'Following up from Tuesday',
    body:
      "Hi,\n\nJust a quick follow-up on the numbers we talked about — everything's looking good on my end. Let me know when you have a minute to sync.\n\nCheers",
  },
  {
    subject: 'Coffee next week?',
    body:
      "Hey,\n\nNot urgent at all, but would love to grab coffee next week if you're around. Tuesday or Thursday afternoon work?\n\nThanks",
  },
  {
    subject: 'That article you mentioned',
    body:
      "Finally got around to reading that piece you recommended — really good. The section on how small teams ship is spot on.\n\nTalk soon",
  },
  {
    subject: 'Checking in',
    body:
      "Hi!\n\nHope all's well. Nothing urgent, just wanted to see how things are going on your side. Let me know if I can help with anything.\n\nTalk soon",
  },
  {
    subject: 'Thanks for the intro',
    body:
      "Hey,\n\nThanks again for making the intro last week — super helpful conversation. I owe you one.\n\nTalk soon",
  },
  {
    subject: 'Small update',
    body:
      'Quick update: the thing we chatted about is moving forward. Will send more details once I have them nailed down. Good progress though.\n\nCheers',
  },
  {
    subject: 'Reading list',
    body:
      "Hi,\n\nI started a reading list for the quarter and thought of a few things you might like. I'll send them over once I finish the first one.\n\nHope you're good",
  },
];

function pickTemplate(): (typeof WARMUP_TEMPLATES)[number] {
  return (
    WARMUP_TEMPLATES[Math.floor(Math.random() * WARMUP_TEMPLATES.length)] ??
    WARMUP_TEMPLATES[0]!
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool + quota bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns workspace-scoped warmup-enabled mailboxes other than `excludeId`. */
async function loadWarmupPartners(
  workspaceId: number,
  excludeId: number,
): Promise<Array<typeof mailbox.$inferSelect>> {
  return db
    .select()
    .from(mailbox)
    .where(
      and(
        eq(mailbox.workspaceId, workspaceId),
        eq(mailbox.warmupEnabled, true),
        eq(mailbox.healthStatus, 'connected'),
        ne(mailbox.id, excludeId),
      ),
    );
}

async function todayWarmupUsage(mailboxId: number): Promise<number> {
  const [row] = await db
    .select()
    .from(mailboxDailyUsage)
    .where(
      and(
        eq(mailboxDailyUsage.mailboxId, mailboxId),
        eq(mailboxDailyUsage.date, todayIso()),
      ),
    )
    .limit(1);
  return row?.warmupSendsUsed ?? 0;
}

/**
 * Increments both sends_used AND warmup_sends_used atomically. Warmup counts
 * against the overall daily cap (so a warmup send reduces how many campaign
 * sends the mailbox can do today) AND against its own counter (so the UI can
 * report "warmup: X of Y").
 */
async function recordWarmupSend(mailboxId: number): Promise<void> {
  const today = todayIso();
  await db.execute(sql`
    INSERT INTO mailbox_daily_usage (mailbox_id, date, sends_used, warmup_sends_used)
    VALUES (${mailboxId}, ${today}, 1, 1)
    ON CONFLICT (mailbox_id, date)
    DO UPDATE SET
      sends_used = mailbox_daily_usage.sends_used + 1,
      warmup_sends_used = mailbox_daily_usage.warmup_sends_used + 1
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-mailbox tick
// ─────────────────────────────────────────────────────────────────────────────

export type WarmupSweepItem = {
  mailboxId: number;
  email: string;
  attempted: number;
  sent: number;
  errors: string[];
};

/**
 * Sends up to `budget` warmup messages from this mailbox, each to a random
 * partner in the workspace pool. Returns an item for the sweep summary.
 */
export async function runWarmupForMailbox(
  mailboxId: number,
): Promise<WarmupSweepItem> {
  const item: WarmupSweepItem = {
    mailboxId,
    email: '',
    attempted: 0,
    sent: 0,
    errors: [],
  };

  const [mbRow] = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.id, mailboxId))
    .limit(1);
  if (!mbRow) {
    item.errors.push('mailbox_not_found');
    return item;
  }
  item.email = mbRow.email;

  if (!mbRow.warmupEnabled) {
    item.errors.push('warmup_disabled');
    return item;
  }
  if (mbRow.healthStatus !== 'connected') {
    item.errors.push(`health_${mbRow.healthStatus}`);
    return item;
  }
  if (mbRow.pool === 'resting') {
    item.errors.push('mailbox_resting');
    return item;
  }

  const used = await todayWarmupUsage(mailboxId);
  const budget = Math.max(0, mbRow.warmupDailyLimit - used);
  if (budget === 0) return item;

  const partners = await loadWarmupPartners(mbRow.workspaceId, mailboxId);
  if (partners.length === 0) {
    item.errors.push('no_partners');
    return item;
  }

  // Pull the access token once — we reuse it for every send in this tick.
  let accessToken: string;
  try {
    accessToken = await getMailboxAccessToken(mailboxId);
  } catch (e) {
    item.errors.push(
      `access_token_failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return item;
  }

  const oauthConfigured = isGoogleOAuthConfigured();

  for (let i = 0; i < budget; i++) {
    item.attempted += 1;
    const partner = partners[Math.floor(Math.random() * partners.length)];
    if (!partner) continue;
    const tpl = pickTemplate();

    // Dev fallback: without OAuth, we log the warmup event as 'failed' so you
    // can still watch counters move in the UI.
    if (!oauthConfigured) {
      await db.insert(emailEvent).values({
        workspaceId: mbRow.workspaceId,
        mailboxId: mbRow.id,
        type: 'failed',
        payload: {
          warmup: true,
          to: partner.email,
          reason: 'google_oauth_not_configured',
        },
      });
      item.errors.push('google_oauth_not_configured');
      continue;
    }

    try {
      const sendResult = await sendGmailMessage({
        accessToken,
        from: { email: mbRow.email, displayName: mbRow.displayName },
        to: partner.email,
        subject: tpl.subject,
        bodyText: tpl.body,
      });

      await recordWarmupSend(mbRow.id);
      await db.insert(emailEvent).values({
        workspaceId: mbRow.workspaceId,
        mailboxId: mbRow.id,
        type: 'sent',
        payload: {
          warmup: true,
          to: partner.email,
          gmail_message_id: sendResult.id,
          gmail_thread_id: sendResult.threadId,
          partner_mailbox_id: partner.id,
        },
      });

      await db
        .update(mailbox)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(mailbox.id, mbRow.id));

      item.sent += 1;
    } catch (e) {
      item.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return item;
}

/**
 * Warmup sweep across every warmup-enabled mailbox. Runs once per warmup tick
 * from the warmup-scheduler (every ~30 min in dev; real prod cadence depends
 * on the desired daily volume).
 */
export async function runWarmupSweep(): Promise<{
  participating: number;
  sentTotal: number;
  items: WarmupSweepItem[];
}> {
  const enabled = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(
      and(eq(mailbox.warmupEnabled, true), eq(mailbox.healthStatus, 'connected')),
    );

  const items: WarmupSweepItem[] = [];
  for (const m of enabled) {
    items.push(await runWarmupForMailbox(m.id));
  }
  return {
    participating: enabled.length,
    sentTotal: items.reduce((s, x) => s + x.sent, 0),
    items,
  };
}

// silence lints for type-only re-uses
void scheduledEmail;

// ─────────────────────────────────────────────────────────────────────────────
// Engagement loop — receive + rescue + reply
// ─────────────────────────────────────────────────────────────────────────────
//
// When a warmup message lands at another workspace mailbox, the reply-ingestion
// path calls handleWarmupInbound below. We:
//   (a) rescue it out of SPAM if Gmail filed it there,
//   (b) add IMPORTANT + remove UNREAD — the two label signals Gmail's
//       Postmaster Tools weights most heavily,
//   (c) record a warmup_engagement row with a random reply_at in 30min–12h,
//       staggered so the pool doesn't look synthetic.
//
// A separate tick (runWarmupReplyTick) picks up due engagements and sends the
// reply in the same Gmail thread. Target reply rate ~40% — not every inbound
// warmup gets answered, because a 100% reply rate is a giveaway.

const REPLY_PROBABILITY = 0.4;
const MIN_REPLY_DELAY_MS = 30 * 60 * 1000; // 30 min
const MAX_REPLY_DELAY_MS = 12 * 60 * 60 * 1000; // 12 h

const WARMUP_REPLY_TEMPLATES = [
  'Thanks for the note — good thinking on that. Will circle back next week.',
  'Got it, appreciate you flagging this. Sounds good on the approach.',
  'Makes sense. Happy to chat more when you have time.',
  'Nice, thanks for the update. Let me know if anything changes.',
  "Agreed — that's the right call. Talk soon.",
  "Perfect, appreciate it. I'll keep you posted.",
  "Thanks! Works for me. Let's pick it up next week.",
  "Got it, thanks for the heads-up. I'm on it.",
];

function pickReplyTemplate(): string {
  return (
    WARMUP_REPLY_TEMPLATES[
      Math.floor(Math.random() * WARMUP_REPLY_TEMPLATES.length)
    ] ?? WARMUP_REPLY_TEMPLATES[0]!
  );
}

export type WarmupInboundInput = {
  receiverMailbox: typeof mailbox.$inferSelect;
  partnerMailbox: typeof mailbox.$inferSelect;
  gmailMessage: GmailMessage;
  subject: string;
  bodyText: string;
};

/**
 * Called by reply-ingestion for every inbound message from another
 * warmup-enabled mailbox in the same workspace. Idempotent: repeated calls
 * for the same gmail_message_id are deduped.
 */
export async function handleWarmupInbound(
  input: WarmupInboundInput,
): Promise<void> {
  const { receiverMailbox, partnerMailbox, gmailMessage } = input;

  // Dedupe — an engagement row per inbound message.
  const [existing] = await db
    .select({ id: warmupEngagement.id })
    .from(warmupEngagement)
    .where(
      and(
        eq(warmupEngagement.mailboxId, receiverMailbox.id),
        eq(warmupEngagement.gmailMessageId, gmailMessage.id),
      ),
    )
    .limit(1);
  if (existing) return;

  // Rescue from SPAM + mark engagement labels. Best-effort — if Gmail returns
  // an error we still record the engagement so the reply still gets sent.
  let rescued = false;
  try {
    const labelIds = gmailMessage.labelIds ?? [];
    const accessToken = await getMailboxAccessToken(receiverMailbox.id);
    const remove: string[] = [];
    const add: string[] = ['IMPORTANT'];
    if (labelIds.includes('SPAM')) {
      remove.push('SPAM');
      add.push('INBOX');
      rescued = true;
    }
    if (labelIds.includes('UNREAD')) remove.push('UNREAD');
    if (labelIds.includes('CATEGORY_PROMOTIONS')) {
      remove.push('CATEGORY_PROMOTIONS');
    }
    await modifyGmailMessageLabels(accessToken, gmailMessage.id, { add, remove });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      '[warmup] label modify failed for',
      receiverMailbox.email,
      e instanceof Error ? e.message : e,
    );
  }

  // Decide whether to reply (probabilistic, ~40%). If we're not replying,
  // record the engagement as 'skipped' so reporting is still accurate.
  const willReply = Math.random() < REPLY_PROBABILITY;
  const state: 'pending' | 'skipped' = willReply ? 'pending' : 'skipped';
  const delay =
    MIN_REPLY_DELAY_MS +
    Math.floor(Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS));
  const replyAt = new Date(Date.now() + delay);

  await db.insert(warmupEngagement).values({
    workspaceId: receiverMailbox.workspaceId,
    mailboxId: receiverMailbox.id,
    partnerMailboxId: partnerMailbox.id,
    gmailThreadId: gmailMessage.threadId,
    gmailMessageId: gmailMessage.id,
    subject: input.subject,
    bodyText: input.bodyText.slice(0, 2000),
    state,
    rescuedFromSpam: rescued,
    replyAt,
  });
}

export type WarmupReplyTickResult = {
  attempted: number;
  sent: number;
  errors: string[];
};

/**
 * Processes due warmup_engagement rows. Sends a short conversational reply in
 * the same Gmail thread using the receiver mailbox (which is the other end of
 * the pool). Uses threadId + In-Reply-To so Gmail threads it correctly.
 */
export async function runWarmupReplyTick(): Promise<WarmupReplyTickResult> {
  const out: WarmupReplyTickResult = { attempted: 0, sent: 0, errors: [] };

  const due = await db
    .select()
    .from(warmupEngagement)
    .where(
      and(
        eq(warmupEngagement.state, 'pending'),
        lte(warmupEngagement.replyAt, new Date()),
      ),
    )
    .limit(50);

  for (const eng of due) {
    out.attempted += 1;
    try {
      const [mbRow] = await db
        .select()
        .from(mailbox)
        .where(eq(mailbox.id, eng.mailboxId))
        .limit(1);
      const [partnerRow] = await db
        .select()
        .from(mailbox)
        .where(eq(mailbox.id, eng.partnerMailboxId))
        .limit(1);
      if (!mbRow || !partnerRow) {
        await db
          .update(warmupEngagement)
          .set({ state: 'skipped' })
          .where(eq(warmupEngagement.id, eng.id));
        continue;
      }
      if (
        mbRow.healthStatus !== 'connected' ||
        !mbRow.warmupEnabled ||
        partnerRow.healthStatus !== 'connected'
      ) {
        await db
          .update(warmupEngagement)
          .set({ state: 'skipped' })
          .where(eq(warmupEngagement.id, eng.id));
        continue;
      }

      if (!isGoogleOAuthConfigured()) {
        await db
          .update(warmupEngagement)
          .set({ state: 'skipped' })
          .where(eq(warmupEngagement.id, eng.id));
        continue;
      }

      const accessToken = await getMailboxAccessToken(mbRow.id);
      const subjectBase = eng.subject ?? '';
      const subject = /^re:\s/i.test(subjectBase)
        ? subjectBase
        : `Re: ${subjectBase}`;

      const sent = await sendGmailMessage({
        accessToken,
        from: { email: mbRow.email, displayName: mbRow.displayName },
        to: partnerRow.email,
        subject,
        bodyText: pickReplyTemplate(),
        threadId: eng.gmailThreadId,
      });

      await db
        .update(warmupEngagement)
        .set({ state: 'replied', repliedAt: new Date() })
        .where(eq(warmupEngagement.id, eng.id));

      await db.insert(emailEvent).values({
        workspaceId: mbRow.workspaceId,
        mailboxId: mbRow.id,
        type: 'sent',
        payload: {
          warmup: true,
          warmup_reply: true,
          to: partnerRow.email,
          gmail_message_id: sent.id,
          gmail_thread_id: sent.threadId,
          rescued_from_spam: eng.rescuedFromSpam,
        },
      });

      out.sent += 1;
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return out;
}
