import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module
import {
  generateBearer,
  discoverFunctions,
  orderFunctionsForDeploy,
  buildSecretPairs,
  deployFunction,
  setSecrets,
  run,
} from '../../scripts/lib/cloud-deploy.mjs'

type CliCall = { args: string[] }

function makeCli(
  responses: Record<string, { status: number; stdout?: string; stderr?: string }>,
) {
  const calls: CliCall[] = []
  const cli = (args: string[]) => {
    calls.push({ args })
    const key = args.join(' ')
    const r = responses[key] ?? responses['*'] ?? {
      status: 1,
      stderr: `unmocked: supabase ${key}`,
    }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { cli, calls }
}

describe('generateBearer', () => {
  it('returns 64 hex chars for 32 random bytes', () => {
    const stubRng = (n: number) => Buffer.alloc(n, 0xab)
    expect(generateBearer(stubRng)).toBe('ab'.repeat(32))
  })
  it('uses crypto.randomBytes by default and yields hex of correct length', () => {
    const b = generateBearer()
    expect(b).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('discoverFunctions', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-funcs-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function fn(name: string, withIndex = true) {
    mkdirSync(join(root, name), { recursive: true })
    if (withIndex) writeFileSync(join(root, name, 'index.ts'), '// stub')
  }

  it('returns [] when the dir does not exist', () => {
    expect(discoverFunctions(join(root, 'missing'))).toEqual([])
  })

  it('lists subdirs that contain an index.ts, sorted', () => {
    fn('agent-discover')
    fn('mcp')
    fn('memory-image')
    expect(discoverFunctions(root)).toEqual(['agent-discover', 'mcp', 'memory-image'])
  })

  it('skips _shared, node_modules, dotfiles, and dirs without index.ts', () => {
    fn('mcp')
    fn('_shared')
    fn('node_modules', false)
    mkdirSync(join(root, '.cache'), { recursive: true })
    fn('not-a-function', false) // no index.ts
    writeFileSync(join(root, 'package.json'), '{}') // file, not dir
    expect(discoverFunctions(root)).toEqual(['mcp'])
  })
})

describe('orderFunctionsForDeploy', () => {
  it('places mcp first, alpha order for the rest', () => {
    expect(orderFunctionsForDeploy(['memory-image', 'agent-discover', 'mcp'])).toEqual([
      'mcp',
      'agent-discover',
      'memory-image',
    ])
  })

  it('leaves the list alone when mcp is absent', () => {
    expect(orderFunctionsForDeploy(['b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('handles mcp already at the front', () => {
    expect(orderFunctionsForDeploy(['mcp', 'a', 'b'])).toEqual(['mcp', 'a', 'b'])
  })

  it('does not mutate input', () => {
    const input = ['a', 'mcp', 'b']
    orderFunctionsForDeploy(input)
    expect(input).toEqual(['a', 'mcp', 'b'])
  })
})

describe('buildSecretPairs', () => {
  it('emits only fields that are present', () => {
    expect(
      buildSecretPairs({
        userEmail: 'a@b.com',
        mcpBearerToken: 'tok',
      }),
    ).toEqual(['PLANNEN_USER_EMAIL=a@b.com', 'MCP_BEARER_TOKEN=tok'])
  })

  it('includes Google + Anthropic when present', () => {
    expect(
      buildSecretPairs({
        userEmail: 'x',
        mcpBearerToken: 'y',
        googleClientId: 'gci',
        googleClientSecret: 'gcs',
        anthropicApiKey: 'sk-ant-xxx',
      }),
    ).toEqual([
      'PLANNEN_USER_EMAIL=x',
      'MCP_BEARER_TOKEN=y',
      'GOOGLE_CLIENT_ID=gci',
      'GOOGLE_CLIENT_SECRET=gcs',
      'ANTHROPIC_API_KEY=sk-ant-xxx',
    ])
  })

  it('merges extraSecrets at the end', () => {
    expect(
      buildSecretPairs({
        userEmail: 'x',
        mcpBearerToken: 'y',
        extraSecrets: { FOO: '1', BAR: '2' },
      }),
    ).toEqual(['PLANNEN_USER_EMAIL=x', 'MCP_BEARER_TOKEN=y', 'FOO=1', 'BAR=2'])
  })

  it('skips empty strings, null, and undefined', () => {
    expect(
      buildSecretPairs({
        userEmail: 'x',
        mcpBearerToken: '',
        googleClientId: null,
        googleClientSecret: undefined,
      }),
    ).toEqual(['PLANNEN_USER_EMAIL=x'])
  })
})

describe('deployFunction', () => {
  it('calls `functions deploy <name> --project-ref <ref>` for non-mcp', () => {
    const { cli, calls } = makeCli({ '*': { status: 0 } })
    deployFunction('agent-discover', 'projref', { cli })
    expect(calls[0].args).toEqual([
      'functions',
      'deploy',
      'agent-discover',
      '--project-ref',
      'projref',
    ])
  })

  it('adds --no-verify-jwt for mcp', () => {
    const { cli, calls } = makeCli({ '*': { status: 0 } })
    deployFunction('mcp', 'projref', { cli })
    expect(calls[0].args).toEqual([
      'functions',
      'deploy',
      'mcp',
      '--project-ref',
      'projref',
      '--no-verify-jwt',
    ])
  })

  it('throws on non-zero', () => {
    const { cli } = makeCli({ '*': { status: 1, stderr: 'boom' } })
    expect(() => deployFunction('mcp', 'p', { cli })).toThrow(/exit 1.*boom/)
  })
})

describe('setSecrets', () => {
  it('is a no-op for empty pairs', () => {
    const { cli, calls } = makeCli({})
    setSecrets([], 'p', { cli })
    expect(calls).toEqual([])
  })

  it('passes all pairs in one invocation', () => {
    const { cli, calls } = makeCli({ '*': { status: 0 } })
    setSecrets(['A=1', 'B=2'], 'projref', { cli })
    expect(calls[0].args).toEqual([
      'secrets',
      'set',
      '--project-ref',
      'projref',
      'A=1',
      'B=2',
    ])
  })
})

describe('run', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-funcs-'))
    function fn(name: string) {
      mkdirSync(join(root, name), { recursive: true })
      writeFileSync(join(root, name, 'index.ts'), '// stub')
    }
    fn('mcp')
    fn('agent-discover')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sets secrets first, then deploys mcp, then others', async () => {
    const { cli, calls } = makeCli({ '*': { status: 0 } })
    const ctx = await run(
      {
        projectRef: 'projref',
        userEmail: 'me@x.com',
        mcpBearerToken: 'tok',
      },
      { cli, functionsDir: root },
    )

    expect(ctx.deployedFunctions).toEqual(['mcp', 'agent-discover'])
    expect(ctx.mcpBearerToken).toBe('tok')

    // First call: secrets set
    expect(calls[0].args.slice(0, 2)).toEqual(['secrets', 'set'])
    expect(calls[0].args).toContain('PLANNEN_USER_EMAIL=me@x.com')
    expect(calls[0].args).toContain('MCP_BEARER_TOKEN=tok')
    // Second call: deploy mcp
    expect(calls[1].args).toContain('mcp')
    expect(calls[1].args).toContain('--no-verify-jwt')
    // Third call: deploy agent-discover
    expect(calls[2].args).toContain('agent-discover')
    expect(calls[2].args).not.toContain('--no-verify-jwt')
  })

  it('generates a bearer when none provided', async () => {
    const stubRng = (n: number) => Buffer.alloc(n, 0x11)
    const { cli } = makeCli({ '*': { status: 0 } })
    const ctx = await run(
      { projectRef: 'projref', userEmail: 'me' },
      { cli, functionsDir: root, rng: stubRng },
    )
    expect(ctx.mcpBearerToken).toBe('11'.repeat(32))
  })

  it('aborts the run when mcp deploy fails (does not deploy others)', async () => {
    const { cli, calls } = makeCli({
      'secrets set --project-ref projref PLANNEN_USER_EMAIL=me MCP_BEARER_TOKEN=tok': { status: 0 },
      'functions deploy mcp --project-ref projref --no-verify-jwt': {
        status: 1,
        stderr: 'bundle error',
      },
    })
    await expect(
      run(
        { projectRef: 'projref', userEmail: 'me', mcpBearerToken: 'tok' },
        { cli, functionsDir: root },
      ),
    ).rejects.toThrow(/bundle error/)
    // Two calls before throw: secrets set, then mcp deploy. agent-discover never attempted.
    expect(calls.length).toBe(2)
    expect(calls[1].args[2]).toBe('mcp')
  })

  it('requires projectRef', async () => {
    await expect(run({})).rejects.toThrow(/projectRef/)
  })
})
