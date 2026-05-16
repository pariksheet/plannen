import type { Pool } from 'npm:pg@8'

export async function resolveUserIdByEmail(pool: Pool, email: string): Promise<string> {
  if (!email) throw new Error('PLANNEN_USER_EMAIL is required')
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
    [email],
  )
  if (rows.length === 0) {
    throw new Error(
      `No Plannen user found for ${email}. Run scripts/bootstrap.sh or insert a row in plannen.users.`,
    )
  }
  return rows[0].id
}
