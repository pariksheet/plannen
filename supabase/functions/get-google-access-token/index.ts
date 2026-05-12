import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function refreshGoogleAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { access_token: data.access_token, expires_in: data.expires_in ?? 3600 };
}

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "Authorization required" }, 401);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Google OAuth or Supabase not configured" }, 500);
  }

  // Use user's JWT so RLS applies: only their own token row is visible.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: row, error: tokenError } = await supabase
    .from("user_oauth_tokens")
    .select("access_token, expires_at, refresh_token")
    .eq("provider", "google")
    .maybeSingle();

  if (tokenError || !row) return jsonResponse({ error: "Google not connected or invalid token" }, 404);

  const now = new Date();
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const needRefresh = !row.access_token || !expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

  let accessToken = row.access_token;
  if (needRefresh) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        row.refresh_token,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET
      );
      accessToken = access_token;
      const newExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
      await supabase
        .from("user_oauth_tokens")
        .update({ access_token: access_token, expires_at: newExpiresAt, updated_at: new Date().toISOString() })
        .eq("provider", "google");
    } catch (e) {
      console.error("Google token refresh failed", e);
      return jsonResponse({ error: "Failed to refresh Google token" }, 502);
    }
  }

  return jsonResponse({ access_token: accessToken });
});
