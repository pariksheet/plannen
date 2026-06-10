import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventList } from './EventList'
import { Event } from '../types/event'

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
        <button type="button" onClick={() => onConvertKind(event, 'todo')}>
          Convert kind
        </button>
      )}
    </div>
  ),
}))

function makeTodo(overrides: Partial<Event> = {}): Event {
  return {
    id: 'todo-1',
    title: 'Water the plants',
    description: null,
    start_date: '2030-01-15T09:00:00.000Z',
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
}

describe('EventList todo prop threading', () => {
  it('forwards onToggleTodo to EventCard — clicking the stub button calls the handler', () => {
    const onToggleTodo = vi.fn()
    const todo = makeTodo()
    render(<EventList events={[todo]} onToggleTodo={onToggleTodo} />)
    const btn = screen.getByRole('button', { name: 'Toggle todo' })
    btn.click()
    expect(onToggleTodo).toHaveBeenCalledOnce()
    expect(onToggleTodo).toHaveBeenCalledWith(todo)
  })

  it('forwards onConvertKind to EventCard — clicking the stub button calls the handler', () => {
    const onConvertKind = vi.fn()
    const todo = makeTodo()
    render(<EventList events={[todo]} onConvertKind={onConvertKind} />)
    const btn = screen.getByRole('button', { name: 'Convert kind' })
    btn.click()
    expect(onConvertKind).toHaveBeenCalledOnce()
    expect(onConvertKind).toHaveBeenCalledWith(todo, 'todo')
  })

  it('renders without handlers — no toggle/convert buttons exposed', () => {
    const todo = makeTodo()
    render(<EventList events={[todo]} />)
    expect(screen.queryByRole('button', { name: 'Toggle todo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Convert kind' })).toBeNull()
  })

  it('renders the empty message when events array is empty', () => {
    render(<EventList events={[]} emptyMessage="Nothing here yet" />)
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
  })
})
