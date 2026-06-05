import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore — .mjs module
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
  it('lists 12 named steps in spec order', () => {
    expect(STEPS).toEqual([
      'snapshot',
      'link',
      'push-schema',
      'expose-schemas',
      'restore-data',
      'rewrite-storage-urls',
      'upload-photos',
      'deploy',
      'mint-pat',
      'rewrite-config',
      'wire-auth',
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
      'expose-schemas',
      'restore-data',
      'rewrite-storage-urls',
      'upload-photos',
      'deploy',
      'mint-pat',
      'rewrite-config',
      'wire-auth',
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
      supabaseMgmt: {
        readAccessToken: () => null,
        setExposedSchemas: async () => ({ changed: true, schemas: [] }),
        updateAuthConfig: async () => ({ changed: false }),
      },
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

  it('runs every step end-to-end and writes progress', async () => {
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

  it('rewrite-config backs up and removes .env.local so Vite picks up cloud .env', async () => {
    const envLocalPath = join(root, '.env.local')
    writeFileSync(envLocalPath, 'VITE_SUPABASE_URL=http://127.0.0.1:54321\n')
    const deps = makeDeps()
    await run(baseCtx({ envLocalPath }), deps)
    expect(existsSync(envLocalPath)).toBe(false)
    expect(existsSync(`${envLocalPath}.tier1.bak`)).toBe(true)
    expect(readFileSync(`${envLocalPath}.tier1.bak`, 'utf8')).toContain('127.0.0.1:54321')
  })

  it('rewrite-config updates profile manifest mode to cloud_sb (issue #23)', async () => {
    const profileManifestPath = join(root, 'profile.json')
    writeFileSync(
      profileManifestPath,
      JSON.stringify({ name: 'default', mode: 'local_pg', port_offset: 0, created_at: 'orig' }),
    )
    const deps = makeDeps()
    await run(baseCtx({ profileManifestPath }), deps)
    const m = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
    expect(m.mode).toBe('cloud_sb')
    expect(m.name).toBe('default')
    expect(m.port_offset).toBe(0)
    expect(m.created_at).toBe('orig')
  })

  it('rewrite-config tolerates missing profile manifest', async () => {
    const profileManifestPath = join(root, 'nope.json')
    const deps = makeDeps()
    await expect(run(baseCtx({ profileManifestPath }), deps)).resolves.toBeDefined()
    expect(existsSync(profileManifestPath)).toBe(false)
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

describe('stepWireAuth (via run)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plannen-wire-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('calls updateAuthConfig with siteUrl=localhost + localhost wildcard', async () => {
    const calls: any[] = []
    const deps = {
      log: () => {},
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { tools: [{ name: 'x' }] } }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => {},
        updateAuthConfig: async (token: string, ref: string, patch: any) => {
          calls.push({ token, ref, patch })
          return { changed: true }
        },
        readAccessToken: () => 'tok',
      },
      rewriteStorageUrls: async () => ({ memories: 0, stories: 0 }),
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nexpose-schemas\nrestore-data\nupload-photos\ndeploy\nrewrite-config\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(calls).toHaveLength(1)
    expect(calls[0].patch.siteUrl).toBe('http://localhost:4321')
    expect(calls[0].patch.addAllowList).toContain('http://localhost:4321/**')
  })

  it('skips with a log line when no access token is available', async () => {
    const logs: string[] = []
    const deps = {
      log: (s: string) => { logs.push(s) },
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { tools: [{ name: 'x' }] } }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => {},
        updateAuthConfig: async () => { throw new Error('should not be called') },
        readAccessToken: () => null,
      },
      rewriteStorageUrls: async () => ({ memories: 0, stories: 0 }),
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nexpose-schemas\nrestore-data\nupload-photos\ndeploy\nrewrite-config\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(logs.some((l) => /wire-auth: skipping/i.test(l))).toBe(true)
  })
})

describe('stepExposeSchemas (via run)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plannen-expose-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('calls setExposedSchemas with [plannen,public,graphql_public]', async () => {
    const calls: any[] = []
    const deps = {
      log: () => {},
      // Stub every other step so we can isolate expose-schemas.
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { tools: [{ name: 'x' }] } }) }),
      supabaseMgmt: {
        setExposedSchemas: async (token: string, ref: string, schemas: string[]) => {
          calls.push({ token, ref, schemas })
        },
        updateAuthConfig: async () => ({ changed: false }),
        readAccessToken: () => 'tok',
      },
      rewriteStorageUrls: async () => ({ memories: 0, stories: 0 }),
    }
    // Pre-populate progress so we only run expose-schemas.
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nrestore-data\nupload-photos\ndeploy\nrewrite-config\nverify\n')
    // Now reset to test just expose-schemas + downstream skipping.
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\n')
    // Provide enough ctx to skip later steps' preconditions.
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(calls).toHaveLength(1)
    expect(calls[0].schemas).toEqual(['plannen', 'public', 'graphql_public'])
    expect(calls[0].ref).toBe('abcd1234abcd1234abcd')
  })

  it('skips with a log line when no access token is available', async () => {
    const logs: string[] = []
    const deps = {
      log: (s: string) => { logs.push(s) },
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { tools: [{ name: 'x' }] } }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => { throw new Error('should not be called') },
        updateAuthConfig: async () => ({ changed: false }),
        readAccessToken: () => null,
      },
      rewriteStorageUrls: async () => ({ memories: 0, stories: 0 }),
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(logs.some((l) => /expose-schemas: skipping/i.test(l))).toBe(true)
  })
})

describe('stepRewriteStorageUrls (via run)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plannen-rewrite-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('rewrites Tier 1 storage URLs to the cloud storage URL', async () => {
    const calls: { sql: string; params: any[] }[] = []
    const rewriteStorageUrls = async () => {
      calls.push({ sql: 'invoked', params: [] })
      return { memories: 22, stories: 6 }
    }
    const deps = {
      log: () => {},
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { tools: [{ name: 'x' }] } }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => {},
        updateAuthConfig: async () => ({ changed: false }),
        readAccessToken: () => null,
      },
      rewriteStorageUrls,
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nexpose-schemas\nrestore-data\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(calls).toHaveLength(1)
  })
})
