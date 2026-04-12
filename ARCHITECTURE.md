# Cold Email Sequencer — Architecture

A robust outbound email sequencer that enforces cold-email best practices by default, with one-click Gmail OAuth connection. Inspired by EmailBison's API surface, Smartlead's portfolio model, and Instantly's deliverability research.

---

## 1. System Overview

```
┌────────────────────────────────────────────────────────────────┐
│  Frontend (Vite + React + TS)                                  │
│  - Mailbox health dashboard                                    │
│  - Campaign + sequence builder                                 │
│  - Master inbox                                                │
└─────────────────────┬──────────────────────────────────────────┘
                      │ REST + SSE
┌─────────────────────▼──────────────────────────────────────────┐
│  API (Hono on Node + TS)                                       │
│  - REST endpoints for all resources                            │
│  - Gmail OAuth callback                                        │
│  - Pub/Sub push receiver (Gmail real-time replies)             │
└─────────┬─────────────────────────────────────────┬────────────┘
          │                                         │
          │  ┌──────────────────────────────────┐   │
          │  │  Workers (BullMQ on Redis)       │   │
          │  │  - scheduler-tick (every 60s)    │   │
          │  │  - sender-worker (queue)         │   │
          │  │  - mailbox-health-worker (daily) │   │
          │  │  - warmup-worker                 │   │
          │  │  - analytics-aggregator          │   │
          │  │  - webhook-delivery-worker       │   │
          │  │  - gmail-watch-renew (every 6d)  │   │
          │  └──────────┬───────────────────────┘   │
          ▼             ▼                           ▼
   ┌────────────────────────────────────────────────────┐
   │  Postgres                       Redis              │
   │  - source of truth              - queues, cache    │
   └────────────────────────────────────────────────────┘
                      │
                      ▼
   ┌────────────────────────────────────────────────────┐
   │  External                                          │
   │  - Gmail API (send + watch + history.list)         │
   │  - Google Pub/Sub (Gmail push notifications)       │
   │  - LLM API (reply classification)                  │
   └────────────────────────────────────────────────────┘
```

---

## 2. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Vite + React + TypeScript | Already scaffolded |
| FE styling | Tailwind + shadcn/ui | Fast, consistent |
| FE state | TanStack Query (server) + Zustand (UI) | Standard for this kind of app |
| Backend | Hono on Node + TypeScript | Fast, ESM-first, runs everywhere |
| ORM | Drizzle | Typed SQL, no runtime magic |
| DB | PostgreSQL 15+ | Relational shape fits the model |
| Cache + Queue | Redis + BullMQ | Delayed jobs, retries, repeatable cron |
| Auth | Lucia (default) or Clerk if hosted preferred | Both swap-in compatible |
| Mail provider | googleapis (Gmail API) | Native — no IMAP/SMTP |
| Token encryption | libsodium sealed boxes, KMS-managed key | Refresh tokens are sensitive |
| LLM | Anthropic Claude (Haiku for classification) | Cheap, fast |
| Hosting | Fly.io (api + workers) + Neon (Postgres) + Upstash (Redis) | Cheap, fast, good defaults |

---

## 3. Repo Structure (monorepo)

```
cold-email-sequencer/
├── apps/
│   ├── web/                    ← the Vite app (current scaffold)
│   │   └── src/
│   └── api/                    ← Hono backend
│       ├── src/
│       │   ├── routes/         ← REST handlers
│       │   ├── workers/        ← BullMQ consumers
│       │   ├── services/       ← business logic
│       │   ├── mail/           ← provider drivers
│       │   │   ├── driver.ts   ← MailboxDriver interface
│       │   │   ├── gmail.ts    ← Google implementation
│       │   │   └── outlook.ts  ← future
│       │   └── lib/
│       └── package.json
├── packages/
│   ├── db/                     ← Drizzle schema + migrations + queries
│   ├── shared/                 ← Zod schemas, types shared FE↔BE
│   └── config/                 ← env loader, defaults
├── ARCHITECTURE.md             ← this file
├── package.json                ← root, with workspaces
└── pnpm-workspace.yaml
```

---

## 4. Data Model

### Auth & tenant

```
workspace
  id, name, slug, plan, created_at, updated_at

user
  id, workspace_id, email, name, role, password_hash, created_at

api_token
  id, workspace_id, name, token_hash, last_used_at, created_at
```

### Mailboxes (Gmail OAuth lives here)

