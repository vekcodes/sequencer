import { useEffect, useState } from 'react'
import {
  attachCampaignLeadList,
  getCampaignLeads,
  removeCampaignLeads,
  type EnrollmentView,
} from '../lib/campaigns'
import { listLeadLists, type LeadListView } from '../lib/lead-lists'
import { useToast } from './Toast'

type Props = { campaignId: number; onChanged: () => void }

const PAGE_SIZE = 50

export function CampaignLeadsEditor({ campaignId, onChanged }: Props) {
  const { toast } = useToast()
  const [enrollments, setEnrollments] = useState<EnrollmentView[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [lists, setLists] = useState<LeadListView[]>([])
  const [selectedList, setSelectedList] = useState<number | null>(null)
  const [attaching, setAttaching] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const result = await getCampaignLeads(campaignId, page, PAGE_SIZE)
      setEnrollments(result.enrollments)
      setTotal(result.total)
      const ls = await listLeadLists()
      setLists(ls)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, page])

  async function onAttachList() {
    if (!selectedList) return
    setAttaching(true)
    try {
      const result = await attachCampaignLeadList(campaignId, selectedList)
      toast('success', `Attached ${result.added} lead(s) to the campaign.`)
      await refresh()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Attach failed')
    } finally {
      setAttaching(false)
    }
  }

  async function onRemove(leadId: number) {
    if (!confirm('Remove this lead from the campaign?')) return
    await removeCampaignLeads(campaignId, [leadId])
    await refresh()
    onChanged()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (loading && enrollments.length === 0)
    return <p className="dashboard-sub">Loading leads…</p>

  return (
    <div className="campaign-leads">
      {error && <div className="banner banner-error"><span>{error}</span></div>}

      <div className="inline-form">
        <select
          value={selectedList ?? ''}
          onChange={(e) =>
            setSelectedList(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">Pick a lead list to attach…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.leadCount.toLocaleString()})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-primary"
          disabled={!selectedList || attaching}
          onClick={onAttachList}
        >
          {attaching ? 'Attaching…' : 'Attach list'}
        </button>
      </div>

      <p className="dashboard-sub">
        {total.toLocaleString()} lead{total === 1 ? '' : 's'} enrolled · page{' '}
        {page} of {totalPages}
      </p>

      {enrollments.length === 0 ? (
        <div className="empty-state">
          <h2>No leads enrolled</h2>
          <p>
            Pick a lead list above to enroll all of its leads. Or import a CSV
            from the Leads page first.
          </p>
        </div>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Status</th>
                <th>Step</th>
                <th>Next send</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {enrollments.map((e) => (
                <tr key={e.lead.id}>
                  <td>{e.lead.email}</td>
                  <td>
                    {[e.lead.firstName, e.lead.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td>
                    <span className={`badge badge--enroll-${e.status}`}>
                      {e.status}
                    </span>
                  </td>
                  <td>{e.currentStep}</td>
                  <td className="dim">
                    {e.nextSendAt
                      ? new Date(e.nextSendAt).toLocaleString()
                      : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => onRemove(e.lead.id)}
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
    </div>
  )
}
