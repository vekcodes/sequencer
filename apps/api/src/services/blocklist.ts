import { and, eq, desc } from 'drizzle-orm';
import { blocklistEmail, blocklistDomain } from '@ces/db';
import { db } from '../lib/db';

// ─────────────────────────────────────────────────────────────────────────────
// Email blocklist
// ─────────────────────────────────────────────────────────────────────────────

export type BlocklistEmailView = {
  id: number;
  email: string;
  reason: string | null;
  createdAt: string;
};

export async function listBlocklistedEmails(
  workspaceId: number,
): Promise<BlocklistEmailView[]> {
  const rows = await db
    .select()
    .from(blocklistEmail)
    .where(eq(blocklistEmail.workspaceId, workspaceId))
    .orderBy(desc(blocklistEmail.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function addEmailToBlocklist(
  workspaceId: number,
  email: string,
  reason?: string | null,
): Promise<BlocklistEmailView | null> {
  const inserted = await db
    .insert(blocklistEmail)
    .values({
      workspaceId,
      email: email.toLowerCase().trim(),
      reason: reason ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) return null;
  return {
    id: inserted[0].id,
    email: inserted[0].email,
    reason: inserted[0].reason,
    createdAt: inserted[0].createdAt.toISOString(),
  };
}

export async function removeEmailFromBlocklist(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(blocklistEmail)
    .where(
      and(eq(blocklistEmail.id, id), eq(blocklistEmail.workspaceId, workspaceId)),
    )
    .returning({ id: blocklistEmail.id });
  return deleted.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain blocklist
// ─────────────────────────────────────────────────────────────────────────────

export type BlocklistDomainView = {
  id: number;
  domain: string;
  reason: string | null;
  createdAt: string;
};

export async function listBlocklistedDomains(
  workspaceId: number,
): Promise<BlocklistDomainView[]> {
  const rows = await db
    .select()
    .from(blocklistDomain)
    .where(eq(blocklistDomain.workspaceId, workspaceId))
    .orderBy(desc(blocklistDomain.createdAt));
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function addDomainToBlocklist(
  workspaceId: number,
  domain: string,
  reason?: string | null,
): Promise<BlocklistDomainView | null> {
  const inserted = await db
    .insert(blocklistDomain)
    .values({
      workspaceId,
      domain: domain.toLowerCase().trim(),
      reason: reason ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) return null;
  return {
    id: inserted[0].id,
    domain: inserted[0].domain,
    reason: inserted[0].reason,
    createdAt: inserted[0].createdAt.toISOString(),
  };
}

export async function removeDomainFromBlocklist(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(blocklistDomain)
    .where(
      and(eq(blocklistDomain.id, id), eq(blocklistDomain.workspaceId, workspaceId)),
    )
    .returning({ id: blocklistDomain.id });
  return deleted.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the workspace's full blocklist into memory and returns a fast checker.
 * Used by CSV import to filter blocked rows without N+1 queries.
 */
export async function loadBlocklistChecker(workspaceId: number): Promise<{
  isBlocked: (email: string) => boolean;
}> {
  const [emails, domains] = await Promise.all([
    db
      .select({ email: blocklistEmail.email })
      .from(blocklistEmail)
      .where(eq(blocklistEmail.workspaceId, workspaceId)),
    db
      .select({ domain: blocklistDomain.domain })
      .from(blocklistDomain)
      .where(eq(blocklistDomain.workspaceId, workspaceId)),
  ]);

  const emailSet = new Set(emails.map((e) => e.email.toLowerCase()));
  const domainSet = new Set(domains.map((d) => d.domain.toLowerCase()));

  return {
    isBlocked(email: string) {
      const lower = email.toLowerCase().trim();
      if (emailSet.has(lower)) return true;
      const at = lower.indexOf('@');
      if (at < 0) return false;
      const domain = lower.slice(at + 1);
      return domainSet.has(domain);
    },
  };
}

/** Single-email check (used by single-lead create endpoint). */
export async function isEmailBlocked(
  workspaceId: number,
  email: string,
): Promise<boolean> {
  const checker = await loadBlocklistChecker(workspaceId);
  return checker.isBlocked(email);
}
