import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { makeClaudeCliProvider } from './claude-cli.js'
import type { RunCli } from './run-cli.js'
import type { AISettings } from '../ai.js'

const settings: AISettings = {
  provider: 'claude-code-cli',
  api_key: null,
  default_model: null,
  base_url: null,
  user_id: 'test-user',
}

// Minimal fake HandlerCtx for tests — provider methods don't use ctx.db.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { userId: 'test-user', db: {} } as any

describe('claudeCliProvider.generate', () => {
  it('returns wrapper.result on success', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: 'hello world', is_error: false }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    const out = await provider.generate(ctx, { prompt: 'say hi' })
    expect(out).toBe('hello world')
    expect(runCli).toHaveBeenCalledWith(
      'claude',
      ['-p', '--output-format=json'],
      expect.objectContaining({ timeoutMs: 90_000, input: 'say hi' }),
    )
  })

  it('appends --allowed-tools WebSearch when tools include web_search', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: 'searched', is_error: false }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await provider.generate(ctx, { prompt: 'find events', tools: ['web_search'] })
    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('--allowed-tools')
    expect(calledArgs).toContain('WebSearch')
    // Prompt must NOT be in argv — it would be swallowed by the variadic
    // --allowed-tools flag. It rides on stdin instead.
    expect(calledArgs).not.toContain('find events')
    const opts = runCli.mock.calls[0][2]
    expect(opts.input).toBe('find events')
  })
})

describe('claudeCliProvider.generateStructured', () => {
  const schema = z.object({ city: z.string(), days: z.number() })

  it('parses JSON from wrapper.result and validates against schema', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({
        result: '```json\n{"city": "Brussels", "days": 3}\n```',
        is_error: false,
      }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    const out = await provider.generateStructured(ctx, { prompt: 'pick a city', schema })
    expect(out).toEqual({ city: 'Brussels', days: 3 })
    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('-p')
    expect(calledArgs).toContain('--output-format=json')
    const stdinPrompt = runCli.mock.calls[0][2].input
    expect(stdinPrompt).toMatch(/Return ONLY a JSON value/)
    expect(stdinPrompt).toMatch(/pick a city/)
  })

  it('appends --allowed-tools WebSearch when tools include web_search', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"city": "Brussels", "days": 1}', is_error: false }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await provider.generateStructured(ctx, { prompt: 'search', schema, tools: ['web_search'] })
    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('--allowed-tools')
    expect(calledArgs).toContain('WebSearch')
  })

  it('throws unknown_error when wrapper.result does not match schema', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"city": "Brussels"}', is_error: false }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generateStructured(ctx, { prompt: 'pick', schema }))
      .rejects.toMatchObject({ code: 'unknown_error' })
  })
})

describe('claudeCliProvider.generateFromImage', () => {
  it('writes temp file, calls claude with --allowed-tools Read and path in prompt, unlinks temp file', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ result: 'an image of a dog', is_error: false }),
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({
      runCli,
      tmpDir: () => '/tmp',
      uuid: () => 'fixed-uuid',
    })(settings)

    const out = await provider.generateFromImage(ctx, {
      imageBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      prompt: 'what is this',
    })
    expect(out).toBe('an image of a dog')

    const calledArgs = runCli.mock.calls[0][1]
    expect(calledArgs).toContain('--allowed-tools')
    expect(calledArgs).toContain('Read')
    const stdinPrompt = runCli.mock.calls[0][2].input
    expect(stdinPrompt).toContain('/tmp/plannen-img-fixed-uuid.png')
    expect(stdinPrompt).toContain('what is this')

    const { access } = await import('node:fs/promises')
    await expect(access('/tmp/plannen-img-fixed-uuid.png')).rejects.toThrow()
  })

  it('throws unknown_error on unsupported mime type', async () => {
    const runCli = vi.fn<RunCli>()
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generateFromImage(ctx, {
      imageBytes: new Uint8Array([]),
      mimeType: 'image/svg+xml',
      prompt: 'x',
    })).rejects.toMatchObject({ code: 'unknown_error' })
    expect(runCli).not.toHaveBeenCalled()
  })

  it('unlinks temp file even when subprocess fails', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'not json',
      stderr: '',
      exitCode: 0,
    })
    const provider = makeClaudeCliProvider({
      runCli,
      tmpDir: () => '/tmp',
      uuid: () => 'fail-uuid',
    })(settings)
    await expect(provider.generateFromImage(ctx, {
      imageBytes: new Uint8Array([0x89, 0x50]),
      mimeType: 'image/jpeg',
      prompt: 'x',
    })).rejects.toMatchObject({ code: 'unknown_error' })
    const { access } = await import('node:fs/promises')
    await expect(access('/tmp/plannen-img-fail-uuid.jpg')).rejects.toThrow()
  })
})

describe('claudeCliProvider error mapping', () => {
  it('ENOENT from runCli → no_provider_configured', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'no_provider_configured' })
  })

  it('ETIMEDOUT from runCli → provider_unavailable', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('non-zero exit code → provider_unavailable with stderr in message', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: '', stderr: 'boom', exitCode: 2,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'provider_unavailable', message: expect.stringContaining('boom') })
  })

  it('is_error wrapper with auth message → invalid_api_key', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ is_error: true, message: 'Please log in by running claude' }),
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_api_key' })
  })

  it('is_error wrapper with rate/credit message → rate_limited', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ is_error: true, message: 'Monthly credit exhausted', retry_after: 120 }),
      stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120 })
  })

  it('unparseable stdout JSON → unknown_error', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'this is not json', stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'unknown_error' })
  })

  it('wrapper missing .result string → unknown_error', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: JSON.stringify({ is_error: false }), stderr: '', exitCode: 0,
    })
    const provider = makeClaudeCliProvider({ runCli })(settings)
    await expect(provider.generate(ctx, { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'unknown_error' })
  })
})
