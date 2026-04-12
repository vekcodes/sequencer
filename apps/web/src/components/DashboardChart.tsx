import { useMemo, useState } from 'react'

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

type SeriesKey = keyof Omit<SeriesPoint, 'date'>

const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: 'uniqueOpens', label: 'Unique Opens', color: '#3b82f6' },
  { key: 'unsubscribed', label: 'Unsubscribed', color: '#10b981' },
  { key: 'bounced',     label: 'Bounced',      color: '#6366f1' },
  { key: 'interested',  label: 'Interested',   color: '#ec4899' },
  { key: 'sent',        label: 'Sent',         color: '#06b6d4' },
  { key: 'totalOpens',  label: 'Total Opens',  color: '#22c55e' },
  { key: 'replied',     label: 'Replied',      color: '#8b5cf6' },
]

/**
 * Smoothed multi-series area chart for the dashboard.
 *
 * Hand-rolled SVG (no chart lib) so the web bundle stays light. Uses a
 * catmull-rom-ish smoothing so the curves match the reference screenshot.
 * Hovering reveals a value-per-series tooltip aligned to the closest point.
 */
export function DashboardChart({ data }: { data: SeriesPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const width = 1100
  const height = 380
  const padT = 20
  const padR = 20
  const padB = 40
  const padL = 50

  const innerW = width - padL - padR
  const innerH = height - padT - padB

  const yMax = useMemo(() => {
    let max = 0
    for (const p of data) {
      for (const s of SERIES) {
        if (p[s.key] > max) max = p[s.key]
      }
    }
    // Round up to next 500 for a clean axis, min scale 100.
    const target = Math.max(100, Math.ceil(max / 500) * 500)
    return target
  }, [data])

  if (data.length === 0) {
    return <div className="chart-empty">No activity yet.</div>
  }

  const xFor = (i: number) =>
    padL + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW)
  const yFor = (v: number) => padT + innerH - (v / yMax) * innerH

  // Smooth path using a simple catmull-rom-to-bezier conversion.
  function smoothPath(values: number[]): { line: string; area: string } {
    const pts = values.map((v, i) => [xFor(i), yFor(v)] as const)
    if (pts.length === 0) return { line: '', area: '' }
    if (pts.length === 1) {
      const [x, y] = pts[0]
      return {
        line: `M ${x} ${y}`,
        area: `M ${x} ${padT + innerH} L ${x} ${y} L ${x} ${padT + innerH} Z`,
      }
    }
    let line = `M ${pts[0][0]} ${pts[0][1]}`
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] ?? p2
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6
      line += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`
    }
    const areaBase = padT + innerH
    const area = `${line} L ${pts[pts.length - 1][0]} ${areaBase} L ${pts[0][0]} ${areaBase} Z`
    return { line, area }
  }

  const yTicks = 5
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((yMax / yTicks) * i),
  )

  // Month/day label for x-axis; show every point when ≤ 12, otherwise thin.
  const xLabelStride = Math.max(1, Math.ceil(data.length / 12))

  function formatDate(dateStr: string, i: number) {
    const d = new Date(dateStr + 'T00:00:00Z')
    const day = String(d.getUTCDate()).padStart(2, '0')
    const month = d.toLocaleString('en', { month: 'short' })
    if (i === 0 || d.getUTCDate() === 1) {
      return `${month} '${String(d.getUTCFullYear()).slice(-2)}`
    }
    return `${day} ${month}`
  }

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const xPct = (e.clientX - rect.left) / rect.width
    const xPx = xPct * width
    // Find nearest data index.
    let nearest = 0
    let bestDx = Infinity
    for (let i = 0; i < data.length; i++) {
      const dx = Math.abs(xFor(i) - xPx)
      if (dx < bestDx) {
        bestDx = dx
        nearest = i
      }
    }
    setHover(nearest)
  }

  const hoveredPoint = hover !== null ? data[hover] : null

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Campaign performance over time"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {SERIES.map((s) => (
            <linearGradient
              key={s.key}
              id={`grad-${s.key}`}
              x1="0"
              x2="0"
              y1="0"
              y2="1"
            >
              <stop offset="0%" stopColor={s.color} stopOpacity="0.25" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Horizontal grid lines + y-axis labels */}
        {tickValues.map((v) => {
          const y = yFor(v)
          return (
            <g key={v}>
              <line
                x1={padL}
                x2={width - padR}
                y1={y}
                y2={y}
                stroke="#eef0f5"
                strokeWidth={1}
              />
              <text
                x={padL - 8}
                y={y + 4}
                fontSize="11"
                fill="#9ca3af"
                textAnchor="end"
              >
                {v}
              </text>
            </g>
          )
        })}

        {/* Series: areas underneath, lines on top. Render the biggest series
            first so smaller ones stay visible. */}
        {SERIES.map((s) => {
          const { area } = smoothPath(data.map((p) => p[s.key]))
          return (
            <path
              key={`area-${s.key}`}
              d={area}
              fill={`url(#grad-${s.key})`}
              stroke="none"
            />
          )
        })}
        {SERIES.map((s) => {
          const { line } = smoothPath(data.map((p) => p[s.key]))
          return (
            <path
              key={`line-${s.key}`}
              d={line}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )
        })}

        {/* X-axis labels */}
        {data.map((p, i) => {
          if (i % xLabelStride !== 0 && i !== data.length - 1) return null
          return (
            <text
              key={p.date}
              x={xFor(i)}
              y={height - padB + 20}
              fontSize="11"
              fill="#9ca3af"
              textAnchor="middle"
            >
              {formatDate(p.date, i)}
            </text>
          )
        })}

        {/* Hover guideline + dots */}
        {hover !== null && (
          <>
            <line
              x1={xFor(hover)}
              x2={xFor(hover)}
              y1={padT}
              y2={padT + innerH}
              stroke="#cbd5e1"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {SERIES.map((s) => (
              <circle
                key={`dot-${s.key}`}
                cx={xFor(hover)}
                cy={yFor(data[hover][s.key])}
                r={3.5}
                fill="#fff"
                stroke={s.color}
                strokeWidth={2}
              />
            ))}
          </>
        )}
      </svg>

      {hoveredPoint && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginTop: '-18px',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '0.55rem 0.75rem',
              fontSize: 11,
              color: '#475569',
              boxShadow: '0 4px 12px rgba(15, 23, 42, 0.08)',
            }}
          >
            <div style={{ fontWeight: 600, color: '#111827', marginBottom: 4 }}>
              {formatDate(hoveredPoint.date, 0)}
            </div>
            {SERIES.map((s) => (
              <div
                key={s.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 2,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: s.color,
                    display: 'inline-block',
                  }}
                />
                <span style={{ minWidth: 90 }}>{s.label}:</span>
                <strong style={{ color: '#111827' }}>
                  {hoveredPoint[s.key]}
                </strong>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="chart-legend">
        {SERIES.map((s) => (
          <div key={s.key} className="chart-legend__item">
            <span
              className="chart-legend__swatch"
              style={{ background: s.color }}
            />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  )
}
