// Spintax + variable resolution. Both the API (sender-worker, validation) and
// the frontend (live preview) use the same logic, so a parallel file lives in
// apps/web/src/lib/render.ts. Keep them in sync until we extract a shared package.

/** Mulberry32 PRNG — deterministic spintax for previews and tests. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolves spintax: `{Hi|Hey|Hello}` → one of the three. No nesting.
 * `seed=0` is deterministic — useful for snapshot tests and the preview UI.
 */
export function resolveSpintax(text: string, seed = 0): string {
  const rng = mulberry32(seed);
  // Negative lookbehind (?<!{) and negative lookahead (?!}) ensure we don't
  // accidentally consume the inner braces of a {{variable|fallback}} token.
  return text.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (match, inside: string) => {
    const options = inside.split('|');
    if (options.length < 2) return match;
    const idx = Math.floor(rng() * options.length);
    return options[idx] ?? match;
  });
}

/**
 * Resolves `{{var}}` and `{{var|fallback}}` placeholders against a vars map.
 * Returns the rendered text plus the list of unresolved keys, so callers can
 * block sends with missing required variables.
 */
export function resolveVariables(
  text: string,
  vars: Record<string, string | null | undefined>,
): { rendered: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const rendered = text.replace(
    /\{\{([^{}|]+)(?:\|([^{}]*))?\}\}/g,
    (match, key: string, fallback?: string) => {
      const k = key.trim();
      const value = vars[k];
      if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value);
      }
      if (fallback !== undefined) return fallback;
      unresolved.push(k);
      return match;
    },
  );
  return { rendered, unresolved };
}

/** Spintax then variables. The combined order matters — spintax should run first. */
export function render(
  text: string,
  vars: Record<string, string | null | undefined>,
  seed = 0,
): { rendered: string; unresolved: string[] } {
  const afterSpintax = resolveSpintax(text, seed);
  return resolveVariables(afterSpintax, vars);
}

/** Maps a lead row to the variable namespace used in subjects + bodies. */
export function leadToVars(lead: {
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  customVariables?: Record<string, unknown> | null;
}): Record<string, string | null> {
  const vars: Record<string, string | null> = {
    email: lead.email,
    first_name: lead.firstName,
    last_name: lead.lastName,
    company: lead.company,
    title: lead.title,
  };
  if (lead.customVariables) {
    for (const [k, v] of Object.entries(lead.customVariables)) {
      vars[k] = v != null ? String(v) : null;
    }
  }
  return vars;
}
