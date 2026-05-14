// Tier-0 AI provider that shells out to `claude -p --output-format=json` so
// users running on a Claude subscription do not need to also configure a BYOK
// console API key. See `docs/superpowers/specs/2026-05-15-tier0-claude-cli-provider-design.md`.
//
// Contract we depend on (pinned for Claude Code 1.x):
//   - `claude -p --output-format=json <prompt>` emits `{ result, is_error, ... }`
//     on stdout, exits 0 on success, non-zero on hard failure.
//   - `--allowed-tools` accepts `Read` and `WebSearch`.
//
// Anything outside that contract is normalised here into AIError so the
// dispatcher's retry + tracking logic sees the same shapes the Anthropic
// SDK path produces.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { HandlerCtx } from '../handlers/types.js'
import type { AISettings } from '../ai.js'
import { AIError, parseJsonAgainstSchema } from '../ai.js'
import type {
  AIProvider,
  GenerateOpts,
  GenerateStructuredOpts,
  GenerateFromImageOpts,
} from './types.js'
import type { RunCli } from './run-cli.js'
import { defaultRunCli } from './run-cli.js'

const DEFAULT_TIMEOUT_MS = 90_000

type Deps = {
  runCli?: RunCli
  tmpDir?: () => string
  uuid?: () => string
  binary?: string
}

export function makeClaudeCliProvider(deps: Deps = {}): (s: AISettings) => AIProvider {
  const runCli = deps.runCli ?? defaultRunCli
  const tmp = deps.tmpDir ?? tmpdir
  const uuid = deps.uuid ?? randomUUID
  const binary = deps.binary ?? 'claude'

  return (_s: AISettings): AIProvider => ({
    async generate(_ctx: HandlerCtx, opts: GenerateOpts): Promise<string> {
      const args = ['-p', '--output-format=json']
      if (opts.tools?.includes('web_search')) args.push('--allowed-tools', 'WebSearch')
      args.push(opts.prompt)
      const { result } = await invokeCli(runCli, binary, args)
      return result
    },

    async generateStructured<T>(_ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
      const jsonInstruction = '\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.'
      const args = ['-p', '--output-format=json']
      if (opts.tools?.includes('web_search')) args.push('--allowed-tools', 'WebSearch')
      args.push(opts.prompt + jsonInstruction)
      const { result } = await invokeCli(runCli, binary, args)
      return parseJsonAgainstSchema(result, opts.schema)
    },

    async generateFromImage(_ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
      const ext = extForMimeType(opts.mimeType)
      if (!ext) {
        throw new AIError('unknown_error', `Unsupported image type for CLI provider: ${opts.mimeType}`)
      }
      const path = join(tmp(), `plannen-img-${uuid()}.${ext}`)
      await writeFile(path, opts.imageBytes)
      try {
        const args = [
          '-p', '--output-format=json',
          '--allowed-tools', 'Read',
          `Analyze the image at ${path}:\n\n${opts.prompt}`,
        ]
        const { result } = await invokeCli(runCli, binary, args)
        return result
      } finally {
        await unlink(path).catch(() => { /* best-effort */ })
      }
    },
  })
}

// Convenience export: provider factory with production defaults baked in.
export const claudeCliProvider = makeClaudeCliProvider()

// ── Internals ──────────────────────────────────────────────────────────────────

async function invokeCli(runCli: RunCli, binary: string, args: string[]): Promise<{ result: string }> {
  let res
  try {
    res = await runCli(binary, args, { timeoutMs: DEFAULT_TIMEOUT_MS })
  } catch (e) {
    throw mapRunCliError(e)
  }
  return unwrapClaudeJson(res.stdout, res.stderr, res.exitCode)
}

function mapRunCliError(e: unknown): AIError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = (e as any)?.code
  if (code === 'ENOENT') {
    return new AIError('no_provider_configured',
      'Claude CLI not found in PATH — install Claude Code or switch to BYOK in /settings.')
  }
  if (code === 'ETIMEDOUT') {
    return new AIError('provider_unavailable', 'claude subprocess timed out.')
  }
  return new AIError('unknown_error',
    `claude subprocess failed: ${e instanceof Error ? e.message : String(e)}`)
}

function unwrapClaudeJson(stdout: string, stderr: string, exitCode: number): { result: string } {
  if (exitCode !== 0) {
    throw new AIError('provider_unavailable', `claude exited ${exitCode}: ${truncate(stderr, 500)}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wrapper: any
  try { wrapper = JSON.parse(stdout) }
  catch { throw new AIError('unknown_error', `claude output unparseable: ${truncate(stdout, 200)}`) }

  if (wrapper.is_error === true || wrapper.subtype === 'error') throw mapClaudeError(wrapper)
  if (typeof wrapper.result !== 'string') {
    throw new AIError('unknown_error', 'claude wrapper missing .result string — format may have changed')
  }
  return { result: wrapper.result }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapClaudeError(wrapper: any): AIError {
  const msg = String(wrapper?.message ?? wrapper?.error ?? 'claude returned error wrapper')
  const lowered = msg.toLowerCase()
  if (/log in|authenticate|not authenticated/.test(lowered)) {
    return new AIError('invalid_api_key', 'Run `claude` in your terminal to log in.')
  }
  if (/rate|limit|quota|credit/.test(lowered)) {
    const retryAfter = Number(wrapper?.retry_after) || 60
    return new AIError('rate_limited', msg, { retryAfterSeconds: retryAfter })
  }
  return new AIError('provider_unavailable', msg)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function extForMimeType(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case 'image/png':  return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif':  return 'gif'
    default: return null
  }
}
