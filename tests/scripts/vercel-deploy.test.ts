import { describe, it, expect } from 'vitest'
// @ts-ignore — .mjs module
import {
  pickEnvForVercel,
  parseDeployUrl,
  vercelLoggedIn,
  vercelEnvRm,
  vercelEnvAdd,
  vercelDeploy,
  vercelLink,
  parseInspectAliases,
  findStableAlias,
  upsertEnvKey,
  run,
} from '../../scripts/lib/vercel-deploy.mjs'

type CliCall = { args: string[]; input?: string }

function makeSyncCli(
  responses: Record<string, { status: number; stdout?: string; stderr?: string }>,
) {
  const calls: CliCall[] = []
  const cli = (args: string[]) => {
    calls.push({ args })
    const key = args.join(' ')
    const r = responses[key] ?? responses['*'] ?? {
      status: 1,
      stderr: `unmocked: vercel ${key}`,
    }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { cli, calls }
}

function makeStdinCli(responses: Record<string, { status: number }>) {
  const calls: CliCall[] = []
  const cli = async (args: string[], input: string) => {
    calls.push({ args, input })
    const key = args.join(' ')
    const r = responses[key] ?? responses['*'] ?? { status: 0 }
    return { status: r.status, stdout: '', stderr: '' }
  }
  return { cli, calls }
}

describe('pickEnvForVercel', () => {
  it('extracts VITE_* keys with values', () => {
    const env = [
      'PLANNEN_TIER=2',
      'PLANNEN_USER_EMAIL=me@x.com',
      'VITE_SUPABASE_URL=https://abc.supabase.co',
      'VITE_SUPABASE_ANON_KEY=ey-xxx',
      'VITE_PLANNEN_TIER=2',
    ].join('\n')
    expect(pickEnvForVercel(env)).toEqual({
      VITE_SUPABASE_URL: 'https://abc.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'ey-xxx',
      VITE_PLANNEN_TIER: '2',
    })
  })

  it('skips comments and blank lines', () => {
    const env = `# header\n\nVITE_X=1\n# inline note\nVITE_Y=2\n`
    expect(pickEnvForVercel(env)).toEqual({ VITE_X: '1', VITE_Y: '2' })
  })

  it('strips matching quotes', () => {
    const env = `VITE_A="quoted"\nVITE_B='single'\nVITE_C=mixed"\n`
    const out = pickEnvForVercel(env)
    expect(out.VITE_A).toBe('quoted')
    expect(out.VITE_B).toBe('single')
    expect(out.VITE_C).toBe('mixed"')
  })

  it('skips empty values', () => {
    const env = `VITE_KEEP=x\nVITE_SKIP=\n`
    expect(pickEnvForVercel(env)).toEqual({ VITE_KEEP: 'x' })
  })

  it('ignores non-VITE keys', () => {
    const env = `MY_SECRET=do-not-leak\nVITE_OK=ok\n`
    expect(pickEnvForVercel(env)).toEqual({ VITE_OK: 'ok' })
  })

  it('handles empty body', () => {
    expect(pickEnvForVercel('')).toEqual({})
  })
})

describe('upsertEnvKey', () => {
  it('replaces an existing key in place', () => {
    const before = 'A=1\nPLANNEN_WEB_URL=old\nB=2\n'
    const after = upsertEnvKey(before, 'PLANNEN_WEB_URL', 'https://new.vercel.app')
    expect(after).toBe('A=1\nPLANNEN_WEB_URL=https://new.vercel.app\nB=2\n')
  })

  it('appends a new key when missing', () => {
    const before = 'A=1\nB=2\n'
    const after = upsertEnvKey(before, 'PLANNEN_WEB_URL', 'https://x.vercel.app')
    expect(after).toBe('A=1\nB=2\nPLANNEN_WEB_URL=https://x.vercel.app\n')
  })

  it('appends with a leading newline if the file does not end with one', () => {
    const before = 'A=1'
    const after = upsertEnvKey(before, 'B', '2')
    expect(after).toBe('A=1\nB=2\n')
  })
})

describe('parseDeployUrl', () => {
  it('matches the explicit "Production:" line', () => {
    const out = `✅ Production: https://plannen.vercel.app [123ms]`
    expect(parseDeployUrl(out)).toBe('https://plannen.vercel.app')
  })

  it('matches the inspect URL when no Production line', () => {
    const out = `Inspect: https://vercel.com/me/plannen/abc\nhttps://plannen-abc.vercel.app`
    expect(parseDeployUrl(out)).toBe('https://plannen-abc.vercel.app')
  })

  it('returns null on no URL', () => {
    expect(parseDeployUrl('build failed')).toBeNull()
    expect(parseDeployUrl('')).toBeNull()
    expect(parseDeployUrl(null as unknown as string)).toBeNull()
  })

  it('is case-insensitive on "Production"', () => {
    expect(parseDeployUrl('PRODUCTION: https://x.vercel.app')).toBe('https://x.vercel.app')
  })
})

describe('vercelLoggedIn', () => {
  it('true on `whoami` exit 0', () => {
    const { cli } = makeSyncCli({ whoami: { status: 0, stdout: 'me@x.com' } })
    expect(vercelLoggedIn({ cli })).toBe(true)
  })
  it('false on non-zero', () => {
    const { cli } = makeSyncCli({ whoami: { status: 1, stderr: 'not logged in' } })
    expect(vercelLoggedIn({ cli })).toBe(false)
  })
})

describe('vercelEnvRm', () => {
  it('runs `env rm NAME ENV --yes`', () => {
    const { cli, calls } = makeSyncCli({ '*': { status: 0 } })
    expect(vercelEnvRm('VITE_X', 'production', { cli })).toBe(true)
    expect(calls[0].args).toEqual(['env', 'rm', 'VITE_X', 'production', '--yes'])
  })
  it('returns false (does not throw) when the env var is absent', () => {
    const { cli } = makeSyncCli({ '*': { status: 1, stderr: 'not found' } })
    expect(vercelEnvRm('VITE_MISSING', 'production', { cli })).toBe(false)
  })
})

describe('vercelEnvAdd', () => {
  it('passes value via stdin', async () => {
    const { cli, calls } = makeStdinCli({ '*': { status: 0 } })
    await vercelEnvAdd('VITE_X', 'value', 'production', { cli })
    expect(calls[0].args).toEqual(['env', 'add', 'VITE_X', 'production'])
    expect(calls[0].input).toBe('value')
  })
  it('throws on non-zero exit', async () => {
    const { cli } = makeStdinCli({ '*': { status: 1 } })
    await expect(vercelEnvAdd('X', 'v', 'production', { cli })).rejects.toThrow(/exit 1/)
  })
})

describe('vercelDeploy', () => {
  it('passes --prod by default and parses URL', () => {
    const { cli, calls } = makeSyncCli({
      '--prod': { status: 0, stdout: 'Production: https://plannen.vercel.app' },
    })
    const r = vercelDeploy({}, { cli })
    expect(calls[0].args).toEqual(['--prod'])
    expect(r.url).toBe('https://plannen.vercel.app')
  })

  it('runs preview deploy when prod=false', () => {
    const { cli, calls } = makeSyncCli({ '': { status: 0, stdout: 'https://x.vercel.app' } })
    vercelDeploy({ prod: false }, { cli })
    expect(calls[0].args).toEqual([])
  })

  it('throws on deploy failure', () => {
    const { cli } = makeSyncCli({ '--prod': { status: 1, stderr: 'build failed' } })
    expect(() => vercelDeploy({}, { cli })).toThrow(/build failed/)
  })
})

describe('run (orchestrator)', () => {
  const envText = [
    'PLANNEN_TIER=2',
    'VITE_SUPABASE_URL=https://abc.supabase.co',
    'VITE_SUPABASE_ANON_KEY=ey-xxx',
    'VITE_PLANNEN_TIER=2',
  ].join('\n')

  it('rms then adds each var, then deploys, then returns URL', async () => {
    const { cli: syncCli, calls: syncCalls } = makeSyncCli({
      whoami: { status: 0 },
      'env rm VITE_SUPABASE_URL production --yes': { status: 0 },
      'env rm VITE_SUPABASE_ANON_KEY production --yes': { status: 0 },
      'env rm VITE_PLANNEN_TIER production --yes': { status: 0 },
      '--prod': { status: 0, stdout: 'Production: https://plannen.vercel.app' },
    })
    const { cli: stdinCli, calls: stdinCalls } = makeStdinCli({ '*': { status: 0 } })

    const out = await run(
      { envText },
      { cli: syncCli, cliWithStdin: stdinCli, log: () => {} },
    )

    expect(out.pushedKeys).toEqual([
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'VITE_PLANNEN_TIER',
    ])
    expect(out.deploymentUrl).toBe('https://plannen.vercel.app')

    // 3 stdin adds (one per key).
    expect(stdinCalls.length).toBe(3)
    expect(stdinCalls[0].input).toBe('https://abc.supabase.co')

    // Sync calls: whoami + 3 rm + 1 deploy + 1 inspect = 6
    expect(syncCalls.length).toBe(6)
    expect(syncCalls[0].args).toEqual(['whoami'])
    expect(syncCalls[4].args).toEqual(['--prod'])
    expect(syncCalls[5].args[0]).toBe('inspect')
  })

  it('throws when not logged in', async () => {
    const { cli } = makeSyncCli({ whoami: { status: 1 } })
    const { cli: stdinCli } = makeStdinCli({})
    await expect(
      run({ envText }, { cli, cliWithStdin: stdinCli, log: () => {} }),
    ).rejects.toThrow(/not logged in/)
  })

  it('throws when no VITE_ keys in env', async () => {
    const { cli } = makeSyncCli({ whoami: { status: 0 } })
    const { cli: stdinCli } = makeStdinCli({})
    await expect(
      run(
        { envText: 'PLANNEN_TIER=2\n' },
        { cli, cliWithStdin: stdinCli, log: () => {} },
      ),
    ).rejects.toThrow(/no VITE_\*/)
  })

  it('proceeds when env rm is a no-op (var didn\'t exist)', async () => {
    const { cli } = makeSyncCli({
      whoami: { status: 0 },
      'env rm VITE_X production --yes': { status: 1, stderr: 'not found' }, // ← absent
      '--prod': { status: 0, stdout: 'Production: https://x.vercel.app' },
    })
    const { cli: stdinCli, calls: stdinCalls } = makeStdinCli({ '*': { status: 0 } })

    const out = await run(
      { envText: 'VITE_X=value\n' },
      { cli, cliWithStdin: stdinCli, log: () => {} },
    )
    expect(out.deploymentUrl).toBe('https://x.vercel.app')
    expect(stdinCalls[0].input).toBe('value')
  })
})

describe('vercelLink', () => {
  it('runs `vercel link --yes` and returns success', () => {
    const calls: any[] = []
    const cli = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: 'Linked to team/proj', stderr: '' }
    }
    const r = vercelLink({ yes: true }, { cli })
    expect(calls[0]).toEqual(['link', '--yes'])
    expect(r.status).toBe(0)
  })

  it('throws with vercel stderr on non-zero exit', () => {
    const cli = () => ({ status: 1, stdout: '', stderr: 'team not found' })
    expect(() => vercelLink({ yes: true }, { cli })).toThrow(/team not found/)
  })
})

