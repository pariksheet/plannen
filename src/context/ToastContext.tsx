import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

type ToastVariant = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
}

interface ShowToastOptions {
  variant?: ToastVariant
  durationMs?: number
}

interface ToastContextValue {
  showToast: (message: string, opts?: ShowToastOptions) => void
}

// Default to a no-op so components embedded without a provider (e.g. in unit
// tests) can call showToast harmlessly instead of throwing.
const ToastContext = createContext<ToastContextValue>({ showToast: () => {} })

const VARIANT_STYLES: Record<ToastVariant, { wrap: string; Icon: typeof CheckCircle2 }> = {
  success: { wrap: 'bg-gray-900 text-white', Icon: CheckCircle2 },
  error: { wrap: 'bg-red-600 text-white', Icon: AlertCircle },
  info: { wrap: 'bg-gray-900 text-white', Icon: Info },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const showToast = useCallback((message: string, opts?: ShowToastOptions) => {
    const id = ++idRef.current
    const variant = opts?.variant ?? 'success'
    setToasts((t) => [...t, { id, message, variant }])
    window.setTimeout(() => dismiss(id), opts?.durationMs ?? 4000)
  }, [dismiss])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 inset-x-0 z-[100] flex flex-col items-center gap-2 px-4 pointer-events-none"
      >
        {toasts.map(({ id, message, variant }) => {
          const { wrap, Icon } = VARIANT_STYLES[variant]
          return (
            <div
              key={id}
              role="status"
              className={`pointer-events-auto flex items-center gap-2 max-w-md w-full sm:w-auto rounded-lg shadow-lg px-4 py-3 text-sm font-medium ${wrap}`}
            >
              <Icon className="h-5 w-5 flex-shrink-0" aria-hidden />
              <span className="flex-1">{message}</span>
              <button
                type="button"
                onClick={() => dismiss(id)}
                className="flex-shrink-0 opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}
