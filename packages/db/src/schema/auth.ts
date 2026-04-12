import {
  pgTable,
  serial,
  integer,
  text,
  varchar,
  timestamp,
} from 'drizzle-orm/pg-core';

// Workspace = the tenant. All other rows hang off a workspace_id.
export const workspace = pgTable('workspace', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  plan: text('plan').default('free').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// User. id is text to match Lucia v3's expected schema.
// Email is globally unique — one account per email. Multi-workspace membership
// will be handled via a separate workspace_membership table later if needed.
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 320 }).notNull().unique(),
  name: text('name'),
  role: text('role').default('member').notNull(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Lucia v3 session table — see https://lucia-auth.com/database/postgresql
export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
});

// Long-lived API tokens for programmatic access (e.g. CI, scripts).
export const apiToken = pgTable('api_token', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
