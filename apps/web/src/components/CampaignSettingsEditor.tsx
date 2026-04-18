import { useState } from 'react'
import { updateCampaign, type CampaignView } from '../lib/campaigns'

type Props = { campaign: CampaignView; onSaved: () => void }

export function CampaignSettingsEditor({ campaign, onSaved }: Props) {
  const [name, setName] = useState(campaign.name)
  const [maxEmailsPerDay, setMaxEmailsPerDay] = useState(campaign.maxEmailsPerDay)
  const [maxNewLeadsPerDay, setMaxNewLeadsPerDay] = useState(
    campaign.maxNewLeadsPerDay,
  )
  const [plainText, setPlainText] = useState(campaign.plainText)
  // Open tracking is permanently disabled — cold-email deliverability over vanity metrics.
  const openTracking = false
  const [clickTracking, setClickTracking] = useState(campaign.clickTracking)
  const [canUnsubscribe, setCanUnsubscribe] = useState(campaign.canUnsubscribe)
  const [useLeadTimezone, setUseLeadTimezone] = useState(campaign.useLeadTimezone)
  const [skipHolidays, setSkipHolidays] = useState(campaign.skipHolidays)
  const [sequencePrioritization, setSequencePrioritization] = useState(
    campaign.sequencePrioritization,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSave() {
    setSaving(true)
    setError(null)
    try {
      await updateCampaign(campaign.id, {
        name,
        maxEmailsPerDay,
        maxNewLeadsPerDay,
        plainText,
        openTracking,
        clickTracking,
        canUnsubscribe,
        useLeadTimezone,
        skipHolidays,
        sequencePrioritization,
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Deliverability score: starts at 100, drops as user disables safeguards
  const score =
    100 -
    (plainText ? 0 : 15) -
    (clickTracking ? 20 : 0) -
    (canUnsubscribe ? 0 : 10) -
    (useLeadTimezone ? 0 : 5)

  return (
    <div className="settings-editor">
      <div className="settings-grid">
        <section className="auth-card">
          <h3 className="settings-section-title">Basics</h3>
          <label>
            <span>Campaign name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="form-row">
            <label>
              <span>Max emails / day</span>
              <input
                type="number"
                min={1}
                value={maxEmailsPerDay}
                onChange={(e) => setMaxEmailsPerDay(Number(e.target.value))}
              />
              <small>Hard cap on this campaign's daily volume</small>
            </label>
            <label>
              <span>Max new leads / day</span>
              <input
                type="number"
                min={1}
                value={maxNewLeadsPerDay}
                onChange={(e) => setMaxNewLeadsPerDay(Number(e.target.value))}
              />
              <small>Throttles enrollment ramp</small>
            </label>
          </div>
          <label>
            <span>When rate-limited, prioritize</span>
            <select
              value={sequencePrioritization}
              onChange={(e) =>
                setSequencePrioritization(
                  e.target.value as 'followups' | 'new_leads',
                )
              }
            >
              <option value="followups">Follow-ups first (recommended)</option>
              <option value="new_leads">New leads first</option>
            </select>
          </label>
        </section>

        <section className="auth-card">
          <h3 className="settings-section-title">
            Deliverability score:{' '}
            <span className={score >= 90 ? 'score-good' : score >= 70 ? 'score-warn' : 'score-bad'}>
              {score}/100
            </span>
          </h3>
          <p className="dim small">
            Each safeguard you turn off lowers your score and your inbox
            placement. The defaults are correct for cold email.
          </p>

          <Toggle
            label="Plain text"
            hint="HTML+images triggers Gmail promo tab. Recommended."
            value={plainText}
            onChange={setPlainText}
          />
          <Toggle
            label="Click tracking"
            hint="Link rewriting is the single biggest spam signal. Recommended OFF."
            value={clickTracking}
            onChange={setClickTracking}
          />
          <Toggle
            label="Unsubscribe link"
            hint="Required for Google's bulk-sender rules (Feb 2024)."
            value={canUnsubscribe}
            onChange={setCanUnsubscribe}
          />
          <Toggle
            label="Lead timezone matching"
            hint="Sends at the recipient's 9–11am, not yours. Recommended."
            value={useLeadTimezone}
            onChange={setUseLeadTimezone}
          />
          <Toggle
            label="Skip holidays"
            hint="US calendar by default."
            value={skipHolidays}
            onChange={setSkipHolidays}
          />
        </section>
      </div>

      <div className="settings-save-bar">
        <button
          type="button"
          className="btn-primary"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {error && <span className="inline-form__error">{error}</span>}
      </div>
    </div>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="setting-toggle">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="setting-toggle__main">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </label>
  )
}
