# Audit 02 — Sharing & WhatsApp

## Summary

Plannen surfaces three distinct sharing/invite affordances:

1. **`EventShareModal`** — sets event visibility flags (`shared_with_family`, `shared_with_friends`, group IDs) on the event row. Also exposes a "Share to WhatsApp" link that opens a pre-filled `wa.me` message. The "Share to WhatsApp" link inside this modal is the **only place** the share modal actually pushes content to anyone outside Plannen; the rest of the modal toggles in-app visibility flags only.
2. **`EventInviteModal`** — generates / fetches a token-backed invite URL (`/invite/:token`) for the event and exposes a copy-to-clipboard button. The recipient still needs a Plannen account; the join handler is currently stubbed out (no-op).
3. **`InviteToApp`** — the dashboard "Invite someone to Plannen" form. Records the email locally (no-op in Tier 0), tries to send a magic-link email via the `send-invite-email` edge function, and offers a WhatsApp share fallback containing only the bare `/login` URL.

A fourth share surface lives directly on `EventCard.tsx`: non-organizers see a WhatsApp icon (`getWhatsAppShareUrl`) on each event card.

**Solo-mode reality check.** The deployment is single-user / local-only. The "share with family / friends / groups" toggles all write to DB columns on `plannen.events`, but in Tier 0 nobody else is logging in to read them — so the visibility flags only affect what shows up in *the same user's* MyFamily / MyFriends / MyGroups feeds. The `EventInviteModal` flow is structurally broken in Tier 0: `getInviteByToken` and `joinEventByInvite` both return `null` / error (`src/services/inviteService.ts:18-44`). Invite tokens can be created, the URL can be copied, but the recipient can never actually join. **All three sharing surfaces are effectively `wa.me` text-blast wrappers in single-user mode; the rest is cruft pending a multi-user backend.**

Top failure-prone areas: `wa.me` link uses no recipient phone number (always opens the WhatsApp "pick a contact" sheet); the event link inside the WhatsApp message is just `VITE_APP_URL` root (no deep-link to the event); and the invite token UI promises a join flow that doesn't exist.

## Components reviewed

| File | LOC | Role | Backend reachable? |
|---|---|---|---|
| `src/components/EventShareModal.tsx` | 159 | Toggle in-app sharing flags; secondary "Share to WhatsApp" link | Partial (groups path works; selected-users path is silently dropped) |
| `src/components/EventInviteModal.tsx` | 77 | Generate `/invite/:token` URL; copy-to-clipboard | Token creation works; **join flow stubbed (`inviteService.ts:18-44`)** |
| `src/components/InviteToApp.tsx` | 105 | App-level invite by email + WhatsApp fallback | Email goes via Mailgun if configured; DB write is a Tier-0 no-op |
| `src/pages/InviteJoin.tsx` | 100 | Handler for `/invite/:token` | Always shows "Invalid or expired link" in Tier 0 because `getInviteByToken` returns null |
| `src/components/EventCard.tsx` | 970 | Hosts share/invite trigger buttons; renders modals | n/a |
| `src/utils/whatsappShare.ts` | 50 | Builds the WhatsApp share URL + message body | Pure utility |
| `src/services/inviteService.ts` | 44 | Token CRUD via `dbClient.groups.createInvite` | Create works (`backend/src/routes/api/groups.ts:60-84`); read by token does not |
| `src/services/appAccessService.ts` | 47 | App-allowed-emails + magic-link sender | DB write is a no-op; Mailgun call is real but only fires if env is set |
| `backend/src/routes/api/groups.ts` | 84 | `/api/groups/invites` POST + GET | Persists to `plannen.event_invites` but no public read-by-token route |
| `supabase/functions/_shared/handlers/send-invite-email.ts` | 96 | Mailgun wrapper for app-invite emails | Real, requires `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` (Tier 1 only) |
| `src/routes/AppRoutes.tsx` | 55 | Mounts `/invite/:token` → `InviteJoin` | Route exists |

## Flows reviewed

### Share event via WhatsApp

**Trigger surfaces:**

