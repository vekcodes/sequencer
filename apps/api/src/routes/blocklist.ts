import { Hono } from 'hono';
import { z } from 'zod';
import {
  listBlocklistedEmails,
  addEmailToBlocklist,
  removeEmailFromBlocklist,
  listBlocklistedDomains,
  addDomainToBlocklist,
  removeDomainFromBlocklist,
} from '../services/blocklist';
import { requireAuth, type AuthVariables } from '../middleware/auth';

const AddEmailBody = z.object({
  email: z.string().email().max(320),
  reason: z.string().max(500).optional(),
});

const AddDomainBody = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain format'),
  reason: z.string().max(500).optional(),
});

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export const blocklistRoutes = new Hono<{ Variables: AuthVariables }>();
blocklistRoutes.use('*', requireAuth);

// ─── Emails ──────────────────────────────────────────────────────────────────

blocklistRoutes.get('/emails', async (c) => {
  const user = c.get('user')!;
  const items = await listBlocklistedEmails(user.workspaceId);
  return c.json({ items });
});

blocklistRoutes.post('/emails', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = AddEmailBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const item = await addEmailToBlocklist(
    user.workspaceId,
    parsed.data.email,
    parsed.data.reason ?? null,
  );
  if (!item) return c.json({ error: 'already_blocklisted' }, 409);
  return c.json({ item }, 201);
});

blocklistRoutes.delete('/emails/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await removeEmailFromBlocklist(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});

// ─── Domains ─────────────────────────────────────────────────────────────────

blocklistRoutes.get('/domains', async (c) => {
  const user = c.get('user')!;
  const items = await listBlocklistedDomains(user.workspaceId);
  return c.json({ items });
});

blocklistRoutes.post('/domains', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = AddDomainBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const item = await addDomainToBlocklist(
    user.workspaceId,
    parsed.data.domain,
    parsed.data.reason ?? null,
  );
  if (!item) return c.json({ error: 'already_blocklisted' }, 409);
  return c.json({ item }, 201);
});

blocklistRoutes.delete('/domains/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await removeDomainFromBlocklist(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});
