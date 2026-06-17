import type { ResolvedObligationRow } from '../lib/dbClient/types'

/**
 * Human label for an actionable drop/pick obligation: just its source
 * attendance name (e.g. "example school"). The drop/pick role is shown
 * separately as a badge, so it is not prefixed here.
 */
export function obligationLabel(o: ResolvedObligationRow): string {
  return o.source_name
}
