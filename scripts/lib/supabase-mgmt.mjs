import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const API_BASE = 'https://api.supabase.com/v1'
const DEFAULT_TOKEN_PATH = join(homedir(), '.supabase', 'access-token')

// Supabase CLI ≥ 1.x stores the access token in the system keychain (macOS),
// not on disk. The legacy file path is checked as a fallback for older
// installs and self-built configs.
export function readAccessToken({
  env = process.env,
  readFile = defaultReadFile,
  path = DEFAULT_TOKEN_PATH,
  readKeychain = defaultReadKeychain,
  osPlatform = platform(),
} = {}) {
  const fromEnv = env.SUPABASE_ACCESS_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  if (osPlatform === 'darwin') {
    const t = readKeychain()
    if (t) return t
  }
  try {
    const t = readFile(path)
    if (t && t.trim()) return t.trim()
  } catch {
    /* file missing → fall through */
  }
  return null
}

function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}

// macOS Keychain → Supabase CLI's go-keyring stores the token base64-encoded
// behind a `go-keyring-base64:` prefix.
function defaultReadKeychain() {
  const r = spawnSync('security', ['find-generic-password', '-s', 'Supabase CLI', '-w'], {
    encoding: 'utf8',
  })
  if (r.status !== 0) return null
  const raw = (r.stdout ?? '').trim()
  if (!raw) return null
  const PREFIX = 'go-keyring-base64:'
  if (raw.startsWith(PREFIX)) {
    try {
      return Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8').trim()
    } catch {
      return null
    }
  }
  return raw
}

// Throws a specific message on 401 so the caller can suggest `supabase login` rather than dumping the raw response.
async function request({ method, path, body, token, fetch = globalThis.fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) {
    throw new Error('supabase access token rejected (run `supabase login` to refresh)')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`supabase-mgmt ${method} ${path} → HTTP ${res.status}: ${text}`)
  }
  return res
}

export async function listProjects(token, { fetch = globalThis.fetch } = {}) {
  const res = await request({ method: 'GET', path: '/projects', token, fetch })
  return res.json()
}

export async function getAuthConfig(token, ref, { fetch = globalThis.fetch } = {}) {
  const res = await request({ method: 'GET', path: `/projects/${ref}/config/auth`, token, fetch })
  return res.json()
}

