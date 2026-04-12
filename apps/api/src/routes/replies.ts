import { Hono } from 'hono';
import { z } from 'zod';
import {
  listReplies,
  getReply,
  updateReplyFlags,
  getReplyCounts,
} from '../services/replies';
import { requireAuth, type AuthVariables } from '../middleware/auth';

export const repliesRoutes = new Hono<{ Variables: AuthVariables }>();

repliesRoutes.use('*', requireAuth);

const PatchBody = z.object({
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
});

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

repliesRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const filter = (c.req.query('filter') ?? 'all') as
    | 'all'
    | 'unread'
    | 'interested'
    | 'starred'
    | 'archived';
  const search = c.req.query('q') ?? undefined;
  const result = await listReplies({
    workspaceId: user.workspaceId,
    page,
    limit,
    filter,
    search,
  });
  return c.json(result);
});

repliesRoutes.get('/counts', async (c) => {
  const user = c.get('user')!;
  const counts = await getReplyCounts(user.workspaceId);
  return c.json({ counts });
});

repliesRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const r = await getReply(id, user.workspaceId);
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json({ reply: r });
});

repliesRoutes.patch('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const updated = await updateReplyFlags(id, user.workspaceId, parsed.data);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ reply: updated });
});