```
mailbox
  id, workspace_id
  provider              -- 'google' | 'microsoft' | 'smtp'
  email                 -- unique per workspace
  display_name, signature_html
  oauth_refresh_token   -- encrypted (libsodium)
  oauth_access_token    -- encrypted, short-lived
  oauth_expires_at
  google_history_id     -- for Gmail incremental sync
  google_watch_expires_at
  google_label_id       -- our "[CES]" label id

  pool                  -- 'primed' | 'ramping' | 'resting'
  pool_changed_at
  resting_until         -- nullable
  resting_reason        -- nullable: 'spam' | 'bounce' | 'health' | 'manual'

  daily_limit_target    -- e.g. 30
  daily_limit_current   -- starts at 5, ramps up
  ramp_started_at
  ramp_completed_at

  warmup_enabled, warmup_daily_limit
  smart_adjust_enabled

  health_score          -- 0-100, computed nightly
  placement_score       -- from inbox-placement tests
  bounce_rate_30d       -- rolling
  spam_complaint_rate_30d
  consecutive_bounce_count

  spf_ok, dkim_ok, dmarc_ok, mx_ok
  spf_checked_at, dkim_checked_at, dmarc_checked_at, mx_checked_at

  health                -- 'connected' | 'disconnected' | 'paused' | 'bouncing'
  pause_reason
  last_used_at
  created_at, updated_at

mailbox_daily_usage     -- prevents over-cap sends; reset at mailbox local midnight
  mailbox_id, date (local), sends_used, warmup_sends_used
  PRIMARY KEY (mailbox_id, date)

mailbox_health_snapshot -- append-only daily, for trend charts
  mailbox_id, date,
  pool, health_score, placement_score,
  bounce_rate_30d, spam_complaint_rate_30d,
  sends, opens, replies, bounces,
  effective_daily_limit
```

### Leads

```
lead
  id, workspace_id
  email                 -- unique per workspace
  first_name, last_name, company, title, phone
  custom_variables      -- jsonb
  timezone              -- IANA, optional
  status                -- 'active' | 'replied' | 'unsubscribed' | 'bounced' | 'blacklisted'
  created_at, updated_at

lead_list
  id, workspace_id, name, created_at

lead_list_membership
  lead_id, lead_list_id
  PRIMARY KEY (lead_id, lead_list_id)

custom_variable         -- workspace-defined fields, e.g. {{pain_point}}
  id, workspace_id, key, fallback_default

blocklist_email
  id, workspace_id, email, reason, created_at

blocklist_domain
  id, workspace_id, domain, reason, created_at
```

### Campaigns + sequences

```
campaign
  id, workspace_id, name
  status                -- 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  type                  -- 'outbound' | 'reply_followup'

  -- limits
  max_emails_per_day
  max_new_leads_per_day

  -- deliverability
  plain_text                       -- default true
  open_tracking                    -- default false
  click_tracking                   -- default false
  reputation_building              -- default true (= safe mode)
  can_unsubscribe                  -- default true
  unsubscribe_text                 -- 'Unsubscribe here'
  custom_tracking_domain_id        -- nullable

  -- behavior
  sequence_prioritization          -- 'followups' | 'new_leads'  default 'followups'
  reply_behavior                   -- 'auto_pause_lead' (default) | 'continue'
  bounce_behavior                  -- 'auto_pause_lead'
  use_lead_timezone                -- default true
  skip_holidays                    -- default true
  holiday_calendar                 -- 'US' | 'UK' | 'EU' | 'IN' | null

  created_at, updated_at, started_at, completed_at

campaign_schedule        -- 1:1
  campaign_id (PK)
  monday, tuesday, wednesday, thursday, friday, saturday, sunday  -- bools
  start_time              -- 'HH:MM'
  end_time                -- 'HH:MM'
  timezone                -- IANA, fallback when use_lead_timezone=false
  avoid_hours_local       -- jsonb array, e.g. ['00:00-06:00','22:00-24:00']

sequence_step
  id, campaign_id, order
  wait_in_business_days   -- default field; converted from wait_in_days
  wait_in_days            -- alternative
  thread_reply            -- bool, default true on step >= 2
  stop_on_reply           -- default true

sequence_step_variant    -- A/B variants
  id, sequence_step_id
  weight                  -- e.g. 50, 50
  subject                 -- spintax + {{vars}} allowed
  body                    -- plain text default
  attachments             -- nullable jsonb

campaign_sender          -- M:N campaign ↔ mailbox
  campaign_id, mailbox_id, weight, active
  PRIMARY KEY (campaign_id, mailbox_id)

campaign_lead            -- the enrollment, where scheduling state lives
  id, campaign_id, lead_id
  status                  -- 'queued' | 'active' | 'completed' | 'replied' | 'unsubscribed' | 'bounced' | 'paused'
  current_step
  next_send_at
  assigned_mailbox_id     -- sticky after first send
  thread_id               -- Gmail threadId
  first_message_id        -- for In-Reply-To/References
  added_at, completed_at
  UNIQUE (campaign_id, lead_id)
```

### Send queue + events

