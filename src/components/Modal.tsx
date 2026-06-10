import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  showCloseButton?: boolean
  /** Extra buttons rendered in the sticky header, left of the close button. */
  headerActions?: React.ReactNode
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function Modal({ isOpen, onClose, title, children, showCloseButton = true, headerActions }: ModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = 'unset'
    return () => { document.body.style.overflow = 'unset' }
  }, [isOpen])

  // Focus-trap: remember the previously focused element on open, move focus
  // into the modal, intercept Tab/Shift-Tab to wrap focus within the dialog,
  // restore focus on close.
  useEffect(() => {
    if (!isOpen) return
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null

    const root = containerRef.current
    if (root) {
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      const first = focusables[0]
      if (first) first.focus()
      else root.focus()
    }

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root) return
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => !el.hasAttribute('disabled'))
      if (nodes.length === 0) {
        e.preventDefault()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleTab)
    return () => {
      document.removeEventListener('keydown', handleTab)
      previouslyFocusedRef.current?.focus?.()
    }
  }, [isOpen])

  if (!isOpen) return null

  // Render through a portal to document.body so the modal escapes any ancestor
  // `opacity`/`transform` stacking context. Without this, a dimmed past-event
  // row (e.g. `opacity-60` in ScheduleOverview) would cascade its opacity onto
  // the fixed-position modal, washing it out.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-2 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="bg-white rounded-lg shadow-xl w-full max-w-[min(100vw-1rem,36rem)] sm:max-w-xl max-h-[calc(100dvh-1rem)] sm:max-h-[90vh] overflow-y-auto overflow-x-hidden min-w-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-3 sm:p-6 bg-white border-b border-gray-200">
          <h2 className="text-lg sm:text-xl font-semibold text-gray-900 min-w-0 truncate" title={title}>{title}</h2>
          <div className="flex items-center gap-1 flex-shrink-0">
            {headerActions}
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <div className="px-4 py-4 sm:p-6">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel?: () => void
  variant?: 'default' | 'danger'
}

export function ConfirmModal({
  isOpen,
  onClose,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
}: ConfirmModalProps) {
  const handleConfirm = () => {
    onConfirm()
    onClose()
  }
  const handleCancel = () => {
    onCancel?.()
    onClose()
  }
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-gray-700">{message}</p>
        <div className="flex flex-wrap justify-end gap-2 sm:gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="min-h-[44px] px-4 py-2.5 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className={`min-h-[44px] px-4 py-2.5 text-white rounded-md transition-colors ${
              variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </Modal>
  )
}

interface PromptModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  message: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
  onConfirm: (value: string) => void
  onCancel?: () => void
  type?: 'text' | 'date' | 'email' | 'number'
}

export function PromptModal({
  isOpen,
  onClose,
  title,
  message,
  placeholder = '',
  defaultValue = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  type = 'text',
}: PromptModalProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const value = formData.get('input') as string
    if (value) {
      onConfirm(value)
      onClose()
    }
  }
  const handleCancel = () => {
    onCancel?.()
    onClose()
  }
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-gray-700">{message}</p>
        <input
          type={type}
          name="input"
          defaultValue={defaultValue}
          placeholder={placeholder}
          autoFocus
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <div className="flex flex-wrap justify-end gap-2 sm:gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="min-h-[44px] px-4 py-2.5 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
          >
            {cancelText}
          </button>
          <button
            type="submit"
            className="min-h-[44px] px-4 py-2.5 text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors"
          >
            {confirmText}
          </button>
        </div>
      </form>
    </Modal>
  )
}
