# Kind Filter for MyFeed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add All / Events / Reminders kind filter pills to the left of the existing status pills in MyFeed; selecting Reminders disables the status pills.

**Architecture:** Single-file change in `MyFeed.tsx`. Add `activeKindFilter` state, prepend kind pill constants to the filter row, extend the filter chain, disable status pills when kind is `'reminder'`, and update empty state messages.

**Tech Stack:** React, TypeScript, Tailwind CSS

---

### Task 1: Add kind pill constants and state

**Files:**
- Modify: `src/components/MyFeed.tsx:16-24` (after `STATUS_FILTER_PILLS`), `src/components/MyFeed.tsx:39-40` (state block)

- [ ] **Step 1: Add KIND_FILTER_PILLS constant after STATUS_FILTER_PILLS (line 24)**

Insert this block immediately after the closing `]` of `STATUS_FILTER_PILLS`:

```ts
const KIND_FILTER_PILLS: { kind: 'all' | 'event' | 'reminder'; label: string; className: string; activeClassName: string }[] = [
  { kind: 'all',      label: 'All',       className: 'bg-white text-gray-600 border-gray-300',     activeClassName: 'bg-gray-800 text-white border-gray-800' },
  { kind: 'event',    label: 'Events',    className: 'bg-white text-indigo-700 border-indigo-300', activeClassName: 'bg-indigo-600 text-white border-indigo-600' },
  { kind: 'reminder', label: 'Reminders', className: 'bg-white text-purple-700 border-purple-300', activeClassName: 'bg-purple-600 text-white border-purple-600' },
]
```

- [ ] **Step 2: Add activeKindFilter state (line 40, after activeStatusFilter state)**

```ts
const [activeKindFilter, setActiveKindFilter] = useState<'all' | 'event' | 'reminder'>('all')
```

- [ ] **Step 3: Start the dev server and confirm it compiles**

```bash
npm run dev
```

Expected: No TypeScript errors, app loads at localhost:5173.

- [ ] **Step 4: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: add kind filter state and pill constants"
```

---

### Task 2: Update filter logic

**Files:**
- Modify: `src/components/MyFeed.tsx:110-112`

- [ ] **Step 1: Replace the filteredEvents chain (lines 110-112)**

Old code:
```ts
const filteredEvents = events
  .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
  .filter((e) => activeStatusFilter === 'all' || e.event_status === activeStatusFilter)
```

New code:
```ts
const filteredEvents = events
  .filter((e) => activeKindFilter === 'all' || e.event_kind === activeKindFilter)
  .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
  .filter((e) => activeKindFilter === 'reminder' || activeStatusFilter === 'all' || e.event_status === activeStatusFilter)
```

- [ ] **Step 2: Add a kind change handler (place just before the `return` statement)**

```ts
const handleKindChange = (kind: 'all' | 'event' | 'reminder') => {
  if (kind === 'reminder') setActiveStatusFilter('all')
  setActiveKindFilter(kind)
}
```

- [ ] **Step 3: Verify in browser**

With the dev server running, open My Plans. Confirm the app still loads and existing status pills work. No visual changes yet.

- [ ] **Step 4: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: filter events by kind, disable status filter for reminders"
```

---

### Task 3: Render kind pills and disable status pills

**Files:**
- Modify: `src/components/MyFeed.tsx:159-172`

- [ ] **Step 1: Replace the filter row (lines 159-172)**

Old code:
```tsx
<div className="flex justify-center gap-2 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
  {STATUS_FILTER_PILLS.map(({ status, label, className, activeClassName }) => (
    <button
      key={status}
      type="button"
      onClick={() => setActiveStatusFilter(status)}
      className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
        activeStatusFilter === status ? activeClassName : className
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
          ? 'opacity-40 cursor-not-allowed'
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

- [ ] **Step 2: Verify in browser**

- All / Events / Reminders pills appear to the left of the status pills
- Clicking "Reminders" dims and disables the status pills
- Clicking "Events" or "All" re-enables the status pills
- Selecting "Reminders" shows only reminder-kind events in the feed

- [ ] **Step 3: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: render kind filter pills, disable status pills for reminders"
```

---

### Task 4: Update empty state messages and clear filters

**Files:**
- Modify: `src/components/MyFeed.tsx:197-209`

- [ ] **Step 1: Replace the empty state message and clear button (lines 197-209)**

Old code:
```tsx
<p className="text-gray-500 mb-4">
  {activeHashtag && activeStatusFilter !== 'all'
    ? `No ${activeStatusFilter} events found for #${activeHashtag}.`
    : activeHashtag
      ? `No events found for #${activeHashtag} in My Plans.`
      : `No ${activeStatusFilter} events found.`}
</p>
<button
  type="button"
  onClick={() => { setActiveHashtag(null); setActiveStatusFilter('all') }}
  className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
>
  Clear filters
</button>
```

New code:
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

- [ ] **Step 2: Verify in browser**

- Select "Reminders" with no reminders in feed → "No reminders found."
- Select "Reminders" + a hashtag with no results → "No reminders found for #tag."
- Click "Clear filters" → all three filters reset (kind=All, status=All, hashtag=none)
- Existing event/status/hashtag empty states still work correctly

- [ ] **Step 3: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: update empty state messages and clear filters for kind filter"
```
