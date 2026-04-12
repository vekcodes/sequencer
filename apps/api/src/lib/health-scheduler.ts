import { runDailyHealthSweep } from '../services/mailbox-health';

// In-process scheduler for the mailbox health worker. Runs hourly so we can
// pick up newly-connected mailboxes without waiting until the next day.
// `runDailyHealthSweep` is idempotent — it skips mailboxes already processed today.
//
// In production this should move to BullMQ (Phase 6, when we add the send queue
// alongside it). For now, in-process is plenty.

const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000; // wait 30s after boot before the first run

let inFlight = false;

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const { processed, skipped } = await runDailyHealthSweep();
    if (processed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[health-scheduler] processed ${processed} mailbox(es), skipped ${skipped}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[health-scheduler] tick failed:', e);
  } finally {
    inFlight = false;
  }
}

export function startHealthScheduler() {
  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, HOUR_MS);
  // eslint-disable-next-line no-console
  console.log('[health-scheduler] running hourly + 30s after boot');
}
