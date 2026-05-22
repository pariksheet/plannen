import { describe, it, expect, beforeEach } from 'vitest'
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { createS3Adapter } from './s3.js'

const s3Mock = mockClient(S3Client)

beforeEach(() => {
  s3Mock.reset()
})

const baseOpts = {
  endpoint: 'https://acc.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'plannen-photos',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  publicBaseUrl: 'https://photos.example.com',
  forcePathStyle: false,
}

describe('s3 adapter', () => {
  it('upload sends PutObjectCommand with bucket+key', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    const a = createS3Adapter(baseOpts)
    await a.upload('u/e/x.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' })
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input.Bucket).toBe('plannen-photos')
    expect(calls[0].args[0].input.Key).toBe('u/e/x.jpg')
    expect(calls[0].args[0].input.ContentType).toBe('image/jpeg')
  })

  it('delete returns true on success and false on NoSuchKey', async () => {
    s3Mock.on(DeleteObjectCommand).resolvesOnce({}).rejectsOnce({ name: 'NoSuchKey' })
    const a = createS3Adapter(baseOpts)
    expect(await a.delete('u/e/exists.jpg')).toBe(true)
    expect(await a.delete('u/e/missing.jpg')).toBe(false)
  })

  it('head returns metadata, or null on NotFound', async () => {
    s3Mock.on(HeadObjectCommand)
      .resolvesOnce({ ContentLength: 42, ContentType: 'image/png', ETag: '"abc"' })
      .rejectsOnce({ name: 'NotFound' })
    const a = createS3Adapter(baseOpts)
    expect(await a.head('u/e/a.png')).toEqual({ size: 42, contentType: 'image/png', etag: '"abc"' })
    expect(await a.head('u/e/missing.png')).toBeNull()
  })

  it('signedUrl returns a presigned URL string', async () => {
    const a = createS3Adapter(baseOpts)
    const url = await a.signedUrl('u/e/a.jpg', { ttlSeconds: 900 })
    // We can't deterministically assert the signature, but we can assert the
    // structural shape — host + key + X-Amz-* query params.
    expect(url).toContain('plannen-photos')
    expect(url).toContain('u/e/a.jpg')
    expect(url).toMatch(/X-Amz-Signature=/)
  })
})
