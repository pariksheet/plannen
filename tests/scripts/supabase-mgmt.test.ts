import { describe, it, expect } from 'vitest'
// @ts-ignore — .mjs module
import {
  readAccessToken,
  listProjects,
  getAuthConfig,
  setExposedSchemas,
  updateAuthConfig,
  updatePasskeyConfig,
  updateOAuthServerConfig,
  mergeAllowList,
} from '../../scripts/lib/supabase-mgmt.mjs'

describe('readAccessToken', () => {
  it('prefers SUPABASE_ACCESS_TOKEN env var', () => {
    const t = readAccessToken({
      env: { SUPABASE_ACCESS_TOKEN: 'env-token' },
      readFile: () => 'file-token\n',
      readKeychain: () => 'keychain-token',
      osPlatform: 'darwin',
    })
    expect(t).toBe('env-token')
  })

  it('reads from macOS Keychain when env unset', () => {
    const t = readAccessToken({
      env: {},
      readFile: () => { throw new Error('ENOENT') },
      readKeychain: () => 'keychain-token',
      osPlatform: 'darwin',
    })
    expect(t).toBe('keychain-token')
  })

  it('falls back to ~/.supabase/access-token when env + keychain unset', () => {
    const t = readAccessToken({
      env: {},
      readFile: () => '  file-token\n',
      readKeychain: () => null,
      osPlatform: 'darwin',
    })
    expect(t).toBe('file-token')
  })

  it('skips keychain on non-darwin platforms', () => {
    const t = readAccessToken({
      env: {},
      readFile: () => '  file-token\n',
      readKeychain: () => { throw new Error('should not run on linux') },
      osPlatform: 'linux',
    })
    expect(t).toBe('file-token')
  })

  it('returns null when no source is available', () => {
    const t = readAccessToken({
      env: {},
      readFile: () => { throw new Error('ENOENT') },
      readKeychain: () => null,
      osPlatform: 'darwin',
    })
    expect(t).toBeNull()
  })
})

describe('listProjects', () => {
  it('GETs /v1/projects with Bearer auth and returns the parsed list', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'a', ref: 'aaaa1111', name: 'one', region: 'eu-central-1' },
          { id: 'b', ref: 'bbbb2222', name: 'two', region: 'us-east-1' },
        ],
      }
    }
    const projects = await listProjects('tok', { fetch: fakeFetch as any })
    expect(projects).toHaveLength(2)
    expect(projects[0].ref).toBe('aaaa1111')
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
  })

  it('throws a clean 401 message when token is expired', async () => {
    const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    await expect(listProjects('bad', { fetch: fakeFetch as any })).rejects.toThrow(/supabase access token rejected/i)
  })
})

describe('mergeAllowList', () => {
  it('unions existing entries with new ones, deduped', () => {
    const merged = mergeAllowList(['http://localhost:4321/**'], ['https://plannen.vercel.app/**'])
    expect(merged).toEqual(['http://localhost:4321/**', 'https://plannen.vercel.app/**'])
  })

  it('does not duplicate an entry already present', () => {
    const merged = mergeAllowList(['https://a/**'], ['https://a/**', 'https://b/**'])
    expect(merged).toEqual(['https://a/**', 'https://b/**'])
  })

  it('handles null/undefined current list', () => {
    const merged = mergeAllowList(undefined, ['https://a/**'])
    expect(merged).toEqual(['https://a/**'])
  })
})

describe('getAuthConfig', () => {
  it('GETs /v1/projects/<ref>/config/auth', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:3000', uri_allow_list: '' }) }
    }
    const cfg = await getAuthConfig('tok', 'abcd1234', { fetch: fakeFetch as any })
    expect(cfg.site_url).toBe('http://localhost:3000')
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abcd1234/config/auth')
  })
})

describe('updateAuthConfig', () => {
  it('fetches current allow-list then PATCHes a union', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:3000', uri_allow_list: 'http://localhost:4321/**' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await updateAuthConfig('tok', 'abcd1234', {
      siteUrl: 'https://plannen.vercel.app',
      addAllowList: ['https://plannen.vercel.app/**'],
    }, { fetch: fakeFetch as any })

    expect(calls).toHaveLength(2)
    expect(calls[1].init.method).toBe('PATCH')
    const body = JSON.parse(calls[1].init.body)
    expect(body.site_url).toBe('https://plannen.vercel.app')
    // Allow-list serialized as comma-separated string.
    expect(body.uri_allow_list.split(',').sort()).toEqual([
      'http://localhost:4321/**',
      'https://plannen.vercel.app/**',
    ])
  })

  it('skips PATCH when there is nothing to change', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ site_url: 'https://plannen.vercel.app', uri_allow_list: 'https://plannen.vercel.app/**' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await updateAuthConfig('tok', 'abcd1234', {
      siteUrl: 'https://plannen.vercel.app',
      addAllowList: ['https://plannen.vercel.app/**'],
    }, { fetch: fakeFetch as any })
    expect(calls).toHaveLength(1)  // only the GET, no PATCH
  })
})

