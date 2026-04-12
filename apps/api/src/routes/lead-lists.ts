import { Hono } from 'hono';
import { z } from 'zod';
import {
  listLeadLists,
  getLeadListById,
  createLeadList,
  deleteLeadList,
  getLeadsInList,
  addLeadsToList,
  removeLeadsFromList,
} from '../services/lead-lists';
import { requireAuth, type AuthVariables } from '../middleware/auth';

const CreateBody = z.object({
  name: z.string().min(1).max(100),
});

const AttachBody = z.object({
  leadIds: z.array(z.number().int().positive()).max(10000),
});

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export const leadListsRoutes = new Hono<{ Variables: AuthVariables }>();
leadListsRoutes.use('*', requireAuth);

leadListsRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const lists = await listLeadLists(user.workspaceId);
  return c.json({ leadLists: lists });
});

leadListsRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const created = await createLeadList(user.workspaceId, parsed.data.name);
  return c.json({ leadList: { ...created, leadCount: 0 } }, 201);
});

leadListsRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const list = await getLeadListById(id, user.workspaceId);
  if (!list) return c.json({ error: 'not_found' }, 404);
  return c.json({ leadList: list });
});

leadListsRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await deleteLeadList(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

leadListsRoutes.get('/:id/leads', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const result = await getLeadsInList(id, user.workspaceId, page, limit);
  return c.json(result);
});

leadListsRoutes.post('/:id/leads', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = AttachBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  try {
    const added = await addLeadsToList(id, parsed.data.leadIds, user.workspaceId);
    return c.json({ added });
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
});

leadListsRoutes.delete('/:id/leads', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = AttachBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const removed = await removeLeadsFromList(
    id,
    parsed.data.leadIds,
    user.workspaceId,
  );
  return c.json({ removed });
});
