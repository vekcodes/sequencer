import { api } from './api'

export type BlocklistEmail = {
  id: number
  email: string
  reason: string | null
  createdAt: string
}

export type BlocklistDomain = {
  id: number
  domain: string
  reason: string | null
  createdAt: string
}

// ─── Emails ──────────────────────────────────────────────────────────────────

export function listBlocklistedEmails() {
  return api<{ items: BlocklistEmail[] }>('/api/blocklist/emails').then(
    (r) => r.items,
  )
}

export function addBlocklistEmail(email: string, reason?: string) {
  return api<{ item: BlocklistEmail }>('/api/blocklist/emails', {
    method: 'POST',
    body: JSON.stringify({ email, reason }),
  }).then((r) => r.item)
}

export function removeBlocklistEmail(id: number) {
  return api<{ ok: true }>(`/api/blocklist/emails/${id}`, { method: 'DELETE' })
}

// ─── Domains ─────────────────────────────────────────────────────────────────

export function listBlocklistedDomains() {
  return api<{ items: BlocklistDomain[] }>('/api/blocklist/domains').then(
    (r) => r.items,
  )
}

export function addBlocklistDomain(domain: string, reason?: string) {
  return api<{ item: BlocklistDomain }>('/api/blocklist/domains', {
    method: 'POST',
    body: JSON.stringify({ domain, reason }),
  }).then((r) => r.item)
}

export function removeBlocklistDomain(id: number) {
  return api<{ ok: true }>(`/api/blocklist/domains/${id}`, {
    method: 'DELETE',
  })
}