```
scheduled_email
  id, campaign_lead_id, sequence_step_id, sequence_step_variant_id
  mailbox_id
  subject_rendered, body_rendered_text, body_rendered_html
  send_at                  -- jittered timestamp; the queue scheduler reads this
  status                   -- 'queued' | 'sending' | 'sent' | 'failed' | 'bounced' | 'cancelled'
  attempt_count, last_error
  gmail_message_id         -- set on success
  in_reply_to_message_id   -- set when thread_reply=true
  created_at, sent_at

email_event              -- append-only
  id, type                 -- 'sent' | 'opened' | 'clicked' | 'replied' | 'bounced' | 'unsubscribed' | 'failed'
  workspace_id, campaign_id, campaign_lead_id, mailbox_id, scheduled_email_id
  payload                  -- jsonb
  occurred_at

reply                    -- master inbox row
  id, workspace_id
  campaign_lead_id         -- nullable for untracked
  mailbox_id
  gmail_thread_id, gmail_message_id
  subject, body_text, body_html
  from_email, from_name, to_email
  classification           -- 'interested' | 'not_interested' | 'neutral' | 'auto_reply' | 'unknown'
  read, starred, archived
  received_at
```

### Tags, webhooks, ignore phrases, templates

```
tag
  id, workspace_id, name, color

tag_assignment
  tag_id, target_type ('lead'|'campaign'|'mailbox'), target_id

webhook
  id, workspace_id, url, secret, event_types (array), active

ignore_phrase            -- auto-reply detector strings
  id, workspace_id, phrase, language

reply_template
  id, workspace_id, name, subject, body
```

---

## 5. System Components / Services

### Workers (BullMQ on Redis)

| Worker | Schedule | Responsibility |
|---|---|---|
| `scheduler-tick` | Every 60s | Find due `campaign_lead`s, enqueue `scheduled_email` rows with jittered `send_at` |
| `sender-worker` | Queue consumer | Send via Gmail API, handle retries, log events, schedule next step |
| `mailbox-health-worker` | Daily per mailbox at local 00:30 | Recompute health, transition pools, advance ramp |
| `warmup-worker` | Per-mailbox cron | Inbox-to-inbox warmup sends within capacity |
| `gmail-watch-renew` | Every 6 days per mailbox | Re-call `gmail.users.watch()` (watches expire after 7) |
| `analytics-aggregator` | Every 5 min | Roll up `email_event` into per-campaign stats |
| `webhook-delivery-worker` | Queue consumer | Deliver outbound webhook events with retries + HMAC |

### HTTP receivers (in API)

| Endpoint | Purpose |
|---|---|
| `POST /pubsub/gmail` | Google Pub/Sub push for new mail in any watched mailbox |
| `GET /auth/google/start` | Initiate OAuth |
| `GET /auth/google/callback` | OAuth callback → store tokens → redirect |

---

## 6. Gmail OAuth Flow (the differentiator)

### Scopes (minimal)

```
https://www.googleapis.com/auth/gmail.send       -- send messages
https://www.googleapis.com/auth/gmail.modify     -- read inbound + apply labels
https://www.googleapis.com/auth/gmail.labels     -- create our "CES" label
https://www.googleapis.com/auth/userinfo.email   -- grab email address
openid
```

We do NOT request `gmail.readonly` for full mailbox access. Consent screen explicitly says: "We can only see emails related to your campaigns."

### Connection sequence

```
1. User clicks "Connect Gmail" in /mailboxes/new
2. Frontend hits GET /api/auth/google/start
3. Backend signs a state JWT (workspace_id + csrf nonce) and redirects to:
     https://accounts.google.com/o/oauth2/v2/auth
       ?client_id=<CES app>
       &redirect_uri=https://app.../auth/google/callback
       &response_type=code
       &access_type=offline           ← required for refresh_token
       &prompt=consent                ← forces refresh_token on re-consent
       &scope=<scopes joined by space>
       &state=<signed jwt>

4. User consents on Google's screen
5. Google redirects back: /auth/google/callback?code=...&state=...
6. Backend:
     - verifies state
     - POSTs code to https://oauth2.googleapis.com/token
     - receives { access_token, refresh_token, expires_in }
     - calls gmail.users.getProfile to fetch emailAddress + historyId
     - encrypts both tokens with libsodium sealed box (KMS-managed key)
     - inserts mailbox row:
         pool='ramping', daily_limit_current=5, daily_limit_target=30
         google_history_id=<from getProfile>
     - kicks off background:
         - DNS SPF/DKIM/DMARC/MX checks
         - gmail.users.watch() with our Pub/Sub topic
         - Optional: create '[CES]' label
     - redirects to /mailboxes/<id>?welcome=1

7. From this point on, sender-worker uses get_access_token(mailbox_id):
     if access_token expired: refresh via refresh_token, update DB
     return access_token
```

### Send call

