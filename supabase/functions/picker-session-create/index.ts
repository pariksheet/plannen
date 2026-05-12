import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { refreshGoogleAccessToken } from "../_shared/googleOAuth.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Server config error" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "Authorization required" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: row, error: tokenError } = await supabase
    .from("user_oauth_tokens")
    .select("access_token, expires_at, refresh_token")
    .eq("provider", "google")
    .maybeSingle();
  if (tokenError || !row) return jsonResponse({ error: "Google not connected" }, 404);

  let accessToken = row.access_token;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const needRefresh = !accessToken || !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000;
  if (needRefresh) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        row.refresh_token,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
      );
      accessToken = access_token;
      await supabase
        .from("user_oauth_tokens")
        .update({
          access_token,
          expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("provider", "google");
    } catch (e) {
      console.error("Token refresh failed", e);
      return jsonResponse({ error: "Failed to refresh Google token" }, 502);
    }
  }

  const sessionRes = await fetch("https://photospicker.googleapis.com/v1/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    console.error("Picker session create failed", sessionRes.status, text);
    return jsonResponse({ error: "Failed to create picker session", detail: text }, 502);
  }

  const session = await sessionRes.json();
  return jsonResponse(session);
});
