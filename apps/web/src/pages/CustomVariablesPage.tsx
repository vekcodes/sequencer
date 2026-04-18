import { useEffect, useState, type FormEvent } from 'react'
import { AppShell } from '../components/AppShell'
import {
  createCustomVariable,
  deleteCustomVariable,
  listCustomVariables,
  updateCustomVariable,
  type CustomVariable,
} from '../lib/custom-variables'
import { ApiError } from '../lib/api'

export function CustomVariablesPage() {
  const [rows, setRows] = useState<CustomVariable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newFallback, setNewFallback] = useState('')
  const [creating, setCreating] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setRows(await listCustomVariables())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    if (!newKey.trim()) return
    setCreating(true)
    setError(null)
    try {
      await createCustomVariable({
        key: newKey.trim(),
        fallbackDefault: newFallback.trim() || null,
      })
      setNewKey('')
      setNewFallback('')
      setShowAdd(false)
      await refresh()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(`"${newKey}" already exists`)
      } else {
        setError(e instanceof Error ? e.message : 'Create failed')
      }
    } finally {
      setCreating(false)
    }
  }

  async function onDelete(v: CustomVariable) {
    if (
      !confirm(
        `Delete variable "{{${v.key}}}"?\n\nExisting lead values are kept (they're stored per-lead in JSON). Only this workspace definition is removed.`,
      )
    )
      return
    try {
      await deleteCustomVariable(v.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  async function onUpdateFallback(v: CustomVariable, fallback: string) {
    const next = fallback.trim() || null
    if (next === v.fallbackDefault) return
    try {
      const updated = await updateCustomVariable(v.id, { fallbackDefault: next })
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  return (
    <AppShell>
      <div className="page-head">
        <div>
          <h1>Custom variables</h1>
          <p className="dashboard-sub">
            Define workspace-wide variables you can reference in email bodies
            as <code>{'{{variable_name}}'}</code>. Map a CSV column to a variable
            on import, or set one per-lead on the Leads page.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setShowAdd((s) => !s)}
        >
          {showAdd ? 'Cancel' : '+ New variable'}
        </button>
      </div>

      {showAdd && (
        <form
          className="auth-card"
          style={{ maxWidth: 560 }}
          onSubmit={onCreate}
        >
          <label>
            <span>Variable name</span>
            <input
              type="text"
              placeholder="e.g. pain_point"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              required
            />
            <small>
              Letters, numbers, spaces, hyphens and underscores. Stored as a
              slug — "Pain Point" becomes <code>pain_point</code>.
            </small>
          </label>
          <label>
            <span>Fallback default (optional)</span>
            <input
              type="text"
              placeholder="e.g. your team's workflow"
              value={newFallback}
              onChange={(e) => setNewFallback(e.target.value)}
            />
            <small>
              Shown in email bodies when a lead doesn't have a value for this
              variable. You can also override per-step with{' '}
              <code>{'{{name|fallback}}'}</code>.
            </small>
          </label>
          <div className="actions">
            <button type="submit" className="btn-primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {loading && <p className="dashboard-sub">Loading…</p>}

      {!loading && rows.length === 0 && (
        <div className="empty-state">
          <h2>No custom variables yet</h2>
          <p>
            Create one, then map CSV columns to it during lead import, or set
            values per-lead. Reference it in your sequences as{' '}
            <code>{'{{name}}'}</code>.
          </p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Fallback default</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <td>
                  <code>{`{{${v.key}}}`}</code>
                </td>
                <td>
                  <FallbackCell
                    value={v.fallbackDefault ?? ''}
                    onSave={(next) => onUpdateFallback(v, next)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="row-action"
                    onClick={() => onDelete(v)}
                    title="Delete variable definition"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppShell>
  )
}

function FallbackCell({
  value,
  onSave,
}: {
  value: string
  onSave: (next: string) => Promise<void> | void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <input
      type="text"
      value={draft}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onSave(draft)
      }}
      style={{ width: '100%', background: 'transparent' }}
    />
  )
}