describe('parseInspectAliases', () => {
  it('returns all .vercel.app URLs under the Aliases header', () => {
    const out = `
  General
    id     dpl_x
    name   plannen

  Aliases

    ╶ https://plannen.vercel.app
    ╶ https://plannen-team.vercel.app

  Build
`
    
    expect(parseInspectAliases(out)).toEqual([
      'https://plannen.vercel.app',
      'https://plannen-team.vercel.app',
    ])
  })

  it('returns [] when no Aliases section', () => {
    
    expect(parseInspectAliases('Production: https://x.vercel.app')).toEqual([])
  })
})

describe('findStableAlias', () => {
  it('picks the shortest alias and excludes the deployment URL itself', () => {
    
    const deploy = 'https://plannen-h1a-team.vercel.app'
    const aliases = [
      'https://plannen-h1a-team.vercel.app',
      'https://plannen-team.vercel.app',
      'https://plannen.vercel.app',
    ]
    expect(findStableAlias(aliases, deploy)).toBe('https://plannen.vercel.app')
  })

  it('returns null when only the deployment URL is present', () => {
    
    expect(findStableAlias(['https://x.vercel.app'], 'https://x.vercel.app')).toBeNull()
  })

  it('returns null on empty input', () => {
    
    expect(findStableAlias([], 'https://x.vercel.app')).toBeNull()
  })
})

