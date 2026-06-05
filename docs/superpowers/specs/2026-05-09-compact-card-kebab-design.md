# Compact Event Card — Action Kebab Design

**Date:** 2026-05-09
**Status:** Approved, ready for implementation plan
**Component:** `src/components/EventCard.tsx`

## Problem

The compact `EventCard` (`viewMode='compact'`) is missing two actions that exist on the detailed card: **Invite** (organizer-only) and **Delete** (organizer-only). The compact action strip is already at 5–6 icons on the right side (status badges + Clone + Share/WhatsApp + Edit + Calendar), so naively adding two more icons would overflow on mobile.

Today, an organizer who wants to delete or invite from the compact view has to first tap the card to open the detail modal, then act from there. That's an extra tap for routine actions.

## Solution

Reorganise the compact card's action row into a hybrid pattern:

- **Frequent actions stay inline** as icon buttons.
- **Rare or destructive actions collapse into a kebab `⋯` dropdown** anchored to the action strip.

The detailed card (`viewMode='detailed'`) is untouched.

## Inline strip layout

Right side of the compact card, after the existing share-status badges (Family / Friends / Lock):

| Role | Inline icons (left → right) |
|---|---|
| Organizer | Share, Edit, Invite, `⋯` |
| Non-organizer | WhatsApp, `⋯` |

Existing per-icon visibility rules carry over:

- **Share** — `showActions && isOrganizer`
- **WhatsApp** — `showActions && !isOrganizer`
- **Edit** — `onEdit && isOrganizer`
- **Invite** — `showActions && isOrganizer` *(new for compact; mirrors the detailed view's existing rule)*

## Kebab dropdown contents

When opened, the `⋯` button renders a portal popover with these items, in order:

1. ⬇️ **Download .ics** — `!isReminder`
2. 📅 **Google Calendar** — `!isReminder`
3. 📅 **Outlook** — `!isReminder`
4. ─── divider — only if both calendar group and below-divider group have ≥1 item
5. 📄 **Clone** — `onClone` provided (no organizer gate; non-organizers can clone)
6. 🗑️ **Delete** — `onDelete && isOrganizer`

### Kebab visibility

Hide the `⋯` button entirely when the dropdown would have zero items. This can happen for, e.g., a reminder card with no clone callback for a non-organizer.

### Behaviour

- Same portal + outside-click pattern as the existing in-card calendar dropdown (`EventCard.tsx` lines 558–599) for visual and behavioural consistency: portal-rendered, fixed positioning anchored to the kebab button via `getBoundingClientRect()`, dismissed on click outside the trigger or the portal.
- Calendar links call the same helpers already imported (`downloadIcs`, `getGoogleCalendarAddUrl`, `getOutlookCalendarAddUrl`) and pass the same `visitDate` argument when present.
- Delete calls existing `onDelete(event.id)` — the caller (currently passed from `EventList` / `Timeline`) is already responsible for any confirmation UX.

## Removed from compact

The current inline calendar button and its standalone dropdown (lines 537–551 trigger; 557–599 portal) are **removed from the compact view**. Their three options live inside the kebab.

The detailed view keeps its inline calendar button and its dropdown unchanged.

## Out of scope

- No changes to the detailed view (`viewMode='detailed'`).
- No new confirmation dialog for Delete in this change — caller handles it.
- No keyboard shortcuts; no animation polish beyond what the existing dropdown uses.
- No reordering of inline icons beyond what is specified.

## Acceptance

- Organizer compact card shows: status badges, Share, Edit, Invite, `⋯`. Kebab contains 3 calendar options + Clone + Delete.
- Non-organizer compact card shows: status badges, WhatsApp, `⋯`. Kebab contains 3 calendar options + Clone.
- Reminder card (calendar group suppressed): kebab shows Clone + (Delete if organizer); kebab hidden entirely if neither applies. Inline Share / WhatsApp / Edit / Invite still appear on reminders per their existing rules — they are not gated on `isReminder`.
- Detailed card pixel-identical to before.
