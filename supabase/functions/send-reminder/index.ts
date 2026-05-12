import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    })
  }

  try {
    // Cron/scheduled: no user context; service_role required to query events and send reminders.
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { db: { schema: 'plannen' } }
    )

    // Get events with enrollment deadlines in the next 24 hours
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    const { data: events, error: eventsError } = await supabaseClient
      .from('events')
      .select('*, created_by_user:users!events_created_by_fkey(email, full_name)')
      .not('enrollment_deadline', 'is', null)
      .gte('enrollment_deadline', now.toISOString())
      .lte('enrollment_deadline', tomorrow.toISOString())

    if (eventsError) {
      throw eventsError
    }

    if (!events || events.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No events with upcoming enrollment deadlines' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      )
    }

    // For each event, send reminder email
    const results = []
    for (const event of events) {
      if (!event.created_by_user?.email) continue

      // In a real implementation, you would use Mailgun or another email service here
      // For now, we'll just log the reminder
      const reminderData = {
        to: event.created_by_user.email,
        subject: `Reminder: Enrollment deadline for ${event.title}`,
        message: `The enrollment deadline for "${event.title}" is approaching. Deadline: ${new Date(event.enrollment_deadline).toLocaleString()}`,
        event_id: event.id,
      }

      // TODO: Integrate with Mailgun
      // const mailgunResponse = await fetch('https://api.mailgun.net/v3/...', {
      //   method: 'POST',
      //   headers: {
      //     'Authorization': `Basic ${btoa(`api:${Deno.env.get('MAILGUN_API_KEY')}`)}`,
      //     'Content-Type': 'application/x-www-form-urlencoded',
      //   },
      //   body: new URLSearchParams({
      //     from: 'noreply@plannen.app',
      //     to: reminderData.to,
      //     subject: reminderData.subject,
      //     text: reminderData.message,
      //   }),
      // })

      results.push({
        event_id: event.id,
        email: reminderData.to,
        status: 'sent', // or 'failed' if mailgun fails
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
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  }
})
