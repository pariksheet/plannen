// REST surface for plannen.mailbox_ignore_rules (Tier 0).
// Mirrors the MCP tool signature: kind/pattern/subject_keyword.
// Also exposes /find-matching for the retroactive sweep used by the web mute UI.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const mailboxIgnoreRules = new Hono<{ Variables: AppVariables }>()

const RuleInput = z.object({
  adapter_id: z.string().min(1),
  kind: z.enum(['sender', 'domain', 'domain_subject']),
  pattern: z.string().min(1),
  subject_keyword: z.string().optional().nullable(),
  source_event_id: z.string().uuid().optional().nullable(),
  source_message_id: z.string().optional().nullable(),
  reason: z.string().optional().nullable(),
}).superRefine((v, ctx) => {
  if (v.kind === 'domain_subject' && !v.subject_keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_keyword is required when kind=domain_subject' })
  }
  if (v.kind !== 'domain_subject' && v.subject_keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_keyword is only allowed when kind=domain_subject' })
  }
})

const FindMatchingInput = z.object({
  kind: z.enum(['sender', 'domain', 'domain_subject']),
  pattern: z.string().min(1),
  subject_keyword: z.string().optional().nullable(),
}).superRefine((v, ctx) => {
  if (v.kind === 'domain_subject' && !v.subject_keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_keyword is required when kind=domain_subject' })
  }
  if (v.kind !== 'domain_subject' && v.subject_keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_keyword is only allowed when kind=domain_subject' })
  }
})

mailboxIgnoreRules.get('/', async (c) => {
  const userId = c.var.userId
  const adapterId = c.req.query('adapter_id')
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = `SELECT id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason, hit_count, last_hit_at, created_at
               FROM plannen.mailbox_ignore_rules WHERE user_id = $1`
    if (adapterId) {
      params.push(adapterId)
      sql += ` AND adapter_id = $${params.length}`
    }
    sql += ' ORDER BY created_at DESC'
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

mailboxIgnoreRules.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = RuleInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid rule', JSON.stringify(parsed.error.issues))
  }
  const v = parsed.data
  const pattern = v.pattern.trim().toLowerCase()
  const subjectKeyword = v.subject_keyword ? v.subject_keyword.trim() : null
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.mailbox_ignore_rules
         (user_id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT ON CONSTRAINT mailbox_ignore_rules_unique_rule DO UPDATE
         SET source_event_id   = COALESCE(EXCLUDED.source_event_id,   plannen.mailbox_ignore_rules.source_event_id),
             source_message_id = COALESCE(EXCLUDED.source_message_id, plannen.mailbox_ignore_rules.source_message_id),
             reason            = COALESCE(EXCLUDED.reason,            plannen.mailbox_ignore_rules.reason)
       RETURNING *`,
      [userId, v.adapter_id, v.kind, pattern, subjectKeyword, v.source_event_id ?? null, v.source_message_id ?? null, v.reason ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

mailboxIgnoreRules.post('/find-matching', async (c) => {
  const userId = c.var.userId
  const parsed = FindMatchingInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid spec', JSON.stringify(parsed.error.issues))
  }
  const v = parsed.data
  const pattern = v.pattern.trim().toLowerCase()
  const subject = v.subject_keyword ? v.subject_keyword.trim() : null
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.find_matching_mbsync_events($1, $2, $3)',
      [v.kind, pattern, subject],
    )
    return c.json({ data: rows })
  })
})

mailboxIgnoreRules.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.mailbox_ignore_rules WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Rule not found')
    return c.json({ data: { id } })
  })
})
