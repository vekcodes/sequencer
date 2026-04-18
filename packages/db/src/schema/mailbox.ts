import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  date,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { workspace } from './auth';

export const mailboxProvider = pgEnum('mailbox_provider', ['google', 'microsoft', 'smtp']);
export const mailboxPool = pgEnum('mailbox_pool', ['primed', 'ramping', 'resting']);
export const mailboxHealthStatus = pgEnum('mailbox_health_status', [
  'connected',
  'disconnected',
  'paused',
  'bouncing',
]);
export const mailboxRestingReason = pgEnum('mailbox_resting_reason', [
  'spam',
  'bounce',
  'health',
  'manual',
]);

// A connected sender mailbox (Gmail / Outlook / SMTP).
// Rates stored as basis points (1 bp = 0.01%) to avoid floats.
export const mailbox = pgTable(
  'mailbox',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    provider: mailboxProvider('provider').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    signatureHtml: text('signature_html'),

    // OAuth (encrypted at rest by application code, not the DB)
    oauthRefreshToken: text('oauth_refresh_token'),
    oauthAccessToken: text('oauth_access_token'),
    oauthExpiresAt: timestamp('oauth_expires_at', { withTimezone: true }),

    // Gmail-specific
    googleHistoryId: text('google_history_id'),
    googleWatchExpiresAt: timestamp('google_watch_expires_at', { withTimezone: true }),
    googleLabelId: text('google_label_id'),

    // Portfolio classification
    pool: mailboxPool('pool').default('ramping').notNull(),
    poolChangedAt: timestamp('pool_changed_at', { withTimezone: true }).defaultNow().notNull(),
    restingUntil: timestamp('resting_until', { withTimezone: true }),
    restingReason: mailboxRestingReason('resting_reason'),

    // Limits + ramp
    dailyLimitTarget: integer('daily_limit_target').default(30).notNull(),
    dailyLimitCurrent: integer('daily_limit_current').default(5).notNull(),
    rampStartedAt: timestamp('ramp_started_at', { withTimezone: true }).defaultNow().notNull(),
    rampCompletedAt: timestamp('ramp_completed_at', { withTimezone: true }),

    // Warmup
    warmupEnabled: boolean('warmup_enabled').default(false).notNull(),
    warmupDailyLimit: integer('warmup_daily_limit').default(0).notNull(),
    smartAdjustEnabled: boolean('smart_adjust_enabled').default(true).notNull(),

    // Health (rates in basis points: 200 bp = 2%)
    healthScore: integer('health_score').default(100).notNull(),
    placementScore: integer('placement_score').default(100).notNull(),
    bounceRate30dBps: integer('bounce_rate_30d_bps').default(0).notNull(),
    spamComplaintRate30dBps: integer('spam_complaint_rate_30d_bps').default(0).notNull(),
    consecutiveBounceCount: integer('consecutive_bounce_count').default(0).notNull(),

    // DNS checks
    spfOk: boolean('spf_ok'),
    dkimOk: boolean('dkim_ok'),
    dmarcOk: boolean('dmarc_ok'),
    mxOk: boolean('mx_ok'),
    spfCheckedAt: timestamp('spf_checked_at', { withTimezone: true }),
    dkimCheckedAt: timestamp('dkim_checked_at', { withTimezone: true }),
    dmarcCheckedAt: timestamp('dmarc_checked_at', { withTimezone: true }),
    mxCheckedAt: timestamp('mx_checked_at', { withTimezone: true }),

    // Status
    healthStatus: mailboxHealthStatus('health_status').default('connected').notNull(),
    pauseReason: text('pause_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceEmailIdx: uniqueIndex('mailbox_workspace_email_idx').on(t.workspaceId, t.email),
  }),
);

// Per-mailbox per-day counter so we never exceed the daily cap.
// Resets at the mailbox's local midnight (handled in app code).
export const mailboxDailyUsage = pgTable(
  'mailbox_daily_usage',
  {
    mailboxId: integer('mailbox_id')
      .notNull()
      .references(() => mailbox.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    sendsUsed: integer('sends_used').default(0).notNull(),
    warmupSendsUsed: integer('warmup_sends_used').default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mailboxId, t.date] }),
  }),
);

// Warmup engagement log. Every inbound message from another warmup-enabled
// mailbox in the same workspace creates one of these rows. A background tick
// picks up rows with state='pending' where reply_at <= now() and sends a
// conversational auto-reply on the same thread — this is what actually moves
// the deliverability needle for new inboxes.
export const warmupEngagementState = pgEnum('warmup_engagement_state', [
  'pending',
  'replied',
  'skipped',
]);

export const warmupEngagement = pgTable('warmup_engagement', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  // The mailbox that RECEIVED the warmup message and will send the reply.
  mailboxId: integer('mailbox_id')
    .notNull()
    .references(() => mailbox.id, { onDelete: 'cascade' }),
  // The other workspace mailbox that sent the warmup message in the first place.
  partnerMailboxId: integer('partner_mailbox_id')
    .notNull()
    .references(() => mailbox.id, { onDelete: 'cascade' }),
  gmailThreadId: text('gmail_thread_id').notNull(),
  gmailMessageId: text('gmail_message_id').notNull(),
  subject: text('subject'),
  bodyText: text('body_text'),
  state: warmupEngagementState('state').default('pending').notNull(),
  rescuedFromSpam: boolean('rescued_from_spam').default(false).notNull(),
  replyAt: timestamp('reply_at', { withTimezone: true }).notNull(),
  repliedAt: timestamp('replied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Append-only daily snapshot for the health dashboard's trend charts.
export const mailboxHealthSnapshot = pgTable(
  'mailbox_health_snapshot',
  {
    id: serial('id').primaryKey(),
    mailboxId: integer('mailbox_id')
      .notNull()
      .references(() => mailbox.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    pool: mailboxPool('pool').notNull(),
    healthScore: integer('health_score').notNull(),
    placementScore: integer('placement_score').notNull(),
    bounceRate30dBps: integer('bounce_rate_30d_bps').notNull(),
    spamRate30dBps: integer('spam_rate_30d_bps').notNull(),
    sendsCount: integer('sends_count').default(0).notNull(),
    opensCount: integer('opens_count').default(0).notNull(),
    repliesCount: integer('replies_count').default(0).notNull(),
    bouncesCount: integer('bounces_count').default(0).notNull(),
    effectiveDailyLimit: integer('effective_daily_limit').notNull(),
  },
  (t) => ({
    mailboxDateIdx: uniqueIndex('mailbox_health_snapshot_mailbox_date_idx').on(
      t.mailboxId,
      t.date,
    ),
  }),
);
