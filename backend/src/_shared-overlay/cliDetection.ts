// Cached `claude --version` probe used at backend boot to decide whether the
// CLI provider can be offered/auto-configured. Cached so repeat reads in the
// same process don't fork a new subprocess.

import type { RunCli } from './providers/run-cli.js'

export type CliDetection = { available: boolean; version: string | null }

let cached: CliDetection | null = null

export function parseVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? m[0] : null
}

export async function detectClaudeCli(runCli: RunCli): Promise<CliDetection> {
  if (cached) return cached
  try {
    const { stdout, exitCode } = await runCli('claude', ['--version'], { timeoutMs: 5_000 })
    cached = { available: exitCode === 0, version: parseVersion(stdout) }
  } catch {
    cached = { available: false, version: null }
  }
  return cached
}

// Exported for tests only.
export function _resetDetectionCacheForTests(): void { cached = null }
