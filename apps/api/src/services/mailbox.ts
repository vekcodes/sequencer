import { and, eq } from 'drizzle-orm';
import { mailbox, type mailboxPool } from '@ces/db';
import { db } from '../lib/db';
import { encrypt, decrypt } from '../lib/crypto';
import { refreshAccessToken } from '../lib/google';

export type MailboxRow = typeof mailbox.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Public view (safe to send to the frontend — no encrypted secrets)
// ─────────────────────────────────────────────────────────────────────────────

export type MailboxView = {
  id: number;
  email: string;
  displayName: string | null;
  provider: 'google' | 'microsoft' | 'smtp';
  pool: 'primed' | 'ramping' | 'resting';
  healthStatus: 'connected' | 'disconnected' | 'paused' | 'bouncing';
  healthScore: number;
  dailyLimitTarget: number;
  dailyLimitCurrent: number;
  bounceRate30dBps: number;
  spamComplaintRate30dBps: number;
  spfOk: boolean | null;
  dkimOk: boolean | null;
  dmarcOk: boolean | null;
  mxOk: boolean | null;
  warmupEnabled: boolean;
  warmupDailyLimit: number;
  smartAdjustEnabled: boolean;
  pauseReason: string | null;
  restingUntil: string | null;
  rampStartedAt: string;
  createdAt: string;
  updatedAt: string;
};

export function toView(row: MailboxRow): MailboxView {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    provider: row.provider,
    pool: row.pool,
    healthStatus: row.healthStatus,
    healthScore: row.healthScore,
    dailyLimitTarget: row.dailyLimitTarget,
    dailyLimitCurrent: row.dailyLimitCurrent,
    bounceRate30dBps: row.bounceRate30dBps,
    spamComplaintRate30dBps: row.spamComplaintRate30dBps,
    spfOk: row.spfOk,
    dkimOk: row.dkimOk,
    dmarcOk: row.dmarcOk,
    mxOk: row.mxOk,
    warmupEnabled: row.warmupEnabled,
    warmupDailyLimit: row.warmupDailyLimit,
    smartAdjustEnabled: row.smartAdjustEnabled,
    pauseReason: row.pauseReason,
    restingUntil: row.restingUntil ? row.restingUntil.toISOString() : null,
    rampStartedAt: row.rampStartedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function listMailboxes(workspaceId: number): Promise<MailboxRow[]> {
  return db
    .select()
    .from(mailbox)
    .where(eq(mailbox.workspaceId, workspaceId))
    .orderBy(mailbox.createdAt);
}

export async function getMailbox(
  id: number,
  workspaceId: number,
): Promise<MailboxRow | null> {
  const rows = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.id, id), eq(mailbox.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findMailboxByEmail(
  workspaceId: number,
  email: string,
): Promise<MailboxRow | null> {
  const rows = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.email, email)))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect / reconnect via Google OAuth
// ─────────────────────────────────────────────────────────────────────────────

export type GoogleConnectInput = {
  workspaceId: number;
  email: string;
  displayName: string | null;
  refreshToken: string;
  accessToken: string;
  expiresInSec: number;
  historyId: string;
};

/**
 * Idempotent: if a mailbox with the same email already exists in this workspace,
 * we update its tokens (a re-auth flow). Otherwise we insert a fresh ramping row.
 */
export async function upsertGoogleMailbox(input: GoogleConnectInput): Promise<MailboxRow> {
  const existing = await findMailboxByEmail(input.workspaceId, input.email);
  const expiresAt = new Date(Date.now() + input.expiresInSec * 1000);

  if (existing) {
    const updated = await db
      .update(mailbox)
      .set({
        oauthRefreshToken: encrypt(input.refreshToken),
        oauthAccessToken: encrypt(input.accessToken),
        oauthExpiresAt: expiresAt,
        googleHistoryId: input.historyId,
        displayName: input.displayName ?? existing.displayName,
        healthStatus: 'connected',
        pauseReason: null,
        updatedAt: new Date(),
      })
      .where(eq(mailbox.id, existing.id))
      .returning();
    if (!updated[0]) throw new Error('mailbox_update_failed');
    return updated[0];
  }

  const inserted = await db
    .insert(mailbox)
    .values({
      workspaceId: input.workspaceId,
      provider: 'google',
      email: input.email,
      displayName: input.displayName,
      oauthRefreshToken: encrypt(input.refreshToken),
      oauthAccessToken: encrypt(input.accessToken),
      oauthExpiresAt: expiresAt,
      googleHistoryId: input.historyId,
      pool: 'ramping',
      dailyLimitCurrent: 5,
      dailyLimitTarget: 30,
      rampStartedAt: new Date(),
      healthStatus: 'connected',
    })
    .returning();
  if (!inserted[0]) throw new Error('mailbox_insert_failed');
  return inserted[0];
}

