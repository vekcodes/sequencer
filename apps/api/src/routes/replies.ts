import { Hono } from 'hono';
import { z } from 'zod';
import {
  listReplies,
  getReply,
  updateReplyFlags,
  getReplyCounts,
  replyToThread,
  ReplyComposeError,
} from '../services/replies';
import { requireAuth, type AuthVariables } from '../middleware/auth';

export const repliesRoutes = new Hono<{ Variables: AuthVariables }>();

repliesRoutes.use('*', requireAuth);

const PatchBody = z.object({
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const ReplyBody = z.object({
  body: z.string().min(1).max(50_000),
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
  const mailboxIdRaw = c.req.query('mailboxId');
  const mailboxId = mailboxIdRaw ? Number.parseInt(mailboxIdRaw, 10) : undefined;
  const result = await listReplies({
    workspaceId: user.workspaceId,
    page,
    limit,
    filter,
    search,
    mailboxId: Number.isFinite(mailboxId) && mailboxId! > 0 ? mailboxId : undefined,
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

repliesRoutes.post('/:id/reply', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = ReplyBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  try {
    const sent = await replyToThread(id, user.workspaceId, parsed.data.body);
    const full = await getReply(id, user.workspaceId);
    return c.json({ reply: full, gmailMessageId: sent.gmailMessageId });
  } catch (e) {
    if (e instanceof ReplyComposeError) {
      return c.json({ error: e.code, message: e.message }, e.status as 400 | 404 | 409);
    }
    throw e;
  }
});
