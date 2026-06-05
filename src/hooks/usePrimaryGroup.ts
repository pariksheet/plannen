import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getMyGroups, FriendGroup } from '../services/groupService'
import { isTierZero } from '../lib/tier'

export type PrimaryGroup = { id: string; name: string }

/**
 * Resolves the user's pinned primary group to { id, name } for the nav.
 * Returns null in Tier 0 (groups are hidden) or when the user has no
 * accessible groups.
 *
 * Resolution order:
 *   1. profile.primary_group_id, if it matches a group the user can see
 *   2. Fallback: if the user has exactly one accessible group, treat it as
 *      primary. Keeps the nav star visible for members who were added to a
 *      single group but never explicitly pinned it.
 */
export function usePrimaryGroup(): PrimaryGroup | null {
  const { profile } = useAuth()
  const [resolved, setResolved] = useState<PrimaryGroup | null>(null)

  useEffect(() => {
    let cancelled = false
    if (isTierZero()) {
      setResolved(null)
      return () => { cancelled = true }
    }
    const primaryId = profile?.primary_group_id ?? null
    void (async () => {
      const { data } = await getMyGroups()
      if (cancelled) return
      const groups = (data as FriendGroup[] | undefined) ?? []
      const explicit = primaryId ? groups.find((g) => g.id === primaryId) : null
      const fallback = !explicit && groups.length === 1 ? groups[0] : null
      const match = explicit ?? fallback
      setResolved(match ? { id: match.id, name: match.name } : null)
    })()
    return () => { cancelled = true }
  }, [profile?.primary_group_id])

  return resolved
}
