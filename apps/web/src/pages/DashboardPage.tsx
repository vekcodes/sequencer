import { useEffect, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { DashboardChart } from '../components/DashboardChart'
import { api, ApiError } from '../lib/api'

type Totals = {
  sent: number
  peopleContacted: number
  totalOpens: number
  uniqueOpens: number
  replies: number
  bounced: number
  unsubscribed: number
  interested: number
}

type SeriesPoint = {
  date: string
  sent: number
  totalOpens: number
  uniqueOpens: number
  replied: number
  bounced: number
  unsubscribed: number
  interested: number
}

type DashboardStats = {
  days: number
  totals: Totals
  series: SeriesPoint[]
}

const RANGE_OPTIONS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 10 days', days: 10 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** Safe percentage: returns 0 when denominator is 0 so we don't show NaN. */
function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0
  return (numerator / denominator) * 100
}

function formatPercent(p: number): string {
  if (p === 0) return '0%'
  if (p < 0.01) return '<0.01%'
  return `${p.toFixed(2)}%`
}

export function DashboardPage() {
  const [days, setDays] = useState(10)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api<DashboardStats>(`/api/stats/dashboard?days=${days}`)
      .then((data) => {
        if (cancelled) return
        setStats(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError) {
          setError(`Failed to load stats (HTTP ${err.status})`)
        } else {
          setError('Failed to load stats')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [days])

  const totals = stats?.totals
  const series = stats?.series ?? []

  // Derived rates for the card badges.
  const replyRate = percent(totals?.replies ?? 0, totals?.sent ?? 0)
  const bounceRate = percent(totals?.bounced ?? 0, totals?.sent ?? 0)
  const unsubRate = percent(totals?.unsubscribed ?? 0, totals?.sent ?? 0)
  const uniqueOpenRate = percent(
    totals?.uniqueOpens ?? 0,
    totals?.peopleContacted ?? 0,
  )
  const interestedRate = percent(totals?.interested ?? 0, totals?.replies ?? 0)

  return (
    <AppShell>
      <div className="dash2">
        <div className="dash2__header">
          <div className="dash2__title">
            <h1>Main Dashboard</h1>
            <p>Full overview of your current workspace</p>
          </div>
          <select
            className="dash2__range"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {error && <div className="banner banner-error"><span>{error}</span></div>}

        {loading && !stats ? (
          <>
            <div className="kpi-grid">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="skeleton-card">
                  <div className="skeleton skeleton-text" style={{ width: '50%' }} />
                  <div className="skeleton skeleton-heading" style={{ width: '35%', marginTop: '0.75rem' }} />
                </div>
              ))}
            </div>
            <div className="chart-card">
              <div className="skeleton" style={{ height: 240, borderRadius: 8 }} />
            </div>
          </>
        ) : (
          <>
            <div className="kpi-grid">
              <KpiCard label="Emails sent" value={formatNumber(totals?.sent ?? 0)} />
              <KpiCard label="People contacted" value={formatNumber(totals?.peopleContacted ?? 0)} />
              <KpiCard label="Total opens" value={formatNumber(totals?.totalOpens ?? 0)} />
              <KpiCard
                label="Unique opens"
                value={formatNumber(totals?.uniqueOpens ?? 0)}
                badge={formatPercent(uniqueOpenRate)}
                badgeKind="muted"
              />
              <KpiCard
                label="Replies"
                value={formatNumber(totals?.replies ?? 0)}
                badge={formatPercent(replyRate)}
                badgeKind="good"
              />
              <KpiCard
                label="Bounced"
                value={formatNumber(totals?.bounced ?? 0)}
                badge={formatPercent(bounceRate)}
                badgeKind="bad"
              />
              <KpiCard
                label="Unsubscribed"
                value={formatNumber(totals?.unsubscribed ?? 0)}
                badge={formatPercent(unsubRate)}
                badgeKind="muted"
              />
              <KpiCard
                label="Interested"
                value={formatNumber(totals?.interested ?? 0)}
                badge={formatPercent(interestedRate)}
                badgeKind="good"
              />
            </div>

            <div className="chart-card">
              <DashboardChart data={series} />
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}

function KpiCard({
  label,
  value,
  badge,
  badgeKind = 'muted',
}: {
  label: string
  value: string
  badge?: string
  badgeKind?: 'good' | 'bad' | 'muted'
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-card__label">{label}</div>
      <div className="kpi-card__row">
        {badge && (
          <span className={`kpi-badge kpi-badge--${badgeKind}`}>{badge}</span>
        )}
        <span className="kpi-card__value">{value}</span>
      </div>
    </div>
  )
}
