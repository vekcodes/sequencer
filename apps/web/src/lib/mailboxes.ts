import { api } from './api'

export type MailboxView = {
  id: number
  email: string
  displayName: string | null
  provider: 'google' | 'microsoft' | 'smtp'
  pool: 'primed' | 'ramping' | 'resting'
  healthStatus: 'connected' | 'disconnected' | 'paused' | 'bouncing'
  healthScore: number
  dailyLimitTarget: number
  dailyLimitCurrent: number
  bounceRate30dBps: number
  spamComplaintRate30dBps: number
  spfOk: boolean | null
  dkimOk: boolean | null
  dmarcOk: boolean | null
  mxOk: boolean | null
  warmupEnabled: boolean
  warmupDailyLimit: number
  smartAdjustEnabled: boolean
  pauseReason: string | null
  restingUntil: string | null
  rampStartedAt: string
  createdAt: string
  updatedAt: string
}

export function updateMailboxWarmup(
  id: number,
  patch: {
    warmupEnabled?: boolean
    warmupDailyLimit?: number
    smartAdjustEnabled?: boolean
    dailyLimitTarget?: number
  },
) {
  return api<{ mailbox: MailboxView }>(`/api/mailboxes/${id}/warmup`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((r) => r.mailbox)
}

export function listMailboxes() {
  return api<{ mailboxes: MailboxView[] }>('/api/mailboxes').then((r) => r.mailboxes)
}

export function getMailbox(id: number) {
  return api<{ mailbox: MailboxView }>(`/api/mailboxes/${id}`).then((r) => r.mailbox)
}

export function pauseMailbox(id: number) {
  return api<{ mailbox: MailboxView }>(`/api/mailboxes/${id}/pause`, {
    method: 'POST',
  }).then((r) => r.mailbox)
}

export function resumeMailbox(id: number) {
  return api<{ mailbox: MailboxView }>(`/api/mailboxes/${id}/resume`, {
    method: 'POST',
  }).then((r) => r.mailbox)
}

export function deleteMailbox(id: number) {
  return api<{ ok: true }>(`/api/mailboxes/${id}`, { method: 'DELETE' })
}

/**
 * Kicks off the Google OAuth flow. Returns a full-page navigation rather
 * than a fetch, because the api endpoint responds with a 302 to Google.
 */
export function startGoogleConnect() {
  window.location.href = '/api/auth/google/start'
}

// ─────────────────────────────────────────────────────────────────────────────
// Health snapshots + recompute (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

export type MailboxHealthSnapshot = {
  date: string
  pool: 'primed' | 'ramping' | 'resting'
  healthScore: number
  bounceRate30dBps: number
  spamRate30dBps: number
  sendsCount: number
  bouncesCount: number
  effectiveDailyLimit: number
}

export type HealthRunResult = {
  mailboxId: number
  email: string
  previousPool: 'primed' | 'ramping' | 'resting'
  newPool: 'primed' | 'ramping' | 'resting'
  previousLimit: number
  newLimit: number
  healthScore: number
  bounceRateBps: number
  spamRateBps: number
  reason: string
}

export function getHealthHistory(id: number, days = 30) {
  return api<{ snapshots: MailboxHealthSnapshot[] }>(
    `/api/mailboxes/${id}/health-history?days=${days}`,
  ).then((r) => r.snapshots)
}

export function recomputeMailboxHealth(id: number) {
  return api<{ result: HealthRunResult; mailbox: MailboxView }>(
    `/api/mailboxes/${id}/recompute-health`,
    { method: 'POST' },
  )
}

export function recomputeAllMailboxHealth() {
  return api<{ results: HealthRunResult[] }>('/api/admin/run-health', {
    method: 'POST',
  })
}
