import { processAllConnectedMailboxes } from '../services/reply-ingestion';
import { renewExpiringWatches } from '../services/gmail-watch';

// Phase 7 background loops:
//   - reply-sweep (every 5 min): history-walks every connected mailbox. A
//     fallback for when Pub/Sub is down or the shared-secret push isn't
//     configured in dev.
//   - watch-renew (every 6 hours): re-calls gmail.users.watch() for mailboxes
//     whose watches are within 1 day of expiry.

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;

let sweepInFlight = false;
let renewInFlight = false;

async function sweep() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const results = await processAllConnectedMailboxes();
    const totalIngested = results.reduce((s, r) => s + r.messagesIngested, 0);
    if (totalIngested > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[reply-sweep] processed ${results.length} mailboxes, ingested ${totalIngested}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[reply-sweep] failed:', e);
  } finally {
    sweepInFlight = false;
  }
}

async function renew() {
  if (renewInFlight) return;
  renewInFlight = true;
  try {
    const r = await renewExpiringWatches();
    if (r.checked > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[watch-renew] checked=${r.checked} renewed=${r.renewed} failures=${r.failures.length}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[watch-renew] failed:', e);
  } finally {
    renewInFlight = false;
  }
}

export function startReplyScheduler() {
  setTimeout(sweep, STARTUP_DELAY_MS);
  setTimeout(renew, STARTUP_DELAY_MS + 5_000);
  setInterval(sweep, SWEEP_INTERVAL_MS);
  setInterval(renew, RENEW_INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(
    `[reply-scheduler] running — sweep every ${SWEEP_INTERVAL_MS / 1000}s, watch-renew every ${RENEW_INTERVAL_MS / 1000 / 60}min`,
  );
}
