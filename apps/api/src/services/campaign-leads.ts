import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { campaignLead, lead, leadListMembership } from '@ces/db';
import { db } from '../lib/db';
import { getCampaign } from './campaigns';
import { getLeadListById } from './lead-lists';
import { toLeadView, type LeadView } from './leads';

export type EnrollmentView = {
  lead: LeadView;
  status: typeof campaignLead.$inferSelect.status;
  currentStep: number;
  nextSendAt: string | null;
  assignedMailboxId: number | null;
  threadId: string | null;
  addedAt: string;
};

export async function listCampaignLeads(
  campaignId: number,
  workspaceId: number,
  page: number,
  limit: number,
): Promise<{
  enrollments: EnrollmentView[];
  total: number;
  page: number;
  limit: number;
} | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;

  const [rows, totalRows] = await Promise.all([
    db
      .select({ leadRow: lead, enrollment: campaignLead })
      .from(campaignLead)
      .innerJoin(lead, eq(lead.id, campaignLead.leadId))
      .where(eq(campaignLead.campaignId, campaignId))
      .orderBy(desc(campaignLead.addedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignLead)
      .where(eq(campaignLead.campaignId, campaignId)),
  ]);

  return {
    enrollments: rows.map((r) => ({
      lead: toLeadView(r.leadRow),
      status: r.enrollment.status,
      currentStep: r.enrollment.currentStep,
      nextSendAt: r.enrollment.nextSendAt?.toISOString() ?? null,
      assignedMailboxId: r.enrollment.assignedMailboxId,
      threadId: r.enrollment.threadId,
      addedAt: r.enrollment.addedAt.toISOString(),
    })),
    total: totalRows[0]?.count ?? 0,
    page,
    limit,
  };
}

export async function attachLeadsToCampaign(
  campaignId: number,
  workspaceId: number,
  leadIds: number[],
): Promise<{ added: number } | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;
  if (leadIds.length === 0) return { added: 0 };

  // Verify lead ownership
  const owned = await db
    .select({ id: lead.id })
    .from(lead)
    .where(and(eq(lead.workspaceId, workspaceId), inArray(lead.id, leadIds)));
  if (owned.length === 0) return { added: 0 };

  await db
    .insert(campaignLead)
    .values(
      owned.map((l) => ({
        campaignId,
        leadId: l.id,
        status: 'queued' as const,
        currentStep: 0,
      })),
    )
    .onConflictDoNothing();

  return { added: owned.length };
}

export async function attachLeadListToCampaign(
  campaignId: number,
  workspaceId: number,
  listId: number,
): Promise<{ added: number } | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;
  const list = await getLeadListById(listId, workspaceId);
  if (!list) return { added: 0 };

  const memberships = await db
    .select({ leadId: leadListMembership.leadId })
    .from(leadListMembership)
    .where(eq(leadListMembership.leadListId, listId));

  return attachLeadsToCampaign(
    campaignId,
    workspaceId,
    memberships.map((m) => m.leadId),
  );
}

export async function removeLeadsFromCampaign(
  campaignId: number,
  workspaceId: number,
  leadIds: number[],
): Promise<{ removed: number }> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return { removed: 0 };
  if (leadIds.length === 0) return { removed: 0 };
  const deleted = await db
    .delete(campaignLead)
    .where(
      and(
        eq(campaignLead.campaignId, campaignId),
        inArray(campaignLead.leadId, leadIds),
      ),
    )
    .returning({ leadId: campaignLead.leadId });
  return { removed: deleted.length };
}
