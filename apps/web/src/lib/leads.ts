import { api } from './api'

export type LeadStatus =
  | 'active'
  | 'replied'
  | 'unsubscribed'
  | 'bounced'
  | 'blacklisted'

export type LeadView = {
  id: number
  email: string
  firstName: string | null
  lastName: string | null
  company: string | null
  title: string | null
  phone: string | null
  customVariables: Record<string, unknown>
  timezone: string | null
  status: LeadStatus
  createdAt: string
  updatedAt: string
}

export type ListLeadsResponse = {
  leads: LeadView[]
  total: number
  page: number
  limit: number
}

export type ListLeadsParams = {
  search?: string
  status?: LeadStatus
  page?: number
  limit?: number
}

export function listLeads(params: ListLeadsParams = {}) {
  const q = new URLSearchParams()
  if (params.search) q.set('search', params.search)
  if (params.status) q.set('status', params.status)
  if (params.page) q.set('page', String(params.page))
  if (params.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return api<ListLeadsResponse>(`/api/leads${qs ? '?' + qs : ''}`)
}

export type CreateLeadInput = {
  email: string
  firstName?: string | null
  lastName?: string | null
  company?: string | null
  title?: string | null
  phone?: string | null
  timezone?: string | null
  customVariables?: Record<string, unknown>
}

export function createLead(input: CreateLeadInput) {
  return api<{ lead: LeadView }>('/api/leads', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.lead)
}

export function updateLead(id: number, input: Partial<CreateLeadInput>) {
  return api<{ lead: LeadView }>(`/api/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((r) => r.lead)
}

export function deleteLead(id: number) {
  return api<{ ok: true }>(`/api/leads/${id}`, { method: 'DELETE' })
}

export function bulkDeleteLeads(ids: number[]) {
  return api<{ deleted: number }>('/api/leads/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

// ─── CSV import ──────────────────────────────────────────────────────────────

export type CsvHeadersResponse = {
  headers: string[]
  preview: string[][]
  totalRows: number
}

export function parseCsvHeaders(csv: string) {
  return api<CsvHeadersResponse>('/api/leads/parse-headers', {
    method: 'POST',
    body: JSON.stringify({ csv }),
  })
}

export type ColumnField =
  | 'email'
  | 'first_name'
  | 'last_name'
  | 'company'
  | 'title'
  | 'phone'
  | 'timezone'
  | `custom_var:${string}`
  | null

export type ImportLeadsInput = {
  csv: string
  hasHeader: boolean
  /** Keys are CSV column indices as strings, values are field names. */
  mapping: Record<string, ColumnField>
  listId?: number
  listName?: string
}

export type ImportLeadsResponse = {
  imported: number
  parsed: number
  errors: Array<{ rowIndex: number; reason: string }>
  listId: number | null
}

export function importLeads(input: ImportLeadsInput) {
  return api<ImportLeadsResponse>('/api/leads/import', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
