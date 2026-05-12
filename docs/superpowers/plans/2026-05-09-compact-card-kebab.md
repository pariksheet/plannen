# Compact Card Action Kebab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Calendar, Clone, and Delete on the compact `EventCard` into a kebab `⋯` dropdown, and add Invite to the compact card's inline action strip for organizers. Detailed card is untouched.

**Architecture:** Single-file React change inside `src/components/EventCard.tsx`. The existing calendar dropdown portal (lines 557–599) is repurposed into a unified kebab menu that also holds Clone + Delete. A new `Invite` button is added to the compact inline strip mirroring the detailed view's existing rule. New tests live in `tests/components/EventCard.test.tsx`.

**Tech Stack:** React 18, TypeScript, Tailwind, lucide-react icons, Vitest + @testing-library/react + jsdom.

**Spec:** `docs/superpowers/specs/2026-05-09-compact-card-kebab-design.md`

---

## File Structure

- **Modify:** `src/components/EventCard.tsx`
  - Lines ~5: add `MoreVertical` to lucide import.
  - Lines ~159–164: rename `showCalendarMenu` / `setShowCalendarMenu` → `showKebabMenu` / `setShowKebabMenu`; rename `calendarTriggerRef` → `kebabTriggerRef`; rename `calendarMenuRef` → `kebabMenuRef`; rename `calendarPortalRef` → `kebabPortalRef`; rename `calendarMenuPosition` / `setCalendarMenuPosition` → `kebabMenuPosition` / `setKebabMenuPosition`; rename `calendarVisitDate` / `setCalendarVisitDate` → `kebabVisitDate` / `setKebabVisitDate`. (These pieces of state are only used for the dropdown — the rename keeps them honest about their new role.)
  - Lines ~217–243: update the two effects that referenced the old names.
  - Lines ~493–551: rebuild the compact action strip — keep status badges, Share, WhatsApp, Edit; add Invite for organizer; remove the inline Calendar button; add the kebab `⋯` button gated on `kebabHasItems`.
  - Lines ~557–599: replace the calendar-only dropdown contents with the unified kebab menu (3 calendar items, divider, Clone, Delete).
  - Lines ~605+: detailed view untouched.

- **Create:** `tests/components/EventCard.test.tsx`
  - Six tests covering: baseline render, organizer Invite inline, kebab opens with org contents, kebab opens with non-org contents (no Delete), kebab hidden when zero items, no inline Calendar button on compact.

---

## Reference: pre-existing visibility rules (kept unchanged)

| Action | Compact today | Compact after |
|---|---|---|
| Share (`Share2`) | `showActions && isOrganizer` | unchanged (inline) |
| WhatsApp (`MessageCircle`) | `showActions && !isOrganizer` | unchanged (inline) |
| Edit (`Pencil`) | `onEdit && isOrganizer` | unchanged (inline) |
| Invite (`UserPlus`) | **absent** | **`showActions && isOrganizer` (inline)** |
| Calendar (`CalendarPlus`) inline button | `!isReminder` | **removed from compact** |
| Calendar group inside kebab | n/a | `!isReminder` |
| Clone (`Copy`) | `onClone` | **moved to kebab** |
| Delete (`Trash2`) | **absent** | **`onDelete && isOrganizer` inside kebab** |

`kebabHasItems = (!isReminder) || (!!onClone) || (!!onDelete && isOrganizer)`. Hide the `⋯` button when this is false.

---

## Task 1: Test scaffolding for EventCard

Create the test file with mocks for the services that EventCard touches in `useEffect` so we can render the component in jsdom without network calls. Establish a baseline that the component renders.

**Files:**
- Create: `tests/components/EventCard.test.tsx`

- [ ] **Step 1: Confirm there is no existing EventCard test**

Run: `ls tests/components/`
Expected output contains `MyStories.test.tsx` but **not** `EventCard.test.tsx`.

- [ ] **Step 2: Write the scaffolding file**

