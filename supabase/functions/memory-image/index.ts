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
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

interface MemoryRow {
  id: string;
  event_id: string;
  user_id: string;
  source: string;
  external_id: string | null;
  media_url: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const memoryId = url.searchParams.get("memory_id") ?? url.pathname.split("/").filter(Boolean).pop();
  if (!memoryId) return new Response("Missing memory_id", { status: 400 });

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("Authorization required", { status: 401 });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Server config error", { status: 500 });
  }

  const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: memory, error: memError } = await supabaseUser
    .from("event_memories")
    .select("id, event_id, user_id, source, external_id, media_url")
    .eq("id", memoryId)
    .maybeSingle();

  if (memError || !memory) return new Response("Not found", { status: 404 });

  const row = memory as MemoryRow;

  // Bytes already cached in storage (manual upload or picker import) — redirect to public URL.
  if (row.media_url) {
    return Response.redirect(row.media_url, 302);
  }

  if (row.source === "upload") {
    return new Response("No photo URL", { status: 404 });
  }

  if (row.source !== "google_drive" && row.source !== "google_photos") {
    return new Response("Unsupported source", { status: 400 });
  }
  if (!row.external_id) return new Response("Missing external_id", { status: 400 });

  // Service role required: we need the photo owner's OAuth tokens (row.user_id may differ from requestor for shared memories).
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: tokenRow, error: tokenError } = await supabaseAdmin
    .from("user_oauth_tokens")
    .select("access_token, expires_at, refresh_token")
    .eq("user_id", row.user_id)
    .eq("provider", "google")
    .maybeSingle();

  if (tokenError || !tokenRow) {
    return new Response("Photo owner has not connected Google", { status: 403 });
  }

  let accessToken = tokenRow.access_token;
  const now = new Date();
  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at) : null;
  const needRefresh = !accessToken || !expiresAt || expiresAt.getTime() - now.getTime() < 60 * 1000;

  if (needRefresh && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        tokenRow.refresh_token,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET
      );
      accessToken = access_token;
      await supabaseAdmin
        .from("user_oauth_tokens")
        .update({
          access_token: access_token,
          expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", row.user_id)
        .eq("provider", "google");
    } catch (e) {
      console.error("Token refresh failed", e);
      return new Response("Failed to refresh token", { status: 502 });
    }
  }

  if (!accessToken) return new Response("No access token", { status: 502 });

  try {
    if (row.source === "google_drive") {
      const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.external_id)}?alt=media`;
      const driveRes = await fetch(driveUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!driveRes.ok) {
        return new Response("Photo unavailable", { status: driveRes.status === 404 ? 404 : 502 });
      }
      const contentType = driveRes.headers.get("Content-Type") ?? "image/jpeg";
      return new Response(driveRes.body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=300",
          ...corsHeaders,
        },
      });
    }

    if (row.source === "google_photos") {
      const metaRes = await fetch(
        `https://photoslibrary.googleapis.com/v1/mediaItems/${encodeURIComponent(row.external_id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!metaRes.ok) {
        return new Response("Photo unavailable", { status: metaRes.status === 404 ? 404 : 502 });
      }
      const meta = (await metaRes.json()) as { baseUrl?: string };
      const baseUrl = meta.baseUrl;
      if (!baseUrl) return new Response("Photo URL not available", { status: 502 });
      const mediaUrl = baseUrl.includes("?") ? `${baseUrl}&access_token=${accessToken}` : `${baseUrl}?access_token=${accessToken}`;
      const mediaRes = await fetch(mediaUrl);
      if (!mediaRes.ok) return new Response("Photo unavailable", { status: 502 });
      const contentType = mediaRes.headers.get("Content-Type") ?? "image/jpeg";
      return new Response(mediaRes.body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=300",
          ...corsHeaders,
        },
      });
    }
  } catch (e) {
    console.error("Proxy fetch failed", e);
    return new Response("Failed to load photo", { status: 502 });
  }

  return new Response("Unsupported source", { status: 400 });
});
