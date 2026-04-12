// Master inbox — Phase 7 backing service. Reads the `reply` table with
// workspace scoping and exposes patch ops for read/starred/archived flags.

import { and, eq, desc, sql, inArray, or, ilike } from 'drizzle-orm';
import { reply, lead, campaignLead, campaign, mailbox } from '@ces/db';
import { db } from '../lib/db';

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
};

export async function listReplies(input: ListRepliesInput): Promise<{
  replies: ReplyView[];
  total: number;
  page: number;
  limit: number;
}> {
  const conditions = [eq(reply.workspaceId, input.workspaceId)];
  if (input.filter === 'unread') conditions.push(eq(reply.read, false));
  if (input.filter === 'interested')
    conditions.push(eq(reply.classification, 'interested'));
  if (input.filter === 'starred') conditions.push(eq(reply.starred, true));
  if (input.filter === 'archived') conditions.push(eq(reply.archived, true));
  if (input.filter !== 'archived') conditions.push(eq(reply.archived, false));

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
    .where(and(eq(reply.id, id), eq(reply.workspaceId, workspaceId)))
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
    .where(eq(reply.workspaceId, workspaceId));
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
