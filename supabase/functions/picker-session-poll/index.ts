import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { refreshGoogleAccessToken } from "../_shared/googleOAuth.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
// SUPABASE_URL inside the local Docker stack is http://kong:8000, which the browser can't resolve.
// Set this to a host-accessible base so the public URLs we store work for clients.
const STORAGE_PUBLIC_URL_BASE = Deno.env.get("STORAGE_PUBLIC_URL_BASE") ?? SUPABASE_URL;

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

interface PickedMediaItem {
  id: string;
  type?: string;
  createTime?: string;
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
  };
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heif": "heif",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

function pickExtension(filename: string | undefined, contentType: string, itemType: string): string {
  // Filename's extension is the most accurate signal when present.
  if (filename) {
    const fromName = filename.toLowerCase().split(".").pop();
    if (fromName && fromName.length <= 4 && /^[a-z0-9]+$/.test(fromName)) return fromName;
  }
  // Then content-type.
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (MIME_TO_EXT[ct]) return MIME_TO_EXT[ct];
  // Final fallback by item type.
  if (itemType === "VIDEO") return "mp4";
  return "jpg";
}

function pickMediaType(contentType: string, filename: string | undefined): 'image' | 'video' | 'audio' {
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  if (contentType.startsWith('image/')) return 'image'
  // Fallback to extension
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? ''
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio'
  return 'image'
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Server config error" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const userJwt = authHeader?.replace(/^Bearer\s+/i, "");
  if (!userJwt) return jsonResponse({ error: "Authorization required" }, 401);

  let body: { sessionId?: string; eventId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const sessionId = body.sessionId;
  const eventId = body.eventId;
  if (!sessionId || !eventId) return jsonResponse({ error: "Missing sessionId or eventId" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser(userJwt);
  if (userError || !user) return jsonResponse({ error: "Invalid or expired token" }, 401);

  const { data: tokenRow, error: tokenError } = await supabase
    .from("user_oauth_tokens")
    .select("access_token, expires_at, refresh_token")
    .eq("provider", "google")
    .maybeSingle();
  if (tokenError || !tokenRow) return jsonResponse({ error: "Google not connected" }, 404);

  let accessToken = tokenRow.access_token;
  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at) : null;
  const needRefresh = !accessToken || !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000;
  if (needRefresh) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        tokenRow.refresh_token,
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

  const sessionRes = await fetch(
    `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    return jsonResponse({ error: "Failed to fetch session", detail: text }, 502);
  }
  const session = (await sessionRes.json()) as { mediaItemsSet?: boolean };
  if (!session.mediaItemsSet) {
    return jsonResponse({ status: "pending" });
  }

  const mediaItems: PickedMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const listRes = await fetch(
      `https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) {
      const text = await listRes.text();
      return jsonResponse({ error: "Failed to list picker items", detail: text }, 502);
    }
    const page = (await listRes.json()) as { mediaItems?: PickedMediaItem[]; nextPageToken?: string };
    if (page.mediaItems) mediaItems.push(...page.mediaItems);
    pageToken = page.nextPageToken;
  } while (pageToken);

  const attached: { external_id: string; memory_id: string; filename?: string }[] = [];
  const skipped: { external_id: string; reason: string }[] = [];

  for (const item of mediaItems) {
    if (!item.id || !item.mediaFile?.baseUrl) {
      skipped.push({ external_id: item.id ?? "", reason: "missing id or baseUrl" });
      continue;
    }
    if (item.type && item.type !== "PHOTO" && item.type !== "VIDEO") {
      skipped.push({ external_id: item.id, reason: `unsupported type ${item.type}` });
      continue;
    }

    const { data: existing } = await supabase
      .from("event_memories")
      .select("id")
      .eq("event_id", eventId)
      .eq("external_id", item.id)
      .maybeSingle();
    if (existing) {
      attached.push({ external_id: item.id, memory_id: existing.id, filename: item.mediaFile.filename });
      continue;
    }

    // Photos: =w1280 → JPEG ≤1280px wide. Browser-renderable regardless of source format (HEIF/HEIC etc.)
    // and ~60% smaller than =w2048 with no visible quality loss for memory display.
    // Videos: =dv downloads the actual video file (no transcoding available via picker API).
    const downloadUrl = item.type === "VIDEO"
      ? `${item.mediaFile.baseUrl}=dv`
      : `${item.mediaFile.baseUrl}=w1280`;
    const bytesRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!bytesRes.ok) {
      skipped.push({ external_id: item.id, reason: `download failed ${bytesRes.status}` });
      continue;
    }
    const contentType = bytesRes.headers.get('content-type') ?? ''
    const blob = await bytesRes.blob();
    const ext = pickExtension(item.mediaFile?.filename, contentType, item.type ?? "");
    const path = `${eventId}/${user.id}/${item.id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("event-photos")
      .upload(path, blob, { upsert: true, contentType: contentType || 'application/octet-stream' });
    if (uploadError) {
      skipped.push({ external_id: item.id, reason: `upload failed: ${uploadError.message}` });
      continue;
    }

    const publicUrl = `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/public/event-photos/${path}`;

    const { data: inserted, error: insertError } = await supabase
      .from("event_memories")
      .insert({
        event_id: eventId,
        user_id: user.id,
        source: "google_photos",
        external_id: item.id,
        media_url: publicUrl,
        media_type: pickMediaType(contentType, item.mediaFile?.filename),
        taken_at: item.createTime ?? null,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      skipped.push({ external_id: item.id, reason: `insert failed: ${insertError?.message ?? "unknown"}` });
      continue;
    }
    attached.push({ external_id: item.id, memory_id: inserted.id, filename: item.mediaFile.filename });
  }

  return jsonResponse({
    status: "complete",
    attached,
    skipped,
    total_selected: mediaItems.length,
  });
});
