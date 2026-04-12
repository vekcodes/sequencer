import { useEffect, useState, useCallback, useRef } from 'react'
import { AppShell } from '../components/AppShell'
import {
  listReplies,
  getReplyCounts,
  getReply,
  updateReplyFlags,
  type ReplyView,
  type ReplyFilter,
} from '../lib/replies'
import { ApiError } from '../lib/api'

const FILTERS: Array<{ key: ReplyFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'interested', label: 'Interested' },
  { key: 'starred', label: 'Starred' },
  { key: 'archived', label: 'Archived' },
]

export function MasterInboxPage() {
  const [filter, setFilter] = useState<ReplyFilter>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [replies, setReplies] = useState<ReplyView[]>([])
  const [counts, setCounts] = useState({ total: 0, unread: 0, interested: 0, archived: 0 })
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selected, setSelected] = useState<ReplyView | null>(null)
  const [detailBody, setDetailBody] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce search input by 400ms
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 400)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  // Reset to page 1 when filter or search changes
  useEffect(() => { setPage(1) }, [filter, debouncedSearch])

  const loadList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [list, cs] = await Promise.all([
        listReplies({ page, filter, q: debouncedSearch || undefined, limit: 50 }),
        getReplyCounts(),
      ])
      setReplies(list.replies)
      setTotal(list.total)
      setCounts(cs.counts)
    } catch (e) {
      setError(e instanceof ApiError ? `Error ${e.status}` : 'Failed to load replies')
    } finally {
      setLoading(false)
    }
  }, [filter, debouncedSearch, page])

  useEffect(() => { loadList() }, [loadList])

  // Fetch full reply on selection
  useEffect(() => {
    if (!selectedId) { setSelected(null); setDetailBody(null); return }
    let cancelled = false
    getReply(selectedId)
      .then((res) => {
        if (cancelled) return
        setSelected(res.reply)
        setDetailBody(res.reply.snippet) // snippet has up to 240 chars from API; full body comes from the detail endpoint
        if (!res.reply.read) {
          updateReplyFlags(res.reply.id, { read: true }).then((u) => {
            setReplies((prev) => prev.map((r) => (r.id === u.reply.id ? u.reply : r)))
            setCounts((c) => ({ ...c, unread: Math.max(0, c.unread - 1) }))
          }).catch(() => {})
        }
      })
      .catch(() => { if (!cancelled) setError('Failed to load reply') })
    return () => { cancelled = true }
  }, [selectedId])

  async function toggleStar(r: ReplyView) {
    try {
      const updated = await updateReplyFlags(r.id, { starred: !r.starred })
      setReplies((prev) => prev.map((x) => (x.id === r.id ? updated.reply : x)))
      if (selected?.id === r.id) setSelected(updated.reply)
    } catch { /* swallow */ }
  }

  async function toggleArchive(r: ReplyView) {
    try {
      await updateReplyFlags(r.id, { archived: !r.archived })
      // Remove from current list since it moved to/from archived
      setReplies((prev) => prev.filter((x) => x.id !== r.id))
      if (selected?.id === r.id) { setSelected(null); setSelectedId(null) }
      setCounts((c) => ({
        ...c,
        archived: r.archived ? c.archived - 1 : c.archived + 1,
      }))
    } catch { /* swallow */ }
  }

  const totalPages = Math.ceil(total / 50)

  return (
    <AppShell>
      <div className="page">
        <div className="page__header">
          <h1 className="page__title">Master Inbox</h1>
          <p className="page__subtitle">
            All replies from every connected mailbox.{' '}
            <strong>{counts.unread}</strong> unread,{' '}
            <strong>{counts.interested}</strong> interested.
          </p>
        </div>

        <div className="inbox">
          <div className="inbox__toolbar">
            <div className="inbox__filters">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={
                    'inbox__filter' +
                    (filter === f.key ? ' inbox__filter--active' : '')
                  }
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  {f.key === 'unread' && counts.unread > 0 ? ` (${counts.unread})` : ''}
                  {f.key === 'interested' && counts.interested > 0 ? ` (${counts.interested})` : ''}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="inbox__search"
              placeholder="Search replies..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--small"
              onClick={() => loadList()}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {error && <div className="error">{error}</div>}

          <div className="inbox__body">
            <div className="inbox__list">
              {loading && replies.length === 0 && (
                <div className="inbox__empty">Loading...</div>
              )}
              {!loading && replies.length === 0 && (
                <div className="inbox__empty">
                  {debouncedSearch ? 'No replies match your search.' : 'No replies yet.'}
                </div>
              )}
              {replies.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={
                    'inbox__row' +
                    (selectedId === r.id ? ' inbox__row--active' : '') +
                    (r.read ? '' : ' inbox__row--unread')
                  }
                >
                  <div className="inbox__row-head">
                    <span className="inbox__row-from">
                      {r.fromName || r.fromEmail}
                    </span>
                    <span className="inbox__row-date">
                      {new Date(r.receivedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="inbox__row-subject">{r.subject || '(no subject)'}</div>
                  <div className="inbox__row-snippet">{r.snippet}</div>
                  <div className="inbox__row-meta">
                    <span className={`pill pill--${r.classification}`}>
                      {r.classification.replace(/_/g, ' ')}
                    </span>
                    {r.starred && <span className="pill pill--interested">starred</span>}
                    {r.campaignName && (
                      <span className="inbox__row-campaign">{r.campaignName}</span>
                    )}
                  </div>
                </button>
              ))}
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', padding: '0.75rem' }}>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', alignSelf: 'center' }}>
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            <div className="inbox__detail">
              {!selected && (
                <div className="inbox__empty">
                  Select a reply to preview it.
                </div>
              )}
              {selected && (
                <article style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <header className="inbox__detail-head">
                    <h2>{selected.subject || '(no subject)'}</h2>
                    <div className="inbox__detail-meta">
                      <div>
                        <strong>From:</strong>{' '}
                        {selected.fromName ? `${selected.fromName} <${selected.fromEmail}>` : selected.fromEmail}
                      </div>
                      <div>
                        <strong>To:</strong> {selected.toEmail ?? selected.mailboxEmail}
                      </div>
                      <div>
                        <strong>Received:</strong>{' '}
                        {new Date(selected.receivedAt).toLocaleString()}
                      </div>
                      {selected.campaignName && (
                        <div>
                          <strong>Campaign:</strong> {selected.campaignName}
                        </div>
                      )}
                      <div>
                        <strong>Classification:</strong>{' '}
                        <span className={`pill pill--${selected.classification}`}>
                          {selected.classification.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>
                    <div className="inbox__detail-actions">
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => toggleStar(selected)}
                      >
                        {selected.starred ? '\u2605 Starred' : '\u2606 Star'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => toggleArchive(selected)}
                      >
                        {selected.archived ? 'Unarchive' : 'Archive'}
                      </button>
                    </div>
                  </header>
                  <pre className="inbox__detail-body">
                    {detailBody ?? selected.snippet}
                  </pre>
                </article>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
