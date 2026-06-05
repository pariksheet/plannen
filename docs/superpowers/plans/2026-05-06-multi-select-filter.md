# Multi-Select Kind and Status Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-select kind/status filters (with "All" pill) with multi-select toggles — click to select, click again to deselect, nothing selected = show all.

**Architecture:** Single-file change in `src/components/MyFeed.tsx`. Three sequential tasks: (1) update pill constants and state types, (2) replace handlers and filter logic, (3) update JSX rendering and empty states.

**Tech Stack:** React, TypeScript, Tailwind CSS

---

### Task 1: Update pill constants and state types

**Files:**
- Modify: `src/components/MyFeed.tsx:16-31` (pill constants), `src/components/MyFeed.tsx:47-48` (state declarations)

- [ ] **Step 1: Replace STATUS_FILTER_PILLS (lines 16-24)**

Old code:
```ts
const STATUS_FILTER_PILLS: { status: EventStatus | 'all'; label: string; className: string; activeClassName: string }[] = [
  { status: 'all',        label: 'All',        className: 'bg-white text-gray-600 border-gray-300',               activeClassName: 'bg-gray-800 text-white border-gray-800' },
  { status: 'going',      label: 'Going',      className: 'bg-white text-green-700 border-green-300',             activeClassName: 'bg-green-600 text-white border-green-600' },
  { status: 'interested', label: 'Interested', className: 'bg-white text-orange-700 border-orange-300',           activeClassName: 'bg-orange-500 text-white border-orange-500' },
  { status: 'planned',    label: 'Planned',    className: 'bg-white text-amber-700 border-amber-300',             activeClassName: 'bg-amber-500 text-white border-amber-500' },
  { status: 'watching',   label: 'Watching',   className: 'bg-white text-sky-700 border-sky-300',                 activeClassName: 'bg-sky-500 text-white border-sky-500' },
  { status: 'missed',     label: 'Missed',     className: 'bg-white text-yellow-700 border-yellow-300',           activeClassName: 'bg-yellow-500 text-white border-yellow-500' },
  { status: 'cancelled',  label: 'Cancelled',  className: 'bg-white text-red-600 border-red-300',                 activeClassName: 'bg-red-500 text-white border-red-500' },
]
```

New code:
```ts
const STATUS_FILTER_PILLS: { status: EventStatus; label: string; className: string; activeClassName: string }[] = [
  { status: 'going',      label: 'Going',      className: 'bg-white text-green-700 border-green-300',             activeClassName: 'bg-green-600 text-white border-green-600' },
  { status: 'interested', label: 'Interested', className: 'bg-white text-orange-700 border-orange-300',           activeClassName: 'bg-orange-500 text-white border-orange-500' },
  { status: 'planned',    label: 'Planned',    className: 'bg-white text-amber-700 border-amber-300',             activeClassName: 'bg-amber-500 text-white border-amber-500' },
  { status: 'watching',   label: 'Watching',   className: 'bg-white text-sky-700 border-sky-300',                 activeClassName: 'bg-sky-500 text-white border-sky-500' },
  { status: 'missed',     label: 'Missed',     className: 'bg-white text-yellow-700 border-yellow-300',           activeClassName: 'bg-yellow-500 text-white border-yellow-500' },
  { status: 'cancelled',  label: 'Cancelled',  className: 'bg-white text-red-600 border-red-300',                 activeClassName: 'bg-red-500 text-white border-red-500' },
]
```

- [ ] **Step 2: Replace KIND_FILTER_PILLS (lines 26-31)**

