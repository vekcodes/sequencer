import { api } from './api'
import type { ListLeadsResponse } from './leads'

export type LeadListView = {
  id: number
  name: string
  leadCount: number
  createdAt: string
}

export function listLeadLists() {
  return api<{ leadLists: LeadListView[] }>('/api/lead-lists').then(
    (r) => r.leadLists,
  )
}

export function createLeadList(name: string) {
  return api<{ leadList: LeadListView }>('/api/lead-lists', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }).then((r) => r.leadList)
}

export function getLeadList(id: number) {
  return api<{ leadList: LeadListView }>(`/api/lead-lists/${id}`).then(
    (r) => r.leadList,
  )
}

export function deleteLeadList(id: number) {
  return api<{ ok: true }>(`/api/lead-lists/${id}`, { method: 'DELETE' })
}

export function getLeadsInList(id: number, page = 1, limit = 50) {
  return api<ListLeadsResponse>(
    `/api/lead-lists/${id}/leads?page=${page}&limit=${limit}`,
  )
}

export function addLeadsToList(id: number, leadIds: number[]) {
  return api<{ added: number }>(`/api/lead-lists/${id}/leads`, {
    method: 'POST',
    body: JSON.stringify({ leadIds }),
  })
}

export function removeLeadsFromList(id: number, leadIds: number[]) {
  return api<{ removed: number }>(`/api/lead-lists/${id}/leads`, {
    method: 'DELETE',
    body: JSON.stringify({ leadIds }),
  })
}
