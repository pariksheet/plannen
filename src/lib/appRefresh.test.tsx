import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { useAppRefresh, requestRefresh } from './appRefresh'

const BASE = 1_700_000_000_000 // far from epoch so the first fire isn't coalesced

function Harness({ cb }: { cb: () => void }) {
  useAppRefresh(cb)
  return null
}

describe('useAppRefresh', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE) })
  afterEach(() => { vi.useRealTimers() })

  it('reloads on an explicit requestRefresh()', () => {
    const cb = vi.fn()
    render(<Harness cb={cb} />)
    requestRefresh()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('reloads when the tab becomes visible', () => {
    const cb = vi.fn()
    render(<Harness cb={cb} />)
    document.dispatchEvent(new Event('visibilitychange')) // jsdom defaults to 'visible'
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('coalesces bursts within 1s but fires again afterwards', () => {
    const cb = vi.fn()
    render(<Harness cb={cb} />)
    requestRefresh()
    requestRefresh() // same instant → coalesced
    expect(cb).toHaveBeenCalledTimes(1)
    vi.setSystemTime(BASE + 1500)
    requestRefresh()
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('stops listening after unmount', () => {
    const cb = vi.fn()
    const { unmount } = render(<Harness cb={cb} />)
    unmount()
    requestRefresh()
    expect(cb).not.toHaveBeenCalled()
  })
})