Old code:
```ts
// 'session' excluded — sessions are child records of recurring events, not standalone filterable items
const KIND_FILTER_PILLS: { kind: 'all' | 'event' | 'reminder'; label: string; className: string; activeClassName: string }[] = [
  { kind: 'all',      label: 'All',       className: 'bg-white text-gray-600 border-gray-300',     activeClassName: 'bg-gray-800 text-white border-gray-800' },
  { kind: 'event',    label: 'Events',    className: 'bg-white text-indigo-700 border-indigo-300', activeClassName: 'bg-indigo-600 text-white border-indigo-600' },
  { kind: 'reminder', label: 'Reminders', className: 'bg-white text-purple-700 border-purple-300', activeClassName: 'bg-purple-600 text-white border-purple-600' },
]
```

New code:
```ts
// 'session' excluded — sessions are child records of recurring events, not standalone filterable items
const KIND_FILTER_PILLS: { kind: 'event' | 'reminder'; label: string; className: string; activeClassName: string }[] = [
  { kind: 'event',    label: 'Events',    className: 'bg-white text-indigo-700 border-indigo-300', activeClassName: 'bg-indigo-600 text-white border-indigo-600' },
  { kind: 'reminder', label: 'Reminders', className: 'bg-white text-purple-700 border-purple-300', activeClassName: 'bg-purple-600 text-white border-purple-600' },
]
```

- [ ] **Step 3: Replace state declarations (lines 47-48)**

Old code:
```ts
  const [activeStatusFilter, setActiveStatusFilter] = useState<EventStatus | 'all'>('all')
  const [activeKindFilter, setActiveKindFilter] = useState<'all' | 'event' | 'reminder'>('all')
```

New code:
```ts
  const [activeStatusFilter, setActiveStatusFilter] = useState<Set<EventStatus>>(new Set())
  const [activeKindFilter, setActiveKindFilter] = useState<Set<'event' | 'reminder'>>(new Set())
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: Errors will appear (filter logic and JSX still reference the old types — that is expected at this stage). Verify the errors are ONLY about usages of `activeKindFilter` and `activeStatusFilter`, not about the constants themselves.

- [ ] **Step 5: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "refactor: update filter pill constants and state to multi-select Sets"
```

---

### Task 2: Replace handlers and filter logic

**Files:**
- Modify: `src/components/MyFeed.tsx` (handleKindChange, new handleStatusChange, filteredEvents chain)

- [ ] **Step 1: Replace handleKindChange and add handleStatusChange (lines 126-129)**

Old code:
```ts
  const handleKindChange = (kind: 'all' | 'event' | 'reminder') => {
    if (kind === 'reminder') setActiveStatusFilter('all')
    setActiveKindFilter(kind)
  }
```

New code:
```ts
  const handleKindChange = (kind: 'event' | 'reminder') => {
    setActiveKindFilter(prev => {
      const next = new Set(prev)
      next.has(kind) ? next.delete(kind) : next.add(kind)
      if (next.has('reminder')) setActiveStatusFilter(new Set<EventStatus>())
      return next
    })
  }

  const handleStatusChange = (status: EventStatus) => {
    setActiveStatusFilter(prev => {
      const next = new Set(prev)
      next.has(status) ? next.delete(status) : next.add(status)
      return next
    })
  }
```

- [ ] **Step 2: Replace filteredEvents chain (lines 118-121)**

Old code:
```ts
  const filteredEvents = events
    .filter((e) => activeKindFilter === 'all' || e.event_kind === activeKindFilter)
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => activeKindFilter === 'reminder' || activeStatusFilter === 'all' || e.event_status === activeStatusFilter)
```

New code:
```ts
  const filteredEvents = events
    .filter((e) => activeKindFilter.size === 0 || activeKindFilter.has(e.event_kind as 'event' | 'reminder'))
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => activeKindFilter.has('reminder') || activeStatusFilter.size === 0 || activeStatusFilter.has(e.event_status))
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: Errors will remain only about JSX usages of `activeKindFilter` and `activeStatusFilter` (the render layer still uses old comparisons). That is expected at this stage.

- [ ] **Step 4: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: multi-select toggle handlers and filter logic"
```

---

### Task 3: Update JSX rendering and empty states

