import { api } from './api'

export type ReplyClassification =
  | 'interested'
  | 'not_interested'
  | 'neutral'
  | 'auto_reply'
  | 'unknown'

export type ReplyView = {
  id: number
  mailboxId: number
  mailboxEmail: string
  campaignId: number | null
  campaignName: string | null
  campaignLeadId: number | null
  leadId: number | null
  leadName: string | null
  fromEmail: string
  fromName: string | null
  toEmail: string | null
  subject: string | null
  snippet: string
  classification: ReplyClassification
  read: boolean
  starred: boolean
  archived: boolean
  gmailThreadId: string | null
  gmailMessageId: string | null
  receivedAt: string
}

export type ReplyFilter = 'all' | 'unread' | 'interested' | 'starred' | 'archived'

export async function listReplies(params: {
  page?: number
  limit?: number
  filter?: ReplyFilter
  q?: string
  mailboxId?: number
}): Promise<{ replies: ReplyView[]; total: number; page: number; limit: number }> {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.filter) qs.set('filter', params.filter)
  if (params.q) qs.set('q', params.q)
  if (params.mailboxId) qs.set('mailboxId', String(params.mailboxId))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return api(`/api/replies${query}`)
}

export async function sendReplyToThread(
  id: number,
  body: { body: string },
): Promise<{ reply: ReplyView; gmailMessageId: string }> {
  return api(`/api/replies/${id}/reply`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getReplyCounts(): Promise<{
  counts: { total: number; unread: number; interested: number; archived: number }
}> {
  return api('/api/replies/counts')
}

export async function getReply(id: number): Promise<{ reply: ReplyView }> {
  return api(`/api/replies/${id}`)
}

export async function updateReplyFlags(
  id: number,
  patch: { read?: boolean; starred?: boolean; archived?: boolean },
): Promise<{ reply: ReplyView }> {
  return api(`/api/replies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
