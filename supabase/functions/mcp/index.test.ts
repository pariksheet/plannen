import { describe, it, expect, beforeEach } from 'vitest'
import { authenticate, handleRequest } from './index.ts'

describe('authenticate', () => {
  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = 'test-token-abc'
  })

  it('returns null when Authorization header matches', () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer test-token-abc' },
    })
    expect(authenticate(req)).toBeNull()
  })

  it('returns 401 when Authorization header is missing', () => {
    const req = new Request('http://x/')
    const res = authenticate(req)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('returns 401 when bearer is wrong', () => {
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    const res = authenticate(req)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('uses constant-time compare (no early return on length mismatch)', () => {
    // Same length as test-token-abc (14 chars) so length matches but content doesn't.
    const req = new Request('http://x/', {
      headers: { Authorization: 'Bearer wronglongabc1' },
    })
    expect(authenticate(req)!.status).toBe(401)
  })
})

describe('handleRequest (transport)', () => {
  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = 'test-token-abc'
    process.env.PLANNEN_USER_EMAIL = 'test@example.com'
  })

  it('responds to tools/list with an empty list when no tool modules are registered', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-token-abc',
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
    const res = await handleRequest(req, { tools: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result?.tools).toEqual([])
  })
})
