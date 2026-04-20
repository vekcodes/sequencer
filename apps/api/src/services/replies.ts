// Master inbox — Phase 7 backing service. Reads the `reply` table with
// workspace scoping and exposes patch ops for read/starred/archived flags.

import { and, eq, desc, sql, inArray, or, ilike, isNotNull } from 'drizzle-orm';
import { reply, lead, campaignLead, campaign, mailbox } from '@ces/db';
import { db } from '../lib/db';
import { sendGmailMessage } from '../lib/gmail-send';
import { getMailboxAccessToken } from './mailbox';
import { fetchGmailMessage, getHeader } from '../lib/google';

export type ReplyView = {
  id: number;
  mailboxId: number;
  mailboxEmail: string;
  campaignId: number | null;
  campaignName: string | null;
  campaignLeadId: number | null;
  leadId: number | null;
  leadName: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string | null;
  snippet: string;
  classification: 'interested' | 'not_interested' | 'neutral' | 'auto_reply' | 'unknown';
  read: boolean;
  starred: boolean;
  archived: boolean;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  receivedAt: string;
};

function toView(row: {
  r: typeof reply.$inferSelect;
  mailboxEmail: string;
  campaignId: number | null;
  campaignName: string | null;
  leadId: number | null;
  leadFirst: string | null;
  leadLast: string | null;
}): ReplyView {
  const snippet = (row.r.bodyText ?? '').slice(0, 240).replace(/\s+/g, ' ').trim();
  const fullName = [row.leadFirst, row.leadLast].filter(Boolean).join(' ').trim() || null;
  return {
    id: row.r.id,
    mailboxId: row.r.mailboxId,
    mailboxEmail: row.mailboxEmail,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    campaignLeadId: row.r.campaignLeadId,
    leadId: row.leadId,
    leadName: fullName,
    fromEmail: row.r.fromEmail,
    fromName: row.r.fromName,
    toEmail: row.r.toEmail,
    subject: row.r.subject,
    snippet,
    classification: row.r.classification,
    read: row.r.read,
    starred: row.r.starred,
    archived: row.r.archived,
    gmailThreadId: row.r.gmailThreadId,
    gmailMessageId: row.r.gmailMessageId,
    receivedAt: row.r.receivedAt.toISOString(),
  };
}

export type ListRepliesInput = {
  workspaceId: number;
  page: number;
  limit: number;
  filter?: 'all' | 'unread' | 'interested' | 'starred' | 'archived';
  search?: string;
  /** Restrict to replies received on a specific sender mailbox. */
  mailboxId?: number;
};

export async function listReplies(input: ListRepliesInput): Promise<{
  replies: ReplyView[];
  total: number;
  page: number;
  limit: number;
}> {
  // Master inbox shows ONLY replies tied to a campaign lead. Untracked mail is
  // already dropped at ingestion, but this belt-and-suspenders filter also
  // hides any legacy rows with a null campaignLeadId.
  const conditions = [
    eq(reply.workspaceId, input.workspaceId),
    isNotNull(reply.campaignLeadId),
  ];
  if (input.filter === 'unread') conditions.push(eq(reply.read, false));
  if (input.filter === 'interested')
    conditions.push(eq(reply.classification, 'interested'));
  if (input.filter === 'starred') conditions.push(eq(reply.starred, true));
  if (input.filter === 'archived') conditions.push(eq(reply.archived, true));
  if (input.filter !== 'archived') conditions.push(eq(reply.archived, false));
  if (input.mailboxId) conditions.push(eq(reply.mailboxId, input.mailboxId));

  if (input.search) {
    const q = `%${input.search}%`;
    const searchCond = or(
      ilike(reply.fromEmail, q),
      ilike(reply.subject, q),
      ilike(reply.bodyText, q),
    );
    if (searchCond) conditions.push(searchCond);
  }

  const where = and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        r: reply,
        mailboxEmail: mailbox.email,
        campaignId: campaign.id,
        campaignName: campaign.name,
        leadId: lead.id,
        leadFirst: lead.firstName,
        leadLast: lead.lastName,
      })
      .from(reply)
      .innerJoin(mailbox, eq(mailbox.id, reply.mailboxId))
      .leftJoin(campaignLead, eq(campaignLead.id, reply.campaignLeadId))
      .leftJoin(campaign, eq(campaign.id, campaignLead.campaignId))
      .leftJoin(lead, eq(lead.id, campaignLead.leadId))
      .where(where)
      .orderBy(desc(reply.receivedAt))
      .limit(input.limit)
      .offset((input.page - 1) * input.limit),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(reply)
      .where(where),
  ]);

  return {
    replies: rows.map(toView),
    total: totalRows[0]?.c ?? 0,
    page: input.page,
    limit: input.limit,
  };
}

