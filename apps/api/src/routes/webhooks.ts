import { Hono } from 'hono';
import { z } from 'zod';
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  WEBHOOK_EVENT_TYPES,
} from '../services/webhooks';
import { requireAuth, type AuthVariables } from '../middleware/auth';

export const webhooksRoutes = new Hono<{ Variables: AuthVariables }>();

webhooksRoutes.use('*', requireAuth);

const EventTypeEnum = z.enum(WEBHOOK_EVENT_TYPES);

const CreateBody = z.object({
  url: z.string().url().max(500),
  eventTypes: z.array(EventTypeEnum).min(1),
  active: z.boolean().optional(),
});

const UpdateBody = z.object({
  url: z.string().url().max(500).optional(),
  eventTypes: z.array(EventTypeEnum).optional(),
  active: z.boolean().optional(),
});

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

webhooksRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const webhooks = await listWebhooks(user.workspaceId);
  return c.json({ webhooks, eventTypes: WEBHOOK_EVENT_TYPES });
});

webhooksRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  const result = await createWebhook(user.workspaceId, parsed.data);
  // Secret is returned ONCE, only here.
  return c.json(
    { webhook: result.webhook, secret: result.secret },
    201,
  );
});

webhooksRoutes.patch('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const updated = await updateWebhook(id, user.workspaceId, parsed.data);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ webhook: updated });
});

webhooksRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await deleteWebhook(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

webhooksRoutes.post('/:id/test', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const result = await testWebhook(id, user.workspaceId);
  return c.json(result);
});
