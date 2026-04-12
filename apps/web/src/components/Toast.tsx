import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type ToastType = 'success' | 'error' | 'info'

interface Toast {
  id: number
  type: ToastType
  message: string
  leaving?: boolean
}

interface ToastCtx {
  toast: (type: ToastType, message: string) => void
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback((type: ToastType, message: string) => {
    const id = ++nextId
    setToasts((prev) => [...prev, { id, type, message }])
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, 250)
    }, 4000)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 250)
  }, [])

  const ICONS: Record<ToastType, string> = {
    success: '\u2713',
    error: '!',
    info: 'i',
  }

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast--${t.type}${t.leaving ? ' toast--leaving' : ''}`}
            >
              <span className="toast__icon">{ICONS[t.type]}</span>
              <span className="toast__message">{t.message}</span>
              <button
                type="button"
                className="toast__close"
                onClick={() => dismiss(t.id)}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
