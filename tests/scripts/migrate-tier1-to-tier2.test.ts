import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module
import {
  STEPS,
  readProgress,
  markProgress,
  pendingSteps,
  rewriteEnvContent,
  rewritePluginManifest,
  cloudDbUrlHint,
  run,
} from '../../scripts/lib/migrate-tier1-to-tier2.mjs'

describe('STEPS', () => {
  it('lists 8 named steps in spec order', () => {
    expect(STEPS).toEqual([
      'snapshot',
      'link',
      'push-schema',
      'restore-data',
      'upload-photos',
      'deploy',
      'rewrite-config',
      'verify',
    ])
  })
})

describe('progress file helpers', () => {
  let root: string
  let p: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-prog-'))
    p = join(root, 'prog.txt')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('readProgress returns empty Set when missing', () => {
    expect(readProgress(p)).toEqual(new Set())
  })

  it('markProgress + readProgress round-trip', () => {
    markProgress(p, 'snapshot')
    markProgress(p, 'link')
    expect(readProgress(p)).toEqual(new Set(['snapshot', 'link']))
  })

  it('pendingSteps filters out completed in original order', () => {
    expect(pendingSteps(STEPS, new Set(['snapshot', 'link']))).toEqual([
      'push-schema',
      'restore-data',
      'upload-photos',
      'deploy',
      'rewrite-config',
      'verify',
    ])
  })
})

describe('rewriteEnvContent', () => {
  it('overrides existing keys in place, preserving order', () => {
    const cur = `PLANNEN_USER_EMAIL=me@x.com\nPLANNEN_TIER=1\nDATABASE_URL=postgres://x\n`
    const out = rewriteEnvContent(cur, { PLANNEN_TIER: '2' })
    expect(out).toBe(
      `PLANNEN_USER_EMAIL=me@x.com\nPLANNEN_TIER=2\nDATABASE_URL=postgres://x\n`,
    )
  })

  it('appends new keys at the end', () => {
    const cur = `PLANNEN_TIER=1\n`
    const out = rewriteEnvContent(cur, { PLANNEN_TIER: '2', MCP_BEARER_TOKEN: 'tok' })
    expect(out).toContain('PLANNEN_TIER=2')
    expect(out).toContain('MCP_BEARER_TOKEN=tok')
    expect(out.indexOf('PLANNEN_TIER')).toBeLessThan(out.indexOf('MCP_BEARER_TOKEN'))
  })

  it('does not touch comment or blank lines', () => {
    const cur = `# header\n\nPLANNEN_TIER=1\n`
    const out = rewriteEnvContent(cur, { PLANNEN_TIER: '2' })
    expect(out).toBe(`# header\n\nPLANNEN_TIER=2\n`)
  })

  it('works on empty file', () => {
    const out = rewriteEnvContent('', { PLANNEN_TIER: '2' })
    expect(out).toContain('PLANNEN_TIER=2')
  })
})

describe('rewritePluginManifest', () => {
  it('writes HTTP-mode plannen entry with cloud URL + bearer', () => {
    const cur = JSON.stringify({
      name: 'plannen',
      mcpServers: { plannen: { command: 'node', args: ['./mcp/dist/index.js'] } },
    })
    const out = rewritePluginManifest(cur, {
      cloudUrl: 'https://abc.supabase.co',
      bearer: 'tok',
    })
    const data = JSON.parse(out)
    expect(data.mcpServers.plannen).toEqual({
      type: 'http',
      url: 'https://abc.supabase.co/functions/v1/mcp',
      headers: { Authorization: 'Bearer tok' },
    })
    // Other top-level fields preserved.
    expect(data.name).toBe('plannen')
  })

  it('creates mcpServers when missing', () => {
    const out = rewritePluginManifest('{}', {
      cloudUrl: 'https://abc.supabase.co',
      bearer: 'tok',
    })
    const data = JSON.parse(out)
    expect(data.mcpServers.plannen.type).toBe('http')
  })

  it('strips trailing slash on cloudUrl', () => {
    const out = rewritePluginManifest('{}', {
      cloudUrl: 'https://abc.supabase.co/',
      bearer: 't',
    })
    expect(JSON.parse(out).mcpServers.plannen.url).toBe(
      'https://abc.supabase.co/functions/v1/mcp',
    )
  })
})

describe('cloudDbUrlHint', () => {
  it('produces a placeholder URL', () => {
    expect(cloudDbUrlHint('abcdef')).toMatch(
      /postgresql:\/\/postgres\.abcdef:\[YOUR-PASSWORD\]@/,
    )
  })
})

// ── run() — end-to-end with all deps stubbed ──────────────────────────────

function FakePgClient(rows: any[]) {
  return class {
    queries: string[] = []
    async connect() {}
    async query(sql: string) {
      this.queries.push(sql)
      if (/count\(\*\).*plannen\.events/i.test(sql)) {
        return { rows: [{ n: rows.length }] }
      }
      return { rows }
    }
    async end() {}
  }
}

