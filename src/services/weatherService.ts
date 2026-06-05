export interface WeatherChip {
  time: string
  label: string
}

export interface TodayWeather {
  city: string
  temp_c: number
  summary: string
  chips: WeatherChip[]
  fetched_at: string
}

const SESSION_PREFIX = 'plannen:weather:'

// Open-Meteo coordinates per supported city. Falls back to Brussels.
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  brussels: { lat: 50.8503, lon: 4.3517 },
  antwerp: { lat: 51.2194, lon: 4.4025 },
  ghent: { lat: 51.0543, lon: 3.7174 },
  leuven: { lat: 50.8798, lon: 4.7005 },
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function cacheKey(city: string, day: string): string {
  return `${SESSION_PREFIX}${city.toLowerCase()}:${day}`
}

const memCache = new Map<string, TodayWeather>()

function readCache(key: string): TodayWeather | null {
  if (memCache.has(key)) return memCache.get(key)!
  if (typeof sessionStorage === 'undefined') return null
  const raw = sessionStorage.getItem(key)
  if (!raw) return null
  try { return JSON.parse(raw) as TodayWeather } catch { return null }
}

function writeCache(key: string, value: TodayWeather): void {
  memCache.set(key, value)
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* quota or disabled */ }
  }
}

export function _clearWeatherCacheForTest(): void {
  memCache.clear()
  if (typeof sessionStorage !== 'undefined') {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(SESSION_PREFIX))
      .forEach((k) => sessionStorage.removeItem(k))
  }
}

// WMO weather-code → human label. https://open-meteo.com/en/docs
function describeCode(code: number): string {
  if (code === 0) return 'clear'
  if (code === 1) return 'mostly clear'
  if (code === 2) return 'partly cloudy'
  if (code === 3) return 'overcast'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'showers'
  if (code >= 95 && code <= 99) return 'thunderstorm'
  return 'mixed'
}

interface OpenMeteoResponse {
  current?: { temperature_2m?: number; weather_code?: number }
  hourly?: {
    time?: string[]
    temperature_2m?: number[]
    weather_code?: number[]
  }
}

function summariseDay(hourly: NonNullable<OpenMeteoResponse['hourly']>): {
  summary: string
  chips: WeatherChip[]
} {
  const times = hourly.time ?? []
  const temps = hourly.temperature_2m ?? []
  const codes = hourly.weather_code ?? []
  const at = (hour: number): { temp: number | null; code: number | null; label: string } => {
    const idx = times.findIndex((iso) => {
      const h = new Date(iso).getHours()
      return h === hour
    })
    if (idx < 0) return { temp: null, code: null, label: '' }
    const temp = temps[idx] ?? null
    const code = codes[idx] ?? null
    if (temp == null || code == null) return { temp: null, code: null, label: '' }
    return { temp, code, label: `${Math.round(temp)}° ${describeCode(code)}` }
  }
  const morning = at(8)
  const noon = at(13)
  const evening = at(19)
  const chips: WeatherChip[] = [
    morning.label && { time: '08:00', label: `AM ${describeCode(morning.code!)}` },
    noon.label && { time: '13:00', label: `noon ${describeCode(noon.code!)}` },
    evening.label && { time: '19:00', label: `PM ${describeCode(evening.code!)}` },
  ].filter(Boolean) as WeatherChip[]
  // Day-long summary: pick the dominant non-clear condition, or default to noon's label
  const allCodes = codes.filter((c) => c != null) as number[]
  const max = allCodes.length ? Math.max(...allCodes) : 0
  const summary = describeCode(max)
  return { summary, chips }
}

export async function getTodayWeather(city: string): Promise<TodayWeather | null> {
  const day = ymd(new Date())
  const key = cacheKey(city, day)
  const cached = readCache(key)
  if (cached) return cached

  const coords = CITY_COORDS[city.toLowerCase()] ?? CITY_COORDS.brussels
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
    `&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code` +
    `&timezone=auto&forecast_days=1`

  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json() as OpenMeteoResponse
    const temp = data.current?.temperature_2m
    if (typeof temp !== 'number') return null
    const { summary, chips } = data.hourly ? summariseDay(data.hourly) : { summary: 'unknown', chips: [] as WeatherChip[] }
    const w: TodayWeather = {
      city,
      temp_c: temp,
      summary,
      chips,
      fetched_at: new Date().toISOString(),
    }
    writeCache(key, w)
    return w
  } catch {
    return null
  }
}