```
gmail.users.messages.send({
  userId: 'me',
  requestBody: {
    threadId: <thread_id if thread_reply else undefined>,
    raw: base64url(rfc822_message_with(
      headers={
        From: '<display_name> <email>',
        To: lead.email,
        Subject: rendered_subject,
        'In-Reply-To': first_message_id (if thread_reply),
        'References': first_message_id (if thread_reply),
        'List-Unsubscribe': '<https://app.../unsub/<token>>, <mailto:unsub+<token>@app...>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      },
      body=rendered_body_plaintext
    ))
  }
})
```

The `List-Unsubscribe` + `List-Unsubscribe-Post` headers satisfy Google's bulk-sender rules (RFC 8058 one-click).

---

## 7. Mailbox Router (Portfolio Algorithm)

```ts
// Called once per lead, at enrollment time
function pickMailbox(campaign, lead): Mailbox | null {
  // 1. Sticky: reuse if assigned and not resting
  if (lead.assigned_mailbox_id && pool(lead.assigned_mailbox_id) !== 'resting') {
    return load(lead.assigned_mailbox_id);
  }

  // 2. Filter to viable senders
  const candidates = campaign.senders.filter(s =>
       s.active
    && s.mailbox.pool !== 'resting'
    && s.mailbox.health === 'connected'
    && usageToday(s.mailbox) < effectiveDailyLimit(s.mailbox)
    && domainRateLimitOk(workspace, lead.emailDomain)
  );
  if (candidates.length === 0) return null;  // defer to tomorrow

  // 3. Prefer Primed pool over Ramping (don't burn new mailboxes)
  const primed  = candidates.filter(c => c.mailbox.pool === 'primed');
  const pool    = primed.length > 0 ? primed : candidates;

  // 4. Weighted random by remaining capacity × health
  const score = (m: Mailbox) =>
       (effectiveDailyLimit(m) - usageToday(m))
     * (m.health_score / 100)
     * m.weight;

  const pick = weightedRandom(pool, score);

  // 5. Persist sticky assignment
  lead.assigned_mailbox_id = pick.mailbox.id;
  return pick.mailbox;
}

function effectiveDailyLimit(mailbox): number {
  let cap = mailbox.daily_limit_current;
  if (hadBounceSpikeYesterday(mailbox)) cap = Math.floor(cap * 0.5);  // Instantly's dynamic brake
  return cap;
}

function domainRateLimitOk(workspace, domain): boolean {
  // Max 5 emails/hour to a single recipient domain across the entire workspace
  return sendsLastHourTo(workspace, domain) < 5;
}
```

### Why sticky + portfolio?

- **Sticky** = thread continuity. If a lead replies, the reply lands in the same mailbox, in the same Gmail thread. Following up from a different mailbox would break the thread and look spammy.
- **Portfolio** = right-sized risk. Hot leads get sent from your most-trusted (Primed) inboxes. New mailboxes (Ramping) only get assigned when no Primed has capacity. Resting mailboxes never get traffic.

---

## 8. Sequence Engine & Scheduler

### `scheduler-tick` (every 60s)

```
For each active campaign:
  if not in_sending_window(campaign): continue
  if today_count(campaign) >= campaign.max_emails_per_day: continue

  // 1. Find leads whose next step is due
  due = SELECT * FROM campaign_lead
        WHERE campaign_id = X
          AND status = 'active'
          AND next_send_at <= now()
        ORDER BY (
          CASE campaign.sequence_prioritization
            WHEN 'followups' THEN current_step DESC
            ELSE current_step ASC
          END
        )
        LIMIT (campaign.max_emails_per_day - today_count(campaign))

  // 2. Cap new-lead enrollments
  new_leads_today = count(due where current_step == 1)
  if new_leads_today > campaign.max_new_leads_per_day:
    drop excess down to cap

  // 3. For each, assign mailbox + render + schedule
  for enrollment in due:
    mailbox = pickMailbox(campaign, enrollment.lead)
    if mailbox is None: continue   // defer

    step    = current_sequence_step(enrollment)
    variant = pick_variant_by_weight(step.variants)

    rendered_subject = render(variant.subject, lead, spintax_seed=enrollment.id)
    rendered_body    = render(variant.body, lead, spintax_seed=enrollment.id)

    if has_unresolved_var(rendered_subject) or has_unresolved_var(rendered_body):
      mark_for_attention(enrollment)
      continue

    send_at = compute_jittered_send_at(campaign, mailbox, enrollment)

    INSERT scheduled_email (
      campaign_lead_id, sequence_step_id, sequence_step_variant_id,
      mailbox_id, subject_rendered, body_rendered_text,
      send_at='<jittered>',
      status='queued',
      in_reply_to_message_id=(enrollment.first_message_id if step.thread_reply else null)
    )
    INSERT into BullMQ delayed queue with delay = send_at - now()
```

### Jitter calculation