describe('run (full orchestration with stubbed deps)', () => {
  let root: string
  let progressPath: string
  let envPath: string
  let pluginPath: string
  let snapshotSqlPath: string

  const VALID_REF = 'abcdefghijklmnopqrst'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-orch-'))
    progressPath = join(root, '.plannen-tier2-progress')
    envPath = join(root, '.env')
    pluginPath = join(root, 'plugin.json')
    snapshotSqlPath = join(root, 'snap.sql')
    writeFileSync(envPath, `PLANNEN_TIER=1\nPLANNEN_USER_EMAIL=me@x.com\n`)
    writeFileSync(
      pluginPath,
      JSON.stringify({ name: 'plannen', mcpServers: { plannen: { command: 'node' } } }),
    )
    writeFileSync(snapshotSqlPath, '-- empty snapshot\n')
    mkdirSync(join(root, 'snapshots'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeDeps() {
    const apiKeysBody = JSON.stringify([
      { name: 'anon', api_key: 'A' },
      { name: 'service_role', api_key: 'S' },
    ])
    const cliResponses: Record<string, { status: number; stdout?: string }> = {
      'projects list': { status: 0 },
      [`link --project-ref ${VALID_REF}`]: { status: 0 },
      [`projects api-keys --project-ref ${VALID_REF} --output json`]: {
        status: 0,
        stdout: apiKeysBody,
      },
      '*': { status: 0 },
    }
    return {
      cli: (args: string[]) => {
        const key = args.join(' ')
        const r = cliResponses[key] ?? cliResponses['*']
        return { status: r.status, stdout: r.stdout ?? '', stderr: '' }
      },
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      log: () => {},
      delay: async () => {},
      fetch: async (_url: string, init: any) => {
        if (init?.method === 'POST' && init?.body?.includes?.('tools/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ result: { tools: [{ name: 'list_events' }] } }),
          } as unknown as Response
        }
        if (init?.method === 'HEAD') return { status: 404 } as Response
        if (init?.method === 'POST') return { ok: true, status: 200 } as Response
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response
      },
      Client: FakePgClient([]),
      functionsDir: (() => {
        const fd = join(root, 'functions')
        mkdirSync(join(fd, 'mcp'), { recursive: true })
        writeFileSync(join(fd, 'mcp', 'index.ts'), '// stub')
        return fd
      })(),
    }
  }

  function baseCtx(extra: Record<string, any> = {}) {
    return {
      projectRef: VALID_REF,
      cloudDatabaseUrl: 'postgres://cloud',
      snapshotSqlPath,
      tier1DatabaseUrl: 'postgres://t1',
      tier1StorageUrl: 'http://127.0.0.1:54321',
      tier1ServiceRoleKey: 't1srk',
      userEmail: 'me@x.com',
      envPath,
      pluginManifestPath: pluginPath,
      progressPath,
      checkpointPath: join(root, 'cp.txt'),
      snapshotDir: join(root, 'snapshots'),
      ...extra,
    }
  }

  it('runs all 8 steps end-to-end and writes progress', async () => {
    const deps = makeDeps()
    const out = await run(baseCtx(), deps)

    expect(out.doneSteps).toEqual(STEPS)
    const progress = readFileSync(progressPath, 'utf8')
    for (const s of STEPS) expect(progress).toContain(s)
  })

  it('rewrite-config produces a valid .env and plugin manifest', async () => {
    const deps = makeDeps()
    await run(baseCtx(), deps)

    const env = readFileSync(envPath, 'utf8')
    expect(env).toContain('PLANNEN_TIER=2')
    expect(env).toContain(`SUPABASE_URL=https://${VALID_REF}.supabase.co`)
    expect(env).toContain('SUPABASE_ANON_KEY=A')
    expect(env).toContain('VITE_PLANNEN_TIER=2')
    expect(env).toContain('MCP_BEARER_TOKEN=')

    const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'))
    expect(plugin.mcpServers.plannen.type).toBe('http')
    expect(plugin.mcpServers.plannen.url).toBe(
      `https://${VALID_REF}.supabase.co/functions/v1/mcp`,
    )

    // Backups created.
    expect(existsSync(`${envPath}.tier1.bak`)).toBe(true)
    expect(existsSync(`${pluginPath}.tier1.bak`)).toBe(true)
  })

  it('resumes from a partially-complete progress file', async () => {
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\n')
    const deps = makeDeps()
    // Pre-populate the ctx with link outputs (since we're skipping that step
    // we won't get them back from the orchestrator).
    const ctx = {
      ...baseCtx(),
      cloudSupabaseUrl: `https://${VALID_REF}.supabase.co`,
      cloudAnonKey: 'A',
      cloudServiceRoleKey: 'S',
    }
    const out = await run(ctx, deps)
    const all = readFileSync(progressPath, 'utf8')
    for (const s of STEPS) expect(all).toContain(s)
    expect(out.doneSteps).toEqual(STEPS)
  })

  it('no-ops when all steps already complete', async () => {
    writeFileSync(progressPath, STEPS.join('\n') + '\n')
    const deps = makeDeps()
    const out = await run(baseCtx(), deps)
    expect(out.doneSteps).toEqual(STEPS)
  })

  it('restore-data aborts on non-empty cloud DB without forceOverwrite', async () => {
    const deps = makeDeps()
    // Drop the no-op stub so defaultRestoreData runs (against FakePgClient).
    delete (deps as any).restoreData
    deps.Client = FakePgClient([{ id: 1 }])
    // Skip earlier steps so we land on restore-data quickly.
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\n')
    const ctx = {
      ...baseCtx(),
      cloudSupabaseUrl: `https://${VALID_REF}.supabase.co`,
      cloudAnonKey: 'A',
    }
    await expect(run(ctx, deps)).rejects.toThrow(/non-empty/)
  })

  it('verify fails when MCP tools/list returns 0 tools', async () => {
    const deps = makeDeps()
    const origFetch = deps.fetch
    deps.fetch = async (url: string, init: any) => {
      if (init?.method === 'POST' && init?.body?.includes?.('tools/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { tools: [] } }),
        } as unknown as Response
      }
      return origFetch(url, init)
    }
    await expect(run(baseCtx(), deps)).rejects.toThrow(/0 tools/)
  })
})
