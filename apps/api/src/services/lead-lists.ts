import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { lead, leadList, leadListMembership } from '@ces/db';
import { db } from '../lib/db';
import { toLeadView, type LeadView } from './leads';

export type LeadListView = {
  id: number;
  name: string;
  leadCount: number;
  createdAt: string;
};

export async function listLeadLists(workspaceId: number): Promise<LeadListView[]> {
  const rows = await db
    .select({
      id: leadList.id,
      name: leadList.name,
      createdAt: leadList.createdAt,
      leadCount: sql<number>`count(${leadListMembership.leadId})::int`,
    })
    .from(leadList)
    .leftJoin(leadListMembership, eq(leadListMembership.leadListId, leadList.id))
    .where(eq(leadList.workspaceId, workspaceId))
    .groupBy(leadList.id)
    .orderBy(desc(leadList.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    leadCount: r.leadCount,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getLeadListById(
  id: number,
  workspaceId: number,
): Promise<LeadListView | null> {
  const rows = await db
    .select({
      id: leadList.id,
      name: leadList.name,
      createdAt: leadList.createdAt,
      leadCount: sql<number>`count(${leadListMembership.leadId})::int`,
    })
    .from(leadList)
    .leftJoin(leadListMembership, eq(leadListMembership.leadListId, leadList.id))
    .where(and(eq(leadList.id, id), eq(leadList.workspaceId, workspaceId)))
    .groupBy(leadList.id)
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    leadCount: r.leadCount,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function createLeadList(
  workspaceId: number,
  name: string,
): Promise<{ id: number; name: string }> {
  const inserted = await db
    .insert(leadList)
    .values({ workspaceId, name })
    .returning({ id: leadList.id, name: leadList.name });
  if (!inserted[0]) throw new Error('lead_list_create_failed');
  return inserted[0];
}

export async function deleteLeadList(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(leadList)
    .where(and(eq(leadList.id, id), eq(leadList.workspaceId, workspaceId)))
    .returning({ id: leadList.id });
  return deleted.length > 0;
}

export async function getLeadsInList(
  listId: number,
  workspaceId: number,
  page: number,
  limit: number,
): Promise<{ leads: LeadView[]; total: number; page: number; limit: number }> {
  // Verify ownership
  const list = await getLeadListById(listId, workspaceId);
  if (!list) {
    return { leads: [], total: 0, page, limit };
  }

  const [rows, totalRows] = await Promise.all([
    db
      .select({ leadRow: lead })
      .from(leadListMembership)
      .innerJoin(lead, eq(lead.id, leadListMembership.leadId))
      .where(eq(leadListMembership.leadListId, listId))
      .orderBy(desc(lead.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadListMembership)
      .where(eq(leadListMembership.leadListId, listId)),
  ]);

  return {
    leads: rows.map((r) => toLeadView(r.leadRow)),
    total: totalRows[0]?.count ?? 0,
    page,
    limit,
  };
}

/**
 * Attach a set of leads to a list. Idempotent: ON CONFLICT DO NOTHING.
 * Verifies all lead IDs belong to the workspace before inserting.
 */
export async function addLeadsToList(
  listId: number,
  leadIds: number[],
  workspaceId: number,
): Promise<number> {
  if (leadIds.length === 0) return 0;

  // Verify list ownership
  const list = await getLeadListById(listId, workspaceId);
  if (!list) throw new Error('lead_list_not_found');

  // Filter to leads that actually belong to this workspace
  const ownedLeads = await db
    .select({ id: lead.id })
    .from(lead)
    .where(and(eq(lead.workspaceId, workspaceId), inArray(lead.id, leadIds)));

  if (ownedLeads.length === 0) return 0;

  await db
    .insert(leadListMembership)
    .values(ownedLeads.map((l) => ({ leadListId: listId, leadId: l.id })))
    .onConflictDoNothing();

  return ownedLeads.length;
}

export async function removeLeadsFromList(
  listId: number,
  leadIds: number[],
  workspaceId: number,
): Promise<number> {
  if (leadIds.length === 0) return 0;
  const list = await getLeadListById(listId, workspaceId);
  if (!list) return 0;

  const deleted = await db
    .delete(leadListMembership)
    .where(
      and(
        eq(leadListMembership.leadListId, listId),
        inArray(leadListMembership.leadId, leadIds),
      ),
    )
    .returning({ leadId: leadListMembership.leadId });
  return deleted.length;
}
