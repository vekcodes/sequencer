import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { api, ApiError } from './api'

export type AuthUser = {
  id: string
  email: string
  name: string | null
  role: string
  workspaceId: number
}

export type SignupInput = {
  email: string
  password: string
  name: string
  workspaceName: string
}

type AuthState = {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (input: SignupInput) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

type MeResponse = { user: AuthUser | null }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await api<MeResponse>('/api/auth/me')
      setUser(data.user)
    } catch {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [refresh])

  const login = useCallback<AuthState['login']>(
    async (email, password) => {
      try {
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        })
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          throw new Error('Invalid email or password')
        }
        throw e
      }
      await refresh()
    },
    [refresh],
  )

  const signup = useCallback<AuthState['signup']>(
    async (input) => {
      try {
        await api('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify(input),
        })
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          throw new Error('That email or workspace is already taken')
        }
        if (e instanceof ApiError && e.status === 400) {
          throw new Error('Please check your inputs')
        }
        throw e
      }
      await refresh()
    },
    [refresh],
  )

  const logout = useCallback<AuthState['logout']>(async () => {
    await api('/api/auth/logout', { method: 'POST' })
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
