# Collapsible Timeline Months Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each month group in the Timeline collapsible — clicking the month header toggles its events list, all expanded by default.

**Architecture:** Single-file change to `src/components/Timeline.tsx`. Add local `collapsedMonths: Set<string>` state, replace the static `<h4>` month header with a toggle `<button>`, and conditionally render the events list.

**Tech Stack:** React, TypeScript, Tailwind CSS, lucide-react

---

### Task 1: Add collapsible month groups to Timeline

**Files:**
- Modify: `src/components/Timeline.tsx` (entire file — 75 lines)

- [ ] **Step 1: Add useState and ChevronDown imports**

Old imports (lines 1-3):
```ts
import { Event, EventViewMode } from '../types/event'
import { EventCard } from './EventCard'
import { TimelineItem, groupTimelineByMonth } from '../utils/timeline'
```

New imports:
```ts
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Event, EventViewMode } from '../types/event'
import { EventCard } from './EventCard'
import { TimelineItem, groupTimelineByMonth } from '../utils/timeline'
```

- [ ] **Step 2: Add state and toggle handler inside the Timeline function**

IMPORTANT: Add these BEFORE the `if (items.length === 0)` early return (React hooks rules — hooks cannot be called after a conditional return). Insert after the opening of the `Timeline` function body, before line 34:

```ts
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set())

  const toggleMonth = (monthKey: string) => {
    setCollapsedMonths(prev => {
      const next = new Set(prev)
      next.has(monthKey) ? next.delete(monthKey) : next.add(monthKey)
      return next
    })
  }
```

- [ ] **Step 3: Replace the month header and conditionally render events**

Old JSX inside `groups.map(...)` (lines 46-71):
```tsx
        <section key={monthKey} className="mb-8">
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 sticky top-0 bg-gray-50 py-1 -mx-1 sm:bg-transparent">
            {label}
          </h4>
          <div className="space-y-4">
            {groupItems.map((item) => (
              <EventCard
                key={item.event.id}
                event={item.event}
                onEdit={onEdit}
                onClone={onClone}
                onDelete={onDelete}
                onShareSuccess={onShareSuccess}
                onHashtagClick={onHashtagClick}
                showActions={showActions}
                showRSVP={showRSVP}
                showMemories={showMemories}
                showWatchButton={showWatchButton}
                viewMode={viewMode}
                isImmediateNext={item.isImmediateNext}
                nextExpectedDate={item.nextExpectedDate?.toISOString()}
              />
            ))}
          </div>
        </section>
```

New JSX:
```tsx
        <section key={monthKey} className="mb-8">
          <button
            type="button"
            onClick={() => toggleMonth(monthKey)}
            className="w-full flex items-center justify-between text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 py-1 -mx-1 px-1 sticky top-0 bg-gray-50 sm:bg-transparent hover:text-gray-700"
          >
            <span>{label}</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsedMonths.has(monthKey) ? '-rotate-90' : ''}`} />
          </button>
          {!collapsedMonths.has(monthKey) && (
            <div className="space-y-4">
              {groupItems.map((item) => (
                <EventCard
                  key={item.event.id}
                  event={item.event}
                  onEdit={onEdit}
                  onClone={onClone}
                  onDelete={onDelete}
                  onShareSuccess={onShareSuccess}
                  onHashtagClick={onHashtagClick}
                  showActions={showActions}
                  showRSVP={showRSVP}
                  showMemories={showMemories}
                  showWatchButton={showWatchButton}
                  viewMode={viewMode}
                  isImmediateNext={item.isImmediateNext}
                  nextExpectedDate={item.nextExpectedDate?.toISOString()}
                />
              ))}
            </div>
          )}
        </section>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Verify in browser**

```bash
npm run dev
```

Check:
- All month groups start expanded (chevron pointing down)
- Clicking a month header collapses it (events hidden, chevron rotates to point right)
- Clicking again re-expands it
- Other months are unaffected when one is toggled
- Sticky header still works when scrolling

- [ ] **Step 6: Commit**

```bash
git add src/components/Timeline.tsx
git commit -m "feat: collapsible month groups in timeline"
```
