CREATE TYPE "public"."mailbox_health_status" AS ENUM('connected', 'disconnected', 'paused', 'bouncing');--> statement-breakpoint
CREATE TYPE "public"."mailbox_pool" AS ENUM('primed', 'ramping', 'resting');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('google', 'microsoft', 'smtp');--> statement-breakpoint
CREATE TYPE "public"."mailbox_resting_reason" AS ENUM('spam', 'bounce', 'health', 'manual');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('active', 'replied', 'unsubscribed', 'bounced', 'blacklisted');--> statement-breakpoint
CREATE TYPE "public"."campaign_lead_status" AS ENUM('queued', 'active', 'completed', 'replied', 'unsubscribed', 'bounced', 'paused');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."campaign_type" AS ENUM('outbound', 'reply_followup');--> statement-breakpoint
CREATE TYPE "public"."reply_behavior" AS ENUM('auto_pause_lead', 'continue');--> statement-breakpoint
CREATE TYPE "public"."sequence_prioritization" AS ENUM('followups', 'new_leads');--> statement-breakpoint
CREATE TYPE "public"."email_event_type" AS ENUM('sent', 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('interested', 'not_interested', 'neutral', 'auto_reply', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."scheduled_email_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'bounced', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tag_target_type" AS ENUM('lead', 'campaign', 'mailbox');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_token" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"provider" "mailbox_provider" NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"signature_html" text,
	"oauth_refresh_token" text,
	"oauth_access_token" text,
	"oauth_expires_at" timestamp with time zone,
	"google_history_id" text,
	"google_watch_expires_at" timestamp with time zone,
	"google_label_id" text,
	"pool" "mailbox_pool" DEFAULT 'ramping' NOT NULL,
	"pool_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resting_until" timestamp with time zone,
	"resting_reason" "mailbox_resting_reason",
	"daily_limit_target" integer DEFAULT 30 NOT NULL,
	"daily_limit_current" integer DEFAULT 5 NOT NULL,
	"ramp_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ramp_completed_at" timestamp with time zone,
	"warmup_enabled" boolean DEFAULT false NOT NULL,
	"warmup_daily_limit" integer DEFAULT 0 NOT NULL,
	"smart_adjust_enabled" boolean DEFAULT true NOT NULL,
	"health_score" integer DEFAULT 100 NOT NULL,
	"placement_score" integer DEFAULT 100 NOT NULL,
	"bounce_rate_30d_bps" integer DEFAULT 0 NOT NULL,
	"spam_complaint_rate_30d_bps" integer DEFAULT 0 NOT NULL,
	"consecutive_bounce_count" integer DEFAULT 0 NOT NULL,
	"spf_ok" boolean,
	"dkim_ok" boolean,
	"dmarc_ok" boolean,
	"mx_ok" boolean,
	"spf_checked_at" timestamp with time zone,
	"dkim_checked_at" timestamp with time zone,
	"dmarc_checked_at" timestamp with time zone,
	"mx_checked_at" timestamp with time zone,
	"health_status" "mailbox_health_status" DEFAULT 'connected' NOT NULL,
	"pause_reason" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_daily_usage" (
	"mailbox_id" integer NOT NULL,
	"date" date NOT NULL,
	"sends_used" integer DEFAULT 0 NOT NULL,
	"warmup_sends_used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mailbox_daily_usage_mailbox_id_date_pk" PRIMARY KEY("mailbox_id","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_health_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"mailbox_id" integer NOT NULL,
	"date" date NOT NULL,
	"pool" "mailbox_pool" NOT NULL,
	"health_score" integer NOT NULL,
	"placement_score" integer NOT NULL,
	"bounce_rate_30d_bps" integer NOT NULL,
	"spam_rate_30d_bps" integer NOT NULL,
	"sends_count" integer DEFAULT 0 NOT NULL,
	"opens_count" integer DEFAULT 0 NOT NULL,
	"replies_count" integer DEFAULT 0 NOT NULL,
	"bounces_count" integer DEFAULT 0 NOT NULL,
	"effective_daily_limit" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blocklist_domain" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"domain" varchar(253) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blocklist_email" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"email" varchar(320) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_variable" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"key" text NOT NULL,
	"fallback_default" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"email" varchar(320) NOT NULL,
	"first_name" text,
	"last_name" text,
	"company" text,
	"title" text,
	"phone" text,
	"custom_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text,
	"status" "lead_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_list" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_list_membership" (
	"lead_id" integer NOT NULL,
	"lead_list_id" integer NOT NULL,
	CONSTRAINT "lead_list_membership_lead_id_lead_list_id_pk" PRIMARY KEY("lead_id","lead_list_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"type" "campaign_type" DEFAULT 'outbound' NOT NULL,
	"max_emails_per_day" integer DEFAULT 1000 NOT NULL,
	"max_new_leads_per_day" integer DEFAULT 50 NOT NULL,
	"plain_text" boolean DEFAULT true NOT NULL,
	"open_tracking" boolean DEFAULT false NOT NULL,
	"click_tracking" boolean DEFAULT false NOT NULL,
	"reputation_building" boolean DEFAULT true NOT NULL,
	"can_unsubscribe" boolean DEFAULT true NOT NULL,
	"unsubscribe_text" text DEFAULT 'Unsubscribe here' NOT NULL,
	"custom_tracking_domain_id" integer,
	"sequence_prioritization" "sequence_prioritization" DEFAULT 'followups' NOT NULL,
	"reply_behavior" "reply_behavior" DEFAULT 'auto_pause_lead' NOT NULL,
	"bounce_behavior" text DEFAULT 'auto_pause_lead' NOT NULL,
	"use_lead_timezone" boolean DEFAULT true NOT NULL,
	"skip_holidays" boolean DEFAULT true NOT NULL,
	"holiday_calendar" text DEFAULT 'US',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_lead" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"lead_id" integer NOT NULL,
	"status" "campaign_lead_status" DEFAULT 'queued' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_send_at" timestamp with time zone,
	"assigned_mailbox_id" integer,
	"thread_id" text,
	"first_message_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_schedule" (
	"campaign_id" integer PRIMARY KEY NOT NULL,
	"monday" boolean DEFAULT true NOT NULL,
	"tuesday" boolean DEFAULT true NOT NULL,
	"wednesday" boolean DEFAULT true NOT NULL,
	"thursday" boolean DEFAULT true NOT NULL,
	"friday" boolean DEFAULT true NOT NULL,
	"saturday" boolean DEFAULT false NOT NULL,
	"sunday" boolean DEFAULT false NOT NULL,
	"start_time" text DEFAULT '09:00' NOT NULL,
	"end_time" text DEFAULT '16:30' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"avoid_hours_local" jsonb DEFAULT '["00:00-06:00","22:00-24:00"]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_sender" (
	"campaign_id" integer NOT NULL,
	"mailbox_id" integer NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "campaign_sender_campaign_id_mailbox_id_pk" PRIMARY KEY("campaign_id","mailbox_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sequence_step" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"step_order" integer NOT NULL,
	"wait_in_business_days" integer DEFAULT 0 NOT NULL,
	"wait_in_days" integer,
	"thread_reply" boolean DEFAULT true NOT NULL,
	"stop_on_reply" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sequence_step_variant" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_step_id" integer NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"campaign_id" integer,
	"campaign_lead_id" integer,
	"mailbox_id" integer,
	"scheduled_email_id" integer,
	"type" "email_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reply" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"campaign_lead_id" integer,
	"mailbox_id" integer NOT NULL,
	"gmail_thread_id" text,
	"gmail_message_id" text,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"from_email" text NOT NULL,
	"from_name" text,
	"to_email" text,
	"classification" "reply_classification" DEFAULT 'unknown' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_email" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"campaign_lead_id" integer NOT NULL,
	"sequence_step_id" integer NOT NULL,
	"sequence_step_variant_id" integer NOT NULL,
	"mailbox_id" integer NOT NULL,
	"subject_rendered" text NOT NULL,
	"body_rendered_text" text NOT NULL,
	"body_rendered_html" text,
	"send_at" timestamp with time zone NOT NULL,
	"status" "scheduled_email_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"gmail_message_id" text,
	"in_reply_to_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ignore_phrase" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"phrase" text NOT NULL,
	"language" varchar(8) DEFAULT 'en' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reply_template" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tag" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"color" varchar(7)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tag_assignment" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag_id" integer NOT NULL,
	"target_type" "tag_target_type" NOT NULL,
	"target_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_token" ADD CONSTRAINT "api_token_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user" ADD CONSTRAINT "user_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_daily_usage" ADD CONSTRAINT "mailbox_daily_usage_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_health_snapshot" ADD CONSTRAINT "mailbox_health_snapshot_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blocklist_domain" ADD CONSTRAINT "blocklist_domain_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blocklist_email" ADD CONSTRAINT "blocklist_email_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_variable" ADD CONSTRAINT "custom_variable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_list" ADD CONSTRAINT "lead_list_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_list_membership" ADD CONSTRAINT "lead_list_membership_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_list_membership" ADD CONSTRAINT "lead_list_membership_lead_list_id_lead_list_id_fk" FOREIGN KEY ("lead_list_id") REFERENCES "public"."lead_list"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_lead" ADD CONSTRAINT "campaign_lead_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_lead" ADD CONSTRAINT "campaign_lead_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_lead" ADD CONSTRAINT "campaign_lead_assigned_mailbox_id_mailbox_id_fk" FOREIGN KEY ("assigned_mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_schedule" ADD CONSTRAINT "campaign_schedule_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_sender" ADD CONSTRAINT "campaign_sender_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_sender" ADD CONSTRAINT "campaign_sender_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sequence_step" ADD CONSTRAINT "sequence_step_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sequence_step_variant" ADD CONSTRAINT "sequence_step_variant_sequence_step_id_sequence_step_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_step"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_campaign_lead_id_campaign_lead_id_fk" FOREIGN KEY ("campaign_lead_id") REFERENCES "public"."campaign_lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply" ADD CONSTRAINT "reply_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply" ADD CONSTRAINT "reply_campaign_lead_id_campaign_lead_id_fk" FOREIGN KEY ("campaign_lead_id") REFERENCES "public"."campaign_lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply" ADD CONSTRAINT "reply_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_email" ADD CONSTRAINT "scheduled_email_campaign_lead_id_campaign_lead_id_fk" FOREIGN KEY ("campaign_lead_id") REFERENCES "public"."campaign_lead"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_email" ADD CONSTRAINT "scheduled_email_sequence_step_id_sequence_step_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_step"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_email" ADD CONSTRAINT "scheduled_email_sequence_step_variant_id_sequence_step_variant_id_fk" FOREIGN KEY ("sequence_step_variant_id") REFERENCES "public"."sequence_step_variant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_email" ADD CONSTRAINT "scheduled_email_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ignore_phrase" ADD CONSTRAINT "ignore_phrase_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_template" ADD CONSTRAINT "reply_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tag" ADD CONSTRAINT "tag_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tag_assignment" ADD CONSTRAINT "tag_assignment_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook" ADD CONSTRAINT "webhook_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_workspace_email_idx" ON "mailbox" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_health_snapshot_mailbox_date_idx" ON "mailbox_health_snapshot" USING btree ("mailbox_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blocklist_domain_workspace_domain_idx" ON "blocklist_domain" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blocklist_email_workspace_email_idx" ON "blocklist_email" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_variable_workspace_key_idx" ON "custom_variable" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_workspace_email_idx" ON "lead" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_lead_campaign_lead_idx" ON "campaign_lead" USING btree ("campaign_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sequence_step_campaign_order_idx" ON "sequence_step" USING btree ("campaign_id","step_order");