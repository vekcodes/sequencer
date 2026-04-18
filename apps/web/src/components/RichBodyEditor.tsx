import { useEffect, useRef, useState } from 'react'
import type { CustomVariable } from '../lib/custom-variables'

// A Gmail-style body editor for sequence variants.
//
// Tradeoff: the canonical storage + wire format is plain text (the sequence
// step variant body column). Bold/italic/list formatting is an authoring
// affordance — it's visible while composing but stripped on save, because we
// send real emails as text/plain for deliverability. The hint line below the
// canvas makes this contract explicit.
//
// What IS preserved through save → send:
//   - Paragraph structure (blank-line separated)
//   - Line breaks within paragraphs
//   - Bullet lists (rendered as "- " lines)
//   - Numbered lists (rendered as "1. " lines)
//   - Variable tokens ({{first_name}}, {{pain_point|fallback}})

type Props = {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  customVariables: CustomVariable[]
  placeholder?: string
}

const BUILT_IN_VARS: Array<{ key: string; fallback: string | null }> = [
  { key: 'first_name', fallback: 'there' },
  { key: 'last_name', fallback: null },
  { key: 'company', fallback: 'your team' },
  { key: 'title', fallback: null },
  { key: 'email', fallback: null },
]

// ─── Plain text ↔ HTML conversion ───────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Turns stored plain text into contentEditable HTML. Preserves paragraph
 * breaks (blank lines), intra-paragraph line breaks, and reconstructs
 * "- item" / "1. item" lines into <ul>/<ol> blocks so the author sees real
 * list formatting instead of the raw markers.
 */
function plainTextToHtml(text: string): string {
  if (!text) return ''
  const blocks = text.split(/\n\n+/)
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*-\s+/.test(l))) {
        return `<ul>${lines
          .map((l) => `<li>${escapeHtml(l.replace(/^\s*-\s+/, ''))}</li>`)
          .join('')}</ul>`
      }
      if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        return `<ol>${lines
          .map((l) => `<li>${escapeHtml(l.replace(/^\s*\d+\.\s+/, ''))}</li>`)
          .join('')}</ol>`
      }
      const joined = lines.map(escapeHtml).join('<br>')
      return `<p>${joined || '<br>'}</p>`
    })
    .join('')
}

/**
 * Serializes the contentEditable DOM back to plain text. Bold/italic tags are
 * unwrapped (text is kept, markers aren't emitted). Lists render as "- " / "1. "
 * prefixed lines. Paragraphs are separated by blank lines.
 */
function htmlToPlainText(root: HTMLElement): string {
  const out: string[] = []
  let listCounter = 0

  function walk(node: Node, parentTag: string | null): void {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()

    if (tag === 'br') {
      out.push('\n')
      return
    }
    if (tag === 'p' || tag === 'div') {
      for (const child of Array.from(el.childNodes)) walk(child, tag)
      out.push('\n\n')
      return
    }
    if (tag === 'ul') {
      for (const child of Array.from(el.childNodes)) walk(child, 'ul')
      out.push('\n')
      return
    }
    if (tag === 'ol') {
      listCounter = 0
      for (const child of Array.from(el.childNodes)) walk(child, 'ol')
      out.push('\n')
      return
    }
    if (tag === 'li') {
      if (parentTag === 'ol') {
        listCounter += 1
        out.push(`${listCounter}. `)
      } else {
        out.push('- ')
      }
      for (const child of Array.from(el.childNodes)) walk(child, parentTag)
      out.push('\n')
      return
    }
    // span/strong/em/b/i/u/a/code: just traverse children, dropping formatting
    for (const child of Array.from(el.childNodes)) walk(child, parentTag)
  }

  for (const child of Array.from(root.childNodes)) walk(child, null)
  return out
    .join('')
    .replace(/\u00a0/g, ' ') // NBSP → space
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // collapse excess blank lines
    .replace(/[\t ]+$/gm, '') // strip trailing whitespace per line
    .trim()
}

// ─── Component ──────────────────────────────────────────────────────────────

