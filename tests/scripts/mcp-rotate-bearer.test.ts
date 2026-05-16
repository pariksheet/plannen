import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — .mjs module
import { rotate } from '../../scripts/lib/mcp-rotate-bearer.mjs'

describe('rotate', () => {
  let root: string
  let envPath: string
  let pluginPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plannen-rot-'))
    envPath = join(root, '.env')
    pluginPath = join(root, 'plugin.json')
    writeFileSync(envPath, `PLANNEN_TIER=2\nMCP_BEARER_TOKEN=old-token\n`)
    writeFileSync(
      pluginPath,
      JSON.stringify({
        mcpServers: {
          plannen: {
            type: 'http',
            url: 'https://abc.supabase.co/functions/v1/mcp',
            headers: { Authorization: 'Bearer old-token' },
          },
        },
      }),
    )
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('pushes new bearer to cloud, then rewrites .env and plugin.json', async () => {
    const calls: string[][] = []
    const rng = (n: number) => Buffer.alloc(n, 0xff) // gives 'ff'.repeat(32)
    const cli = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: '', stderr: '' }
    }

    const out = await rotate(
      {
        projectRef: 'abcdef',
        cloudSupabaseUrl: 'https://abc.supabase.co',
        envPath,
        pluginManifestPath: pluginPath,
      },
      { cli, rng },
    )

    expect(out.bearer).toBe('ff'.repeat(32))
    expect(calls[0]).toEqual([
      'secrets',
      'set',
      '--project-ref',
      'abcdef',
      `MCP_BEARER_TOKEN=${'ff'.repeat(32)}`,
    ])

    const env = readFileSync(envPath, 'utf8')
    expect(env).toContain(`MCP_BEARER_TOKEN=${'ff'.repeat(32)}`)
    expect(env).not.toContain('MCP_BEARER_TOKEN=old-token')

    const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'))
    expect(plugin.mcpServers.plannen.headers.Authorization).toBe(
      `Bearer ${'ff'.repeat(32)}`,
    )
  })

  it('aborts (and does not touch local files) when `secrets set` fails', async () => {
    const originalEnv = readFileSync(envPath, 'utf8')
    const originalPlugin = readFileSync(pluginPath, 'utf8')
    const cli = () => ({ status: 1, stdout: '', stderr: 'permission denied' })

    await expect(
      rotate(
        {
          projectRef: 'abcdef',
          cloudSupabaseUrl: 'https://abc.supabase.co',
          envPath,
          pluginManifestPath: pluginPath,
        },
        { cli },
      ),
    ).rejects.toThrow(/permission denied/)

    expect(readFileSync(envPath, 'utf8')).toBe(originalEnv)
    expect(readFileSync(pluginPath, 'utf8')).toBe(originalPlugin)
  })

  it('requires projectRef and cloudSupabaseUrl', async () => {
    await expect(rotate({}, {})).rejects.toThrow(/projectRef/)
    await expect(rotate({ projectRef: 'x' }, {})).rejects.toThrow(/cloudSupabaseUrl/)
  })

  it('works when only .env exists (no plugin.json)', async () => {
    rmSync(pluginPath)
    const cli = () => ({ status: 0, stdout: '', stderr: '' })
    const rng = (n: number) => Buffer.alloc(n, 0xaa)

    await rotate(
      {
        projectRef: 'abc',
        cloudSupabaseUrl: 'https://abc.supabase.co',
        envPath,
        pluginManifestPath: pluginPath,
      },
      { cli, rng },
    )
    expect(readFileSync(envPath, 'utf8')).toContain(`MCP_BEARER_TOKEN=${'aa'.repeat(32)}`)
  })
})
