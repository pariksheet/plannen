import { useState, useRef, useEffect } from 'react'
import { Send, Loader, Sparkles } from 'lucide-react'
import { dbClient } from '../lib/dbClient'
import { useToast } from '../context/ToastContext'

// ── Wire shapes (mirror supabase/functions/agent-chat/logic.ts) ───────────────

type ChatMessage = { role: 'user' | 'assistant'; content: string }

type ProposedAction = { tool: string; args: Record<string, unknown>; summary: string }
type ExecutedAction = { tool: string; summary: string }
type Usage = { used: number; limit: number; resets_at: string }

type AgentResponse = {
  assistant_text: string
  proposed_action: ProposedAction | null
  executed_action: ExecutedAction | null
  usage: Usage | null
  error: string | null
}

// A rendered thread entry. `pending` marks an assistant proposal awaiting a
// Confirm / Cancel decision.
type ThreadItem = ChatMessage & { pending?: ProposedAction }

interface AgentChatProps {
  /** Called whenever a write action actually executes, so the feed can reload. */
  onExecuted?: () => void
  /** Current on-screen record, scoping context-resolved edits/ticks. */
  context?: { open_event_id?: string | null; open_checklist_id?: string | null }
}

// Bounded conversation window sent to the server: current task + ~1 prior. We
// cap at the last 6 messages (the server prompt + tool-call cap do the rest).
const WINDOW = 6

export function AgentChat({ onExecuted, context }: AgentChatProps) {
  const { showToast } = useToast()
  const [thread, setThread] = useState<ThreadItem[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<Usage | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const atLimit = usage ? usage.used >= usage.limit : false
  const hasPendingProposal = thread.some((t) => t.pending)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [thread, loading])

  // Bounded window of plain messages (drop the pending marker) for the wire.
  const windowMessages = (items: ThreadItem[]): ChatMessage[] =>
    items.slice(-WINDOW).map(({ role, content }) => ({ role, content }))

  const applyResponse = (data: AgentResponse) => {
    if (data.usage) setUsage(data.usage)
    setThread((prev) => [
      ...prev,
      { role: 'assistant', content: data.assistant_text, pending: data.proposed_action ?? undefined },
    ])
    if (data.executed_action) {
      showToast(data.executed_action.summary, { variant: 'success' })
      onExecuted?.()
    }
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading || atLimit) return
    setError('')
    setInput('')
    const next: ThreadItem[] = [...thread, { role: 'user', content: text }]
    setThread(next)
    setLoading(true)
    try {
      const data = await dbClient.functions.invoke<AgentResponse>('agent-chat', {
        messages: windowMessages(next),
        context: context ?? undefined,
      })
      applyResponse(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach the assistant')
    } finally {
      setLoading(false)
    }
  }

  const confirm = async (item: ThreadItem) => {
    if (!item.pending || loading) return
    const proposal = item.pending
    // Drop the pending marker so the buttons disappear immediately.
    setThread((prev) => prev.map((t) => (t === item ? { ...t, pending: undefined } : t)))
    setLoading(true)
    setError('')
    try {
      const data = await dbClient.functions.invoke<AgentResponse>('agent-chat', {
        messages: windowMessages(thread),
        confirm: { tool: proposal.tool, args: proposal.args },
      })
      applyResponse(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm the action')
    } finally {
      setLoading(false)
    }
  }

  const cancelProposal = (item: ThreadItem) => {
    setThread((prev) => [
      ...prev.map((t) => (t === item ? { ...t, pending: undefined } : t)),
      { role: 'assistant', content: 'Okay, cancelled.' },
    ])
  }

  return (
    <div className="flex flex-col h-[min(70vh,32rem)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {thread.length === 0 && (
          <div className="text-sm text-gray-500 space-y-2 py-6 text-center">
            <Sparkles className="h-6 w-6 mx-auto text-indigo-400" />
            <p>Tell me what to change in your plans.</p>
            <p className="text-xs text-gray-400">
              e.g. “add swimming Friday 4pm”, “cancel the dentist appointment”, “check off sunscreen”
            </p>
          </div>
        )}
        {thread.map((item, i) => (
          <div key={i} className={item.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                item.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 text-white px-3 py-2 text-sm'
                  : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-gray-100 text-gray-900 px-3 py-2 text-sm'
              }
            >
              <p className="whitespace-pre-wrap break-words">{item.content}</p>
              {item.pending && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => confirm(item)}
                    disabled={loading}
                    className="min-h-[36px] px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-md hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => cancelProposal(item)}
                    disabled={loading}
                    className="min-h-[36px] px-3 py-1.5 border border-gray-300 text-gray-700 text-xs rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2">
              <Loader className="h-4 w-4 animate-spin text-gray-500" />
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>
      )}

      {atLimit ? (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900 text-center">
          You’ve used today’s {usage?.limit} assistant requests. Resets at midnight.
        </div>
      ) : (
        <form onSubmit={send} className="mt-3 flex gap-2 items-end">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={hasPendingProposal ? 'Confirm above, or type a new instruction…' : 'add swimming Friday 4pm…'}
            disabled={loading}
            className="flex-1 min-w-0 px-3 py-2 min-h-[44px] border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="min-h-[44px] px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center"
            aria-label="Send"
          >
            {loading ? <Loader className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </form>
      )}

      {usage && !atLimit && (
        <p className="mt-1.5 text-[11px] text-gray-400 text-right">
          {usage.limit - usage.used} of {usage.limit} assistant requests left today
        </p>
      )}
    </div>
  )
}