```
function compute_jittered_send_at(campaign, mailbox, enrollment):
  tz = (campaign.use_lead_timezone && lead.timezone) || campaign.timezone
  window = today's_window_in(tz)

  // First-message anti-bot jitter
  if enrollment.current_step == 1:
    return window.start + random_uniform(0, 30) minutes

  // Otherwise spread across remaining window
  remaining_capacity = effective_daily_limit(mailbox) - usage_today(mailbox)
  remaining_window_min = (window.end - now()).minutes
  mean_gap_min = remaining_window_min / max(1, remaining_capacity)
  jitter = random_uniform(0.7, 1.3) * mean_gap_min

  candidate = now() + jitter minutes
  // Hard floor: never less than 60s after last send from same mailbox
  candidate = max(candidate, last_send(mailbox) + 60s)
  // Snap into avoid_hours_local
  candidate = skip_avoid_hours(candidate, campaign.avoid_hours_local)
  return candidate
```

### `sender-worker` (BullMQ consumer)

```
Acquire row lock (SELECT FOR UPDATE SKIP LOCKED)

Pre-send re-check:
  - mailbox still healthy + not resting?
  - lead not unsubscribed/blacklisted/replied?
  - mailbox usage_today < cap?
If any fail → cancel or defer

Send via Gmail API:
  msg = build_rfc822(...)
  result = gmail.users.messages.send(threadId?, raw=msg)

On success:
  scheduled_email.status = 'sent'
  scheduled_email.gmail_message_id = result.id
  mailbox_daily_usage++ (atomic)
  email_event(type='sent') inserted

  if first step:
    campaign_lead.thread_id = result.threadId
    campaign_lead.first_message_id = extract Message-ID header
    campaign_lead.assigned_mailbox_id = mailbox.id  (cement stickiness)

  // schedule next step
  next_step = sequence_step where order = current_step+1
  if next_step exists:
    campaign_lead.current_step += 1
    campaign_lead.next_send_at = add_business_days(
      now(), next_step.wait_in_business_days
    ) at sending_window_start
  else:
    campaign_lead.status = 'completed'

On hard bounce (5xx, gmail bounce class):
  lead.status = 'bounced', add to blocklist
  email_event(type='bounced')
  mailbox.consecutive_bounce_count++
  if bounce_rate(mailbox, last 50) > 0.05:
    mailbox.pool = 'resting', resting_until = now()+48h
    fire pool_change webhook

On soft bounce / 4xx:
  retry with exponential backoff (3 attempts)

On invalid_grant (refresh failed):
  mailbox.health = 'disconnected'
  fire email_account_disconnected webhook
```

---

## 9. Mailbox Health Worker (the dashboard brain)

Runs nightly per mailbox at the mailbox's local 00:30.

```
For mailbox M:
  bounces_30d = count(email_event where mailbox=M, type='bounced', last 30d)
  sends_30d   = count(email_event where mailbox=M, type='sent', last 30d)
  spam_30d    = count(complaints last 30d)  // from Gmail postmaster API or feedback loop

  bounce_rate_30d = bounces_30d / max(1, sends_30d)
  spam_rate_30d   = spam_30d  / max(1, sends_30d)
  placement       = latest_placement_test(M) ?? 100

  health_score = 0.5 * placement
               + 0.3 * (100 - bounce_rate_30d * 100)
               + 0.2 * (100 - spam_rate_30d * 100)

  // Pool transitions (in priority order — first match wins)
  if spam_rate_30d >= 0.003:
    pool = 'resting', resting_reason = 'spam', resting_until = null  // manual unblock
  elif bounce_rate_30d >= 0.02:
    pool = 'resting', resting_reason = 'bounce', resting_until = now() + 48h
  elif health_score < 85:
    pool = 'resting', resting_reason = 'health', resting_until = now() + 7d
  elif pool == 'ramping' and days_since(ramp_started_at) >= 28 and health_score >= 90:
    pool = 'primed'
  elif pool == 'resting' and now() > resting_until and health_score >= 90:
    pool = 'ramping'

  // Ramp progression — only if no triggers fired
  if pool == 'ramping' and no_triggers_today and daily_limit_current < daily_limit_target:
    daily_limit_current = next_step_in_curve(week_index)
    // Curve: week1: 5-10, week2: 15-20, week3: 20-30, week4+: 30

  // Snapshot for charts
  INSERT mailbox_health_snapshot (...)
```

---

## 10. Reply Handling (Master Inbox)

### Gmail Push (Pub/Sub) flow

