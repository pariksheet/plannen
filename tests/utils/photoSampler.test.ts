import { describe, it, expect } from 'vitest'
import { samplePhotosForVision } from '../../src/utils/photoSampler'

describe('samplePhotosForVision', () => {
  it('returns empty array when input is empty', () => {
    expect(samplePhotosForVision([])).toEqual([])
  })

  it('returns the only item when length is 1 (ceil(1/2) = 1)', () => {
    expect(samplePhotosForVision(['a'])).toEqual(['a'])
  })

  it('returns 1 item for length 2 (ceil(2/2) = 1, picks index 0)', () => {
    expect(samplePhotosForVision(['a', 'b'])).toEqual(['a'])
  })

  it('returns 2 items evenly for length 4 (ceil(4/2) = 2)', () => {
    expect(samplePhotosForVision(['a', 'b', 'c', 'd'])).toEqual(['a', 'c'])
  })

  it('returns 3 items evenly for length 6', () => {
    expect(samplePhotosForVision(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'c', 'e'])
  })

  it('caps at 5 even when half is greater', () => {
    const items = Array.from({ length: 12 }, (_, i) => i)
    const sampled = samplePhotosForVision(items)
    expect(sampled).toHaveLength(5)
    expect(sampled[0]).toBe(0)
    expect(sampled[sampled.length - 1]).toBeLessThan(12)
  })

  it('respects a custom cap with even spread across full range', () => {
    expect(samplePhotosForVision(['a','b','c','d','e','f'], 2)).toEqual(['a', 'd'])
    // n=6, nVision=min(ceil(6/2)=3, 2)=2; indices floor(0*6/2)=0, floor(1*6/2)=3
  })
})
