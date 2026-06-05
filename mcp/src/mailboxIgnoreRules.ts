export type IgnoreRule = {
  id: string
  user_id: string
  adapter_id: string
  sender: string
  source_event_id: string | null
  source_message_id: string | null
  reason: string | null
  hit_count: number
  last_hit_at: string | null
  created_at: string
}

export function normaliseSender(raw: string): string {
  const m = raw.match(/<([^>]+)>/)
  const addr = (m ? m[1] : raw).trim().toLowerCase()
  return addr
}

export function ruleMatches(
  rule: Pick<IgnoreRule, 'adapter_id' | 'sender'>,
  candidate: { adapter_id: string; sender: string },
): boolean {
  if (rule.adapter_id !== candidate.adapter_id) return false
  return normaliseSender(rule.sender) === normaliseSender(candidate.sender)
}