```
1. On mailbox connect, we call gmail.users.watch({
     topicName: 'projects/<gcp>/topics/ces-gmail-push',
     labelIds: ['INBOX'],
     labelFilterAction: 'include'
   })
   Save watch_expires_at (now + 7d).

2. When new mail hits any watched mailbox, Google publishes to Pub/Sub.
3. Pub/Sub pushes a POST to /pubsub/gmail with { emailAddress, historyId }.
4. Handler:
   mailbox = find by emailAddress
   verify Pub/Sub JWT signature
   call gmail.users.history.list({ startHistoryId: mailbox.google_history_id })
   for each history record:
     for each new message id:
       msg = gmail.users.messages.get(id)
       process_inbound_message(mailbox, msg)
   mailbox.google_history_id = response.historyId

5. process_inbound_message:
   - extract headers: From, Subject, Message-ID, In-Reply-To, References, threadId
   - lookup campaign_lead by:
     a) gmail_thread_id matching (preferred)
     b) From email matching a known lead in any active campaign
     c) otherwise: untracked reply
   - check ignore_phrases: if matches → classification='auto_reply'
   - else: call LLM classify(subject, body) → 'interested'|'not_interested'|'neutral'
   - INSERT reply
   - INSERT email_event(type='replied')
   - if classification != 'auto_reply' AND campaign.reply_behavior='auto_pause_lead':
       campaign_lead.status = 'replied'
       UPDATE scheduled_email SET status='cancelled'
         WHERE campaign_lead_id = X AND status='queued'
   - fire webhook lead_replied (and lead_interested if applicable)
```

### Bounce handling

Bounces arrive as inbound mail from `mailer-daemon`. Same path as replies, but classifier detects DSN format and routes to `bounce_handler` instead.

### Watch renewal

`gmail-watch-renew` cron runs every 6 days, re-calls `users.watch()` for each connected mailbox. Without this, watches expire after 7 days and we stop receiving replies.

---

## 11. Deliverability Defaults (the rule table)

The system enforces these by default. The user can override per campaign/mailbox, but a "Deliverability Score" badge in the UI drops as they turn off safeguards.

| # | Rule | Default | Source |
|---|---|---|---|
| 1 | Daily cap per inbox | **30** | Instantly |
| 2 | Ramp curve (sends/day by week) | **5-10 → 15-20 → 20-30 → 30** | Instantly |
| 3 | First-send jitter on enrollment | uniform(0, 30) min | Anti-bulk-pattern |
| 4 | Inter-send jitter (same mailbox) | mean = window/cap, ±30%, floor 60s | Standard |
| 5 | Bounce circuit breaker | bounce ≥2% → 50% next-day cut + 48h rest | Instantly |
| 6 | Spam complaint hard ceiling | ≥0.3% → immediate Resting (manual unblock) | Gmail postmaster |
| 7 | Health score minimum | <85 → 7-day Resting | Instantly formula |
| 8 | Default sequence | 5–6 steps at days 0, 3, 7, 14, 21, 30 (business) | Instantly cadence |
| 9 | Lead-timezone matching | **on by default** | Instantly: "basic requirement" |
| 10 | Avoid hours | 22:00–06:00 local | Anti-3am-bulk |
| 11 | Sending window | Mon–Fri 09:00–16:30 | Default; user-configurable |
| 12 | `plain_text` | true | Cold email best practice |
| 13 | `open_tracking` | false | Pixels hurt deliverability |
| 14 | `click_tracking` | false | Link rewriting = spam signal |
| 15 | `can_unsubscribe` | true (with one-click List-Unsubscribe header) | Google bulk-sender rules (Feb 2024) |
| 16 | `reply_behavior` | `auto_pause_lead` | Mandatory |
| 17 | Domain rate limit | max 5/hour/workspace/recipient-domain | Anti-mass-attack |
| 18 | SPF/DKIM/DMARC checks | on connect + daily | Standard |
| 19 | DMARC progression | `p=none` → `quarantine` → `reject` after 30 clean days | Standard |
| 20 | Workspace per-recipient cap | enforced (Gmail: 2,000/day external) | Google docs |
| 21 | `ignore_phrases` | pre-seeded ("out of office", "automatic reply", ...) | Auto-reply detection |
| 22 | Spintax in subject + body | supported, applied at send time | EmailBison |
| 23 | Custom variable fallbacks | `{{first_name|there}}` syntax, blocked send if unresolved | Standard |
| 24 | Thread-reply follow-ups | true on step ≥2 by default | EmailBison + Gmail threads |
| 25 | Skip holidays | true (US default, configurable) | Standard |

---

## 12. REST API Surface (key endpoints)

