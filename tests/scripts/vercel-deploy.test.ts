import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import {
  pickEnvForVercel,
  parseDeployUrl,
  vercelLoggedIn,
  vercelEnvRm,
  vercelEnvAdd,
  vercelDeploy,
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

    // Sync calls: whoami + 3 rm + 1 deploy = 5
    expect(syncCalls.length).toBe(5)
    expect(syncCalls[0].args).toEqual(['whoami'])
    expect(syncCalls[4].args).toEqual(['--prod'])
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
