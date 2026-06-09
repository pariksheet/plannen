import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Timeline } from './Timeline'
import { Event } from '../types/event'
import { TimelineItem } from '../utils/timeline'

// Stub EventCard to expose todo checkbox handler via a testable button.
vi.mock('./EventCard', () => ({
  EventCard: ({
    event,
    onToggleTodo,
    onConvertKind,
  }: {
    event: Event
    onToggleTodo?: (e: Event) => void
    onConvertKind?: (e: Event, kind: 'reminder' | 'todo') => void
  }) => (
    <div data-testid="event-card">
      <span>{event.title}</span>
      {onToggleTodo && (
        <button type="button" onClick={() => onToggleTodo(event)}>
          Toggle todo
        </button>
      )}
      {onConvertKind && (
        <button type="button" onClick={() => onConvertKind(event, 'reminder')}>
          Convert kind
        </button>
      )}
    </div>
  ),
}))

function makeTodoItem(overrides: Partial<Event> = {}): TimelineItem {
  const nextMonth = new Date()
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  const event: Event = {
    id: 'todo-1',
    title: 'Buy tickets',
    description: null,
    start_date: nextMonth.toISOString(),
    end_date: null,
    enrollment_url: null,
    enrollment_deadline: null,
    enrollment_start_date: null,
    image_url: null,
    location: null,
    hashtags: null,
    event_kind: 'todo',
    event_type: 'personal',
    event_status: 'going',
    created_by: 'u1',
    created_at: '',
    updated_at: '',
    shared_with_friends: 'none',
    completed_at: null,
    ...overrides,
  }
  return {
    event,
    timelineDate: nextMonth,
    isImmediateNext: false,
    isPastToday: false,
  }
}

describe('Timeline todo prop threading', () => {
  it('forwards onToggleTodo to EventCard — clicking the stub button calls the handler', async () => {
    const onToggleTodo = vi.fn()
    const item = makeTodoItem()
    render(<Timeline items={[item]} onToggleTodo={onToggleTodo} />)
    const btn = screen.getByRole('button', { name: 'Toggle todo' })
    btn.click()
    expect(onToggleTodo).toHaveBeenCalledOnce()
    expect(onToggleTodo).toHaveBeenCalledWith(item.event)
  })

  it('forwards onConvertKind to EventCard — clicking the stub button calls the handler', () => {
    const onConvertKind = vi.fn()
    const item = makeTodoItem()
    render(<Timeline items={[item]} onConvertKind={onConvertKind} />)
    const btn = screen.getByRole('button', { name: 'Convert kind' })
    btn.click()
    expect(onConvertKind).toHaveBeenCalledOnce()
    expect(onConvertKind).toHaveBeenCalledWith(item.event, 'reminder')
  })

  it('renders without handlers — no toggle/convert buttons exposed', () => {
    const item = makeTodoItem()
    render(<Timeline items={[item]} />)
    expect(screen.queryByRole('button', { name: 'Toggle todo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Convert kind' })).toBeNull()
  })
})
