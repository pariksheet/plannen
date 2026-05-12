// Pure validation helpers for the save_source MCP tool.
// Kept dependency-free so they can be unit-tested without Supabase.

export type SourceType = 'platform' | 'organiser' | 'one_off'

const VALID_SOURCE_TYPES: readonly SourceType[] = ['platform', 'organiser', 'one_off']

export function parseSourceUrl(input: string): { domain: string; sourceUrl: string } {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('invalid url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid url')
  }
  const domain = url.host.replace(/^www\./, '')
  return { domain, sourceUrl: input }
}

export function normaliseTags(input: string[]): string[] {
  const cleaned = input
    .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter((t) => t.length > 0)
  const deduped = Array.from(new Set(cleaned))
  if (deduped.length === 0) throw new Error('tags required')
  return deduped.slice(0, 10)
}

export function validateName(input: string): string {
  if (typeof input !== 'string') throw new Error('name required')
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error('name required')
  return trimmed
}

export function validateSourceType(input: string): SourceType {
  if (!VALID_SOURCE_TYPES.includes(input as SourceType)) {
    throw new Error('invalid source_type')
  }
  return input as SourceType
}
