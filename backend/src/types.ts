import type { Pool } from 'pg'

export type AppVariables = {
  userId: string
  userEmail: string
  pool: Pool
}
