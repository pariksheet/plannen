import { describe, it, expect } from 'vitest'
import { defaultRunCli } from './run-cli.js'

describe('defaultRunCli', () => {
  it('returns stdout and exit 0 on success', async () => {
    const r = await defaultRunCli('node', ['-e', 'process.stdout.write("hello")'], { timeoutMs: 5_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hello')
  })

  it('returns non-zero exit code without throwing', async () => {
    const r = await defaultRunCli('node', ['-e', 'process.exit(3)'], { timeoutMs: 5_000 })
    expect(r.exitCode).toBe(3)
  })

  it('throws with code ENOENT when binary missing', async () => {
    await expect(defaultRunCli('this-binary-does-not-exist-xyz', [], { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws with code ETIMEDOUT when subprocess exceeds timeout', async () => {
    await expect(defaultRunCli('node', ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('forwards optional stdin input', async () => {
    const r = await defaultRunCli('node', ['-e', 'process.stdin.pipe(process.stdout)'], {
      timeoutMs: 5_000,
      input: 'from-stdin',
    })
    expect(r.stdout).toBe('from-stdin')
  })
})
