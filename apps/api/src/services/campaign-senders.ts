import { and, eq, inArray } from 'drizzle-orm';
import { campaignSender, mailbox } from '@ces/db';
import { db } from '../lib/db';
import { getCampaign } from './campaigns';
import { toView as toMailboxView, type MailboxView } from './mailbox';

export type CampaignSenderView = {
  mailbox: MailboxView;
  weight: number;
  active: boolean;
};

export async function listCampaignSenders(
  campaignId: number,
  workspaceId: number,
): Promise<CampaignSenderView[] | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;

  const rows = await db
    .select({
      mailboxRow: mailbox,
      weight: campaignSender.weight,
      active: campaignSender.active,
    })
    .from(campaignSender)
    .innerJoin(mailbox, eq(mailbox.id, campaignSender.mailboxId))
    .where(eq(campaignSender.campaignId, campaignId))
    .orderBy(mailbox.email);

  return rows.map((r) => ({
    mailbox: toMailboxView(r.mailboxRow),
    weight: r.weight,
    active: r.active,
  }));
}

export async function attachSendersToCampaign(
  campaignId: number,
  workspaceId: number,
  mailboxIds: number[],
): Promise<CampaignSenderView[] | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;
  if (mailboxIds.length === 0) return listCampaignSenders(campaignId, workspaceId);

  // Verify mailboxes belong to this workspace before attaching
  const owned = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(
      and(eq(mailbox.workspaceId, workspaceId), inArray(mailbox.id, mailboxIds)),
    );

  if (owned.length === 0) {
    return listCampaignSenders(campaignId, workspaceId);
  }

  await db
    .insert(campaignSender)
    .values(
      owned.map((m) => ({
        campaignId,
        mailboxId: m.id,
        weight: 100,
        active: true,
      })),
    )
    .onConflictDoNothing();

  return listCampaignSenders(campaignId, workspaceId);
}

export async function removeSenderFromCampaign(
  campaignId: number,
  mailboxId: number,
  workspaceId: number,
): Promise<boolean> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return false;
  const deleted = await db
    .delete(campaignSender)
    .where(
      and(
        eq(campaignSender.campaignId, campaignId),
        eq(campaignSender.mailboxId, mailboxId),
      ),
    )
    .returning({ campaignId: campaignSender.campaignId });
  return deleted.length > 0;
}

export async function updateCampaignSender(
  campaignId: number,
  mailboxId: number,
  workspaceId: number,
  patch: { weight?: number; active?: boolean },
): Promise<boolean> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return false;
  const set: Record<string, unknown> = {};
  if (patch.weight !== undefined) set.weight = patch.weight;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) return true;
  await db
    .update(campaignSender)
    .set(set)
    .where(
      and(
        eq(campaignSender.campaignId, campaignId),
        eq(campaignSender.mailboxId, mailboxId),
      ),
    );
  return true;
}
