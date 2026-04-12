import { useEffect, useState } from 'react'
import {
  attachCampaignSenders,
  getCampaignSenders,
  removeCampaignSender,
  updateCampaignSender,
  type CampaignSenderView,
} from '../lib/campaigns'
import { listMailboxes, type MailboxView } from '../lib/mailboxes'

type Props = { campaignId: number; onChanged: () => void }

export function CampaignSendersEditor({ campaignId, onChanged }: Props) {
  const [senders, setSenders] = useState<CampaignSenderView[]>([])
  const [available, setAvailable] = useState<MailboxView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [s, all] = await Promise.all([
        getCampaignSenders(campaignId),
        listMailboxes(),
      ])
      setSenders(s)
      const attachedIds = new Set(s.map((x) => x.mailbox.id))
      setAvailable(all.filter((m) => !attachedIds.has(m.id)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId])

  async function onAttach(mailboxId: number) {
    await attachCampaignSenders(campaignId, [mailboxId])
    setShowPicker(false)
    await refresh()
    onChanged()
  }

  async function onRemove(mailboxId: number) {
    if (!confirm('Remove this sender? Existing thread continuity stays intact.'))
      return
    await removeCampaignSender(campaignId, mailboxId)
    await refresh()
    onChanged()
  }

  async function onWeightChange(mailboxId: number, weight: number) {
    setSenders((prev) =>
      prev.map((s) => (s.mailbox.id === mailboxId ? { ...s, weight } : s)),
    )
  }

  async function onWeightCommit(mailboxId: number, weight: number) {
    await updateCampaignSender(campaignId, mailboxId, { weight })
  }

  if (loading) return <p className="dashboard-sub">Loading senders…</p>

  return (
    <div className="senders-editor">
      {error && <div className="banner banner-error"><span>{error}</span></div>}

      <div className="page-head">
        <p className="dashboard-sub" style={{ margin: 0 }}>
          {senders.length} mailbox{senders.length === 1 ? '' : 'es'} attached. Sticky-per-lead routing
          assigns each lead to one of these on first send.
        </p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setShowPicker((s) => !s)}
          disabled={available.length === 0}
        >
          {showPicker ? 'Cancel' : '+ Attach mailbox'}
        </button>
      </div>

      {showPicker && available.length > 0 && (
        <div className="picker">
          <p className="dim small">Pick a mailbox to attach:</p>
          {available.map((m) => (
            <button
              key={m.id}
              type="button"
              className="picker-item"
              onClick={() => onAttach(m.id)}
            >
              <strong>{m.email}</strong>
              <span className={`badge badge--pool-${m.pool}`}>{m.pool}</span>
            </button>
          ))}
        </div>
      )}

      {senders.length === 0 && (
        <div className="empty-state">
          <h2>No senders attached</h2>
          <p>
            {available.length > 0
              ? 'Click "Attach mailbox" above to pick from your connected Gmails.'
              : 'Connect a Gmail in the Mailboxes tab first.'}
          </p>
        </div>
      )}

      {senders.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Pool</th>
              <th>Daily cap</th>
              <th>Weight</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {senders.map((s) => (
              <tr key={s.mailbox.id}>
                <td>{s.mailbox.email}</td>
                <td>
                  <span className={`badge badge--pool-${s.mailbox.pool}`}>
                    {s.mailbox.pool}
                  </span>
                </td>
                <td>
                  {s.mailbox.dailyLimitCurrent}/{s.mailbox.dailyLimitTarget}
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    className="weight-input"
                    value={s.weight}
                    onChange={(e) =>
                      onWeightChange(s.mailbox.id, Math.max(1, Number(e.target.value)))
                    }
                    onBlur={(e) =>
                      onWeightCommit(s.mailbox.id, Math.max(1, Number(e.target.value)))
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="row-action"
                    onClick={() => onRemove(s.mailbox.id)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
