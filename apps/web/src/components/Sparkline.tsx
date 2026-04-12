type Props = {
  values: number[]
  dates?: string[]
  width?: number
  height?: number
  /** Y-axis floor — defaults to 0 (use 50 to zoom into the 50-100 range). */
  yMin?: number
  /** Y-axis ceiling — defaults to 100. */
  yMax?: number
}

/**
 * Lightweight SVG sparkline. Plots a polyline of `values` and a thin gradient
 * area underneath. No chart library — keeps the bundle small.
 */
export function Sparkline({
  values,
  dates,
  width = 600,
  height = 80,
  yMin = 0,
  yMax = 100,
}: Props) {
  if (values.length === 0) {
    return <div className="sparkline-empty">No history yet — run the worker to seed the chart.</div>
  }

  const padX = 4
  const padY = 4
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const range = Math.max(1, yMax - yMin)

  const xFor = (i: number) =>
    padX + (i / Math.max(1, values.length - 1)) * innerW
  const yFor = (v: number) =>
    padY + innerH - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / range) * innerH

  const linePoints = values.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ')
  const areaPoints = [
    `${xFor(0)},${yFor(yMin)}`,
    ...values.map((v, i) => `${xFor(i)},${yFor(v)}`),
    `${xFor(values.length - 1)},${yFor(yMin)}`,
  ].join(' ')

  // Reference line at the health floor (85)
  const floorY = yFor(85)

  return (
    <svg
      className="sparkline"
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Health score history"
    >
      <defs>
        <linearGradient id="sparkline-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>

      <line
        x1={padX}
        x2={width - padX}
        y1={floorY}
        y2={floorY}
        stroke="#f87171"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.5}
      />

      <polygon points={areaPoints} fill="url(#sparkline-grad)" />
      <polyline
        points={linePoints}
        fill="none"
        stroke="#6366f1"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {values.map((v, i) => (
        <circle
          key={i}
          cx={xFor(i)}
          cy={yFor(v)}
          r={values.length <= 14 ? 3 : 2}
          fill="#6366f1"
        >
          {dates && dates[i] && (
            <title>{`${dates[i]}: ${v}/100`}</title>
          )}
        </circle>
      ))}
    </svg>
  )
}
