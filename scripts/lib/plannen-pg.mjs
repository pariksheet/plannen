#!/usr/bin/env node
// Lifecycle for the Tier 0 embedded Postgres.
// Usage: node scripts/lib/plannen-pg.mjs <init|start|stop|status>
import EmbeddedPostgres from 'embedded-postgres'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = process.env.PLANNEN_PG_DATA ?? join(homedir(), '.plannen', 'pgdata')
const PID_FILE = join(homedir(), '.plannen', 'pg.pid')
const PORT = Number(process.env.PLANNEN_PG_PORT ?? 54322)
const USER = 'plannen'
const PASSWORD = 'plannen'
const DB = 'plannen'

function newServer() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  })
}

async function init() {
  mkdirSync(join(homedir(), '.plannen'), { recursive: true })
  if (existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    console.log(`pgdata already initialised at ${DATA_DIR}`)
    const pg = newServer()
    await pg.start()
    writeFileSync(PID_FILE, String(process.pid))
    console.log(`pg started on port ${PORT}`)
    return
  }
  const pg = newServer()
  await pg.initialise()
  await pg.start()
  try {
    await pg.createDatabase(DB)
  } catch (e) {
    if (!/already exists/i.test(String(e?.message ?? e))) throw e
  }
  writeFileSync(PID_FILE, String(process.pid))
  console.log(`pg initialised at ${DATA_DIR} on port ${PORT}; running.`)
}

async function start() {
  const pg = newServer()
  await pg.start()
  writeFileSync(PID_FILE, String(process.pid))
  console.log(`pg started on port ${PORT}`)
  setInterval(() => {}, 1 << 30)
}

async function stop() {
  if (!existsSync(PID_FILE)) {
    console.log('no pid file; nothing to stop')
    return
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`sent SIGTERM to ${pid}`)
  } catch {
    console.log(`pid ${pid} not running`)
  }
  unlinkSync(PID_FILE)
}

async function status() {
  if (!existsSync(PID_FILE)) {
    console.log('not running (no pid file)')
    process.exit(1)
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  try {
    process.kill(pid, 0)
    console.log(`running (pid ${pid}, port ${PORT})`)
  } catch {
    console.log(`stale pid file ${pid}`)
    process.exit(1)
  }
}

const cmd = process.argv[2]
const map = { init, start, stop, status }
if (!map[cmd]) {
  console.error(`usage: plannen-pg.mjs <${Object.keys(map).join('|')}>`)
  process.exit(1)
}
await map[cmd]()
