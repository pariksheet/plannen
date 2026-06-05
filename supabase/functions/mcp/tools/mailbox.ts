import type { ToolDefinition, ToolHandler, ToolModule } from '../types.ts'

// ── Tool definitions (verbatim from mcp/src/index.ts:2519-2583) ───────────────

const definitions: ToolDefinition[] = [
  {
    name: 'list_ignore_rules',
    description: "List the user's mailbox ignore rules. Used by /plannen-mailbox-sync to skip muted senders before classification.",
    inputSchema: {
      type: 'object',
      properties: {
        adapter_id: { type: 'string', description: 'Filter by adapter (e.g. "gmail"). Omit for all adapters.' },
      },
    },
  },
  {
    name: 'add_ignore_rule',
    description: 'Add a mailbox mute rule (sender, whole domain, or domain + subject keyword). Future emails matching this rule are skipped by /plannen-mailbox-sync without LLM classification.',
    inputSchema: {
      type: 'object',
      required: ['adapter_id', 'kind', 'pattern'],
      properties: {
        adapter_id:        { type: 'string', description: '"gmail" today; "icloud"/"imap" once those adapters land.' },
        kind:              { type: 'string', enum: ['sender', 'domain', 'domain_subject'], description: 'sender = exact email; domain = whole sending domain (includes subdomains); domain_subject = domain + subject keyword.' },
        pattern:           { type: 'string', description: 'For kind=sender: full address. For kind=domain or domain_subject: bare domain (e.g. "acmelife.com"). Lowercased server-side.' },
        subject_keyword:   { type: 'string', description: 'Required iff kind=domain_subject. Matched as case-insensitive substring against email subject.' },
        source_event_id:   { type: 'string', description: 'Optional — the Plannen event whose dismissal created this rule.' },
        source_message_id: { type: 'string', description: 'Optional — the originating message ID for audit.' },
        reason:            { type: 'string', description: 'Optional human note.' },
      },
    },
  },
  {
    name: 'delete_ignore_rule',
    description: 'Delete a single ignore rule by id. Used by /plannen-mailbox-rules to unmute a sender.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'bump_ignore_rule_hit',
    description: 'Increment hit_count and set last_hit_at = now() for a rule. /plannen-mailbox-sync calls this each time a muted message is skipped.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'get_mailbox_sync_state',
    description: 'Get the last_synced_at checkpoint for an adapter. Returns { last_synced_at: ISO string | null }. /plannen-mailbox-sync reads this at the start of each run to compute the Gmail search-window lower bound.',
    inputSchema: {
      type: 'object',
      required: ['adapter_id'],
      properties: {
        adapter_id: { type: 'string', description: 'e.g. "gmail".' },
      },
    },
  },
  {
    name: 'set_mailbox_sync_state',
    description: 'Upsert the last_synced_at checkpoint for an adapter. /plannen-mailbox-sync calls this at end-of-run with the internalDate of the latest successfully-processed message so the next run skips everything older.',
    inputSchema: {
      type: 'object',
      required: ['adapter_id', 'last_synced_at'],
      properties: {
        adapter_id:     { type: 'string', description: 'e.g. "gmail".' },
        last_synced_at: { type: 'string', description: 'ISO 8601 timestamp (Z-suffixed UTC recommended).' },
      },
    },
  },
  {
    name: 'find_matching_mbsync_events',
    description: 'Given a (kind, pattern, subject_keyword) rule spec, returns up to 100 #mbsync events the rule would match. Used by the web mute UI to ask the user whether to retroactively delete prior captures.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'pattern'],
      properties: {
        kind:            { type: 'string', enum: ['sender', 'domain', 'domain_subject'] },
        pattern:         { type: 'string' },
        subject_keyword: { type: 'string', description: 'Required iff kind=domain_subject.' },
      },
    },
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

// Mirrors mcp/src/mailboxIgnoreRules.ts. Strip "Name <addr>" wrappers and
// lowercase the address so comparisons are display-name-insensitive.
export function normaliseSender(raw: string): string {
  const m = raw.match(/<([^>]+)>/)
  const addr = (m ? m[1] : raw).trim().toLowerCase()
  return addr
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const listIgnoreRules: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { adapter_id?: string }
  const adapterId = typedArgs.adapter_id ?? null
  const baseCols = `id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason,
                    hit_count, last_hit_at, created_at`
  const sql = adapterId
    ? `SELECT ${baseCols}
       FROM plannen.mailbox_ignore_rules
       WHERE user_id = $1 AND adapter_id = $2
       ORDER BY created_at DESC`
    : `SELECT ${baseCols}
       FROM plannen.mailbox_ignore_rules
       WHERE user_id = $1
       ORDER BY created_at DESC`
  const params = adapterId ? [ctx.userId, adapterId] : [ctx.userId]
  const { rows } = await ctx.client.query(sql, params)
  return rows
}

const addIgnoreRule: ToolHandler = async (args, ctx) => {
  const typedArgs = args as {
    adapter_id?: string
    kind?: 'sender' | 'domain' | 'domain_subject'
    pattern?: string
    subject_keyword?: string
    source_event_id?: string | null
    source_message_id?: string | null
    reason?: string | null
  }
  const adapterId = (typedArgs.adapter_id ?? '').trim()
  const kind = typedArgs.kind
  const patternRaw = (typedArgs.pattern ?? '').trim()
  if (!adapterId) throw new Error('adapter_id required')
  if (kind !== 'sender' && kind !== 'domain' && kind !== 'domain_subject') {
    throw new Error('kind must be one of sender | domain | domain_subject')
  }
  if (!patternRaw) throw new Error('pattern required')
  if (kind === 'domain_subject' && !typedArgs.subject_keyword?.trim()) {
    throw new Error('subject_keyword is required when kind=domain_subject')
  }
  if (kind !== 'domain_subject' && typedArgs.subject_keyword) {
    throw new Error('subject_keyword is only allowed when kind=domain_subject')
  }
  const pattern = patternRaw.toLowerCase()
  const subjectKeyword = kind === 'domain_subject' ? (typedArgs.subject_keyword ?? '').trim() : null
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.mailbox_ignore_rules
       (user_id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT ON CONSTRAINT mailbox_ignore_rules_unique_rule DO UPDATE
       SET source_event_id   = COALESCE(EXCLUDED.source_event_id,   plannen.mailbox_ignore_rules.source_event_id),
           source_message_id = COALESCE(EXCLUDED.source_message_id, plannen.mailbox_ignore_rules.source_message_id),
           reason            = COALESCE(EXCLUDED.reason,            plannen.mailbox_ignore_rules.reason)
     RETURNING id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason,
               hit_count, last_hit_at, created_at`,
    [
      ctx.userId,
      adapterId,
      kind,
      pattern,
      subjectKeyword,
      typedArgs.source_event_id ?? null,
      typedArgs.source_message_id ?? null,
      typedArgs.reason ?? null,
    ],
  )
  return rows[0]
}

const deleteIgnoreRule: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { id?: string }
  const id = (typedArgs.id ?? '').trim()
  if (!id) throw new Error('id required')
  const { rowCount } = await ctx.client.query(
    `DELETE FROM plannen.mailbox_ignore_rules WHERE id = $1 AND user_id = $2`,
    [id, ctx.userId],
  )
  return { deleted: rowCount ?? 0 }
}

const bumpIgnoreRuleHit: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { id?: string }
  const id = (typedArgs.id ?? '').trim()
  if (!id) throw new Error('id required')
  const { rows } = await ctx.client.query(
    `UPDATE plannen.mailbox_ignore_rules
       SET hit_count = hit_count + 1, last_hit_at = now()
       WHERE id = $1 AND user_id = $2
     RETURNING id, hit_count, last_hit_at`,
    [id, ctx.userId],
  )
  if (rows.length === 0) throw new Error('rule not found')
  return rows[0]
}

const getMailboxSyncState: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { adapter_id?: string }
  const adapterId = (typedArgs.adapter_id ?? '').trim()
  if (!adapterId) throw new Error('adapter_id required')
  const { rows } = await ctx.client.query(
    `SELECT last_synced_at FROM plannen.mailbox_sync_state
     WHERE user_id = $1 AND adapter_id = $2`,
    [ctx.userId, adapterId],
  )
  return { last_synced_at: rows[0]?.last_synced_at ?? null }
}

const setMailboxSyncState: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { adapter_id?: string; last_synced_at?: string }
  const adapterId = (typedArgs.adapter_id ?? '').trim()
  const lastSyncedAt = (typedArgs.last_synced_at ?? '').trim()
  if (!adapterId) throw new Error('adapter_id required')
  if (!lastSyncedAt) throw new Error('last_synced_at required')
  if (Number.isNaN(Date.parse(lastSyncedAt))) throw new Error('last_synced_at must be a valid ISO 8601 timestamp')
  const { rows } = await ctx.client.query(
    `INSERT INTO plannen.mailbox_sync_state (user_id, adapter_id, last_synced_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, adapter_id) DO UPDATE
       SET last_synced_at = EXCLUDED.last_synced_at, updated_at = now()
     RETURNING last_synced_at, updated_at`,
    [ctx.userId, adapterId, lastSyncedAt],
  )
  return rows[0]
}

const findMatchingMbsyncEvents: ToolHandler = async (args, ctx) => {
  const typedArgs = args as { kind?: string; pattern?: string; subject_keyword?: string }
  const kind = typedArgs.kind
  const patternRaw = (typedArgs.pattern ?? '').trim()
  if (kind !== 'sender' && kind !== 'domain' && kind !== 'domain_subject') {
    throw new Error('kind must be one of sender | domain | domain_subject')
  }
  if (!patternRaw) throw new Error('pattern required')
  if (kind === 'domain_subject' && !typedArgs.subject_keyword?.trim()) {
    throw new Error('subject_keyword is required when kind=domain_subject')
  }
  if (kind !== 'domain_subject' && typedArgs.subject_keyword) {
    throw new Error('subject_keyword is only allowed when kind=domain_subject')
  }
  const pattern = patternRaw.toLowerCase()
  const subject = kind === 'domain_subject' ? (typedArgs.subject_keyword ?? '').trim() : null
  const { rows } = await ctx.client.query(
    `SELECT * FROM plannen.find_matching_mbsync_events($1, $2, $3)`,
    [kind, pattern, subject],
  )
  return rows
}

// ── Module ────────────────────────────────────────────────────────────────────

export const mailboxModule: ToolModule = {
  definitions,
  dispatch: {
    list_ignore_rules: listIgnoreRules,
    add_ignore_rule: addIgnoreRule,
    delete_ignore_rule: deleteIgnoreRule,
    bump_ignore_rule_hit: bumpIgnoreRuleHit,
    get_mailbox_sync_state: getMailboxSyncState,
    set_mailbox_sync_state: setMailboxSyncState,
    find_matching_mbsync_events: findMatchingMbsyncEvents,
  },
}
