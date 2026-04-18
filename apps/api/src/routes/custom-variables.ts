import { Hono } from 'hono';
import { z } from 'zod';
import {
  listCustomVariables,
  createCustomVariable,
  updateCustomVariable,
  deleteCustomVariable,
} from '../services/custom-variables';
import { requireAuth, type AuthVariables } from '../middleware/auth';

export const customVariablesRoutes = new Hono<{ Variables: AuthVariables }>();
customVariablesRoutes.use('*', requireAuth);

const KeyField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9 _-]+$/, 'only letters, numbers, space, underscore, hyphen');

const CreateBody = z.object({
  key: KeyField,
  fallbackDefault: z.string().max(2000).nullable().optional(),
});

const PatchBody = z.object({
  key: KeyField.optional(),
  fallbackDefault: z.string().max(2000).nullable().optional(),
});

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

customVariablesRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const variables = await listCustomVariables(user.workspaceId);
  return c.json({ variables });
});

customVariablesRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  try {
    const variable = await createCustomVariable(user.workspaceId, parsed.data);
    return c.json({ variable }, 201);
  } catch (e) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code: string }).code === '23505'
    ) {
      return c.json({ error: 'key_already_exists' }, 409);
    }
    if (e instanceof Error && e.message === 'invalid_key') {
      return c.json({ error: 'invalid_key' }, 400);
    }
    throw e;
  }
});

customVariablesRoutes.patch('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  try {
    const variable = await updateCustomVariable(id, user.workspaceId, parsed.data);
    if (!variable) return c.json({ error: 'not_found' }, 404);
    return c.json({ variable });
  } catch (e) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code: string }).code === '23505'
    ) {
      return c.json({ error: 'key_already_exists' }, 409);
    }
    if (e instanceof Error && e.message === 'invalid_key') {
      return c.json({ error: 'invalid_key' }, 400);
    }
    throw e;
  }
});

customVariablesRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await deleteCustomVariable(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});