// IO: patch Auth config. Caller passes the desired siteUrl and additions
// to the allow-list; we GET the current list and PATCH the union back so
// we never clobber entries the user added by hand. pruneAllowList (a RegExp)
// drops stale entries we own — e.g. per-deployment Vercel URLs — before the
// union, so they get replaced instead of accumulating until Supabase rejects
// the list as too large. If the resulting payload would be a no-op, we skip
// the PATCH.
//
// patch = { siteUrl?: string, addAllowList?: string[], pruneAllowList?: RegExp }
export async function updateAuthConfig(token, ref, patch, { fetch = globalThis.fetch } = {}) {
  const current = await getAuthConfig(token, ref, { fetch })
  const currentList = (current.uri_allow_list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const kept = patch.pruneAllowList
    ? currentList.filter((e) => !patch.pruneAllowList.test(e))
    : currentList
  const nextList = mergeAllowList(kept, patch.addAllowList ?? [])
  const body = {}
  if (patch.siteUrl && patch.siteUrl !== current.site_url) {
    body.site_url = patch.siteUrl
  }
  if (nextList.join(',') !== currentList.join(',')) {
    body.uri_allow_list = nextList.join(',')
  }
  if (Object.keys(body).length === 0) return { changed: false }
  await request({ method: 'PATCH', path: `/projects/${ref}/config/auth`, body, token, fetch })
  return { changed: true, body }
}

// IO: enable passkeys on a project. Patches the Supabase Auth config with
// passkey_enabled + webauthn_rp_id + webauthn_rp_origins + webauthn_rp_display_name.
// Idempotent — re-PATCHing the same values is treated as a no-op.
//
// patch = { rpId: string, rpOrigins: string[], rpDisplayName: string }
export async function updatePasskeyConfig(token, ref, patch, { fetch = globalThis.fetch } = {}) {
  const current = await getAuthConfig(token, ref, { fetch });
  const currentOrigins = parseOriginsField(current.webauthn_rp_origins);
  const targetOrigins = dedupeAndNormalize(patch.rpOrigins ?? []);
  const body = {};
  if (current.passkey_enabled !== true) {
    body.passkey_enabled = true;
  }
  if (patch.rpId && patch.rpId !== current.webauthn_rp_id) {
    body.webauthn_rp_id = patch.rpId;
  }
  if (!sameOriginSet(currentOrigins, targetOrigins)) {
    // The Supabase API accepts a CSV string here, same shape as uri_allow_list.
    body.webauthn_rp_origins = targetOrigins.join(',');
  }
  if (patch.rpDisplayName && patch.rpDisplayName !== current.webauthn_rp_display_name) {
    body.webauthn_rp_display_name = patch.rpDisplayName;
  }
  if (Object.keys(body).length === 0) return { changed: false };
  await request({ method: 'PATCH', path: `/projects/${ref}/config/auth`, body, token, fetch });
  return { changed: true, body };
}

function parseOriginsField(v) {
  if (Array.isArray(v)) return dedupeAndNormalize(v);
  if (typeof v === 'string') return dedupeAndNormalize(v.split(',').map((s) => s.trim()).filter(Boolean));
  return [];
}

function dedupeAndNormalize(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw).trim().replace(/\/+$/, '');
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function sameOriginSet(a, b) {
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  for (const x of b) if (!aSet.has(x)) return false;
  return true;
}

// IO: enable the OAuth 2.1 server on a project (claude.ai custom connector
// support). Patches oauth_server_enabled + dynamic client registration +
// the authorization (consent) path. Idempotent — no PATCH when current
// state already matches.
//
// patch = { authorizationPath: string }
export async function updateOAuthServerConfig(token, ref, patch, { fetch = globalThis.fetch } = {}) {
  const current = await getAuthConfig(token, ref, { fetch });
  const body = {};
  if (current.oauth_server_enabled !== true) {
    body.oauth_server_enabled = true;
  }
  if (current.oauth_server_allow_dynamic_registration !== true) {
    body.oauth_server_allow_dynamic_registration = true;
  }
  if (patch.authorizationPath && patch.authorizationPath !== current.oauth_server_authorization_path) {
    body.oauth_server_authorization_path = patch.authorizationPath;
  }
  if (Object.keys(body).length === 0) return { changed: false };
  await request({ method: 'PATCH', path: `/projects/${ref}/config/auth`, body, token, fetch });
  return { changed: true, body };
}

// IO: set the PostgREST exposed schemas. The Management API accepts a
// comma-separated `db_schema` string. Idempotent — PATCHing the same
// value is a no-op server-side.
export async function setExposedSchemas(token, ref, schemas, { fetch = globalThis.fetch } = {}) {
  const body = { db_schema: schemas.join(',') }
  await request({ method: 'PATCH', path: `/projects/${ref}/postgrest`, body, token, fetch })
  return { changed: true, schemas }
}

// IO: run an arbitrary SQL query against the project's Postgres via the
// Management API. Used by promote's parity check (and any other read-only
// SQL the CLI needs against a project we don't want to `supabase link`).
export async function runSql(token, ref, query, { fetch = globalThis.fetch } = {}) {
  const res = await request({
    method: 'POST',
    path: `/projects/${ref}/database/query`,
    body: { query },
    token,
    fetch,
  })
  return res.json()
}

// IO: list versions in supabase_migrations.schema_migrations. Returns an
// array of version strings in ascending order. Empty array if the schema
// has never been pushed (table missing).
export async function listAppliedMigrations(token, ref, { fetch = globalThis.fetch } = {}) {
  try {
    const rows = await runSql(
      token,
      ref,
      "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version ASC",
      { fetch },
    )
    return rows.map((r) => r.version)
  } catch (e) {
    // If the schema or table doesn't exist yet, the API returns 4xx with a
    // PG error in the body. Treat that as "no migrations applied" rather
    // than failing the parity check.
    if (/relation .* does not exist|schema .* does not exist/i.test(e.message)) {
      return []
    }
    throw e
  }
}

export function mergeAllowList(current, additions) {
  const seen = new Set()
  const out = []
  for (const e of current ?? []) {
    if (!seen.has(e)) { seen.add(e); out.push(e) }
  }
  for (const e of additions ?? []) {
    if (!seen.has(e)) { seen.add(e); out.push(e) }
  }
  return out
}