export async function getReply(
  id: number,
  workspaceId: number,
): Promise<ReplyView | null> {
  const [row] = await db
    .select({
      r: reply,
      mailboxEmail: mailbox.email,
      campaignId: campaign.id,
      campaignName: campaign.name,
      leadId: lead.id,
      leadFirst: lead.firstName,
      leadLast: lead.lastName,
    })
    .from(reply)
    .innerJoin(mailbox, eq(mailbox.id, reply.mailboxId))
    .leftJoin(campaignLead, eq(campaignLead.id, reply.campaignLeadId))
    .leftJoin(campaign, eq(campaign.id, campaignLead.campaignId))
    .leftJoin(lead, eq(lead.id, campaignLead.leadId))
    .where(
      and(
        eq(reply.id, id),
        eq(reply.workspaceId, workspaceId),
        isNotNull(reply.campaignLeadId),
      ),
    )
    .limit(1);
  return row ? toView(row) : null;
}

export async function updateReplyFlags(
  id: number,
  workspaceId: number,
  patch: { read?: boolean; starred?: boolean; archived?: boolean },
): Promise<ReplyView | null> {
  const set: Record<string, unknown> = {};
  if (patch.read !== undefined) set.read = patch.read;
  if (patch.starred !== undefined) set.starred = patch.starred;
  if (patch.archived !== undefined) set.archived = patch.archived;
  if (Object.keys(set).length === 0) return getReply(id, workspaceId);

  await db
    .update(reply)
    .set(set)
    .where(and(eq(reply.id, id), eq(reply.workspaceId, workspaceId)));
  return getReply(id, workspaceId);
}

/**
 * Unread / interested / total summary for the inbox header badges.
 * One grouped query.
 */
export async function getReplyCounts(workspaceId: number): Promise<{
  total: number;
  unread: number;
  interested: number;
  archived: number;
}> {
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${reply.read} = false and ${reply.archived} = false)::int`,
      interested: sql<number>`count(*) filter (where ${reply.classification} = 'interested' and ${reply.archived} = false)::int`,
      archived: sql<number>`count(*) filter (where ${reply.archived} = true)::int`,
    })
    .from(reply)
    .where(
      and(
        eq(reply.workspaceId, workspaceId),
        isNotNull(reply.campaignLeadId),
      ),
    );
  const r = rows[0];
  return {
    total: r?.total ?? 0,
    unread: r?.unread ?? 0,
    interested: r?.interested ?? 0,
    archived: r?.archived ?? 0,
  };
}

// silence unused linter
void inArray;

// ─────────────────────────────────────────────────────────────────────────────
// Reply to thread (master inbox composer)
// ─────────────────────────────────────────────────────────────────────────────

export class ReplyComposeError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Sends a reply in the original Gmail thread from the same mailbox that
 * received the reply (which is the same mailbox we used for the first cold
 * email — thread stickiness is enforced upstream in the sender-worker). Plain
 * text only, threadId + In-Reply-To set so Gmail keeps it in the same thread
 * and other MUAs thread it too.
 */
export async function replyToThread(
  replyId: number,
  workspaceId: number,
  bodyText: string,
): Promise<{ gmailMessageId: string; threadId: string }> {
  if (!bodyText.trim()) {
    throw new ReplyComposeError('empty_body', 400, 'Reply body is required');
  }

  const [row] = await db
    .select({
      r: reply,
      mb: mailbox,
      cl: campaignLead,
    })
    .from(reply)
    .innerJoin(mailbox, eq(mailbox.id, reply.mailboxId))
    .leftJoin(campaignLead, eq(campaignLead.id, reply.campaignLeadId))
    .where(and(eq(reply.id, replyId), eq(reply.workspaceId, workspaceId)))
    .limit(1);
  if (!row) {
    throw new ReplyComposeError('not_found', 404, 'Reply not found');
  }
  if (row.mb.healthStatus !== 'connected') {
    throw new ReplyComposeError(
      'mailbox_not_connected',
      409,
      `Sender mailbox ${row.mb.email} is ${row.mb.healthStatus}`,
    );
  }
  if (!row.r.gmailThreadId) {
    throw new ReplyComposeError(
      'no_thread',
      409,
      'Original message has no Gmail thread id',
    );
  }

  const accessToken = await getMailboxAccessToken(row.mb.id);

  // Pull the RFC 822 Message-ID of the message we're replying to, so other
  // clients can thread correctly. Fall back to the enrollment's stored
  // first_message_id if the fetch fails.
  let inReplyTo: string | null = null;
  if (row.r.gmailMessageId) {
    try {
      const msg = await fetchGmailMessage(accessToken, row.r.gmailMessageId);
      inReplyTo = getHeader(msg, 'Message-ID') ?? getHeader(msg, 'Message-Id');
    } catch {
      // fall through
    }
  }
  if (!inReplyTo && row.cl?.firstMessageId) {
    inReplyTo = row.cl.firstMessageId;
  }

  const subjectBase = row.r.subject ?? '';
  const subject = /^re:\s/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`;

  const sent = await sendGmailMessage({
    accessToken,
    from: { email: row.mb.email, displayName: row.mb.displayName },
    to: row.r.fromEmail,
    subject,
    bodyText,
    inReplyToMessageId: inReplyTo,
    threadId: row.r.gmailThreadId,
  });

  return { gmailMessageId: sent.id, threadId: sent.threadId };
}