describe('run (with post-deploy auth update)', () => {
  it('updates Supabase Auth site_url and allow-list with the Vercel URL', async () => {
    const calls: any[] = []
    const cli = (args: string[]) => {
      if (args[0] === 'whoami') return { status: 0, stdout: 'user', stderr: '' }
      if (args[0] === 'env' && args[1] === 'rm') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'env' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' }
      // `vercel --prod`
      return { status: 0, stdout: 'Production: https://plannen.vercel.app', stderr: '' }
    }
    const cliWithStdin = async () => ({ status: 0, stdout: '', stderr: '' })
    const supabaseMgmt = {
      readAccessToken: () => 'tok',
      updateAuthConfig: async (token: string, ref: string, patch: any) => {
        calls.push({ token, ref, patch })
        return { changed: true }
      },
    }
    const envText = [
      'PLANNEN_TIER=2',
      'SUPABASE_PROJECT_REF=abcd1234abcd1234abcd',
      'VITE_SUPABASE_URL=https://abcd.supabase.co',
      'VITE_SUPABASE_ANON_KEY=anon',
    ].join('\n')
    const out = await run({ envText }, { cli, cliWithStdin, supabaseMgmt, log: () => {} } as any)
    expect(out.deploymentUrl).toBe('https://plannen.vercel.app')
    expect(calls).toHaveLength(1)
    expect(calls[0].ref).toBe('abcd1234abcd1234abcd')
    expect(calls[0].patch.siteUrl).toBe('https://plannen.vercel.app')
    expect(calls[0].patch.addAllowList).toContain('https://plannen.vercel.app/**')
  })

  it('logs a skip note and continues when no access token', async () => {
    const logs: string[] = []
    const cli = (args: string[]) => {
      if (args[0] === 'whoami') return { status: 0, stdout: 'user', stderr: '' }
      if (args[0] === 'env' && args[1] === 'rm') return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: 'Production: https://plannen.vercel.app', stderr: '' }
    }
    const cliWithStdin = async () => ({ status: 0, stdout: '', stderr: '' })
    const supabaseMgmt = {
      readAccessToken: () => null,
      updateAuthConfig: async () => { throw new Error('should not be called') },
    }
    const envText = 'PLANNEN_TIER=2\nSUPABASE_PROJECT_REF=abcd1234abcd1234abcd\nVITE_SUPABASE_URL=https://abcd.supabase.co\nVITE_SUPABASE_ANON_KEY=anon'
    const out = await run({ envText }, { cli, cliWithStdin, supabaseMgmt, log: (s: string) => logs.push(s) } as any)
    expect(out.deploymentUrl).toBe('https://plannen.vercel.app')
    expect(logs.some((l) => /post-deploy auth wire: skipping/i.test(l))).toBe(true)
  })

  it('uses the stable alias for Site URL instead of the per-deployment URL', async () => {
    const calls: any[] = []
    const inspectStdout = `
  General

  Aliases

    ╶ https://plannen.vercel.app
    ╶ https://plannen-acme-team.vercel.app
`
    const cli = (args: string[]) => {
      if (args[0] === 'whoami') return { status: 0, stdout: 'user', stderr: '' }
      if (args[0] === 'env') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { status: 0, stdout: inspectStdout, stderr: '' }
      return { status: 0, stdout: 'Production: https://plannen-abc123-acme-team.vercel.app', stderr: '' }
    }
    const cliWithStdin = async () => ({ status: 0, stdout: '', stderr: '' })
    const supabaseMgmt = {
      readAccessToken: () => 'tok',
      updateAuthConfig: async (_token: string, _ref: string, patch: any) => {
        calls.push({ patch })
        return { changed: true }
      },
    }
    const envText = 'PLANNEN_TIER=2\nSUPABASE_PROJECT_REF=abcd1234abcd1234abcd\nVITE_SUPABASE_URL=https://abcd.supabase.co\nVITE_SUPABASE_ANON_KEY=anon'
    const out = await run({ envText }, { cli, cliWithStdin, supabaseMgmt, log: () => {} } as any)
    // deploymentUrl stays as the per-deploy URL (truthful)…
    expect(out.deploymentUrl).toBe('https://plannen-abc123-acme-team.vercel.app')
    // …stableUrl and primaryUrl point at the alias…
    expect(out.stableUrl).toBe('https://plannen.vercel.app')
    expect(out.primaryUrl).toBe('https://plannen.vercel.app')
    // …Site URL uses the stable alias too.
    expect(calls[0].patch.siteUrl).toBe('https://plannen.vercel.app')
    // Both go into the allow-list so old per-deploy links still resolve.
    expect(calls[0].patch.addAllowList).toEqual(
      expect.arrayContaining([
        'https://plannen.vercel.app/**',
        'https://plannen-abc123-acme-team.vercel.app/**',
      ]),
    )
  })

  it('logs a warning and still returns deploymentUrl when updateAuthConfig throws', async () => {
    const logs: string[] = []
    const cli = (args: string[]) => {
      if (args[0] === 'whoami') return { status: 0, stdout: 'user', stderr: '' }
      if (args[0] === 'env' && args[1] === 'rm') return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: 'Production: https://plannen.vercel.app', stderr: '' }
    }
    const cliWithStdin = async () => ({ status: 0, stdout: '', stderr: '' })
    const supabaseMgmt = {
      readAccessToken: () => 'tok',
      updateAuthConfig: async () => { throw new Error('access token expired') },
    }
    const envText = 'PLANNEN_TIER=2\nSUPABASE_PROJECT_REF=abcd1234abcd1234abcd\nVITE_SUPABASE_URL=https://abcd.supabase.co\nVITE_SUPABASE_ANON_KEY=anon'
    const out = await run({ envText }, { cli, cliWithStdin, supabaseMgmt, log: (s: string) => logs.push(s) } as any)
    expect(out.deploymentUrl).toBe('https://plannen.vercel.app')
    expect(logs.some((l) => /post-deploy auth wire: ⚠ failed.*access token expired/i.test(l))).toBe(true)
  })
})
