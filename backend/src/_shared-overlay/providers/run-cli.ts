// Subprocess wrapper used by claude-cli.ts. Returns stdout/stderr/exit code
// and surfaces only two failure modes via tagged error codes — ENOENT (binary
// missing) and ETIMEDOUT (kill after grace). All other failures are reported
// via exit codes so callers can branch on them.

import { spawn } from 'node:child_process'

export type RunCliResult = { stdout: string; stderr: string; exitCode: number }
export type RunCliOpts = { timeoutMs: number; input?: string }
export type RunCli = (cmd: string, args: string[], opts: RunCliOpts) => Promise<RunCliResult>

class RunCliError extends Error {
  code: 'ENOENT' | 'ETIMEDOUT' | 'UNKNOWN'
  constructor(code: 'ENOENT' | 'ETIMEDOUT' | 'UNKNOWN', message: string) {
    super(message)
    this.name = 'RunCliError'
    this.code = code
  }
}

export const defaultRunCli: RunCli = (cmd, args, opts) =>
  new Promise<RunCliResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: NodeJS.Timeout | null = null

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
      reject(new RunCliError('ETIMEDOUT', `Subprocess timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (err.code === 'ENOENT') {
        reject(new RunCliError('ENOENT', `Binary not found: ${cmd}`))
      } else {
        reject(new RunCliError('UNKNOWN', err.message))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })

    if (opts.input != null) {
      child.stdin.write(opts.input)
    }
    child.stdin.end()
  })
