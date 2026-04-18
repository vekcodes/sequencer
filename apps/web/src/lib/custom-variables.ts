import { api } from './api'

export type CustomVariable = {
  id: number
  key: string
  fallbackDefault: string | null
}

export function listCustomVariables() {
  return api<{ variables: CustomVariable[] }>('/api/custom-variables').then(
    (r) => r.variables,
  )
}

export function createCustomVariable(input: {
  key: string
  fallbackDefault?: string | null
}) {
  return api<{ variable: CustomVariable }>('/api/custom-variables', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.variable)
}

export function updateCustomVariable(
  id: number,
  patch: { key?: string; fallbackDefault?: string | null },
) {
  return api<{ variable: CustomVariable }>(`/api/custom-variables/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((r) => r.variable)
}

export function deleteCustomVariable(id: number) {
  return api<{ ok: true }>(`/api/custom-variables/${id}`, { method: 'DELETE' })
}
