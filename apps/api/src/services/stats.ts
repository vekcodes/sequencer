import { and, eq, gte, sql } from 'drizzle-orm';
import { emailEvent, reply } from '@ces/db';
import { db } from '../lib/db';

export type DashboardTotals = {
  sent: number;
  peopleContacted: number;
  totalOpens: number;
  uniqueOpens: number;
  replies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
};

export type DashboardSeriesPoint = {
  date: string; // YYYY-MM-DD
  sent: number;
  totalOpens: number;
  uniqueOpens: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
};

export type DashboardStats = {
  days: number;
  totals: DashboardTotals;
  series: DashboardSeriesPoint[];
};

/**
 * Build a date-indexed row for every day in the window, so the chart has a
 * continuous x-axis even on days with no activity.
 */
function buildDateAxis(days: number): string[] {
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
 * Dashboard KPIs + time-series for the workspace over the last N days.
 *
 * Totals come from lifetime event counts (not windowed) so the top-card
 * numbers stay meaningful when a workspace just started; the series is
 * windowed to the selected range.
 */
export async function getDashboardStats(
  workspaceId: number,
  days: number,
): Promise<DashboardStats> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  // Totals (lifetime). One grouped query keeps this to a single round trip.
  const totalRows = await db
    .select({
      type: emailEvent.type,
      c: sql<number>`count(*)::int`,
      uniqueLeads: sql<number>`count(distinct ${emailEvent.campaignLeadId})::int`,
    })
    .from(emailEvent)
    .where(eq(emailEvent.workspaceId, workspaceId))
    .groupBy(emailEvent.type);

  const tot: DashboardTotals = {
    sent: 0,
    peopleContacted: 0,
    totalOpens: 0,
    uniqueOpens: 0,
    replies: 0,
    bounced: 0,
    unsubscribed: 0,
    interested: 0,
  };
  for (const r of totalRows) {
    switch (r.type) {
      case 'sent':
        tot.sent = r.c;
        tot.peopleContacted = r.uniqueLeads;
        break;
      case 'opened':
        tot.totalOpens = r.c;
        tot.uniqueOpens = r.uniqueLeads;
        break;
      case 'replied':
        tot.replies = r.c;
        break;
      case 'bounced':
        tot.bounced = r.c;
        break;
      case 'unsubscribed':
        tot.unsubscribed = r.c;
        break;
    }
  }

  // "Interested" comes from reply classification, not an event type.
  const interestedRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(reply)
    .where(
      and(
        eq(reply.workspaceId, workspaceId),
        eq(reply.classification, 'interested'),
      ),
    );
  tot.interested = interestedRow[0]?.c ?? 0;

  // Windowed per-day series, grouped by UTC date + event type.
  const seriesRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${emailEvent.occurredAt}), 'YYYY-MM-DD')`,
      type: emailEvent.type,
      c: sql<number>`count(*)::int`,
      uniqueLeads: sql<number>`count(distinct ${emailEvent.campaignLeadId})::int`,
    })
    .from(emailEvent)
    .where(
      and(
        eq(emailEvent.workspaceId, workspaceId),
        gte(emailEvent.occurredAt, since),
      ),
    )
    .groupBy(
      sql`date_trunc('day', ${emailEvent.occurredAt})`,
      emailEvent.type,
    );

  const axis = buildDateAxis(days);
  const byDay = new Map<string, DashboardSeriesPoint>();
  for (const d of axis) {
    byDay.set(d, {
      date: d,
      sent: 0,
      totalOpens: 0,
      uniqueOpens: 0,
      replied: 0,
      bounced: 0,
      unsubscribed: 0,
      interested: 0,
    });
  }
  for (const r of seriesRows) {
    const p = byDay.get(r.day);
    if (!p) continue;
    switch (r.type) {
      case 'sent':
        p.sent = r.c;
        break;
      case 'opened':
        p.totalOpens = r.c;
        p.uniqueOpens = r.uniqueLeads;
        break;
      case 'replied':
        p.replied = r.c;
        break;
      case 'bounced':
        p.bounced = r.c;
        break;
      case 'unsubscribed':
        p.unsubscribed = r.c;
        break;
    }
  }

  // Interested-per-day from reply.receivedAt.
  const interestedSeries = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${reply.receivedAt}), 'YYYY-MM-DD')`,
      c: sql<number>`count(*)::int`,
    })
    .from(reply)
    .where(
      and(
        eq(reply.workspaceId, workspaceId),
        eq(reply.classification, 'interested'),
        gte(reply.receivedAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', ${reply.receivedAt})`);
  for (const r of interestedSeries) {
    const p = byDay.get(r.day);
    if (p) p.interested = r.c;
  }

  return {
    days,
    totals: tot,
    series: axis.map((d) => byDay.get(d)!),
  };
}