```
Auth
  POST /api/auth/login
  POST /api/auth/logout
  GET  /api/auth/me

Workspaces
  GET    /api/workspaces
  POST   /api/workspaces
  PATCH  /api/workspaces/:id
  GET    /api/workspaces/:id/stats

Mailboxes
  GET    /api/mailboxes
  GET    /api/mailboxes/:id
  PATCH  /api/mailboxes/:id              (display_name, signature, daily_limit_target)
  DELETE /api/mailboxes/:id
  POST   /api/mailboxes/:id/pause
  POST   /api/mailboxes/:id/resume
  POST   /api/mailboxes/:id/check-dns
  GET    /api/mailboxes/:id/health-history?days=30

OAuth
  GET    /api/auth/google/start          → 302 to Google
  GET    /api/auth/google/callback       → exchanges code, creates mailbox
  POST   /pubsub/gmail                   ← Google Pub/Sub push receiver

Leads
  GET    /api/leads
  POST   /api/leads
  POST   /api/leads/bulk                 (max 500)
  POST   /api/leads/csv                  (multipart upload)
  GET    /api/leads/:id
  PATCH  /api/leads/:id
  DELETE /api/leads/:id
  PATCH  /api/leads/:id/unsubscribe

Lead Lists
  GET    /api/lead-lists
  POST   /api/lead-lists
  POST   /api/lead-lists/:id/leads       (attach)

Campaigns
  GET    /api/campaigns
  POST   /api/campaigns                  (name + type only)
  GET    /api/campaigns/:id
  PATCH  /api/campaigns/:id              (settings)
  POST   /api/campaigns/:id/pause
  POST   /api/campaigns/:id/resume
  POST   /api/campaigns/:id/archive
  POST   /api/campaigns/:id/duplicate

  GET    /api/campaigns/:id/sequence
  PUT    /api/campaigns/:id/sequence     (full sequence replace)

  GET    /api/campaigns/:id/schedule
  PUT    /api/campaigns/:id/schedule

  GET    /api/campaigns/:id/senders
  POST   /api/campaigns/:id/senders      (attach mailbox_ids)
  DELETE /api/campaigns/:id/senders/:mailboxId

  POST   /api/campaigns/:id/leads        (import lead_ids or list_id)
  GET    /api/campaigns/:id/leads
  DELETE /api/campaigns/:id/leads        (remove by ids)

  GET    /api/campaigns/:id/stats
  GET    /api/campaigns/:id/stats/by-date?from=&to=

Replies (Master Inbox)
  GET    /api/replies?filter=...
  GET    /api/replies/:id
  GET    /api/replies/:id/thread
  POST   /api/replies/:id/reply
  POST   /api/replies/:id/forward
  PATCH  /api/replies/:id/mark-interested
  PATCH  /api/replies/:id/mark-not-interested
  PATCH  /api/replies/:id/mark-read

Custom Variables / Tags / Blocklists / Webhooks
  Standard CRUD
```

---

## 13. Frontend Pages

| Route | Purpose |
|---|---|
| `/login` | Auth |
| `/dashboard` | Workspace overview: total sends today, replies, mailbox pool summary |
| `/mailboxes` | List of all connected mailboxes, grouped by pool (Primed / Ramping / Resting) |
| `/mailboxes/new` | Connect Gmail (OAuth) — the killer demo |
| `/mailboxes/:id` | Detail: health score, ramp progress, DNS checks, daily usage, history sparkline |
| `/leads` | Lead table with filters, custom variable columns |
| `/leads/import` | CSV import with column mapping |
| `/lead-lists` | Manage named lists |
| `/campaigns` | List campaigns with status, stats, pause/resume |
| `/campaigns/new` | Create wizard: name → schedule → senders → sequence → leads → launch |
| `/campaigns/:id` | Tabs: Overview, Sequence, Schedule, Senders, Leads, Analytics |
| `/campaigns/:id/sequence` | Drag-drop step builder, A/B variants, spintax preview, custom-var picker |
| `/inbox` | Master inbox: filter by mailbox/campaign/classification, reply composer |
| `/blocklists` | Email + domain blocklists |
| `/settings/workspace` | Workspace name, members, API tokens |
| `/settings/webhooks` | Webhook config + event-type picker + sample payloads |
| `/settings/custom-variables` | CRUD + fallback defaults |

The **mailbox health page** is the differentiator screen. It's where users running 10+ inboxes spend their time and what justifies pricing.

---

## 14. Configuration & Defaults

```ts
// packages/config/defaults.ts
export const DEFAULTS = {
  mailbox: {
    daily_limit_target: 30,
    daily_limit_initial: 5,
    rampCurve: [
      // [day, sends/day]
      [1, 5], [2, 6], [3, 8], [4, 10],
      [5, 12], [6, 15], [7, 18],
      [8, 20], [9, 22], [10, 25], [11, 27], [12, 30],
    ],
  },
  campaign: {
    max_emails_per_day: 1000,    // workspace-aware cap, lifted later
    max_new_leads_per_day: 50,
    plain_text: true,
    open_tracking: false,
    click_tracking: false,
    can_unsubscribe: true,
    reputation_building: true,
    sequence_prioritization: 'followups' as const,
    use_lead_timezone: true,
    skip_holidays: true,
    reply_behavior: 'auto_pause_lead' as const,
  },
  schedule: {
    days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    start_time: '09:00',
    end_time:   '16:30',
    avoid_hours_local: ['00:00-06:00', '22:00-24:00'],
  },
  sequenceTemplate: [
    { order: 1, wait_in_business_days: 0,  thread_reply: false },
    { order: 2, wait_in_business_days: 3,  thread_reply: true },
    { order: 3, wait_in_business_days: 4,  thread_reply: true },
    { order: 4, wait_in_business_days: 7,  thread_reply: true },
    { order: 5, wait_in_business_days: 7,  thread_reply: true },
    { order: 6, wait_in_business_days: 9,  thread_reply: true },
  ],
  health: {
    spamComplaintHardCeiling: 0.003,
    bounceRateCircuitBreaker: 0.02,
    healthScoreMin: 85,
    bounceCircuitDurationHours: 48,
    healthRestDurationDays: 7,
    rampToPromotedDays: 28,
    promotionMinHealth: 90,
  },
  rateLimit: {
    perDomainPerHour: 5,
    minInterSendSeconds: 60,
    firstSendJitterMaxMinutes: 30,
  },
  gmail: {
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid',
    ],
    workspaceDailyExternalCap: 2000,  // Google's hard ceiling
    watchRenewIntervalDays: 6,        // before 7d expiry
  },
};
```

