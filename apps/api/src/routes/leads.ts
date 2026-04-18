import { Hono } from 'hono';
import { z } from 'zod';
import {
  listLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  bulkUpsertLeads,
  type LeadStatus,
} from '../services/leads';
import { loadBlocklistChecker } from '../services/blocklist';
import {
  addLeadsToList,
  createLeadList,
  getLeadListById,
} from '../services/lead-lists';
import {
  parseCsvHeaders,
  parseCsvRows,
  validateAndMap,
  type ColumnField,
  type ColumnMapping,
} from '../lib/csv-import';
import { requireAuth, type AuthVariables } from '../middleware/auth';

const LEAD_STATUS = [
  'active',
  'replied',
  'unsubscribed',
  'bounced',
  'blacklisted',
] as const;

const CreateLeadBody = z.object({
  email: z.string().email().max(320),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  customVariables: z.record(z.unknown()).optional(),
});

const UpdateLeadBody = CreateLeadBody.partial();

const BulkDeleteBody = z.object({
  ids: z.array(z.number().int().positive()).max(10000),
});

const ColumnFieldSchema = z.union([
  z.literal('email'),
  z.literal('first_name'),
  z.literal('last_name'),
  z.literal('company'),
  z.literal('title'),
  z.literal('phone'),
  z.literal('timezone'),
  z.string().regex(/^custom_var:.+$/),
  z.null(),
]);

const ImportBody = z.object({
  csv: z.string().min(1).max(10 * 1024 * 1024), // 10 MB max
  hasHeader: z.boolean().default(true),
  // Mapping is keyed by string column index (JSON keys are strings).
  mapping: z.record(z.string(), ColumnFieldSchema),
  listId: z.number().int().positive().optional(),
  listName: z.string().min(1).max(100).optional(),
});

const ParseHeadersBody = z.object({
  csv: z.string().min(1).max(10 * 1024 * 1024),
});

const MAX_IMPORT_ROWS = 10_000;

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export const leadsRoutes = new Hono<{ Variables: AuthVariables }>();
leadsRoutes.use('*', requireAuth);

// ─── List + create ───────────────────────────────────────────────────────────

leadsRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const search = c.req.query('search')?.trim() || undefined;
  const statusParam = c.req.query('status');
  const status =
    statusParam && (LEAD_STATUS as readonly string[]).includes(statusParam)
      ? (statusParam as LeadStatus)
      : undefined;
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));

  const result = await listLeads({
    workspaceId: user.workspaceId,
    search,
    status,
    page,
    limit,
  });
  return c.json(result);
});

leadsRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = CreateLeadBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const checker = await loadBlocklistChecker(user.workspaceId);
  if (checker.isBlocked(parsed.data.email)) {
    return c.json({ error: 'email_blocklisted' }, 409);
  }

  try {
    const created = await createLead(user.workspaceId, parsed.data);
    return c.json({ lead: created }, 201);
  } catch (e) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code: string }).code === '23505'
    ) {
      return c.json({ error: 'email_already_exists' }, 409);
    }
    throw e;
  }
});

// ─── Bulk operations ─────────────────────────────────────────────────────────

leadsRoutes.post('/bulk-delete', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = BulkDeleteBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const count = await bulkDeleteLeads(user.workspaceId, parsed.data.ids);
  return c.json({ deleted: count });
});

leadsRoutes.post('/parse-headers', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ParseHeadersBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  try {
    const headers = parseCsvHeaders(parsed.data.csv);
    // also include up to 5 preview rows
    const allRows = parseCsvRows(parsed.data.csv, true);
    const preview = allRows.slice(0, 5);
    const totalRows = allRows.length;
    return c.json({ headers, preview, totalRows });
  } catch (e) {
    return c.json(
      { error: 'csv_parse_failed', message: e instanceof Error ? e.message : 'parse error' },
      400,
    );
  }
});

leadsRoutes.post('/import', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const parsed = ImportBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  const { csv, hasHeader, mapping, listId, listName } = parsed.data;

  // Convert string-keyed mapping to numeric ColumnMapping
  const numericMapping: ColumnMapping = {};
  for (const [k, v] of Object.entries(mapping)) {
    numericMapping[Number(k)] = v as ColumnField | null;
  }

  let rows: string[][];
  try {
    rows = parseCsvRows(csv, hasHeader);
  } catch (e) {
    return c.json(
      {
        error: 'csv_parse_failed',
        message: e instanceof Error ? e.message : 'parse error',
      },
      400,
    );
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    return c.json({ error: 'too_many_rows', max: MAX_IMPORT_ROWS }, 413);
  }

  try {
    const { valid, errors } = validateAndMap(rows, numericMapping);

    // Filter blocklisted emails (single in-memory pass — no N+1)
    const checker = await loadBlocklistChecker(user.workspaceId);
    const filtered: typeof valid = [];
    const blockedErrors: typeof errors = [];
    for (const v of valid) {
      if (checker.isBlocked(v.email)) {
        blockedErrors.push({ rowIndex: v.rowIndex, reason: 'Email is blocklisted' });
      } else {
        filtered.push(v);
      }
    }

    // Resolve target lead list (if any)
    let resolvedListId: number | null = null;
    if (listId !== undefined) {
      const list = await getLeadListById(listId, user.workspaceId);
      if (!list) return c.json({ error: 'list_not_found' }, 404);
      resolvedListId = list.id;
    } else if (listName) {
      const created = await createLeadList(user.workspaceId, listName);
      resolvedListId = created.id;
    }

    const importedIds = await bulkUpsertLeads(user.workspaceId, filtered);

    if (resolvedListId !== null && importedIds.length > 0) {
      await addLeadsToList(resolvedListId, importedIds, user.workspaceId);
    }

    return c.json({
      imported: importedIds.length,
      parsed: rows.length,
      errors: [...errors, ...blockedErrors],
      listId: resolvedListId,
    });
  } catch (e) {
    // Surface the actual DB/validation error to the client so a "500" becomes
    // actionable (e.g. unique-violation details, value too long, etc.).
    // eslint-disable-next-line no-console
    console.error('[leads/import] failed:', e);
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: 'import_failed', message }, 500);
  }
});

// ─── Single-lead routes ──────────────────────────────────────────────────────

leadsRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const lead = await getLead(id, user.workspaceId);
  if (!lead) return c.json({ error: 'not_found' }, 404);
  return c.json({ lead });
});

leadsRoutes.patch('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateLeadBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const updated = await updateLead(id, user.workspaceId, parsed.data);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ lead: updated });
});

leadsRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const ok = await deleteLead(id, user.workspaceId);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true as const });
});
