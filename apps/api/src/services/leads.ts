import { and, eq, ilike, or, sql, desc, inArray } from 'drizzle-orm';
import { lead } from '@ces/db';
import { db } from '../lib/db';

export type LeadRow = typeof lead.$inferSelect;
export type LeadStatus = LeadRow['status'];

export type LeadView = {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  customVariables: Record<string, unknown>;
  timezone: string | null;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
};

export function toLeadView(row: LeadRow): LeadView {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    company: row.company,
    title: row.title,
    phone: row.phone,
    customVariables: (row.customVariables ?? {}) as Record<string, unknown>,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export type ListLeadsParams = {
  workspaceId: number;
  search?: string;
  status?: LeadStatus;
  page: number;
  limit: number;
};

export type ListLeadsResult = {
  leads: LeadView[];
  total: number;
  page: number;
  limit: number;
};

export async function listLeads(
  params: ListLeadsParams,
): Promise<ListLeadsResult> {
  const { workspaceId, search, status, page, limit } = params;

  const conditions = [eq(lead.workspaceId, workspaceId)];
  if (status) conditions.push(eq(lead.status, status));
  if (search && search.trim().length > 0) {
    const term = `%${search.trim()}%`;
    const searchOr = or(
      ilike(lead.email, term),
      ilike(lead.firstName, term),
      ilike(lead.lastName, term),
      ilike(lead.company, term),
    );
    if (searchOr) conditions.push(searchOr);
  }
  const where = and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(lead)
      .where(where)
      .orderBy(desc(lead.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(lead)
      .where(where),
  ]);

  return {
    leads: rows.map(toLeadView),
    total: totalRows[0]?.count ?? 0,
    page,
    limit,
  };
}

export async function getLead(
  id: number,
  workspaceId: number,
): Promise<LeadView | null> {
  const rows = await db
    .select()
    .from(lead)
    .where(and(eq(lead.id, id), eq(lead.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ? toLeadView(rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export type CreateLeadInput = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  timezone?: string | null;
  customVariables?: Record<string, unknown>;
};

function normalize(input: CreateLeadInput) {
  return {
    email: input.email.toLowerCase().trim(),
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    company: input.company ?? null,
    title: input.title ?? null,
    phone: input.phone ?? null,
    timezone: input.timezone ?? null,
    customVariables: input.customVariables ?? {},
  };
}

export async function createLead(
  workspaceId: number,
  input: CreateLeadInput,
): Promise<LeadView | null> {
  const inserted = await db
    .insert(lead)
    .values({ workspaceId, ...normalize(input) })
    .returning();
  return inserted[0] ? toLeadView(inserted[0]) : null;
}

export async function updateLead(
  id: number,
  workspaceId: number,
  input: Partial<CreateLeadInput>,
): Promise<LeadView | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.email !== undefined) set.email = input.email.toLowerCase().trim();
  if (input.firstName !== undefined) set.firstName = input.firstName;
  if (input.lastName !== undefined) set.lastName = input.lastName;
  if (input.company !== undefined) set.company = input.company;
  if (input.title !== undefined) set.title = input.title;
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.timezone !== undefined) set.timezone = input.timezone;
  if (input.customVariables !== undefined)
    set.customVariables = input.customVariables;

  const updated = await db
    .update(lead)
    .set(set)
    .where(and(eq(lead.id, id), eq(lead.workspaceId, workspaceId)))
    .returning();
  return updated[0] ? toLeadView(updated[0]) : null;
}

export async function deleteLead(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(lead)
    .where(and(eq(lead.id, id), eq(lead.workspaceId, workspaceId)))
    .returning({ id: lead.id });
  return deleted.length > 0;
}

export async function bulkDeleteLeads(
  workspaceId: number,
  ids: number[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db
    .delete(lead)
    .where(and(eq(lead.workspaceId, workspaceId), inArray(lead.id, ids)))
    .returning({ id: lead.id });
  return deleted.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk upsert (used by CSV import)
// ─────────────────────────────────────────────────────────────────────────────

const BULK_BATCH_SIZE = 500;

export async function bulkUpsertLeads(
  workspaceId: number,
  inputs: CreateLeadInput[],
): Promise<number[]> {
  if (inputs.length === 0) return [];

  // Dedupe by email WITHIN this batch — ON CONFLICT DO UPDATE throws
  // "cannot affect row a second time" if we send two rows with the same
  // (workspace_id, email) conflict target in a single INSERT. Keep the last
  // occurrence so later rows win (matches a user's intuition for updates).
  const byEmail = new Map<string, CreateLeadInput>();
  for (const input of inputs) {
    const key = input.email.toLowerCase().trim();
    if (!key) continue;
    byEmail.set(key, input);
  }
  const deduped = Array.from(byEmail.values());

  const ids: number[] = [];
  for (let i = 0; i < deduped.length; i += BULK_BATCH_SIZE) {
    const batch = deduped.slice(i, i + BULK_BATCH_SIZE);
    const values = batch.map((input) => ({
      workspaceId,
      ...normalize(input),
    }));

    const inserted = await db
      .insert(lead)
      .values(values)
      .onConflictDoUpdate({
        target: [lead.workspaceId, lead.email],
        set: {
          firstName: sql`EXCLUDED.first_name`,
          lastName: sql`EXCLUDED.last_name`,
          company: sql`EXCLUDED.company`,
          title: sql`EXCLUDED.title`,
          phone: sql`EXCLUDED.phone`,
          timezone: sql`EXCLUDED.timezone`,
          customVariables: sql`EXCLUDED.custom_variables`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: lead.id });

    for (const r of inserted) ids.push(r.id);
  }

  return ids;
}
