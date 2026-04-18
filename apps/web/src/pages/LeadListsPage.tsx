import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  createLeadList,
  deleteLeadList,
  listLeadLists,
  type LeadListView,
} from '../lib/lead-lists'

export function LeadListsPage() {
  const [lists, setLists] = useState<LeadListView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      setLists(await listLeadLists())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    try {
      await createLeadList(newName.trim())
      setNewName('')
      setShowAdd(false)
      await refresh()
    } finally {
      setCreating(false)
    }
  }

  async function onDelete(id: number, name: string) {
    if (
      !confirm(
        `Permanently delete list "${name}"?\n\nThis cannot be undone. The individual lead rows are kept (they just lose their membership in this list).`,
      )
    )
      return
    await deleteLeadList(id)
    await refresh()
  }

  return (
    <AppShell>
      <div className="page-head">
        <div>
          <h1>Lead lists</h1>
          <p className="dashboard-sub">
            Group leads into named lists for use in campaigns.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setShowAdd((s) => !s)}
        >
          {showAdd ? 'Cancel' : '+ New list'}
        </button>
      </div>

      {showAdd && (
        <form className="inline-form" onSubmit={onCreate}>
          <input
            type="text"
            placeholder="List name (e.g. Q2 SaaS founders)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {error && <div className="banner banner-error"><span>{error}</span></div>}
      {loading && <p className="dashboard-sub">Loading…</p>}

      {!loading && lists.length === 0 && (
        <div className="empty-state">
          <h2>No lists yet</h2>
          <p>Create one above, or import a CSV with a list name to auto-create.</p>
          <Link to="/leads/import" className="btn-primary">
            Import CSV
          </Link>
        </div>
      )}

      {!loading && lists.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Leads</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lists.map((list) => (
              <tr key={list.id}>
                <td>
                  <Link to={`/lead-lists/${list.id}`}>{list.name}</Link>
                </td>
                <td>{list.leadCount.toLocaleString()}</td>
                <td className="dim">
                  {new Date(list.createdAt).toLocaleDateString()}
                </td>
                <td>
                  <button
                    type="button"
                    className="row-action"
                    onClick={() => onDelete(list.id, list.name)}
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
