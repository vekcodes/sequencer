import { api } from './api'
import type { LeadView } from './leads'
import type { MailboxView } from './mailboxes'

// ─── Types ───────────────────────────────────────────────────────────────────

export type CampaignStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'completed'
  | 'archived'

export type CampaignType = 'outbound' | 'reply_followup'

export type CampaignView = {
  id: number
  name: string
  status: CampaignStatus
  type: CampaignType
  maxEmailsPerDay: number
  maxNewLeadsPerDay: number
  plainText: boolean
  openTracking: boolean
  clickTracking: boolean
  reputationBuilding: boolean
  canUnsubscribe: boolean
  unsubscribeText: string
  sequencePrioritization: 'followups' | 'new_leads'
  replyBehavior: string
  useLeadTimezone: boolean
  skipHolidays: boolean
  holidayCalendar: string | null
  leadCount: number
  senderCount: number
  stepCount: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export type SequenceStepVariant = {
  id?: number
  weight: number
  subject: string
  body: string
}

export type SequenceStep = {
  id?: number
  order: number
  waitInBusinessDays: number
  threadReply: boolean
  stopOnReply?: boolean
  variants: SequenceStepVariant[]
}

export type CampaignSchedule = {
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
  startTime: string
  endTime: string
  timezone: string
  avoidHoursLocal: string[]
}

export type CampaignSenderView = {
  mailbox: MailboxView
  weight: number
  active: boolean
}

export type EnrollmentView = {
  lead: LeadView
  status: string
  currentStep: number
  nextSendAt: string | null
  assignedMailboxId: number | null
  threadId: string | null
  addedAt: string
}

// ─── Campaign CRUD ───────────────────────────────────────────────────────────

export function listCampaigns() {
  return api<{ campaigns: CampaignView[] }>('/api/campaigns').then(
    (r) => r.campaigns,
  )
}

export function getCampaign(id: number) {
  return api<{ campaign: CampaignView }>(`/api/campaigns/${id}`).then(
    (r) => r.campaign,
  )
}

export function createCampaign(name: string) {
  return api<{ campaign: CampaignView }>('/api/campaigns', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }).then((r) => r.campaign)
}

export function updateCampaign(
  id: number,
  patch: Partial<Omit<CampaignView, 'id' | 'createdAt' | 'updatedAt' | 'leadCount' | 'senderCount' | 'stepCount' | 'status' | 'type' | 'reputationBuilding' | 'holidayCalendar' | 'startedAt' | 'completedAt'>>,
) {
  return api<{ campaign: CampaignView }>(`/api/campaigns/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((r) => r.campaign)
}

export function deleteCampaign(id: number) {
  return api<{ ok: true }>(`/api/campaigns/${id}`, { method: 'DELETE' })
}

// ─── Transitions ─────────────────────────────────────────────────────────────

export function launchCampaign(id: number) {
  return api<{ campaign: CampaignView }>(`/api/campaigns/${id}/launch`, {
    method: 'POST',
  }).then((r) => r.campaign)
}
export function pauseCampaign(id: number) {
  return api<{ campaign: CampaignView }>(`/api/campaigns/${id}/pause`, {
    method: 'POST',
  }).then((r) => r.campaign)
}
export function resumeCampaign(id: number) {
  return api<{ campaign: CampaignView }>(`/api/campaigns/${id}/resume`, {
    method: 'POST',
  }).then((r) => r.campaign)
}
export function archiveCampaign(id: number) {
  return api<{ campaign: CampaignView }>(`/api/campaigns/${id}/archive`, {
    method: 'POST',
  }).then((r) => r.campaign)
}

// ─── Sequence ────────────────────────────────────────────────────────────────

export function getCampaignSequence(id: number) {
  return api<{ steps: SequenceStep[] }>(`/api/campaigns/${id}/sequence`).then(
    (r) => r.steps,
  )
}

export function putCampaignSequence(id: number, steps: SequenceStep[]) {
  return api<{ steps: SequenceStep[] }>(`/api/campaigns/${id}/sequence`, {
    method: 'PUT',
    body: JSON.stringify({ steps }),
  }).then((r) => r.steps)
}

// ─── Schedule ────────────────────────────────────────────────────────────────

export function getCampaignSchedule(id: number) {
  return api<{ schedule: CampaignSchedule }>(`/api/campaigns/${id}/schedule`).then(
    (r) => r.schedule,
  )
}

export function putCampaignSchedule(id: number, patch: Partial<CampaignSchedule>) {
  return api<{ schedule: CampaignSchedule }>(`/api/campaigns/${id}/schedule`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then((r) => r.schedule)
}

// ─── Senders ─────────────────────────────────────────────────────────────────

export function getCampaignSenders(id: number) {
  return api<{ senders: CampaignSenderView[] }>(
    `/api/campaigns/${id}/senders`,
  ).then((r) => r.senders)
}

export function attachCampaignSenders(id: number, mailboxIds: number[]) {
  return api<{ senders: CampaignSenderView[] }>(
    `/api/campaigns/${id}/senders`,
    { method: 'POST', body: JSON.stringify({ mailboxIds }) },
  ).then((r) => r.senders)
}

export function updateCampaignSender(
  id: number,
  mailboxId: number,
  patch: { weight?: number; active?: boolean },
) {
  return api<{ ok: true }>(`/api/campaigns/${id}/senders/${mailboxId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function removeCampaignSender(id: number, mailboxId: number) {
  return api<{ ok: true }>(`/api/campaigns/${id}/senders/${mailboxId}`, {
    method: 'DELETE',
  })
}

// ─── Leads ───────────────────────────────────────────────────────────────────

export function getCampaignLeads(id: number, page = 1, limit = 50) {
  return api<{
    enrollments: EnrollmentView[]
    total: number
    page: number
    limit: number
  }>(`/api/campaigns/${id}/leads?page=${page}&limit=${limit}`)
}

export function attachCampaignLeads(id: number, leadIds: number[]) {
  return api<{ added: number }>(`/api/campaigns/${id}/leads`, {
    method: 'POST',
    body: JSON.stringify({ leadIds }),
  })
}

export function attachCampaignLeadList(id: number, listId: number) {
  return api<{ added: number }>(`/api/campaigns/${id}/leads/from-list`, {
    method: 'POST',
    body: JSON.stringify({ listId }),
  })
}

export function removeCampaignLeads(id: number, leadIds: number[]) {
  return api<{ removed: number }>(`/api/campaigns/${id}/leads`, {
    method: 'DELETE',
    body: JSON.stringify({ leadIds }),
  })
}