- `EventCard.tsx:504-516` — compact-view button shown to **non-organizers only** (`showActions && !isOrganizer`):
  ```tsx
  <a
    href={getWhatsAppShareUrl(event)}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => e.stopPropagation()}
    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[#25D366] hover:bg-[#25D366]/10"
    aria-label="Share to WhatsApp"
    title="Share to WhatsApp"
  >
    <MessageCircle className="h-3.5 w-3.5" />
  </a>
  ```
- `EventCard.tsx:724-736` — large-view equivalent (also non-organizer only).
- `EventShareModal.tsx:100-108` — link inside the share modal (organizer-only path since the kebab is gated on `isOrganizer`).
- `InviteToApp.tsx:85-98` — secondary WhatsApp button after a successful app invite.

**URL construction.** `src/utils/whatsappShare.ts:47-50`:

```ts
export function getWhatsAppShareUrl(event: Event, options?: WhatsAppShareOptions): string {
  const text = buildWhatsAppEventMessage(event, options)
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}
```

The `text` body comes from `buildWhatsAppEventMessage` (`whatsappShare.ts:17-42`), which assembles:

```
{event.title}
📅 {date range}
[Visit: {visitDate}]
[📍 {location}]
(blank line)
View in Plannen: {APP_URL}
```

`encodeURIComponent` is applied once to the whole text. That correctly handles emoji (`📅`, `📍`), `&`, `#`, and newlines — so the URL itself is well-formed.

**Issues:**

- `[BROKEN]` **The "View in Plannen" link is the app root, not a deep-link to the event.** `whatsappShare.ts:38` does `View in Plannen: ${APP_URL}`. The recipient clicking the link lands on `/` → `Navigate to /dashboard`. There is no `/events/:id` route registered in `src/routes/AppRoutes.tsx` to deep-link to anyway. **In a single-user app where the recipient probably isn't logged in, they hit `/dashboard`, get bounced to `/login`, and the connection between the shared message and the event is lost entirely.**
- `[MINOR]` `APP_URL` falls back to `http://localhost:4321` (`whatsappShare.ts:4`). If `VITE_APP_URL` isn't set at build time, every WhatsApp message contains a `localhost` URL that's useless to the recipient.
- `[MINOR]` `wa.me/?text=…` (empty phone field) always opens WhatsApp's contact-picker. That's the intended fallback when you don't know the phone number, but combined with the empty event link it makes this flow a "copy this text into WhatsApp" affordance rather than a real share.
- `[MINOR]` `buildWhatsAppEventMessage` formats time with `format(start, 'MMM d, yyyy, h:mm a')` even when `event.start_date` has no time component (e.g. a 00:00 date-only entry). All-day events read "Jan 5, 2027, 12:00 AM" in the message body. Compare to `EventCard.tsx:407-411` which suppresses zero-time stamps; the WhatsApp message does not.

### Share event via system share-sheet (`navigator.share`)

**Result:** the project does **not** use `navigator.share` anywhere.

```
$ grep -rn "navigator\.share" src/
(no matches)
```

There is no Web Share API integration and therefore no system share-sheet fallback. The only share path is the explicit `wa.me` link. This is a deliberate choice (or an oversight) — on iOS Safari and Android Chrome, `navigator.share` would let the user pick WhatsApp, Telegram, Signal, Mail, AirDrop, etc. without the app hardcoding `wa.me`.

- `[MINOR]` No `navigator.share` integration means mobile users are funneled exclusively into WhatsApp. On a desktop where WhatsApp Web isn't logged in, the `wa.me` link still works (opens web.whatsapp.com), but there's no Mail/Signal/Telegram fallback.

### Copy link

**Trigger surface:** `EventInviteModal.tsx:63-71`. Only entry point.

**Implementation** (`EventInviteModal.tsx:31-40`):

```tsx
const handleCopy = async () => {
  if (!inviteUrl) return
  try {
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  } catch {
    setError('Could not copy to clipboard')
  }
}
```

**URL construction** (`EventInviteModal.tsx:29`):

```tsx
const inviteUrl = token
  ? `${typeof window !== 'undefined' ? window.location.origin : ''}/invite/${token}`
  : ''
```

**Issues:**

