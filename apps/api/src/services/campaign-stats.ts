// Phase 9 — per-campaign analytics. The dashboard-level stats already live in
// `services/stats.ts`; this file adds the drill-down view the campaign detail
// page needs: funnel totals + a per-day series scoped to one campaign.

import { and, eq, gte, sql } from 'drizzle-orm';
import { emailEvent, reply, campaignLead } from '@ces/db';
import { db } from '../lib/db';
import { getCampaign } from './campaigns';

export type CampaignFunnel = {
  enrolled: number;
  sent: number;
  peopleContacted: number;
  opened: number;
  uniqueOpens: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
  completed: number;
  openRatePct: number;
  replyRatePct: number;
  bounceRatePct: number;
};

export type CampaignSeriesPoint = {
  date: string;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
};

export type CampaignStats = {
  funnel: CampaignFunnel;
  series: CampaignSeriesPoint[];
  days: number;
};

function buildAxis(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Lifetime totals for the funnel + a windowed per-day series. One query per
 * aggregation; `campaignId + type` is a hot read path so downstream index
 * tuning (idx on email_event.campaign_id, type) pays for itself.
 */
export async function getCampaignStats(
  campaignId: number,
  workspaceId: number,
  days: number = 30,
): Promise<CampaignStats | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  // 1. Totals by event type (lifetime).
  const totals = await db
    .select({
      type: emailEvent.type,
      c: sql<number>`count(*)::int`,
      uniq: sql<number>`count(distinct ${emailEvent.campaignLeadId})::int`,
    })
    .from(emailEvent)
    .where(eq(emailEvent.campaignId, campaignId))
    .groupBy(emailEvent.type);

  const funnel: CampaignFunnel = {
    enrolled: 0,
    sent: 0,
    peopleContacted: 0,
    opened: 0,
    uniqueOpens: 0,
    replied: 0,
    bounced: 0,
    unsubscribed: 0,
    interested: 0,
    completed: 0,
    openRatePct: 0,
    replyRatePct: 0,
    bounceRatePct: 0,
  };
  for (const r of totals) {
    switch (r.type) {
      case 'sent':
        funnel.sent = r.c;
        funnel.peopleContacted = r.uniq;
        break;
      case 'opened':
        funnel.opened = r.c;
        funnel.uniqueOpens = r.uniq;
        break;
      case 'replied':
        funnel.replied = r.c;
        break;
      case 'bounced':
        funnel.bounced = r.c;
        break;
      case 'unsubscribed':
        funnel.unsubscribed = r.c;
        break;
    }
  }

  // 2. Enrolled + completed counts from campaign_lead.
  const enrolledRows = await db
    .select({
      status: campaignLead.status,
      c: sql<number>`count(*)::int`,
    })
    .from(campaignLead)
    .where(eq(campaignLead.campaignId, campaignId))
    .groupBy(campaignLead.status);
  for (const r of enrolledRows) {
    funnel.enrolled += r.c;
    if (r.status === 'completed') funnel.completed = r.c;
  }

  // 3. Interested replies — from the reply table.
  const [interested] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(reply)
    .innerJoin(campaignLead, eq(campaignLead.id, reply.campaignLeadId))
    .where(
      and(
        eq(campaignLead.campaignId, campaignId),
        eq(reply.classification, 'interested'),
      ),
    );
  funnel.interested = interested?.c ?? 0;

  // 4. Derived rates.
  const denom = Math.max(1, funnel.sent);
  funnel.openRatePct = Number(((funnel.uniqueOpens / denom) * 100).toFixed(2));
  funnel.replyRatePct = Number(((funnel.replied / denom) * 100).toFixed(2));
  funnel.bounceRatePct = Number(((funnel.bounced / denom) * 100).toFixed(2));

  // 5. Per-day series for the chart.
  const seriesRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${emailEvent.occurredAt}), 'YYYY-MM-DD')`,
      type: emailEvent.type,
      c: sql<number>`count(*)::int`,
    })
    .from(emailEvent)
    .where(
      and(
        eq(emailEvent.campaignId, campaignId),
        gte(emailEvent.occurredAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', ${emailEvent.occurredAt})`, emailEvent.type);

  const axis = buildAxis(days);
  const byDay = new Map<string, CampaignSeriesPoint>();
  for (const d of axis) {
    byDay.set(d, { date: d, sent: 0, opened: 0, replied: 0, bounced: 0 });
  }
  for (const r of seriesRows) {
    const p = byDay.get(r.day);
    if (!p) continue;
    if (r.type === 'sent') p.sent = r.c;
    else if (r.type === 'opened') p.opened = r.c;
    else if (r.type === 'replied') p.replied = r.c;
    else if (r.type === 'bounced') p.bounced = r.c;
  }

  return {
    funnel,
    series: axis.map((d) => byDay.get(d)!),
    days,
  };
}

/**
 * Per-sequence-step breakdown: how many sends + opens + replies came from
 * each step. Useful for "which follow-up is working?" in the detail page.
 */
export async function getCampaignStepBreakdown(
  campaignId: number,
  workspaceId: number,
): Promise<Array<{
  sequenceStepId: number;
  stepOrder: number;
  sent: number;
  replied: number;
  bounced: number;
}> | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;

  const rows = await db.execute(sql`
    SELECT
      ss.id AS sequence_step_id,
      ss.step_order,
      COUNT(*) FILTER (WHERE se.status = 'sent')::int AS sent,
      COUNT(*) FILTER (WHERE se.status = 'sent' AND EXISTS (
        SELECT 1 FROM email_event ee
        WHERE ee.scheduled_email_id = se.id AND ee.type = 'replied'
      ))::int AS replied,
      COUNT(*) FILTER (WHERE se.status = 'bounced')::int AS bounced
    FROM sequence_step ss
    LEFT JOIN scheduled_email se ON se.sequence_step_id = ss.id
    WHERE ss.campaign_id = ${campaignId}
    GROUP BY ss.id, ss.step_order
    ORDER BY ss.step_order ASC
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = ((rows as any).rows ?? rows) as Array<{
    sequence_step_id: number;
    step_order: number;
    sent: number;
    replied: number;
    bounced: number;
  }>;
  return raw.map((r) => ({
    sequenceStepId: r.sequence_step_id,
    stepOrder: r.step_order,
    sent: r.sent,
    replied: r.replied,
    bounced: r.bounced,
  }));
}