**Files:**
- Modify: `src/components/MyFeed.tsx` (pill row, empty state message, clear button)

- [ ] **Step 1: Replace the pill row (lines 173-203)**

Old code:
```tsx
      <div className="flex justify-center gap-2 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
        {KIND_FILTER_PILLS.map(({ kind, label, className, activeClassName }) => (
          <button
            key={kind}
            type="button"
            onClick={() => handleKindChange(kind)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeKindFilter === kind ? activeClassName : className
            }`}
          >
            {label}
          </button>
        ))}
        {STATUS_FILTER_PILLS.map(({ status, label, className, activeClassName }) => (
          <button
            key={status}
            type="button"
            onClick={() => setActiveStatusFilter(status)}
            disabled={activeKindFilter === 'reminder'}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeKindFilter === 'reminder'
                ? 'opacity-40 cursor-not-allowed pointer-events-none'
                : activeStatusFilter === status
                  ? activeClassName
                  : className
            }`}
          >
            {label}
          </button>
        ))}
      </div>
```

New code:
```tsx
      <div className="flex justify-center gap-2 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
        {KIND_FILTER_PILLS.map(({ kind, label, className, activeClassName }) => (
          <button
            key={kind}
            type="button"
            onClick={() => handleKindChange(kind)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeKindFilter.has(kind) ? activeClassName : className
            }`}
          >
            {label}
          </button>
        ))}
        {STATUS_FILTER_PILLS.map(({ status, label, className, activeClassName }) => (
          <button
            key={status}
            type="button"
            onClick={() => handleStatusChange(status)}
            disabled={activeKindFilter.has('reminder')}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeKindFilter.has('reminder')
                ? 'opacity-40 cursor-not-allowed pointer-events-none'
                : activeStatusFilter.has(status)
                  ? activeClassName
                  : className
            }`}
          >
            {label}
          </button>
        ))}
      </div>
```

- [ ] **Step 2: Replace the empty state message and clear button (lines 227-244)**

Old code:
```tsx
          <p className="text-gray-500 mb-4">
            {activeKindFilter === 'reminder' && activeHashtag
              ? `No reminders found for #${activeHashtag}.`
              : activeKindFilter === 'reminder'
                ? 'No reminders found.'
                : activeHashtag && activeStatusFilter !== 'all'
                  ? `No ${activeStatusFilter} events found for #${activeHashtag}.`
                  : activeHashtag
                    ? `No events found for #${activeHashtag} in My Plans.`
                    : `No ${activeStatusFilter} events found.`}
          </p>
          <button
            type="button"
            onClick={() => { setActiveHashtag(null); setActiveStatusFilter('all'); setActiveKindFilter('all') }}
            className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
          >
            Clear filters
          </button>
```

New code:
```tsx
          <p className="text-gray-500 mb-4">
            {activeHashtag
              ? `No events found for #${activeHashtag} in My Plans.`
              : 'No events match your filters.'}
          </p>
          <button
            type="button"
            onClick={() => { setActiveHashtag(null); setActiveStatusFilter(new Set<EventStatus>()); setActiveKindFilter(new Set<'event' | 'reminder'>()) }}
            className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
          >
            Clear filters
          </button>
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Verify in browser**

Start the dev server:
```bash
npm run dev
```

Check these behaviors:
- Events and Reminders pills appear (no "All" pill)
- Going / Interested / Planned / Watching / Missed / Cancelled pills appear (no "All" pill)
- Clicking "Events" highlights it; clicking again deselects it
- Clicking "Reminders" highlights it and dims status pills; clicking again re-enables status pills
- Clicking both "Events" and "Reminders" = both highlighted, status pills dimmed
- Clicking a status pill highlights it; clicking again deselects it; multiple status pills can be active
- Nothing selected = all events shown
- "Clear filters" deselects everything

- [ ] **Step 5: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: multi-select pill rendering and updated empty states"
```
