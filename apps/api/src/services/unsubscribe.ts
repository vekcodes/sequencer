// Phase 10 — unsubscribe endpoint.
//
// Implements one-click unsubscribe per RFC 8058 + a browser-friendly GET fallback.
//
// Token format: `c<campaignId>-l<leadId>-<hmac>` where the HMAC is SHA-256 of
// `c<campaignId>-l<leadId>` keyed by TOKEN_ENCRYPTION_KEY. This makes tokens
// deterministic (so the List-Unsubscribe header can include them) and tamper-proof
// (so nobody can unsubscribe arbitrary leads by guessing IDs).
//
// When a lead unsubscribes:
//   1. lead.status → 'unsubscribed'
//   2. All queued scheduled_email rows for this lead are cancelled
//   3. An email_event(type='unsubscribed') is logged
//   4. A webhook(lead_unsubscribed) fires

import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { lead, campaignLead, scheduledEmail, emailEvent, campaign } from '@ces/db';
import { db } from '../lib/db';
import { dispatchEvent } from './webhooks';

function getSigningKey(): string {
  // Re-use TOKEN_ENCRYPTION_KEY — it's already set in every env for Phase 2+.
  return process.env.TOKEN_ENCRYPTION_KEY ?? 'dev-unsub-key-NOT-FOR-PROD';
}

export function generateUnsubToken(campaignId: number, leadId: number): string {
  const payload = `c${campaignId}-l${leadId}`;
  const hmac = createHmac('sha256', getSigningKey())
    .update(payload)
    .digest('hex')
    .slice(0, 16); // 16 hex chars = 64 bits — sufficient for anti-guessing.
  return `${payload}-${hmac}`;
}

export function parseUnsubToken(
  token: string,
): { campaignId: number; leadId: number } | null {
  const match = token.match(/^c(\d+)-l(\d+)-([a-f0-9]+)$/);
  if (!match) return null;
  const campaignId = Number(match[1]);
  const leadId = Number(match[2]);
  const providedHmac = match[3];

  const expected = createHmac('sha256', getSigningKey())
    .update(`c${campaignId}-l${leadId}`)
    .digest('hex')
    .slice(0, 16);

  if (providedHmac !== expected) return null;
  return { campaignId, leadId };
}

export type UnsubResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Processes an unsubscribe. Idempotent — calling it twice on the same lead
 * just returns ok=true without re-logging.
 */
export async function processUnsubscribe(
  campaignId: number,
  leadId: number,
): Promise<UnsubResult> {
  const [leadRow] = await db
    .select()
    .from(lead)
    .where(eq(lead.id, leadId))
    .limit(1);
  if (!leadRow) return { ok: false, reason: 'lead_not_found' };
  if (leadRow.status === 'unsubscribed') return { ok: true };

  const [campaignRow] = await db
    .select()
    .from(campaign)
    .where(eq(campaign.id, campaignId))
    .limit(1);
  if (!campaignRow) return { ok: false, reason: 'campaign_not_found' };

  await db.transaction(async (tx) => {
    // Mark lead globally as unsubscribed.
    await tx
      .update(lead)
      .set({ status: 'unsubscribed', updatedAt: new Date() })
      .where(eq(lead.id, leadId));

    // Mark the campaign enrollment.
    await tx
      .update(campaignLead)
      .set({ status: 'unsubscribed', completedAt: new Date() })
      .where(
        and(
          eq(campaignLead.campaignId, campaignId),
          eq(campaignLead.leadId, leadId),
        ),
      );

    // Cancel queued sends.
    const enrollments = await tx
      .select({ id: campaignLead.id })
      .from(campaignLead)
      .where(eq(campaignLead.leadId, leadId));
    for (const e of enrollments) {
      await tx
        .update(scheduledEmail)
        .set({ status: 'cancelled', lastError: 'lead_unsubscribed' })
        .where(
          and(
            eq(scheduledEmail.campaignLeadId, e.id),
            eq(scheduledEmail.status, 'queued'),
          ),
        );
    }

    // Log the event.
    if (campaignRow) {
      await tx.insert(emailEvent).values({
        workspaceId: campaignRow.workspaceId,
        campaignId,
        mailboxId: null,
        type: 'unsubscribed',
        payload: { lead_id: leadId, email: leadRow.email },
      });
    }
  });

  // Webhook.
  if (campaignRow) {
    dispatchEvent(campaignRow.workspaceId, 'lead_unsubscribed', {
      campaign_id: campaignId,
      lead_id: leadId,
      email: leadRow.email,
    }).catch(() => {});
  }

  return { ok: true };
}
