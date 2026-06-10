import { dbClient } from '../lib/dbClient'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'

export async function listPractices(activeOnly = true): Promise<PracticeRow[]> {
  return dbClient.practices.list({ active_only: activeOnly })
}

export async function createPractice(input: Partial<PracticeRow> & {
  name: string
  category: PracticeRow['category']
  recurrence_mode: PracticeRow['recurrence_mode']
}): Promise<PracticeRow> {
  return dbClient.practices.create(input)
}

export async function updatePractice(id: string, patch: Partial<PracticeRow>): Promise<PracticeRow> {
  return dbClient.practices.update(id, patch)
}

export async function deletePractice(id: string): Promise<void> {
  await dbClient.practices.delete(id)
}

export async function markPracticeDone(practiceId: string, completedOn?: string): Promise<void> {
  await dbClient.practices.markDone({ practice_id: practiceId, completed_on: completedOn })
}

export async function unmarkPracticeDone(practiceId: string, completedOn: string): Promise<void> {
  await dbClient.practices.unmarkDone({ practice_id: practiceId, completed_on: completedOn })
}

export async function completionsThisWeek(date: string): Promise<PracticeCompletionRow[]> {
  return dbClient.practices.completionsThisWeek(date)
}
