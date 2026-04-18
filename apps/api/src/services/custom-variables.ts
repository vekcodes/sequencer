// Workspace-defined custom variables. Once a key is defined here, it shows
// up as a direct mapping option in the CSV import UI and — via the
// fallbackDefault — provides the default value when a lead doesn't carry its
// own value for that key.
//
// The storage is per-workspace; lead rows still carry the actual per-lead
// values in lead.customVariables (jsonb).

import { and, eq } from 'drizzle-orm';
import { customVariable } from '@ces/db';
import { db } from '../lib/db';

export type CustomVariableView = {
  id: number;
  key: string;
  fallbackDefault: string | null;
};

function toView(row: typeof customVariable.$inferSelect): CustomVariableView {
  return {
    id: row.id,
    key: row.key,
    fallbackDefault: row.fallbackDefault,
  };
}

/** Sanitizes a variable key to the same shape we allow via the CSV importer. */
export function sanitizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export async function listCustomVariables(
  workspaceId: number,
): Promise<CustomVariableView[]> {
  const rows = await db
    .select()
    .from(customVariable)
    .where(eq(customVariable.workspaceId, workspaceId))
    .orderBy(customVariable.key);
  return rows.map(toView);
}

export async function createCustomVariable(
  workspaceId: number,
  input: { key: string; fallbackDefault?: string | null },
): Promise<CustomVariableView> {
  const key = sanitizeKey(input.key);
  if (!key) throw new Error('invalid_key');
  const inserted = await db
    .insert(customVariable)
    .values({
      workspaceId,
      key,
      fallbackDefault: input.fallbackDefault ?? null,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('custom_variable_create_failed');
  return toView(row);
}

export async function updateCustomVariable(
  id: number,
  workspaceId: number,
  patch: { key?: string; fallbackDefault?: string | null },
): Promise<CustomVariableView | null> {
  const set: Record<string, unknown> = {};
  if (patch.key !== undefined) {
    const key = sanitizeKey(patch.key);
    if (!key) throw new Error('invalid_key');
    set.key = key;
  }
  if (patch.fallbackDefault !== undefined) set.fallbackDefault = patch.fallbackDefault;
  if (Object.keys(set).length === 0) {
    const [row] = await db
      .select()
      .from(customVariable)
      .where(
        and(
          eq(customVariable.id, id),
          eq(customVariable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ? toView(row) : null;
  }
  const updated = await db
    .update(customVariable)
    .set(set)
    .where(
      and(
        eq(customVariable.id, id),
        eq(customVariable.workspaceId, workspaceId),
      ),
    )
    .returning();
  return updated[0] ? toView(updated[0]) : null;
}

export async function deleteCustomVariable(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(customVariable)
    .where(
      and(
        eq(customVariable.id, id),
        eq(customVariable.workspaceId, workspaceId),
      ),
    )
    .returning({ id: customVariable.id });
  return deleted.length > 0;
}
