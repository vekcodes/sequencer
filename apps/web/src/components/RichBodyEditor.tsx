import { useEffect, useRef, useState } from 'react'
import type { CustomVariable } from '../lib/custom-variables'

// Gmail-style body editor for sequence variants.
//
// Canonical storage + wire format is plain text. Bold/italic/underline are
// visual affordances while composing — they're stripped on save because we
// send as text/plain for deliverability. Paragraph breaks, line breaks,
// bullet lists (→ "- "), numbered lists (→ "1. "), and variable tokens are
// preserved through save and send.

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
    for (const child of Array.from(el.childNodes)) walk(child, parentTag)
  }

  for (const child of Array.from(root.childNodes)) walk(child, null)
  return out
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\t ]+$/gm, '')
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
  // Sentinel — must not equal any real string so the first effect run after
  // mount always paints innerHTML, even when `value` is already populated
  // from a server fetch. Using `useRef(value)` here silently skipped the
  // initial paint and caused saved bodies to render blank, which led users
  // to overwrite them with partial edits.
  const lastValueRef = useRef<string | null>(null)
  const [showVarMenu, setShowVarMenu] = useState(false)
  const varWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editorRef.current) return
    if (value === lastValueRef.current) return
    editorRef.current.innerHTML = plainTextToHtml(value)
    lastValueRef.current = value
  }, [value])

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
    document.execCommand(command)
    emit()
  }

  function insertAtCursor(text: string) {
    if (disabled) return
    editorRef.current?.focus()
    document.execCommand('insertText', false, text)
    emit()
  }

  return (
    <div className="rich-editor">
      <div className="rich-editor__toolbar">
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
        <span className="rich-editor__divider" aria-hidden />
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
        <span className="rich-editor__divider" aria-hidden />
        <div ref={varWrapRef} className="rich-editor__var-wrap">
          <ToolbarButton
            label="Insert a variable"
            disabled={disabled}
            onClick={() => setShowVarMenu((s) => !s)}
          >
            {'{{ }} Variable ▾'}
          </ToolbarButton>
          {showVarMenu && (
            <div className="rich-editor__menu">
              <div className="rich-editor__menu-header">Built-in</div>
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
                  <div className="rich-editor__menu-header">Your custom variables</div>
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
              {customVariables.length === 0 && (
                <div className="rich-editor__menu-hint">
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
        className="rich-editor__canvas"
      />

      <div className="rich-editor__hint">
        Sent as plain text. Bold/italic are authoring aids — lists,
        paragraph breaks, and variables are preserved.
      </div>
    </div>
  )
}

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
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rich-editor__tool"
    >
      {children}
    </button>
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
      className="rich-editor__menu-item"
    >
      <code>{token}</code>
      {v.fallback && <small>fallback: {v.fallback}</small>}
    </button>
  )
}
