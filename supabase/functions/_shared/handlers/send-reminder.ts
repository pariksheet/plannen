// Scheduled (cron) reminder dispatcher. Scans events whose enrollment
// deadline is in the next 24 hours and logs the would-be email per event.
// Mailgun integration is a TODO in the original; we keep that as-is.
//
// Runs without a user JWT (cron context); on Tier 1 that means service_role
// and on Tier 0 it means the resolved single-user backend context. Either
// way, `ctx.db.query` is the only db surface used here.

import type { HandlerCtx } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    const { rows: events } = await ctx.db.query(
      `SELECT e.id, e.title, e.enrollment_deadline,
              u.email AS creator_email, u.full_name AS creator_full_name
         FROM plannen.events e
         LEFT JOIN plannen.users u ON u.id = e.created_by
        WHERE e.enrollment_deadline IS NOT NULL
          AND e.enrollment_deadline >= $1
          AND e.enrollment_deadline <= $2`,
      [now.toISOString(), tomorrow.toISOString()],
    )

    if (!events || events.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No events with upcoming enrollment deadlines' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      )
    }

    const results: { event_id: string; email: string; status: string }[] = []
    for (const event of events) {
      if (!event.creator_email) continue
      const reminderData = {
        to: event.creator_email as string,
        subject: `Reminder: Enrollment deadline for ${event.title}`,
        message: `The enrollment deadline for "${event.title}" is approaching. Deadline: ${new Date(event.enrollment_deadline).toLocaleString()}`,
        event_id: event.id as string,
      }

      // TODO: Integrate with Mailgun (matches the original index.ts placeholder).

      results.push({
        event_id: event.id as string,
        email: reminderData.to,
        status: 'sent',
      })
    }

    return new Response(
      JSON.stringify({
        message: `Processed ${results.length} reminders`,
        results,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      },
    )
  }
}