export async function updateMailboxDnsResults(
  mailboxId: number,
  results: {
    spf: boolean | null;
    dkim: boolean | null;
    dmarc: boolean | null;
    mx: boolean | null;
  },
): Promise<void> {
  const now = new Date();
  await db
    .update(mailbox)
    .set({
      spfOk: results.spf,
      dkimOk: results.dkim,
      dmarcOk: results.dmarc,
      mxOk: results.mx,
      spfCheckedAt: now,
      dkimCheckedAt: now,
      dmarcCheckedAt: now,
      mxCheckedAt: now,
    })
    .where(eq(mailbox.id, mailboxId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pause / resume / delete
// ─────────────────────────────────────────────────────────────────────────────

export async function pauseMailbox(
  id: number,
  workspaceId: number,
  reason = 'Paused by user',
): Promise<MailboxRow | null> {
  const updated = await db
    .update(mailbox)
    .set({ healthStatus: 'paused', pauseReason: reason, updatedAt: new Date() })
    .where(and(eq(mailbox.id, id), eq(mailbox.workspaceId, workspaceId)))
    .returning();
  return updated[0] ?? null;
}

export async function resumeMailbox(
  id: number,
  workspaceId: number,
): Promise<MailboxRow | null> {
  const updated = await db
    .update(mailbox)
    .set({ healthStatus: 'connected', pauseReason: null, updatedAt: new Date() })
    .where(and(eq(mailbox.id, id), eq(mailbox.workspaceId, workspaceId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteMailbox(id: number, workspaceId: number): Promise<boolean> {
  const deleted = await db
    .delete(mailbox)
    .where(and(eq(mailbox.id, id), eq(mailbox.workspaceId, workspaceId)))
    .returning({ id: mailbox.id });
  return deleted.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warmup + smart-adjust toggles (Phase 8)
// ─────────────────────────────────────────────────────────────────────────────

export async function updateMailboxWarmup(
  id: number,
  workspaceId: number,
  patch: {
    warmupEnabled?: boolean;
    warmupDailyLimit?: number;
    smartAdjustEnabled?: boolean;
  },
): Promise<MailboxRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.warmupEnabled !== undefined) set.warmupEnabled = patch.warmupEnabled;
  if (patch.warmupDailyLimit !== undefined) {
    // Clamp to a sane range. 0 means "participate but send nothing" which is
    // useful for new mailboxes that want to receive warmup mail without sending.
    set.warmupDailyLimit = Math.max(0, Math.min(50, patch.warmupDailyLimit));
  }
  if (patch.smartAdjustEnabled !== undefined)
    set.smartAdjustEnabled = patch.smartAdjustEnabled;

  const updated = await db
    .update(mailbox)
    .set(set)
    .where(and(eq(mailbox.id, id), eq(mailbox.workspaceId, workspaceId)))
    .returning();
  return updated[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Access token retrieval (auto-refresh if expired)
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS = 60_000; // refresh if token expires within next 60s

/**
 * Returns a valid access token for the given mailbox, refreshing it via the
 * stored refresh_token if necessary. Used by Phase 6+ workers and Phase 7 push.
 */
export async function getMailboxAccessToken(mailboxId: number): Promise<string> {
  const rows = await db
    .select()
    .from(mailbox)
    .where(eq(mailbox.id, mailboxId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('mailbox_not_found');
  if (!row.oauthRefreshToken) throw new Error('mailbox_no_refresh_token');

  const expired =
    !row.oauthAccessToken ||
    !row.oauthExpiresAt ||
    row.oauthExpiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;

  if (!expired && row.oauthAccessToken) {
    return decrypt(row.oauthAccessToken);
  }

  // Refresh
  const refreshToken = decrypt(row.oauthRefreshToken);
  let token;
  try {
    token = await refreshAccessToken(refreshToken);
  } catch (e) {
    await db
      .update(mailbox)
      .set({
        healthStatus: 'disconnected',
        pauseReason: 'OAuth refresh failed — please reconnect',
      })
      .where(eq(mailbox.id, mailboxId));
    throw e;
  }

  const newExpiresAt = new Date(Date.now() + token.expires_in * 1000);
  await db
    .update(mailbox)
    .set({
      oauthAccessToken: encrypt(token.access_token),
      oauthExpiresAt: newExpiresAt,
      // Google doesn't return a new refresh_token on refresh, but if it ever
      // does we should store it.
      ...(token.refresh_token
        ? { oauthRefreshToken: encrypt(token.refresh_token) }
        : {}),
    })
    .where(eq(mailbox.id, mailboxId));

  return token.access_token;
}

// keep the unused export to make tsc happy if no other file imports it yet
export type _MailboxPoolRef = typeof mailboxPool;
