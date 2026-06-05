import { dbClient } from '../lib/dbClient'
import type { DailyBriefingRow } from '../lib/dbClient/types'

export async function getTodayBriefing(date: string): Promise<DailyBriefingRow | null> {
  return dbClient.briefings.getByDate(date)
}

export async function saveBriefing(input: {
  briefing_date: string
  content_md: string
  summary?: string | null
  source: DailyBriefingRow['source']
}): Promise<DailyBriefingRow> {
  return dbClient.briefings.save(input)
}
