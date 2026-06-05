import { describe, it, expect } from 'vitest'
import { shouldWarnLargeFile } from '../../src/services/memoryService'

function makeFile(name: string, size: number): File {
  // jsdom's File ignores actual content size and uses the provided length;
  // we use Object.defineProperty because File.size is read-only.
  const f = new File(['x'], name, { type: 'image/jpeg' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('shouldWarnLargeFile', () => {
  const CAP = 200 * 1024 * 1024

  it('returns null below the cap', () => {
    expect(shouldWarnLargeFile(makeFile('a.jpg', 1024))).toBeNull()
  })

  it('returns null exactly at the cap', () => {
    expect(shouldWarnLargeFile(makeFile('a.jpg', CAP))).toBeNull()
  })

  it('returns a warning string above the cap', () => {
    const warning = shouldWarnLargeFile(makeFile('clip.mp4', CAP + 1024 * 1024))
    expect(warning).not.toBeNull()
    expect(warning).toContain('clip.mp4')
    expect(warning).toContain('MB')
    expect(warning).toContain('Upload anyway?')
  })

  it('rounds the size to whole MB', () => {
    // 250.5 MB → 251 MB (Math.round)
    const bytes = Math.round(250.5 * 1024 * 1024)
    const warning = shouldWarnLargeFile(makeFile('big.mov', bytes))
    expect(warning).toContain('251 MB')
  })
})
