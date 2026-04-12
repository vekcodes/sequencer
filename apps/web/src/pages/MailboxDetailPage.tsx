import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  deleteMailbox,
  getHealthHistory,
  getMailbox,
  pauseMailbox,
  recomputeMailboxHealth,
  resumeMailbox,
  type MailboxHealthSnapshot,
  type MailboxView,
} from '../lib/mailboxes'
import { Sparkline } from '../components/Sparkline'

export function MailboxDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [mailbox, setMailbox] = useState<MailboxView | null>(null)
  const [history, setHistory] = useState<MailboxHealthSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recomputing, setRecomputing] = useState(false)

  const welcome = params.get('welcome') === '1'

  const refresh = useCallback(async () => {
    if (!id) return
    const numId = Number(id)
    const [m, h] = await Promise.all([
      getMailbox(numId),
      getHealthHistory(numId, 30).catch(() => [] as MailboxHealthSnapshot[]),
    ])
    setMailbox(m)
    setHistory(h)
  }, [id])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh()
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [refresh])

  async function onRecompute() {
    if (!mailbox) return
    setRecomputing(true)
    try {
      await recomputeMailboxHealth(mailbox.id)
      await refresh()
    } finally {
      setRecomputing(false)
    }
  }

  async function onPause() {
    if (!mailbox) return
    setBusy(true)
    try {
      const updated = await pauseMailbox(mailbox.id)
      setMailbox(updated)
    } finally {
      setBusy(false)
    }
  }
  async function onResume() {
    if (!mailbox) return
    setBusy(true)
    try {
      const updated = await resumeMailbox(mailbox.id)
      setMailbox(updated)
    } finally {
      setBusy(false)
    }
  }
  async function onDelete() {
    if (!mailbox) return
    if (!confirm(`Disconnect ${mailbox.email}? This cannot be undone.`)) return
    setBusy(true)
    try {
      await deleteMailbox(mailbox.id)
      navigate('/mailboxes', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell>
      <Link to="/mailboxes" className="back-link">
        &larr; All mailboxes
      </Link>

      {welcome && mailbox && (
        <div className="banner banner-success">
          Connected <strong>{mailbox.email}</strong>. It's in the Ramping pool —
          we'll grow its daily cap as deliverability stays clean.
        </div>
      )}

      {loading && (
        <div className="detail-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton skeleton-text" style={{ width: '50%' }} />
              <div className="skeleton skeleton-heading" style={{ width: '30%' }} />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {!loading && mailbox && (
        <>
          <div className="page-head">
            <div>
              <h1>{mailbox.email}</h1>
              <p className="dashboard-sub">
                {mailbox.displayName ?? '—'} &middot; {mailbox.provider} &middot;{' '}
                <PoolBadge pool={mailbox.pool} />{' '}
                <StatusBadge status={mailbox.healthStatus} />
              </p>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={recomputing}
                onClick={onRecompute}
                title="Re-run the mailbox health worker for this mailbox"
              >
                {recomputing ? 'Recomputing...' : 'Recompute'}
              </button>
              {mailbox.healthStatus === 'paused' ? (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={onResume}
                >
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={onPause}
                >
                  Pause
                </button>
              )}
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={onDelete}
              >
                Disconnect
              </button>
            </div>
          </div>

          {mailbox.pauseReason && (
            <div className="banner banner-warn">
              Paused: {mailbox.pauseReason}
            </div>
          )}

          <div className="detail-grid">
            <Tile label="Health score" value={`${mailbox.healthScore}/100`} />
            <Tile
              label="Daily cap"
              value={`${mailbox.dailyLimitCurrent} / ${mailbox.dailyLimitTarget}`}
              hint="Today's allowance vs. target after ramp"
            />
            <Tile
              label="Bounce rate (30d)"
              value={fmtBps(mailbox.bounceRate30dBps)}
              hint="Triggers a brake at 2.00%"
            />
            <Tile
              label="Spam complaints (30d)"
              value={fmtBps(mailbox.spamComplaintRate30dBps)}
              hint="Hard ceiling at 0.30%"
            />
          </div>

          <h2 className="section-title">Health score (last 30 days)</h2>
          <div className="sparkline-card">
            <Sparkline
              values={history.map((s) => s.healthScore)}
              dates={history.map((s) => s.date)}
              yMin={50}
            />
            <div className="sparkline-legend">
              <span className="sparkline-legend__dot sparkline-legend__dot--line" />
              Health score
              <span className="sparkline-legend__dot sparkline-legend__dot--floor" />
              Floor (85 — auto-rest below this)
            </div>
          </div>

          <h2 className="section-title">Authentication</h2>
          <div className="dns-grid">
            <DnsCheck label="SPF" ok={mailbox.spfOk} />
            <DnsCheck label="DKIM" ok={mailbox.dkimOk} />
            <DnsCheck label="DMARC" ok={mailbox.dmarcOk} />
            <DnsCheck label="MX" ok={mailbox.mxOk} />
          </div>

          <p className="dashboard-sub">
            Connected{' '}
            {new Date(mailbox.createdAt).toLocaleString()} &middot; ramp started{' '}
            {new Date(mailbox.rampStartedAt).toLocaleString()}
          </p>
        </>
      )}
    </AppShell>
  )
}

function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

function PoolBadge({ pool }: { pool: MailboxView['pool'] }) {
  return <span className={`badge badge--pool-${pool}`}>{pool}</span>
}

function StatusBadge({ status }: { status: MailboxView['healthStatus'] }) {
  return <span className={`badge badge--${status}`}>{status}</span>
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint && <span className="tile-hint">{hint}</span>}
    </div>
  )
}

function DnsCheck({ label, ok }: { label: string; ok: boolean | null }) {
  let cls = 'dns-check'
  let icon = '?'
  let text = 'Not checked'
  if (ok === true) {
    cls += ' dns-check--ok'
    icon = '\u2713'
    text = 'Configured'
  } else if (ok === false) {
    cls += ' dns-check--bad'
    icon = '\u2715'
    text = 'Missing'
  }
  return (
    <div className={cls}>
      <span className="dns-check__icon">{icon}</span>
      <div>
        <div className="dns-check__label">{label}</div>
        <div className="dns-check__text">{text}</div>
      </div>
    </div>
  )
}
