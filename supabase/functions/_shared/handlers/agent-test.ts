// Tiny round-trip to verify the user's saved AI provider works. Used by the
// Settings page Test button. Cheaper than /v1/models because it proves auth +
// model access in one shot.

import { generate, aiErrorResponse, AIError } from '../ai.ts'
import type { HandlerCtx } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'method_not_allowed', message: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
  try {
    const text = await generate(ctx, { prompt: 'Reply with just "ok".', maxTokens: 16 })
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
}
