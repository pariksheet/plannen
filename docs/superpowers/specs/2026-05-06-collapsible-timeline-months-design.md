# Collapsible Timeline Months

**Date:** 2026-05-06  
**Status:** Approved

## Overview

Make each month group in the Timeline collapsible. Clicking the month header toggles its events list open or closed. All months start expanded by default.

## State

Inside `Timeline` component:

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

Empty set = all months expanded.

## UI

The month `<h4>` header is replaced with a full-width `<button>`:

```tsx
<button
  type="button"
  onClick={() => toggleMonth(monthKey)}
  className="w-full flex items-center justify-between text-sm font-semibold text-gray-500 uppercase tracking-wide py-1 -mx-1 px-1 sticky top-0 bg-gray-50 sm:bg-transparent hover:text-gray-700"
>
  <span>{label}</span>
  <ChevronDown className={`h-4 w-4 transition-transform ${collapsedMonths.has(monthKey) ? '-rotate-90' : ''}`} />
</button>
```

The events list renders only when the month is not collapsed:

```tsx
{!collapsedMonths.has(monthKey) && (
  <div className="space-y-4">
    {groupItems.map(...)}
  </div>
)}
```

`ChevronDown` is imported from `lucide-react` (already available in the project).

## Files Changed

- `src/components/Timeline.tsx` — state, toggle handler, header button, conditional events list
