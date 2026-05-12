import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { generate, aiErrorResponse, AIError } from '../_shared/ai.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Tiny round-trip to verify the user's saved AI provider works. Used by the
// Settings page Test button. Cheaper than /v1/models because it proves auth +
// model access in one shot.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  try {
    const text = await generate(req, { prompt: 'Reply with just "ok".', maxTokens: 16 })
    return new Response(
      JSON.stringify({ success: true, sample: text.slice(0, 64) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    )
  } catch (err) {
    if (err instanceof AIError) return aiErrorResponse(err, corsHeaders)
    return new Response(
      JSON.stringify({
        success: false,
        error: 'unknown_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})
