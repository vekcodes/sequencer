import {
  pgTable,
  pgEnum,
  serial,
  bigserial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';
import { workspace } from './auth';
import { mailbox } from './mailbox';
import { campaign, campaignLead, sequenceStep, sequenceStepVariant } from './campaigns';

export const scheduledEmailStatus = pgEnum('scheduled_email_status', [
  'queued',
  'sending',
  'sent',
  'failed',
  'bounced',
  'cancelled',
]);
export const emailEventType = pgEnum('email_event_type', [
  'sent',
  'opened',
  'clicked',
  'replied',
  'bounced',
  'unsubscribed',
  'failed',
]);
export const replyClassification = pgEnum('reply_classification', [
  'interested',
  'not_interested',
  'neutral',
  'auto_reply',
  'unknown',
]);

// The send queue. scheduler-tick inserts; sender-worker reads.
export const scheduledEmail = pgTable('scheduled_email', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  campaignLeadId: integer('campaign_lead_id')
    .notNull()
    .references(() => campaignLead.id, { onDelete: 'cascade' }),
  sequenceStepId: integer('sequence_step_id')
    .notNull()
    .references(() => sequenceStep.id),
  sequenceStepVariantId: integer('sequence_step_variant_id')
    .notNull()
    .references(() => sequenceStepVariant.id),
  mailboxId: integer('mailbox_id')
    .notNull()
    .references(() => mailbox.id),
  subjectRendered: text('subject_rendered').notNull(),
  bodyRenderedText: text('body_rendered_text').notNull(),
  bodyRenderedHtml: text('body_rendered_html'),
  sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
  status: scheduledEmailStatus('status').default('queued').notNull(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  lastError: text('last_error'),
  gmailMessageId: text('gmail_message_id'),
  inReplyToMessageId: text('in_reply_to_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});

// Append-only event log. Drives analytics + webhooks.
export const emailEvent = pgTable('email_event', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  campaignId: integer('campaign_id').references(() => campaign.id),
  campaignLeadId: integer('campaign_lead_id').references(() => campaignLead.id),
  mailboxId: integer('mailbox_id').references(() => mailbox.id),
  scheduledEmailId: integer('scheduled_email_id'),
  type: emailEventType('type').notNull(),
  payload: jsonb('payload').default({}).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
});

// Master inbox row. Populated by gmail-push-listener.
export const reply = pgTable('reply', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  campaignLeadId: integer('campaign_lead_id').references(() => campaignLead.id),
  mailboxId: integer('mailbox_id')
    .notNull()
    .references(() => mailbox.id),
  gmailThreadId: text('gmail_thread_id'),
  gmailMessageId: text('gmail_message_id'),
  subject: text('subject'),
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name'),
  toEmail: text('to_email'),
  classification: replyClassification('classification').default('unknown').notNull(),
  read: boolean('read').default(false).notNull(),
  starred: boolean('starred').default(false).notNull(),
  archived: boolean('archived').default(false).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
});
