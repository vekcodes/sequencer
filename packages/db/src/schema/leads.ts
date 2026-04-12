import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  varchar,
  timestamp,
  jsonb,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { workspace } from './auth';

export const leadStatus = pgEnum('lead_status', [
  'active',
  'replied',
  'unsubscribed',
  'bounced',
  'blacklisted',
]);

export const lead = pgTable(
  'lead',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    company: text('company'),
    title: text('title'),
    phone: text('phone'),
    customVariables: jsonb('custom_variables').default({}).notNull(),
    timezone: text('timezone'),
    status: leadStatus('status').default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceEmailIdx: uniqueIndex('lead_workspace_email_idx').on(t.workspaceId, t.email),
  }),
);

export const leadList = pgTable('lead_list', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const leadListMembership = pgTable(
  'lead_list_membership',
  {
    leadId: integer('lead_id')
      .notNull()
      .references(() => lead.id, { onDelete: 'cascade' }),
    leadListId: integer('lead_list_id')
      .notNull()
      .references(() => leadList.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.leadId, t.leadListId] }),
  }),
);

export const customVariable = pgTable(
  'custom_variable',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    fallbackDefault: text('fallback_default'),
  },
  (t) => ({
    workspaceKeyIdx: uniqueIndex('custom_variable_workspace_key_idx').on(t.workspaceId, t.key),
  }),
);

export const blocklistEmail = pgTable(
  'blocklist_email',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceEmailIdx: uniqueIndex('blocklist_email_workspace_email_idx').on(
      t.workspaceId,
      t.email,
    ),
  }),
);

export const blocklistDomain = pgTable(
  'blocklist_domain',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    domain: varchar('domain', { length: 253 }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceDomainIdx: uniqueIndex('blocklist_domain_workspace_domain_idx').on(
      t.workspaceId,
      t.domain,
    ),
  }),
);
