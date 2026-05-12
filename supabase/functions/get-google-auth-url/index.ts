import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
// SUPABASE_URL inside the Supabase local Docker stack is http://kong:8000, which Google rejects.
// Set GOOGLE_OAUTH_REDIRECT_URI to a host-accessible URL registered on the OAuth client.
const GOOGLE_OAUTH_REDIRECT_URI = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const PHOTOS_PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Google OAuth or Supabase not configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "Authorization required" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return jsonResponse({ error: "Invalid or expired token" }, 401);

  const state = crypto.randomUUID();
  const redirectUri = GOOGLE_OAUTH_REDIRECT_URI ?? `${SUPABASE_URL}/functions/v1/google-oauth-callback`;
  const scope = [DRIVE_SCOPE, PHOTOS_PICKER_SCOPE].join(" ");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
    access_type: "offline",
    prompt: "consent",
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  const { error: insertError } = await supabase.from("oauth_state").insert({
    state,
    user_id: user.id,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (insertError) return jsonResponse({ error: "Failed to create state" }, 500);

  return jsonResponse({ url, state });
});
