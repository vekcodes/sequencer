import { useEffect, useState } from 'react'
import {
  getCampaignSchedule,
  putCampaignSchedule,
  type CampaignSchedule,
} from '../lib/campaigns'

const DAYS: Array<{ key: keyof CampaignSchedule; label: string }> = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
]

const TIMEZONES = [
  { value: 'America/New_York', label: 'US Eastern (EST/EDT)' },
  { value: 'Europe/London', label: 'UK / London (GMT/BST)' },
]

export function CampaignScheduleEditor({ campaignId }: { campaignId: number }) {
  const [schedule, setSchedule] = useState<CampaignSchedule | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getCampaignSchedule(campaignId)
      .then((s) => !cancelled && setSchedule(s))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [campaignId])

  function patch(p: Partial<CampaignSchedule>) {
    if (!schedule) return
    setSchedule({ ...schedule, ...p })
    setDirty(true)
  }

  async function onSave() {
    if (!schedule) return
    setSaving(true)
    try {
      const saved = await putCampaignSchedule(campaignId, schedule)
      setSchedule(saved)
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="dashboard-sub">Loading schedule…</p>
  if (!schedule) return <p>{error ?? 'No schedule'}</p>

  return (
    <div className="schedule-editor">
      <div className="auth-card" style={{ maxWidth: 640 }}>
        <label>
          <span>Sending days</span>
          <div className="day-toggles">
            {DAYS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={
                  schedule[d.key]
                    ? 'day-toggle day-toggle--on'
                    : 'day-toggle'
                }
                onClick={() => patch({ [d.key]: !schedule[d.key] } as Partial<CampaignSchedule>)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </label>

        <div className="form-row">
          <label>
            <span>Start time</span>
            <input
              type="time"
              value={schedule.startTime}
              onChange={(e) => patch({ startTime: e.target.value })}
            />
          </label>
          <label>
            <span>End time</span>
            <input
              type="time"
              value={schedule.endTime}
              onChange={(e) => patch({ endTime: e.target.value })}
            />
          </label>
        </div>

        <label>
          <span>Timezone</span>
          <select
            value={schedule.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          <small>
            Emails send during the window above in this timezone.
            If "Use lead timezone" is on (Settings tab), this is the fallback
            for leads with no timezone set.
          </small>
        </label>

        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || saving}
          onClick={onSave}
        >
          {saving ? 'Saving…' : dirty ? 'Save schedule' : 'Saved'}
        </button>

        {error && <div className="inline-form__error">{error}</div>}
      </div>
    </div>
  )
}
