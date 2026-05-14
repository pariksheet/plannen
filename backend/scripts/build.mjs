#!/usr/bin/env node
// Backend build: stage the shared dir, run tsc, leave dist in place.
// The staged src/_shared/ is gitignored and kept around after the build
// for `npm start` parity with `npm run dev`.

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')

const prep = spawnSync('node', [join(here, 'prepare-shared.mjs')], {
  cwd: backendRoot,
  stdio: 'inherit',
})
if (prep.status !== 0) process.exit(prep.status ?? 1)

const dist = join(backendRoot, 'dist')
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true })

const tsc = spawnSync('npx', ['tsc', '-p', '.'], { cwd: backendRoot, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
