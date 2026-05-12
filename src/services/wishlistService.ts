import { supabase } from '../lib/supabase'
import { Event, resolveEventStatus } from '../types/event'

export async function getWishlistEvents(): Promise<{ data: Event[] | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('created_by', user.id)
    .in('event_status', ['watching', 'missed'])
    .order('start_date', { ascending: true })
  if (error) return { data: null, error: new Error(error.message) }
  return { data: (data ?? []).map((e) => resolveEventStatus(e as Event)), error: null }
}