---

## 15. Build Phases

### Phase 0 — Foundation (1 PR)
- Restructure to monorepo: `apps/web` (existing Vite), `apps/api`, `packages/db`, `packages/shared`, `packages/config`
- Drizzle schema for all tables in §4
- Migrations runnable
- Local Postgres + Redis via docker-compose
- Hono API skeleton with one health endpoint

### Phase 1 — Auth + workspace
- Lucia (or Clerk) auth
- Workspace creation flow
- User session in frontend, API protected

### Phase 2 — Gmail OAuth ⭐ (the killer demo)
- Google Cloud Console setup docs
- `/auth/google/start` + `/auth/google/callback`
- Token encryption + storage
- Mailbox row creation with `pool='ramping'`, `daily_limit_current=5`
- Profile fetch + initial DNS checks
- "Connect Gmail" button on `/mailboxes/new`
- Mailbox detail page showing connection status

### Phase 3 — Mailbox health surface
- `mailbox-health-worker` (nightly per mailbox)
- Health score computation
- Pool transitions (no real sends yet, but the logic runs)
- `/mailboxes` page with Primed/Ramping/Resting columns
- `/mailboxes/:id` detail with sparkline + ramp progress

### Phase 4 — Leads
- Lead CRUD
- CSV import with column mapping
- Lead lists
- Blocklists

### Phase 5 — Campaign + sequence builder
- Campaign CRUD
- Sequence step builder UI (drag-drop, A/B variants, spintax preview)
- Schedule UI
- Sender attachment with weight sliders
- Lead enrollment

### Phase 6 — Send engine ⭐ (the second killer milestone)
- `scheduler-tick` worker
- `sender-worker` consumer
- `mailbox-router` portfolio algorithm
- Jitter + window enforcement
- Gmail send via `googleapis`
- Thread-reply follow-ups
- Event logging

### Phase 7 — Reply ingestion
- `gmail.users.watch()` on mailbox connect
- Pub/Sub topic + subscription setup
- `/pubsub/gmail` push receiver
- `gmail-watch-renew` cron
- Reply classification (LLM + ignore_phrases)
- Auto-pause on reply
- Master inbox UI

### Phase 8 — Warmup
- Warmup pool participation
- `warmup-worker`
- Warmup-counted-against-daily-cap accounting
- Smart-Adjust feedback loop

### Phase 9 — Analytics + webhooks
- `analytics-aggregator`
- Campaign stats endpoints + dashboard charts
- Webhook config + delivery worker (HMAC, retries)
- Webhook event types match the EmailBison set

### Phase 10 — Polish
- Outlook driver (same MailboxDriver interface)
- Custom tracking domain support (when click tracking on)
- Inbox placement testing integration
- Multi-workspace switcher
- Team members + permissions

---

## Appendix A — Why these choices

- **Gmail API over IMAP/SMTP:** Real-time replies via Pub/Sub (vs polling), thread continuity via `threadId`, no app password setup, recoverable from disconnects via OAuth refresh.
- **Portfolio rotation over round-robin:** Round-robin treats every mailbox as equal. Real sender reputation isn't equal — new mailboxes are fragile, mature mailboxes can carry more load. The pool model matches how deliverability actually works.
- **Lead-timezone default:** Sending at the recipient's 10am, not the sender's, is the single biggest deliverability win after authentication. It's what separates "tool that sends email" from "tool that gets emails read."
- **30/day default cap:** The industry has converged here. 50 was the old number (2022). 30 is the 2025–2026 number for Gmail.
- **Sticky mailbox per lead:** Without this, follow-ups break Gmail threads → recipient sees disjointed messages → spam-flag risk skyrockets.
- **Open + click tracking off by default:** This is the hardest sell to users (they want metrics) but it's what separates 80% inbox placement from 30%. We surface it as a "deliverability score" tradeoff so the user understands what they're giving up if they enable it.
