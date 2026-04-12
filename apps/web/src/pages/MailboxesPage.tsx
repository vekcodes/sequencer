import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  listMailboxes,
  startGoogleConnect,
  type MailboxView,
} from '../lib/mailboxes'

const POOL_LABELS: Record<MailboxView['pool'], string> = {
  primed: 'Primed',
  ramping: 'Ramping',
  resting: 'Resting',
}

const POOL_DESCRIPTIONS: Record<MailboxView['pool'], string> = {
  primed: 'Mature mailboxes carrying the bulk of your sending volume',
  ramping: 'New or recovering mailboxes still building reputation',
  resting: 'Paused due to a deliverability trigger — will recover',
}

export function MailboxesPage() {
  const [params, setParams] = useSearchParams()
  const [mailboxes, setMailboxes] = useState<MailboxView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const errorParam = params.get('error')

  useEffect(() => {
    let cancelled = false
    listMailboxes()
      .then((data) => {
        if (!cancelled) setMailboxes(data)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function dismissError() {
    params.delete('error')
    setParams(params, { replace: true })
  }

  const grouped = (mailboxes ?? []).reduce<Record<MailboxView['pool'], MailboxView[]>>(
    (acc, m) => {
      acc[m.pool].push(m)
      return acc
    },
    { primed: [], ramping: [], resting: [] },
  )

  return (
    <AppShell>
      <div className="page-head">
        <div>
          <h1>Sender Emails</h1>
          <p className="dashboard-sub">
            Connected sender accounts grouped by deliverability pool.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={startGoogleConnect}
        >
          + Connect Gmail
        </button>
      </div>

      {errorParam && (
        <div className="banner banner-error">
          <span>Connect failed: <code>{errorParam}</code></span>
          <button type="button" onClick={dismissError}>&times;</button>
        </div>
      )}

      {loading && (
        <div className="kpi-grid">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton skeleton-text" style={{ width: '60%' }} />
              <div className="skeleton skeleton-heading" style={{ width: '40%' }} />
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && mailboxes && mailboxes.length === 0 && (
        <div className="empty-state">
          <h2>No mailboxes connected yet</h2>
          <p>
            Connect your first Gmail account to start sending. We'll start it in
            the <strong>Ramping</strong> pool at 5 emails/day and grow it to 30/day
            over the next few weeks while we monitor deliverability.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={startGoogleConnect}
          >
            + Connect Gmail
          </button>
        </div>
      )}

      {!loading && !error && mailboxes && mailboxes.length > 0 && (
        <div className="pools">
          {(['primed', 'ramping', 'resting'] as const).map((pool) => (
            <section key={pool} className={`pool pool--${pool}`}>
              <header>
                <h2>
                  {POOL_LABELS[pool]}
                  <span className="count">{grouped[pool].length}</span>
                </h2>
                <p>{POOL_DESCRIPTIONS[pool]}</p>
              </header>
              {grouped[pool].length === 0 ? (
                <div className="pool-empty">No mailboxes in this pool</div>
              ) : (
                <div className="mailbox-grid">
                  {grouped[pool].map((m) => (
                    <MailboxCard key={m.id} mailbox={m} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </AppShell>
  )
}

function MailboxCard({ mailbox }: { mailbox: MailboxView }) {
  const usagePct = Math.min(
    100,
    Math.round(
      (mailbox.dailyLimitCurrent / Math.max(1, mailbox.dailyLimitTarget)) * 100,
    ),
  )
  return (
    <Link to={`/mailboxes/${mailbox.id}`} className="mailbox-card">
      <div className="mailbox-card__head">
        <strong>{mailbox.email}</strong>
        <HealthBadge status={mailbox.healthStatus} />
      </div>
      <div className="mailbox-card__stats">
        <div>
          <span className="stat-label">Health</span>
          <span className="stat-value">{mailbox.healthScore}/100</span>
        </div>
        <div>
          <span className="stat-label">Daily cap</span>
          <span className="stat-value">
            {mailbox.dailyLimitCurrent}/{mailbox.dailyLimitTarget}
          </span>
        </div>
      </div>
      <div className="ramp-bar">
        <div className="ramp-bar__fill" style={{ width: `${usagePct}%` }} />
      </div>
    </Link>
  )
}

function HealthBadge({ status }: { status: MailboxView['healthStatus'] }) {
  const labels: Record<MailboxView['healthStatus'], string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    paused: 'Paused',
    bouncing: 'Bouncing',
  }
  return <span className={`badge badge--${status}`}>{labels[status]}</span>
}
