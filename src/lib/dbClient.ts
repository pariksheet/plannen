// Factory: select the dbClient implementation at module load based on the
// Vite env. Default is supabase (Tier 1) to preserve existing behaviour when
// the env var is unset.

import type { DbClient } from './dbClient/types'
import { tier0 } from './dbClient/tier0'
import { tier1 } from './dbClient/tier1'

const mode = import.meta.env.VITE_PLANNEN_BACKEND_MODE ?? 'supabase'

export const dbClient: DbClient = mode === 'plannen-api' ? tier0 : tier1
