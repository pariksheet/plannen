import type { PoolClient } from 'npm:pg@8'

// ── Pure-logic helpers ────────────────────────────────────────────────────────

/**
 * Convert a UTC ISO string to a local datetime string (no offset) for the
 * given IANA timezone.
 * e.g. "2026-05-10T09:00:00+00:00" + "Europe/Brussels" → "2026-05-10T11:00:00"
 */
export function toLocalIso(utcIso: string, tz: string): string {
  const d = new Date(utcIso)
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`
}

export function extractDomain(url: string): string | null {
  let hostname: string
  try { hostname = new URL(url).hostname } catch { return null }
  if (hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null
  return hostname.replace(/^www\./, '')
}

// Columns returned by default for event reads — excludes image_url, created_at,
// updated_at, gcal_event_id, event_type, shared_with_*, enrollment_start_date,
// which are rarely needed by callers and balloon token usage.
export const SLIM_EVENT_COLUMNS =
  'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, recurrence_rule, parent_event_id'

export function slimEvent<T extends Record<string, unknown>>(e: T) {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? null,
    start_date: e.start_date,
    end_date: e.end_date,
    location: e.location,
    event_kind: e.event_kind,
    event_status: e.event_status,
    hashtags: e.hashtags,
    enrollment_url: e.enrollment_url,
    enrollment_deadline: e.enrollment_deadline,
  }
}

export function truncateDescription(desc: unknown, maxLen = 200): string | null {
  if (typeof desc !== 'string') return null
  if (desc.length <= maxLen) return desc
  return desc.slice(0, maxLen) + '…'
}

export const VALID_EVENT_STATUSES = ['watching', 'planned', 'interested', 'going', 'cancelled', 'past', 'missed'] as const
export type EventStatus = typeof VALID_EVENT_STATUSES[number]

// ── DB-aware helpers ──────────────────────────────────────────────────────────

export async function getUserTimezone(client: PoolClient, userId: string): Promise<string> {
  const { rows } = await client.query(
    'SELECT timezone FROM plannen.user_profiles WHERE user_id = $1 LIMIT 1',
    [userId],
  )
  return (rows[0]?.timezone as string | undefined) ?? 'UTC'
}

export async function upsertSource(
  client: PoolClient,
  userId: string,
  eventId: string | null,
  enrollmentUrl: string,
): Promise<{ id: string; last_analysed_at: string | null } | null> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return null
  const { rows: srcRows } = await client.query(
    `INSERT INTO plannen.event_sources (user_id, domain, source_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, domain) DO UPDATE
       SET source_url = EXCLUDED.source_url
     RETURNING id, last_analysed_at`,
    [userId, domain, enrollmentUrl],
  )
  if (srcRows.length === 0) return null
  const src = srcRows[0] as { id: string; last_analysed_at: string | null }
  if (eventId !== null) {
    await client.query(
      `INSERT INTO plannen.event_source_refs (event_id, source_id, user_id, ref_type)
       VALUES ($1, $2, $3, 'enrollment_url')
       ON CONFLICT (event_id, source_id) DO NOTHING`,
      [eventId, src.id, userId],
    )
  }
  return { id: src.id, last_analysed_at: src.last_analysed_at }
}
