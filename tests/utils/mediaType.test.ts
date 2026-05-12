import { describe, it, expect } from 'vitest'
import { mediaTypeFromMime } from '../../src/utils/mediaType'

describe('mediaTypeFromMime', () => {
  it('returns image for image MIMEs', () => {
    expect(mediaTypeFromMime('image/jpeg')).toBe('image')
    expect(mediaTypeFromMime('image/png')).toBe('image')
    expect(mediaTypeFromMime('image/heif')).toBe('image')
  })

  it('returns video for video MIMEs', () => {
    expect(mediaTypeFromMime('video/mp4')).toBe('video')
    expect(mediaTypeFromMime('video/quicktime')).toBe('video')
    expect(mediaTypeFromMime('video/webm')).toBe('video')
  })

  it('returns audio for audio MIMEs', () => {
    expect(mediaTypeFromMime('audio/mpeg')).toBe('audio')
    expect(mediaTypeFromMime('audio/mp4')).toBe('audio')
    expect(mediaTypeFromMime('audio/x-m4a')).toBe('audio')
    expect(mediaTypeFromMime('audio/wav')).toBe('audio')
  })

  it('falls back to image for unknown / empty MIME', () => {
    expect(mediaTypeFromMime('')).toBe('image')
    expect(mediaTypeFromMime('application/pdf')).toBe('image')
  })
})
