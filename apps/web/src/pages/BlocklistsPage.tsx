import { useEffect, useState, type FormEvent } from 'react'
import { AppShell } from '../components/AppShell'
import {
  addBlocklistDomain,
  addBlocklistEmail,
  listBlocklistedDomains,
  listBlocklistedEmails,
  removeBlocklistDomain,
  removeBlocklistEmail,
  type BlocklistDomain,
  type BlocklistEmail,
} from '../lib/blocklist'
import { ApiError } from '../lib/api'

type Tab = 'emails' | 'domains'

export function BlocklistsPage() {
  const [tab, setTab] = useState<Tab>('emails')
  const [emails, setEmails] = useState<BlocklistEmail[]>([])
  const [domains, setDomains] = useState<BlocklistDomain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add form state
  const [newValue, setNewValue] = useState('')
  const [newReason, setNewReason] = useState('')
  const [adding, setAdding] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [e, d] = await Promise.all([
        listBlocklistedEmails(),
        listBlocklistedDomains(),
      ])
      setEmails(e)
      setDomains(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (!newValue.trim()) return
    setAdding(true)
    setError(null)
    try {
      if (tab === 'emails') {
        await addBlocklistEmail(newValue.trim(), newReason.trim() || undefined)
      } else {
        await addBlocklistDomain(newValue.trim(), newReason.trim() || undefined)
      }
      setNewValue('')
      setNewReason('')
      await refresh()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError('Already on the blocklist.')
      } else if (e instanceof ApiError && e.status === 400) {
        setError(tab === 'emails' ? 'Invalid email address.' : 'Invalid domain.')
      } else {
        setError(e instanceof Error ? e.message : 'Failed to add')
      }
    } finally {
      setAdding(false)
    }
  }

  async function onRemove(id: number) {
    if (tab === 'emails') {
      await removeBlocklistEmail(id)
    } else {
      await removeBlocklistDomain(id)
    }
    await refresh()
  }

  const items = tab === 'emails' ? emails : domains

  return (
    <AppShell>
      <div className="page-head">
        <div>
          <h1>Blocklist</h1>
          <p className="dashboard-sub">
            Emails and domains here will never be sent to or imported. Bounces and
            unsubscribes auto-add entries.
          </p>
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={tab === 'emails' ? 'tab tab--active' : 'tab'}
          onClick={() => setTab('emails')}
        >
          Emails ({emails.length})
        </button>
        <button
          type="button"
          className={tab === 'domains' ? 'tab tab--active' : 'tab'}
          onClick={() => setTab('domains')}
        >
          Domains ({domains.length})
        </button>
      </div>

      <form className="inline-form" onSubmit={onAdd}>
        <input
          type={tab === 'emails' ? 'email' : 'text'}
          placeholder={tab === 'emails' ? 'name@example.com' : 'example.com'}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Reason (optional)"
          value={newReason}
          onChange={(e) => setNewReason(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={adding}>
          {adding ? 'Adding…' : 'Block'}
        </button>
      </form>

      {error && <div className="banner banner-error"><span>{error}</span></div>}
      {loading && <p className="dashboard-sub">Loading…</p>}

      {!loading && items.length === 0 && (
        <div className="empty-state">
          <h2>Nothing blocked yet</h2>
          <p>
            Add {tab === 'emails' ? 'an email' : 'a domain'} above to get started.
          </p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{tab === 'emails' ? 'Email' : 'Domain'}</th>
              <th>Reason</th>
              <th>Added</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{tab === 'emails' ? (item as BlocklistEmail).email : (item as BlocklistDomain).domain}</td>
                <td className="dim">{item.reason ?? '—'}</td>
                <td className="dim">
                  {new Date(item.createdAt).toLocaleDateString()}
                </td>
                <td>
                  <button
                    type="button"
                    className="row-action"
                    onClick={() => onRemove(item.id)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppShell>
  )
}