export function RichBodyEditor({
  value,
  onChange,
  disabled,
  customVariables,
  placeholder,
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const lastValueRef = useRef(value)
  const [showVarMenu, setShowVarMenu] = useState(false)
  const varWrapRef = useRef<HTMLDivElement>(null)

  // Initial mount + external value sync (only if parent state genuinely
  // differs from what we just emitted — avoids fighting the user's cursor).
  useEffect(() => {
    if (!editorRef.current) return
    if (value === lastValueRef.current) return
    editorRef.current.innerHTML = plainTextToHtml(value)
    lastValueRef.current = value
  }, [value])

  // Close variable menu on outside click
  useEffect(() => {
    if (!showVarMenu) return
    function onDocClick(e: MouseEvent) {
      if (varWrapRef.current && !varWrapRef.current.contains(e.target as Node)) {
        setShowVarMenu(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showVarMenu])

  function emit() {
    if (!editorRef.current) return
    const plain = htmlToPlainText(editorRef.current)
    lastValueRef.current = plain
    onChange(plain)
  }

  function runCommand(command: string) {
    if (disabled) return
    editorRef.current?.focus()
    // execCommand is deprecated but universally supported and keeps this
    // component dependency-free. Fine for bold/italic/list toggles.
    document.execCommand(command)
    emit()
  }

  function insertAtCursor(text: string) {
    if (disabled) return
    editorRef.current?.focus()
    // insertText preserves the current caret and selection semantics.
    document.execCommand('insertText', false, text)
    emit()
  }

  const allVars = [
    ...BUILT_IN_VARS,
    ...customVariables.map((v) => ({ key: v.key, fallback: v.fallbackDefault })),
  ]

  return (
    <div
      style={{
        border: '1px solid var(--border, #ddd)',
        borderRadius: 6,
        background: 'var(--bg-card, #fff)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 200,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 8px',
          borderBottom: '1px solid var(--border, #eee)',
          flexWrap: 'wrap',
        }}
      >
        <ToolbarButton
          label="Bold (Ctrl+B)"
          disabled={disabled}
          onClick={() => runCommand('bold')}
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          label="Italic (Ctrl+I)"
          disabled={disabled}
          onClick={() => runCommand('italic')}
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          disabled={disabled}
          onClick={() => runCommand('underline')}
        >
          <span style={{ textDecoration: 'underline' }}>U</span>
        </ToolbarButton>
        <Divider />
        <ToolbarButton
          label="Bullet list"
          disabled={disabled}
          onClick={() => runCommand('insertUnorderedList')}
        >
          •&nbsp;List
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          disabled={disabled}
          onClick={() => runCommand('insertOrderedList')}
        >
          1.&nbsp;List
        </ToolbarButton>
        <Divider />
        <div ref={varWrapRef} style={{ position: 'relative' }}>
          <ToolbarButton
            label="Insert a variable"
            disabled={disabled}
            onClick={() => setShowVarMenu((s) => !s)}
          >
            {'{{ }} Variable ▾'}
          </ToolbarButton>
          {showVarMenu && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                minWidth: 260,
                maxHeight: 320,
                overflowY: 'auto',
                background: 'var(--bg, #fff)',
                border: '1px solid var(--border, #ddd)',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                zIndex: 20,
                padding: 4,
              }}
            >
              <MenuHeader>Built-in</MenuHeader>
              {BUILT_IN_VARS.map((v) => (
                <VarMenuItem
                  key={v.key}
                  var={v}
                  onPick={(token) => {
                    insertAtCursor(token)
                    setShowVarMenu(false)
                  }}
                />
              ))}
              {customVariables.length > 0 && (
                <>
                  <MenuHeader>Your custom variables</MenuHeader>
                  {customVariables.map((cv) => (
                    <VarMenuItem
                      key={cv.id}
                      var={{ key: cv.key, fallback: cv.fallbackDefault }}
                      onPick={(token) => {
                        insertAtCursor(token)
                        setShowVarMenu(false)
                      }}
                    />
                  ))}
                </>
              )}
              {customVariables.length === 0 && allVars.length === BUILT_IN_VARS.length && (
                <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-dim)' }}>
                  Define workspace variables on the Custom Variables page to
                  reuse them here.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        data-placeholder={placeholder ?? 'Write your email…'}
        style={{
          padding: '12px 14px',
          minHeight: 180,
          outline: 'none',
          fontFamily: 'inherit',
          fontSize: '0.95rem',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      />

      <div
        style={{
          padding: '6px 10px',
          borderTop: '1px solid var(--border, #eee)',
          fontSize: 11,
          color: 'var(--text-dim, #666)',
        }}
      >
        Sent as plain text. Bold/italic are authoring aids — lists,
        paragraph breaks, and variables are preserved.
      </div>
    </div>
  )
}

// ─── Small building blocks ──────────────────────────────────────────────────

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep caret in the canvas
      onClick={onClick}
      style={{
        background: 'transparent',
        border: '1px solid transparent',
        padding: '4px 8px',
        fontSize: 13,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

function Divider() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 1,
        height: 18,
        background: 'var(--border, #ddd)',
        margin: '0 4px',
      }}
    />
  )
}

function MenuHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '6px 10px 2px',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: 'var(--text-dim, #666)',
      }}
    >
      {children}
    </div>
  )
}

function VarMenuItem({
  var: v,
  onPick,
}: {
  var: { key: string; fallback: string | null }
  onPick: (token: string) => void
}) {
  const token = v.fallback ? `{{${v.key}|${v.fallback}}}` : `{{${v.key}}}`
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(token)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        width: '100%',
        padding: '6px 10px',
        background: 'transparent',
        border: 0,
        borderRadius: 4,
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-muted, #f4f4f5)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <code style={{ fontSize: 12 }}>{token}</code>
      {v.fallback && (
        <small style={{ color: 'var(--text-dim, #888)' }}>
          fallback: {v.fallback}
        </small>
      )}
    </button>
  )
}
