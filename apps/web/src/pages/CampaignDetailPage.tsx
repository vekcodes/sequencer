import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  archiveCampaign,
  getCampaign,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  type CampaignView,
} from '../lib/campaigns'
import { ApiError } from '../lib/api'
import { CampaignOverview } from '../components/CampaignOverview'
import { CampaignSequenceEditor } from '../components/CampaignSequenceEditor'
import { CampaignScheduleEditor } from '../components/CampaignScheduleEditor'
import { CampaignSendersEditor } from '../components/CampaignSendersEditor'
import { CampaignLeadsEditor } from '../components/CampaignLeadsEditor'
import { CampaignSettingsEditor } from '../components/CampaignSettingsEditor'

type Tab = 'overview' | 'sequence' | 'schedule' | 'senders' | 'leads' | 'settings'

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  sequence: 'Sequence',
  schedule: 'Schedule',
  senders: 'Senders',
  leads: 'Leads',
  settings: 'Settings',
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const numId = Number(id)
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab | null) ?? 'overview'

  const [campaign, setCampaign] = useState<CampaignView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!Number.isFinite(numId)) return
    try {
      setCampaign(await getCampaign(numId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    }
  }, [numId])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  function setTab(t: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', t)
    setParams(next, { replace: true })
  }

  async function runAction(fn: () => Promise<CampaignView>) {
    setBusy(true)
    setActionError(null)
    try {
      const updated = await fn()
      setCampaign(updated)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 409)) {
        const msg = (e.payload as { message?: string })?.message
        setActionError(msg ?? 'Action failed')
      } else {
        setActionError(e instanceof Error ? e.message : 'Action failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell>
      <Link to="/campaigns" className="back-link">
        ← All campaigns
      </Link>

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="skeleton skeleton-heading" style={{ width: '40%' }} />
          <div className="skeleton" style={{ height: 44, borderRadius: 8 }} />
          <div className="detail-grid">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton-card">
                <div className="skeleton skeleton-text" style={{ width: '50%' }} />
                <div className="skeleton skeleton-heading" style={{ width: '30%' }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {!loading && campaign && (
        <>
          <div className="page-head">
            <div>
              <h1>{campaign.name}</h1>
              <p className="dashboard-sub">
                <span className={`badge badge--campaign-${campaign.status}`}>
                  {campaign.status}
                </span>{' '}
                · {campaign.stepCount} steps · {campaign.senderCount} senders ·{' '}
                {campaign.leadCount.toLocaleString()} leads
              </p>
            </div>
            <div className="actions">
              {campaign.status === 'draft' && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => runAction(() => launchCampaign(campaign.id))}
                >
                  ▶ Launch
                </button>
              )}
              {campaign.status === 'active' && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => runAction(() => pauseCampaign(campaign.id))}
                >
                  ⏸ Pause
                </button>
              )}
              {campaign.status === 'paused' && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => runAction(() => resumeCampaign(campaign.id))}
                >
                  ▶ Resume
                </button>
              )}
              {campaign.status !== 'archived' && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    if (confirm('Archive this campaign? It can be unarchived later.'))
                      runAction(() => archiveCampaign(campaign.id))
                  }}
                >
                  Archive
                </button>
              )}
            </div>
          </div>

          {actionError && (
            <div className="banner banner-error">
              <span>{actionError}</span>
            </div>
          )}

          <div className="tabs">
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? 'tab tab--active' : 'tab'}
                onClick={() => setTab(t)}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <CampaignOverview campaign={campaign} />
          )}
          {tab === 'sequence' && (
            <CampaignSequenceEditor
              campaignId={campaign.id}
              campaignStatus={campaign.status}
              onSaved={refresh}
            />
          )}
          {tab === 'schedule' && (
            <CampaignScheduleEditor campaignId={campaign.id} />
          )}
          {tab === 'senders' && (
            <CampaignSendersEditor campaignId={campaign.id} onChanged={refresh} />
          )}
          {tab === 'leads' && (
            <CampaignLeadsEditor campaignId={campaign.id} onChanged={refresh} />
          )}
          {tab === 'settings' && (
            <CampaignSettingsEditor campaign={campaign} onSaved={refresh} />
          )}
        </>
      )}
    </AppShell>
  )
}
