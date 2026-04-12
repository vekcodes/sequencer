/**
 * Tiny fetch wrapper that always sends cookies and parses JSON.
 * Throws ApiError on non-2xx so callers can `try/catch` cleanly.
 */
export class ApiError extends Error {
  status: number
  payload: unknown
  constructor(status: number, payload: unknown, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.status = status
    this.payload = payload
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data)
  }
  return data as T
}
