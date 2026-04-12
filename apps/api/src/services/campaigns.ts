import { and, eq, sql, desc } from 'drizzle-orm';
import {
  campaign,
  campaignSchedule,
  sequenceStep,
  sequenceStepVariant,
  campaignSender,
  campaignLead,
} from '@ces/db';
import { db } from '../lib/db';
import { DEFAULTS } from '@ces/config';

export type CampaignRow = typeof campaign.$inferSelect;
export type CampaignStatus = CampaignRow['status'];
export type CampaignType = CampaignRow['type'];

export type CampaignView = {
  id: number;
  name: string;
  status: CampaignStatus;
  type: CampaignType;

  maxEmailsPerDay: number;
  maxNewLeadsPerDay: number;

  plainText: boolean;
  openTracking: boolean;
  clickTracking: boolean;
  reputationBuilding: boolean;
  canUnsubscribe: boolean;
  unsubscribeText: string;

  sequencePrioritization: 'followups' | 'new_leads';
  replyBehavior: string;
  useLeadTimezone: boolean;
  skipHolidays: boolean;
  holidayCalendar: string | null;

  // Joined counts (filled on demand)
  leadCount: number;
  senderCount: number;
  stepCount: number;

  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function toCampaignView(
  row: CampaignRow,
  counts: { leadCount: number; senderCount: number; stepCount: number },
): CampaignView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type,
    maxEmailsPerDay: row.maxEmailsPerDay,
    maxNewLeadsPerDay: row.maxNewLeadsPerDay,
    plainText: row.plainText,
    openTracking: row.openTracking,
    clickTracking: row.clickTracking,
    reputationBuilding: row.reputationBuilding,
    canUnsubscribe: row.canUnsubscribe,
    unsubscribeText: row.unsubscribeText,
    sequencePrioritization: row.sequencePrioritization,
    replyBehavior: row.replyBehavior,
    useLeadTimezone: row.useLeadTimezone,
    skipHolidays: row.skipHolidays,
    holidayCalendar: row.holidayCalendar,
    leadCount: counts.leadCount,
    senderCount: counts.senderCount,
    stepCount: counts.stepCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export async function listCampaigns(workspaceId: number): Promise<CampaignView[]> {
  const rows = await db
    .select({
      c: campaign,
      leadCount: sql<number>`(SELECT COUNT(*)::int FROM campaign_lead WHERE campaign_id = ${campaign.id})`,
      senderCount: sql<number>`(SELECT COUNT(*)::int FROM campaign_sender WHERE campaign_id = ${campaign.id})`,
      stepCount: sql<number>`(SELECT COUNT(*)::int FROM sequence_step WHERE campaign_id = ${campaign.id})`,
    })
    .from(campaign)
    .where(eq(campaign.workspaceId, workspaceId))
    .orderBy(desc(campaign.createdAt));

  return rows.map((r) =>
    toCampaignView(r.c, {
      leadCount: r.leadCount,
      senderCount: r.senderCount,
      stepCount: r.stepCount,
    }),
  );
}

export async function getCampaign(
  id: number,
  workspaceId: number,
): Promise<CampaignView | null> {
  const rows = await db
    .select()
    .from(campaign)
    .where(and(eq(campaign.id, id), eq(campaign.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const [leadCountRow, senderCountRow, stepCountRow] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(campaignLead)
      .where(eq(campaignLead.campaignId, id)),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(campaignSender)
      .where(eq(campaignSender.campaignId, id)),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(sequenceStep)
      .where(eq(sequenceStep.campaignId, id)),
  ]);

  return toCampaignView(row, {
    leadCount: leadCountRow[0]?.c ?? 0,
    senderCount: senderCountRow[0]?.c ?? 0,
    stepCount: stepCountRow[0]?.c ?? 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Create + auto-apply default schedule and template
// ─────────────────────────────────────────────────────────────────────────────

export async function createCampaign(
  workspaceId: number,
  name: string,
  type: CampaignType = 'outbound',
): Promise<CampaignView> {
  const id = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(campaign)
      .values({ workspaceId, name, type })
      .returning({ id: campaign.id });
    const newId = inserted[0]?.id;
    if (!newId) throw new Error('campaign_create_failed');

    // Default schedule (Mon-Fri, 09:00-16:30 in America/New_York)
    await tx.insert(campaignSchedule).values({
      campaignId: newId,
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startTime: '09:00',
      endTime: '16:30',
      timezone: 'America/New_York',
      avoidHoursLocal: ['00:00-06:00', '22:00-24:00'],
    });

    // Default 6-step sequence with one variant per step
    for (const tpl of DEFAULTS.sequenceTemplate) {
      const stepRows = await tx
        .insert(sequenceStep)
        .values({
          campaignId: newId,
          stepOrder: tpl.order,
          waitInBusinessDays: tpl.waitInBusinessDays,
          threadReply: tpl.threadReply,
          stopOnReply: true,
        })
        .returning({ id: sequenceStep.id });

      const stepId = stepRows[0]?.id;
      if (!stepId) continue;

      await tx.insert(sequenceStepVariant).values({
        sequenceStepId: stepId,
        weight: 100,
        subject:
          tpl.order === 1
            ? 'Quick question, {{first_name|there}}'
            : '',
        body:
          tpl.order === 1
            ? `Hi {{first_name|there}},\n\nNoticed {{company|your team}} is doing great work. I'm reaching out because [your reason here].\n\nWorth a quick chat?\n\nBest`
            : tpl.order === 2
              ? `{{first_name|Hi there}},\n\nJust bumping this in case it got buried.\n\nBest`
              : `{{first_name|Hi}},\n\n[Step ${tpl.order} body — edit me]\n\nBest`,
      });
    }

    return newId;
  });

  const view = await getCampaign(id, workspaceId);
  if (!view) throw new Error('campaign_post_create_fetch_failed');
  return view;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update settings
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignSettingsInput = {
  name?: string;
  maxEmailsPerDay?: number;
  maxNewLeadsPerDay?: number;
  plainText?: boolean;
  openTracking?: boolean;
  clickTracking?: boolean;
  canUnsubscribe?: boolean;
  unsubscribeText?: string;
  sequencePrioritization?: 'followups' | 'new_leads';
  useLeadTimezone?: boolean;
  skipHolidays?: boolean;
  replyBehavior?: 'auto_pause_lead' | 'continue';
};

export async function updateCampaignSettings(
  id: number,
  workspaceId: number,
  input: CampaignSettingsInput,
): Promise<CampaignView | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.maxEmailsPerDay !== undefined) set.maxEmailsPerDay = input.maxEmailsPerDay;
  if (input.maxNewLeadsPerDay !== undefined)
    set.maxNewLeadsPerDay = input.maxNewLeadsPerDay;
  if (input.plainText !== undefined) set.plainText = input.plainText;
  if (input.openTracking !== undefined) set.openTracking = input.openTracking;
  if (input.clickTracking !== undefined) set.clickTracking = input.clickTracking;
  if (input.canUnsubscribe !== undefined) set.canUnsubscribe = input.canUnsubscribe;
  if (input.unsubscribeText !== undefined) set.unsubscribeText = input.unsubscribeText;
  if (input.sequencePrioritization !== undefined)
    set.sequencePrioritization = input.sequencePrioritization;
  if (input.useLeadTimezone !== undefined) set.useLeadTimezone = input.useLeadTimezone;
  if (input.skipHolidays !== undefined) set.skipHolidays = input.skipHolidays;
  if (input.replyBehavior !== undefined) set.replyBehavior = input.replyBehavior;

  const updated = await db
    .update(campaign)
    .set(set)
    .where(and(eq(campaign.id, id), eq(campaign.workspaceId, workspaceId)))
    .returning({ id: campaign.id });
  if (updated.length === 0) return null;
  return getCampaign(id, workspaceId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status transitions
// ─────────────────────────────────────────────────────────────────────────────

export type TransitionAction = 'launch' | 'pause' | 'resume' | 'archive';

export class TransitionError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export async function transitionCampaign(
  id: number,
  workspaceId: number,
  action: TransitionAction,
): Promise<CampaignView | null> {
  const current = await getCampaign(id, workspaceId);
  if (!current) return null;

  let newStatus: CampaignStatus;
  const updateExtras: Record<string, unknown> = {};

  if (action === 'launch') {
    if (current.status !== 'draft' && current.status !== 'paused') {
      throw new TransitionError(
        'invalid_transition',
        `Cannot launch from status "${current.status}"`,
      );
    }
    if (current.stepCount === 0) {
      throw new TransitionError(
        'no_sequence_steps',
        'Campaign has no sequence steps — add one before launching',
      );
    }
    if (current.senderCount === 0) {
      throw new TransitionError(
        'no_senders',
        'Campaign has no senders attached — connect a mailbox first',
      );
    }
    if (current.leadCount === 0) {
      throw new TransitionError(
        'no_leads',
        'Campaign has no leads — import leads or attach a list first',
      );
    }
    newStatus = 'active';
    if (!current.startedAt) updateExtras.startedAt = new Date();
  } else if (action === 'pause') {
    if (current.status !== 'active') {
      throw new TransitionError(
        'invalid_transition',
        `Cannot pause from status "${current.status}"`,
      );
    }
    newStatus = 'paused';
  } else if (action === 'resume') {
    if (current.status !== 'paused') {
      throw new TransitionError(
        'invalid_transition',
        `Cannot resume from status "${current.status}"`,
      );
    }
    newStatus = 'active';
  } else {
    // archive — allowed from any non-archived state
    newStatus = 'archived';
  }

  await db
    .update(campaign)
    .set({ status: newStatus, updatedAt: new Date(), ...updateExtras })
    .where(and(eq(campaign.id, id), eq(campaign.workspaceId, workspaceId)));

  return getCampaign(id, workspaceId);
}

export async function deleteCampaign(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(campaign)
    .where(and(eq(campaign.id, id), eq(campaign.workspaceId, workspaceId)))
    .returning({ id: campaign.id });
  return deleted.length > 0;
}
