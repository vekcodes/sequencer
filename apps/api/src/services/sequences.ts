import { eq, inArray } from 'drizzle-orm';
import { sequenceStep, sequenceStepVariant } from '@ces/db';
import { db } from '../lib/db';
import { getCampaign } from './campaigns';

export type SequenceStepVariantView = {
  id: number;
  weight: number;
  subject: string;
  body: string;
};

export type SequenceStepView = {
  id: number;
  order: number;
  waitInBusinessDays: number;
  threadReply: boolean;
  stopOnReply: boolean;
  variants: SequenceStepVariantView[];
};

export async function getSequence(
  campaignId: number,
  workspaceId: number,
): Promise<SequenceStepView[] | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;

  const steps = await db
    .select()
    .from(sequenceStep)
    .where(eq(sequenceStep.campaignId, campaignId))
    .orderBy(sequenceStep.stepOrder);

  if (steps.length === 0) return [];

  const stepIds = steps.map((s) => s.id);
  const variants = await db
    .select()
    .from(sequenceStepVariant)
    .where(inArray(sequenceStepVariant.sequenceStepId, stepIds));

  const variantsByStep = new Map<number, SequenceStepVariantView[]>();
  for (const v of variants) {
    const arr = variantsByStep.get(v.sequenceStepId) ?? [];
    arr.push({ id: v.id, weight: v.weight, subject: v.subject, body: v.body });
    variantsByStep.set(v.sequenceStepId, arr);
  }

  return steps.map((s) => ({
    id: s.id,
    order: s.stepOrder,
    waitInBusinessDays: s.waitInBusinessDays,
    threadReply: s.threadReply,
    stopOnReply: s.stopOnReply,
    variants: variantsByStep.get(s.id) ?? [],
  }));
}

export type PutSequenceInput = {
  steps: Array<{
    order: number;
    waitInBusinessDays: number;
    threadReply: boolean;
    stopOnReply?: boolean;
    variants: Array<{
      weight: number;
      subject: string;
      body: string;
    }>;
  }>;
};

export class SequenceLockedError extends Error {
  code = 'sequence_locked' as const;
  constructor() {
    super('Cannot edit sequence on an active campaign — pause it first');
  }
}

/**
 * Replaces the entire sequence in a single transaction.
 * Cheaper than diffing and matches what the UI saves (the user clicks "Save").
 * Refuses to edit while the campaign is active.
 */
export async function putSequence(
  campaignId: number,
  workspaceId: number,
  input: PutSequenceInput,
): Promise<SequenceStepView[] | null> {
  const c = await getCampaign(campaignId, workspaceId);
  if (!c) return null;
  if (c.status === 'active') throw new SequenceLockedError();

  await db.transaction(async (tx) => {
    // Variants cascade-delete via FK on sequence_step.id.
    await tx.delete(sequenceStep).where(eq(sequenceStep.campaignId, campaignId));

    for (const step of input.steps) {
      const stepRows = await tx
        .insert(sequenceStep)
        .values({
          campaignId,
          stepOrder: step.order,
          waitInBusinessDays: step.waitInBusinessDays,
          threadReply: step.threadReply,
          stopOnReply: step.stopOnReply ?? true,
        })
        .returning({ id: sequenceStep.id });

      const stepId = stepRows[0]?.id;
      if (!stepId) continue;

      if (step.variants.length === 0) {
        // A step needs at least one variant — skip empty
        continue;
      }

      await tx.insert(sequenceStepVariant).values(
        step.variants.map((v) => ({
          sequenceStepId: stepId,
          weight: v.weight,
          subject: v.subject,
          body: v.body,
        })),
      );
    }
  });

  return getSequence(campaignId, workspaceId);
}
