import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gte } from 'drizzle-orm';
import { mailboxHealthSnapshot } from '@ces/db';
import {
  listMailboxes,
  getMailbox,
  pauseMailbox,
  resumeMailbox,
  deleteMailbox,
  updateMailboxWarmup,
  toView,
} from '../services/mailbox';
import { computeMailboxHealth } from '../services/mailbox-health';
import { runWarmupForMailbox } from '../services/warmup';
import { smartAdjustMailbox } from '../services/smart-adjust';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import type { AuthVariables } from '../middleware/auth';

export const mailboxRoutes = new Hono<{ Variables: AuthVariables }>();

mailboxRoutes.use('*', requireAuth);

mailboxRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const rows = await listMailboxes(user.workspaceId);
  return c.json({ mailboxes: rows.map(toView) });
});

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

mailboxRoutes.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const row = await getMailbox(id, user.workspaceId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ mailbox: toView(row) });
});

mailboxRoutes.post('/:id/pause', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const row = await pauseMailbox(id, user.workspaceId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ mailbox: toView(row) });
});

mailboxRoutes.post('/:id/resume', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const row = await resumeMailbox(id, user.workspaceId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ mailbox: toView(row) });
});

mailboxRoutes.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const ok = await deleteMailbox(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

/**
 * Daily health snapshots for the sparkline. Returns up to `days` snapshots
 * (capped at 90), oldest first.
 */
mailboxRoutes.get('/:id/health-history', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;

  // Workspace check
  const m = await getMailbox(id, user.workspaceId);
  if (!m) return c.json({ error: 'not_found' }, 404);

  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? '30')));
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const snapshots = await db
    .select({
      date: mailboxHealthSnapshot.date,
      pool: mailboxHealthSnapshot.pool,
      healthScore: mailboxHealthSnapshot.healthScore,
      bounceRate30dBps: mailboxHealthSnapshot.bounceRate30dBps,
      spamRate30dBps: mailboxHealthSnapshot.spamRate30dBps,
      sendsCount: mailboxHealthSnapshot.sendsCount,
      bouncesCount: mailboxHealthSnapshot.bouncesCount,
      effectiveDailyLimit: mailboxHealthSnapshot.effectiveDailyLimit,
    })
    .from(mailboxHealthSnapshot)
    .where(
      and(
        eq(mailboxHealthSnapshot.mailboxId, id),
        gte(mailboxHealthSnapshot.date, sinceDate),
      ),
    )
    .orderBy(mailboxHealthSnapshot.date);

  return c.json({ snapshots });
});

/**
 * Force-runs the health worker for a single mailbox. Used by the "Recompute"
 * button on the detail page when the user wants an immediate refresh.
 */
mailboxRoutes.post('/:id/recompute-health', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const m = await getMailbox(id, user.workspaceId);
  if (!m) return c.json({ error: 'not_found' }, 404);

  const result = await computeMailboxHealth(id);
  // Reload the row so the response shows the updated state
  const updated = await getMailbox(id, user.workspaceId);
  return c.json({ result, mailbox: updated ? toView(updated) : null });
});

// ─── Warmup + Smart-Adjust (Phase 8) ─────────────────────────────────────────

const WarmupBody = z.object({
  warmupEnabled: z.boolean().optional(),
  warmupDailyLimit: z.number().int().min(0).max(50).optional(),
  smartAdjustEnabled: z.boolean().optional(),
});

mailboxRoutes.patch('/:id/warmup', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = WarmupBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const row = await updateMailboxWarmup(id, user.workspaceId, parsed.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ mailbox: toView(row) });
});

/** Force-runs one warmup tick for a single mailbox. */
mailboxRoutes.post('/:id/warmup/run', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const m = await getMailbox(id, user.workspaceId);
  if (!m) return c.json({ error: 'not_found' }, 404);
  const result = await runWarmupForMailbox(id);
  return c.json({ result });
});

/** Force-runs Smart-Adjust for a single mailbox. */
mailboxRoutes.post('/:id/smart-adjust/run', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const user = c.get('user')!;
  const m = await getMailbox(id, user.workspaceId);
  if (!m) return c.json({ error: 'not_found' }, 404);
  const result = await smartAdjustMailbox(id);
  return c.json({ result });
});
