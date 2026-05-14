import { dbClient } from '../lib/dbClient'
import { Event, resolveEventStatus } from '../types/event'

export async function getWishlistEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  try {
    const data = await dbClient.wishlist.list() as unknown as Event[]
    return { data: data.map((e) => resolveEventStatus(e)), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get wishlist failed') }
  }
}
