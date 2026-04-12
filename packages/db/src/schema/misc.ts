import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  varchar,
  timestamp,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';
import { workspace } from './auth';

export const tagTargetType = pgEnum('tag_target_type', ['lead', 'campaign', 'mailbox']);

export const tag = pgTable('tag', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: varchar('color', { length: 7 }),
});

// Polymorphic tag attachment — target_id is interpreted by target_type.
export const tagAssignment = pgTable('tag_assignment', {
  id: serial('id').primaryKey(),
  tagId: integer('tag_id')
    .notNull()
    .references(() => tag.id, { onDelete: 'cascade' }),
  targetType: tagTargetType('target_type').notNull(),
  targetId: integer('target_id').notNull(),
});

export const webhook = pgTable('webhook', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  eventTypes: jsonb('event_types').default([]).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Phrases that, when present in an inbound message, classify it as auto_reply
// and prevent the lead from being marked "replied".
export const ignorePhrase = pgTable('ignore_phrase', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  phrase: text('phrase').notNull(),
  language: varchar('language', { length: 8 }).default('en').notNull(),
});

export const replyTemplate = pgTable('reply_template', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
