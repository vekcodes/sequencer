import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  bulkDeleteLeads,
  createLead,
  deleteLead,
  listLeads,
  type LeadStatus,
  type LeadView,
} from '../lib/leads'
import { ApiError } from '../lib/api'

const STATUS_OPTIONS: { value: LeadStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'replied', label: 'Replied' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'blacklisted', label: 'Blacklisted' },
]

const PAGE_SIZE = 50

export function LeadsPage() {
  const [params, setParams] = useSearchParams()
  const search = params.get('search') ?? ''
  const status = (params.get('status') as LeadStatus | null) ?? null
  const page = Math.max(1, Number(params.get('page') ?? '1'))

  const [leads, setLeads] = useState<LeadView[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [showAdd, setShowAdd] = useState(false)

  // Local search input — only updates URL on submit so we don't refetch on every keystroke
  const [searchInput, setSearchInput] = useState(search)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await listLeads({
        search: search || undefined,
        status: status || undefined,
        page,
        limit: PAGE_SIZE,
      })
      setLeads(result.leads)
      setTotal(result.total)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [search, status, page])

  useEffect(() => {
    refresh()
  }, [refresh])

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
    next.delete('page') // reset to page 1 on filter change
    setParams(next, { replace: true })
  }

  function gotoPage(p: number) {
    const next = new URLSearchParams(params)
    next.set('page', String(p))
    setParams(next)
  }

  function onSearchSubmit(e: FormEvent) {
    e.preventDefault()
    setParam('search', searchInput.trim())
  }

  function toggleSelect(id: number) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  function toggleSelectAll() {
    if (selected.size === leads.length) setSelected(new Set())
    else setSelected(new Set(leads.map((l) => l.id)))
  }

  async function onDeleteSelected() {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} lead(s)? This can't be undone.`)) return
    await bulkDeleteLeads(Array.from(selected))
    await refresh()
  }

  async function onDeleteOne(id: number) {
    if (!confirm('Delete this lead?')) return
    await deleteLead(id)
    await refresh()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <AppShell>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="dashboard-sub">
            {total.toLocaleString()} total · page {page} of {totalPages}
          </p>
        </div>
        <div className="actions">
          <Link to="/leads/import" className="btn-secondary">
            Import CSV
          </Link>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowAdd((s) => !s)}
          >
            {showAdd ? 'Cancel' : '+ Add lead'}
          </button>
        </div>
      </div>

      {showAdd && <AddLeadInline onCreated={() => { setShowAdd(false); refresh() }} />}

      <div className="filter-bar">
        <form onSubmit={onSearchSubmit} className="filter-search">
          <input
            type="search"
            placeholder="Search email, name, company…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button type="submit" className="btn-secondary">
            Search
          </button>
        </form>
        <select
          value={status ?? ''}
          onChange={(e) => setParam('status', e.target.value || null)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {selected.size > 0 && (
          <button
            type="button"
            className="btn-danger"
            onClick={onDeleteSelected}
          >
            Delete {selected.size}
          </button>
        )}
      </div>

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48, borderRadius: 8 }} />
          ))}
        </div>
      )}

      {!loading && !error && leads.length === 0 && (
        <div className="empty-state">
          <h2>No leads yet</h2>
          <p>Import a CSV or add your first lead manually to get started.</p>
          <Link to="/leads/import" className="btn-primary">
            Import CSV
          </Link>
        </div>
      )}

      {!loading && leads.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th className="check">
                  <input
                    type="checkbox"
                    checked={selected.size === leads.length && leads.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Email</th>
                <th>Name</th>
                <th>Company</th>
                <th>Title</th>
                <th>Variables</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggleSelect(l.id)}
                    />
                  </td>
                  <td>{l.email}</td>
                  <td>
                    {[l.firstName, l.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td>{l.company ?? '—'}</td>
                  <td>{l.title ?? '—'}</td>
                  <td>
                    <CustomVarsCell vars={l.customVariables} />
                  </td>
                  <td>
                    <span className={`badge badge--lead-${l.status}`}>
                      {l.status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => onDeleteOne(l.id)}
                      title="Delete"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button
              type="button"
              className="btn-secondary"
              disabled={page <= 1}
              onClick={() => gotoPage(page - 1)}
            >
              ← Previous
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={page >= totalPages}
              onClick={() => gotoPage(page + 1)}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </AppShell>
  )
}

// ─── Custom variables cell ─────────────────────────────────────────────────

function CustomVarsCell({ vars }: { vars: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const entries = Object.entries(vars ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && String(v).length > 0,
  )
  if (entries.length === 0) return <span className="dim">—</span>

  const title = entries
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('\n\n')

  const summary =
    entries.length === 1
      ? `${entries[0]![0]}`
      : `${entries[0]![0]} +${entries.length - 1} more`

  return (
    <>
      <button
        type="button"
        className="row-action"
        style={{ fontSize: '0.8rem', padding: '2px 6px' }}
        onClick={() => setOpen(true)}
        title={title}
      >
        {summary}
      </button>
      {open && (
        <div
          role="dialog"
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg, #fff)',
              color: 'var(--text, #111)',
              border: '1px solid var(--border, #ddd)',
              borderRadius: 8,
              padding: '1rem 1.25rem',
              maxWidth: 520,
              maxHeight: '70vh',
              overflow: 'auto',
              width: '90%',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Custom variables</h3>
              <button type="button" className="row-action" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <dl style={{ marginTop: '0.75rem' }}>
              {entries.map(([k, v]) => (
                <div key={k} style={{ marginBottom: '0.75rem' }}>
                  <dt>
                    <code>{`{{${k}}}`}</code>
                  </dt>
                  <dd style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap' }}>
                    {String(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Inline add-lead form ──────────────────────────────────────────────────

function AddLeadInline({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createLead({
        email,
        firstName: firstName || null,
        lastName: lastName || null,
        company: company || null,
        title: title || null,
      })
      onCreated()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const code = (e.payload as { error?: string })?.error
        setError(
          code === 'email_blocklisted'
            ? 'This email is on the blocklist.'
            : 'A lead with this email already exists.',
        )
      } else {
        setError(e instanceof Error ? e.message : 'Failed to create lead')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <input
        type="email"
        placeholder="Email *"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        type="text"
        placeholder="First name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <input
        type="text"
        placeholder="Last name"
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
      />
      <input
        type="text"
        placeholder="Company"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
      />
      <input
        type="text"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Adding…' : 'Add'}
      </button>
      {error && <div className="inline-form__error">{error}</div>}
    </form>
  )
}
