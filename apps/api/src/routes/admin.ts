import { Hono } from 'hono';
import { forceRunHealthForWorkspace } from '../services/mailbox-health';
import { runSchedulerTick } from '../services/scheduler-tick';
import { runSenderDrain } from '../services/sender-worker';
import {
  processAllConnectedMailboxes,
  processMailboxHistory,
} from '../services/reply-ingestion';
import { renewExpiringWatches, startWatchForMailbox } from '../services/gmail-watch';
import { runWarmupSweep } from '../services/warmup';
import { runSmartAdjustSweep } from '../services/smart-adjust';
import { requireAuth } from '../middleware/auth';
import type { AuthVariables } from '../middleware/auth';

export const adminRoutes = new Hono<{ Variables: AuthVariables }>();

adminRoutes.use('*', requireAuth);

/**
 * Force-runs the mailbox health worker for every mailbox in the current workspace.
 * Used by the "Recompute" button on the detail page and useful for testing.
 */
adminRoutes.post('/run-health', async (c) => {
  const user = c.get('user')!;
  const results = await forceRunHealthForWorkspace(user.workspaceId);
  return c.json({ results });
});

/**
 * Force-runs one scheduler-tick pass across every active campaign. Scoped is
 * workspace-agnostic — the tick is a global pass — but the endpoint is gated
 * behind auth so only signed-in users can trigger it. Useful in dev to see
 * scheduled_email rows appear without waiting 60s.
 */
adminRoutes.post('/scheduler/tick', async (c) => {
  const result = await runSchedulerTick();
  return c.json({ result });
});

/**
 * Force-runs one sender-worker drain. Picks up any already-due scheduled_email
 * rows and processes them inline. Useful in dev to watch sends happen in real
 * time after calling /scheduler/tick.
 */
adminRoutes.post('/sender/drain', async (c) => {
  const result = await runSenderDrain();
  return c.json({ result });
});

/** Force-runs the reply sweep across every connected mailbox in the system. */
adminRoutes.post('/replies/sweep', async (c) => {
  const results = await processAllConnectedMailboxes();
  return c.json({ results });
});

/** Force-runs the reply sweep for a single mailbox. */
adminRoutes.post('/replies/sweep/:mailboxId', async (c) => {
  const mailboxId = Number(c.req.param('mailboxId'));
  if (!Number.isFinite(mailboxId)) return c.json({ error: 'invalid_id' }, 400);
  const result = await processMailboxHistory(mailboxId);
  return c.json({ result });
});

/** Force-starts or renews a Gmail watch for a single mailbox. */
adminRoutes.post('/watch/start/:mailboxId', async (c) => {
  const mailboxId = Number(c.req.param('mailboxId'));
  if (!Number.isFinite(mailboxId)) return c.json({ error: 'invalid_id' }, 400);
  const result = await startWatchForMailbox(mailboxId);
  return c.json({ result });
});

/** Force-renews every expiring watch. */
adminRoutes.post('/watch/renew', async (c) => {
  const result = await renewExpiringWatches();
  return c.json({ result });
});

/** Force-runs the warmup sweep across every warmup-enabled mailbox. */
adminRoutes.post('/warmup/sweep', async (c) => {
  const result = await runWarmupSweep();
  return c.json({ result });
});

/** Force-runs the Smart-Adjust feedback loop across every mailbox. */
adminRoutes.post('/smart-adjust/sweep', async (c) => {
  const result = await runSmartAdjustSweep();
  return c.json({ result });
});
