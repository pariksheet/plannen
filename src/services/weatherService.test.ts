import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTodayWeather, _clearWeatherCacheForTest } from './weatherService'

beforeEach(() => {
  vi.restoreAllMocks()
  _clearWeatherCacheForTest()
})

function openMeteoBody(temp_c: number, weather_code: number) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const hours = Array.from({ length: 24 }, (_, h) => {
    const d = new Date(today)
    d.setHours(h)
    return d.toISOString()
  })
  return {
    current: { temperature_2m: temp_c, weather_code },
    hourly: {
      time: hours,
      temperature_2m: Array(24).fill(temp_c),
      weather_code: Array(24).fill(weather_code),
    },
  }
}

describe('getTodayWeather', () => {
  it('parses Open-Meteo response into TodayWeather', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(openMeteoBody(24, 0)), { status: 200 })
    ))
    const w = await getTodayWeather('Brussels')
    expect(w).not.toBeNull()
    expect(w!.temp_c).toBe(24)
    expect(w!.summary).toBe('clear')
    expect(w!.chips.length).toBeGreaterThan(0)
  })

  it('returns null on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const w = await getTodayWeather('Brussels')
    expect(w).toBeNull()
  })

  it('returns null on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 502 })))
    const w = await getTodayWeather('Brussels')
    expect(w).toBeNull()
  })

  it('caches per (city, day): second call does not refetch', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(openMeteoBody(20, 3)), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchSpy)
    await getTodayWeather('Brussels')
    await getTodayWeather('Brussels')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
