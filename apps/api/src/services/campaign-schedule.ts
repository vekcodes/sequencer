import { eq } from 'drizzle-orm';
import { campaignSchedule } from '@ces/db';
import { db } from '../lib/db';
import { getCampaign } from './campaigns';

export type CampaignScheduleView = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startTime: string;
  endTime: string;
  timezone: string;
  avoidHoursLocal: string[];
};

function toView(
  row: typeof campaignSchedule.$inferSelect,
): CampaignScheduleView {
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

export async function getCampaignSchedule(
  campaignId: number,
  workspaceId: number,
): Promise<CampaignScheduleView | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;
  const rows = await db
    .select()
    .from(campaignSchedule)
    .where(eq(campaignSchedule.campaignId, campaignId))
    .limit(1);
  return rows[0] ? toView(rows[0]) : null;
}

export async function upsertCampaignSchedule(
  campaignId: number,
  workspaceId: number,
  input: Partial<CampaignScheduleView>,
): Promise<CampaignScheduleView | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;

  const existing = await db
    .select()
    .from(campaignSchedule)
    .where(eq(campaignSchedule.campaignId, campaignId))
    .limit(1);

  if (existing[0]) {
    const set: Record<string, unknown> = {};
    if (input.monday !== undefined) set.monday = input.monday;
    if (input.tuesday !== undefined) set.tuesday = input.tuesday;
    if (input.wednesday !== undefined) set.wednesday = input.wednesday;
    if (input.thursday !== undefined) set.thursday = input.thursday;
    if (input.friday !== undefined) set.friday = input.friday;
    if (input.saturday !== undefined) set.saturday = input.saturday;
    if (input.sunday !== undefined) set.sunday = input.sunday;
    if (input.startTime !== undefined) set.startTime = input.startTime;
    if (input.endTime !== undefined) set.endTime = input.endTime;
    if (input.timezone !== undefined) set.timezone = input.timezone;
    if (input.avoidHoursLocal !== undefined)
      set.avoidHoursLocal = input.avoidHoursLocal;

    await db
      .update(campaignSchedule)
      .set(set)
      .where(eq(campaignSchedule.campaignId, campaignId));
  } else {
    await db.insert(campaignSchedule).values({
      campaignId,
      monday: input.monday ?? true,
      tuesday: input.tuesday ?? true,
      wednesday: input.wednesday ?? true,
      thursday: input.thursday ?? true,
      friday: input.friday ?? true,
      saturday: input.saturday ?? false,
      sunday: input.sunday ?? false,
      startTime: input.startTime ?? '09:00',
      endTime: input.endTime ?? '16:30',
      timezone: input.timezone ?? 'America/New_York',
      avoidHoursLocal: input.avoidHoursLocal ?? ['00:00-06:00', '22:00-24:00'],
    });
  }

  return getCampaignSchedule(campaignId, workspaceId);
}
