import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import {
  importLeads,
  parseCsvHeaders,
  type ColumnField,
  type ImportLeadsResponse,
} from '../lib/leads'
import {
  listCustomVariables,
  type CustomVariable,
} from '../lib/custom-variables'

type Step = 'upload' | 'map' | 'importing' | 'done'

const CUSTOM_VAR_SENTINEL = '__custom_var__' as const

const FIELD_OPTIONS: { value: ColumnField | '' | typeof CUSTOM_VAR_SENTINEL; label: string }[] = [
  { value: '', label: '— Skip —' },
  { value: 'email', label: 'Email *' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Title' },
  { value: 'phone', label: 'Phone' },
  { value: 'timezone', label: 'Timezone' },
  { value: CUSTOM_VAR_SENTINEL, label: 'Custom variable…' },
]

function sanitizeVarKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
}

const HEADER_HINTS: Record<string, ColumnField> = {
  email: 'email',
  'email address': 'email',
  'first name': 'first_name',
  firstname: 'first_name',
  fname: 'first_name',
  'last name': 'last_name',
  lastname: 'last_name',
  lname: 'last_name',
  company: 'company',
  organization: 'company',
  org: 'company',
  title: 'title',
  position: 'title',
  'job title': 'title',
  phone: 'phone',
  'phone number': 'phone',
  timezone: 'timezone',
  tz: 'timezone',
}

function autoMap(
  headers: string[],
  customVars: CustomVariable[],
): Record<number, ColumnField | null> {
  const m: Record<number, ColumnField | null> = {}
  const varKeys = new Set(customVars.map((v) => v.key))
  for (let i = 0; i < headers.length; i++) {
    const raw = headers[i]?.toLowerCase().trim() ?? ''
    if (HEADER_HINTS[raw]) {
      m[i] = HEADER_HINTS[raw] ?? null
      continue
    }
    // Match against user-defined custom variables using the same slugification
    // rule as the UI. "Pain Point" header + "pain_point" variable → auto-map.
    const slug = sanitizeVarKey(raw)
    if (slug && varKeys.has(slug)) {
      m[i] = `custom_var:${slug}` as ColumnField
      continue
    }
    m[i] = null
  }
  return m
}