- `[RISKY]` `navigator.clipboard.writeText` requires a secure context (HTTPS or localhost). On HTTP-served Tier 0 deployments behind a non-localhost hostname (rare but possible), it throws and the user sees "Could not copy to clipboard" with no fallback path. No `document.execCommand('copy')` fallback, no manual-selectable text fallback (the input is `readOnly` but it's there — though without `select()` automation).
- `[MINOR]` `window.location.origin` — on Tier 0 dev the user copies `http://localhost:4321/invite/{token}`, which won't resolve on the recipient's machine. There's no use of `VITE_APP_URL` here (contrast with `whatsappShare.ts:4` and `InviteToApp.tsx:34-37`).
- `[BROKEN]` The `/invite/:token` route exists (`AppRoutes.tsx:18`) but `getInviteByToken` always returns `{ data: null, error: null }` (`inviteService.ts:18-25`). So the recipient — even if they receive a working URL — lands on the "Invalid or expired link" page (`InviteJoin.tsx:44-60`). See **Invite a family member / friend** flow below.

### Invite a family member / friend

**Trigger surfaces:**

- `EventCard.tsx:527-537` — compact-view "Invite" button (UserPlus icon), organizer-only.
- `EventCard.tsx:737-746` — large-view equivalent, organizer-only.

These open `EventInviteModal`, which:

1. Calls `getOrCreateEventInvite(event.id)` (`inviteService.ts:27-39`).
2. Hits `dbClient.groups.listInvites({ event_id })` → `dbClient.groups.createInvite({ event_id, expires_in_days: 7 })`.
3. The backend (`backend/src/routes/api/groups.ts:60-84`) generates a 48-char hex token, inserts into `plannen.event_invites`, returns the row.
4. UI builds `${window.location.origin}/invite/${token}` and renders a copy button.

**The recipient flow** (`InviteJoin.tsx:14-42`):

1. Hits `/invite/:token`.
2. If not authenticated → redirects to `/login?redirect=…`.
3. Once authed, calls `getInviteByToken(token)` → **stub returns `null`** (`inviteService.ts:18-25` comment: *"The original implementation used a Supabase RPC; no equivalent REST yet."*).
4. UI renders "Invalid or expired link".
5. Even if the lookup worked, `joinEventByInvite` is hard-coded to return an error (`inviteService.ts:42-44`).

**Issues:**

- `[BROKEN]` **Invite-by-link end-to-end does not function.** The token is generated and persisted, but the redemption path (read-by-token + join) is explicitly unimplemented. The user-visible promise — "Only people with this link can join" (`EventInviteModal.tsx:46`) — is false. Either:
  - delete the modal and stop generating tokens, or
  - implement `GET /api/groups/invites/:token` (public, no auth) + `POST /api/groups/invites/:token/redeem` on the backend.
- `[MINOR]` No WhatsApp share button inside `EventInviteModal` — only copy. The `EventShareModal` has the WhatsApp link but no token-based invite URL in its message. Users who want to send the invite link via WhatsApp have to manually copy from one modal and switch to the other.
- `[MINOR]` The privacy warning text ("Don't share it publicly (e.g. on social media)") implies a real access-control gate exists. It doesn't.

### Invite to app

**Trigger surfaces:**

- `Navigation.tsx:106-112` — desktop "Invite" button in the top bar.
- `Navigation.tsx:189-197` — mobile menu "Invite" item.

Both call `onInviteClick` → `Dashboard.tsx:27, 70, 99-108` which opens a `Modal` containing `<InviteToApp />`.

**`InviteToApp` flow** (`src/components/InviteToApp.tsx`):

1. User enters email (+ optional name).
2. `inviteEmailToApp(trimmed)` runs (`appAccessService.ts:23-28`):
   ```ts
   export async function inviteEmailToApp(email: string): Promise<{ error: Error | null }> {
     const trimmed = email.trim().toLowerCase()
     if (!trimmed) return { error: new Error('Email is required') }
     // No REST endpoint for app_allowed_emails yet; treat as a no-op in Tier 0.
     return { error: null }
   }
   ```
3. `sendInviteEmail(trimmed)` (`appAccessService.ts:31-47`) → POSTs to the `send-invite-email` edge function, which Mailgun-sends a templated email (`send-invite-email.ts:26-95`). Requires `MAILGUN_API_KEY` + `MAILGUN_DOMAIN`; fails with HTTP 500 otherwise.
4. UI also builds a WhatsApp fallback URL (`InviteToApp.tsx:34-41`):
   ```tsx
   const appUrl =
     (import.meta.env.VITE_APP_URL as string | undefined) ||
     'http://localhost:4321'
   const loginUrl = `${appUrl.replace(/\/+$/, '')}/login`
   const inviterName = profile?.full_name || profile?.email || 'a friend'
   const shareText = `You're invited to join Plannen by ${inviterName}. Click here to sign in: ${loginUrl}`
   const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`
   ```
5. WhatsApp button opens that URL via `window.open(waUrl, '_blank', 'noopener,noreferrer')` (`InviteToApp.tsx:91`).

**Issues:**

- `[BROKEN]` `inviteEmailToApp` is a no-op (`appAccessService.ts:25-28`). The success message ("Invite email sent…") tells the user they did something multi-step, but the DB write is silently skipped. If `sendInviteEmail` succeeds, the only effect is a Mailgun email — there's no `app_allowed_emails` allow-list maintained, and there's no DB record of who was invited.
- `[BROKEN]` Tier 0 has no Mailgun: `send-invite-email` returns HTTP 500 (`send-invite-email.ts:41-46`) when `MAILGUN_API_KEY`/`MAILGUN_DOMAIN` are unset. In that case `InviteToApp.tsx:43-49` falls through to: *"Invite saved, but we couldn't send the email. You can share the link on WhatsApp or ask them to visit {loginUrl} and log in with {email}."* — but **nothing was saved** and Tier 0 has no auth backend that recognizes the email at all. The WhatsApp fallback is the only thing that does something.
- `[RISKY]` `loginUrl` defaults to `http://localhost:4321/login`. Same hazard as the event-share flow: if `VITE_APP_URL` isn't set, recipients get a localhost link.
- `[MINOR]` `name` is collected (`InviteToApp.tsx:13, 66-73`) but never sent anywhere — neither to the no-op DB call, the Mailgun handler, nor the WhatsApp message. It's UI-only state.
- `[MINOR]` After success the WhatsApp button stays visible but uses `window.open` rather than an `<a href>` (`InviteToApp.tsx:88-97`). Inconsistent with `EventShareModal.tsx:100-108` which uses `<a>`. Both work, but `window.open` is blocked by Safari pop-up rules in some configurations.
- `[MINOR]` `setEmail('')`/`setName('')` happen after success (`InviteToApp.tsx:50-51`), but `whatsAppUrl` survives. Clicking "Share invite on WhatsApp" later still works — fine, but the previous email is no longer visible to remind the user who they invited.

### Sidebar — MCP / `whatsapp-notify`

The MCP search (`grep -rn "whatsapp" mcp/src/`) returns one hit:

```
mcp/src/index.ts:1964: "...accepts the end-of-discovery batch ask. ... 'send X to whatsapp' ..."
```

This is just example phrasing in the `save_source` tool description — there is no `whatsapp-notify` tool or external WhatsApp notification path inside the MCP. The UI's `wa.me` links and the MCP don't overlap or conflict.

## Issues found

### [BROKEN]

1. **Invite-link redemption is unimplemented.** `EventInviteModal` generates real, persisted tokens, but `getInviteByToken` (`inviteService.ts:18-25`) and `joinEventByInvite` (`inviteService.ts:42-44`) are stubs. Recipients always see "Invalid or expired link" on `/invite/:token`. The UI text "Only people with this link can join" is a lie.
2. **WhatsApp share message points at the app root, not the event.** `whatsappShare.ts:38` appends `View in Plannen: ${APP_URL}` — there's no `/events/:id` route, and `APP_URL` is the bare origin. Recipients can't navigate from the message to the event itself.
3. **App-invite DB step is a no-op.** `appAccessService.ts:25-28` (`inviteEmailToApp`) does nothing in Tier 0, but the UI flow tells the user the invite was "saved". No allow-list is maintained.
4. **App-invite email requires Tier 1 Mailgun env.** In Tier 0 the `send-invite-email` edge function returns HTTP 500. The UI message ("Invite saved, but we couldn't send the email…") then claims the recipient can "visit {loginUrl} and log in with {email}" — but Tier 0's auth layer is single-user and won't recognise that email at all.

### [RISKY]

1. **Copy-to-clipboard has no fallback.** `EventInviteModal.tsx:31-40` only handles the happy path; on insecure contexts the user sees a red error with no other way to grab the URL. The `<input readOnly>` doesn't auto-select on focus.
2. **`localhost` defaults leak into share messages.** Both `whatsappShare.ts:4` and `InviteToApp.tsx:34-37` fall back to `http://localhost:4321` when `VITE_APP_URL` is unset. Shipped Tier-0 builds without an explicit `VITE_APP_URL` will produce useless share text.

### [MINOR]

1. **No `navigator.share` fallback.** Mobile users are funneled exclusively to WhatsApp; no system share-sheet path exists.
2. **All-day events render as "12:00 AM".** `buildWhatsAppEventMessage` (`whatsappShare.ts:23-25`) always formats with `h:mm a` even when `event.start_date` has no time. `EventCard.tsx:409` already has the right pattern (suppress zero-time stamps) — port it.
3. **`name` field in `InviteToApp` is never sent anywhere.** `InviteToApp.tsx:13, 66-73`.
4. **`EventInviteModal` has no WhatsApp share button.** Users wanting to send the invite link via WhatsApp must copy it manually. Either add one or merge `EventShareModal` + `EventInviteModal`.
5. **Inconsistent open-link technique.** `EventShareModal.tsx:100-108` uses `<a target="_blank">`; `InviteToApp.tsx:88-97` uses `window.open`. Pick one.
6. **`EventShareModal` `selected friends` path silently fails.** `eventService.ts:108-111` notes *"event_shared_with_users is not yet surfaced via REST — skip in Tier 0"*. The modal's `FriendPicker` writes to local state, the save call succeeds, but no rows land in the bridge table. Users can pick friends and the picks are lost.
7. **Non-organizer share affordance is asymmetric.** `EventCard.tsx:504-516` shows a WhatsApp icon for non-organizers, but a different `Share2` icon for organizers (which opens `EventShareModal`). The two icons don't visually communicate "this is the same flow under the hood" or "these are different flows" — they're just different.
8. **`getEventSharedWithUserIds` returns empty.** `eventService.ts:185-188` is hard-coded `{ data: [], error: null }`. The modal's "Selected friends" view will always render with zero checked friends even if the user previously selected some. Combined with #6, the per-friend share is effectively dead.

## Open questions

1. Is the multi-user "share with friends / groups / family" model still on the roadmap, or has it been quietly deprecated in favour of single-user + WhatsApp? The half-built code (group-share works; per-user share doesn't; invite tokens persist but can't be redeemed) is the worst of both worlds. **Decision needed: implement the missing pieces, or rip them out.**
2. Should the WhatsApp message include a deep-link to a public event view that doesn't require login? If yes, that's a new public route + a tokenised read endpoint. If no, the "View in Plannen: {url}" line should probably be removed entirely.
3. Why does `EventCard` show the WhatsApp icon to non-organizers but the share-toggles modal to organizers? Is the intent that non-organizers can't change visibility but can still forward? If so, organizers should *also* be able to forward via WhatsApp from the card (without opening the share modal).
4. Should `InviteToApp` still exist in Tier 0? Currently the only useful effect is the WhatsApp fallback, which has nothing to do with email — a simpler "Share Plannen on WhatsApp" button would do the same job without the no-op DB step and broken Mailgun path.
5. Is `app_allowed_emails` a real Tier 1 feature, or vestigial? `appAccessService.ts:13-20` checks Tier-1 access with a `me.get()` call (i.e. "is the user logged in") rather than an allow-list lookup. The original gating logic seems to have been dropped during the v0 REST migration.
6. Should `EventInviteModal` and `EventShareModal` be merged? They share a host event, both deal with "who can see this event", and they're triggered side-by-side. The mental model split between "set sharing flags" and "send a one-off invite link" is real, but the UI cost of two separate modals — plus the inconsistency that one of them has WhatsApp and the other doesn't — is high.
