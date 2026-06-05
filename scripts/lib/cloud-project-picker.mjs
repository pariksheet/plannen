export function formatProjectMenu(projects) {
  if (projects.length === 0) return 'no projects found on this account.\n'
  const lines = projects.map((p, i) => `  ${i + 1}) ${p.name} (${p.ref}, ${p.region})`)
  return `Select a Supabase project:\n${lines.join('\n')}\n`
}

export function parseSelection(input, projects) {
  const trimmed = String(input).trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`selection must be numeric, got: "${trimmed}"`)
  }
  const idx = Number(trimmed) - 1
  if (idx < 0 || idx >= projects.length) {
    throw new Error(`selection out of range: ${trimmed} (1..${projects.length})`)
  }
  return projects[idx]
}

// Uses /dev/tty (via CLI entrypoint) so the JSON on stdout stays clean when called from a subshell.
export async function pick(projects, deps) {
  if (projects.length === 0) {
    throw new Error('no projects found on this Supabase account')
  }
  if (projects.length === 1) {
    // Sole-project shortcut: no prompt needed — typing "1<Enter>" when there's
    // only one option is busywork (and was a real foot-gun: empty-Enter caused
    // a noisy "must be numeric" error before falling back to a re-prompt).
    const only = projects[0]
    deps.write(`Only one Supabase project on this account — auto-selecting:\n  ${only.name} (${only.ref}, ${only.region})\n`)
    return only
  }
  deps.write(formatProjectMenu(projects))
  for (;;) {
    deps.write('  > ')
    const input = await deps.read()
    if (!String(input ?? '').trim()) {
      // Silent re-prompt on empty Enter — don't print "must be numeric" noise.
      continue
    }
    try {
      return parseSelection(input, projects)
    } catch (e) {
      deps.write(`  ${(e instanceof Error ? e.message : String(e))}\n`)
    }
  }
}

// CLI entry. Used by bootstrap.sh:
//   node scripts/lib/cloud-project-picker.mjs
// Reads SUPABASE_ACCESS_TOKEN from env (or ~/.supabase/access-token),
// lists projects, prompts on /dev/tty (so the menu survives subshells +
// pipes), prints the picked ref + region to stdout as JSON for the
// shell to consume:
//   {"ref":"<ref>","region":"<region>","name":"<name>"}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createInterface } = await import('node:readline')
  const { openSync, createReadStream, createWriteStream } = await import('node:fs')
  const { readAccessToken, listProjects } = await import('./supabase-mgmt.mjs')
  try {
    const token = readAccessToken()
    if (!token) {
      process.stderr.write('no Supabase access token — run `supabase login` first\n')
      process.exit(2)
    }
    const projects = await listProjects(token)
    // Prompt against /dev/tty so the JSON on stdout stays clean.
    const ttyIn = createReadStream('/dev/tty')
    const ttyOut = createWriteStream('/dev/tty')
    const rl = createInterface({ input: ttyIn, output: ttyOut, terminal: false })
    const read = () => new Promise((resolve) => rl.once('line', resolve))
    const write = (s) => ttyOut.write(s)
    const chosen = await pick(projects, { read, write })
    rl.close()
    ttyIn.close()
    ttyOut.end()
    process.stdout.write(JSON.stringify({ ref: chosen.ref, region: chosen.region, name: chosen.name }) + '\n')
  } catch (e) {
    process.stderr.write(`cloud-project-picker: ${e.message}\n`)
    process.exit(1)
  }
}
