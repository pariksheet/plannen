import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectClaudeCli, parseVersion, _resetDetectionCacheForTests } from './cliDetection.js'
import type { RunCli } from './providers/run-cli.js'

beforeEach(() => { _resetDetectionCacheForTests() })

describe('parseVersion', () => {
  it('extracts semver from version output', () => {
    expect(parseVersion('claude 1.2.3 (build abc)\n')).toBe('1.2.3')
  })
  it('returns null when no version present', () => {
    expect(parseVersion('claude (no version)')).toBeNull()
  })
})

describe('detectClaudeCli', () => {
  it('returns available=true on exit 0', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'claude 1.0.0\n', stderr: '', exitCode: 0,
    })
    const r = await detectClaudeCli(runCli)
    expect(r).toEqual({ available: true, version: '1.0.0' })
  })

  it('returns available=false on ENOENT', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    const r = await detectClaudeCli(runCli)
    expect(r).toEqual({ available: false, version: null })
  })

  it('returns available=false on non-zero exit', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({ stdout: '', stderr: 'err', exitCode: 1 })
    const r = await detectClaudeCli(runCli)
    expect(r.available).toBe(false)
  })

  it('caches the result — second call does not re-probe', async () => {
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      stdout: 'claude 1.0.0', stderr: '', exitCode: 0,
    })
    await detectClaudeCli(runCli)
    await detectClaudeCli(runCli)
    expect(runCli).toHaveBeenCalledTimes(1)
  })
})
