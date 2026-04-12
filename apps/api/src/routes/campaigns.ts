import { Hono } from 'hono';
import { z } from 'zod';
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaignSettings,
  transitionCampaign,
  deleteCampaign,
  TransitionError,
  type CampaignType,
} from '../services/campaigns';
import {
  getSequence,
  putSequence,
  SequenceLockedError,
} from '../services/sequences';
import {
  getCampaignSchedule,
  upsertCampaignSchedule,
} from '../services/campaign-schedule';
import {
  listCampaignSenders,
  attachSendersToCampaign,
  removeSenderFromCampaign,
  updateCampaignSender,
} from '../services/campaign-senders';
import {
  listCampaignLeads,
  attachLeadsToCampaign,
  attachLeadListToCampaign,
  removeLeadsFromCampaign,
} from '../services/campaign-leads';
import {
  getCampaignStats,
  getCampaignStepBreakdown,
} from '../services/campaign-stats';
import { requireAuth, type AuthVariables } from '../middleware/auth';

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['outbound', 'reply_followup']).optional(),
});

const SettingsBody = z.object({
  name: z.string().min(1).max(200).optional(),
  maxEmailsPerDay: z.number().int().positive().max(100000).optional(),
  maxNewLeadsPerDay: z.number().int().positive().max(100000).optional(),
  plainText: z.boolean().optional(),
  openTracking: z.boolean().optional(),
  clickTracking: z.boolean().optional(),
  canUnsubscribe: z.boolean().optional(),
  unsubscribeText: z.string().max(200).optional(),
  sequencePrioritization: z.enum(['followups', 'new_leads']).optional(),
  useLeadTimezone: z.boolean().optional(),
  skipHolidays: z.boolean().optional(),
  replyBehavior: z.enum(['auto_pause_lead', 'continue']).optional(),
});

const SequenceBody = z.object({
  steps: z.array(
    z.object({
      order: z.number().int().positive(),
      waitInBusinessDays: z.number().int().min(0).max(365),
      threadReply: z.boolean(),
      stopOnReply: z.boolean().optional(),
      variants: z
        .array(
          z.object({
            weight: z.number().int().min(1).max(1000),
            subject: z.string().min(0).max(998), // RFC 5322 line length
            body: z.string().min(0).max(50000),
          }),
        )
        .min(1),
    }),
  ),
});

const ScheduleBody = z.object({
  monday: z.boolean().optional(),
  tuesday: z.boolean().optional(),
  wednesday: z.boolean().optional(),
  thursday: z.boolean().optional(),
  friday: z.boolean().optional(),
  saturday: z.boolean().optional(),
  sunday: z.boolean().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
  avoidHoursLocal: z.array(z.string()).optional(),
});

const AttachSendersBody = z.object({
  mailboxIds: z.array(z.number().int().positive()).max(50),
});

const UpdateSenderBody = z.object({
  weight: z.number().int().min(1).max(1000).optional(),
  active: z.boolean().optional(),
});

const AttachLeadsBody = z.object({
  leadIds: z.array(z.number().int().positive()).max(10000),
});

const AttachListBody = z.object({
  listId: z.number().int().positive(),
});

const RemoveLeadsBody = z.object({
  leadIds: z.array(z.number().int().positive()).max(10000),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────

export const campaignsRoutes = new Hono<{ Variables: AuthVariables }>();
campaignsRoutes.use('*', requireAuth);

// ─── Campaign CRUD ───────────────────────────────────────────────────────────

campaignsRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const campaigns = await listCampaigns(user.workspaceId);
  return c.json({ campaigns });
});

campaignsRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  const created = await createCampaign(
    user.workspaceId,
    parsed.data.name,
    (parsed.data.type ?? 'outbound') as CampaignType,
  );
  return c.json({ campaign: created }, 201);
});

campaignsRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const camp = await getCampaign(id, user.workspaceId);
  if (!camp) return c.json({ error: 'not_found' }, 404);
  return c.json({ campaign: camp });
});

campaignsRoutes.patch('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = SettingsBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  const updated = await updateCampaignSettings(id, user.workspaceId, parsed.data);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ campaign: updated });
});

campaignsRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await deleteCampaign(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

// ─── Status transitions ─────────────────────────────────────────────────────

async function handleTransition(
  c: import('hono').Context<{ Variables: AuthVariables }>,
  action: 'launch' | 'pause' | 'resume' | 'archive',
) {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  try {
    const updated = await transitionCampaign(id, user.workspaceId, action);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ campaign: updated });
  } catch (e) {
    if (e instanceof TransitionError) {
      return c.json({ error: e.code, message: e.message }, 400);
    }
    throw e;
  }
}

