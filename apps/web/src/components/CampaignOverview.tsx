import type { CampaignView } from '../lib/campaigns'

export function CampaignOverview({ campaign }: { campaign: CampaignView }) {
  const requiredChecks = [
    { ok: campaign.stepCount > 0, label: 'Has sequence steps', hint: campaign.stepCount === 0 ? 'Add steps in the Sequence tab' : `${campaign.stepCount} steps configured` },
    { ok: campaign.senderCount > 0, label: 'Has at least one sender', hint: campaign.senderCount === 0 ? 'Attach mailboxes in the Senders tab' : `${campaign.senderCount} sender(s) attached` },
    { ok: campaign.leadCount > 0, label: 'Has at least one lead', hint: campaign.leadCount === 0 ? 'Add leads in the Leads tab' : `${campaign.leadCount.toLocaleString()} leads enrolled` },
  ]

  const optionalChecks = [
    { ok: campaign.plainText, label: 'Plain text mode', hint: 'HTML + images triggers Gmail promo tab' },
    { ok: !campaign.openTracking, label: 'Open tracking off', hint: 'Tracking pixels hurt deliverability' },
    { ok: !campaign.clickTracking, label: 'Click tracking off', hint: 'Link rewriting is the top spam signal' },
    { ok: campaign.canUnsubscribe, label: 'Unsubscribe enabled', hint: 'Required for Google bulk-sender rules' },
    { ok: campaign.useLeadTimezone, label: 'Lead-timezone matching', hint: 'Sends at the recipient\'s local time' },
  ]

  const requiredPassed = requiredChecks.filter((c) => c.ok).length
  const allRequiredPassed = requiredPassed === requiredChecks.length
  const optionalPassed = optionalChecks.filter((c) => c.ok).length

  return (
    <>
      <div className="detail-grid">
        <Tile
          label="Sequence steps"
          value={String(campaign.stepCount)}
          hint={
            campaign.stepCount === 0
              ? 'Add steps in the Sequence tab'
              : 'Default: day 0/3/7/14/21/30'
          }
        />
        <Tile
          label="Senders attached"
          value={String(campaign.senderCount)}
          hint={
            campaign.senderCount === 0
              ? 'Attach mailboxes in the Senders tab'
              : 'Sticky per lead routing'
          }
        />
        <Tile
          label="Leads enrolled"
          value={campaign.leadCount.toLocaleString()}
          hint={
            campaign.leadCount === 0
              ? 'Attach a list in the Leads tab'
              : `Max ${campaign.maxNewLeadsPerDay} new/day`
          }
        />
        <Tile
          label="Daily cap"
          value={campaign.maxEmailsPerDay.toLocaleString()}
          hint={`+${campaign.maxNewLeadsPerDay} new leads/day`}
        />
      </div>

      <h2 className="section-title">
        Launch checklist
        <span className={`checklist-progress ${allRequiredPassed ? 'checklist-progress--ready' : ''}`}>
          {requiredPassed}/{requiredChecks.length} required
        </span>
      </h2>

      <div className="checklist-section">
        <div className="checklist-section__label">Required</div>
        <ul className="checklist">
          {requiredChecks.map((c) => (
            <Check key={c.label} ok={c.ok} label={c.label} hint={c.hint} />
          ))}
        </ul>
      </div>

      <div className="checklist-section">
        <div className="checklist-section__label">Recommended ({optionalPassed}/{optionalChecks.length})</div>
        <ul className="checklist">
          {optionalChecks.map((c) => (
            <Check key={c.label} ok={c.ok} label={c.label} hint={c.hint} optional />
          ))}
        </ul>
      </div>
    </>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint && <span className="tile-hint">{hint}</span>}
    </div>
  )
}

function Check({
  ok,
  label,
  hint,
  optional,
}: {
  ok: boolean
  label: string
  hint?: string
  optional?: boolean
}) {
  let cls = 'checklist-item'
  if (ok) cls += ' checklist-item--ok'
  else if (!optional) cls += ' checklist-item--bad'
  else cls += ' checklist-item--warn'
  return (
    <li className={cls}>
      <span className="checklist-item__icon">{ok ? '\u2713' : optional ? '!' : '\u2715'}</span>
      <span className="checklist-item__content">
        <span>{label}</span>
        {hint && <small className="checklist-item__hint">{hint}</small>}
      </span>
    </li>
  )
}
