// Cold-email-best-practice DEFAULTS.
// These are the values the system enforces unless explicitly overridden.
// See ARCHITECTURE.md section 11 for the rationale and sources behind each number.

export const DEFAULTS = {
  mailbox: {
    /** Target daily send cap per inbox once fully ramped (Instantly: 30/day safe ceiling). */
    dailyLimitTarget: 30,
    /** Day-1 send cap for a brand new mailbox. */
    dailyLimitInitial: 5,
    /** Day -> sends/day curve until reaching target. Source: Instantly warmup curve. */
    rampCurve: [
      [1, 5],
      [2, 6],
      [3, 8],
      [4, 10],
      [5, 12],
      [6, 15],
      [7, 18],
      [8, 20],
      [9, 22],
      [10, 25],
      [11, 27],
      [12, 30],
    ] as const,
  },

  campaign: {
    maxEmailsPerDay: 1000,
    maxNewLeadsPerDay: 50,
    plainText: true,
    openTracking: false,
    clickTracking: false,
    canUnsubscribe: true,
    reputationBuilding: true,
    sequencePrioritization: 'followups' as const,
    useLeadTimezone: true,
    skipHolidays: true,
    replyBehavior: 'auto_pause_lead' as const,
  },

  schedule: {
    days: {
      mon: true,
      tue: true,
      wed: true,
      thu: true,
      fri: true,
      sat: false,
      sun: false,
    },
    startTime: '09:00',
    endTime: '16:30',
    avoidHoursLocal: ['00:00-06:00', '22:00-24:00'] as const,
  },

  /** Default 6-step outbound sequence: day 0/3/7/14/21/30 (business days). */
  sequenceTemplate: [
    { order: 1, waitInBusinessDays: 0, threadReply: false },
    { order: 2, waitInBusinessDays: 3, threadReply: true },
    { order: 3, waitInBusinessDays: 4, threadReply: true },
    { order: 4, waitInBusinessDays: 7, threadReply: true },
    { order: 5, waitInBusinessDays: 7, threadReply: true },
    { order: 6, waitInBusinessDays: 9, threadReply: true },
  ] as const,

  health: {
    /** Mailbox is auto-rested when health drops below this. Source: Instantly. */
    healthScoreMin: 85,
    /** Spam complaint rate ceiling (basis points). 30 bp = 0.30%. */
    spamComplaintHardCeilingBps: 30,
    /** Bounce rate that triggers the dynamic brake (basis points). 200 bp = 2%. */
    bounceRateCircuitBreakerBps: 200,
    /** When the dynamic brake fires, multiply next-day cap by this factor. */
    bounceCircuitBrakeMultiplier: 0.5,
    /** How long bounce-rest lasts. */
    bounceCircuitDurationHours: 48,
    /** How long health-rest lasts. */
    healthRestDurationDays: 7,
    /** Min ramping days before a mailbox can promote to "primed". */
    rampToPromotedDays: 28,
    /** Min health score to promote ramping -> primed. */
    promotionMinHealth: 90,
  },

  rateLimit: {
    /** Max emails to a single recipient domain per hour, workspace-wide. */
    perDomainPerHour: 5,
    /** Hard floor between two consecutive sends from the same mailbox. */
    minInterSendSeconds: 60,
    /** First-send-of-day jitter window — anti "bot at 9:00:00" pattern. */
    firstSendJitterMaxMinutes: 30,
  },

  gmail: {
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid',
    ] as const,
    /** Google's hard ceiling for external recipients per Workspace user per day. */
    workspaceDailyExternalCap: 2000,
    /** Re-call gmail.users.watch() before this many days (watches expire after 7). */
    watchRenewIntervalDays: 6,
  },
} as const;

export type Defaults = typeof DEFAULTS;
