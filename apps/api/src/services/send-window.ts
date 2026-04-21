// Pure scheduling primitives: "is campaign sending right now?", "when should
// the next send land?", "add N business days", etc. Kept dependency-free so
// it's unit-testable in isolation (and so the frontend can re-use it later).
//
// TZ handling uses Intl.DateTimeFormat — no moment/dayjs/luxon.

import { DEFAULTS } from '@ces/config';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignScheduleLike = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  timezone: string; // IANA TZ
  avoidHoursLocal: string[]; // ["00:00-06:00", "22:00-24:00"]
};

// ─────────────────────────────────────────────────────────────────────────────
// Time-of-day helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the local wall-clock parts of `date` in `timezone`. Intl.DateTimeFormat
 * is the only TZ library we need — every modern Node has full TZ data.
 */
export function getLocalParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  // Intl returns "24" for midnight in hour12:false mode on some engines.
  const hourRaw = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(get('minute')),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

/** "HH:MM" → minutes since local midnight. */
function parseHHMM(s: string): number {
  const [h = '0', m = '0'] = s.split(':');
  return Number(h) * 60 + Number(m);
}

/** Returns true if the weekday (0=Sun..6=Sat) is enabled on the schedule. */
function isDayEnabled(schedule: CampaignScheduleLike, weekday: number): boolean {
  switch (weekday) {
    case 0:
      return schedule.sunday;
    case 1:
      return schedule.monday;
    case 2:
      return schedule.tuesday;
    case 3:
      return schedule.wednesday;
    case 4:
      return schedule.thursday;
    case 5:
      return schedule.friday;
    case 6:
      return schedule.saturday;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Window checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is `now` inside the campaign's sending window right now?
 *   - day is enabled
 *   - local time is between startTime and endTime
 *   - local time does NOT fall inside any avoidHoursLocal range
 */
export function inSendingWindow(
  schedule: CampaignScheduleLike,
  now: Date = new Date(),
): boolean {
  const local = getLocalParts(now, schedule.timezone);
  if (!isDayEnabled(schedule, local.weekday)) return false;

  const minsNow = local.hour * 60 + local.minute;
  const start = parseHHMM(schedule.startTime);
  const end = parseHHMM(schedule.endTime);
  if (minsNow < start || minsNow >= end) return false;

  for (const range of schedule.avoidHoursLocal) {
    const [from, to] = range.split('-');
    if (!from || !to) continue;
    const a = parseHHMM(from);
    const b = parseHHMM(to);
    if (minsNow >= a && minsNow < b) return false;
  }
  return true;
}

/**
 * Number of minutes remaining in today's sending window, capped at 0 if we're
 * outside it. Used by the inter-send jitter calculation.
 */
export function remainingWindowMinutes(
  schedule: CampaignScheduleLike,
  now: Date = new Date(),
): number {
  if (!inSendingWindow(schedule, now)) return 0;
  const local = getLocalParts(now, schedule.timezone);
  const minsNow = local.hour * 60 + local.minute;
  const end = parseHHMM(schedule.endTime);
  return Math.max(0, end - minsNow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Business days + next-window calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advances `from` by N business days (Mon-Fri), returning a UTC Date. If the
 * schedule disables some weekdays we honor those too — "business days" here
 * means "days the campaign sends on".
 *
 * Returns a Date snapped to the *start* of that day's sending window, in the
 * campaign's timezone. Used to set `campaign_lead.next_send_at` after a send.
 */
export function addBusinessDays(
  from: Date,
  businessDays: number,
  schedule: CampaignScheduleLike,
): Date {
  // Walk day-by-day in the campaign's local TZ.
  let cursor = new Date(from);
  let added = 0;
  // Advance at least one day if businessDays is 0? No — 0 means "eligible now"
  // (first step of the sequence), so don't touch cursor and just snap.
  while (added < businessDays) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    const parts = getLocalParts(cursor, schedule.timezone);
    if (isDayEnabled(schedule, parts.weekday)) {
      added += 1;
    }
    // Safety: cap at 400 iterations so a misconfigured (all-days-off) schedule
    // doesn't spin forever.
    if (added === 0 && cursor.getTime() - from.getTime() > 400 * 24 * 60 * 60 * 1000) {
      break;
    }
  }

  return snapToWindowStart(cursor, schedule);
}

/**
 * Given any instant, returns the next instant that's inside the sending window.
 * If we're already in the window, returns `from` unchanged. If we're past
 * today's window, advances to the next enabled day at startTime.
 */
export function snapToWindowStart(
  from: Date,
  schedule: CampaignScheduleLike,
): Date {
  for (let i = 0; i < 14; i++) {
    const probe = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const parts = getLocalParts(probe, schedule.timezone);
    if (!isDayEnabled(schedule, parts.weekday)) continue;

    const start = parseHHMM(schedule.startTime);
    const end = parseHHMM(schedule.endTime);
    const minsNow = parts.hour * 60 + parts.minute;

    // Today — still inside window.
    if (i === 0 && minsNow >= start && minsNow < end) {
      // Skip forward if we're inside an avoid-hours range.
      for (const range of schedule.avoidHoursLocal) {
        const [f, t] = range.split('-');
        if (!f || !t) continue;
        const a = parseHHMM(f);
        const b = parseHHMM(t);
        if (minsNow >= a && minsNow < b) {
          return localDateAt(probe, schedule.timezone, b);
        }
      }
      return from;
    }

    // Today but before the window opens — snap to start time.
    if (i === 0 && minsNow < start) {
      return localDateAt(probe, schedule.timezone, start);
    }

    // A future day — snap to that day's start time.
    if (i > 0) {
      return localDateAt(probe, schedule.timezone, start);
    }
  }
  // Shouldn't happen unless every single day is disabled — fall back to +1d.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Returns a Date representing "the given day, at `minutesSinceMidnight` local
 * time in `timezone`". Built by computing the offset between UTC and local
 * for that day, then constructing a UTC Date.
 */
function localDateAt(day: Date, timezone: string, minutesSinceMidnight: number): Date {
  const parts = getLocalParts(day, timezone);
  // Construct a "naive UTC" Date at the desired local wall time, then correct
  // by the zone offset. This is the standard Intl-only trick.
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    Math.floor(minutesSinceMidnight / 60),
    minutesSinceMidnight % 60,
    0,
    0,
  );
  // Figure out what local time the "naive UTC" instant actually represents in
  // the target zone, and shift the other direction.
  const probe = new Date(asUtc);
  const probeLocal = getLocalParts(probe, timezone);
  const localMinutes = probeLocal.hour * 60 + probeLocal.minute;
  const drift = minutesSinceMidnight - localMinutes;
  // Guard against day rollover in the drift.
  return new Date(asUtc + drift * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Jitter calculation (ARCHITECTURE §8)
// ─────────────────────────────────────────────────────────────────────────────

export type JitterInput = {
  schedule: CampaignScheduleLike;
  now: Date;
  /** True when this is the lead's first send in the campaign — anti-bulk jitter. */
  isFirstStep: boolean;
  /** Effective daily limit on the mailbox (already discounted for bounce brake). */
  mailboxDailyLimit: number;
  /** How many we've already sent from this mailbox today. */
  mailboxUsageToday: number;
  /** Most recent send timestamp from this mailbox, if any. For the hard floor. */
  lastSendFromMailbox: Date | null;
};

function randomUniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Returns the `send_at` a scheduled_email row should use. Implementation
 * matches ARCHITECTURE §8:
 *   - first step: window.start + uniform(0, 30m)
 *   - otherwise: now + uniform(0.7, 1.3) × (remaining_window / remaining_capacity)
 * Enforces the 60s inter-send floor against the mailbox's last send.
 * Falls inside the window (snap past avoid-hours).
 */
export function computeJitteredSendAt(input: JitterInput): Date {
  const { schedule, now, isFirstStep, mailboxDailyLimit, mailboxUsageToday } = input;

  let candidate: Date;

  if (isFirstStep) {
    // Anti-bot jitter: spread first-sends across the first 30 minutes of the
    // window. If we're already past the start, offset from now instead so the
    // lead doesn't get queued into the past.
    const base = snapToWindowStart(now, schedule);
    const jitterMin = randomUniform(0, DEFAULTS.rateLimit.firstSendJitterMaxMinutes);
    candidate = new Date(base.getTime() + jitterMin * 60_000);
    if (candidate.getTime() < now.getTime()) {
      candidate = new Date(now.getTime() + jitterMin * 60_000);
    }
  } else {
    const remainingCap = Math.max(1, mailboxDailyLimit - mailboxUsageToday);
    const remainingWindowMin = Math.max(1, remainingWindowMinutes(schedule, now));
    const meanGapMin = remainingWindowMin / remainingCap;
    const jitterMin = randomUniform(0.7, 1.3) * meanGapMin;
    candidate = new Date(now.getTime() + jitterMin * 60_000);
  }

  // Hard floor: at least 60s after the last send from this mailbox.
  // Defensively coerce — some drivers hand us an ISO string here despite the
  // Date type annotation. Calling .getTime() on a string used to crash the tick.
  if (input.lastSendFromMailbox) {
    const last =
      input.lastSendFromMailbox instanceof Date
        ? input.lastSendFromMailbox
        : new Date(input.lastSendFromMailbox as unknown as string);
    if (!Number.isNaN(last.getTime())) {
      const floor = new Date(
        last.getTime() + DEFAULTS.rateLimit.minInterSendSeconds * 1000,
      );
      if (candidate.getTime() < floor.getTime()) candidate = floor;
    }
  }

  // Snap forward past any avoid-hours window and out of the window if needed.
  return snapToWindowStart(candidate, schedule);
}