Create `tests/components/EventCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import type { Event } from '../../src/types/event'
import { EventCard } from '../../src/components/EventCard'

// --- mocks ---------------------------------------------------------------

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../../src/services/rsvpService', () => ({
  getMyRsvp: vi.fn(() => Promise.resolve({ data: null, error: null })),
  getRsvpList: vi.fn(() => Promise.resolve({ data: [], error: null })),
}))

vi.mock('../../src/services/eventService', () => ({
  getEvent: vi.fn(() => Promise.resolve({ data: null, error: null })),
}))

vi.mock('../../src/services/agentTaskService', () => ({
  getEventWatchTask: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../src/services/calendarExport', () => ({
  downloadIcs: vi.fn(),
  getGoogleCalendarAddUrl: vi.fn(() => 'https://calendar.google.com/test'),
  getOutlookCalendarAddUrl: vi.fn(() => 'https://outlook.live.com/test'),
}))

vi.mock('../../src/utils/whatsappShare', () => ({
  getWhatsAppShareUrl: vi.fn(() => 'https://wa.me/test'),
}))

// Modals are imported unconditionally by EventCard but never opened in these tests.
vi.mock('../../src/components/EventDetailsModal', () => ({
  EventDetailsModal: () => null,
}))
vi.mock('../../src/components/EventShareModal', () => ({
  EventShareModal: () => null,
}))
vi.mock('../../src/components/EventInviteModal', () => ({
  EventInviteModal: () => null,
}))

import { useAuth } from '../../src/context/AuthContext'
const mockedUseAuth = vi.mocked(useAuth)

// --- helpers -------------------------------------------------------------

const ORG_ID = 'org-uuid'
const OTHER_ID = 'other-uuid'

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    user_id: ORG_ID,
    created_by: ORG_ID,
    title: 'Niheet swimming',
    description: null,
    start_date: '2026-05-09T10:00:00',
    end_date: '2026-05-09T11:00:00',
    location: 'Mechelen',
    event_kind: 'session',
    event_type: 'family',
    event_status: 'going',
    hashtags: [],
    enrollment_url: null,
    enrollment_deadline: null,
    enrollment_start_date: null,
    image_url: null,
    parent_event_id: null,
    parent_title: null,
    shared_with_family: false,
    shared_with_friends: 'none',
    user_timezone: 'Europe/Brussels',
    sessions_summary: null,
    my_rsvp_status: null,
    ...overrides,
  } as Event
}

function asOrganizer() {
  mockedUseAuth.mockReturnValue({ user: { id: ORG_ID } } as ReturnType<typeof useAuth>)
}

function asNonOrganizer() {
  mockedUseAuth.mockReturnValue({ user: { id: OTHER_ID } } as ReturnType<typeof useAuth>)
}

// --- tests ---------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EventCard compact', () => {
  it('renders the event title in compact mode', () => {
    asOrganizer()
    render(<EventCard event={makeEvent()} viewMode="compact" />)
    expect(screen.getByText('Niheet swimming')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the baseline test**

Run: `npx vitest run tests/components/EventCard.test.tsx`
Expected: 1 passed.

If the test fails on import (e.g. an Event field name mismatch), open `src/types/event.ts` and adjust the `makeEvent` factory to match — do not change anything in `EventCard.tsx`.

- [ ] **Step 4: Commit**

```bash
git add tests/components/EventCard.test.tsx
git commit -m "test: scaffold EventCard compact tests"
```

---

## Task 2: Failing test — Invite button inline for organizer in compact

Capture the gap that the spec is closing: today the compact card has no Invite button.

**Files:**
- Modify: `tests/components/EventCard.test.tsx`

- [ ] **Step 1: Add the failing test inside the existing `describe('EventCard compact', ...)` block**

```tsx
it('shows an inline Invite button for organizer when showActions=true', () => {
  asOrganizer()
  render(
    <EventCard
      event={makeEvent()}
      viewMode="compact"
      showActions
    />
  )
  expect(screen.getByRole('button', { name: /invite/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/components/EventCard.test.tsx -t "Invite button"`
Expected: FAIL — "Unable to find an accessible element with the role 'button' and name `/invite/i`".

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/components/EventCard.test.tsx
git commit -m "test: failing — compact card should expose Invite for organizer"
```

---

## Task 3: Failing test — kebab opens with organizer items

The kebab `⋯` is the new home for Calendar (3 options), Clone, and Delete.

**Files:**
- Modify: `tests/components/EventCard.test.tsx`

- [ ] **Step 1: Add the failing test**

```tsx
it('shows a kebab "More actions" button that opens with calendar items + Clone + Delete for organizer', () => {
  asOrganizer()
  render(
    <EventCard
      event={makeEvent()}
      viewMode="compact"
      showActions
      onClone={() => {}}
      onDelete={() => {}}
    />
  )
  const kebab = screen.getByRole('button', { name: /more actions/i })
  expect(kebab).toBeInTheDocument()
  fireEvent.click(kebab)

  // Items live in a portal — query the whole document.
  expect(screen.getByText(/Download \.ics/i)).toBeInTheDocument()
  expect(screen.getByText(/Google Calendar/i)).toBeInTheDocument()
  expect(screen.getByText(/Outlook/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^clone$/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/components/EventCard.test.tsx -t "kebab"`
Expected: FAIL — no element with name `/more actions/i`.

- [ ] **Step 3: Commit**

```bash
git add tests/components/EventCard.test.tsx
git commit -m "test: failing — kebab opens with calendar+clone+delete for organizer"
```

---

## Task 4: Failing test — kebab for non-organizer (no Delete)

**Files:**
- Modify: `tests/components/EventCard.test.tsx`

- [ ] **Step 1: Add the failing test**

```tsx
it('omits Delete from the kebab for non-organizer and still includes Calendar+Clone', () => {
  asNonOrganizer()
  render(
    <EventCard
      event={makeEvent()}
      viewMode="compact"
      showActions
      onClone={() => {}}
      onDelete={() => {}}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /more actions/i }))
  expect(screen.getByText(/Download \.ics/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^clone$/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/components/EventCard.test.tsx -t "non-organizer"`
Expected: FAIL.

- [ ] **Step 3: Commit**

```bash
git add tests/components/EventCard.test.tsx
git commit -m "test: failing — non-organizer kebab excludes Delete"
```

---

## Task 5: Failing test — kebab hidden when it would be empty

A reminder card for a non-organizer with no `onClone` callback should not render the `⋯` button at all (calendar group is suppressed for reminders, Clone needs a callback, Delete needs `onDelete && isOrganizer`).

**Files:**
- Modify: `tests/components/EventCard.test.tsx`

- [ ] **Step 1: Add the failing test**

```tsx
it('hides the kebab when it would render zero items', () => {
  asNonOrganizer()
  render(
    <EventCard
      event={makeEvent({ event_kind: 'reminder' })}
      viewMode="compact"
      showActions
      // no onClone, no onDelete
    />
  )
  expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/components/EventCard.test.tsx -t "hides the kebab"`
Expected: FAIL — currently the inline Calendar button is suppressed for reminders but no kebab exists at all, so `queryByRole` returns null and the test would actually *pass* by accident. To make it a true red, also assert that the test would fail once the kebab exists. To do this, add a sibling positive test for an organizer that has just one kebab item:

```tsx
it('renders the kebab when at least one item is available (org with onDelete only, reminder)', () => {
  asOrganizer()
  render(
    <EventCard
      event={makeEvent({ event_kind: 'reminder' })}
      viewMode="compact"
      showActions
      onDelete={() => {}}
    />
  )
  expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument()
})
```

Run: `npx vitest run tests/components/EventCard.test.tsx -t "kebab when at least"`
Expected: FAIL — kebab not implemented yet.

- [ ] **Step 3: Commit both visibility tests**

```bash
git add tests/components/EventCard.test.tsx
git commit -m "test: failing — kebab visibility (hidden when empty, shown otherwise)"
```

---

## Task 6: Failing test — inline Calendar button is gone from compact

Sanity check that the migration is complete and the old Calendar button doesn't linger inline.

**Files:**
- Modify: `tests/components/EventCard.test.tsx`

- [ ] **Step 1: Add the failing test**

```tsx
it('does not render an inline Calendar button on the compact card', () => {
  asOrganizer()
  render(
    <EventCard
      event={makeEvent()}
      viewMode="compact"
      showActions
      onClone={() => {}}
      onDelete={() => {}}
    />
  )
  // The kebab is allowed; what we forbid is a top-level button labelled "Add to calendar".
  // Before the kebab opens, only the kebab trigger should match — the calendar inline button must be gone.
  expect(screen.queryByRole('button', { name: /^add to calendar$/i })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/components/EventCard.test.tsx -t "inline Calendar"`
Expected: FAIL — current compact card still renders a button with `aria-label="Add to calendar"`.

- [ ] **Step 3: Commit**

```bash
git add tests/components/EventCard.test.tsx
git commit -m "test: failing — compact card should not render inline Calendar button"
```

---

## Task 7: Implementation — Invite inline + kebab dropdown

This is the single coherent edit that makes all six failing tests pass.

**Files:**
- Modify: `src/components/EventCard.tsx`

- [ ] **Step 1: Add `MoreVertical` to the lucide import**

Find the import on line ~5:

```tsx
import { Calendar, Users, Pencil, Trash2, CalendarDays, Bell, CheckCircle, Eye, Share2, UserPlus, MapPin, Handshake, Lock, Copy, CalendarPlus, Download, MessageCircle, Layers } from 'lucide-react'
```

Replace with:

```tsx
import { Calendar, Users, Pencil, Trash2, CalendarDays, Bell, CheckCircle, Eye, Share2, UserPlus, MapPin, Handshake, Lock, Copy, CalendarPlus, Download, MessageCircle, Layers, MoreVertical } from 'lucide-react'
```

- [ ] **Step 2: Rename the dropdown state and refs to neutral "kebab" names**

Find the block around line ~159–164:

```tsx
  const [showCalendarMenu, setShowCalendarMenu] = useState(false)
  const [calendarMenuPosition, setCalendarMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [calendarVisitDate, setCalendarVisitDate] = useState<string | null>(null)
  const calendarMenuRef = useRef<HTMLDivElement>(null)
  const calendarTriggerRef = useRef<HTMLButtonElement>(null)
  const calendarPortalRef = useRef<HTMLDivElement>(null)
```

Replace with:

```tsx
  const [showKebabMenu, setShowKebabMenu] = useState(false)
  const [kebabMenuPosition, setKebabMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [kebabVisitDate, setKebabVisitDate] = useState<string | null>(null)
  const kebabMenuRef = useRef<HTMLDivElement>(null)
  const kebabTriggerRef = useRef<HTMLButtonElement>(null)
  const kebabPortalRef = useRef<HTMLDivElement>(null)
```

- [ ] **Step 3: Update the two effects that reference the renamed state**

Find the `useLayoutEffect` block at lines ~217–231:

```tsx
  useLayoutEffect(() => {
    if (showCalendarMenu && calendarTriggerRef.current) {
      const rect = calendarTriggerRef.current.getBoundingClientRect()
      const padding = 4
      const menuWidth = 192
      setCalendarMenuPosition({
        top: rect.bottom + padding,
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      })
      getMyRsvp(event.id).then(({ data }) => setCalendarVisitDate(data?.preferred_visit_date ?? null))
    } else {
      setCalendarMenuPosition(null)
      setCalendarVisitDate(null)
    }
  }, [showCalendarMenu, event.id])
```

Replace with:

```tsx
  useLayoutEffect(() => {
    if (showKebabMenu && kebabTriggerRef.current) {
      const rect = kebabTriggerRef.current.getBoundingClientRect()
      const padding = 4
      const menuWidth = 192
      setKebabMenuPosition({
        top: rect.bottom + padding,
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      })
      getMyRsvp(event.id).then(({ data }) => setKebabVisitDate(data?.preferred_visit_date ?? null))
    } else {
      setKebabMenuPosition(null)
      setKebabVisitDate(null)
    }
  }, [showKebabMenu, event.id])
```

Find the click-outside `useEffect` at lines ~233–243:

```tsx
  useEffect(() => {
    if (!showCalendarMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const inTrigger = calendarMenuRef.current?.contains(target)
      const inPortal = calendarPortalRef.current?.contains(target)
      if (!inTrigger && !inPortal) setShowCalendarMenu(false)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [showCalendarMenu])
```

Replace with:

```tsx
  useEffect(() => {
    if (!showKebabMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const inTrigger = kebabMenuRef.current?.contains(target)
      const inPortal = kebabPortalRef.current?.contains(target)
      if (!inTrigger && !inPortal) setShowKebabMenu(false)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [showKebabMenu])
```

- [ ] **Step 4: Compute kebab visibility just above the compact return**

Find this line (around line ~287):

```tsx
  const compactAccentClass: Record<string, string> = {
```

Just **before** that `compactAccentClass` declaration, add:

```tsx
  const kebabHasItems = (!isReminder) || (!!onClone) || (!!onDelete && isOrganizer)
```

- [ ] **Step 5: Rebuild the compact action strip**

Find the action strip in the compact `if (viewMode === 'compact')` block, lines ~493–551 — the part that begins with `{onClone && (` and ends with the closing of the calendar `<div className="relative" ref={calendarMenuRef}>` block.

Replace this entire span (from `{onClone && (` up through the closing `)}` of the `{!isReminder && (...)}` calendar block) with:

```tsx
                  {showActions && isOrganizer && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowInviteModal(true) }}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-600 hover:bg-gray-100"
                      aria-label="Invite"
                      title="Invite"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {kebabHasItems && (
                    <div className="relative" ref={kebabMenuRef}>
                      <button
                        ref={kebabTriggerRef}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setShowKebabMenu((v) => !v) }}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-600 hover:bg-gray-100"
                        aria-label="More actions"
                        title="More actions"
                        aria-expanded={showKebabMenu}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
```

The lines being deleted in this replacement are:
- The standalone `{onClone && (...)}` Clone button (lines ~493–503).
- The `{showActions && isOrganizer}` Share button (lines ~504–513) — **keep this**, it stays inline. Verify you didn't accidentally remove it. (If you did, restore it: it's the `Share2` button.)
- The `{showActions && !isOrganizer}` WhatsApp link (lines ~514–526) — **keep this** too.
- The `{onEdit && isOrganizer}` Edit button (lines ~527–536) — **keep**.
- The `{!isReminder && (...)}` inline Calendar dropdown trigger (lines ~537–551) — **delete**.

To make this concrete, the **final** order of the action strip's right-hand `<div className="flex items-center gap-0.5 flex-shrink-0" ...>` children should read top-to-bottom:

1. Family share-status badge (existing, keep)
2. Friends share-status badge (existing, keep)
3. Lock badge if neither shared (existing, keep)
4. Share button (`showActions && isOrganizer`) — keep
5. WhatsApp link (`showActions && !isOrganizer`) — keep
6. Edit button (`onEdit && isOrganizer`) — keep
7. **Invite button** (`showActions && isOrganizer`) — **new**
8. **Kebab `⋯` button** (`kebabHasItems`) — **new, replaces inline Calendar**
9. Clone button — **deleted from inline strip** (moved into kebab)

- [ ] **Step 6: Replace the calendar-only dropdown portal with the unified kebab dropdown**

Find the portal block at lines ~557–599:

```tsx
        {showCalendarMenu &&
          calendarMenuPosition &&
          createPortal(
            <div
              ref={calendarPortalRef}
              className="fixed z-[9999] py-1 w-48 bg-white rounded-md shadow-lg border border-gray-200"
              style={{ top: calendarMenuPosition.top, left: calendarMenuPosition.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  downloadIcs(event, calendarVisitDate ? { visitDate: calendarVisitDate } : undefined)
                  setShowCalendarMenu(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <Download className="h-4 w-4 text-gray-500" />
                Download .ics
              </button>
              <a
                href={getGoogleCalendarAddUrl(event, calendarVisitDate ? { visitDate: calendarVisitDate } : undefined)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setShowCalendarMenu(false)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <CalendarPlus className="h-4 w-4 text-gray-500" />
                Google Calendar
              </a>
              <a
                href={getOutlookCalendarAddUrl(event, calendarVisitDate ? { visitDate: calendarVisitDate } : undefined)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setShowCalendarMenu(false)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <CalendarPlus className="h-4 w-4 text-gray-500" />
                Outlook
              </a>
            </div>,
            document.body
          )}
```

Replace it with the unified kebab dropdown:

```tsx
        {showKebabMenu &&
          kebabMenuPosition &&
          createPortal(
            <div
              ref={kebabPortalRef}
              className="fixed z-[9999] py-1 w-48 bg-white rounded-md shadow-lg border border-gray-200"
              style={{ top: kebabMenuPosition.top, left: kebabMenuPosition.left }}
              onClick={(e) => e.stopPropagation()}
            >
              {!isReminder && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      downloadIcs(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)
                      setShowKebabMenu(false)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Download className="h-4 w-4 text-gray-500" />
                    Download .ics
                  </button>
                  <a
                    href={getGoogleCalendarAddUrl(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setShowKebabMenu(false)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <CalendarPlus className="h-4 w-4 text-gray-500" />
                    Google Calendar
                  </a>
                  <a
                    href={getOutlookCalendarAddUrl(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setShowKebabMenu(false)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <CalendarPlus className="h-4 w-4 text-gray-500" />
                    Outlook
                  </a>
                </>
              )}
              {!isReminder && (onClone || (onDelete && isOrganizer)) && (
                <div className="my-1 border-t border-gray-100" />
              )}
              {onClone && (
                <button
                  type="button"
                  onClick={() => { onClone(event); setShowKebabMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Copy className="h-4 w-4 text-violet-700" />
                  Clone
                </button>
              )}
              {onDelete && isOrganizer && (
                <button
                  type="button"
                  onClick={() => { onDelete(event.id); setShowKebabMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              )}
            </div>,
            document.body
          )}
```

- [ ] **Step 7: Run the full EventCard test file**

Run: `npx vitest run tests/components/EventCard.test.tsx`
Expected: 7 passed (1 baseline + Invite + kebab-organizer + kebab-non-organizer + kebab-hidden-when-empty + kebab-shown-with-one-item + no-inline-calendar).

If any test fails:
- "Cannot find Invite" → check the `aria-label="Invite"` on the new button.
- "Cannot find More actions" → check the `aria-label="More actions"` on the kebab trigger.
- Portal items not found → confirm `screen.getByText(/Download \.ics/i)` traverses `document.body` (RTL default does this with jsdom).
- Inline Calendar button still found → confirm you deleted lines ~537–551 of the original file (the `{!isReminder && (<div className="relative" ref={calendarMenuRef}>...)}` block).

- [ ] **Step 8: Run the broader test suite to ensure no regression**

Run: `npx vitest run`
Expected: All previously-passing tests still pass.

- [ ] **Step 9: Run typecheck**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 10: Manual smoke (UI)**

Tell the user: "All tests pass. Please run `npm run dev` and check a compact event card — confirm Invite is inline for organizer, the `⋯` kebab opens with Calendar items + Clone + Delete, and the detailed view is unchanged. Reply 'looks good' to proceed."

- [ ] **Step 11: Commit**

```bash
git add src/components/EventCard.tsx
git commit -m "feat(EventCard): kebab menu on compact card; surface Invite inline

Compact card now exposes Invite for organizers and folds Calendar,
Clone, and Delete into a kebab dropdown that reuses the existing
portal pattern. Detailed view unchanged."
```

---

## Self-Review Notes (post-write)

- **Spec coverage:**
  - Inline strip matrix (organizer / non-organizer) → Task 7 Step 5.
  - Kebab contents and order → Task 7 Step 6.
  - Kebab visibility (`kebabHasItems`) → Task 7 Step 4.
  - Detailed view untouched → no task modifies lines 605+ of `EventCard.tsx`.
  - "Reminder card: kebab shows Clone + (Delete if organizer); hidden if neither" → covered by Tasks 5 + 7 Step 4.
  - Inline Share/WhatsApp/Edit/Invite still appear on reminders (not gated on `isReminder`) → preserved by leaving those buttons unchanged in Step 5; Invite uses `showActions && isOrganizer` only.

- **No placeholders:** every step has the actual code.

- **Type/name consistency:** `kebabHasItems`, `showKebabMenu`, `setShowKebabMenu`, `kebabTriggerRef`, `kebabMenuRef`, `kebabPortalRef`, `kebabMenuPosition`, `kebabVisitDate` used consistently across Steps 2, 3, 4, 5, 6.
