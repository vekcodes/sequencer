import { runSchedulerTick } from '../services/scheduler-tick';
import { runSenderDrain } from '../services/sender-worker';

// In-process loops for Phase 6. Mirrors the pattern established by
// `health-scheduler.ts`: no queue infra (BullMQ/Redis) yet — just setInterval.
//
// Two loops:
//   - scheduler-tick  : every 60s. Inserts new scheduled_email rows for due leads.
//   - sender-worker   : every 10s. Drains scheduled_email rows whose send_at has passed.
//
// Both are single-instance only — if you run multiple API processes, you'd
// end up with duplicate ticks. The sender-worker's FOR UPDATE SKIP LOCKED keeps
// that safe, but the scheduler-tick relies on each tick's writes being
// idempotent via `nextSendAt` being pushed forward. When we move to real
// infra (Phase 9+) these become BullMQ jobs and the interval-arming here is
// deleted.

const TICK_INTERVAL_MS = 60_000;
const DRAIN_INTERVAL_MS = 10_000;
const STARTUP_DELAY_MS = 5_000;

let tickInFlight = false;
let drainInFlight = false;

async function tickLoop() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const result = await runSchedulerTick();
    if (result.enqueued > 0 || result.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[scheduler-tick] enqueued=${result.enqueued} ` +
          `deferred_no_mailbox=${result.deferredNoMailbox} ` +
          `deferred_domain=${result.deferredDomainLimit} ` +
          `deferred_vars=${result.deferredUnresolvedVars} ` +
          `errors=${result.errors.length}`,
      );
      for (const err of result.errors) {
        // eslint-disable-next-line no-console
        console.error(
          `[scheduler-tick] campaign=${err.campaignId} error:\n${err.error}`,
        );
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scheduler-tick] tick failed:', e);
  } finally {
    tickInFlight = false;
  }
}

async function drainLoop() {
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    const result = await runSenderDrain();
    if (result.claimed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[sender-worker] claimed=${result.claimed} sent=${result.sent} ` +
          `bounced=${result.failedBounced} disconnect=${result.failedDisconnected} ` +
          `retry=${result.failedRetryable} other=${result.failedOther} ` +
          `skipped=${result.skipped}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[sender-worker] drain failed:', e);
  } finally {
    drainInFlight = false;
  }
}

export function startSendScheduler() {
  setTimeout(tickLoop, STARTUP_DELAY_MS);
  setTimeout(drainLoop, STARTUP_DELAY_MS + 2_000);
  setInterval(tickLoop, TICK_INTERVAL_MS);
  setInterval(drainLoop, DRAIN_INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(
    `[send-scheduler] running — scheduler-tick every ${TICK_INTERVAL_MS / 1000}s, sender-worker every ${DRAIN_INTERVAL_MS / 1000}s`,
  );
}