campaignsRoutes.post('/:id/launch', (c) => handleTransition(c, 'launch'));
campaignsRoutes.post('/:id/pause', (c) => handleTransition(c, 'pause'));
campaignsRoutes.post('/:id/resume', (c) => handleTransition(c, 'resume'));
campaignsRoutes.post('/:id/archive', (c) => handleTransition(c, 'archive'));

// ─── Sequence ────────────────────────────────────────────────────────────────

campaignsRoutes.get('/:id/sequence', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const seq = await getSequence(id, user.workspaceId);
  if (seq === null) return c.json({ error: 'not_found' }, 404);
  return c.json({ steps: seq });
});

campaignsRoutes.put('/:id/sequence', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = SequenceBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  try {
    const seq = await putSequence(id, user.workspaceId, parsed.data);
    if (seq === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ steps: seq });
  } catch (e) {
    if (e instanceof SequenceLockedError) {
      return c.json({ error: e.code, message: e.message }, 409);
    }
    throw e;
  }
});

// ─── Schedule ────────────────────────────────────────────────────────────────

campaignsRoutes.get('/:id/schedule', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const sched = await getCampaignSchedule(id, user.workspaceId);
  if (!sched) return c.json({ error: 'not_found' }, 404);
  return c.json({ schedule: sched });
});

campaignsRoutes.put('/:id/schedule', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = ScheduleBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  const sched = await upsertCampaignSchedule(id, user.workspaceId, parsed.data);
  if (!sched) return c.json({ error: 'not_found' }, 404);
  return c.json({ schedule: sched });
});

// ─── Senders ─────────────────────────────────────────────────────────────────

campaignsRoutes.get('/:id/senders', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const senders = await listCampaignSenders(id, user.workspaceId);
  if (senders === null) return c.json({ error: 'not_found' }, 404);
  return c.json({ senders });
});

campaignsRoutes.post('/:id/senders', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = AttachSendersBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const senders = await attachSendersToCampaign(
    id,
    user.workspaceId,
    parsed.data.mailboxIds,
  );
  if (senders === null) return c.json({ error: 'not_found' }, 404);
  return c.json({ senders });
});

campaignsRoutes.patch('/:id/senders/:mailboxId', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const mailboxId = parseId(c.req.param('mailboxId'));
  if (id === null || mailboxId === null)
    return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateSenderBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const ok = await updateCampaignSender(
    id,
    mailboxId,
    user.workspaceId,
    parsed.data,
  );
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

campaignsRoutes.delete('/:id/senders/:mailboxId', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const mailboxId = parseId(c.req.param('mailboxId'));
  if (id === null || mailboxId === null)
    return c.json({ error: 'invalid_id' }, 400);
  const ok = await removeSenderFromCampaign(id, mailboxId, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

// ─── Leads (campaign enrollments) ────────────────────────────────────────────

campaignsRoutes.get('/:id/leads', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const result = await listCampaignLeads(id, user.workspaceId, page, limit);
  if (result === null) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

campaignsRoutes.post('/:id/leads', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = AttachLeadsBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const result = await attachLeadsToCampaign(
    id,
    user.workspaceId,
    parsed.data.leadIds,
  );
  if (result === null) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

campaignsRoutes.post('/:id/leads/from-list', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = AttachListBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const result = await attachLeadListToCampaign(
    id,
    user.workspaceId,
    parsed.data.listId,
  );
  if (result === null) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

// ─── Stats ──────────────────────────────────────────────────────────────────

campaignsRoutes.get('/:id/stats', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? '30')));
  const stats = await getCampaignStats(id, user.workspaceId, days);
  if (!stats) return c.json({ error: 'not_found' }, 404);
  return c.json(stats);
});

campaignsRoutes.get('/:id/stats/steps', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const breakdown = await getCampaignStepBreakdown(id, user.workspaceId);
  if (!breakdown) return c.json({ error: 'not_found' }, 404);
  return c.json({ steps: breakdown });
});

campaignsRoutes.delete('/:id/leads', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = RemoveLeadsBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const result = await removeLeadsFromCampaign(
    id,
    user.workspaceId,
    parsed.data.leadIds,
  );
  return c.json(result);
});
