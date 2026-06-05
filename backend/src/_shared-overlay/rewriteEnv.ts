// Pure helper to update a single key in a .env file's text. Preserves the
// existing key's line position; appends to end if the key isn't present.

import { readFileSync, writeFileSync } from 'node:fs'

export function rewriteEnvKey(currentText: string, key: string, value: string): string {
  const lines = currentText.split('\n')
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=`)
  let seen = false
  const next = lines.map((line) => {
    if (re.test(line)) {
      seen = true
      return `${key}=${value}`
    }
    return line
  })
  if (!seen) {
    if (next.length > 0 && next[next.length - 1] !== '') next.push(`${key}=${value}`)
    else next.splice(next.length > 0 ? next.length - 1 : 0, 0, `${key}=${value}`)
  }
  return next.join('\n')
}

export function updateEnvFile(envPath: string, key: string, value: string): void {
  let text = ''
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    text = ''
  }
  const updated = rewriteEnvKey(text, key, value)
  writeFileSync(envPath, updated)
}
