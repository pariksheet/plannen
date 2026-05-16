import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import {
  validateProjectRef,
  parseApiKeys,
  cloudUrlFor,
  isLoggedIn,
  linkProject,
  fetchApiKeys,
  run,
} from '../../scripts/lib/cloud-link.mjs'

type CliCall = { args: string[]; input?: string }

function makeCli(
  responses: Record<string, { status: number; stdout?: string; stderr?: string }>,
) {
  const calls: CliCall[] = []
  const cli = (args: string[], opts?: { input?: string }) => {
    calls.push({ args, input: opts?.input })
    const key = args.join(' ')
    const r = responses[key] ?? { status: 1, stderr: `unmocked: supabase ${key}` }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { cli, calls }
}

describe('validateProjectRef', () => {
  it('accepts 20-char lowercase slugs', () => {
    expect(validateProjectRef('abcdefghijklmnopqrst')).toBe(true)
    expect(validateProjectRef('aaaaaaaaaaaaaaaaaaaa')).toBe(true)
  })
  it('accepts alphanumeric within the length window', () => {
    expect(validateProjectRef('abc123def456ghi789')).toBe(true)
  })
  it('rejects too-short / too-long / uppercase / non-string', () => {
    expect(validateProjectRef('short')).toBe(false)
    expect(validateProjectRef('A'.repeat(20))).toBe(false)
    expect(validateProjectRef('a'.repeat(40))).toBe(false)
    expect(validateProjectRef('')).toBe(false)
    // @ts-expect-error testing non-string
    expect(validateProjectRef(null)).toBe(false)
    // @ts-expect-error testing non-string
    expect(validateProjectRef(123)).toBe(false)
  })
})

describe('parseApiKeys', () => {
  it('extracts anon and service_role from a JSON array', () => {
    const input = JSON.stringify([
      { name: 'anon', api_key: 'eyJxxx_anon' },
      { name: 'service_role', api_key: 'eyJxxx_sr' },
    ])
    expect(parseApiKeys(input)).toEqual({
      anonKey: 'eyJxxx_anon',
      serviceRoleKey: 'eyJxxx_sr',
    })
  })

  it('accepts a pre-parsed array', () => {
    const data = [
      { name: 'anon', api_key: 'a' },
      { name: 'service_role', api_key: 's' },
    ]
    expect(parseApiKeys(data)).toEqual({ anonKey: 'a', serviceRoleKey: 's' })
  })

  it('throws when anon or service_role is missing', () => {
    expect(() => parseApiKeys([{ name: 'anon', api_key: 'a' }])).toThrow(/service_role/)
    expect(() => parseApiKeys([{ name: 'service_role', api_key: 's' }])).toThrow(/anon/)
  })

  it('throws when input is not an array', () => {
    expect(() => parseApiKeys('{}')).toThrow(/array/)
  })
})

describe('cloudUrlFor', () => {
  it('builds the canonical cloud URL', () => {
    expect(cloudUrlFor('abcdefghijklmnopqrst')).toBe('https://abcdefghijklmnopqrst.supabase.co')
  })
  it('rejects invalid refs', () => {
    expect(() => cloudUrlFor('bad')).toThrow(/invalid/)
  })
})

describe('isLoggedIn', () => {
  it('returns true when `projects list` exits 0', () => {
    const { cli } = makeCli({ 'projects list': { status: 0, stdout: '...' } })
    expect(isLoggedIn({ cli })).toBe(true)
  })
  it('returns false on non-zero exit', () => {
    const { cli } = makeCli({ 'projects list': { status: 1, stderr: 'not logged in' } })
    expect(isLoggedIn({ cli })).toBe(false)
  })
})

describe('linkProject', () => {
  it('calls `supabase link --project-ref <ref>`', () => {
    const { cli, calls } = makeCli({
      'link --project-ref abcdefghijklmnopqrst': { status: 0 },
    })
    linkProject('abcdefghijklmnopqrst', { cli })
    expect(calls[0].args).toEqual(['link', '--project-ref', 'abcdefghijklmnopqrst'])
  })
  it('throws on invalid ref before touching the CLI', () => {
    const { cli, calls } = makeCli({})
    expect(() => linkProject('bad', { cli })).toThrow(/invalid/)
    expect(calls).toHaveLength(0)
  })
  it('propagates CLI errors', () => {
    const { cli } = makeCli({
      'link --project-ref abcdefghijklmnopqrst': { status: 1, stderr: 'boom' },
    })
    expect(() => linkProject('abcdefghijklmnopqrst', { cli })).toThrow(/exit 1.*boom/)
  })
})

describe('fetchApiKeys', () => {
  it('parses the JSON stdout', () => {
    const body = JSON.stringify([
      { name: 'anon', api_key: 'A' },
      { name: 'service_role', api_key: 'S' },
    ])
    const { cli } = makeCli({
      'projects api-keys --project-ref abcdefghijklmnopqrst --output json': {
        status: 0,
        stdout: body,
      },
    })
    expect(fetchApiKeys('abcdefghijklmnopqrst', { cli })).toEqual({
      anonKey: 'A',
      serviceRoleKey: 'S',
    })
  })
})

describe('run', () => {
  const VALID = 'abcdefghijklmnopqrst'

  it('populates the ctx with project ref, URL, and keys', async () => {
    const apiKeysBody = JSON.stringify([
      { name: 'anon', api_key: 'A' },
      { name: 'service_role', api_key: 'S' },
    ])
    const { cli, calls } = makeCli({
      'projects list': { status: 0 },
      [`link --project-ref ${VALID}`]: { status: 0 },
      [`projects api-keys --project-ref ${VALID} --output json`]: { status: 0, stdout: apiKeysBody },
    })

    const ctx = await run({ projectRef: VALID }, { cli })

    expect(ctx.projectRef).toBe(VALID)
    expect(ctx.cloudSupabaseUrl).toBe(`https://${VALID}.supabase.co`)
    expect(ctx.cloudAnonKey).toBe('A')
    expect(ctx.cloudServiceRoleKey).toBe('S')
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'projects list',
      `link --project-ref`,
      `projects api-keys`,
    ])
  })

  it('preserves prior ctx fields', async () => {
    const apiKeysBody = JSON.stringify([
      { name: 'anon', api_key: 'A' },
      { name: 'service_role', api_key: 'S' },
    ])
    const { cli } = makeCli({
      'projects list': { status: 0 },
      [`link --project-ref ${VALID}`]: { status: 0 },
      [`projects api-keys --project-ref ${VALID} --output json`]: { status: 0, stdout: apiKeysBody },
    })

    const ctx = await run({ projectRef: VALID, carry: 'kept' }, { cli })
    expect(ctx.carry).toBe('kept')
  })

  it('fails fast when not logged in', async () => {
    const { cli } = makeCli({ 'projects list': { status: 1, stderr: 'no session' } })
    await expect(run({ projectRef: VALID }, { cli })).rejects.toThrow(/not logged in/)
  })

  it('fails fast when project ref missing', async () => {
    const { cli } = makeCli({ 'projects list': { status: 0 } })
    const oldEnv = process.env.SUPABASE_PROJECT_REF
    delete process.env.SUPABASE_PROJECT_REF
    try {
      await expect(run({}, { cli })).rejects.toThrow(/SUPABASE_PROJECT_REF/)
    } finally {
      if (oldEnv) process.env.SUPABASE_PROJECT_REF = oldEnv
    }
  })

  it('fails fast on invalid project ref format', async () => {
    const { cli } = makeCli({ 'projects list': { status: 0 } })
    await expect(run({ projectRef: 'bad' }, { cli })).rejects.toThrow(/invalid project ref/)
  })
})
