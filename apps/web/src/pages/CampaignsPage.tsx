import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  createCampaign,
  deleteCampaign,
  listCampaigns,
  type CampaignStatus,
  type CampaignView,
} from '../lib/campaigns'

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
}

export function CampaignsPage() {
  const navigate = useNavigate()

  const [campaigns, setCampaigns] = useState<CampaignView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setCampaigns(await listCampaigns())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function onDelete(c: CampaignView) {
    if (
      !confirm(
        `Permanently delete campaign "${c.name}"?\n\nThis will remove the campaign plus every enrollment, queued send, and event tied to it. Cannot be undone.`,
      )
    )
      return
    try {
      await deleteCampaign(c.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    try {
      const created = await createCampaign(newName.trim())
      navigate(`/campaigns/${created.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  return (
    <AppShell>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="dashboard-sub">
            New campaigns get a default 6-step sequence and Mon-Fri 9am-4:30pm schedule.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setShowAdd((s) => !s)}
        >
          {showAdd ? 'Cancel' : '+ New campaign'}
        </button>
      </div>

      {showAdd && (
        <form className="inline-form" onSubmit={onCreate}>
          <input
            type="text"
            placeholder="Campaign name (e.g. Q2 SaaS founders outbound)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 52, borderRadius: 8 }} />
          ))}
        </div>
      )}

      {!loading && campaigns.length === 0 && (
        <div className="empty-state">
          <h2>No campaigns yet</h2>
          <p>
            Create your first campaign to start sending. We'll seed it with a
            safe-by-default 6-step sequence so you can edit instead of starting blank.
          </p>
        </div>
      )}

      {!loading && campaigns.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Senders</th>
              <th>Leads</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/campaigns/${c.id}`}>{c.name}</Link>
                </td>
                <td>
                  <span className={`badge badge--campaign-${c.status}`}>
                    {STATUS_LABEL[c.status]}
                  </span>
                </td>
                <td>{c.stepCount}</td>
                <td>{c.senderCount}</td>
                <td>{c.leadCount.toLocaleString()}</td>
                <td className="dim">
                  {new Date(c.createdAt).toLocaleDateString()}
                </td>
                <td>
                  <button
                    type="button"
                    className="row-action"
                    title="Permanently delete campaign"
                    onClick={() => onDelete(c)}
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
