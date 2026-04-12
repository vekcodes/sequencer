// Phase 9 — webhooks.
//
// Workspace-scoped CRUD over the `webhook` table + a fire-and-forget
// dispatcher. Every domain write site (sender-worker, reply-ingestion,
// campaign transition) calls `dispatchEvent` after its insert — this is the
// same pattern EmailBison uses.
//
// Dispatch contract:
//   - POST to webhook.url
//   - Body is a stable JSON envelope
//   - Headers: X-CES-Event, X-CES-Signature (HMAC-SHA256 of body with
//     webhook.secret), X-CES-Timestamp, X-CES-Delivery (uuid)
//   - Retries: up to 3 attempts with exponential backoff (1s, 5s, 25s)
//   - Non-2xx or timeout → retry; 2xx → success
//
// Delivery runs in the Node event loop via setTimeout. We don't persist
// pending deliveries — a server restart drops in-flight retries on the floor.
// That's acceptable for Phase 9 (the EmailBison parity is the URL/signature
// shape, not at-least-once delivery); Phase 10+ can move it to a durable
// queue if we need stronger guarantees.

import { and, eq, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import { webhook } from '@ces/db';
import { db } from '../lib/db';

// ─────────────────────────────────────────────────────────────────────────────
// Event types — mirrors EmailBison's set so clients can swap providers.
// ─────────────────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENT_TYPES = [
  'lead_sent',
  'lead_opened',
  'lead_replied',
  'lead_interested',
  'lead_not_interested',
  'lead_bounced',
  'lead_unsubscribed',
  'campaign_launched',
  'campaign_paused',
  'campaign_completed',
  'mailbox_connected',
  'mailbox_disconnected',
  'mailbox_pool_changed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export type WebhookView = {
  id: number;
  url: string;
  eventTypes: WebhookEventType[];
  active: boolean;
  createdAt: string;
  secretPreview: string;
};

function toView(row: typeof webhook.$inferSelect): WebhookView {
  return {
    id: row.id,
    url: row.url,
    eventTypes: (row.eventTypes as WebhookEventType[] | null) ?? [],
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    // Don't leak the full secret after it's set — show first 6 chars.
    secretPreview: row.secret.slice(0, 6) + '…',
  };
}

export async function listWebhooks(workspaceId: number): Promise<WebhookView[]> {
  const rows = await db
    .select()
    .from(webhook)
    .where(eq(webhook.workspaceId, workspaceId))
    .orderBy(webhook.createdAt);
  return rows.map(toView);
}

export async function createWebhook(
  workspaceId: number,
  input: { url: string; eventTypes: WebhookEventType[]; active?: boolean },
): Promise<{ webhook: WebhookView; secret: string }> {
  // Secrets are shown once on create. The client must save it — we never return
  // it again.
  const secret = `whsec_${randomUUID().replace(/-/g, '')}`;
  const [row] = await db
    .insert(webhook)
    .values({
      workspaceId,
      url: input.url,
      secret,
      eventTypes: input.eventTypes,
      active: input.active ?? true,
    })
    .returning();
  if (!row) throw new Error('webhook_create_failed');
  return { webhook: toView(row), secret };
}

export async function updateWebhook(
  id: number,
  workspaceId: number,
  patch: { url?: string; eventTypes?: WebhookEventType[]; active?: boolean },
): Promise<WebhookView | null> {
  const set: Record<string, unknown> = {};
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.eventTypes !== undefined) set.eventTypes = patch.eventTypes;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) {
    const [row] = await db
      .select()
      .from(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.workspaceId, workspaceId)))
      .limit(1);
    return row ? toView(row) : null;
  }
  const [row] = await db
    .update(webhook)
    .set(set)
    .where(and(eq(webhook.id, id), eq(webhook.workspaceId, workspaceId)))
    .returning();
  return row ? toView(row) : null;
}

export async function deleteWebhook(
  id: number,
  workspaceId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(webhook)
    .where(and(eq(webhook.id, id), eq(webhook.workspaceId, workspaceId)))
    .returning({ id: webhook.id });
  return deleted.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

function hmacSign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

type Envelope = {
  id: string;
  type: WebhookEventType;
  workspace_id: number;
  created_at: string;
  data: Record<string, unknown>;
};

type Outgoing = {
  webhookId: number;
  url: string;
  secret: string;
  body: string;
  headers: Record<string, string>;
  attempt: number;
};

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;
const BACKOFFS_MS = [1_000, 5_000, 25_000];

async function attempt(out: Outgoing): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(out.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...out.headers,
      },
      body: out.body,
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function scheduleRetry(out: Outgoing): void {
  if (out.attempt >= MAX_ATTEMPTS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[webhooks] giving up after ${MAX_ATTEMPTS} attempts for webhook ${out.webhookId}`,
    );
    return;
  }
  const delay = BACKOFFS_MS[Math.min(out.attempt - 1, BACKOFFS_MS.length - 1)] ?? 25_000;
  setTimeout(async () => {
    out.attempt += 1;
    const ok = await attempt(out);
    if (!ok) scheduleRetry(out);
  }, delay);
}

/**
 * Best-effort dispatch. Non-blocking — the caller doesn't wait. If no webhooks
 * are registered for the event type, this is a no-op after the lookup.
 */
export async function dispatchEvent(
  workspaceId: number,
  type: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const rows = await db
    .select()
    .from(webhook)
    .where(
      and(
        eq(webhook.workspaceId, workspaceId),
        eq(webhook.active, true),
        // eventTypes is a JSON array column — postgres ? operator tests membership
        sql`${webhook.eventTypes} ? ${type}`,
      ),
    );

  if (rows.length === 0) return;

  const envelope: Envelope = {
    id: randomUUID(),
    type,
    workspace_id: workspaceId,
    created_at: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));

  for (const w of rows) {
    const signature = hmacSign(w.secret, `${timestamp}.${body}`);
    const out: Outgoing = {
      webhookId: w.id,
      url: w.url,
      secret: w.secret,
      body,
      headers: {
        'X-CES-Event': type,
        'X-CES-Delivery': envelope.id,
        'X-CES-Timestamp': timestamp,
        'X-CES-Signature': `t=${timestamp},v1=${signature}`,
      },
      attempt: 1,
    };
    attempt(out).then((ok) => {
      if (!ok) scheduleRetry(out);
    });
  }
}

/** Send a dummy ping — used by the "Test" button in the webhooks UI. */
export async function testWebhook(
  id: number,
  workspaceId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db
    .select()
    .from(webhook)
    .where(and(eq(webhook.id, id), eq(webhook.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };

  const envelope: Envelope = {
    id: randomUUID(),
    type: 'lead_sent',
    workspace_id: workspaceId,
    created_at: new Date().toISOString(),
    data: { test: true },
  };
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = hmacSign(row.secret, `${timestamp}.${body}`);

  const out: Outgoing = {
    webhookId: row.id,
    url: row.url,
    secret: row.secret,
    body,
    headers: {
      'X-CES-Event': 'lead_sent',
      'X-CES-Delivery': envelope.id,
      'X-CES-Timestamp': timestamp,
      'X-CES-Signature': `t=${timestamp},v1=${signature}`,
      'X-CES-Test': 'true',
    },
    attempt: 1,
  };
  const ok = await attempt(out);
  return { ok, reason: ok ? undefined : 'delivery_failed' };
}
