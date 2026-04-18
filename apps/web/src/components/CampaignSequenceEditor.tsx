import { useEffect, useState } from 'react'
import {
  getCampaignSequence,
  putCampaignSequence,
  type SequenceStep,
  type SequenceStepVariant,
} from '../lib/campaigns'
import { ApiError } from '../lib/api'
import { render, SAMPLE_LEAD_VARS } from '../lib/render'
import { listCustomVariables, type CustomVariable } from '../lib/custom-variables'
import { RichBodyEditor } from './RichBodyEditor'

type Props = {
  campaignId: number
  campaignStatus: string
  onSaved: () => void
}

const VARIABLE_HINTS = [
  '{{first_name|there}}',
  '{{last_name}}',
  '{{company|your team}}',
  '{{title}}',
  '{{email}}',
]

export function CampaignSequenceEditor({ campaignId, campaignStatus, onSaved }: Props) {
  const locked = campaignStatus === 'active'

  const [steps, setSteps] = useState<SequenceStep[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [previewStepIdx, setPreviewStepIdx] = useState(0)
  const [previewVariantIdx, setPreviewVariantIdx] = useState(0)
  const [customVariables, setCustomVariables] = useState<CustomVariable[]>([])

  useEffect(() => {
    listCustomVariables().then(setCustomVariables).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getCampaignSequence(campaignId)
      .then((s) => {
        if (!cancelled) {
          setSteps(s)
          setDirty(false)
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [campaignId])

  function updateStep(idx: number, patch: Partial<SequenceStep>) {
    setSteps((prev) => {
      const next = [...prev]
      const cur = next[idx]
      if (!cur) return prev
      next[idx] = { ...cur, ...patch }
      return next
    })
    setDirty(true)
  }

  function updateVariant(stepIdx: number, varIdx: number, patch: Partial<SequenceStepVariant>) {
    setSteps((prev) => {
      const next = [...prev]
      const cur = next[stepIdx]
      if (!cur) return prev
      const variants = [...cur.variants]
      const v = variants[varIdx]
      if (!v) return prev
      variants[varIdx] = { ...v, ...patch }
      next[stepIdx] = { ...cur, variants }
      return next
    })
    setDirty(true)
  }

  function addStep() {
    const lastOrder = steps.length === 0 ? 0 : (steps[steps.length - 1]?.order ?? 0)
    setSteps((prev) => [
      ...prev,
      {
        order: lastOrder + 1,
        waitInBusinessDays: 3,
        threadReply: true,
        stopOnReply: true,
        variants: [{ weight: 100, subject: '', body: '' }],
      },
    ])
    setDirty(true)
  }

  function removeStep(idx: number) {
    setSteps((prev) => {
      const next = prev.filter((_, i) => i !== idx)
      // Renumber order to stay sequential
      return next.map((s, i) => ({ ...s, order: i + 1 }))
    })
    setDirty(true)
    if (previewStepIdx >= steps.length - 1) setPreviewStepIdx(0)
  }

  function moveStep(idx: number, dir: -1 | 1) {
    const target = idx + dir
    if (target < 0 || target >= steps.length) return
    setSteps((prev) => {
      const next = [...prev]
      const a = next[idx]!
      const b = next[target]!
      next[idx] = b
      next[target] = a
      return next.map((s, i) => ({ ...s, order: i + 1 }))
    })
    setDirty(true)
  }

  function addVariant(stepIdx: number) {
    setSteps((prev) => {
      const next = [...prev]
      const cur = next[stepIdx]
      if (!cur) return prev
      next[stepIdx] = {
        ...cur,
        variants: [...cur.variants, { weight: 50, subject: '', body: '' }],
      }
      return next
    })
    setDirty(true)
  }

  function removeVariant(stepIdx: number, varIdx: number) {
    setSteps((prev) => {
      const next = [...prev]
      const cur = next[stepIdx]
      if (!cur || cur.variants.length <= 1) return prev
      next[stepIdx] = {
        ...cur,
        variants: cur.variants.filter((_, i) => i !== varIdx),
      }
      return next
    })
    setDirty(true)
  }

  async function onSave() {
    setSaving(true)
    setError(null)
    try {
      const saved = await putCampaignSequence(campaignId, steps)
      setSteps(saved)
      setDirty(false)
      onSaved()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError('Cannot edit sequence on an active campaign — pause it first.')
      } else {
        setError(e instanceof Error ? e.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="dashboard-sub">Loading sequence…</p>

  const previewStep = steps[previewStepIdx]
  const previewVariant = previewStep?.variants[previewVariantIdx]

  return (
    <div className="sequence-editor">
      {locked && (
        <div className="banner banner-warn">
          The campaign is active. Pause it to edit the sequence.
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      <div className="sequence-editor__layout">
        <div className="sequence-editor__steps">
          {steps.map((step, stepIdx) => (
            <div className="seq-step" key={stepIdx}>
              <div className="seq-step__head">
                <strong>Step {step.order}</strong>
                <div className="seq-step__head-actions">
                  <button
                    type="button"
                    className="row-action"
                    disabled={locked || stepIdx === 0}
                    onClick={() => moveStep(stepIdx, -1)}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    disabled={locked || stepIdx === steps.length - 1}
                    onClick={() => moveStep(stepIdx, 1)}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    disabled={locked}
                    onClick={() => removeStep(stepIdx)}
                    title="Delete step"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="seq-step__meta">
                <label>
                  <span>Wait (business days)</span>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    disabled={locked}
                    value={step.waitInBusinessDays}
                    onChange={(e) =>
                      updateStep(stepIdx, {
                        waitInBusinessDays: Math.max(0, Number(e.target.value)),
                      })
                    }
                  />
                </label>
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={step.threadReply}
                    onChange={(e) =>
                      updateStep(stepIdx, { threadReply: e.target.checked })
                    }
                  />
                  <span>Thread reply (sends as Re: of previous)</span>
                </label>
              </div>

              {step.variants.map((variant, varIdx) => (
                <div className="seq-variant" key={varIdx}>
                  <div className="seq-variant__head">
                    <span className="seq-variant__label">
                      {step.variants.length > 1
                        ? `Variant ${String.fromCharCode(65 + varIdx)}`
                        : 'Email'}
                    </span>
                    {step.variants.length > 1 && (
                      <>
                        <label className="inline-weight">
                          <span>Weight</span>
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            disabled={locked}
                            value={variant.weight}
                            onChange={(e) =>
                              updateVariant(stepIdx, varIdx, {
                                weight: Math.max(1, Number(e.target.value)),
                              })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="row-action"
                          disabled={locked}
                          onClick={() => removeVariant(stepIdx, varIdx)}
                        >
                          ✕
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="seq-variant__preview-btn"
                      onClick={() => {
                        setPreviewStepIdx(stepIdx)
                        setPreviewVariantIdx(varIdx)
                      }}
                    >
                      Preview →
                    </button>
                  </div>

                  {step.threadReply && stepIdx > 0 ? (
                    <div className="seq-variant__threaded">
                      Subject inherited from step 1 (sent as <code>Re:</code>)
                    </div>
                  ) : (
                    <input
                      type="text"
                      className="seq-variant__subject"
                      placeholder="Subject"
                      disabled={locked}
                      value={variant.subject}
                      onChange={(e) =>
                        updateVariant(stepIdx, varIdx, { subject: e.target.value })
                      }
                    />
                  )}
                  <RichBodyEditor
                    value={variant.body}
                    disabled={locked}
                    customVariables={customVariables}
                    placeholder="Write your email. Supports {{first_name|there}}, {{company}}, and spintax {Hi|Hey|Hello}."
                    onChange={(next) =>
                      updateVariant(stepIdx, varIdx, { body: next })
                    }
                  />
                </div>
              ))}

              <button
                type="button"
                className="btn-secondary seq-step__add-variant"
                disabled={locked}
                onClick={() => addVariant(stepIdx)}
              >
                + Add A/B variant
              </button>
            </div>
          ))}

          <button
            type="button"
            className="btn-secondary seq-add-step"
            disabled={locked}
            onClick={addStep}
          >
            + Add step
          </button>

          <div className="seq-save-bar">
            <button
              type="button"
              className="btn-primary"
              disabled={locked || !dirty || saving}
              onClick={onSave}
            >
              {saving ? 'Saving…' : dirty ? 'Save sequence' : 'Saved'}
            </button>
          </div>
        </div>

        <aside className="sequence-editor__preview">
          <h3>Live preview</h3>
          <p className="dim">
            Rendered as <strong>Alex Chen</strong> (Acme Inc, VP of Sales).
          </p>
          {previewStep && previewVariant ? (
            <Preview
              subject={previewVariant.subject}
              body={previewVariant.body}
              threaded={previewStep.threadReply && previewStepIdx > 0}
            />
          ) : (
            <p className="dim">Add a step to preview.</p>
          )}

          <h4 className="preview-section">Variables you can use</h4>
          <ul className="variable-hints">
            {VARIABLE_HINTS.map((v) => (
              <li key={v}>
                <code>{v}</code>
              </li>
            ))}
            {customVariables.map((cv) => (
              <li key={cv.id}>
                <code>
                  {cv.fallbackDefault
                    ? `{{${cv.key}|${cv.fallbackDefault}}}`
                    : `{{${cv.key}}}`}
                </code>
              </li>
            ))}
          </ul>
          <h4 className="preview-section">Spintax</h4>
          <p className="dim small">
            Wrap alternates in curly braces:{' '}
            <code>{'{Hi|Hey|Hello}'}</code> rotates per send.
          </p>
        </aside>
      </div>
    </div>
  )
}

// ─── Preview rendering ──────────────────────────────────────────────────────

function Preview({
  subject,
  body,
  threaded,
}: {
  subject: string
  body: string
  threaded: boolean
}) {
  const subjectRender = render(subject, SAMPLE_LEAD_VARS, 0)
  const bodyRender = render(body, SAMPLE_LEAD_VARS, 0)

  return (
    <div className="preview-card">
      <div className="preview-card__from">
        <span className="dim small">From:</span>
        <strong>You</strong>
        <span className="dim small">to {SAMPLE_LEAD_VARS.email}</span>
      </div>
      <div className="preview-card__subject">
        {threaded ? (
          <em className="dim">Re: (inherited)</em>
        ) : (
          <strong>{subjectRender.rendered || <em className="dim">No subject</em>}</strong>
        )}
      </div>
      {(subjectRender.unresolved.length > 0 ||
        bodyRender.unresolved.length > 0) && (
        <div className="preview-card__warn">
          Unresolved variables:{' '}
          {[...subjectRender.unresolved, ...bodyRender.unresolved]
            .map((v) => `{{${v}}}`)
            .join(', ')}
        </div>
      )}
      <pre className="preview-card__body">
        {bodyRender.rendered || <em className="dim">No body</em>}
      </pre>
    </div>
  )
}