describe('updatePasskeyConfig', () => {
  it('PATCHes passkey_enabled + webauthn_rp_id + webauthn_rp_origins on first run', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    const result = await updatePasskeyConfig('tok', 'abcd1234', {
      rpId: 'plannen.app',
      rpOrigins: ['https://plannen.app'],
      rpDisplayName: 'Plannen',
    }, { fetch: fakeFetch as any })

    expect(result.changed).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1].init.method).toBe('PATCH')
    const body = JSON.parse(calls[1].init.body)
    expect(body.passkey_enabled).toBe(true)
    expect(body.webauthn_rp_id).toBe('plannen.app')
    expect(body.webauthn_rp_origins).toBe('https://plannen.app')
    expect(body.webauthn_rp_display_name).toBe('Plannen')
  })

  it('skips PATCH when state already matches (idempotent)', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            passkey_enabled: true,
            webauthn_rp_id: 'plannen.app',
            webauthn_rp_origins: 'https://plannen.app',
            webauthn_rp_display_name: 'Plannen',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    const result = await updatePasskeyConfig('tok', 'abcd1234', {
      rpId: 'plannen.app',
      rpOrigins: ['https://plannen.app'],
      rpDisplayName: 'Plannen',
    }, { fetch: fakeFetch as any })

    expect(result.changed).toBe(false)
    expect(calls).toHaveLength(1) // GET only, no PATCH
  })

  it('detects origins set as either CSV string or array on the server response', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            passkey_enabled: true,
            webauthn_rp_id: 'plannen.app',
            // Server returns origins as an array — code should normalise.
            webauthn_rp_origins: ['https://plannen.app', 'https://www.plannen.app/'],
            webauthn_rp_display_name: 'Plannen',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    const result = await updatePasskeyConfig('tok', 'abcd1234', {
      rpId: 'plannen.app',
      rpOrigins: ['https://plannen.app', 'https://www.plannen.app'],
      rpDisplayName: 'Plannen',
    }, { fetch: fakeFetch as any })

    expect(result.changed).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('only PATCHes the fields that drift, leaving others alone', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            passkey_enabled: true,
            webauthn_rp_id: 'plannen.app',
            webauthn_rp_origins: 'https://plannen.app',
            webauthn_rp_display_name: 'Old Name',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await updatePasskeyConfig('tok', 'abcd1234', {
      rpId: 'plannen.app',
      rpOrigins: ['https://plannen.app'],
      rpDisplayName: 'Plannen',
    }, { fetch: fakeFetch as any })

    const body = JSON.parse(calls[1].init.body)
    expect(body.webauthn_rp_display_name).toBe('Plannen')
    // No no-op fields in the body
    expect(body.passkey_enabled).toBeUndefined()
    expect(body.webauthn_rp_id).toBeUndefined()
    expect(body.webauthn_rp_origins).toBeUndefined()
  })
})

describe('setExposedSchemas', () => {
  it('PATCHes /v1/projects/<ref>/postgrest with the joined schema list', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await setExposedSchemas('tok', 'abcd1234', ['plannen', 'public', 'graphql_public'], { fetch: fakeFetch as any })
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abcd1234/postgrest')
    expect(calls[0].init.method).toBe('PATCH')
    const body = JSON.parse(calls[0].init.body)
    expect(body.db_schema).toBe('plannen,public,graphql_public')
  })
})

describe('updateOAuthServerConfig', () => {
  function fakeFetch(currentConfig: Record<string, unknown>) {
    const calls: { url: string; init?: any }[] = []
    const fetch = async (url: string, init?: any) => {
      calls.push({ url, init })
      if (!init || init.method === 'GET' || init.method === undefined) {
        return { ok: true, status: 200, json: async () => currentConfig }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    return { calls, fetch }
  }

  it('enables oauth server + DCR + sets the authorization path', async () => {
    const { calls, fetch } = fakeFetch({})
    const r = await updateOAuthServerConfig('tok', 'ref1', { authorizationPath: '/oauth/consent' }, { fetch })
    expect(r.changed).toBe(true)
    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeTruthy()
    expect(JSON.parse(String(patch!.init!.body))).toEqual({
      oauth_server_enabled: true,
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: '/oauth/consent',
    })
  })

  it('is a no-op when everything already matches', async () => {
    const { calls, fetch } = fakeFetch({
      oauth_server_enabled: true,
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: '/oauth/consent',
    })
    const r = await updateOAuthServerConfig('tok', 'ref1', { authorizationPath: '/oauth/consent' }, { fetch })
    expect(r.changed).toBe(false)
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(0)
  })

  it('only patches the missing fields when oauth_server_enabled is already true', async () => {
    // Current config: oauth_server_enabled already set, but DCR + authorization path missing.
    // PATCH body must contain exactly the two missing fields — not re-send oauth_server_enabled.
    const { calls, fetch } = fakeFetch({ oauth_server_enabled: true })
    const r = await updateOAuthServerConfig('tok', 'ref1', { authorizationPath: '/oauth/consent' }, { fetch })
    expect(r.changed).toBe(true)
    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeTruthy()
    const body = JSON.parse(String(patch!.init!.body))
    expect(body).toEqual({
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: '/oauth/consent',
    })
    // oauth_server_enabled must NOT be re-sent since it already matches
    expect(body.oauth_server_enabled).toBeUndefined()
  })
})
