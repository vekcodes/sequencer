import { runWarmupSweep } from '../services/warmup';
import { runSmartAdjustSweep } from '../services/smart-adjust';

// Phase 8 background loops:
//   - warmup sweep   (every 30 min): every warmup-enabled mailbox sends its
//     pending warmup quota for the day. The sweep is idempotent — it reads the
//     daily counter and stops when the budget hits zero.
//   - smart-adjust   (every 6 hours): nudges dailyLimitTarget up/down based on
//     recent performance.

const WARMUP_INTERVAL_MS = 30 * 60 * 1000;
const ADJUST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 25_000;

let warmupInFlight = false;
let adjustInFlight = false;

async function warmupTick() {
  if (warmupInFlight) return;
  warmupInFlight = true;
  try {
    const r = await runWarmupSweep();
    if (r.sentTotal > 0 || r.participating > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[warmup] participating=${r.participating} sent=${r.sentTotal}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[warmup] sweep failed:', e);
  } finally {
    warmupInFlight = false;
  }
}

async function adjustTick() {
  if (adjustInFlight) return;
  adjustInFlight = true;
  try {
    const results = await runSmartAdjustSweep();
    const changed = results.filter((r) => r.previousTarget !== r.newTarget);
    if (changed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[smart-adjust] ${changed.length} mailboxes retargeted`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[smart-adjust] failed:', e);
  } finally {
    adjustInFlight = false;
  }
}

export function startWarmupScheduler() {
  setTimeout(warmupTick, STARTUP_DELAY_MS);
  setTimeout(adjustTick, STARTUP_DELAY_MS + 10_000);
  setInterval(warmupTick, WARMUP_INTERVAL_MS);
  setInterval(adjustTick, ADJUST_INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(
    `[warmup-scheduler] running — warmup every ${WARMUP_INTERVAL_MS / 60000}min, smart-adjust every ${ADJUST_INTERVAL_MS / 60000}min`,
  );
}
