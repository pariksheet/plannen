import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('storageClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('upload calls /api/photos/upload-url then PUTs to the returned URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: 'u/e/x.jpg',
        upload_url: '/storage/v1/object/event-photos/u/e/x.jpg',
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://x/signed' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { storageClient } = await import('./storageClient.js')
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    const out = await storageClient.upload({ eventId: '11111111-1111-1111-1111-111111111111', filename: 'IMG.jpg', blob })
    expect(out.key).toBe('u/e/x.jpg')
    expect(out.signedUrl).toBe('https://x/signed')
    // Three calls: upload-url, the PUT, and the immediate signed-url fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/photos/upload-url')
    expect(fetchMock.mock.calls[1][0]).toBe('/storage/v1/object/event-photos/u/e/x.jpg')
    expect(fetchMock.mock.calls[2][0]).toBe('/api/photos/signed-url?key=u%2Fe%2Fx.jpg')
  })

  it('downloadUrl GETs /api/photos/signed-url and returns the url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://x/signed' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { storageClient } = await import('./storageClient.js')
    const url = await storageClient.downloadUrl('u/e/x.jpg')
    expect(url).toBe('https://x/signed')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/photos/signed-url?key=u%2Fe%2Fx.jpg')
  })

  it('delete sends DELETE /api/photos with the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { storageClient } = await import('./storageClient.js')
    await storageClient.delete('u/e/x.jpg')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/photos')
    expect((init as RequestInit).method).toBe('DELETE')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ key: 'u/e/x.jpg' })
  })
})
