// Mirror of apps/api/src/lib/render.ts so the sequence editor can do live
// preview without a roundtrip. Keep these two files in sync.

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function resolveSpintax(text: string, seed = 0): string {
  const rng = mulberry32(seed)
  return text.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (match, inside: string) => {
    const options = inside.split('|')
    if (options.length < 2) return match
    const idx = Math.floor(rng() * options.length)
    return options[idx] ?? match
  })
}

export function resolveVariables(
  text: string,
  vars: Record<string, string | null | undefined>,
): { rendered: string; unresolved: string[] } {
  const unresolved: string[] = []
  const rendered = text.replace(
    /\{\{([^{}|]+)(?:\|([^{}]*))?\}\}/g,
    (match, key: string, fallback?: string) => {
      const k = key.trim()
      const value = vars[k]
      if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value)
      }
      if (fallback !== undefined) return fallback
      unresolved.push(k)
      return match
    },
  )
  return { rendered, unresolved }
}

export function render(
  text: string,
  vars: Record<string, string | null | undefined>,
  seed = 0,
): { rendered: string; unresolved: string[] } {
  const afterSpintax = resolveSpintax(text, seed)
  return resolveVariables(afterSpintax, vars)
}

/** Hardcoded sample lead used by the preview panel until we let users pick a real one. */
export const SAMPLE_LEAD_VARS: Record<string, string> = {
  email: 'alex@acme.io',
  first_name: 'Alex',
  last_name: 'Chen',
  company: 'Acme Inc',
  title: 'VP of Sales',
}
