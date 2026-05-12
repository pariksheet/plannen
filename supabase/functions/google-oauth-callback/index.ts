import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const APP_OAUTH_REDIRECT_URL = Deno.env.get("APP_OAUTH_REDIRECT_URL") ?? "http://localhost:4321/dashboard";
// Must match the redirect_uri sent in the auth request (see get-google-auth-url).
const GOOGLE_OAUTH_REDIRECT_URI = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI");

function redirect(url: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: url } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const baseRedirect = APP_OAUTH_REDIRECT_URL.replace(/\?.*$/, "");
  const append = (params: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return `${baseRedirect}?${q.toString()}`;
  };

  if (errorParam) {
    return redirect(append({ google_oauth: "error", error: errorParam }));
  }
  if (!code || !state) {
    return redirect(append({ google_oauth: "error", error: "missing_code_or_state" }));
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return redirect(append({ google_oauth: "error", error: "server_config" }));
  }

  // No user JWT in OAuth callback (redirect from Google); must look up state and write tokens by user_id.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: "plannen" },
  });
  const { data: stateRow, error: stateError } = await supabase
    .from("oauth_state")
    .select("user_id")
    .eq("state", state)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (stateError || !stateRow) {
    return redirect(append({ google_oauth: "error", error: "invalid_or_expired_state" }));
  }

  await supabase.from("oauth_state").delete().eq("state", state);

  const redirectUri = GOOGLE_OAUTH_REDIRECT_URI ?? `${SUPABASE_URL}/functions/v1/google-oauth-callback`;
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("Google token exchange failed", tokenRes.status, errText);
    return redirect(append({ google_oauth: "error", error: "token_exchange_failed" }));
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokens.refresh_token) {
    return redirect(append({ google_oauth: "error", error: "no_refresh_token" }));
  }

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { error: upsertError } = await supabase.from("user_oauth_tokens").upsert(
    {
      user_id: stateRow.user_id,
      provider: "google",
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: expiresAt,
      scopes: "drive.readonly photospicker.mediaitems.readonly",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );

  if (upsertError) {
    console.error("Failed to store tokens", upsertError);
    return redirect(append({ google_oauth: "error", error: "save_failed" }));
  }

  return redirect(append({ google_oauth: "success" }));
});
