import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  getLeadList,
  getLeadsInList,
  removeLeadsFromList,
  type LeadListView,
} from '../lib/lead-lists'
import type { LeadView } from '../lib/leads'

const PAGE_SIZE = 50

export function LeadListDetailPage() {
  const { id } = useParams<{ id: string }>()
  const numId = Number(id)

  const [list, setList] = useState<LeadListView | null>(null)
  const [leads, setLeads] = useState<LeadView[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    if (!Number.isFinite(numId)) return
    setLoading(true)
    try {
      const [l, ls] = await Promise.all([
        getLeadList(numId),
        getLeadsInList(numId, page, PAGE_SIZE),
      ])
      setList(l)
      setLeads(ls.leads)
      setTotal(ls.total)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numId, page])

  async function onRemove(leadId: number) {
    if (!confirm('Remove this lead from the list? (The lead itself stays.)'))
      return
    await removeLeadsFromList(numId, [leadId])
    await refresh()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <AppShell>
      <Link to="/lead-lists" className="back-link">
        ← All lists
      </Link>

      <div className="page-head">
        <div>
          <h1>{list?.name ?? '…'}</h1>
          <p className="dashboard-sub">
            {total.toLocaleString()} lead{total === 1 ? '' : 's'} · created{' '}
            {list && new Date(list.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {loading && <p className="dashboard-sub">Loading…</p>}

      {!loading && leads.length === 0 && (
        <div className="empty-state">
          <h2>This list is empty</h2>
          <p>Import a CSV that targets this list, or attach leads from the leads page.</p>
        </div>
      )}

      {!loading && leads.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Company</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>{l.email}</td>
                  <td>
                    {[l.firstName, l.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td>{l.company ?? '—'}</td>
                  <td>
                    <span className={`badge badge--lead-${l.status}`}>
                      {l.status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => onRemove(l.id)}
                      title="Remove from list"
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
              onClick={() => setPage((p) => p - 1)}
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
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </AppShell>
  )
}
