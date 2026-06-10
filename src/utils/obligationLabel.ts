import type { ResolvedObligationRow } from '../lib/dbClient/types'

/**
 * Human label for an actionable drop/pick obligation, tagged with its source
 * attendance: "drop · example school", "pick · summer camp".
 */
export function obligationLabel(o: ResolvedObligationRow): string {
  return `${o.role} · ${o.source_name}`
}