export function LeadImportPage() {
  const navigate = useNavigate()

  const [step, setStep] = useState<Step>('upload')
  const [csvText, setCsvText] = useState('')
  const [hasHeader, setHasHeader] = useState(true)
  const [fileName, setFileName] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [preview, setPreview] = useState<string[][]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [mapping, setMapping] = useState<Record<number, ColumnField | null>>({})
  const [listName, setListName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportLeadsResponse | null>(null)
  const [customVars, setCustomVars] = useState<CustomVariable[]>([])

  useEffect(() => {
    listCustomVariables().then(setCustomVars).catch(() => {})
  }, [])

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setError('File is larger than 10 MB.')
      return
    }
    setFileName(file.name)
    setError(null)
    const text = await file.text()
    setCsvText(text)
  }

  async function onParse(e: FormEvent) {
    e.preventDefault()
    if (!csvText) {
      setError('Pick a file first.')
      return
    }
    setError(null)
    try {
      const result = await parseCsvHeaders(csvText)
      setHeaders(result.headers)
      setPreview(result.preview)
      setTotalRows(result.totalRows)
      setMapping(autoMap(result.headers, customVars))
      setStep('map')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse CSV')
    }
  }

  async function onImport() {
    setError(null)
    setStep('importing')
    try {
      const stringMapping: Record<string, ColumnField> = {}
      for (const [k, v] of Object.entries(mapping)) {
        stringMapping[k] = v
      }
      const result = await importLeads({
        csv: csvText,
        hasHeader,
        mapping: stringMapping,
        listName: listName.trim() || undefined,
      })
      setResult(result)
      setStep('done')
    } catch (e) {
      // Surface the server's error message (route returns { error, message })
      // so "500" becomes actionable. Falls back to a generic label otherwise.
      let msg: string = 'Import failed'
      if (e && typeof e === 'object' && 'payload' in e) {
        const payload = (e as { payload: unknown }).payload
        if (payload && typeof payload === 'object') {
          const p = payload as { error?: string; message?: string }
          msg = p.message || p.error || msg
        }
      } else if (e instanceof Error) {
        msg = e.message
      }
      setError(msg)
      setStep('map')
    }
  }

  const hasEmailMapped = Object.values(mapping).includes('email')

  return (
    <AppShell>
      <Link to="/leads" className="back-link">
        ← All leads
      </Link>

      <div className="page-head">
        <div>
          <h1>Import leads from CSV</h1>
          <p className="dashboard-sub">
            Upload a CSV, map your columns, and we'll dedupe by email.
          </p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
        </div>
      )}

      {step === 'upload' && (
        <form className="auth-card" style={{ maxWidth: 520 }} onSubmit={onParse}>
          <label>
            <span>CSV file</span>
            <input type="file" accept=".csv,text/csv" onChange={onFile} />
            {fileName && <small>{fileName}</small>}
          </label>
          <label className="inline-checkbox">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
            />
            <span>First row is a header</span>
          </label>
          <button type="submit" className="btn-primary" disabled={!csvText}>
            Continue
          </button>
        </form>
      )}

      {step === 'map' && (
        <>
          {(() => {
            const mappedCount = Object.values(mapping).filter((v) => v !== null).length
            return (
              <div className="banner banner-info">
                Detected <strong>{totalRows}</strong> data rows in {fileName}.{' '}
                <strong>{mappedCount}</strong> of {headers.length} columns mapped —
                unmapped columns are ignored on import.
              </div>
            )
          })()}

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                // Keep only the email mapping; skip all other columns so the
                // user can re-map just the variables they care about.
                const emailIdx = Object.entries(mapping).find(([, v]) => v === 'email')?.[0]
                const next: Record<number, ColumnField | null> = {}
                for (let i = 0; i < headers.length; i++) next[i] = null
                if (emailIdx !== undefined) next[Number(emailIdx)] = 'email'
                setMapping(next)
              }}
              title="Skip every column except email, then pick only the variables you want."
            >
              Clear to email only
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setMapping(autoMap(headers, customVars))}
              title="Re-run auto-detection"
            >
              Auto-map again
            </button>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>CSV column</th>
                <th>Maps to</th>
                <th>Sample values</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((h, i) => (
                <tr key={i}>
                  <td>
                    <strong>{h || `Column ${i + 1}`}</strong>
                  </td>
                  <td>
                    <ColumnMap
                      columnHeader={h}
                      value={mapping[i] ?? null}
                      customVars={customVars}
                      onChange={(v) => setMapping((m) => ({ ...m, [i]: v }))}
                    />
                  </td>
                  <td className="dim">
                    {preview
                      .slice(0, 3)
                      .map((row) => row[i])
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="auth-card" style={{ maxWidth: 520, marginTop: '1.5rem' }}>
            <label>
              <span>Add to a new lead list (optional)</span>
              <input
                type="text"
                placeholder="e.g. Q2 SaaS founders"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
              />
              <small>Leave blank to import without a list.</small>
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep('upload')}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!hasEmailMapped}
                onClick={onImport}
              >
                Import {totalRows} row{totalRows === 1 ? '' : 's'}
              </button>
            </div>
            {!hasEmailMapped && (
              <div className="inline-form__error">
                Map at least one column to <strong>Email</strong> to continue.
              </div>
            )}
          </div>
        </>
      )}

      {step === 'importing' && (
        <div className="empty-state">
          <h2>Importing…</h2>
          <p>
            Parsing, validating, and upserting up to {totalRows.toLocaleString()} rows.
          </p>
        </div>
      )}

      {step === 'done' && result && (
        <div className="empty-state">
          <h2>Done!</h2>
          <p>
            Imported <strong>{result.imported.toLocaleString()}</strong> leads from{' '}
            <strong>{result.parsed.toLocaleString()}</strong> parsed rows.
            {result.errors.length > 0 && (
              <>
                {' '}
                <span style={{ color: 'var(--error)' }}>
                  {result.errors.length} skipped
                </span>{' '}
                (see below).
              </>
            )}
          </p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => navigate('/leads')}
            >
              View leads
            </button>
            {result.listId && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigate(`/lead-lists/${result.listId}`)}
              >
                View list
              </button>
            )}
          </div>
          {result.errors.length > 0 && (
            <div style={{ marginTop: '2rem', textAlign: 'left' }}>
              <h3 style={{ fontSize: '0.875rem' }}>Skipped rows</h3>
              <ul className="error-list">
                {result.errors.slice(0, 50).map((e, i) => (
                  <li key={i}>
                    Row {e.rowIndex + (hasHeader ? 2 : 1)}: {e.reason}
                  </li>
                ))}
                {result.errors.length > 50 && (
                  <li>… and {result.errors.length - 50} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </AppShell>
  )
}

function ColumnMap({
  columnHeader,
  value,
  customVars,
  onChange,
}: {
  columnHeader: string
  value: ColumnField | null
  customVars: CustomVariable[]
  onChange: (v: ColumnField | null) => void
}) {
  const isCustomVar = typeof value === 'string' && value.startsWith('custom_var:')
  const currentCustomKey = isCustomVar ? (value as string).slice('custom_var:'.length) : ''
  const predefinedKeys = new Set(customVars.map((v) => v.key))
  // "Ad-hoc" = the user picked Custom variable… with a key that isn't in the
  // workspace-defined list. We show the text input so they can type one.
  const isAdHocCustomVar = isCustomVar && !predefinedKeys.has(currentCustomKey)

  const selectValue: string = isCustomVar
    ? predefinedKeys.has(currentCustomKey)
      ? (value as string) // the full "custom_var:<key>" string
      : CUSTOM_VAR_SENTINEL
    : value === null
      ? ''
      : value

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === CUSTOM_VAR_SENTINEL) {
            const seeded = sanitizeVarKey(columnHeader) || 'custom'
            onChange(`custom_var:${seeded}` as ColumnField)
          } else if (v === '') {
            onChange(null)
          } else if (v.startsWith('custom_var:')) {
            onChange(v as ColumnField)
          } else {
            onChange(v as ColumnField)
          }
        }}
      >
        {FIELD_OPTIONS.map((o) => (
          <option key={String(o.value)} value={String(o.value ?? '')}>
            {o.label}
          </option>
        ))}
        {customVars.length > 0 && (
          <optgroup label="Your custom variables">
            {customVars.map((cv) => (
              <option key={cv.id} value={`custom_var:${cv.key}`}>
                {`{{${cv.key}}}`}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {isAdHocCustomVar && (
        <input
          type="text"
          placeholder="variable name"
          value={currentCustomKey}
          onChange={(e) => {
            const key = sanitizeVarKey(e.target.value)
            onChange(`custom_var:${key || 'custom'}` as ColumnField)
          }}
          style={{ flex: 1, minWidth: 140 }}
          title="Use as {{name}} in your sequence body. Save it from the Custom Variables page to reuse across imports."
        />
      )}
    </div>
  )
}
