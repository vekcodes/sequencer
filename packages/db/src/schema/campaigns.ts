import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { workspace } from './auth';
import { mailbox } from './mailbox';
import { lead } from './leads';

export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
]);
export const campaignType = pgEnum('campaign_type', ['outbound', 'reply_followup']);
export const sequencePrioritization = pgEnum('sequence_prioritization', [
  'followups',
  'new_leads',
]);
export const replyBehavior = pgEnum('reply_behavior', ['auto_pause_lead', 'continue']);
export const campaignLeadStatus = pgEnum('campaign_lead_status', [
  'queued',
  'active',
  'completed',
  'replied',
  'unsubscribed',
  'bounced',
  'paused',
]);

export const campaign = pgTable('campaign', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: campaignStatus('status').default('draft').notNull(),
  type: campaignType('type').default('outbound').notNull(),

  // Limits
  maxEmailsPerDay: integer('max_emails_per_day').default(1000).notNull(),
  maxNewLeadsPerDay: integer('max_new_leads_per_day').default(50).notNull(),

  // Deliverability defaults (safe by default)
  plainText: boolean('plain_text').default(true).notNull(),
  openTracking: boolean('open_tracking').default(false).notNull(),
  clickTracking: boolean('click_tracking').default(false).notNull(),
  reputationBuilding: boolean('reputation_building').default(true).notNull(),
  canUnsubscribe: boolean('can_unsubscribe').default(true).notNull(),
  unsubscribeText: text('unsubscribe_text').default('Unsubscribe here').notNull(),
  customTrackingDomainId: integer('custom_tracking_domain_id'),

  // Behavior
  sequencePrioritization: sequencePrioritization('sequence_prioritization')
    .default('followups')
    .notNull(),
  replyBehavior: replyBehavior('reply_behavior').default('auto_pause_lead').notNull(),
  bounceBehavior: text('bounce_behavior').default('auto_pause_lead').notNull(),
  useLeadTimezone: boolean('use_lead_timezone').default(true).notNull(),
  skipHolidays: boolean('skip_holidays').default(true).notNull(),
  holidayCalendar: text('holiday_calendar').default('US'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const campaignSchedule = pgTable('campaign_schedule', {
  campaignId: integer('campaign_id')
    .primaryKey()
    .references(() => campaign.id, { onDelete: 'cascade' }),
  monday: boolean('monday').default(true).notNull(),
  tuesday: boolean('tuesday').default(true).notNull(),
  wednesday: boolean('wednesday').default(true).notNull(),
  thursday: boolean('thursday').default(true).notNull(),
  friday: boolean('friday').default(true).notNull(),
  saturday: boolean('saturday').default(false).notNull(),
  sunday: boolean('sunday').default(false).notNull(),
  startTime: text('start_time').default('09:00').notNull(),
  endTime: text('end_time').default('16:30').notNull(),
  timezone: text('timezone').default('America/New_York').notNull(),
  avoidHoursLocal: jsonb('avoid_hours_local')
    .default(['00:00-06:00', '22:00-24:00'])
    .notNull(),
});

export const sequenceStep = pgTable(
  'sequence_step',
  {
    id: serial('id').primaryKey(),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    waitInBusinessDays: integer('wait_in_business_days').default(0).notNull(),
    waitInDays: integer('wait_in_days'),
    threadReply: boolean('thread_reply').default(true).notNull(),
    stopOnReply: boolean('stop_on_reply').default(true).notNull(),
  },
  (t) => ({
    campaignOrderIdx: uniqueIndex('sequence_step_campaign_order_idx').on(
      t.campaignId,
      t.stepOrder,
    ),
  }),
);

export const sequenceStepVariant = pgTable('sequence_step_variant', {
  id: serial('id').primaryKey(),
  sequenceStepId: integer('sequence_step_id')
    .notNull()
    .references(() => sequenceStep.id, { onDelete: 'cascade' }),
  weight: integer('weight').default(100).notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  attachments: jsonb('attachments'),
});

// M:N campaign <-> mailbox with per-pairing weight + active flag
export const campaignSender = pgTable(
  'campaign_sender',
  {
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    mailboxId: integer('mailbox_id')
      .notNull()
      .references(() => mailbox.id, { onDelete: 'cascade' }),
    weight: integer('weight').default(100).notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.campaignId, t.mailboxId] }),
  }),
);

// The enrollment table — per-lead state in a campaign.
// This is where scheduling lives (next_send_at) and where stickiness is recorded.
export const campaignLead = pgTable(
  'campaign_lead',
  {
    id: serial('id').primaryKey(),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    leadId: integer('lead_id')
      .notNull()
      .references(() => lead.id, { onDelete: 'cascade' }),
    status: campaignLeadStatus('status').default('queued').notNull(),
    currentStep: integer('current_step').default(0).notNull(),
    nextSendAt: timestamp('next_send_at', { withTimezone: true }),
    assignedMailboxId: integer('assigned_mailbox_id').references(() => mailbox.id),
    threadId: text('thread_id'),
    firstMessageId: text('first_message_id'),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    uniq: uniqueIndex('campaign_lead_campaign_lead_idx').on(t.campaignId, t.leadId),
  }),
);
