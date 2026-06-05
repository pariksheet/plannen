export interface DiscoveryResult {
  title: string
  description?: string | null
  url: string
  image_url?: string | null
  start_date?: string | null
  end_date?: string | null
  enrollment_deadline?: string | null
  location?: string | null
}

export interface ScrapeExtracted {
  title?: string | null
  description?: string | null
  image_url?: string | null
  start_date?: string | null
  end_date?: string | null
  start_time?: string | null
  end_time?: string | null
  enrollment_deadline?: string | null
  location?: string | null
  dates?: string[]
}

export interface ScrapeResponse {
  success?: boolean
  extracted?: ScrapeExtracted
  method?: 'llm' | string
  error?: string
}
